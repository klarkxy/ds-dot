# Dorothy (`ds-dot`) — Technical Reference

[Dorothy’s Notebook (Site & Live Clips)](https://klarkxy.github.io/ds-dot/) · [README](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

This page collects the deeper configuration, security guardrail, GitHub event intake (local `gh` polling & optional webhook), and upgrade details linked from the README.

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

Dorothy's own session never receives the host built-in names in `TASK_ONLY_TOOLS` (`plugin_manager`, `bash`, `pwsh`, `write`, `edit`, `apply_patch`). Those tools stay with dispatched task runs. A stored legacy grant is inert and can be deleted from Settings → Extra capabilities; new or changed grants on those tools, on `builtin:plugin-manager`, or on any catalog group whose tools are all task-only are refused. Third-party write/command aliases used by the approval-risk gate are a separate check and are not part of this set.

---

## Optional DSH profile & settings details

- `homeDir`: Dedicated workspace and session directory (defaults to `dot` under DSH home).
- `approvalGraceMs`: Grace window in milliseconds (default `10000`) during which approvals settled in the originating session do not wake Dorothy.
- `cognitionPromptEntries`: Total cognition entries kept in Dorothy's prompt (default `30`); pinned entries fill the first slots and stay visible even beyond this number, the remaining slots go to the most recently confirmed entries, and the rest stay stored as dormant.
- **Agreements & cognition (Persona tab):** Both are editable entry lists, not single text blocks, and neither has a size limit. Agreements keep your standing rules in your exact words — one entry per line — and always override cognition when they conflict; a one-step undo is available. Cognition entries can be edited, deleted, pinned (always in Dorothy's prompt), or restored from earlier versions; pinned entries fill slots first and the remaining slots go to the most recently confirmed unpinned entries; when entries outnumber the slots, the least recently confirmed go dormant automatically — still stored, and Dorothy can search or page through them with `dot_cognition` (`action=list`). Confirming moves an entry back to the front of the unpinned entries (active unless pins fill every slot); pinning always shows it.
- **Dispatched tasks settings:** Configure *Task permissions* (`Workspace write` or `Full access`, plus `Safe Auto` when `@klarkxy/dsh-safe-auto` (`>=0.5.12`) is installed and `Auto review` when DSH experimental review is enabled), *Default task preset* (`'standard'` by default for backward compatibility, or `'dot-worker'`; per-task `dot_task` `preset` overrides this default), *Allowed task models*, and the idle *Routine check* interval (`0` disables it). Dorothy's own conversation model (`model` under *Her model*, e.g., a lighter/faster model for coordination and routing) and the worker task model (`taskModels` under *Dispatched tasks*, e.g., a stronger execution model) can be configured independently; `dot-worker` follows the configured task model setting just like `standard`.
- **Run Watchdog settings:** Configure `watchdogMode` (`off` | `observe` [default] | `auto`) and `watchdogModel` (host model picker, empty = follow host default) under **Settings → Run Watchdog**. Both fields support `FIELDS` / `locks` / `SettingProposal`. See [Run Watchdog & Context Diagnostics](#run-watchdog--context-diagnostics) below.
- **`dot-worker` task preset:** Registered as a cross-platform sandboxed worker preset (`@deepseek-ai/dsh-bash-sandbox` + `@deepseek-ai/dsh-tool-bash` on POSIX; `@deepseek-ai/dsh-pwsh-sandbox` + `@deepseek-ai/dsh-tool-pwsh` on Windows `win32`). Foreground shell commands default to a **5s** timeout (`timeoutMs: 5_000`) and automatically promote to a background job (`promoteOnTimeout: true`), while allowing explicit requests up to **600s** (`maxTimeoutMs: 600_000`) and setting `@deepseek-ai/dsh-tool-jobs` to `waitTimeoutMs: 5_000`. It omits nested `dsh-tool-subagent*`, `dsh-workflow*`, `dsh-tool-schedule`, and `dsh-tool-goal` tools while keeping file read/write, search, skill, compaction, and shell tools (`TASK_ONLY_TOOLS`), and inherits the exact same `guardRunWriteTool`, `sealChildSession`, capability isolation, and approval-relay guards as `standard`. Set **Settings → Dispatched tasks → Default task preset** to `'dot-worker'` to opt in globally, or pass `preset="dot-worker"` on individual `dot_task` dispatches.
- **Background quiet wait & live job counts:** When a dispatched task run turns `idle` while still owning active background jobs (`jobs`) or active subagent work (`subagents`), Dorothy holds completion notification quietly for up to **30 minutes** (`BACKGROUND_LIMIT_MS`), suppressing false idle alerts; once all background work finishes—or on the 30-minute timeout kill—she re-observes the workspace and sends a single summary notification. Quiet-wait timers and trackers live strictly in **process memory** (no extra persisted table); if the `dsh` host restarts mid-wait, the startup **`reconcile`** flow inspects active runs and settles them cleanly. On the work board, active background jobs appear as a subtle secondary count indicator, and both quiet-wait and job counts degrade silently without errors when the host profile omits `jobs` or `subagents`.
- **Workspaces & follow-up reminders:** Dorothy registers a new project workspace only when dispatching work there (and tells you when she does) rather than adding broad parent folders just to browse. Promised follow-ups waiting on panel acceptance or prerequisite repo changes use `dot_schedule` reminders (and isolated `worktree` tasks are created only after prerequisite changes land in the target checkout) so they still wake even when *Routine check* is `0`.
- **Arena-backed model recommendations:** `dot_list_models` ranks permitted `provider/model` choices from a pinned LMArena snapshot (`mode=raw` preserves the raw catalog view); Dorothy never substitutes a model you explicitly named. See [Arena data and aggregation notes](https://github.com/klarkxy/ds-dot/blob/main/docs/model-arena.md).
- **Factory reset** (bottom of Settings): Previews exact counts of Dorothy's own state before clearing; your own sessions, project files, and host persona stay untouched.
- **Scoped web lookup & GitHub API compaction:** Dorothy's isolated `web_search` / `web_fetch` respect explicit `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` pins. When unpinned, `web_fetch` upgrades `http://api.github.com` URLs to `https:`, fetches `api.github.com` directly with an 8s timeout, strips repetitive endpoint `*_url`/`node_id`/`reactions` metadata while preserving primary records and `html_url`, and falls back to Jina (cooling down direct attempts for 10 minutes on 403/429 or network errors).

## MCP servers (Dorothy only)

The **MCP servers** page connects remote MCP servers that only Dorothy can use — they are mounted inside her own preset scope, so other DSH sessions never see the `mcp__<server>__*` tools. Connecting a server only mounts it; grant its tools under the server row or the **Extra capabilities** page (`mcp:<server>` / `tool:` selectors) before she can call them.

- **Recommended catalog:** GitHub (`https://api.githubcopilot.com/mcp/readonly`), DeepWiki, Context7, Exa, Microsoft Learn, Cloudflare Docs, Hugging Face.
- **GitHub token:** needs a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) with read-only access — Contents, Issues, Pull requests, Actions, Metadata. Tokens are stored in the host credential store (`DOT_MCP_<NAME>_TOKEN`) and never echoed back.
- **Custom servers:** name plus URL with an optional token. Remote (streamable-http) endpoints only: `https` everywhere, `http` allowed for loopback addresses. No stdio/command entries — a browser panel must not define commands to spawn — and no OAuth flow (DSH has none), so token-auth and no-auth servers only.
- Servers stay configured across restarts; a factory reset removes them together with their `DOT_MCP_*` credentials.

---

## Isolated worktree tasks

When `dot_task(action="create", isolation="worktree")` is used, Dorothy cuts a `dot/task-<slug>` branch inside `<homeDir>/worktrees/<slug>` without touching your active checkout:

- **Picking a base (`base_ref` & `base_remote`):** By default the task branch cuts from the checkout's `HEAD`. To continue an existing PR or branch (for example `refs/pull/123/head`), pass `base_ref` (local branch, tag, or commit) and optionally `base_remote` (a configured git remote name or a credential-free `https://` URL). Dorothy fetches into a temporary `refs/dot/base/<slug>` with `--no-tags --no-write-fetch-head --refmap=` and deletes the temp ref immediately after resolving the commit, leaving `FETCH_HEAD` and `refs/remotes/*` untouched.
- **Integration actions:** Tasks cut from the checkout's `HEAD` offer **Merge into checkout**, **Keep branch**, and **Discard** on the board. Tasks cut from a `base_ref` only offer **Keep branch** and **Discard** (and `integrateWork(..., "merge")` refuses) so an unrelated PR or remote branch is never merged over your working checkout; keep the branch and push or merge it yourself where it belongs.

---

## GitHub events (optional)

Dorothy can follow issues, pull requests, comments, reviews, and CI checks, coalescing updates per PR or issue, linking automatically to the tasks owning that PR or branch, and **never granting execution authorization on their own**. Credentials (`gh auth token` output or environment tokens) are never injected into model context, and `gh` `stderr` is redacted before logging or notifying.

### Primary: GitHub Polling (local `gh` CLI, no public URL or tunnel needed)

Recommended for local and desktop setups: Dorothy polls GitHub directly via your signed-in `gh` CLI under **Settings → GitHub** (`githubPoll`), with no public webhook URL, reverse proxy, or tunnel required.

- **Off by default:** `enabled` defaults to `false` and `repos` defaults to `[]` — nothing is polled until you turn it on and add `owner/repo` entries (normalized to lowercase).
- **CLI, GHES & connection test:** `ghPath` defaults to `'gh'` (resolving `gh.exe` automatically on Windows); set optional `hostname` to pass `--hostname` for GitHub Enterprise Server (leave empty for `github.com`). Click **Test `gh` Connection** to verify CLI discovery, `gh auth status`, `/rate_limit` quota, and per-repo access.
- **Interval & 4 observed streams:** `intervalSec` ranges from `60` to `3600` seconds (default `120`). All 4 streams default to on: `issues`, `pulls`, `comments` (issue comments, inline PR review comments, and PR reviews), and `ci` (default-branch failures and active or recent linked PR checks).
- **Cold-start baseline & 304 caching:** On a repository's first poll with no stored cursor, Dorothy records the current timestamp and existing failing default-branch CI baseline without flooding old history. Conditional `ETag` / `Last-Modified` (`304 Not Modified`) and empty cycles make zero main-document writes.
- **Local human login preservation & echo suppression:** Built-in ignored bots (`dependabot[bot]`, `github-actions[bot]`, `renovate[bot]`) and custom `ignoredActors` are filtered as bots, while your local `gh`-authenticated human account is preserved so your own PR/issue comments still arrive. Outgoing comments or reviews sent by Dorothy or tasks via `gh` are tracked for echo suppression so they do not loop back.
- **Rate-limit auto-backoff & health alert:** Effective interval honors `Math.max(userIntervalSec, X-Poll-Interval)` and checks hourly request budget (`repos × enabledStreams × (3600 / interval) < 50%` of remaining API quota), automatically raising the interval and surfacing a warning when exceeded. Consecutive poll errors raise a health alert once `consecutiveFailures >= 3`.
- **Single-repo mutual exclusion & Webhook ↔ Poll handoff:** Each `owner/repo` can use either Polling or Webhook, never both simultaneously. Switching a repository between modes hands off its last-delivered timestamp as the new cursor baseline and deduplicates by `sourceId` so events are neither missed nor duplicated.
- **Fast-Path 3-state admission defaults (Advanced collapsible matrix):** Rules match `(repo or *, eventType: issue | pr | comment | review | ci, senderClass: human | listed-bot | unlisted-bot)` to `inbox`, `context-only`, or `ignore`. Defaults: `human → inbox`; `listed-bot → context-only` (direct context to active subscribed runs only, no inbox clutter); `unlisted-bot → ignore`; `ci → inbox` only for default-branch failures or linked PR failures.
- **Many-to-many direct delivery, `dot_peer` bounce-back & Inline/Spill:** Comments and reviews matching a PR or issue are delivered directly via `supplementWorkRun` to **all** linked active runs (plus a low-priority inbox audit entry when admitted to `inbox`). If a follow-up is outside a worker run's scope, the worker bounces it back via `dot_peer` to Dorothy/inbox for re-dispatch. Payloads inline the object ID, author, up to **500** body characters, direct context (`file:line` or replied comment), linked IDs, and an explicit read pointer (spilling longer bodies to `<homeDir>/artifacts/inbox/`), batched per poll cycle.
- **User-stopped run protection & PR closure acceptance check:** Bots and CI never wake finished runs, and human comments on finished (non-stopped) threads route to Dorothy's inbox; **user-stopped runs receive zero subsequent messages**. When polling or webhook observes a PR `merged` or `closed`, Dorothy marks the thread closed in `links.ts`, moves linked `WorkBook` changes into closure acceptance verification, and emits one `result` notice (opening a PR never triggers completion).

### Advanced: Webhook real-time push (optional)

For instant push when you already expose an HTTPS endpoint, configure `webhookRepos` and `sourceId` (default `primary-github`) under **Settings → GitHub → Advanced: Webhook Real-time Push** (mutually exclusive per `owner/repo` with Polling):

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

---

## Run Watchdog & Context Diagnostics

Dorothy tracks active task runs per `runId + inputRevision` using a two-layer Run Watchdog (`src/watchdog-signals.ts` + `src/watchdog.ts`) to catch spinning, stalled, or infra-blocked runs without false positives during legitimate waits:

### 1. Seven deterministic signals (`src/watchdog-signals.ts`)

1. **`repeat-tool-call`:** Same tool called `>= 4` consecutive times (`REPEAT_TOOL_CALL_THRESHOLD = 4`) with identical canonical normalized-argument SHA-256 hash.
2. **`repeat-tool-error`:** `>= 3` consecutive tool failures (`REPEAT_TOOL_ERROR_THRESHOLD = 3`) sharing the same normalized first-line error fingerprint. Reaching `>= 8` consecutive same-error failures within a single turn (`SINGLE_TURN_ERROR_HARD_LIMIT = 8`) sets a hard trigger in `auto` mode.
3. **`no-progress`:** `netActiveMs = totalElapsedMs - union(quietWaitMs, pendingWaitMs, retryWaitMs) >= 15 min` (`NO_PROGRESS_MS`) with zero successful write/edit calls, zero completed test commands, and zero `dot_peer` messages. Overlapping P1 background quiet waits, `PendingHub` approval/question waits, and P3 retry waits are interval-unioned so overlapping waits are never double-subtracted.
4. **`compaction-loop`:** `>= 2` consecutive completed context compactions (`COMPACTION_LOOP_THRESHOLD = 2`) with zero file edits or test progress in between.
5. **`budget-retry-stall`:** PR-3 `kind === 'budget'` retry health state persisting `>= 15 min` (`BUDGET_STALL_MS`, measured from `since`).
6. **`silent-stall`:** Open `active` run whose live agent is `running` with zero session events for `>= 10 min` (`SILENT_STALL_MS`), excluding P1 quiet waits, approval/question waits, and P3 retry waits.
7. **`infra-failure`:** Sustained host API errors (`>= 2` consecutive `turn/end` / agent errors or `>= 15 min` transient retry), `reconcile`/recovery failures, or session stream disconnects with failed backfill. Intermittent external failures keep rechecking until recovered and **never** auto-stop the run.

### 2. Modes, read-only `dot-watchdog` judge & 5-minute patrol (`src/watchdog.ts`)

- **Modes (`watchdogMode`, default `'observe'`):**
  - `off`: Disables signal detection, patrol timer, and judge evaluation.
  - `observe` *(default)*: Runs the 7 deterministic signals and 5-minute periodic patrol, persisting hits to `trace` and Context Diagnostics with **zero** judge LLM calls.
  - `auto`: Runs deterministic signals and invokes the hidden internal read-only preset `dot-watchdog` only when signals fire.
- **Judge model (`watchdogModel`):** Configured via the host model picker under **Settings → Run Watchdog** as `'provider/model'` (empty/unset follows the host default model). If the configured model is missing from the catalog, malformed, or fails at runtime, Watchdog records a `modelFallbackNotice` (`watchdog.fallback`), surfaces it in Context Diagnostics, and degrades cleanly to deterministic signals only.
- **Hidden read-only preset & strict boundaries:** `dot-watchdog` is listed in `isInternalPreset` (`src/preset-visibility.ts`), mounts only persona and time-context with zero write/Shell/task/approval tools, runs with a **30s** timeout, global concurrency **1**, and a **10-minute** cooldown lock per `runId + inputRevision`. Replies are strictly `zod`-validated against `{ verdict: 'progressing' | 'spinning' | 'off-scope', confidence: 'low' | 'medium' | 'high', summary, evidence }`. Neither the judge nor the patrol ever auto-modifies prompts, triggers, or settings—any adjustment goes through `SettingProposal` for human approval.
- **Alerts, independent `watchdogStops` & human circuit-breaker:** In `auto` mode, the 1st non-low `spinning` or `off-scope` verdict routes evidence via `NoticeBatcher` to Dorothy. Auto-stop (`stopActivity`) triggers only on the **2nd consecutive high-confidence `spinning` verdict** or a **single-turn `>= 8` identical tool-error hard limit**. Watchdog stops increment the independent `watchdogStops` counter (never `FAILED_ROUND_LIMIT` or `runStoppedByUser`), and a 2nd auto-stop on the same run/input emits a `humanRequired: true` circuit-breaker card.
- **5-minute periodic patrol & natural-language query:** A plugin-scoped 5-minute timer (`WATCHDOG_PATROL_MS`, cleaned on `dispose()`) catches silent/no-event stalls (Signals 3, 6, 7). Dorothy can answer questions like *"why was this run flagged?"* using the read-only `dot_watchdog` tool backed by the same Context Diagnostics view.

### 3. Context Diagnostics review & 14-day calibration

- The **Context Diagnostics** panel displays Watchdog state (mode, judge model, `watchdogStops`, and any active `modelFallbackNotice`) even when Dorothy has no live session (`!view.live`).
- Each recorded hit lists its signal type, run metadata, evidence bullets, judge verdict (when present), and **Accurate / False positive** (`判断正确 / 误报`) annotation buttons persisted to `trace` and the `dotDomain` store.
- **14-day calibration metrics:** Context Diagnostics tracks 14-day total hits, reviewed count, accurate count, false-positive count, and false-positive rate (`< 10%` false-positive rate is the readiness gate for future P7 Speculative Bug Reproduction; see [`plan/speculative-repro.md`](../plan/speculative-repro.md)).

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

Reminders, agreements, cognition, settings, and current task records carry over (storage domain v12 still opens v1–v11 rows; back up your profile before upgrading if you might roll back). The `memory` settings lock is now `agreements` (re-lock agreements once if previously locked). Legacy tickets, `memory.md`, old custom-policy text, and retired settings field names are no longer read or migrated.
