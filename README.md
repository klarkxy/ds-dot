# Dorothy (dot)

[简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md)

![Dorothy arrives with her suitcase and umbrella, ready to coordinate your projects](docs/images/dot-arrival.png)

Dorothy (`dot`) is an always-on coordinator for DeepSeek Harness (DSH). Talk to her in her dedicated sidebar panel to manage workspaces, dispatch and verify tasks across sessions, handle routine approvals and questions, schedule reminders, and customize her persona and how she addresses you.

## Install

Requires DSH `0.2.2-rc.3` or later. Add `ds-dot` to the profile you run:

```sh
dsh plugin --profile web add ds-dot
```

Restart the profile when prompted. Use `ds-dot@next` for prereleases, or `ds-dot@<version>` to pin a specific version.

Interactive cards work out of the box (Deep View is bundled). Optional companion plugins unlock extra capabilities when installed:

- `@klarkxy/dsh-dev-index` — DSH documentation and plugin registry search
- `@klarkxy/dsh-model-picker` — searchable model picker in Settings

## Everyday use

Open **Dorothy** in the sidebar beside **Plugins** and **Automations**, and tell her what you want to get done using text or attached PNG, JPEG, WebP, or GIF images:

```text
Create a workspace at D:\work\site and fix the broken links on the docs page. Tell me what changed.
```

- **Delegate and steer tasks:** Dorothy dispatches ordinary DSH sessions (running non-overlapping write paths in parallel), verifies delivered files against concrete scenarios rather than taking a session's word for it, and reports concise outcomes. Follow up mid-run to add context, revise requirements, pause, or cancel — or ask to inspect the result yourself before she closes it out.

- **Handle approvals and questions:** Choose whether Dorothy watches only her dispatched tasks or all DSH sessions. Under the defaults (`approvals=dot`, `questions=dot`), she settles routine reversible choices inside the goal after checking your agreements, conversation history, and workspace state, without re-asking for work already authorized. A confident guess never substitutes for missing authority, and irreversible, external, or costly actions still require explicit authorization. In code, `approvalNotice` (`src/approval-risk.ts`) forces your direct approval whenever display text is truncated or `assessApprovalRisk` flags a high-risk pattern (sandbox escalation, publish/push commands, recursive deletion, private keys/credentials, subagent shell calls, or write operations on a read-only run). Because that static check targets specific patterns rather than every deletion, secret read, write, or spend, Dorothy evaluates remaining requests by authority and impact. When she asks you, she includes one clear recommendation — and never treats silence as consent. Switching approvals to **You** relays every approval card; setting questions to **Always ask me** or **Leave to session** leaves questions to be answered in the originating session.

- **Watch sessions and search history:** Ask Dorothy to track a session you opened yourself, check on everything currently running, or search across earlier conversation segments and task logs.

- **Schedule reminders:** Set one-off or recurring reminders in natural language (*"check in half an hour"*, *"summarize overnight builds at 9:00 every weekday"*). Reminders persist across segment handoffs and DSH restarts.

Dorothy replies in your language while writing project deliverables in the language you or the repository use. Long conversations automatically roll over into a fresh **segment** without losing active tasks, reminders, or memory.

## Panel and settings

- **Tasks:** Filter by *All*, *Needs you*, *In progress*, or *Watched & reminders*; inspect delivered files and verification evidence, accept or send back work awaiting review, jump to underlying sessions, or remove reminders.

- **Settings** (gear icon): Pick **Dorothy's model**, toggle **Background reflection**, configure **Session takeover** (*Scope*, *Permission approvals*, *Model questions*, *Task permissions*), and adjust **Dispatched tasks** (*Allowed task models* and the idle **Routine check** interval). Every setting includes a lock toggle: locking prevents Dorothy from proposing changes, while unlocking lets her submit proposals for your approval. Optional DSH profile config fields control `homeDir` (directory for Dorothy's own workspace and session, defaulting to `dot` under DSH home) and `approvalGraceMs` (grace window in milliseconds, default `10000`, during which approvals settled in the originating session do not wake Dorothy).

- **Persona:** Customize how Dorothy addresses you and her voice, manage **Agreements** (standing rules kept in your exact words that always override cognition, with one-step undo), and edit or restore earlier versions of **Cognition** (her evolving notes on how you collaborate).

- **Context & Trajectory:** Inspect token usage, frozen prompt sections, and cache hit rates, or start a new segment manually; search turn-by-turn steps, tool calls, and background reflection runs.

- **Factory reset:** Previews and clears Dorothy's own task records, sessions she opened, reminders, agreements, cognition, and settings while leaving your own sessions, project files, and host persona untouched.

## Good to know

- Write scopes coordinate Dorothy's dispatched runs with one another without locking external editors or OS processes.
- Read-only task boundaries rely on host-level permission enforcement alongside pre-execution tool guards.
- Accepting a verified delivery closes out the task; it never authorizes pushing, publishing, or spending on its own.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, [docs/releasing.md](docs/releasing.md) for release workflows, and [Apache License 2.0](LICENSE) for licensing.
