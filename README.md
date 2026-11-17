# Dorothy (dot)

[简体中文](docs/README.zh-CN.md)

![Dorothy arrives with her suitcase and umbrella, ready to coordinate your projects](docs/images/dot-arrival.png)

Dorothy, dot for short, is an always-on coordinator for DeepSeek Harness. Talk to her in her own panel: she manages workspaces, starts sessions, follows their progress, handles approvals, and reports back. You stay in one chat while she coordinates your projects.

Her chat is warm, relaxed, and helpful. When work is underway, she keeps tasks moving and provides clear status updates. You can customize her persona and nickname in her settings.

## Install

Install from npm into the profile you use:

```sh
dsh plugin --profile web add ds-dot
```

Restart the profile if DSH asks. Pin a version with `ds-dot@0.1.0`. Deep View is installed with it and draws Dorothy's cards; this release depends on the published `@klarkxy/dsh-deep-view@0.2.1`. Deep View 0.3.0 adds math plots, node graphs, maps and data exploration and is not on npm yet, so Dorothy draws only the cards 0.2.1 renders until it is published. If `@klarkxy/dsh-dev-index` is in the same profile, Dorothy also gets its documentation and plugin-search tools. If `@klarkxy/dsh-model-picker` is installed, her model setting uses that searcher.

To install a source revision instead, use `github:klarkxy/ds-dot#<commit>`. If pnpm asks you to allow its build, add `ds-dot: true` under `allowBuilds` in that profile's `pnpm-workspace.yaml`, then repeat the install.

For local development against this checkout, add it with a `link:` spec so DSH uses the live tree (including `src`) instead of copying `lib` only:

```sh
dsh plugin --profile web add link:H:\Code\ds-dot
```

Run `pnpm watch` in the checkout so `lib/` rebuilds as you edit `src/`. A plain path or `file:` install still copies the published `files` list, which now includes `src` for source-level debugging.

## Use

Click **Dorothy** in the sidebar list with **Plugins** and **Automations**. Her whale turns pink while her panel is open. The panel is her own chat environment, separate from your main session lists.

Tell Dorothy what you need, for example:

```text
Create a workspace at D:\work\site and start a task there: fix the broken links on the docs page, then tell me what changed.
```

Dorothy turns your requests into persistent work. For clear requests she proceeds immediately; for complex work she keeps a change open until every requirement is verified. She manages work as follows:

- **Change & Requirements**: Each goal becomes a change with its own requirements and steps, plus behavior constraints that travel with the input; the run limit is execution configuration, and changing the title or the limit alone does not create a new input revision. Follow-up instructions that change scope create a new input revision — old results never count as new acceptance. Follow-up context that does not change scope is delivered once to the active run at its current input version; a stale version is refused instead of applied. Pausing stops new runs while open ones finish; cancelling refuses new work and settles the open runs.
- **Run Coordination**: She reserves the write scope a run needs, captures a pre-write baseline before the first writing prompt, and only releases the scope once the run is proven stopped. If that capture fails, only a reservation this start just created and never launched is released; a reservation already held stays so it can be retried, and the change is not cancelled. Non-conflicting runs can proceed in parallel.
- **Step Attribution**: A step counts as done only when the run that covers it produced a readable result for it on the current input. A file a later run wrote at the same path is not the earlier run's result.
- **Verification**: Before a change closes, Dorothy checks the actual delivery against each requirement with evidence. Straightforward single-run work can combine verification and closeout in one call, with the same evidence and version checks. A summary alone does not pass a requirement. Rejected work needs rework and a fresh verification before it can close; three consecutive failures are escalated to you.
- **Human Oversight**: When you ask to see a result first, she waits for your version-matched decision through a card or button. A stale or withdrawn request is never treated as a decision.
- **Workspace Management**: She creates or reuses workspaces and gives each run a self-contained first instruction with its goal, scope and acceptance criteria.
- **Agent Selection**: She selects the appropriate preset for each run: DSH's default for general work, `ptc` for scripts, and `cordis` for DSH plugin development.
- **Dedicated Environment**: She maintains a workspace of her own for research and DSH management tasks, accessible via the `dot` folder in your DSH home.
- **Session Tracking**: She can start, stop, or follow sessions based on your instructions.
- **Smart Updates**: She collects work activity, approvals, and questions, delivering updates efficiently when she is idle.
- **Approval Management**: She handles approval prompts for every session. She settles routine requests silently and asks you in chat with a card for requests involving significant changes, such as external data deletion, publishing, or scope changes.

Everything Dorothy says arrives as a card. A display card provides reports with text, tables, or charts; an interactive card allows for options, confirmations, or form entries when she needs an answer.

In the panel, **Tasks** in the header opens the work board. It shows each change's revision, runs, blockers, verification and closeout state, plus the actions that need you — accept, send back, look at a delivery, or finish a closeout. The board refreshes with the work view as background facts change: each run's write scope, deliveries and verification details can be expanded, and statuses are labeled in your language. Recorded evidence bound to the current verification can be opened read-only — unbound, stale or missing entries report a clear failure instead of showing content; it is not a general file browser. Long sources start with a preview and can be opened in full. The details also list paths excluded from the snapshot, such as dependencies, caches and source links. Unknown, refused and unverified states are never drawn as success. A change shows **Done** only when its checks and resource clean-up are all proven; a session saying "finished" is not enough.

Dorothy can also handle scheduled reminders. Ask her to "check in half an hour" or "summarize progress at nine every weekday morning." These reminders persist across sessions and DSH restarts.

## Settings

The gear icon opens a drawer for Settings, Persona, Context, and Trajectory. You can customize Dorothy’s model, approval preferences, task permissions, and personality.

- **Persona**: Define how Dorothy addresses you and choose her voice.
- **Agreements**: Record your standing requirements and rules.
- **Cognition**: Dorothy’s understanding of your collaboration style, updated automatically as you work together.
- **Context**: View token usage and prompt composition for the current segment.
- **Factory reset**: Restore Dorothy to a fresh install. This clears her own work data, sessions she opened, reminders, approvals and settings. If a step fails, the panel reports what remains and offers a fresh preview to retry. Your own sessions, project files and the host persona are not touched.

## Limits

- **Work model**: A run is a record of an ordinary session, not a sub-agent. File and shell work in a run is recorded and reviewable; the change record tracks its input, scope and verification.
- **Cooperative concurrency**: Write scopes guide Dorothy's dispatch — they do not forcibly block every tool, editor or external process. A refused reservation stays queued rather than overwriting shared files.
- **Baseline & evidence**: A write run needs a published pre-write baseline before its first prompt. If capture fails, only a new unlaunched reservation from that start is released. A verification needs a captured subject plus explicit per-requirement checks with evidence; a summary is not a pass, and anything incomplete stays unverified instead of closing.
- **Stale or unknown outcomes**: An out-of-date input, decision or button is refused rather than applied. A stop that cannot be proven keeps its scope occupied until reconciliation.
- **Resource scope**: She can check a current fact on the web herself. A lookup that needs several steps or ongoing research still goes to a run. Her own records cover her conversation and the work she manages.
- **Agreements & Cognition**: These are managed via the Persona page, ensuring your preferences are respected.
- **Approval routing**: In human approval mode, use the request's bound confirmation card; an expired card cannot approve a later request.
- **Human questions**: In human question mode, answer the original question in its session.
- **Background replies**: If a background turn ends without a usable card, its plain text remains visible.
- **Run permissions**: A read-only run cannot start when the host cannot enforce read-only access. A running session can receive follow-up context when its current permissions can be verified; otherwise the permissions must be applied while stopped before it can continue.
- **Cancellation**: A change keeps its write scopes occupied until its runs are confirmed stopped.
- **Not yet proven live**: Dorothy's new work model has passed unit and UI-layer tests plus isolated-host seam checks. Multi-run real-workspace collaboration, live queue/settlement verification, the board in a real browser and full model-in-the-loop behavior are still being verified — treat it as a work in progress, not a released guarantee.

## License

[Apache License 2.0](LICENSE)
