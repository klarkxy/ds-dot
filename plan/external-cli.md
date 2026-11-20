# 外部 CLI（Agent Bridge）

## 动机

Codex、Claude Code、Kimi Code 等 CLI 各有专长。Agent Bridge（AB）已经把它们包装成 MCP 工具（`dispatch_task` 等）。

## 当前结论

- AB 作为 MCP 挂进 DSH 后，dot 派出的普通任务会话就能调用它，dot 主流程不用改。
- dot 自己继续不碰 AB：`DOT_INHERITED_ALLOW`（`src/tools.ts`）是白名单，她只负责派活和验收。
- 不把外部 CLI 做成 `RunSessionHost` 的另一种实现。投递回执、中途追加要求、宿主强制的只读边界、审批拦截，这些 DSH 会话的保障外部 CLI 都给不了。

## 动手前必须补的

1. **只读运行会被绕过**：只读边界靠 DSH 沙箱强制，但 AB 的 MCP server 是独立进程，它拉起的 CLI 不受沙箱约束。`assessApprovalRisk` 的 `read-only-write`（`src/approval-risk.ts`）只认写类工具名和 shell 写命令，拦不住一条自然语言的 `dispatch_task`。
   做法：只读运行里禁止调用 `mcp__agent_bridge__*`，或者强制交给用户审批。补对应测试。
2. **确认 DSH 对 MCP 工具调用的默认审批策略**：如果默认自动批准，上面这个漏洞是一定会被绕过，而不只是可能。

## 待核实

- dot 停止任务会话时，AB 拉起的 CLI 会不会变成孤儿进程。要看 AB 有没有取消接口，以及 DSH 停会话时会不会通知 MCP。
- 是否要在派活提示里加几句关于 AB 的说明，让 dot 主动把合适的任务交给专武。先用一阵再决定。
