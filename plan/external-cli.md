# 外部 CLI（Agent Bridge）

## 动机

Codex、Claude Code、Kimi Code 等 CLI 各有专长。Agent Bridge（AB）已经把它们包装成 MCP 工具（`dispatch_task` 等）。

## 当前结论

- AB 作为 MCP 挂进 DSH 后，dot 派出的普通任务会话就能调用它，dot 主流程不用改。
- dot 自己继续不碰 AB：`DOT_INHERITED_ALLOW`（`src/tools.ts`）是白名单，她只负责派活和验收。
- 不把外部 CLI 做成 `RunSessionHost` 的另一种实现。投递回执、中途追加要求、宿主强制的只读边界、审批拦截，这些 DSH 会话的保障外部 CLI 都给不了。

## 动手前必须补的

1. ~~**只读运行会被绕过**~~ **已补**：只读运行（`access === 'read'` 或写范围为空）在工具预执行处拒绝名称不像查询的 `mcp__*` 工具——`mcpToolMayWrite`（`src/approval-risk.ts`）按 `mcp__<server>__<tool>` 名字取首词，非 `get`/`list`/`search` 等查询词一律当作可能写入；`guardRunWriteTool`（`src/peer.ts`）据此直接拒绝，`assessApprovalRisk` 也会把这类审批记 `read-only-write`。`mcp__agent_bridge__dispatch_task` 因此在只读运行里被拦下。
2. **确认 DSH 对 MCP 工具调用的默认审批策略**：如果默认自动批准，上面这个漏洞是一定会被绕过，而不只是可能。

## 待核实

- dot 停止任务会话时，AB 拉起的 CLI 会不会变成孤儿进程。要看 AB 有没有取消接口，以及 DSH 停会话时会不会通知 MCP。
- 是否要在派活提示里加几句关于 AB 的说明，让 dot 主动把合适的任务交给专武。先用一阵再决定。
