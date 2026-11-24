# Dorothy (`ds-dot`) — Technical Reference

[Dorothy’s Notebook (Site & Live Clips)](https://klarkxy.github.io/ds-dot/) · [README](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

This page collects the deeper configuration, security guardrail, GitHub webhook, and upgrade details linked from the README.

---

## Approval & question routing modes

| Setting | Default | Options |
|---|---|---|
| **Scope** | **Her tasks** | **Her tasks** (only tasks dispatched by Dorothy) · **All** (watch all top-level DSH sessions) |
| **Permission approvals** | **Dorothy** | **Dorothy** (auto-handles routine calls, reads truncated arguments via `dot_answer action=read` first, judges sandbox escalations and own-worktree `git reset --hard` / `clean -f`, and escalates hard risks) · **Me** (relays every card) · **Deny all** |
| **Model questions** | **She decides** | **She decides** (picks routine reversible defaults within goal) · **Ask me** · **Hands off** (leaves in originating session) |

Even in **Dorothy** mode, approvals matching these patterns **always** come straight to you:

- Publishing or pushing (`git push`, `npm/pnpm/yarn/bun/cargo publish`, `gh release` / `pr merge`, `twine upload`)
- Recursive or destructive deletion (`rm -r`, `Remove-Item -Recurse/-Force`, `find -delete`, containers, `kubectl delete`, `terraform destroy`, SQL `DROP` / `TRUNCATE`), and `git reset --hard` / `clean -f` aimed anywhere except the requesting run's own task worktree
- Credential and `.env` access (private keys, tokens, `.ssh`, `.aws/credentials`, `.npmrc`, `.pypirc`, `.netrc`)
- Remote downloads piped into a shell (`curl ... | sh`, `iwr ... | iex`)
- Subagent shell calls
- Writes inside a read-only run — which also refuses MCP tools whose names don't read as lookups (`get_…`, `list_…`, `search_…`, etc.)

Two softer cases stay with Dorothy instead: a sandbox escalation (`danger-full-access` / `sandbox_permissions`) is approved when the command stays inside the work order's authority and the run's own worktree or workspace — her own task-worktree `git reset --hard` / `clean -f` included — and denied or asked about when it would change state outside the run. A truncated request shows her only part of the arguments, so she must read them in full via `dot_answer action=read` before allowing it (and relays it to you if full arguments are unavailable).

The static check is pattern-based rather than exhaustive; silence is never treated as consent, write scopes coordinate Dorothy's own runs without OS file locks, and accepting a delivery closes the task without authorizing pushes, publishing, or spending.

---

## Optional DSH profile & settings details

- `homeDir`: Dedicated workspace and session directory (defaults to `dot` under DSH home).
- `approvalGraceMs`: Grace window in milliseconds (default `10000`) during which approvals settled in the originating session do not wake Dorothy.
- **Dispatched tasks settings:** Configure *Task permissions* (`Workspace write` or `Full access`, plus `Safe Auto` when `@klarkxy/dsh-safe-auto` is installed and `Auto review` when DSH experimental review is enabled), *Allowed task models*, and the idle *Routine check* interval (`0` disables it).
- **Arena-backed model recommendations:** `dot_list_models` ranks permitted `provider/model` choices from a pinned LMArena snapshot (`mode=raw` preserves the raw catalog view); Dorothy never substitutes a model you explicitly named. See [Arena data and aggregation notes](https://github.com/klarkxy/ds-dot/blob/dev/docs/model-arena.md).
- **Factory reset** (bottom of Settings): Previews exact counts of Dorothy's own state before clearing; your own sessions, project files, and host persona stay untouched.

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

## Upgrading from earlier versions

Reminders, agreements, cognition, settings, and current task records carry over (storage domain v10 still opens v1–v9 rows; back up your profile before upgrading if you might roll back). The `memory` settings lock is now `agreements` (re-lock agreements once if previously locked). Legacy tickets, `memory.md`, old custom-policy text, and retired settings field names are no longer read or migrated.
