# Dorothy (dot)

[简体中文](docs/README.zh-CN.md)

![Dorothy arrives with her suitcase and umbrella, ready to coordinate your projects](docs/images/dot-arrival.png)

Dorothy, dot for short, is an always-on coordinator for DeepSeek Harness. Talk to her in her own panel: she manages workspaces, starts sessions, follows progress, handles approvals, and reports back. Her persona and nickname are customizable.

## Install

Requires DSH 0.2.2-rc.3 or later. Install into the profile you use:

```sh
dsh plugin --profile web add ds-dot
```

Restart the profile if DSH asks. Use `ds-dot@0.1.0` to pin this version, or `github:klarkxy/ds-dot#<commit>` for a source revision. Deep View is included for cards. Optional `@klarkxy/dsh-dev-index` adds documentation and plugin search; `@klarkxy/dsh-model-picker` adds model search in settings.

For local development:

```sh
dsh plugin --profile web add link:H:\Code\ds-dot
pnpm watch
```

The linked checkout includes `src`; watch rebuilds `lib` as you edit. If pnpm requires build permission for a source install, allow `ds-dot` in that profile's `pnpm-workspace.yaml` and repeat the install.

## Use

Open **Dorothy** beside **Plugins** and **Automations** in the sidebar. Her panel has its own conversation. Tell her what you need:

```text
Create a workspace at D:\work\site and fix the broken links on the docs page. Tell me what changed.
```

Dorothy keeps each goal as a change with requirements and ordinary session runs:

- **Progress and completion:** Steps are progress notes. Completion depends on explicit checks for every required item, or a goal check when no requirements are listed. A session saying “finished” does not close the change.
- **Write scopes:** Dispatch reserves the run's scope and captures its starting state. Delivery is compared within the combined write scopes; out-of-scope observations are reported separately. Non-conflicting runs can proceed in parallel. Scope is released only after the session and its jobs are confirmed stopped.
- **Closeout:** Direct closeout is the default. Dorothy records per-requirement verdicts, check notes and evidence refs, captures the delivery, and checks it before acceptance. An independent reviewer is optional; its review can be closed out or sent back for rework. Old saved evidence files remain readable.
- **Follow-ups:** Changed requirements create a new input revision. Extra context is delivered once to the active run at its current version. Pausing prevents new runs; cancellation settles open runs before releasing their scopes.
- **Human decisions:** If you ask to see the result first, Dorothy waits for your decision on that version. Expired cards and stale decisions cannot approve later work. Legacy tickets remain read-only history.

**Tasks** opens the board with progress, runs, blockers, checks and closeout actions. Expand a check to read its note or reference and delivered files. Long sources offer a preview and full view. Internal IDs appear only under **Diagnostics**. A change shows **Done** after its checks and resource cleanup are proven.

Dorothy also tracks sessions you ask her to watch and collects approvals and questions. Routine requests can settle silently under your settings; requests needing your decision arrive as cards. In human question mode, answer in the original session.

Ask for reminders such as “check in half an hour” or “summarize progress at nine every weekday.” They persist across conversation segments and DSH restarts.

## Settings and limits

The gear opens settings, persona, context and trajectory. **Agreements** hold your standing rules; **Cognition** holds Dorothy's understanding of how you collaborate. Factory reset clears her work records, sessions she opened, reminders and settings while preserving your own sessions and project files.

Write scopes coordinate dispatch; they do not block external editors or processes. A read-only run requires host enforcement. Stale inputs are refused, and an unproven stop keeps its scope occupied. Acceptance alone does not authorize publishing, pushing or spending.

The work model has unit, UI-layer and isolated-host coverage. Live multi-run collaboration, real-browser board behavior and full model-driven behavior are still being verified.

## License

[Apache License 2.0](LICENSE)
