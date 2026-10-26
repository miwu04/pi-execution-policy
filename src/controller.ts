import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUDGET_GUIDANCE, ReviewSchema, type Config, type Grant } from "./config.ts";
import { canonical, changedFiles, inside, permitted, revision } from "./repository.ts";
import { git, runCommand, type CommandResult } from "./process.ts";
import { digest, readJson, saveJson, WriteLease } from "./storage.ts";

type CheckRecord = { revision: string; passed: boolean; result: CommandResult; checkedAt: string };
type ReviewRecord = { revision: string; reviewerId: string; reportPath: string; reportContent: string; verdict: "pass" | "block" };
export type PolicyMode = "standalone" | "orchestrator" | "managed";
export type ManagedTask = {
  id: string; agentId: string | null; attemptId: string; cwd: string; role: string; phase: string;
  parentAgentId?: string | null; paths?: string[]; allowCommit?: boolean; subjectTaskId?: string; subjectGeneration?: number | null;
};
export type OrchestrationTask = { id: string; agentId: string | null; parentAgentId?: string | null; phase: string; role: string; paths: string[]; allowCommit: boolean; error: string | null };
export type OrchestrationState = {
  tasks: Record<string, OrchestrationTask>;
  messages: Record<string, { id: string; taskId: string; recipientId: string | null; status: string; body: string }>;
};

const FOREVER = "9999-12-31T00:00:00.000Z";
const ENDED = ["accepted", "canceled", "failed", "blocked"];
const SHELL_TOOLS = ["bash", "powershell", "windows_shell_exec", "interactive_shell"];
// Waiting for an upstream ruling by sleeping or polling blocks the turn and hides the blocker; the plugin resumes a finished turn instead.
const WAIT_PATTERN = /(^|[;&|(\n])\s*sleep\s+[0-9.]|\b(while|until|for|timeout)\b[^\n]*\bsleep\b|\b(inotifywait|while\s+true)\b/;

export interface PolicyState {
  schemaVersion: 1; sessionId: string; actorId: string; cwd: string;
  toolCalls: number; touched: string[];
  checks: Record<string, CheckRecord>; review: ReviewRecord | null;
  lastRun: { id: string; check: string; requested: number; attempted: number; completed: number; status: "running" | "completed" | "failed" | "interrupted"; results: Array<Pick<CommandResult, "exitCode" | "timedOut" | "canceled">> } | null;
}

export class PolicyController {
  readonly cwd: string;
  readonly config: Config;
  readonly stateRoot: string;
  readonly state: PolicyState;
  readonly lease: WriteLease;
  readonly protectedPaths: string[];
  readonly mode: PolicyMode;
  private active = new Set<string>();
  private controlBusy = false;
  private stopped = false;
  private lifecycle = new AbortController();
  private statePath: string;

  constructor(options: { cwd: string; config: Config; stateRoot: string; sessionId: string; actorId?: string; configPath?: string }) {
    this.cwd = realpathSync(options.cwd);
    this.config = options.config;
    this.stateRoot = canonical(resolve(options.stateRoot));
    const actorId = options.actorId ?? options.sessionId;
    const taskId = process.env.AGENT_POLICY_TASK_ID;
    const attemptId = process.env.AGENT_POLICY_ATTEMPT_ID;
    const role = process.env.AGENT_POLICY_ROLE;
    this.mode = taskId && attemptId && role ? "managed" : options.actorId ? "orchestrator" : "standalone";
    this.statePath = join(this.stateRoot, "sessions", `${digest(options.sessionId)}.json`);
    this.protectedPaths = [this.stateRoot, ...(options.configPath ? [canonical(resolve(options.configPath))] : [])];
    const old = readJson<PolicyState>(this.statePath);
    this.state = {
      schemaVersion: 1, sessionId: options.sessionId, actorId, cwd: this.cwd,
      toolCalls: 0, touched: [], checks: {}, review: null, lastRun: null,
      ...(old?.schemaVersion === 1 && old.cwd === this.cwd && old.actorId === actorId ? { touched: old.touched, checks: old.checks, lastRun: old.lastRun ? { ...old.lastRun, status: old.lastRun.status === "running" ? "interrupted" : old.lastRun.status } : null } : {}),
    };
    this.lease = new WriteLease(this.stateRoot, this.cwd, `${options.sessionId}:${process.pid}:${randomUUID()}`);
    this.persist();
  }

  private persist(): void { if (!this.stopped && this.mode !== "standalone") saveJson(this.statePath, this.state); }
  private async control(action: () => Promise<void>): Promise<void> {
    if (this.stopped || this.active.size || this.controlBusy) throw new Error("执行过程中不能修改审查或批准；请等待当前操作退出");
    this.controlBusy = true;
    try { await action(); } finally { this.controlBusy = false; }
  }
  private task(): ManagedTask | undefined {
    const taskId = process.env.AGENT_POLICY_TASK_ID;
    if (!taskId) return undefined;
    return readJson<{ tasks: Record<string, ManagedTask> }>(join(this.stateRoot, "orchestration.json"))?.tasks[taskId];
  }
  // Re-read on every call: revocation, a new attempt, or a closed phase must take effect immediately.
  private scope(): Grant {
    if (this.stopped) throw new Error("执行会话已经关闭");
    if (this.mode !== "managed") throw new Error("当前模式没有角色范围");
    const attemptId = process.env.AGENT_POLICY_ATTEMPT_ID;
    const task = this.task();
    if (!task) throw new Error("编排插件没有记录当前任务；按只读处理");
    if (task.agentId !== this.state.actorId || task.attemptId !== attemptId) throw new Error("任务执行阶段已经变化；拒绝写入");
    if (canonical(resolve(task.cwd)) !== this.cwd) throw new Error("任务工作目录与本会话不一致；拒绝写入");
    if (ENDED.includes(task.phase)) throw new Error(`任务阶段已经结束：${task.phase}`);
    if (task.role !== "worker") throw new Error(`当前角色 ${task.role} 不允许写入`);
    if (!task.paths?.length) throw new Error("派发方没有声明写入路径");
    return { paths: task.paths, allowCommit: Boolean(task.allowCommit), allowExisting: true, expiresAt: FOREVER };
  }
  private claim(id: string): void {
    if (this.mode === "managed") this.scope();
    if (this.active.size || this.controlBusy) throw new Error("该目录正在执行写入或检查；必须串行执行");
    if (existsSync(join(this.stateRoot, "freezes", `${digest(this.cwd)}.json`))) throw new Error("该目录正在独立审查；待审查完成并登记处理结果后才能写入或运行检查");
    this.lease.acquire();
    this.active.add(id);
  }
  private path(target: string): string {
    if (this.mode !== "managed") return permitted(this.cwd, target, ["."], this.protectedPaths);
    return permitted(this.cwd, target, this.scope().paths, this.protectedPaths);
  }

  gate(id: string, toolName: string, input: Record<string, unknown>): void {
    if (this.mode !== "managed") return;
    if (SHELL_TOOLS.includes(toolName) && typeof input.command === "string" && WAIT_PATTERN.test(input.command)) {
      throw new Error("受编排的 agent 不能用 sleep 或轮询等待上游；结束当前回合，在报告里写清阻塞点、已有证据和需要的答案，上游会用 continue 把结论送回");
    }
    if (!["write", "edit", "policy_remove", "policy_commit"].includes(toolName)) return;
    if (toolName !== "write" && toolName !== "edit") return;
    if (typeof input.path !== "string") throw new Error("写入工具缺少明确路径");
    const path = this.path(input.path);
    this.claim(id);
    this.state.review = null;
    if (!this.state.touched.includes(path)) this.state.touched.push(path);
    this.persist();
  }

  async inspectGit(operation: "status" | "diff" | "log" | "show" | "head", paths: string[] = [], ref = "HEAD", limit = 20): Promise<string> {
    if (!existsSync(join(this.cwd, ".git"))) throw new Error("当前目录不是 Git 仓库根目录");
    if (!/^(?:HEAD(?:[~^][0-9]*)?|[a-fA-F0-9]{7,64})$/.test(ref) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Git 查询参数无效");
    if (paths.some(path => !inside(this.cwd, resolve(this.cwd, path)))) throw new Error("Git 查询路径越界");
    const argumentsByOperation = {
      status: ["status", "--porcelain=v1", "--untracked-files=all"],
      diff: ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", ref, "--", ...paths],
      log: ["log", `-n${limit}`, "--format=%h %s", ref, "--", ...paths],
      show: ["show", "--no-ext-diff", "--no-textconv", "--format=fuller", ref, "--", ...paths],
      head: ["rev-parse", "HEAD"],
    };
    return git(this.cwd, argumentsByOperation[operation]);
  }

  remove(path: string): void {
    const name = this.path(path);
    const id = randomUUID();
    this.claim(id);
    try {
      const target = resolve(this.cwd, name);
      const stat = lstatSync(target);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("只允许删除明确授权的单个文件，不递归删除目录");
      unlinkSync(target);
      this.state.review = null;
      if (!this.state.touched.includes(name)) this.state.touched.push(name);
      this.persist();
    } finally { this.finishTool(id); }
  }

  finishTool(id: string): void {
    this.active.delete(id);
    if (!this.active.size) this.lease.release();
  }

  async check(key: string, count = 1, signal?: AbortSignal): Promise<{ runs: CommandResult[]; passed: number; failed: number }> {
    signal = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    const spec = this.config.checks[key];
    if (!spec) throw new Error(`未配置检查：${key}`);
    if (!Number.isInteger(count) || count < 1 || count > this.config.maxRepeatRuns) throw new Error("运行次数超出配置范围");
    const id = randomUUID();
    this.claim(id);
    const runs: CommandResult[] = [];
    this.state.lastRun = { id, check: key, requested: count, attempted: 0, completed: 0, status: "running", results: [] };
    this.persist();
    try {
      const before = await revision(this.cwd, this.config);
      for (let i = 0; i < count; i++) {
        if (signal?.aborted) throw new Error("检查已取消");
        this.state.lastRun.attempted++;
        this.persist();
        const result = await runCommand(spec.command, spec.args, this.cwd, { signal, timeoutMs: spec.timeoutMs });
        runs.push(result);
        this.state.lastRun.completed++;
        this.state.lastRun.results.push({ exitCode: result.exitCode, timedOut: result.timedOut, canceled: result.canceled });
        this.persist();
        if (result.canceled || result.timedOut) break;
      }
      const after = await revision(this.cwd, this.config);
      const passed = runs.filter(run => run.exitCode === 0 && !run.canceled && !run.timedOut).length;
      this.state.checks[key] = { revision: before, passed: before === after && passed === count && runs.length === count, result: runs.at(-1)!, checkedAt: new Date().toISOString() };
      this.state.lastRun.status = this.state.checks[key].passed ? "completed" : "failed";
      if (before !== after) this.state.review = null;
      this.persist();
      return { runs, passed, failed: runs.length - passed };
    } catch (error) {
      delete this.state.checks[key];
      this.state.lastRun.status = "failed";
      this.persist();
      throw error;
    } finally { this.finishTool(id); }
  }

  // A reviewer session publishes its verdict for the task it reviewed, so the dispatcher can consume evidence instead of a claim.
  async recordReview(input: unknown): Promise<void> {
    return this.control(async () => {
    const review = ReviewSchema.parse(input);
    if ([this.state.actorId, this.state.sessionId].includes(review.reviewerId)) throw new Error("审查者不能是当前实现者");
    const reportPath = realpathSync(resolve(this.cwd, review.reportPath));
    const report = readFileSync(reportPath, "utf8");
    if (!report.trim()) throw new Error("审查报告为空");
    this.state.review = { ...review, reportPath, reportContent: digest(report), revision: await revision(this.cwd, this.config) };
    const task = this.task();
    if (this.mode === "managed" && task?.role === "reviewer" && task.subjectTaskId) {
      saveJson(join(this.stateRoot, "reviews", `${task.subjectTaskId}.json`), {
        subjectTaskId: task.subjectTaskId, reviewerTaskId: task.id, reviewerAgentId: task.agentId,
        subjectGeneration: task.subjectGeneration ?? null, verdict: review.verdict, reportPath, reportDigest: this.state.review.reportContent,
        revision: this.state.review.revision, recordedAt: new Date().toISOString(),
      });
    }
    this.persist();
    });
  }

  // Commit approval is written by the dispatcher and bound to one attempt, revision and path set.
  private approval(): { attemptId: string; revision: string; paths: string[] } | null {
    const taskId = process.env.AGENT_POLICY_TASK_ID;
    if (!taskId) return null;
    const record = readJson<{ attemptId: string; revision: string; paths: string[] }>(join(this.stateRoot, "approvals", `${taskId}.json`));
    if (!record || record.attemptId !== process.env.AGENT_POLICY_ATTEMPT_ID) return null;
    return record;
  }

  async commit(paths: string[], message: string, signal?: AbortSignal): Promise<string> {
    signal = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    if (!paths.length || !message.trim()) throw new Error("需要明确的路径和提交说明");
    const id = randomUUID();
    this.claim(id);
    try {
      const approvedPaths = [...new Set(paths.map(path => this.path(path)))];
      const current = await revision(this.cwd, this.config);
      if (this.mode === "managed") {
        const scope = this.scope();
        if (!scope.allowCommit) throw new Error("派发方没有授予提交权限");
        const approval = this.approval();
        if (!approval) throw new Error("缺少派发方对当前执行阶段的提交批准");
        if (approval.revision !== current) throw new Error("提交批准已因内容变化失效");
        if (approvedPaths.some(path => !approval.paths.includes(path))) throw new Error("提交路径超出已批准的集合");
      }
      const changed = await changedFiles(this.cwd);
      if (changed.length !== approvedPaths.length || changed.some(path => !approvedPaths.includes(path))) throw new Error("提交必须覆盖当前完整改动；独立行为需分开实现和提交");
      if ((await git(this.cwd, ["diff", "--cached", "--name-only"], signal)).trim()) throw new Error("暂存区已有内容；请先明确其归属，不自动纳入提交");
      await git(this.cwd, ["config", "user.name"], signal);
      await git(this.cwd, ["config", "user.email"], signal);
      await git(this.cwd, ["add", "--", ...approvedPaths], signal);
      const staged = (await git(this.cwd, ["diff", "--cached", "--name-only"], signal)).split("\n").filter(Boolean).sort();
      if (staged.join("\0") !== [...approvedPaths].sort().join("\0")) throw new Error("暂存内容与批准路径不一致，提交已停止");
      const expectedTree = (await git(this.cwd, ["write-tree"], signal)).trim();
      await git(this.cwd, ["commit", "-m", message], signal);
      const actualTree = (await git(this.cwd, ["rev-parse", "HEAD^{tree}"], signal)).trim();
      if (actualTree !== expectedTree) throw new Error("提交钩子改变了暂存内容；停止后续操作，需要检查已有提交");
      this.state.touched = this.state.touched.filter(path => !approvedPaths.includes(path));
      return (await git(this.cwd, ["rev-parse", "HEAD"], signal)).trim();
    } finally { this.persist(); this.finishTool(id); }
  }

  orchestration(): OrchestrationState | null {
    return readJson<OrchestrationState>(join(this.stateRoot, "orchestration.json"));
  }

  visibleTasks(): OrchestrationTask[] {
    const state = this.orchestration();
    if (!state) return [];
    return Object.values(state.tasks).filter(task => this.mode === "managed" ? task.id === process.env.AGENT_POLICY_TASK_ID : true);
  }

  orchestrationStatus(): { mode: PolicyMode; tasks: OrchestrationTask[]; messages: Array<{ id: string; taskId: string; status: string; body: string }>; results: Array<{ id: string; text?: string; error?: string }> } {
    const state = this.orchestration();
    const tasks = this.visibleTasks();
    const ids = new Set(tasks.map(task => task.id));
    const messages = Object.values(state?.messages ?? {}).filter(message => ids.has(message.taskId) && (this.mode !== "managed" || message.recipientId === this.state.actorId || message.status === "awaiting_operator")).map(({ id, taskId, status, body }) => ({ id, taskId, status, body }));
    const results = readdirSync(join(this.stateRoot, "results"), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json")).sort().slice(-20).flatMap(entry => {
      const value = readJson<{ id: string; text?: string; error?: string }>(join(this.stateRoot, "results", entry.name));
      return value ? [value] : [];
    });
    return { mode: this.mode, tasks, messages, results };
  }

  // Dispatch belongs to the top layer: standalone Pi without Paseo refuses instead of writing unread requests.
  orchestrate(input: string): string {
    if (this.mode === "standalone") throw new Error("当前没有连接 Paseo；不能创建编排请求");
    if (!existsSync(join(this.stateRoot, "sessions"))) throw new Error("编排状态目录不可写");
    let action: Record<string, unknown>;
    try { action = JSON.parse(input) as Record<string, unknown>; } catch { throw new Error("编排操作不是有效 JSON"); }
    const task = this.task();
    if (this.mode === "managed" && !["orchestrator", "lane"].includes(task?.role ?? "")) throw new Error("当前角色不能派发或管理其他任务");
    const id = randomUUID();
    saveJson(join(this.stateRoot, "requests", `${id}.json`), { id, actorId: this.state.actorId, taskId: task?.id ?? null, attemptId: task?.attemptId ?? null, action });
    return id;
  }

  // Peer messages coordinate siblings; they are never authorization, a ruling, or a handoff of ownership.
  messagePeer(toTaskId: string, body: string): string {
    if (this.mode !== "managed") throw new Error("只有受编排管理的 agent 可以向同级发消息");
    const sender = this.task();
    if (!sender) throw new Error("当前会话未绑定编排任务");
    const target = this.orchestration()?.tasks[toTaskId];
    if (!target) throw new Error("目标任务不存在");
    if (target.id === sender.id) throw new Error("不能给自己发消息");
    if ((target.parentAgentId ?? null) !== (sender.parentAgentId ?? null)) throw new Error("只能与同一上游下的同级任务通信");
    if (!body.trim() || body.length > 16384) throw new Error("消息为空或过长");
    const id = randomUUID();
    saveJson(join(this.stateRoot, "requests", `${id}.json`), { id, actorId: this.state.actorId, taskId: sender.id, attemptId: sender.attemptId, action: { action: "message", toTaskId, body } });
    return id;
  }

  requestDecision(message: string): string {
    const task = this.task();
    if (!task || task.agentId !== this.state.actorId || ENDED.includes(task.phase)) throw new Error("当前会话未绑定有效的编排任务");
    if (!message.trim() || message.length > 16384) throw new Error("请求内容为空或过长");
    const id = randomUUID();
    saveJson(join(this.stateRoot, "requests", `${id}.json`), { id, taskId: task.id, attemptId: task.attemptId, actorId: this.state.actorId, message, createdAt: new Date().toISOString() });
    return id;
  }

  inbox(): Array<{ id: string; body: string }> {
    const directory = join(this.stateRoot, "inbox", digest(this.state.actorId));
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).sort().flatMap(name => {
      const entry = readJson<{ id: string; recipientId: string; body: string }>(join(directory, name));
      if (!entry || entry.recipientId !== this.state.actorId || existsSync(join(this.stateRoot, "acks", `${entry.id}.json`))) return [];
      return [{ id: entry.id, body: entry.body }];
    }).slice(0, 20);
  }

  acknowledge(id: string): void {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error("消息编号无效");
    const entry = readJson<{ recipientId: string }>(join(this.stateRoot, "inbox", digest(this.state.actorId), `${id}.json`));
    if (entry?.recipientId !== this.state.actorId) throw new Error("不能确认其他接收者的消息");
    saveJson(join(this.stateRoot, "acks", `${id}.json`), { recipientId: this.state.actorId, acknowledgedAt: new Date().toISOString() });
  }

  async context(): Promise<string> {
    let current: string | null = null;
    let statusError: string | null = null;
    try { if (existsSync(join(this.cwd, ".git"))) current = await revision(this.cwd, this.config); }
    catch (error) { statusError = String(error); }
    const task = this.task();
    return JSON.stringify({
      collectedAt: new Date().toISOString(), mode: this.mode, cwd: this.cwd,
      task: task ? { id: task.id, role: task.role, phase: task.phase, paths: task.paths ?? [], allowCommit: Boolean(task.allowCommit) } : null,
      limits: { maxRepeatRuns: this.config.maxRepeatRuns }, toolCalls: this.state.toolCalls, lastRun: this.state.lastRun, statusError,
      checks: Object.fromEntries(Object.entries(this.state.checks).map(([key, result]) => [key, { passed: result.passed && result.revision === current, checkedAt: result.checkedAt }])),
      inbox: this.inbox(), guidance: BUDGET_GUIDANCE,
    });
  }

  async incomplete(): Promise<string[]> {
    if (this.mode !== "managed" || !this.state.touched.length) return [];
    const current = await revision(this.cwd, this.config);
    const missing = this.config.requiredChecks.filter(key => !this.state.checks[key]?.passed || this.state.checks[key]?.revision !== current);
    return missing.map(key => `检查未通过或结果已失效：${key}`);
  }

  shutdown(): void {
    this.lifecycle.abort();
    this.persist();
    this.stopped = true;
    if (!this.active.size) this.lease.release();
  }
}
