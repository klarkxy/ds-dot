# Dorothy (dot)

[简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md)

![Dorothy arrives with her suitcase and umbrella, ready to coordinate your projects](docs/images/dot-arrival.png)

Dorothy (`dot`) is an always-on coordinator for DeepSeek Harness (DSH). Talk to her in her
sidebar panel to manage workspaces, run and follow tasks across sessions, handle routine
approvals and questions, set reminders, and customize her persona and how she addresses you.

## Install

Requires DSH `0.2.2-rc.3` or later. Install into the profile you use:

```sh
dsh plugin --profile web add ds-dot
```

Restart the profile if prompted. Use `ds-dot@next` for prereleases, or `ds-dot@<version>` to
pin a release.

Interactive cards work out of the box (Deep View is bundled). Optional companion plugins
`@klarkxy/dsh-dev-index` (DSH docs and plugin search) and `@klarkxy/dsh-model-picker`
(searchable model picker in settings) add extra capabilities when installed.

## Everyday use

Open **Dorothy** in the sidebar beside **Plugins** and **Automations**, and tell her what you
need using plain text or attached PNG, JPEG, WebP, or GIF images:

```text
Create a workspace at D:\work\site and fix the broken links on the docs page. Tell me what changed.
```

- **Delegate and steer tasks:** She dispatches ordinary DSH sessions (in parallel when tasks
  touch separate paths), verifies delivered files against your requirements rather than taking
  a session's word for it, and reports back. Follow up anytime to add context, adjust
  requirements, pause, or cancel, or ask to review the result yourself before she closes it
  out.

- **Handle approvals and questions:** Watch only her dispatched tasks or all DSH sessions. With
  the defaults (`approvals=dot`, `questions=dot`) she decides routine reversible choices inside
  the goal after checking agreements, history, and what she can look up. Work already authorized
  is not asked again. A confident guess does not replace missing authority, and an irreversible,
  external, or costly effect still follows that authorization. `questions=human` relays every
  question; `questions=off` leaves it on the session. Code forces a human decision, and she
  cannot override it, when `approvalNotice` in `src/approval-risk.ts` marks the request: the
  shown text was truncated, or `assessApprovalRisk` detected a dangerous pattern (sandbox
  escalation, publish commands, a recursive-delete form, a PEM private key, a subagent shell,
  or some write forms on a read-only run). That is not every deletion, every secret, every
  write, or spending. She judges the rest from the authorization and the consequence. A question
  she asks includes one recommendation; silence is not consent. Set either control to you to
  relay every item. When questions are left to you or the session, answer in the original session.

- **Watch sessions and recall history:** Ask her to watch a session you started yourself,
  check on everything running, or search earlier conversations and sessions.

- **Set reminders:** Ask in natural language (*"check in half an hour"*, *"summarize overnight
  builds at 9:00 every weekday"*); reminders persist across conversation segments and DSH
  restarts.

Dorothy replies in your language while keeping deliverables in the language you or the project
use. Long chats automatically hand off to a new **segment** without losing active work,
reminders, or memory.

## Panel and settings

- **Tasks:** Filter by *All*, *Needs you*, *In progress*, or *Watched & reminders*; inspect
  delivered files and check notes, accept or send back work awaiting review, jump to
  underlying sessions, or remove reminders.

- **Settings** (gear icon): Choose **Dorothy's model**, toggle **Background reflection**,
  configure **Session takeover** (*Scope*, *Permission approvals*, *Model questions*, *Task
  permissions*), and set **Dispatched tasks** options (*Allowed task models* and the idle
  **Routine check** interval). Each setting carries a padlock icon: locked prevents her from
  proposing changes, while unlocked lets her submit proposals for your approval. Optional DSH
  plugin settings configure `homeDir` (folder for Dorothy's own workspace and session,
  defaulting to a `dot` folder in DSH home) and `approvalGraceMs` (grace period in
  milliseconds, default `10000`, during which approvals settled in the original session do not
  wake Dorothy).

- **Persona:** Customize how she addresses you and her voice, edit **Agreements** (standing
  rules kept in your own words that always win over cognition, with undo), and edit or restore
  earlier versions of **Cognition** (her notes on how you work).

- **Context & Trajectory:** Check token usage, prompt sections, and cache stats, or start a
  new segment manually; search turn-by-turn steps, tool calls, and reflection logs.

- **Factory reset:** Previews and clears Dorothy's work history, sessions she opened,
  reminders, agreements, cognition, and settings while leaving your own sessions, project
  files, and the host persona untouched.

## Good to know

- Write scopes coordinate Dorothy's dispatched tasks without locking external editors or
  processes.
- Read-only tasks require host enforcement.
- Accepting a task result closes out the task and never authorizes pushing, publishing, or
  spending on its own.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, [docs/releasing.md](docs/releasing.md)
for releases, and [Apache License 2.0](LICENSE) for licensing.
