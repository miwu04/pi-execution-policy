import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUDGET_GUIDANCE, GrantSchema, ReviewSchema, type Config, type Grant } from "./config.ts";
import { canonical, changedFiles, inside, permitted, revision } from "./repository.ts";
import { git, runCommand, type CommandResult } from "./process.ts";
import { digest, readJson, saveJson, WriteLease } from "./storage.ts";

type CheckRecord = { revision: string; passed: boolean; result: CommandResult; checkedAt: string };
type ReviewRecord = { revision: string; reviewerId: string; reportPath: string; reportContent: string; verdict: "pass" | "block" };
export interface PolicyState {
  schemaVersion: 1; sessionId: string; actorId: string; cwd: string;
  grant: Grant | null; toolCalls: number; initialDirty: string[]; touched: string[];
  checks: Record<string, CheckRecord>; review: ReviewRecord | null;
  approval: { revision: string; approvedAt: string } | null;
  lastRun: { id: string; check: string; requested: number; attempted: number; completed: number; status: "running" | "completed" | "failed" | "interrupted"; results: Array<Pick<CommandResult, "exitCode" | "timedOut" | "canceled">> } | null;
}

export class PolicyController {
  readonly cwd: string;
  readonly config: Config;
  readonly stateRoot: string;
  readonly state: PolicyState;
  readonly lease: WriteLease;
  readonly protectedPaths: string[];
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
    this.statePath = join(this.stateRoot, "sessions", `${digest(options.sessionId)}.json`);
    this.protectedPaths = [this.stateRoot, ...(options.configPath ? [canonical(resolve(options.configPath))] : [])];
    const old = readJson<PolicyState>(this.statePath);
    this.state = {
      schemaVersion: 1, sessionId: options.sessionId, actorId, cwd: this.cwd,
      grant: null, toolCalls: 0, initialDirty: [], touched: [], checks: {}, review: null, approval: null, lastRun: null,
      ...(old?.schemaVersion === 1 && old.cwd === this.cwd && old.actorId === actorId ? { initialDirty: old.initialDirty, touched: old.touched, checks: old.checks, lastRun: old.lastRun ? { ...old.lastRun, status: old.lastRun.status === "running" ? "interrupted" : old.lastRun.status } : null } : {}),
    };
    this.lease = new WriteLease(this.stateRoot, this.cwd, `${options.sessionId}:${process.pid}:${randomUUID()}`);
    this.persist();
  }

  private persist(): void { if (!this.stopped) saveJson(this.statePath, this.state); }
  private async control(action: () => Promise<void>): Promise<void> {
    if (this.stopped || this.active.size || this.controlBusy) throw new Error("执行过程中不能修改授权、审查或批准；请等待当前操作退出");
    this.controlBusy = true;
    try { await action(); } finally { this.controlBusy = false; }
  }
  private authorized(): Grant {
    if (this.stopped) throw new Error("执行会话已经关闭");
    const grant = this.state.grant;
    if (!grant || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("缺少有效授权；请由用户通过 /policy grant 登记范围和有效期");
    if (process.env.AGENT_POLICY_ROLE && process.env.AGENT_POLICY_ROLE !== "worker") throw new Error("当前只读角色不允许进入写入阶段");
    return grant;
  }
  private claim(id: string): void {
    this.authorized();
    if (this.active.size || this.controlBusy) throw new Error("该目录正在执行写入、检查或授权登记；必须串行执行");
    if (existsSync(join(this.stateRoot, "freezes", `${digest(this.cwd)}.json`))) throw new Error("该目录正在独立审查；待审查完成并登记处理结果后才能写入或运行检查");
    this.lease.acquire();
    this.active.add(id);
  }
  private path(path: string): string {
    const grant = this.authorized();
    const name = permitted(this.cwd, path, grant.paths, this.protectedPaths);
    if (!grant.allowExisting && this.state.initialDirty.includes(name)) throw new Error("目标包含授权前已有改动；需要用户明确接纳这些改动");
    return name;
  }

  async grant(input: unknown): Promise<void> {
    return this.control(async () => {
    const grant = GrantSchema.parse(input);
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("授权有效期必须晚于当前时间");
    if (process.env.AGENT_POLICY_ROLE && process.env.AGENT_POLICY_ROLE !== "worker") throw new Error("当前只读角色不能申请写入授权");
    if (!existsSync(join(this.cwd, ".git"))) throw new Error("写入与检查授权需要在 Git 仓库根目录登记");
    await revision(this.cwd, this.config);
    for (const path of grant.paths) permitted(this.cwd, path, grant.paths, this.protectedPaths);
    this.state.initialDirty = await changedFiles(this.cwd);
    this.state.grant = grant;
    this.state.toolCalls = 0;
    this.state.review = null;
    this.state.approval = null;
    this.persist();
    });
  }

  revoke(): void {
    if (this.active.size || this.controlBusy) throw new Error("执行过程中不能释放写入归属；先停止并等待命令退出");
    this.state.grant = null;
    this.state.approval = null;
    this.lease.release();
    this.persist();
  }

  gate(id: string, toolName: string, input: Record<string, unknown>): void {
    if (this.state.grant) {
      const limit = this.state.grant.maxToolCalls;
      if (limit !== undefined && this.state.toolCalls >= limit && !["policy_status", "policy_ack", "policy_request_decision"].includes(toolName)) {
        throw new Error("已达到用户设置的工具调用上限；需要报告剩余工作，不得降低完成标准");
      }
      this.state.toolCalls++;
      this.persist();
    }
    if (["policy_status", "policy_git", "policy_remove", "policy_ack", "policy_request_decision", "policy_check", "policy_repeat", "policy_commit"].includes(toolName)) return;
    if (toolName === "codemode") return; // Nested tool calls still pass through this gate.
    if (toolName === "write" || toolName === "edit") {
      if (typeof input.path !== "string") throw new Error("写入工具缺少明确路径");
      const path = this.path(input.path);
      this.claim(id);
      this.state.review = null;
      this.state.approval = null;
      if (!this.state.touched.includes(path)) this.state.touched.push(path);
      this.persist();
      return;
    }
    if (this.config.readTools.includes(toolName)) return;
    if (toolName === "ask_user_question" && !process.env.AGENT_POLICY_TASK_ID) return;
    throw new Error(`执行入口未获授权：${toolName}；原始 shell、外部写入和未知 MCP 工具默认拒绝`);
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
      this.state.review = null; this.state.approval = null;
      if (!this.state.touched.includes(name)) this.state.touched.push(name);
      this.persist();
    } finally { this.finishTool(id); }
  }

  finishTool(id: string): void {
    this.active.delete(id);
    if (this.stopped && !this.active.size) this.lease.release();
  }

  async check(key: string, count = 1, signal?: AbortSignal): Promise<{ runs: CommandResult[]; passed: number; failed: number }> {
    signal = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    const spec = this.config.checks[key];
    if (!spec) throw new Error(`未配置检查：${key}`);
    if (!Number.isInteger(count) || count < 1 || count > this.config.maxRepeatRuns) throw new Error("运行次数超出配置范围");
    const id = randomUUID();
    this.claim(id);
    this.state.approval = null;
    const runs: CommandResult[] = [];
    this.state.lastRun = { id, check: key, requested: count, attempted: 0, completed: 0, status: "running", results: [] };
    this.persist();
    try {
      const before = await revision(this.cwd, this.config);
      for (let i = 0; i < count; i++) {
        this.authorized();
        if (signal?.aborted) throw new Error("检查已取消");
        this.state.lastRun.attempted++;
        this.persist();
        const result = await runCommand(spec.command, spec.args, this.cwd, { signal, timeoutMs: Math.min(spec.timeoutMs, Date.parse(this.authorized().expiresAt) - Date.now()) });
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
      if (before !== after) { this.state.review = null; this.state.approval = null; }
      this.persist();
      return { runs, passed, failed: runs.length - passed };
    } catch (error) {
      delete this.state.checks[key];
      this.state.lastRun.status = "failed";
      this.persist();
      throw error;
    } finally { this.finishTool(id); }
  }

  async recordReview(input: unknown): Promise<void> {
    return this.control(async () => {
    this.authorized();
    this.lease.acquire();
    const review = ReviewSchema.parse(input);
    if ([this.state.actorId, this.state.sessionId].includes(review.reviewerId)) throw new Error("审查者不能是当前实现者");
    const reportPath = realpathSync(resolve(this.cwd, review.reportPath));
    const report = readFileSync(reportPath, "utf8");
    if (!report.trim()) throw new Error("审查报告为空");
    this.state.review = { ...review, reportPath, reportContent: digest(report), revision: await revision(this.cwd, this.config) };
    this.state.approval = null;
    this.persist();
    });
  }

  async approve(): Promise<void> {
    return this.control(async () => {
    if (!this.authorized().allowCommit) throw new Error("当前授权不包含提交");
    this.lease.acquire();
    const current = await revision(this.cwd, this.config);
    const review = this.state.review;
    if (!review || review.verdict !== "pass" || review.revision !== current || digest(readFileSync(review.reportPath)) !== review.reportContent) {
      throw new Error("缺少对应当前内容的通过审查报告");
    }
    const missing = this.config.requiredChecks.filter(key => !this.state.checks[key]?.passed || this.state.checks[key]?.revision !== current);
    if (missing.length) throw new Error(`缺少适用的通过结果：${missing.join(", ")}`);
    for (const path of await changedFiles(this.cwd)) this.path(path);
    this.state.approval = { revision: current, approvedAt: new Date().toISOString() };
    this.persist();
    });
  }

  async commit(paths: string[], message: string, signal?: AbortSignal): Promise<string> {
    signal = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    if (!paths.length || !message.trim()) throw new Error("需要明确的路径和提交说明");
    const id = randomUUID();
    this.claim(id);
    try {
      const approved = this.state.approval?.revision;
      if (!this.authorized().allowCommit || !approved || approved !== await revision(this.cwd, this.config)) throw new Error("提交批准缺失或已因内容变化失效");
      const review = this.state.review;
      if (!review || digest(readFileSync(review.reportPath)) !== review.reportContent) throw new Error("审查报告已经变化，需要重新批准");
      const approvedPaths = [...new Set(paths.map(path => this.path(path)))];
      const changed = await changedFiles(this.cwd);
      if (changed.length !== approvedPaths.length || changed.some(path => !approvedPaths.includes(path))) throw new Error("提交必须覆盖当前已审查的完整改动；独立行为需分开实现、审查和批准");
      for (const path of approvedPaths) {
        if (!this.state.touched.includes(path) && !this.authorized().allowExisting) throw new Error(`不是当前实现者登记的改动：${path}`);
      }
      if ((await git(this.cwd, ["diff", "--cached", "--name-only"], signal)).trim()) throw new Error("暂存区已有内容；请先明确其归属，不自动纳入提交");
      await git(this.cwd, ["config", "user.name"], signal);
      await git(this.cwd, ["config", "user.email"], signal);
      await git(this.cwd, ["add", "--", ...approvedPaths], signal);
      if (approved !== await revision(this.cwd, this.config)) throw new Error("暂存过程中内容变化，提交已停止");
      const expectedTree = (await git(this.cwd, ["write-tree"], signal)).trim();
      await git(this.cwd, ["commit", "-m", message], signal);
      const actualTree = (await git(this.cwd, ["rev-parse", "HEAD^{tree}"], signal)).trim();
      if (actualTree !== expectedTree) throw new Error("提交钩子改变了暂存内容；停止后续操作，需要检查已有提交");
      this.state.touched = this.state.touched.filter(path => !approvedPaths.includes(path));
      return (await git(this.cwd, ["rev-parse", "HEAD"], signal)).trim();
    } finally {
      this.state.approval = null;
      this.persist();
      this.finishTool(id);
    }
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

  requestDecision(message: string): string {
    const binding = readJson<{ taskId: string; attemptId: string }>(join(this.stateRoot, "bindings", `${digest(this.state.actorId)}.json`));
    const taskId = binding?.taskId ?? process.env.AGENT_POLICY_TASK_ID;
    const attemptId = binding?.attemptId ?? process.env.AGENT_POLICY_ATTEMPT_ID;
    if (!taskId || !attemptId || !/^[a-f0-9-]+$/.test(taskId) || !/^[a-f0-9-]+$/.test(attemptId)) throw new Error("当前会话未绑定插件管理的上游任务");
    const task = readJson<{ tasks: Record<string, { agentId: string; attemptId: string; phase: string }> }>(join(this.stateRoot, "orchestration.json"))?.tasks[taskId];
    if (!task || task.agentId !== this.state.actorId || task.attemptId !== attemptId || ["accepted", "canceled"].includes(task.phase)) throw new Error("上游任务已结束或当前执行阶段不匹配");
    if (!message.trim() || message.length > 16384) throw new Error("请求内容为空或过长");
    const id = randomUUID();
    saveJson(join(this.stateRoot, "requests", `${id}.json`), { id, taskId, attemptId, actorId: this.state.actorId, message, createdAt: new Date().toISOString() });
    return id;
  }

  async context(): Promise<string> {
    let current: string | null = null;
    let statusError: string | null = null;
    try { if (existsSync(join(this.cwd, ".git"))) current = await revision(this.cwd, this.config); }
    catch (error) { statusError = String(error); }
    return JSON.stringify({ collectedAt: new Date().toISOString(), actorId: this.state.actorId, cwd: this.cwd, grant: this.state.grant, authorizationValid: Boolean(!this.stopped && this.state.grant && Date.parse(this.state.grant.expiresAt) > Date.now()), limits: { maxRepeatRuns: this.config.maxRepeatRuns }, toolCalls: this.state.toolCalls, lastRun: this.state.lastRun, statusError, checks: Object.fromEntries(Object.entries(this.state.checks).map(([key, result]) => [key, { passed: result.passed && result.revision === current, checkedAt: result.checkedAt }])), inbox: this.inbox(), guidance: BUDGET_GUIDANCE });
  }

  async incomplete(): Promise<string[]> {
    if (!this.state.grant || !this.state.touched.length) return [];
    const current = await revision(this.cwd, this.config);
    const missing = this.config.requiredChecks.filter(key => !this.state.checks[key]?.passed || this.state.checks[key]?.revision !== current);
    return [...missing.map(key => `检查未通过或结果已失效：${key}`), ...(!this.state.review || this.state.review.verdict !== "pass" || this.state.review.revision !== current ? ["当前改动尚未登记通过的独立审查"] : [])];
  }

  shutdown(): void {
    this.lifecycle.abort();
    this.state.grant = null;
    this.state.approval = null;
    this.persist();
    this.stopped = true;
    if (!this.active.size) this.lease.release();
  }
}
