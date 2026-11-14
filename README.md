# Dorothy (dot)

<!-- release-state-note -->

[简体中文](docs/README.zh-CN.md)

Dorothy, dot for short, is an always-on coordinator for DeepSeek Harness. Talk to her in her own panel: she manages workspaces, starts sessions, follows their progress, handles approvals, and reports back. You stay in one chat while she coordinates your projects.

Her chat is warm, relaxed, and helpful. When work is underway, she keeps tasks moving and provides clear status updates. You can customize her persona and nickname in her settings.

## Install

From GitHub, into the profile you use:

```sh
dsh plugin --profile web add github:klarkxy/ds-dot
```

pnpm will not build a Git dependency until you allow it. If the first install stops, add the package name it prints to that profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "@klarkxy/dsh-dot": true
```

Run the same `dsh plugin add` again. Restart the profile if DSH asks. Pin a commit when you want this revision to stay fixed: `github:klarkxy/ds-dot#<commit>`.

The package name stays `@klarkxy/dsh-dot`. Deep View is installed with it and draws Dorothy's cards.

## Use

Click **Dorothy** in the sidebar list with **Plugins** and **Automations**. Her whale turns pink while her panel is open. The panel is her own chat environment, separate from your main session lists.

Tell Dorothy what you need, for example:

```text
Create a workspace at D:\work\site and start a task there: fix the broken links on the docs page, then tell me what changed.
```

Dorothy turns your requests into tasks and starts work. For clear requests, she proceeds immediately; for complex tasks, she creates a draft for you to review. She manages work as follows:

- **Workspace Management**: She creates or reuses workspaces, starting each task with a self-contained instruction. A task can span multiple sessions (work, review, rework), all linked to the same task.
- **Resource Coordination**: She manages write access in a directory, keeping your project organized.
- **Agent Selection**: She selects the appropriate preset for your task: DSH's default for general work, `ptc` for scripts, and `cordis` for DSH plugin development.
- **Dedicated Environment**: She maintains a workspace of her own for research and DSH management tasks, accessible via the `dot` folder in your DSH home.
- **Session Tracking**: She can start, stop, or follow sessions based on your instructions.
- **Smart Updates**: She collects task activity, approvals, and questions, delivering updates efficiently when she is idle.
- **Approval Management**: She handles approval prompts for every session. She settles routine requests silently and asks you in chat with a card for requests involving significant changes, such as external data deletion, publishing, or scope changes.

Everything Dorothy says arrives as a card. A display card provides reports with text, tables, or charts; an interactive card allows for options, confirmations, or form entries when she needs an answer.

In the panel, **Tasks** in the header opens your task board. You can view tasks grouped by status (**Needs you**, **In progress**, **To do**, etc.), click a task to review its goal and history, or manage drafts. For tasks awaiting your review, **Pass** completes them, and **Send back** allows you to add feedback.

Dorothy can also handle scheduled reminders. Ask her to "check in half an hour" or "summarize progress at nine every weekday morning." These reminders persist across sessions and DSH restarts.

## Settings

The gear icon opens a drawer for Settings, Persona, Context, and Trajectory. You can customize Dorothy’s model, approval preferences, task permissions, and personality.

- **Persona**: Define how Dorothy addresses you and choose her voice.
- **Agreements**: Record your standing requirements and rules.
- **Cognition**: Dorothy’s understanding of your collaboration style, updated automatically as you work together.
- **Context**: View token usage and prompt composition for the current segment.

## Limits

- **Workflow integration**: Dorothy operates through task sessions, where all file and shell work is recorded and reviewable.
- **Resource Scope**: Her search is focused on her own conversation and tasks she manages.
- **Agreements & Cognition**: These are managed via the Persona page, ensuring your preferences are respected.
- **Task Board**: Task reminders appear exclusively on Dorothy's board.
- **Approval routing**: In human approval mode, use the request's bound confirmation card; an expired card cannot approve a later request.
- **Human questions**: In human question mode, answer the original question in its session.
- **Background replies**: If a background turn ends without a usable card, its plain text remains visible.
- **Task permissions**: A read-only task cannot start when the host cannot enforce read-only access. A running task can receive follow-up instructions when its current permissions can be verified; otherwise the permissions must be applied while stopped before it can continue.
- **Cancellation**: A task keeps its directory lock until its sessions are confirmed stopped.

## License

[Apache License 2.0](LICENSE)
