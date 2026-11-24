# 桃乐丝（`ds-dot`）

**[桃乐丝的记事本（项目站点与实机录屏）](https://klarkxy.github.io/ds-dot/)** · [English](../README.md) · [日本語](README.ja.md)

[![桃乐丝拎着行李箱和雨伞来到工作区门口](images/dot-arrival.png)](https://klarkxy.github.io/ds-dot/)

**桃乐丝（`dot`）** 是 **DeepSeek Harness（DSH）** 侧栏里的常驻搭档。用日常说话的方式交给她多件事，她会自己核对完改动再摆出前后对比；小确认直接放行，涉及大事一定会停下来等你点头。

> **看详细图文与实机录屏：** 欢迎前往 **[桃乐丝的记事本](https://klarkxy.github.io/ds-dot/)** 浏览个人日记、查看 [9 段完整实机录屏](https://klarkxy.github.io/ds-dot/#clips)，以及复制 [上手常用句子](https://klarkxy.github.io/ds-dot/#about)。

## 安装

需要 **DSH `0.2.2-rc.5` 及以上版本**（尝鲜预发布版可用 `ds-dot@next`）：

```sh
dsh plugin --profile web add ds-dot
```

按提示重启 profile，打开侧栏 **桃乐丝** 就可以直接聊（也支持拖入截图），例如：

```text
帮我查一下这组文档里的失效链接并修好，改完让我看前后对比。
看一眼正在跑的任务里，有没有哪一件需要我拍板的。
每个工作日早上 9 点提醒我看过夜构建。
```

## 特点

- **并行干活与对照验收：** 互不冲突的事会同时推进，或开临时分支隔离改动（既可基于当前检出，也能直接从 PR 或远端引用拉出隔离分支，改完选择保留分支或丢弃，不误合回当前工作区）；汇报前先自己检查一遍，验收时哪行不对可以直接圈出来退回，卡住三次会主动停下找你商量。
- **边界清楚，有事先问：** 看文件、跑本地测试直接过；碰到删文件、外发推送、敏感凭据或拿不准的情况一定弹卡确认，哪怕面板收着也会在侧栏或桌面提醒你。改文件、跑命令、装插件这类工具只归派出去的任务，桃乐丝自己不用。
- **配方与定时：** 常跑的周报和巡检存成配方后可直接由定时提醒启动；改版后效果变差时还会主动建议恢复旧版。
- **习惯上锁与按需搭档：** 可以锁住不想被提议改动的人设或设置项，插件额外工具默认全关；按需搭配 `@klarkxy/dsh-dev-index`、`@klarkxy/dsh-model-picker` 与 `@deepseek-ai/dsh-webhook`。
- **桃乐丝专属 MCP 服务：** 在「MCP 服务」页接入 DeepWiki、GitHub、Context7 等远程服务或自建服务——只挂载给桃乐丝一个人用，接入后工具仍要在「额外能力」里显式授权才会生效。

## 更多资料

- [桃乐丝的记事本（GitHub Pages）](https://klarkxy.github.io/ds-dot/) — 图文日记、[实机录屏](https://klarkxy.github.io/ds-dot/#clips) 与 [上手提示词](https://klarkxy.github.io/ds-dot/#about)
- [进阶参考文档](reference.md) — 审批模式、高危拦截清单、Profile 配置、GitHub Webhook `cordis.yml` 及升级说明
- [参与贡献](https://github.com/klarkxy/ds-dot/blob/main/CONTRIBUTING.md) · [发布流程](https://github.com/klarkxy/ds-dot/blob/main/docs/releasing.md) · [Apache-2.0 协议](../LICENSE)
