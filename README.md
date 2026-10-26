# Pi Execution Policy

在 Git 仓库根目录使用，配置示例见 `execution-policy.example.json`，通过 `PI_EXECUTION_POLICY_CONFIG` 指定配置，通过 `AGENT_POLICY_STATE_DIR` 指定状态目录，未指定时使用 `~/.local/state/agent-policy`。

插件按运行模式工作，`policy_status` 首字段给出当前模式：

- `standalone`：没有连接 Paseo。不加载任何编排状态，不限制工具，按用户要求直接执行。
- `orchestrator`：顶层 Paseo 会话。可直接作业，也可通过 `policy_orchestration` 派发任务；工具有调用不被角色限制。
- `managed`：被派发的 agent。按角色约束：`worker` 只能写派发方声明的 `paths`，提交还需要派发方对当前内容的批准和 `allowCommit`；只读角色不能写入、删除或提交；任务阶段结束或 attempt 变化立即失效。

约束只作用于 `managed` 会话，用来防止执行中的越界和内容错配，不提供操作系统隔离：检查命令以当前系统用户身份运行，Git 钩子和已加载的其他扩展属于可信代码，同账号进程可以绕过插件。

```text
/policy status
/policy review {"reviewerId":"<独立审查者编号>","reportPath":"<报告绝对路径>","verdict":"pass"}
/policy ack <消息编号>
```
