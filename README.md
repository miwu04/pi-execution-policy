# Pi Execution Policy

在 Git 仓库根目录使用，默认只读；配置示例见 `execution-policy.example.json`，通过 `PI_EXECUTION_POLICY_CONFIG` 指定配置，通过 `AGENT_POLICY_STATE_DIR` 指定状态目录，未指定时使用 `~/.local/state/agent-policy`。

用户命令登记授权与独立审查，模型通过受控入口查询 Git、删除授权文件、执行检查、计数、登记回执和提交；提交需要 `allowCommit: true`、独立审查与用户对当前完整改动的批准，检查命令会执行项目代码且子进程仍有当前系统用户权限，Git 钩子及其他已加载扩展同样属于可信代码，本插件不是操作系统隔离，状态恢复后必须重新授权，项目配置在启动时读取且运行中不能由模型修改。

```text
/policy status
/policy grant {"paths":["src/","tests/"],"expiresAt":"<ISO 时间>","allowCommit":false}
/policy review {"reviewerId":"<独立审查者编号>","reportPath":"<报告绝对路径>","verdict":"pass"}
/policy approve
/policy revoke
```
