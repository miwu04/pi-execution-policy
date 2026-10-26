import { z } from "zod";

export const CheckSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
}).strict();

export const ConfigSchema = z.object({
  checks: z.record(z.string(), CheckSchema).default({}),
  requiredChecks: z.array(z.string()).default([]),
  readTools: z.array(z.string()).default([
    "read", "grep", "find", "ls", "project_report", "module_report", "read_symbol",
    "read_enclosing", "symbol_search", "effective_config", "lens_diagnostics",
  ]),
  environmentKeys: z.array(z.string()).default(["PATH", "NODE_ENV", "CI"]),
  environmentFiles: z.array(z.string()).default([]),
  maxRepeatRuns: z.number().int().positive().max(1000).default(100),
}).strict().superRefine((value, ctx) => {
  for (const key of value.requiredChecks) {
    if (!value.checks[key]) ctx.addIssue({ code: "custom", message: `未配置检查：${key}` });
  }
  for (const name of value.readTools) {
    if (["bash", "powershell", "windows_shell_exec", "interactive_shell", "subagent", "write", "edit", "codemode", "policy_remove", "policy_check", "policy_repeat", "policy_commit"].includes(name)) {
      ctx.addIssue({ code: "custom", message: `不能将执行入口声明为只读：${name}` });
    }
  }
});
export type Config = z.infer<typeof ConfigSchema>;

export const GrantSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime(),
  allowCommit: z.boolean().default(false),
  allowExisting: z.boolean().default(false),
  maxToolCalls: z.number().int().positive().optional(),
}).strict();
export type Grant = z.infer<typeof GrantSchema>;

export const ReviewSchema = z.object({
  reviewerId: z.string().min(1),
  reportPath: z.string().min(1),
  verdict: z.enum(["pass", "block"]),
}).strict();

export const BUDGET_GUIDANCE = "简短要求只约束汇报，不降低调查、实现和验证要求。减少重复工作，不省略必要核验；不自行假定预算上限。真实限额不足时报告剩余工作，不降低完成标准。";
