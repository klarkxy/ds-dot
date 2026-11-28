# IM 接入

## 动机

在飞书、Telegram、Slack 等 IM 里收到 dot 的消息，也能直接和她说话。

## 调研结论（2026-11，`@michengai/dsh-im-connect` 1.0.49）

社区插件 IM Connect 已覆盖钉钉、飞书、Lark、微信、企业微信、QQ、Telegram、Discord、Slack，能在 IM 里收发消息、回答提问、处理审批、回传 `tool-present` 交付文件。它的模型是"一个 IM 聊天绑定一个普通 DSH 会话"，直接复用到 dot 身上行不通：

- **绑不到 dot 的会话**：`/session <id>` 只接受 `sessionController.list` 里没有 `origin` 的普通会话（`engine/chat-commands.ts`）。dot 的会话以 `origin: 'subagent'` 创建（`src/host.ts`），会被拒绝；即使能绑，segment 交接后会话 id 会变，绑定随即失效。
- **没有给其他插件用的接口**：插件不 `ctx.provide` 任何服务，只在 `/api/michengai/dsh-im-connect/*` 注册设置页用的 HTTP 路由（账号、渠道、会话改名/移除），没有"往某个聊天发一条消息"或"把某个聊天交给别的插件处理"的入口。
- **审批的先后顺序**：IM Connect 以 `prepend` 全局监听 `approval/request` 和 `user-questions/request`；dot 的监听（`src/index.ts`）没有 `prepend`，所以 IM Connect 总是先拿到请求。对没有绑定 IM 聊天的会话它直接 `next()`，dot 照常和原会话卡片竞争（`raceApproval`）。dot 派出的运行会话是普通会话（`host.createSession` 不带 `origin`），用户可以手动 `/session <id>` 把它绑到 IM；一旦绑定，审批就在 IM 里由用户处理、不再调用 `next()`，dot 看不到这条审批，也不会套用她的高风险强制转人工规则（结果仍由用户本人决定）。
- dot 的卡片（Deep View）在 IM 里渲染不了，需要另行降级成文本 + 结构化回复。

## 推荐路线

1. **只推送**（dot 本体，小改动）：把"需要你"的事项（#39 的 `attention` 投影：dot 的交互卡片、等待验收的交付）推到用户配置的通知地址——ntfy / Bark / 通用 webhook，可选 Telegram `sendMessage`。只出不进，不需要绑定和权限模型；凭据走 DSH credentials 引用。
2. **向上游提议接口**（首选的双向方案）：请 IM Connect 提供一个插件服务，最小形态是
   - `send(chatKey, text | { text, buttons })`：往已绑定的聊天发消息；
   - `claim(chatKey, handler)`：让某个插件接管一个聊天的入站消息（dot 以"虚拟会话"身份接管，不占用真实会话绑定）；
   - `send` 必须同时接受这类被认领、但没有绑定 DSH 会话的聊天，否则 dot 无法回复；
   - 入站消息带上 IM Connect 已有的身份判定结果（扫码本人 / 已批准 / 群聊 @）。
   有了它，dot 只需把 IM 消息转进 `say` 路径，把回复和"需要你"事项发出去，渠道协议、扫码绑定、准入全部留在 IM Connect。
3. **自带最小适配器**（上游不接受时的后备）：dot 单独插件实现一个渠道（Telegram `getUpdates` 最简单），入站本人消息走 `say`，其他来源走收件箱 `submitInbox` 作为不可信事件。

## 权限模型（第 2、3 步动手前必须先定）

- 只有绑定过的本人账号发来的消息，才能和面板里的输入同等对待。群聊、其他人的消息一律是不可信数据，永远不构成授权。
- 即使是本人账号，审批也只接受明确的结构化回复（按钮，或者"批准 #id"），不从闲聊里推断批准。
- 绑定流程：面板生成一次性绑定码 → 在 IM 里发给机器人 → 记下账号 ID（走 IM Connect 时直接复用它的扫码白名单）。

## 回复规范

- IM 渠道回复 ≤ 100 词（出自原文 4.2 节）：IM 聊天窗口篇幅受限，对外回复需控制在 100 词以内，只保留结论与必要决策项；Web 聊天（Dorothy 面板）不设 100 词硬上限。

## 待定

- 第 1 步支持哪几种推送目标，以及推送内容的隐私边界（只推标题，还是带摘要）。
- 是否就第 2 步的接口给 IM Connect 提 issue / PR。
- 是否在 dot 派出的运行会话被绑到 IM 时提示用户（审批将绕过 dot），或在 dot 侧拒绝这种绑定。
