# Dorothy (`ds-dot`) — Technical Reference

[Dorothy’s Notebook (Site & Live Clips)](https://klarkxy.github.io/ds-dot/) · [README](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

This page collects the deeper configuration, security guardrail, GitHub webhook, and upgrade details linked from the README.

---

## Approval & question routing modes

| Setting | Default | Options |
|---|---|---|
| **Scope** | **Her tasks** | **Her tasks** (only tasks dispatched by Dorothy) · **All** (watch all top-level DSH sessions) |
| **Permission approvals** | **Dorothy** | **Dorothy** (auto-handles routine reversible calls; escalates risky/truncated ones) · **Me** (relays every card) · **Deny all** |
| **Model questions** | **She decides** | **She decides** (picks routine reversible defaults within goal) · **Ask me** · **Hands off** (leaves in originating session) |

Even in **Dorothy** mode, approvals matching these patterns **always** come straight to you:

- Truncated approval requests
- Sandbox escalation (`danger-full-access` / `sandbox_permissions`)
- Publishing or pushing (`git push`, `npm/pnpm/yarn/bun/cargo publish`, `gh release` / `pr merge`, `twine upload`)
- Recursive or destructive deletion (`rm -r`, `Remove-Item -Recurse/-Force`, `git reset --hard` / `clean -f`, `find -delete`, containers, `kubectl delete`, `terraform destroy`, SQL `DROP` / `TRUNCATE`)
- Credential and `.env` access (private keys, tokens, `.ssh`, `.aws/credentials`, `.npmrc`, `.pypirc`, `.netrc`)
- Remote downloads piped into a shell (`curl ... | sh`, `iwr ... | iex`)
- Subagent shell calls
- Writes inside a read-only run — which also refuses MCP tools whose names don't read as lookups (`get_…`, `list_…`, `search_…`, etc.)

The static check is pattern-based rather than exhaustive; silence is never treated as consent, write scopes coordinate Dorothy's own runs without OS file locks, and accepting a delivery closes the task without authorizing pushes, publishing, or spending.

Dorothy's own session never receives the host built-in names in `TASK_ONLY_TOOLS` (`plugin_manager`, `bash`, `pwsh`, `write`, `edit`, `apply_patch`). Those tools stay with dispatched task runs. A stored legacy grant is inert and can be deleted from Settings → Extra capabilities; new or changed grants on those tools, on `builtin:plugin-manager`, or on any catalog group whose tools are all task-only are refused. Third-party write/command aliases used by the approval-risk gate are a separate check and are not part of this set.

---

## Optional DSH profile & settings details

- `homeDir`: Dedicated workspace and session directory (defaults to `dot` under DSH home).
- `approvalGraceMs`: Grace window in milliseconds (default `10000`) during which approvals settled in the originating session do not wake Dorothy.
- `cognitionPromptEntries`: Total cognition entries kept in Dorothy's prompt (default `30`); pinned entries fill the first slots and stay visible even beyond this number, the remaining slots go to the most recently confirmed entries, and the rest stay stored as dormant.
- **Agreements & cognition (Persona tab):** Both are editable entry lists, not single text blocks, and neither has a size limit. Agreements keep your standing rules in your exact words — one entry per line — and always override cognition when they conflict; a one-step undo is available. Cognition entries can be edited, deleted, pinned (always in Dorothy's prompt), or restored from earlier versions; pinned entries fill slots first and the remaining slots go to the most recently confirmed unpinned entries; when entries outnumber the slots, the least recently confirmed go dormant automatically — still stored, and Dorothy can search or page through them with `dot_cognition` (`action=list`). Confirming moves an entry back to the front of the unpinned entries (active unless pins fill every slot); pinning always shows it.
- **Dispatched tasks settings:** Configure *Task permissions* (`Workspace write` or `Full access`, plus `Safe Auto` when `@klarkxy/dsh-safe-auto` (`>=0.5.12`) is installed and `Auto review` when DSH experimental review is enabled), *Allowed task models*, and the idle *Routine check* interval (`0` disables it).
- **Workspaces & follow-up reminders:** Dorothy registers a new project workspace only when dispatching work there (and tells you when she does) rather than adding broad parent folders just to browse. Promised follow-ups waiting on panel acceptance or prerequisite repo changes use `dot_schedule` reminders (and isolated `worktree` tasks are created only after prerequisite changes land in the target checkout) so they still wake even when *Routine check* is `0`.
- **Arena-backed model recommendations:** `dot_list_models` ranks permitted `provider/model` choices from a pinned LMArena snapshot (`mode=raw` preserves the raw catalog view); Dorothy never substitutes a model you explicitly named. See [Arena data and aggregation notes](https://github.com/klarkxy/ds-dot/blob/dev/docs/model-arena.md).
- **Factory reset** (bottom of Settings): Previews exact counts of Dorothy's own state before clearing; your own sessions, project files, and host persona stay untouched.
- **Scoped web lookup & GitHub API compaction:** Dorothy's isolated `web_search` / `web_fetch` respect explicit `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` pins. When unpinned, `web_fetch` upgrades `http://api.github.com` URLs to `https:`, fetches `api.github.com` directly with an 8s timeout, strips repetitive endpoint `*_url`/`node_id`/`reactions` metadata while preserving primary records and `html_url`, and falls back to Jina (cooling down direct attempts for 10 minutes on 403/429 or network errors).

## MCP servers (Dorothy only)

The **MCP servers** page connects remote MCP servers that only Dorothy can use — they are mounted inside her own preset scope, so other DSH sessions never see the `mcp__<server>__*` tools. Connecting a server only mounts it; grant its tools under the server row or the **Extra capabilities** page (`mcp:<server>` / `tool:` selectors) before she can call them.

- **Recommended catalog:** GitHub (`https://api.githubcopilot.com/mcp/readonly`), DeepWiki, Context7, Exa, Microsoft Learn, Cloudflare Docs, Hugging Face.
- **GitHub token:** needs a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) with read-only access — Contents, Issues, Pull requests, Actions, Metadata. Tokens are stored in the host credential store (`DOT_MCP_<NAME>_TOKEN`) and never echoed back.
- **Custom servers:** name plus URL with an optional token. Remote (streamable-http) endpoints only: `https` everywhere, `http` allowed for loopback addresses. No stdio/command entries — a browser panel must not define commands to spawn — and no OAuth flow (DSH has none), so token-auth and no-auth servers only.
- Servers stay configured across restarts; a factory reset removes them together with their `DOT_MCP_*` credentials.

---

## GitHub events (optional)

Dorothy can follow pull requests, issues, comments, reviews, CI runs, default-branch pushes, and releases (filtering out pings, stars, forks, watches, check runs, and successful/skipped/neutral CI). Events land in a durable inbox, coalesce per PR/issue, link automatically to the task owning that PR or branch, and never grant authorization on their own.

1. Install the webhook runtime and GitHub adapter pinned to your DSH version:
   ```sh
   dsh plugin --profile web add @deepseek-ai/dsh-webhook@0.2.2-rc.5 @deepseek-ai/dsh-webhook-github@0.2.2-rc.5
   ```
2. Save as `$DSH_HOME/profiles/web/dot-github/cordis.yml` (`~/.dsh` when `DSH_HOME` is unset):
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
3. Set `DSH_GITHUB_WEBHOOK_SECRET` (kept consistent across restarts) and start DSH with `--patch`:
   ```sh
   dsh web --patch "${DSH_HOME:-$HOME/.dsh}/profiles/web/dot-github/cordis.yml"
   ```
4. Expose only `127.0.0.1:3081/github` via a TLS reverse proxy or tunnel (keep port 3080 private).
5. Point your repo's GitHub webhook to `https://<your-host>/github` (`application/json`, same secret).

---

## Self-maintenance

Dorothy never writes her own *running* copy.

- **Installed package** (`node_modules/ds-dot`, typically from the plugin market): writes targeting that package are refused (`dot/self`). Change Dorothy herself upstream. A host project that merely *contains* `node_modules/ds-dot` is a normal write target.
- **Linked checkout** (`dsh plugin add link:…`): create and write-dispatch into her tree always get a git worktree, even when isolation is `"none"`. Merge from the panel returns immediately; a serialized background deploy then:
  1. Skips the rebuild when the live checkout has uncommitted tracked changes (commit or stash, run `pnpm build`, then restart).
  2. Copies `lib/` to `~/.dsh/dot/self-upgrade/<timestamp>-<sha>/lib` (newest three kept; the path currently stored as the restore hint is never pruned).
  3. Runs `pnpm build` in the live checkout. A failed or aborted build restores that backup, then drops the failed attempt's directory.
  4. Persists a marker so the next start can report whether the running bundle matches the deployed hash.

`self.status` (and the chat snapshot's `lastBackup` field) reports install mode, package root, and the newest kept backup. If the panel says the backend is not loaded after an upgrade, copy that backup directory back onto the checkout's `lib/` and restart DeepSeek Harness.

Recipes saved from an isolated self-maintenance task store the original checkout plus `isolation: "worktree"`, so they still run after the temporary worktree is removed.

---

## Upgrading from earlier versions

Reminders, agreements, cognition, settings, and current task records carry over (storage domain v10 still opens v1–v9 rows; back up your profile before upgrading if you might roll back). The `memory` settings lock is now `agreements` (re-lock agreements once if previously locked). Legacy tickets, `memory.md`, old custom-policy text, and retired settings field names are no longer read or migrated.
