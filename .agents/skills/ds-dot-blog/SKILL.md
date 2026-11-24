---
name: ds-dot-blog
description: "维护桃乐丝（Dorothy / ds-dot）的个人博客式 GitHub Pages（docs/）。当某个功能或交互 PR 准备合入、需要把新能力写成随笔、把相近改动合并或更新到已有博客文章、登记 PR 实机录屏 GIF 与真实合入日期、用桃乐丝自然口癖与三语风格维护内容，或发版前核对 docs/ 与精简 README 时使用。"
---
# ds-dot-blog

像维护真实个人博客一样管理 [`docs/`](../../../docs/index.html)（《桃乐丝的记事本 · Dorothy’s Notebook · ドロシーの手帳》）：**每次引入或调整用户可见能力的 PR，都顺手把这次变化写进博客**——主题独立就新发一篇，和已有文章主题重合就**合并或改写进原文章**，让公开站点永远贴着代码演进，不攒过期账。

## When to Use

- 合入或准备引入新功能、新面板交互、安全边界变化、配方/提醒能力或重要体验改进的 PR（特别是刚录好 `dsh web` 演示 GIF、或准备发布新版本前）
- 需要将多个相关小 PR 的能力**合并成一篇更完整的日记**，或给旧日记补充新章节与新录屏，保持博客目录清爽不重复
- 发版准备（`release: prepare vX.Y.Z`）前核对博客、实机录屏、精简 README 与进阶参考文档是否已全部对齐最新特性

## 博客管理原则（像真博客一样维护）

1. **PR 自带文章更新：** 对人类用户可见的新能力（面板功能、安全策略、设置开关、日常工作流、配角插件联动等），都在同一 PR 里同步维护博客，不要另拖到后续补文档。
2. **「合并 / 更新旧文」还是「新建一篇」？按主题相关性判断：**
   - **优先合并或更新已有文章**（大多数迭代 PR 走这条）：
     - 新 PR 是在强化某个已有主题（例如继续补强审批卡片、设置抽屉、配方提案、diff 审阅或 GitHub 联动），不要为了小改动零碎水一篇新文。
     - 直接改写目标文章在 `POSTS` 里的三语 `excerpt` 与 `paragraphs`，将 `date` 刷新为**本次 PR 合入日期（`YYYY.MM.DD`）**，并调整非置顶 `POSTS` 的顺序使最新日期排在前面。
     - 若将一篇较旧的短文并入另一篇主文章：保留主文章 `slug`，把相关内容融进主文章后删掉重复条目，并同步把 [`docs/app.js`](../../../docs/app.js) 中所有 `RECORDINGS[*].post` 从旧 `slug` 改指主文章 `slug`。
   - **开辟独立新文章**：
     - 仅当 PR 带来全新的产品场景、现有 5 类主题（`moving` / `work` / `rules` / `recipes` / `notes`）和已有文章放不进去、强行塞入会让原文章散架时，新建一条 `POSTS` 条目。
     - 首页保持 `welcome`（`pinned: true`）置顶第一，其余非置顶文章严格按 `date` 从新到旧排列；需要新分类时可按需补充 `CATEGORIES`。
3. **豁免范围：** 纯内部重构、不影响用户行为的样式微调/修 bug、纯测试 PR 无需改博客，在 PR 模板勾选框标注 `N/A`。

## 维护步骤（Steps）

### 1. 盘点现有文章与录屏归属

先读取 [`docs/app.js`](../../../docs/app.js) 顶部的 `CATEGORIES`、`RECORDINGS` 与 `POSTS`，确认本次 PR 的能力：
- 是否已有主题高度重合的文章可以直接**更新或合并**；
- PR 新增的交互录屏（若有）应归属到哪一篇文章的 `post` 字段下。

### 2. 使用真实 PR 合入日期（严禁占位日期）

每篇非置顶文章和每段录屏都带真实日期（格式 `YYYY.MM.DD`，东八区 `+08:00`）：
- 可用 `git show -s --format="%cI" <commit>` 或 PR 合入当日日期确定；若是准备中的 PR，填写预计/提交当日真实日期，合入后如需修正随手对齐。
- 严禁填写捏造的跨月占位日期（如随便写几个虚构月份）。

### 3. 登记实机录屏（`RECORDINGS`）

若 PR 附带了 `dsh web` 真实录屏并发布到仓库 `docs/demo-assets` 分支（GIF 文件**严禁提交到主代码分支**）：
1. 在 `RECORDINGS` 中新增（或替换旧的同名能力录屏）条目：写清 `id`、`pr`（真实 PR 号）、`date`、`post`（所属文章 `slug`）、`file`（`docs/demo-assets` 下的文件名）以及三语 `title` / `desc`。
2. 正文下方“顺手贴的真机录屏”区域和 `#clips` 页面会自动读取 `RECORDINGS` 渲染，无需手改分类数量。

### 4. 配图处理（仅新建独立文章需要新图时）

- **优先复用现有 6 张一致画风插画**（[`dot-arrival.png`](../../../docs/images/dot-arrival.png) 及 `docs/images/chibi-*.jpg`），避免图库泛滥。
- 确需新增独立 Q 版插画时，使用 Magpie 生图工具遵循全站统一角色约束：
  - **单参考图原则**：`--reference_images` **只能传入 [`docs/images/dot-arrival.png`](../../../docs/images/dot-arrival.png)**（绝不串联其他 `chibi-*.jpg` 当第二参考图，否则会出现多张图表情姿势雷同的“撞脸”问题）。
  - 使用 `--model klarkxy/gpt-image-2.6 --background opaque --quality high --complexity high --size 1024x1024`，提示词必须给出与现有 5 张明显不同的**姿势、机位视角、表情（闭眼笑/惊讶/鼓腮/眨眼等）与阳光生活场景**。
  - 压为 `800×800` JPEG 存到 `docs/images/chibi-<slug>.jpg`，且**不得**加入 [`package.json`](../../../package.json) 的 `files`（保持 npm 发布包轻量）。

### 5. 桃乐丝口吻写作 & 反 AI-Slop 规范

重写或新增文案时，始终遵守：
- **真人口语，但克制不过火**：
  - **`zh`**：像真人在独立博客上跟熟人闲聊一样松弛自然，几句话里偶尔带一处轻量语气词或停顿（如 `嘛`、`吧`、`来着`、`顺便`、`其实`），结尾或日常闲聊偶见轻巧的 `doro~` / `欧润吉` 即可。**按钮与控件保持中性克制**（`复制`、`看全文 →`、`安装`），禁止满篇感叹号/波浪号、过度二次元拟声词堆砌（如连续出现 `捏`/`嗷`/`咯`/`嘿嘿`）或夸张台词。摘要 `excerpt` 1～2 句，正文 `paragraphs` 2 短段，录屏 `desc` 1 句。
  - **`en` / `ja`**：同步保持平实随和的博客口语（英文正常缩略与轻量口语，日文温和自然的口语/礼貌混用），既不端着写说明书，也不过度卖萌；三语务必同步齐备。
- **反模板与去术语清单（严禁出现）**：
  - 禁止“不是 X 而是 Y”排比、禁止 `"第一……第二……"` 说明书写法、禁止每篇末尾强行塞说教型引用块（`blockquote`）、禁止 AABB 叠词堆砌（如满屏 `清清楚楚`/`明明白白`）、禁止 `X 分钟阅读`、禁止把内部工程词（如 state machine、RPC、payload 等）原封不动甩给读者。
- **视觉与同步约束**：
  - 维持极简纸张质感（禁止发光渐变团块、界面 Emoji 装饰、五颜六色胶囊标签堆、图片上叠加浮动贴纸）。
  - 若改动了置顶首篇文案或右侧栏简介，顺手同步 [`docs/index.html`](../../../docs/index.html) 中的静态首屏汉字回退文本。
  - 若改动了核心上手方式、大特性亮点或深层技术开关：顺手更新精简版三语 README（[`README.md`](../../../README.md)、[`docs/README.zh-CN.md`](../../../docs/README.zh-CN.md)、[`docs/README.ja.md`](../../../docs/README.ja.md)），长篇工程配置统一放入 [`docs/reference.md`](../../../docs/reference.md)。

### 6. 本地与构建验证

改动完成后务必执行：

```sh
node --check docs/app.js
pnpm typecheck && pnpm test && pnpm build
npm pack --dry-run --ignore-scripts
```

- 确认 `node --check docs/app.js` 零语法报错。
- 在桌面（`1440×900`）与移动端（`390×844`）本地静态预览确认：控制台 0 报错、所有插画与外部 PR GIF 正常加载、三语切换及灯箱正常、`scrollWidth <= innerWidth` 无横向溢出。
- 从 `npm pack --dry-run --ignore-scripts` 输出确认 `.agents/`、`docs/app.js`、`docs/index.html`、`docs/styles.css` 与 `docs/images/chibi-*.jpg` 均未混入 npm 打包清单。

## 数据结构速查（`docs/app.js`）

```js
// RECORDINGS 条目：每个 PR 演示 GIF 一条
{
  id: 'worktree',
  pr: 58,
  date: '2026.11.22',
  post: 'parallel-and-diff', // 关联所属 POSTS[*].slug
  file: 'dot-54-worktree-runs.gif',
  title: { zh: '...', en: '...', ja: '...' },
  desc: { zh: '...', en: '...', ja: '...' },
}

// POSTS 条目：置顶篇在最前，其余按 date 从新到旧排列
{
  slug: 'parallel-and-diff',
  date: '2026.11.22', // 合入日期 (YYYY.MM.DD, +08:00)
  category: 'work',   // moving | work | rules | recipes | notes
  image: 'images/chibi-dispatch.jpg',
  aspect: 'square',   // wide | square
  imageAlt: { zh: '...', en: '...', ja: '...' },
  caption: { zh: '...', en: '...', ja: '...' },
  title: { zh: '...', en: '...', ja: '...' },
  excerpt: { zh: '...', en: '...', ja: '...' },
  paragraphs: { zh: ['...', '...'], en: ['...', '...'], ja: ['...', '...'] },
}
```
