import { Button, StateDot, Tag, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { backendMissingText } from './backend-state.ts'
import { groupBoard, headerBoardCounts } from './board-groups.ts'
import { groupWork } from './work-board.ts'
import type { BoardView, TaskStatus } from './contracts.ts'
import { formatWhen, t, timingLabel, type CopyLocale, type TextKey } from './ui-copy.ts'

export const BOARD_ROOT = 'dsh-dot-board'

const DOT: Record<TaskStatus, StateDotState> = {
  running: 'ongoing', idle: 'done', blocked: 'warning', error: 'error', archived: 'idle',
}

/** Which part of the board the drawer shows: everything, or one of its three tabs. */
export type BoardFilter = 'all' | 'waiting' | 'active' | 'watch'

/** Items under each filter tab, from the same grouping the board draws. */
export function boardCounts(view: BoardView | undefined): Record<Exclude<BoardFilter, 'all'>, number> {
  if (!view) return { waiting: 0, active: 0, watch: 0 }
  const groups = groupBoard(view)
  const activeWatched = groups.watched.filter(task => task.status === 'running').length
  return {
    waiting: headerBoardCounts(view).waitingCount,
    active: groupWork(view.work ?? [], view.pending).active.length + activeWatched,
    watch: groups.watched.length + view.schedules.length,
  }
}

export interface BoardProps {
  readonly locale: CopyLocale
  readonly view: BoardView | undefined
  readonly error?: string
  readonly filter?: BoardFilter
  readonly onOpen: (sessionId: string) => void
  readonly onRetry: () => void
  readonly onRemoveSchedule: (id: string) => void
  /** Suppress the empty hint when WorkBoardPanel above already renders Changes. */
  readonly suppressEmpty?: boolean
}

function GroupTitle({ title, count }: { title: string; count?: number }) {
  return <span className="dsh-ui-meta dsh-dot-section-title">{count === undefined ? title : `${title} · ${count}`}</span>
}

/**
 * Board: requests waiting on the human, watched sessions and Dorothy's reminders.
 * Pure render over a board snapshot; the work changes are drawn above by WorkBoardPanel.
 */
export function Board({ locale, view, error, filter = 'all', onOpen, onRetry, onRemoveSchedule, suppressEmpty }: BoardProps) {
  if (view === undefined) {
    return (
      <div className={BOARD_ROOT}>
        {error === undefined ? null : (
          <div className="dsh-ui-row">
            <span className="dsh-ui-error" style={{ whiteSpace: 'pre-line' }}>{backendMissingText(locale, error) ?? `${t(locale, 'loadFailed')}: ${error}`}</span>
            <Button variant="ghost" onClick={onRetry}>{t(locale, 'retry')}</Button>
          </div>
        )}
      </div>
    )
  }
  const groups = groupBoard(view)
  const shows = (section: BoardFilter) => filter === 'all' || filter === section
  const counts = boardCounts(view)
  const empty = !suppressEmpty && (filter === 'all'
    ? groups.liveCount === 0 && view.pending.length === 0 && view.schedules.length === 0
    : counts[filter] === 0 && !(filter === 'watch' && groups.watchedArchived > 0))
  return (
    <div className={BOARD_ROOT}>
      <div className="dsh-ui-stack">
        {error !== undefined ? <div className="dsh-ui-row" role="alert"><span className="dsh-ui-error" style={{ whiteSpace: 'pre-line' }}>{backendMissingText(locale, error) ?? `${t(locale, 'loadFailed')}: ${error}`}</span><Button variant="ghost" onClick={onRetry}>{t(locale, 'retry')}</Button></div> : null}
        {empty ? <p className="dsh-ui-hint">{t(locale, 'empty')}</p> : null}
        {shows('waiting') && groups.requests.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardWaiting')}>
            <GroupTitle title={t(locale, 'boardWaiting')} count={groups.requests.length} />
            {groups.requests.map(item => (
              <button key={item.id} type="button" className="dsh-dot-row" onClick={() => onOpen(item.sessionId)}>
                <StateDot state="warning" />
                <span className="dsh-ui-compact dsh-ui-truncate">{item.subject}</span>
                <span className="dsh-ui-spacer" />
                <Tag tone="outline">{t(locale, item.kind)}</Tag>
              </button>
            ))}
          </section>
        ) : null}
        {((shows('watch') && (groups.watched.length > 0 || groups.watchedArchived > 0)) || (filter === 'active' && groups.watched.some(task => task.status === 'running'))) ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardWatched')}>
            <GroupTitle title={t(locale, 'boardWatched')} count={filter === 'active' ? groups.watched.filter(task => task.status === 'running').length : groups.watched.length} />
            {(filter === 'active' ? groups.watched.filter(task => task.status === 'running') : groups.watched).map(task => (
              <button key={task.sessionId} type="button" className="dsh-dot-row" onClick={() => onOpen(task.sessionId)}>
                <StateDot state={DOT[task.status]} />
                <span className="dsh-dot-main">
                  <span className="dsh-ui-compact dsh-ui-truncate">{task.title}</span>
                  {task.lastNote ? <span className="dsh-ui-hint dsh-ui-truncate">{task.lastNote}</span> : null}
                </span>
                <span className="dsh-ui-spacer" />
                {task.unseenTurns > 0 ? <span className="dsh-ui-meta">{task.unseenTurns} {t(locale, 'unread')}</span> : null}
                <Tag tone="outline">{t(locale, task.status)}</Tag>
              </button>
            ))}
            {shows('watch') && groups.watchedArchived > 0 ? <span className="dsh-ui-hint">{t(locale, 'archived')} · {groups.watchedArchived}</span> : null}
          </section>
        ) : null}
        {shows('watch') && view.schedules.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'reminders')}>
            <span className="dsh-ui-meta dsh-dot-section-title">{t(locale, 'reminders')}</span>
            {view.schedules.map(item => (
              <div key={item.id} className="dsh-dot-reminder">
                <span className="dsh-dot-main">
                  <span className="dsh-ui-compact dsh-ui-truncate" title={item.prompt}>{item.title}{item.recipeName ? ` → ${item.recipeName}` : ''}</span>
                  <span className="dsh-ui-hint dsh-ui-truncate">{timingLabel(locale, item.timing)} · {t(locale, 'reminderNext').replace('{when}', formatWhen(item.nextAt))}</span>
                </span>
                <span className="dsh-ui-spacer" />
                <Button variant="ghost" size="sm" title={t(locale, 'reminderRemoveTip')} onClick={() => onRemoveSchedule(item.id)}>{t(locale, 'reminderRemove')}</Button>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}
// Selectors spell the root out (.dsh-dot-board = BOARD_ROOT) so the repository scope check can read them.
export const boardCss = `
.dsh-dot-board { padding: 4px 2px 16px; overflow-y: auto; height: 100%; }
.dsh-dot-board > .dsh-ui-stack { gap: 18px; }
.dsh-dot-board section.dsh-ui-stack { gap: 8px; }
/* Status hierarchy: group titles read as quiet headings, not as content rows. */
.dsh-dot-board .dsh-dot-section-title {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px 6px;
  font-size: 11px; line-height: 16px; font-weight: 600;
  color: var(--dsw-alias-label-tertiary); user-select: none;
}
.dsh-dot-board .dsh-dot-section-title::after { content: ''; flex: 1; height: 0.5px; background: var(--dsw-alias-border-l2); }
.dsh-dot-board .dsh-dot-row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0;
  padding: 10px 12px; border: 0; border-radius: var(--dsw-radius-md);
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dsh-dot-board .dsh-dot-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-board .dsh-dot-row > [data-state] { flex-shrink: 0; }
.dsh-dot-board .dsh-dot-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-dot-board .dsh-dot-reminder {
  display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 8px 8px 12px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-board .dsh-dot-reminder > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-board .dsh-dot-row > .dsh-ui-meta { white-space: nowrap; flex-shrink: 0; }
.dsh-dot-board .dsh-dot-work {
  display: flex; flex-direction: column; min-width: 0;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke); overflow: hidden;
}
.dsh-dot-board .dsh-dot-work[data-status='rework'], .dsh-dot-board .dsh-dot-work[data-status='unverified'] {
  box-shadow: var(--dsw-elevation-stroke), inset 2.5px 0 0 var(--dsw-alias-state-warn-primary);
}
.dsh-dot-board .dsh-dot-work[data-status='review'] {
  box-shadow: var(--dsw-elevation-stroke), inset 2.5px 0 0 var(--dsw-alias-state-business-primary);
}
.dsh-dot-board .dsh-dot-work[data-status='done'], .dsh-dot-board .dsh-dot-work[data-status='cancelled'] { background: transparent; }
.dsh-dot-board .dsh-ui-stack > .dsh-dot-row { background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-stroke); border-radius: var(--dsw-radius-md); }
.dsh-dot-board .dsh-dot-titleline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-dot-board .dsh-dot-detail {
  display: flex; flex-direction: column; gap: 12px; padding: 12px 16px 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
}
.dsh-dot-board .dsh-dot-block { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-dot-board .dsh-dot-entry { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-dot-board .dsh-dot-text { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-board .dsh-dot-line { padding: 4px 6px; }
.dsh-dot-board .dsh-dot-fold { align-self: flex-start; padding-left: 4px; }
.dsh-dot-board .dsh-dot-work-head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px 6px; min-width: 0; }
.dsh-dot-board .dsh-dot-work-head > [data-state] { margin-top: 5px; flex-shrink: 0; }
.dsh-dot-board .dsh-dot-work-main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-dot-board .dsh-dot-work-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-dot-board .dsh-dot-work-mono { font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-board .dsh-dot-work-diag > summary { cursor: pointer; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-board .dsh-dot-work-facts-line { font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dsh-dot-board .dsh-dot-work-link { display: inline-flex; align-items: center; gap: 4px; font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); text-decoration: none; }
.dsh-dot-board a.dsh-dot-work-link:hover { color: var(--dsw-alias-label-primary); }
.dsh-dot-board .dsh-dot-work-title { font-size: 14px; line-height: 21px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-dot-board .dsh-dot-work-actions {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px;
  padding: 6px 14px 10px 30px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
}
.dsh-dot-board .dsh-dot-work-actions > button { white-space: nowrap; }
/* Visual grouping inside the actions row: primaries lead, secondaries follow,
   and the destructive zone stays separated with clear breathing room. */
.dsh-dot-board .dsh-dot-work-act-group { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dsh-dot-board .dsh-dot-work-act-group[data-kind='danger'] { margin-inline-start: 10px; padding-inline-start: 10px; border-inline-start: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-board .dsh-dot-work > .dsh-ui-hint { margin: 0; padding: 0 14px 10px 30px; }
.dsh-dot-board .dsh-dot-work-facts { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-board .dsh-dot-work-facts > summary {
  display: flex; align-items: center; gap: 6px; padding: 8px 14px 8px 30px; cursor: pointer; list-style: none;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-board .dsh-dot-work-facts > summary::-webkit-details-marker { display: none; }
.dsh-dot-board .dsh-dot-work-facts > summary::after { content: '›'; font-size: 14px; transition: transform 0.15s; }
.dsh-dot-board .dsh-dot-work-facts[open] > summary::after { transform: rotate(90deg); }
.dsh-dot-board .dsh-dot-work-facts > summary:hover { color: var(--dsw-alias-label-primary); }
.dsh-dot-board .dsh-dot-work-facts-body {
  display: flex; flex-direction: column; gap: 14px; padding: 12px 16px 16px;
  background: var(--dsw-alias-bg-base); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-board .dsh-dot-work-summary { margin: 0; overflow-wrap: anywhere; }
.dsh-dot-board .dsh-dot-work-list { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-dot-board .dsh-dot-work-run { display: flex; flex-direction: column; gap: 3px; }
.dsh-dot-board .dsh-dot-work-run-line { overflow-wrap: anywhere; }
.dsh-dot-board .dsh-dot-work-check {
  display: flex; align-items: center; gap: 10px; min-width: 0; padding: 7px 12px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
}
.dsh-dot-board .dsh-dot-work-check-ref { flex-shrink: 0; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-dot-board .dsh-dot-work-check-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-board .dsh-dot-work-check > :last-child { margin-left: auto; flex-shrink: 0; }
.dsh-dot-board .dsh-dot-work-pane { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dsh-dot-board .dsh-dot-work-pane[hidden] { display: none; }
.dsh-dot-board .dsh-dot-work-source { display: flex; flex-direction: column; gap: 5px; min-width: 0; border-radius: var(--dsw-radius-sm); }
.dsh-dot-board .dsh-dot-work-source-head {
  display: flex; align-items: center; gap: 6px; min-width: 0; padding: 5px 6px;
  margin: -5px -6px 0; border-radius: var(--dsw-radius-sm);
  font: 12px/18px var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); text-decoration: none;
}
.dsh-dot-board a.dsh-dot-work-source-head:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-board .dsh-dot-work-source-head > span:first-of-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-board .dsh-dot-work-pre {
  margin: 0; padding: 10px 12px; max-height: 340px; overflow: auto;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
  font: 12px/18px var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); white-space: pre; tab-size: 2;
}
.dsh-dot-board .dsh-dot-work-source-note { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-dot-board .dsh-dot-work-source-note > p { margin: 0; color: var(--dsw-alias-label-error); }
.dsh-dot-board .dsh-dot-work-open { margin-left: auto; }
.dsh-dot-board .dsh-dot-work-reject-box {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 4px 14px 12px 30px;
}
.dsh-dot-board .dsh-dot-work-reject-input { flex: 1 1 180px; min-width: 140px; }
.dsh-dot-board .dsh-dot-work-pane-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding-bottom: 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-dot-board .dsh-dot-work-chevron { flex-shrink: 0; width: 10px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-board .dsh-dot-work-source-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-dot-board .dsh-dot-work-source-body[data-collapsed] { display: none; }
.dsh-dot-board .dsh-dot-work-session-link {
  padding: 0 4px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-state-business-primary); font: inherit; font-size: 11px; cursor: pointer;
}
.dsh-dot-board .dsh-dot-work-session-link:hover { background: var(--dsw-alias-interactive-bg-hover); text-decoration: underline; }
.dsh-dot-board .dsh-dot-work-view { display: inline-flex; align-self: flex-start; flex-shrink: 0; border-radius: var(--dsw-radius-sm); overflow: hidden; box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-board .dsh-dot-work-view > button {
  padding: 2px 10px; border: 0; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary); font: 10px/17px var(--ds-font-family-code); cursor: pointer;
}
.dsh-dot-board .dsh-dot-work-view > button:hover:not(:disabled):not([data-active]) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-board .dsh-dot-work-view > button[data-active] { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); }
.dsh-dot-board .dsh-dot-work-view > button:disabled { opacity: 0.45; cursor: default; }
.dsh-dot-board .dsh-dot-work-diff {
  padding: 6px 0; max-height: 360px; overflow: auto;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
  font: 11px/18px var(--ds-font-family-code); color: var(--dsw-alias-label-secondary);
}
.dsh-dot-board .dsh-dot-work-diff-trunc {
  display: flex; align-items: center; gap: 8px; padding: 4px 0 0;
  font: 11px/18px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-board .dsh-dot-work-diff-line { display: flex; min-width: 0; white-space: pre; }
.dsh-dot-board .dsh-dot-work-diff-line[data-sign='add'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.dsh-dot-board .dsh-dot-work-diff-line[data-sign='add'] .dsh-dot-work-diff-text,
.dsh-dot-board .dsh-dot-work-diff-line[data-sign='add'] .dsh-dot-work-diff-sign { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-board .dsh-dot-work-diff-line[data-sign='del'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dsh-dot-board .dsh-dot-work-diff-line[data-sign='del'] .dsh-dot-work-diff-text,
.dsh-dot-board .dsh-dot-work-diff-line[data-sign='del'] .dsh-dot-work-diff-sign { color: var(--dsw-alias-state-error-primary); }
.dsh-dot-board .dsh-dot-work-diff-no { flex-shrink: 0; width: 34px; padding: 0 6px 0 12px; text-align: right; color: var(--dsw-alias-label-tertiary); user-select: none; }
.dsh-dot-board .dsh-dot-work-diff-sign { flex-shrink: 0; width: 14px; text-align: center; color: var(--dsw-alias-label-tertiary); user-select: none; }
.dsh-dot-board .dsh-dot-work-diff-text { flex: 1; padding-right: 10px; }
.dsh-dot-board .dsh-dot-work-diff-hunk { padding: 0 12px; color: var(--dsw-alias-label-tertiary); white-space: pre; }
.dsh-dot-board .dsh-dot-work-diff-quote {
  flex-shrink: 0; margin-right: 6px; padding: 0 5px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; cursor: pointer; opacity: 0;
}
.dsh-dot-board .dsh-dot-work-diff-line:hover .dsh-dot-work-diff-quote,
.dsh-dot-board .dsh-dot-work-diff-quote:focus-visible { opacity: 1; }
.dsh-dot-board .dsh-dot-work-diff-quote:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* The Recipes filter mounts inside this root too; these overrides beat the base
   chat rules on specificity alone and restyle the cards for the wide drawer. */
.dsh-dot-board.dsh-dot-recipes { padding: 0; height: auto; overflow: visible; }
.dsh-dot-board .dsh-dot-recipes { display: flex; flex-direction: column; gap: 14px; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke); padding: 14px 16px 14px;
}
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-head > .dsh-ui-compact { font-size: 14px; line-height: 21px; font-weight: 600; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-head > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-stats { display: flex; flex-direction: column; gap: 3px; padding-left: 2px; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-reminders { display: flex; flex-direction: column; gap: 3px; padding-left: 2px; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-refusal { color: var(--dsw-alias-danger); margin: 0; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-proposal {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  border-radius: var(--dsw-radius-md); padding: 10px 12px 12px; margin-top: 4px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-warning, var(--dsw-alias-accent));
}
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-proposal-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-proposal-diff {
  display: flex; flex-direction: column; gap: 8px; padding: 8px 10px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base);
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 17px;
}
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-proposal-field { display: flex; flex-direction: column; gap: 2px; }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-proposal-field > .dsh-ui-meta:first-child { font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-diff-add { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-diff-remove { color: var(--dsw-alias-state-error-primary); }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-diff-change { color: var(--dsw-alias-label-secondary); }
.dsh-dot-board .dsh-dot-recipes .dsh-dot-recipe-proposal-actions { display: flex; gap: 8px; }`
