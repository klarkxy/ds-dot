## What and why

Finishes the interactions Dorothy's panel was missing: a running turn now shows its own prose, the drawer docks beside the chat and refuses to throw away an unsaved Persona draft, a reminder removal can be undone, and the work board can carry a rejection note and jump to the run's session.

**Replies and scrolling**
- The panel renders the live streamed markdown while a turn runs instead of only a shimmer, and `filterVisibleChat` hides the last committed reply only while a card is being prepared (`preparingCard`) rather than for the whole run. Streaming, card preparation and thinking are mutually exclusive, and the reply avatar lead follows the last row.
- While the log is scrolled up, new activity raises a **jump to latest** pill that becomes "new messages" once content arrived below; clicking re-pins the view.

**Drawer**
- Above an 860px container the drawer docks beside the conversation (no backdrop, 400/540px wide) instead of covering it.
- Unsaved Persona edits raise a dirty dot on the tab and an unsaved-changes bar. Every way out — tab strip, Escape, backdrop, close button and the header Context/Tasks/Settings shortcuts — now goes through one `requestDrawer` guard in `ChatPanel`, so the draft is kept or discarded deliberately. `PersonaPanel` reports dirtiness up and takes a `discardSignal` that drops the drafts.

**Tasks tab and board**
- The filter row counts everything: `All (N)`.
- `boardCounts` counts running watched sessions as active, and the Active filter lists them under Watched instead of hiding them (the archived hint stays in the watch view).
- Removing a reminder waits 4.5s behind an Undo bar; the row stays hidden while the removal is in flight, so a slow RPC cannot invite a second remove.

**Work board**
- Reject and deny take an optional note. It travels with `work.reject` / `work.answer` and is relayed into Dorothy's chat as `workRejectPrefix` — best effort after the decision is committed, never part of its acknowledgment.
- Work rows gain **Open session ↗** (the newest bound run, from the new `RunView.sessionId`) and fold all but the first changed file; `WorkFacts` gains per-source expand/collapse. Dev's force release and the batched preview pump are kept.

**Composer and images**
- A sent image keeps a local thumbnail (click → lightbox) for the message the host accepted; the preview is stored only after `say` succeeds.

**Trajectory**
- Code blocks get a copy button with a copied state, and the toolbar wraps in a narrow panel.

**Copy**
- 15 new keys across the eight locale packs, plus `fillText`, a one-pass `{slot}` fill so a title containing `{note}` or `$&` cannot redirect or expand the substitution.

No issue — an integration pass over Dorothy's panel rather than issue-backed work.

## How it was checked

- [x] `pnpm typecheck`
- [x] `pnpm test` — 89 files, 802 tests
- [x] `pnpm build`
- [x] Tried it in DeepSeek Harness — an isolated `dsh web` (own `DSH_HOME`, loopback port, headless Edge, 1440×900, zh-CN) drove the real panel at this commit: 0 page errors, 0 console errors, 0 `/api/*` or `/plugins/*` failures, and no `?token=` in any captured frame.

**Against `dev`.** The change was written against `945817e`, so `chat-panel.tsx` and `work-board.tsx` were hand-merged around dev's force release, the `boardRev` watermark and the batched preview reads. Two of the new specs also needed repair to run at all in this repository's harness: `react-dom` is loaded before the specs stub their JSDOM globals, so a raw `input` event never reaches React's change plugin (they use `Simulate.change` now), and the reminder button is looked up by its real copy `移除`.

## Frontend demo

![Persona drafts are guarded in Dorothy's drawer](https://raw.githubusercontent.com/klarkxy/ds-dot/docs/demo-assets/dot-panel-guard.gif)

Recorded on commit `83796d8` in an isolated `dsh web` (own `DSH_HOME`, loopback port, headless Edge, 1440×900, zh-CN; 1280×800 GIF, 9.8s): Settings → Persona, type a draft (dirty dot on the tab), click **Context** (the unsaved-changes bar appears and the draft stays on screen), **Keep editing**, click the header gear to close the drawer (the same bar — the shortcut honours the guard), **Discard** (the drawer closes). The panel is wide enough here to show the drawer docked beside the conversation. No account, key or `?token=` appears in any frame.

The GIF lives on the `docs/demo-assets` branch so it stays off this one.

## Notes for reviewers

- **The guard is client-side and in-memory.** It covers the drawer's own exits and the header shortcuts; a page reload or a segment switch still drops an unsaved draft, as before.
- **A rejection note follows the row, not the moment.** The note box keeps the text while the board refreshes, so if a refresh replaces the actionable revision (or the Look request) with a new one while the box is open, confirming sends the note to the new target. A target identity check that closes the box on change is a small follow-up.
- **The note relay is fire-and-forget.** It runs after the decision is committed and swallows its own failure, so a chat note can never fail a rejection. It does not participate in the decision-wake batch/ack path.
- **Image thumbnails are keyed by message text plus media type and file name**, because the host returns no bytes for a logged attachment. Two different images with the same name in the same text share a preview, and the map is not pruned during a session.
- **The Undo window is optimistic.** A due reminder can still fire inside the 4.5s window, and a removal the server refuses reappears only after the refresh that follows it.
- **Active counts include running watchers** by design; a watched session that is idle still counts under Watched, not Active.
- The wide dock relies on a container query, so a panel narrower than 860px keeps the overlay drawer it had before.
