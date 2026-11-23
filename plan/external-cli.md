# 外部 CLI（Agent Bridge）

## 动机

Codex、Claude Code、Kimi Code 等 CLI 各有专长。Agent Bridge（AB）已将它们封装为 MCP 工具（如 `dispatch_task`）。

## 当前结论

- AB 作为 MCP 接入 DSH 后，桃乐丝派出的普通任务会话可以直接调用它，dot 主流程无需改动。
- dot 自身继续不直接接触 AB：`DOT_INHERITED_ALLOW`（[`src/tools.ts`](../src/tools.ts)）保持白名单约束，她只负责派活与核验。
- 不将外部 CLI 做成 `RunSessionHost` 的另一种实现。投递回执、中途追加要求、宿主强制的只读边界与审批拦截，这些 DSH 会话保障外部 CLI 均无法提供。

## 动手前必须补齐

1. **防止只读运行被绕过**
   - 现状：只读边界依赖 DSH 沙箱强制，但 AB 的 MCP Server 是独立进程，它拉起的 CLI 不受 DSH 沙箱约束；`assessApprovalRisk` 的 `read-only-write`（[`src/approval-risk.ts`](../src/approval-risk.ts)）只识别写类工具名与 Shell 写命令，拦不住自然语言形式的 `dispatch_task`。
   - 做法：在只读运行中禁止调用 `mcp__agent_bridge__*`，或强制转交用户审批，并补齐对应测试。
2. **核实 DSH 对 MCP 工具调用的默认审批策略**
   - 如果宿主默认自动批准，上述漏洞将被必然绕过，而不只是潜在风险。

## 待核实

- dot 停止任务会话时，AB 拉起的子 CLI 是否会成为孤儿进程（需确认 AB 是否提供取消接口，以及 DSH 停会话时是否通知 MCP）。
- 是否需要在派活提示词里引导 dot 主动把合适任务交给专武 CLI，等实际跑通后再评估。
