# Dorothy (dot)

[简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md)

![Dorothy arrives with her suitcase and umbrella, ready to coordinate your projects](docs/images/dot-arrival.png)

Dorothy (`dot`) is an always-on coordinator for DeepSeek Harness (DSH). Talk to her in her dedicated sidebar panel to manage workspaces, dispatch and verify tasks across sessions, handle routine approvals and questions, schedule reminders, and customize her persona and how she addresses you.

## Install

Requires DSH `0.2.2-rc.5` or later. Add `ds-dot` to the profile you run:

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

- **Delegate and steer tasks:** Dorothy dispatches ordinary DSH sessions (running non-overlapping write paths in parallel), checks each run's report, and can open delivered files herself in read-only mode — a closeout must cite a run report or a delivered file. Optional independent review runs are read-only too, and after three failed rounds on the same requirements she stops and asks you. Follow up mid-run to add context, revise requirements, pause, or cancel — or ask to inspect the result yourself before she closes it out.

- **Handle approvals and questions:** Choose whether Dorothy watches only her dispatched tasks or all DSH sessions. With the default settings (**Dorothy** for approvals, **She decides** for questions), she settles routine reversible choices inside the goal after checking your agreements, conversation history, and workspace state, without re-asking for work already authorized. A confident guess never substitutes for missing authority, and irreversible, external, or costly actions still require explicit authorization. Some approvals always come to you: a truncated request, or a command matching a high-risk pattern — sandbox escalation, publish/push, recursive or destructive deletion (including containers, Kubernetes resources, and SQL drops), credential and `.env` access, a remote download piped into a shell, subagent shell calls, or writes inside a read-only run — which also refuses MCP tool calls whose names don't read as lookups (`get_…`, `list_…`, `search_…`, …). The check is pattern-based rather than exhaustive, so Dorothy still judges the rest by authority and impact. When she asks you, she includes one clear recommendation — and never treats silence as consent. Setting approvals to **Me** relays every approval card; setting questions to **Ask me** or **Hands off** leaves questions to be answered in the originating session.

- **Watch sessions and search history:** Ask Dorothy to track a session you opened yourself, check on everything currently running, or search across earlier conversation segments and task logs.

- **Schedule reminders:** Set one-off or recurring reminders in natural language (*"check in half an hour"*, *"summarize overnight builds at 9:00 every weekday"*). Reminders persist across segment handoffs and DSH restarts, and duplicates of an existing reminder are refused instead of stacking.

- **Reuse recipes:** When a kind of task comes back regularly — a weekly report, a dependency bump, a triage pass — Dorothy can save a delivery you were happy with as a versioned **recipe** (or you can have her define one directly). She runs it again on request or from a reminder you set up, filling the work order from the recipe so each run only needs what is different this time. When a run fails because of the recipe itself, she revises it with a reason naming the failure, and revisions are compared by their accepted/cancelled outcomes so a worse revision can be restored.

Dorothy replies in your language while writing project deliverables in the language you or the repository use. Her answers stream as plain text, with cards reserved for structure — tables, choices, and approvals. Long conversations automatically roll over into a fresh **segment** without losing active tasks, reminders, or memory.

## Panel and settings

- **Tasks:** Filter by *All*, *Needs you*, *In progress*, or *Watched & reminders*; inspect delivered files and verification evidence, accept or send back work awaiting review, jump to underlying sessions, or remove reminders.

- **Settings** (gear icon): Pick **Dorothy's model**, toggle **Background reflection** (at most once a day after new conversation; it uses model turns), configure **Session takeover** (*Scope*, *Permission approvals*, *Model questions*, *Task permissions*), and adjust **Dispatched tasks** (*Allowed task models* and the idle **Routine check** interval — a check only fires when unfinished work changed since the last one, and each fired check uses one model turn; `0` disables it). Every setting includes a lock toggle: locking prevents Dorothy from proposing changes, while unlocking lets her submit proposals for your approval. Optional DSH profile config fields control `homeDir` (directory for Dorothy's own workspace and session, defaulting to `dot` under DSH home) and `approvalGraceMs` (grace window in milliseconds, default `10000`, during which approvals settled in the originating session do not wake Dorothy).

- **Persona:** Customize how Dorothy addresses you and her voice, manage **Agreements** (standing rules kept in your exact words that always override cognition, with one-step undo), and edit or restore earlier versions of **Cognition** (her evolving notes on how you collaborate).

- **Context & Trajectory:** Inspect token usage, frozen prompt sections, and cache hit rates, or start a new segment manually; search turn-by-turn steps, tool calls, and background reflection runs.

- **Factory reset:** Previews exactly what will be cleared — tracked tasks, work changes and runs, reminders, recipes, proposals, cards, archived sessions (including her own conversation and background sessions), agreements, cognition, and settings — then asks for confirmation. Your own sessions, project files, and host persona stay untouched.

## GitHub events (optional)

Dorothy can follow pull requests, issues, comments, reviews, CI runs, pushes to the default branch, and releases. Events land in a durable inbox, where redelivered events are dropped and events about the same pull request or issue are merged, and reach Dorothy once she is idle. She treats event content as untrusted data: an event can prompt her to look into something or ask you, but never authorizes anything on its own. Pings, stars, forks, watches, check runs, and successful, skipped, or neutral CI results are filtered out; which repositories and event types arrive is set in your GitHub webhook.

1. Install the webhook runtime and the GitHub adapter into the same profile, pinned to your DSH version (their npm `latest` tag still points at an older 0.1 build):

   ```sh
   dsh plugin --profile web add @deepseek-ai/dsh-webhook@0.2.2-rc.5 @deepseek-ai/dsh-webhook-github@0.2.2-rc.5
   ```

2. Save this overlay as `$DSH_HOME/profiles/web/dot-github/cordis.yml` (`~/.dsh` when `DSH_HOME` is unset). It opens a second listener on `127.0.0.1:3081` that serves only `POST /github`:

   ```yaml
   - insert:
       - id: webhook-runtime
         name: '@deepseek-ai/dsh-webhook'

       - id: github-webhook-ingress
         name: cordis:group
         group: true
         isolate:
           webServer: true
         config:
           - id: github-webhook-server
             name: '@deepseek-ai/dsh-host-webserver'
             config:
               host: '127.0.0.1'
               port: 3081

           - id: github-webhook-adapter
             name: '@deepseek-ai/dsh-webhook-github'
             config:
               source: primary-github
               path: /github
               secretEnv: DSH_GITHUB_WEBHOOK_SECRET
               maxBodyBytes: 1048576
   ```

3. Put a long random secret in `DSH_GITHUB_WEBHOOK_SECRET` (your environment or `$DSH_HOME/.env`), keep it the same across restarts, and start DSH with the overlay:

   ```sh
   dsh web --patch "${DSH_HOME:-$HOME/.dsh}/profiles/web/dot-github/cordis.yml"
   ```

4. Expose only `127.0.0.1:3081/github` through a TLS reverse proxy or tunnel. The UI on port 3080 stays private.

5. In the repository's GitHub webhook settings, set the payload URL to `https://<your-host>/github`, the content type to `application/json`, the same secret, and the events you want Dorothy to hear about.

## Upgrading from earlier versions

Reminders, agreements, cognition, settings, and current task records carry over. Older ticket records, notes files such as `memory.md`, the old custom-policy text, and removed settings field names are no longer read or migrated.

## Good to know

- Write scopes coordinate Dorothy's dispatched runs with one another without locking external editors or OS processes.
- Read-only task boundaries rely on host-level permission enforcement alongside pre-execution tool guards.
- Accepting a verified delivery closes out the task; it never authorizes pushing, publishing, or spending on its own.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, [docs/releasing.md](docs/releasing.md) for release workflows, and [Apache License 2.0](LICENSE) for licensing.
