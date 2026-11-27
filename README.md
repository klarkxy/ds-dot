# Dorothy (`ds-dot`)

**[Dorothy’s Notebook (Site & Live Clips)](https://klarkxy.github.io/ds-dot/)** · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md)

[![Dorothy arrives with her suitcase and umbrella](docs/images/dot-arrival.png)](https://klarkxy.github.io/ds-dot/)

**Dorothy (`dot`)** is your sidebar partner inside **DeepSeek Harness (DSH)**. Hand off tasks in plain words, review clean before/after diffs, let routine checks pass quietly while pausing on big decisions, and keep scheduled recipes organized.

> **Read more & watch real recordings:** Visit **[Dorothy’s Notebook](https://klarkxy.github.io/ds-dot/)** for illustrated guides, all [16 live DSH screen recordings](https://klarkxy.github.io/ds-dot/#clips), and [day-one starter prompts](https://klarkxy.github.io/ds-dot/#about).

## Install

Requires **DSH `0.2.2-rc.5` or later** (use `ds-dot@next` for prereleases):

```sh
dsh plugin --profile web add ds-dot
```

Restart the profile when prompted, open **Dorothy** in the sidebar, or try asking:

```text
Fix the broken links in these docs and show me the diff before merging.
Check running sessions and tell me if anything is waiting on my approval.
Remind me every weekday at 9:00 AM to check overnight builds.
```

## Highlights

- **Parallel work & clean diffs:** Runs non-overlapping tasks together or on isolated branches (from your checkout or a PR/remote `base_ref` — keep or discard foreign branches without merging over your checkout), reads changes first, lets you quote exact lines to revise, and stops after three stalled tries.
- **Composer & file handoff:** The chat input is a single rounded card with a compact “+” menu and circular send/stop controls. Attach any file type (not just images) with non-ASCII filenames preserved; Dorothy can read attachments and absolute paths with read-only file tools, while credential-like paths stay refused and Office/PDF reading goes through the optional Office skill.
- **Clear safety boundaries:** Routine reversible checks run quietly; deletions, pushes, credentials, and gray areas pause with clear confirmation cards and sidebar/desktop alerts. File-editing, command, and plugin-manager tools stay with dispatched tasks—Dorothy never uses them herself. Linked self-edits run on a spare worktree and rebuild only after you merge (previous `lib/` kept under `~/.dsh/dot/self-upgrade`); an installed package is never rewritten.
- **Recipes & reminders:** Save repeatable workflows once, run them directly from plain-language schedules, and review restore suggestions if a tweaked recipe slips.
- **Settings & optional companions:** Lock settings you want untouched, follow GitHub issues/PRs/comments/CI via local `gh` polling with zero public URL (off until you add repos), monitor spinning or stalled runs with **Run Watchdog** (defaults to `observe` with zero LLM calls, plus **Context Diagnostics** 14-day hit review), and optionally pair with `@klarkxy/dsh-dev-index`, `@klarkxy/dsh-model-picker`, or `@deepseek-ai/dsh-webhook` for real-time webhooks.
- **Dorothy-only MCP servers:** Connect remote MCP servers (DeepWiki, GitHub, Context7 and more, or your own) from the MCP page — they are mounted for Dorothy alone, and their tools still need an explicit grant before she calls them.

## More

- [Dorothy’s Notebook (GitHub Pages)](https://klarkxy.github.io/ds-dot/) — illustrated blog notes, [live clips](https://klarkxy.github.io/ds-dot/#clips), and [setup prompts](https://klarkxy.github.io/ds-dot/#about)
- [Technical Reference](docs/reference.md) — approval rules, hard-stop patterns, profile options, Run Watchdog & diagnostics calibration, local `gh` GitHub polling & webhook setup, and upgrade notes
- [Contributing](https://github.com/klarkxy/ds-dot/blob/main/CONTRIBUTING.md) · [Releasing](https://github.com/klarkxy/ds-dot/blob/main/docs/releasing.md) · [Apache-2.0 License](LICENSE)
