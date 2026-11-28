# 投机复现（Speculative Bug Reproduction）

## 为什么想做

针对收件箱中的 GitHub Issue 或评论，在无人显式指派时，先在严格受限的只读隔离环境中静默尝试复现；仅当复现出确定性故障证据时才向用户提交修复提案，减少“空跑提问”与无效上下文打扰。对应原文 3.4 节「Acting in Advance」：只有确认问题存在并找到简单修复时才交付，否则全程保持安静。

## 当前结论

本轮暂不编码实现。待 P5（GitHub 轮询）与 P6（Watchdog）稳定运行 2–4 周、且 P6 近 14 天误报率校准至 `< 10%` 后再独立立项。P7 产生的 run 一律 `origin.strength = 'inferred'`；`observe` 模式在面板列出「本来会接（would accept）」的记录和理由，供人逐条复核；策略版本变更后，已有 run 在续作前需重新校验（参照原型的 `revalidate`）。届时遵循以下双层准入、四道安全边界与产出闭环设计：

### 1. 触发与双层准入

- **第一层确定性过滤**：复用 PR-5 的准入表（`candidate` 语义由 P7 新增第四态），并叠加 GitHub 专用的 `author_association` 门控（默认只允许 `OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR`，这一项是 `ds-dot` 自行补充的，不是原型原有设计）。
- **第二层语义评估**：移植 `dsh-superagent-prototype` `policy.ts` 的自然语言规则结构（改用 `zod` 校验）与 `would_accept` 判定，由用户配置的模型判断（届时新增独立设置项，默认复用 `watchdogModel`）是否具备可复现的客观故障描述。

### 2. 四道硬安全边界（防不可信 Issue 提示词注入）

1. **隔离工作树与零写权限**：在独立临时 `git worktree` 中以 `access: 'read', writeScope: { kind: 'paths', paths: [] }` 启动只读 run，`guardRunWriteTool` 硬拦所有文件写入与非查询 MCP。
2. **强制 OS 沙箱、凭证剥离与断网出站**：Shell 强制绑定 `bash-sandbox` / `pwsh-sandbox` 围栏并**禁止网络出站**（沙箱网络策略设为 `deny`，防止被注入的 Issue 诱导执行 `curl … | sh`），子进程环境剥离 `GH_TOKEN`、`GITHUB_TOKEN` 等外部写凭证，禁止任何向 GitHub 回帖的通道。
3. **无人值守静默拒批**：在 `approval-safe-auto` / `approval-relay` 中对 `speculative: true` 的 run 启用严格静默拒绝——凡触发越界写、敏感网络访问、`git push` 等审批请求一律自动返回 `deny`，绝不弹窗打扰用户。
4. **配额与巡检兜底**：默认模式 `off`（支持 `off | observe | auto`），全局并发上限 `1`，单次上限 `15` 步 / `10` 分钟，每日上限默认 `3` 次，全程接入 P6 Watchdog 防空转。

### 3. 产出闭环

- `observe` 模式：仅在 `trace` 记录“命中规则且拟尝试复现”的候选对象，不启动 run。
- `auto` 模式：复现成功时仅提取复现命令、退出码、错误栈摘要与源码行号定位，向 Dorothy 生成待用户批准的修复任务提案；复现失败静默记录归档，不发通知。

## 动手前要先确认的事

1. **P6 误报率达标**：近 14 天 Watchdog 命中数 / 误报率统计已验证 `< 10%`。
2. **沙箱网络隔离能力**：核实 `dsh-bash-sandbox` 与 `dsh-pwsh-sandbox` 在对应宿主版本是否原生支持 `network: deny` 策略及跨平台行为一致。
3. **配额与费用策略**：明确每日 `3` 次上限的重置时区、模型配置项及超出配额后的静默降级提示文案。
