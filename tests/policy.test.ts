import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../src/config.ts";
import { PolicyController } from "../src/controller.ts";
import { git, runCommand } from "../src/process.ts";
import { digest, readJson, saveJson } from "../src/storage.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.test-work/policy");
after(() => rmSync(root, { recursive: true, force: true }));
async function workspace(t: TestContext, settings: Record<string, unknown> = {}) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  const cwd = join(directory, "repo");
  mkdirSync(cwd);
  await git(cwd, ["init", "--quiet"]);
  writeFileSync(join(cwd, ".gitignore"), "runs.txt\n");
  writeFileSync(join(cwd, "app.txt"), "original\n");
  await git(cwd, ["add", "--", ".gitignore", "app.txt"]);
  await git(cwd, ["commit", "--quiet", "-m", "Initial test content"]);
  const config = ConfigSchema.parse(settings);
  const create = (id: string) => new PolicyController({ cwd, config, stateRoot: join(directory, "state"), sessionId: id });
  const policy = create("writer");
  t.after(() => policy.shutdown());
  const grant = (extra: Record<string, unknown> = {}) => policy.grant({ paths: ["app.txt", "new.txt"], expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra });
  return { cwd, directory, policy, grant, create };
}

test("no grant permits reading but blocks every raw execution or write entry", async t => {
  const { policy } = await workspace(t);
  policy.gate("read", "read", { path: "app.txt" });
  for (const name of ["write", "edit", "bash", "powershell", "windows_shell_exec", "mcp__unknown__write", "policy_grant"]) {
    assert.throws(() => policy.gate(name, name, { path: "app.txt" }));
  }
});

test("path ownership blocks traversal, Git metadata and a symlink escaping the repository", async t => {
  const { cwd, directory, policy, grant } = await workspace(t);
  await grant({ paths: ["."] });
  writeFileSync(join(directory, "outside"), "untouched");
  symlinkSync(join(directory, "outside"), join(cwd, "escape"));
  for (const path of ["../outside", "escape", ".git/config"]) assert.throws(() => policy.gate(path, "write", { path }));
  assert.equal(readFileSync(join(directory, "outside"), "utf8"), "untouched");
});

test("only one session can hold a repository's writing ownership", async t => {
  const { policy, grant, create } = await workspace(t);
  await grant();
  policy.gate("a", "edit", { path: "app.txt" });
  policy.finishTool("a");
  const second = create("another-writer");
  t.after(() => second.shutdown());
  await second.grant({ paths: ["app.txt"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.throws(() => second.gate("b", "edit", { path: "app.txt" }), /已有写入者/);
  policy.revoke();
  second.gate("c", "edit", { path: "app.txt" });
  second.finishTool("c");
});

test("simultaneous writes and permission changes cannot race an active operation", async t => {
  const { policy, grant } = await workspace(t);
  await grant();
  policy.gate("one", "write", { path: "app.txt" });
  assert.throws(() => policy.gate("two", "write", { path: "new.txt" }), /串行/);
  assert.throws(() => policy.revoke(), /执行过程中/);
  await assert.rejects(grant(), /执行过程中/);
  policy.finishTool("one");
  policy.revoke();
});

test("preexisting user changes are not silently adopted", async t => {
  const { cwd, policy, grant } = await workspace(t);
  writeFileSync(join(cwd, "app.txt"), "user changes\n");
  await grant();
  assert.throws(() => policy.gate("a", "edit", { path: "app.txt" }), /已有改动/);
  await grant({ allowExisting: true });
  policy.gate("b", "edit", { path: "app.txt" });
  policy.finishTool("b");
});

test("configured repetition executes exactly ten real commands and records their results", async t => {
  const { cwd, policy, grant } = await workspace(t, { checks: { count: { command: process.execPath, args: ["-e", "require('node:fs').appendFileSync('runs.txt', 'run\\n')"] } } });
  await grant();
  const result = await policy.check("count", 10);
  assert.equal(result.runs.length, 10);
  assert.equal(result.passed, 10);
  assert.equal(readFileSync(join(cwd, "runs.txt"), "utf8").trim().split("\n").length, 10);
  assert.equal(policy.state.checks.count.passed, true);
  assert.equal(JSON.parse(await policy.context()).lastRun.completed, 10);
  assert.equal(JSON.parse(await policy.context()).lastRun.status, "completed");
});

test("a failed command cannot count as a passed check", async t => {
  const { policy, grant } = await workspace(t, { checks: { failure: { command: process.execPath, args: ["-e", "process.exit(9)"] } }, requiredChecks: ["failure"] });
  await grant();
  const result = await policy.check("failure");
  assert.equal(result.failed, 1);
  assert.equal(policy.state.checks.failure.result.exitCode, 9);
  assert.equal(policy.state.checks.failure.passed, false);
});

test("changed content invalidates previous check results in the next context", async t => {
  const { cwd, policy, grant } = await workspace(t, { checks: { test: { command: process.execPath, args: ["-e", "process.exit(0)"] } }, requiredChecks: ["test"] });
  await grant();
  await policy.check("test");
  assert.equal(JSON.parse(await policy.context()).checks.test.passed, true);
  writeFileSync(join(cwd, "app.txt"), "changed after check\n");
  assert.equal(JSON.parse(await policy.context()).checks.test.passed, false);
});

test("independent review and exact user approval allow a scoped local commit, later edits revoke it", async t => {
  const { cwd, directory, policy, grant } = await workspace(t, { checks: { test: { command: process.execPath, args: ["-e", "process.exit(0)"] } }, requiredChecks: ["test"] });
  await grant({ allowCommit: true });
  policy.gate("write", "edit", { path: "app.txt" });
  writeFileSync(join(cwd, "app.txt"), "implemented\n");
  policy.finishTool("write");
  await assert.rejects(policy.commit(["app.txt"], "Implement scoped behavior"), /批准/);
  const reportPath = join(directory, "review.txt");
  writeFileSync(reportPath, "Independent review: behavior and failure cases checked, no blocking findings.\n");
  await assert.rejects(policy.recordReview({ reviewerId: "writer", reportPath, verdict: "pass" }), /不能是当前实现者/);
  await policy.recordReview({ reviewerId: "reviewer", reportPath, verdict: "pass" });
  await assert.rejects(policy.approve(), /检查|结果/);
  await policy.check("test");
  await policy.approve();
  writeFileSync(join(cwd, "app.txt"), "changed after approval\n");
  await assert.rejects(policy.commit(["app.txt"], "Must not commit"), /失效/);
  await policy.check("test");
  await policy.recordReview({ reviewerId: "reviewer", reportPath, verdict: "pass" });
  await policy.approve();
  const commit = await policy.commit(["app.txt"], "Implement scoped behavior");
  assert.equal((await git(cwd, ["show", `${commit}:app.txt`])).trim(), "changed after approval");
  assert.equal((await git(cwd, ["status", "--porcelain"])).trim(), "");
  assert.equal(policy.state.approval, null);
});

test("an existing staged file blocks commit without erasing the staged content", async t => {
  const { cwd, directory, policy, grant } = await workspace(t);
  await grant({ allowCommit: true });
  policy.gate("a", "edit", { path: "app.txt" });
  writeFileSync(join(cwd, "app.txt"), "new\n");
  policy.finishTool("a");
  const reportPath = join(directory, "review.txt");
  writeFileSync(reportPath, "Reviewed.\n");
  await policy.recordReview({ reviewerId: "reviewer", reportPath, verdict: "pass" });
  await policy.approve();
  await git(cwd, ["add", "--", "app.txt"]);
  await assert.rejects(policy.commit(["app.txt"], "Blocked"), /暂存区已有/);
  assert.equal((await git(cwd, ["show", ":app.txt"])).trim(), "new");
});

test("explicit call budgets block execution but permit requesting help", async t => {
  const { policy, grant } = await workspace(t);
  await grant({ maxToolCalls: 1 });
  policy.gate("one", "read", { path: "app.txt" });
  assert.throws(() => policy.gate("two", "read", { path: "app.txt" }), /上限/);
  policy.gate("status", "policy_status", {});
  assert.throws(() => ConfigSchema.parse({ readTools: ["bash"] }));
});

test("a restored session does not restore old write or commit permission", async t => {
  const { policy, grant, create } = await workspace(t);
  await grant({ allowCommit: true });
  policy.shutdown();
  const restored = create("writer");
  t.after(() => restored.shutdown());
  assert.equal(restored.state.grant, null);
  assert.equal(restored.state.approval, null);
  assert.throws(() => restored.gate("write", "write", { path: "app.txt" }));
});

test("timeouts and cancellation wait for process termination instead of reporting success", async t => {
  const { cwd } = await workspace(t);
  const timeout = await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], cwd, { timeoutMs: 100 });
  assert.equal(timeout.timedOut, true);
  assert.notEqual(timeout.exitCode, 0);
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 100);
  const result = await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], cwd, { signal: controller.signal });
  clearTimeout(cancel);
  assert.equal(result.canceled, true);
  assert.notEqual(result.exitCode, 0);
});

test("two runtimes opened on the same session cannot share its writing ownership", async t => {
  const { policy, grant, create } = await workspace(t);
  await grant();
  policy.gate("one", "edit", { path: "app.txt" }); policy.finishTool("one");
  const duplicate = create("writer"); t.after(() => duplicate.shutdown());
  await duplicate.grant({ paths: ["app.txt"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.throws(() => duplicate.gate("two", "edit", { path: "app.txt" }), /已有写入者/);
});

test("read-only Git queries treat filenames literally and reject execution options", async t => {
  const { cwd, policy } = await workspace(t);
  writeFileSync(join(cwd, "app[1].txt"), "bracket before\n");
  writeFileSync(join(cwd, "app1.txt"), "sibling before\n");
  await git(cwd, ["add", "--", "app[1].txt", "app1.txt"]);
  await git(cwd, ["commit", "--quiet", "-m", "Add literal path cases"]);
  writeFileSync(join(cwd, "app[1].txt"), "bracket after\n");
  writeFileSync(join(cwd, "app1.txt"), "sibling after\n");
  const diff = await policy.inspectGit("diff", ["app[1].txt"]);
  assert.match(diff, /bracket after/);
  assert.doesNotMatch(diff, /sibling after/);
  await assert.rejects(policy.inspectGit("show", [], "--output=stolen"), /参数无效/);
});

test("directory-wide commit requests cannot sweep unrelated content into a commit", async t => {
  const { cwd, directory, policy, grant } = await workspace(t);
  await grant({ paths: ["."], allowCommit: true });
  policy.gate("one", "write", { path: "app.txt" });
  writeFileSync(join(cwd, "app.txt"), "changed\n"); policy.finishTool("one");
  const reportPath = join(directory, "review.txt"); writeFileSync(reportPath, "Reviewed current change.\n");
  await policy.recordReview({ reviewerId: "other", reportPath, verdict: "pass" }); await policy.approve();
  await assert.rejects(policy.commit(["."], "Do not sweep"), /完整改动/);
  assert.equal((await git(cwd, ["diff", "--cached", "--name-only"])).trim(), "");
});

test("review-time freezing blocks mutations until its owning controller releases the record", async t => {
  const { cwd, directory, policy, grant } = await workspace(t);
  await grant();
  const freeze = join(directory, "state", "freezes", `${digest(cwd)}.json`);
  saveJson(freeze, { reviewerTaskId: "reviewer" });
  assert.throws(() => policy.gate("one", "edit", { path: "app.txt" }), /独立审查/);
  assert.match(await policy.inspectGit("show"), /Initial test content/);
  rmSync(freeze);
  policy.gate("two", "edit", { path: "app.txt" }); policy.finishTool("two");
});

test("removing a file observes authorization and never recursively removes a directory", async t => {
  const { cwd, policy, grant } = await workspace(t);
  assert.throws(() => policy.remove("app.txt"), /授权/);
  await grant({ paths: ["."] });
  mkdirSync(join(cwd, "directory"));
  assert.throws(() => policy.remove("directory"), /单个文件/);
  policy.remove("app.txt");
  assert.match(await policy.inspectGit("status"), /D app.txt/);
});

test("all non-worker roles remain read-only even if offered a user grant", async t => {
  const { grant } = await workspace(t);
  const previous = process.env.AGENT_POLICY_ROLE;
  try {
    for (const role of ["reviewer", "scout", "researcher", "oracle", "evidence-auditor"]) {
      process.env.AGENT_POLICY_ROLE = role;
      await assert.rejects(grant(), /只读角色/);
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_POLICY_ROLE; else process.env.AGENT_POLICY_ROLE = previous;
  }
});

test("upstream requests use the current shared attempt binding rather than old launch environment", async t => {
  const { directory, policy } = await workspace(t);
  const taskId = "00000000-0000-4000-8000-000000000001";
  const first = "00000000-0000-4000-8000-000000000002";
  const second = "00000000-0000-4000-8000-000000000003";
  const path = join(directory, "state", "bindings", `${digest("writer")}.json`);
  saveJson(path, { taskId, attemptId: first });
  saveJson(join(directory, "state", "orchestration.json"), { tasks: { [taskId]: { agentId: "writer", attemptId: first, phase: "running" } } });
  const one = policy.requestDecision("First decision");
  saveJson(path, { taskId, attemptId: second });
  saveJson(join(directory, "state", "orchestration.json"), { tasks: { [taskId]: { agentId: "writer", attemptId: second, phase: "running" } } });
  const two = policy.requestDecision("Second decision");
  assert.equal(readJson<{ attemptId: string }>(join(directory, "state", "requests", `${one}.json`))!.attemptId, first);
  assert.equal(readJson<{ attemptId: string }>(join(directory, "state", "requests", `${two}.json`))!.attemptId, second);
});

test("only a matching recipient can acknowledge a persisted inbox message", async t => {
  const { directory, policy } = await workspace(t);
  const id = "00000000-0000-4000-8000-000000000004";
  const file = join(directory, "state", "inbox", digest("writer"), `${id}.json`);
  saveJson(file, { id, recipientId: "writer", body: "Need a decision" });
  assert.equal(policy.inbox().length, 1);
  policy.acknowledge(id);
  assert.equal(policy.inbox().length, 0);
  saveJson(file, { id, recipientId: "someone-else", body: "Not yours" });
  assert.throws(() => policy.acknowledge(id), /其他接收者/);
});

test("authorization registration excludes concurrent model writes", async t => {
  const { policy, grant } = await workspace(t);
  await grant();
  const pending = grant();
  assert.throws(() => policy.gate("race", "edit", { path: "app.txt" }), /串行/);
  await pending;
  policy.gate("after", "edit", { path: "app.txt" }); policy.finishTool("after");
});

test("declared dependency inputs outside Git also invalidate a check", async t => {
  const { directory, policy, grant } = await workspace(t, { environmentFiles: ["../dependency-version.txt"], checks: { test: { command: process.execPath, args: ["-e", "process.exit(0)"] } } });
  writeFileSync(join(directory, "dependency-version.txt"), "version one");
  await grant(); await policy.check("test");
  assert.equal(JSON.parse(await policy.context()).checks.test.passed, true);
  writeFileSync(join(directory, "dependency-version.txt"), "version two");
  assert.equal(JSON.parse(await policy.context()).checks.test.passed, false);
});

test("grant expiration terminates a long-running configured check", async t => {
  const { policy, grant } = await workspace(t, { checks: { wait: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 10000 } } });
  await grant({ expiresAt: new Date(Date.now() + 350).toISOString() });
  const result = await policy.check("wait");
  assert.equal(result.runs[0].timedOut, true);
  assert.equal(policy.state.checks.wait.passed, false);
  assert.equal(JSON.parse(await policy.context()).authorizationValid, false);
});

test("shutdown cancels a configured command and releases only its own writing ownership", async t => {
  const { policy, grant, create } = await workspace(t, { checks: { wait: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } } });
  await grant();
  const command = policy.check("wait").then(value => value.passed === 0, () => true);
  await new Promise(resolve => setTimeout(resolve, 100));
  policy.shutdown();
  assert.equal(await command, true);
  const next = create("next-owner"); t.after(() => next.shutdown());
  await next.grant({ paths: ["app.txt"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  next.gate("next", "edit", { path: "app.txt" }); next.finishTool("next");
});
