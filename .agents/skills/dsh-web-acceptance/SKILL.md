---
name: dsh-web-acceptance
description: "指引 Agent 启动完全隔离的 DeepSeek Harness (dsh web) 实例进行前端/插件验收、无头截图与高清交互 GIF 录制。当需要验证 dsh web 界面、测试 DSH 插件（如 ds-dot）、排查 Web UI 渲染/多语言/暗色模式问题、截取验收图或为前端 PR 录制真实交互 GIF 时使用。"
---
# dsh-web-acceptance

启动与宿主环境完全隔离的临时 `dsh web` 实例（独立 `DSH_HOME`、随机空闲回环端口、脱敏环境变量与免泄露 Cookie 鉴权），通过 Playwright 完成自动化 UI 验收、高清截图与双通道调色板 GIF 录制，并在销毁目录前安全回收进程树。

## When to Use

- 修改了 DSH 插件前端组件（如 `src/**/*.tsx`、样式作用域、图标、`locale/*.json` 文案）后，需要在真实 `dsh web` 容器里做端到端视觉与交互验收
- 为包含前端改动的代码分支（如 `ds-dot` PR）录制真实界面交互 GIF，且严禁污染本机 `~/.dsh` 或泄露 API Key、启动 `?token=`、Cookie 及个人会话记录
- 在本地同时运行着主 `dsh web`（默认 `127.0.0.1:3080`）或 DSH Desktop 时，需要并行拉起互不冲突的干净测试实例验证新构建产物
- 需要批量验证多语言（如 `zh-CN` / `en-US` / `ja-JP`）或亮暗主题（`light` / `dark`）下的布局溢出、层级遮挡与接口报错

## Steps

### 1. 预构建待测产物并确认输出目录隔离

`dsh web` 直接加载预编译产物，不会替插件或宿主自动执行源码构建。启动隔离实例前先在目标仓库完成构建与门禁检查：

- **测试 DSH 插件仓库（如 `ds-dot`）**：执行 `pnpm typecheck && pnpm test && pnpm build`，确认 `package.json` 中声明的 `main`（如 `lib/index.js`）与 `./client`（如 `lib/client.js`）均已生成。
- **测试 `deepseek-harness` 核心仓库**：在仓库根目录执行 `pnpm run build`，再用 `--dsh-cmd "pnpm dsh"` 启动。
- **输出目录隔离**：把所有截图、视频与 GIF 输出到仓库外的系统临时目录（例如 `/tmp/dsh-qa-*` 或 `%TEMP%\dsh-qa-*`），不要写入 Git 分支目录。

### 2. 调用捆绑脚本一键执行隔离验收与录制（默认路径）

优先调用本技能自带的跨平台脚本 `scripts/dsh-qa-harness.js`（支持 Windows / macOS / Linux，要求 Node.js >= 22），它已固化端口分配、插件挂载、Token 换取 Cookie、错误拦截、GIF 转码与安全清理全流程：

```sh
node <skill-dir>/scripts/dsh-qa-harness.js \
  --plugin /abs/path/to/plugin-repo \
  --scenario /tmp/qa-scenario.mjs \
  --viewport 1440x900 \
  --locale zh-CN \
  --gif-name feature-demo.gif \
  --out-dir /tmp/dsh-qa-out
```

常见插件面板与多语言验收脚本模板见 `references/ds-dot-recipes.md`。只需快速截图与点击验证时，也可直接传参运行：

```sh
node <skill-dir>/scripts/dsh-qa-harness.js \
  --plugin . \
  --click "button:has-text('Dorothy')" \
  --wait-selector ".dsh-dot-chat" \
  --screenshot-name panel-ready.png \
  --gif-name panel-open.gif \
  --out-dir /tmp/dsh-qa-out
```

脚本支持如下自定义场景模块签名（`--scenario <file.mjs>`），运行结束后会在 `--out-dir` 输出 `qa-report.json`（含当前 Git 短提交号、浏览器通道、产物路径与诊断结果）：

```js
export async function run({
  page,          // 已完成 Cookie 鉴权并打开干净根路径的 Playwright Page
  context,       // 当前 BrowserContext
  baseUrl,       // http://localhost:<PORT>/
  outDir,        // 产物输出目录
  screenshot,    // async (filename, playwrightScreenshotOpts?) => absPath
  captureFrame,  // async (durationMs = 500) => absFramePath（无 ffmpeg 环境下的 GIF 关键帧）
  assertClean,   // () => void（断言零 token 泄露、零 pageerror、零 /api 与 /plugins 4xx/5xx）
  diagnostics,   // { pageErrors, consoleErrors, httpErrors }
}) {
  // 编写交互动作、DOM 断言与截图
  assertClean()
}
```

### 3. 手动编排时的五项底层契约（自定义脚本必读）

若因特殊需求自行编写控制代码而非直接调用 `scripts/dsh-qa-harness.js`，遵守以下五项底层契约：

#### 3.1 隔离 `DSH_HOME` 与遥测/密钥脱敏

创建独立临时目录作为 `DSH_HOME`，设置 `DSH_TELEMETRY_DISABLED=1` 与 `DSH_TELEMETRY_MODE=DISABLED`。除非验收用例确实需要发起在线大模型对话，否则从子进程环境中剔除 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`NPM_TOKEN` 等敏感变量，杜绝密钥出现在页面或报错日志中。

#### 3.2 通过 `link:` 挂载本地插件而非裸写 `--patch`

执行 `DSH_HOME="<temp>" dsh plugin --profile web add "link:<abs_plugin_dir>"`。`dsh plugin add` 会自动初始化 `web` profile 并同步 `dsh.profile.bundles`，让宿主层 `cordis.patch.yml` 与前端模块表 `dsh.client` 同时生效；`link:` 直接复用插件自身的 `node_modules`，既无需联网下载，也不会在 profile 下重复安装 `@deepseek-ai/*` 触发版本遮蔽（shadowing）或 `pnpm` `allowBuilds` 阻塞。

#### 3.3 绑定 `127.0.0.1` 空闲端口并声明 `localhost` Authority

先通过 `net.createServer()` 申请本机空闲端口 `<PORT>`，再按如下参数启动：

```sh
dsh --profile web \
  --no-open \
  --host 127.0.0.1 \
  --port <PORT> \
  --public-url http://localhost:<PORT>/ \
  --trusted-host localhost:<PORT> \
  --trusted-host localhost
```

`--no-open` 阻止弹出宿主机默认浏览器；`--host 127.0.0.1` 保证仅本机回环可达；`--public-url` 配合 `--trusted-host` 让启动 Token、签名 Cookie 与同源请求统一绑定 `localhost:<PORT>`，规避正式版 Chrome / Edge 访问 `http://127.0.0.1:<PORT>` 时剥离 `Origin` 端口导致特权 `/api/*` 接口（如 `host.describe`、`settings.*`）全部返回 `403 Forbidden` 的问题。

#### 3.4 预检上下文换取 Cookie 后再开启录屏上下文

监听子进程输出直到匹配 `/dsh web:\s+(https?:\/\/\S+)/`（Cordis Loader 树就绪信号；若进程提前退出，读取 `$DSH_HOME/logs/startup-*.log` 定位失败插件）。先用不开启录屏的预检 `BrowserContext` 访问该 `?token=...` URL，等待服务端签发 `HttpOnly` 的 `dsh-auth-*` Cookie 并重定向到不含 `token=` 的根路径，导出 `storageState` 后关闭预检上下文；再用该 `storageState` 创建正式录屏 `BrowserContext` 直接访问干净的 `http://localhost:<PORT>/`。这样既跳过空白的 `Loading plugins...` 启动画面，也确保 `?token=` 绝不出现在任何一帧画面中。日志输出时将 `token=` 参数值统一脱敏为 `<REDACTED>`。

#### 3.5 双通道调色板 GIF 转码与视觉复核

控制交互节奏并检查产物质量：

- 在交互动作之间保留 `350ms - 650ms` 间隔，在最终结果态停留 `1000ms - 1500ms`，让审阅者看清前后变化。
- 优先使用 Playwright `recordVideo` 生成 `.webm` 后通过双通道 `ffmpeg` 转码，保留清晰字体边缘并把体积控制在 GitHub 10 MB 上限内：

```sh
ffmpeg -y -i raw.webm \
  -vf "fps=12,scale='min(1280,iw)':-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=256" \
  palette.png
ffmpeg -y -i raw.webm -i palette.png \
  -lavfi "fps=12,scale='min(1280,iw)':-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 output.gif
```

- 若运行环境未安装 `ffmpeg`，在关键动作后截取 PNG 序列并用 Python `Pillow`（`Image.Quantize.FASTOCTREE`）合成动画 GIF。
- 主动检视生成的 PNG / GIF 与 `qa-report.json`，确认零 `pageerror`、零 `/api/*` 与 `/plugins/*` 4xx/5xx、零截断遮挡、零隐私泄露，且 `git status --porcelain` 保持干净。

### 4. 按严格顺序回收进程与临时目录

无论验收成功或异常退出，都在 `finally` 中按以下顺序清理：

1. 关闭 Playwright `BrowserContext` 与 `Browser`（确保录屏 `.webm` 完整落盘）。
2. 先终止 `dsh web` 进程树并等待进程完全退出（POSIX 向进程组发送 `SIGTERM` 等待退出后兜底 `SIGKILL`；Windows 执行 `taskkill /PID <pid> /T /F`，防止 `pnpm`/`cmd` 派生的 `node` 子进程残留占端口）。
3. **确认 `dsh` 进程彻底退出后**，再递归删除临时 `DSH_HOME` 目录。

## Gotchas

- **严禁在 `dsh web` 存活期间删除 `DSH_HOME` 或 `profiles/web`**：`dsh-hmr` 使用 Chokidar 监听 profile 根目录，运行中直接删除目录会触发 Chokidar 忙等，导致残留 `node` 进程永久空转吃满单核 CPU 且无报错退出。务必先杀进程并等待退出，再删临时目录。
- **切勿漏掉 `pnpm build`**：`dsh web` 挂载的是插件编译后的 `lib/` 产物（含 `window.__ModuleLoader__.load` 包装后的 `lib/client.js`），只改 `src/*.tsx` 不重新 `pnpm build` 会导致录制出旧界面。
- **禁止传入 `--host 0.0.0.0`**：出于安全围栏设计，`dsh web` 显式拒绝通配监听地址并直接报错退出；始终绑定具体的 `127.0.0.1`。
- **禁止把截图或 GIF 提交进代码分支**：前端 PR 规范（如 `ds-dot` 的 `CONTRIBUTING.md`）要求 GIF 展示真实界面并在 PR 正文中标注对应 Commit SHA（例如 `Recorded on commit <sha>`），但文件本身不得进入 Git 分支历史。提交前始终检查 `git status --porcelain`。
