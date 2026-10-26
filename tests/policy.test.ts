import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../src/config.ts";
import { PolicyController, type ManagedTask } from "../src/controller.ts";
import { git } from "../src/process.ts";
import { readJson, saveJson } from "../src/storage.ts";
import { revision } from "../src/repository.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.test-work/policy");
after(() => rmSync(root, { recursive: true, force: true }));
const KEYS = ["AGENT_POLICY_TASK_ID", "AGENT_POLICY_ATTEMPT_ID", "AGENT_POLICY_ROLE"] as const;

async function workspace(settings: Record<string, unknown> = {}) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  const cwd = realpathSync(mkdtempSync(join(directory, "repo-")));
  await git(cwd, ["init", "--quiet"]);
  writeFileSync(join(cwd, "app.txt"), "original\n");
  await git(cwd, ["add", "--", "app.txt"]);
  await git(cwd, ["commit", "--quiet", "-m", "Initial test content"]);
  const config = ConfigSchema.parse(settings);
  const stateRoot = join(directory, "state");
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  const restore = () => { for (const key of KEYS) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  const open = (sessionId: string, actorId?: string) => new PolicyController({ cwd, config, stateRoot, sessionId, actorId });
  const sessions: PolicyController[] = [];
  const create = (sessionId: string, actorId?: string) => { const value = open(sessionId, actorId); sessions.push(value); return value; };
  after(() => { for (const value of sessions) value.shutdown(); restore(); rmSync(directory, { recursive: true, force: true }); });
  const task = (extra: Partial<ManagedTask> = {}): ManagedTask => {
    const record: ManagedTask = { id: crypto.randomUUID(), agentId: "agent-1", attemptId: crypto.randomUUID(), cwd, role: "worker", phase: "running", paths: ["app.txt"], allowCommit: false, ...extra };
    saveJson(join(stateRoot, "orchestration.json"), { tasks: { [record.id]: record } });
    process.env.AGENT_POLICY_TASK_ID = record.id;
    process.env.AGENT_POLICY_ATTEMPT_ID = record.attemptId;
    process.env.AGENT_POLICY_ROLE = record.role;
    return record;
  };
  return { cwd, directory, stateRoot, config, create, open, task, restore };
}

test("standalone Pi applies no policy and writes no session state", async () => {
  const s = await workspace();
  s.restore();
  const policy = s.create("solo");
  assert.equal(policy.mode, "standalone");
  for (const name of ["write", "edit", "bash", "todo", "ask_advisor", "mcp__unknown__write"]) policy.gate(name, name, { path: "app.txt" });
  assert.equal(existsSync(join(s.stateRoot, "sessions")), false);
  assert.equal(JSON.parse(await policy.context()).mode, "standalone");
});

test("a top-level Paseo session may dispatch but cannot answer its own decision request", async () => {
  const s = await workspace();
  s.restore();
  const policy = s.create("top", "agent-top");
  assert.equal(policy.mode, "orchestrator");
  for (const name of ["write", "edit", "bash", "todo"]) policy.gate(name, name, { path: "app.txt" });
  const id = policy.orchestrate(JSON.stringify({ action: "status" }));
  assert.ok(readJson(join(s.stateRoot, "requests", `${id}.json`)));
  assert.throws(() => policy.requestDecision("who decides?"), /未绑定有效的编排任务/);
});

test("standalone Pi refuses orchestration instead of writing requests nobody reads", async () => {
  const s = await workspace();
  s.restore();
  const policy = s.create("solo");
  assert.throws(() => policy.orchestrate(JSON.stringify({ action: "status" })), /没有连接 Paseo/);
  assert.equal(existsSync(join(s.stateRoot, "requests")), false);
});

test("a managed worker writes only inside the dispatched paths", async () => {
  const s = await workspace();
  s.task({ paths: ["app.txt"] });
  const policy = s.create("worker", "agent-1");
  assert.equal(policy.mode, "managed");
  writeFileSync(join(s.directory, "outside"), "untouched");
  symlinkSync(join(s.directory, "outside"), join(s.cwd, "escape"));
  for (const path of ["other.txt", "../outside", "escape", ".git/config"]) assert.throws(() => policy.gate(path, "write", { path }), /允许的路径|授权目录之外|元数据/);
  policy.gate("ok", "write", { path: "app.txt" });
  policy.finishTool("ok");
  assert.equal(readFileSync(join(s.directory, "outside"), "utf8"), "untouched");
});

test("a managed worker without declared paths cannot write", async () => {
  const s = await workspace();
  s.task({ paths: [] });
  const policy = s.create("worker", "agent-1");
  assert.throws(() => policy.gate("w", "write", { path: "app.txt" }), /没有声明写入路径/);
});

test("read-only roles cannot write, remove or commit", async () => {
  const s = await workspace();
  s.task({ role: "reviewer", paths: ["app.txt"], allowCommit: true });
  const policy = s.create("reviewer", "agent-1");
  assert.throws(() => policy.gate("w", "write", { path: "app.txt" }), /reviewer 不允许写入/);
  assert.throws(() => policy.remove("app.txt"), /reviewer 不允许写入/);
  await assert.rejects(policy.commit(["app.txt"], "message"), /reviewer 不允许写入/);
});

test("a stale attempt or closed phase stops the worker from writing", async () => {
  const s = await workspace();
  const record = s.task({ paths: ["app.txt"] });
  const policy = s.create("worker", "agent-1");
  policy.gate("w", "write", { path: "app.txt" });
  policy.finishTool("w");
  process.env.AGENT_POLICY_ATTEMPT_ID = crypto.randomUUID();
  assert.throws(() => policy.gate("w2", "write", { path: "app.txt" }), /执行阶段已经变化/);
  process.env.AGENT_POLICY_ATTEMPT_ID = record.attemptId as string;
  saveJson(join(s.stateRoot, "orchestration.json"), { tasks: { [record.id]: { ...record, phase: "accepted" } } });
  assert.throws(() => policy.gate("w3", "write", { path: "app.txt" }), /阶段已经结束/);
});

test("a managed commit needs dispatcher approval bound to the exact content and paths", async () => {
  const s = await workspace();
  const record = s.task({ paths: ["app.txt"], allowCommit: true });
  const policy = s.create("worker", "agent-1");
  policy.gate("w", "write", { path: "app.txt" });
  writeFileSync(join(s.cwd, "app.txt"), "changed\n");
  policy.finishTool("w");
  await assert.rejects(policy.commit(["app.txt"], "Change"), /缺少派发方对当前执行阶段的提交批准/);
  saveJson(join(s.stateRoot, "approvals", `${record.id}.json`), { attemptId: record.attemptId, revision: await revision(s.cwd, s.config), paths: ["app.txt"] });
  writeFileSync(join(s.cwd, "app.txt"), "later content\n");
  await assert.rejects(policy.commit(["app.txt"], "Change"), /提交批准已因内容变化失效/);
  saveJson(join(s.stateRoot, "approvals", `${record.id}.json`), { attemptId: record.attemptId, revision: await revision(s.cwd, s.config), paths: ["app.txt"] });
  const commit = await policy.commit(["app.txt"], "Change");
  assert.equal((await git(s.cwd, ["show", `${commit}:app.txt`])).trim(), "later content");
});

test("a top-level commit needs no approval but still refuses sweeping unrelated changes", async () => {
  const s = await workspace();
  s.restore();
  const policy = s.create("solo");
  writeFileSync(join(s.cwd, "app.txt"), "changed\n");
  writeFileSync(join(s.cwd, "extra.txt"), "extra\n");
  await assert.rejects(policy.commit(["app.txt"], "Partial"), /提交必须覆盖当前完整改动/);
  const commit = await policy.commit(["app.txt", "extra.txt"], "Both files");
  assert.match(commit, /^[a-f0-9]{40}$/);
});

test("two runtimes in the same repository cannot hold the writing lease together", async () => {
  const s = await workspace();
  s.task();
  const first = s.create("worker", "agent-1");
  first.gate("a", "edit", { path: "app.txt" });
  const second = s.create("worker-2", "agent-1");
  assert.throws(() => second.gate("b", "edit", { path: "app.txt" }), /已有写入者/);
  first.finishTool("a");
  second.gate("c", "edit", { path: "app.txt" });
  second.finishTool("c");
});

test("a reviewer session publishes evidence for the task it reviewed", async () => {
  const s = await workspace();
  const subject = s.task({ paths: ["app.txt"] });
  const reviewer = s.task({ role: "reviewer", paths: [], subjectTaskId: subject.id, subjectGeneration: 1 });
  const policy = s.create("reviewer", "agent-1");
  const report = join(s.directory, "report.md");
  writeFileSync(report, "Reviewed the patch; no blockers.\n");
  await policy.recordReview({ reviewerId: "independent-reviewer", reportPath: report, verdict: "pass" });
  const evidence = readJson<{ subjectTaskId: string; verdict: string; reportDigest: string }>(join(s.stateRoot, "reviews", `${subject.id}.json`));
  assert.equal(evidence?.subjectTaskId, subject.id);
  assert.equal(evidence?.verdict, "pass");
  assert.ok(evidence?.reportDigest);
  assert.equal(reviewer.role, "reviewer");
});

test("checks count real runs and a changed tree invalidates them", async () => {
  const s = await workspace({ checks: { test: { command: process.execPath, args: ["-e", "process.exit(0)"] } }, requiredChecks: ["test"] });
  s.task();
  const policy = s.create("worker", "agent-1");
  const result = await policy.check("test", 3);
  assert.equal(result.passed, 3);
  assert.equal(policy.state.checks.test.passed, true);
  writeFileSync(join(s.cwd, "app.txt"), "changed\n");
  assert.equal(JSON.parse(await policy.context()).checks.test.passed, false);
});

test("a managed agent cannot sleep or poll instead of ending its turn", async () => {
  const s = await workspace();
  s.task();
  const policy = s.create("worker", "agent-1");
  for (const command of ["sleep 30", "while true; do sleep 5; done", "timeout 60 sleep 30", "inotifywait -e modify report.md"]) {
    assert.throws(() => policy.gate("wait", "bash", { command }), /不能用 sleep 或轮询等待上游/);
  }
  policy.gate("normal", "bash", { command: "git status --short" });
});

test("a standalone session may still wait deliberately", async () => {
  const s = await workspace();
  s.restore();
  const policy = s.create("solo");
  policy.gate("wait", "bash", { command: "sleep 30" });
});

test("a managed agent can message a sibling but not across different upstreams", async () => {
  const s = await workspace();
  const base = { id: crypto.randomUUID(), attemptId: crypto.randomUUID(), cwd: s.cwd, role: "worker", phase: "running", paths: ["app.txt"], allowCommit: false };
  const mine = { ...base, agentId: "agent-1", parentAgentId: "agent-top" };
  const sibling = { ...base, id: crypto.randomUUID(), agentId: "agent-2", attemptId: crypto.randomUUID(), parentAgentId: "agent-top" };
  const stranger = { ...base, id: crypto.randomUUID(), agentId: "agent-3", attemptId: crypto.randomUUID(), parentAgentId: "other-top" };
  saveJson(join(s.stateRoot, "orchestration.json"), { tasks: { [mine.id]: mine, [sibling.id]: sibling, [stranger.id]: stranger } });
  process.env.AGENT_POLICY_TASK_ID = mine.id;
  process.env.AGENT_POLICY_ATTEMPT_ID = mine.attemptId;
  process.env.AGENT_POLICY_ROLE = "worker";
  const policy = s.create("worker", "agent-1");
  const id = policy.messagePeer(sibling.id, "The interface changed; read the new signature before writing.");
  assert.equal(readJson<{ action: { action: string; body: string } }>(join(s.stateRoot, "requests", `${id}.json`))?.action.action, "message");
  assert.throws(() => policy.messagePeer(stranger.id, "hello"), /同一上游/);
  assert.throws(() => policy.messagePeer(mine.id, "hello"), /不能给自己/);
});

test("removal deletes one authorized file and never a directory", async () => {
  const s = await workspace();
  s.task({ paths: ["app.txt", "folder"] });
  const policy = s.create("worker", "agent-1");
  mkdirSync(join(s.cwd, "folder"));
  assert.throws(() => policy.remove("folder"), /不递归删除目录/);
  policy.remove("app.txt");
  assert.equal(existsSync(join(s.cwd, "app.txt")), false);
});
