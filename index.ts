import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigSchema } from "./src/config.ts";
import { PolicyController } from "./src/controller.ts";

export default function contribute(pi: ExtensionAPI) {
  let policy: PolicyController | undefined;
  let startupError = "执行约束插件尚未初始化";
  let reminded = false;
  const current = () => { if (!policy) throw new Error(startupError); return policy; };
  const reply = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, isError });

  pi.on("session_start", (_event, ctx) => {
    try {
      const configPath = resolve(process.env.PI_EXECUTION_POLICY_CONFIG ?? join(ctx.cwd, ".pi", "execution-policy.json"));
      const config = ConfigSchema.parse(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {});
      policy = new PolicyController({
        cwd: ctx.cwd, config, configPath,
        stateRoot: process.env.AGENT_POLICY_STATE_DIR ?? join(homedir(), ".local", "state", "agent-policy"),
        sessionId: ctx.sessionManager.getSessionId(), actorId: process.env.PASEO_AGENT_ID,
      });
      const label = policy.mode === "managed" ? "受编排角色约束" : policy.mode === "orchestrator" ? "顶层编排" : "独立运行";
      ctx.ui.setStatus("execution-policy", `执行约束：${label}`);
    } catch (error) {
      policy = undefined;
      startupError = String(error);
      ctx.ui.notify(`执行约束初始化失败：${startupError}`, "error");
    }
  });

  pi.on("tool_call", event => {
    try { current().gate(event.toolCallId, event.toolName, event.input as Record<string, unknown>); }
    catch (error) { return { block: true, reason: String(error) }; }
  });
  pi.on("tool_result", event => { policy?.finishTool(event.toolCallId); });
  pi.on("before_agent_start", () => { reminded = false; });
  pi.on("context", async event => ({
    messages: [...event.messages.filter(message => !(message.role === "custom" && message.customType === "execution-policy-state")), {
      role: "custom" as const, customType: "execution-policy-state", content: policy ? await policy.context() : startupError,
      display: false, timestamp: Date.now(),
    }],
  }));
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!policy || reminded || ctx.signal?.aborted) return;
    const issues = await policy.incomplete();
    if (!issues.length) return;
    reminded = true;
    return {
      entries: [{ type: "custom_message" as const, customType: "execution-policy-incomplete", content: `执行记录未满足交付条件：${issues.join("；")}。`, display: true }],
      continue: event.context.canContinue && issues.some(issue => issue.startsWith("检查")),
    };
  });
  pi.on("session_shutdown", () => { policy?.shutdown(); policy = undefined; });

  pi.registerCommand("policy", {
    description: "status | review <JSON> | ack <消息编号>；只读查看与审查登记",
    handler: async (args, ctx) => {
      const split = args.indexOf(" ");
      const action = split < 0 ? args.trim() : args.slice(0, split);
      const body = split < 0 ? "" : args.slice(split + 1).trim();
      const controller = current();
      try {
        if (action === "review") await controller.recordReview(JSON.parse(body));
        else if (action === "ack") controller.acknowledge(body);
        else if (action && action !== "status") throw new Error("未知操作；使用 status、review 或 ack");
        ctx.ui.notify(await controller.context(), "info");
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });

  pi.registerTool({
    name: "policy_status", label: "执行约束状态", description: "读取当前运行模式、角色范围、实际检查结果和未确认消息。",
    parameters: Type.Object({}), async execute() { return reply(await current().context()); },
  });
  pi.registerTool({
    name: "policy_ack", label: "确认收到上游消息", description: "按消息编号登记接收回执；回执不代表批准或任务完成。",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_id, params) { current().acknowledge(params.messageId); return reply({ acknowledged: params.messageId }); },
  });
  pi.registerTool({
    name: "policy_message_peer", label: "给同级任务发消息", description: "向同一上游下的另一个受管任务发送事实或接口信息。同级消息不是裁决、不是授权，也不改变对方的任务合同。",
    parameters: Type.Object({ toTaskId: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1, maxLength: 16_384 }) }),
    async execute(_id, params) { return reply({ requestId: current().messagePeer(params.toTaskId, params.message), status: "queued" }); },
  });
  pi.registerTool({
    name: "policy_request_decision", label: "向上游请求裁决", description: "向绑定任务的上游发送自包含问题；不能自行扩大授权。",
    parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 16_384 }) }),
    async execute(_id, params) { return reply({ requestId: current().requestDecision(params.message), status: "queued" }); },
  });
  pi.registerTool({
    name: "policy_orchestration", label: "受控编排操作", description: "向 Paseo 编排插件提交任务创建、续跑、审查、验收、撤销或回执请求。输入必须是编排操作 JSON。",
    parameters: Type.Object({ input: Type.String({ minLength: 2, maxLength: 65_536 }) }),
    async execute(_id, params) { return reply({ requestId: current().orchestrate(params.input), status: "queued" }); },
  });
  pi.registerTool({
    name: "policy_orchestration_status", label: "读取编排状态", description: "读取当前模式下的任务、消息和控制请求结果。",
    parameters: Type.Object({}), async execute() { return reply(current().orchestrationStatus()); },
  });
  pi.registerTool({
    name: "policy_git", label: "只读 Git 查询", description: "使用固定只读操作查看状态、差异、历史、提交或当前版本，不接受任意 Git 参数。",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("show"), Type.Literal("head")]), paths: Type.Optional(Type.Array(Type.String())), ref: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params) { return reply(await current().inspectGit(params.operation, params.paths, params.ref, params.limit)); },
  });
  pi.registerTool({
    name: "policy_remove", label: "删除授权文件", description: "只删除授权范围内的单个文件，不递归删除目录，不删除运行状态或 Git 元数据。",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    async execute(_id, params) { current().remove(params.path); return reply({ removed: params.path }); },
  });
  pi.registerTool({
    name: "policy_check", label: "执行已配置检查", description: "执行用户配置的命令并记录真实退出状态。不会通过 shell 执行，不自动重试。",
    parameters: Type.Object({ check: Type.String() }),
    async execute(_id, params, signal) {
      const value = await current().check(params.check, 1, signal);
      return reply(value, value.passed !== 1 || !current().state.checks[params.check]?.passed);
    },
  });
  pi.registerTool({
    name: "policy_repeat", label: "按确切次数运行检查", description: "由代码循环并统计结果；取消或超时会停止，未运行次数不计成功。",
    parameters: Type.Object({ check: Type.String(), count: Type.Integer({ minimum: 1 }) }),
    async execute(_id, params, signal) {
      const value = await current().check(params.check, params.count, signal);
      return reply({ requested: params.count, completed: value.runs.length, ...value }, value.passed !== params.count || !current().state.checks[params.check]?.passed);
    },
  });
  pi.registerTool({
    name: "policy_commit", label: "提交改动", description: "只提交明确列出的路径；受编排约束时还要求派发方给出绑定当前内容的提交批准。不推送、不改写已有提交。",
    parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1 }), message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal) { return reply({ commit: await current().commit(params.paths, params.message, signal) }); },
  });
}
