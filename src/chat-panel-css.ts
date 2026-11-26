import { settingsCss } from './settings-panel.tsx'

// Selectors spell the root out (.dsh-dot-chat = CHAT_ROOT) so the repository scope check can read them.
export const chatCss = settingsCss + `
.dsh-dot-chat {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  padding-top: var(--dsh-frame-top-clearance);
}
.dsh-dot-chat .dsh-dot-head {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-dot-chat .dsh-dot-head > button,
.dsh-dot-chat .dsh-dot-drawer-head > button,
.dsh-dot-chat .dsh-dot-composer-bar button,
.dsh-dot-chat .dsh-dot-banner > button,
.dsh-dot-chat .dsh-ui-actions > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-ui-actions { flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-head-text { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-name { font-size: 14px; line-height: 20px; font-weight: 600; }
.dsh-dot-chat .dsh-dot-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dsh-dot-chat .dsh-dot-status[data-running] { color: var(--dsw-alias-state-business-primary); }
.dsh-dot-chat .dsh-dot-status-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-status[data-running] .dsh-dot-status-dot { background: var(--dsw-alias-state-business-primary); animation: dsh-dot-pulse 1.4s ease-in-out infinite; }
@keyframes dsh-dot-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .dsh-dot-chat .dsh-dot-status[data-running] .dsh-dot-status-dot { animation: none; } }
.dsh-dot-chat .dsh-dot-head { min-height: 48px; box-sizing: border-box; padding: 6px 12px 6px 16px; gap: 8px; }
.dsh-dot-chat .dsh-dot-segment-count {
  padding: 1px 6px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
@container (max-width: 420px) { .dsh-dot-chat .dsh-dot-segment-count { display: none; } }
.dsh-dot-chat .dsh-dot-starters { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 480px; margin-top: 12px; }
.dsh-dot-chat .dsh-dot-starter {
  padding: 6px 12px; border: 0; border-radius: var(--dsw-radius-sm); cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px;
}
.dsh-dot-chat .dsh-dot-starter:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-starter:disabled { opacity: 0.5; cursor: default; }
.dsh-dot-chat .dsh-dot-segment-wrap { display: flex; flex-direction: column; gap: 6px; }
.dsh-dot-chat .dsh-dot-segment button {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 2px; border: 0; background: none; cursor: pointer;
  color: inherit; font: inherit;
}
.dsh-dot-chat .dsh-dot-segment button:hover { color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-segment-note {
  display: flex; gap: 8px; align-items: baseline; align-self: center; max-width: 100%;
  padding: 6px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-segment-time { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-spacer { flex: 1; }
.dsh-dot-chat .dsh-dot-badge {
  display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px;
  margin-left: 6px; padding: 0 4px; border-radius: 8px; font-size: 11px;
  background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground);
}
.dsh-dot-chat .dsh-dot-head .dsh-dot-gear { position: relative; }
.dsh-dot-chat .dsh-dot-gear-dot {
  position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 3px;
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-dot-chat .dsh-dot-ctx-pill { gap: 8px; font-variant-numeric: tabular-nums; }
.dsh-dot-chat .dsh-dot-ctx-track {
  display: inline-block; width: 40px; height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-dot-chat .dsh-dot-ctx-track > span { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-ctx-num { font: 12px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: row; container-type: inline-size; }
.dsh-dot-chat .dsh-dot-chatcol { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dsh-dot-chat .dsh-dot-scroll-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsh-dot-chat .dsh-dot-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.dsh-dot-chat .dsh-dot-scroll-fab {
  position: absolute; right: 20px; bottom: 12px; z-index: 4;
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px;
  border: 0; border-radius: 999px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-scroll-fab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-scroll-fab[data-unread] { color: var(--dsw-alias-state-business-primary); font-weight: 500; }
.dsh-dot-chat .dsh-dot-drawer-layer { position: absolute; inset: 0; z-index: 10; display: flex; justify-content: flex-end; overflow: hidden; }
.dsh-dot-chat .dsh-dot-drawer-backdrop {
  position: absolute; inset: 0; padding: 0; border: 0; border-radius: 0; cursor: default;
  background: var(--dsw-alias-bg-mask-1); animation: dsh-dot-fade var(--ds-transition-duration, 0.2s) ease-out;
}
.dsh-dot-chat .dsh-dot-drawer {
  position: relative; width: min(760px, 68cqw); max-width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column;
  border-left: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  transition: width var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-out);
  animation: dsh-dot-drawer-in var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-out);
}
.dsh-dot-chat .dsh-dot-drawer[data-wide] { width: 90cqw; }
.dsh-dot-chat .dsh-dot-drawer[data-resizing] { transition: none; }
.dsh-dot-chat .dsh-dot-drawer-resize {
  position: absolute; top: 0; bottom: 0; left: -3px; z-index: 2; width: 7px; border: 0; padding: 0; background: transparent;
  cursor: col-resize; touch-action: none;
}
.dsh-dot-chat .dsh-dot-drawer-resize::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 1.5px; background: transparent;
  transition: background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out);
}
.dsh-dot-chat .dsh-dot-drawer-resize:hover::after,
.dsh-dot-chat .dsh-dot-drawer-resize:focus-visible::after,
.dsh-dot-chat .dsh-dot-drawer[data-resizing] .dsh-dot-drawer-resize::after { background: var(--dsw-alias-brand-primary); }
.dsh-dot-chat .dsh-dot-drawer-resize:focus-visible { outline: none; }
.dsh-dot-chat .dsh-dot-drawer-title {
  display: inline-flex; align-items: center; gap: 8px; min-width: 0; margin: 0; padding: 0 4px;
  font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@keyframes dsh-dot-drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes dsh-dot-fade { from { opacity: 0; } to { opacity: 1; } }
.dsh-dot-chat .dsh-dot-drawer-head {
  display: flex; align-items: center; gap: 4px; min-height: 46px; padding: 6px 8px 6px 12px; box-sizing: border-box;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-dot-chat .dsh-dot-drawer-head > button { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-drawer-body {
  display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden;
  container-type: inline-size; container-name: dot-drawer-body;
}
.dsh-dot-chat .dsh-dot-drawer-nav {
  flex: 0 0 auto; width: 136px; display: flex; flex-direction: column; gap: 2px;
  padding: 10px 8px 18px; overflow-y: auto; overscroll-behavior: contain;
  border-right: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
}
.dsh-dot-chat .dsh-dot-nav-group-label {
  padding: 6px 8px 4px; font-size: 11px; line-height: 16px; font-weight: 600;
  color: var(--dsw-alias-label-tertiary); user-select: none;
}
.dsh-dot-chat .dsh-dot-nav-sep {
  height: 0.5px; margin: 6px; background: var(--dsw-alias-border-l2); flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-nav-item {
  position: relative; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
  padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  text-align: left; cursor: pointer;
  transition: background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out);
}
.dsh-dot-chat .dsh-dot-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-nav-item[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 500;
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary);
}
.dsh-dot-chat .dsh-dot-nav-item[aria-pressed='true'] .dsh-dot-nav-icon { color: var(--dsw-alias-state-business-primary); }
.dsh-dot-chat .dsh-dot-nav-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-dot-chat .dsh-dot-nav-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 16px; height: 16px; color: inherit; }
.dsh-dot-chat .dsh-dot-filters button {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 5px 10px;
  border: 0; border-radius: var(--dsw-radius-sm); background: transparent; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-filters button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-filters button[aria-pressed='true'] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-dot-chat .dsh-dot-filters button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-dot-chat .dsh-dot-nav-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-nav-badge {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 11px; line-height: 16px; font-weight: 500;
  background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground);
}
.dsh-dot-chat .dsh-dot-settings-status {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 1; min-width: 0; margin-right: 2px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-success-primary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-settings-status--error { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-settings-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; container-type: inline-size; }
.dsh-dot-chat .dsh-dot-settings { display: flex; flex-direction: column; padding: 16px 18px 28px; }
.dsh-dot-chat .dsh-dot-settings[data-tab='tasks'] { padding: 12px 12px 24px; }
.dsh-dot-chat .dsh-dot-settings[data-tab='trajectory'] { padding: 0; }
.dsh-dot-chat .dsh-dot-settings[data-tab='trajectory'] .dsh-dot-tr { flex: none; }
.dsh-dot-chat .dsh-dot-settings[data-tab='trajectory'] .dsh-dot-tr-list { overflow: visible; }
@container dot-drawer-body (max-width: 439px) {
  .dsh-dot-chat .dsh-dot-drawer-nav { width: 68px; padding: 8px 4px 18px; align-items: stretch; gap: 3px; }
  .dsh-dot-chat .dsh-dot-nav-group-label { display: none; }
  .dsh-dot-chat .dsh-dot-nav-sep { width: 28px; align-self: center; margin: 4px 0; }
  .dsh-dot-chat .dsh-dot-nav-item {
    flex-direction: column; justify-content: center; gap: 2px;
    min-height: 44px; padding: 5px 2px; text-align: center;
  }
  .dsh-dot-chat .dsh-dot-nav-label {
    flex: 0 0 auto; max-width: 100%; font-size: 10px; line-height: 12px; text-align: center;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    white-space: normal; overflow-wrap: anywhere;
  }
  .dsh-dot-chat .dsh-dot-nav-item .dsh-dot-nav-badge { position: absolute; top: 2px; right: 3px; min-width: 14px; height: 14px; padding: 0 3px; font-size: 10px; line-height: 14px; }
  .dsh-dot-chat .dsh-dot-nav-item .dsh-dot-dirty-dot { position: absolute; top: 5px; right: 6px; }
  .dsh-dot-chat .dsh-dot-settings { padding: 14px 14px 28px; }
}
.dsh-dot-chat .dsh-dot-trajectory-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsh-dot-chat .dsh-dot-tasks { display: flex; flex-direction: column; gap: 12px; }
.dsh-dot-chat .dsh-dot-recipes { display: flex; flex-direction: column; gap: 10px; }
.dsh-dot-chat .dsh-dot-recipe {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke); padding: 10px 14px 12px;
}
.dsh-dot-chat .dsh-dot-recipe-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-recipe-head > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-recipe-stats { display: flex; flex-direction: column; gap: 2px; }
.dsh-dot-chat .dsh-dot-recipe-reminders { display: flex; flex-direction: column; gap: 2px; }
.dsh-dot-chat .dsh-dot-recipe-refusal { color: var(--dsw-alias-danger); margin: 0; }
.dsh-dot-chat .dsh-dot-recipe-proposal {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  border-radius: var(--dsw-radius-md); padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-warning, var(--dsw-alias-accent));
}
.dsh-dot-chat .dsh-dot-recipe-proposal-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-recipe-proposal-diff { display: flex; flex-direction: column; gap: 4px; }
.dsh-dot-chat .dsh-dot-recipe-proposal-field { display: flex; flex-direction: column; gap: 1px; }
.dsh-dot-chat .dsh-dot-recipe-proposal-actions { display: flex; gap: 6px; }
.dsh-dot-chat .dsh-dot-tasks .dsh-dot-board { padding: 0; height: auto; overflow: visible; }
.dsh-dot-chat .dsh-dot-filters { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.dsh-dot-chat .dsh-dot-filters button { padding: 3px 9px; font-size: 12px; line-height: 18px; }
@container (max-width: 560px) { .dsh-dot-chat .dsh-dot-drawer-widen { display: none; } }
@media (prefers-reduced-motion: reduce) { .dsh-dot-chat .dsh-dot-drawer, .dsh-dot-chat .dsh-dot-drawer-backdrop { transition: none; animation: none; } }
.dsh-dot-chat .dsh-dot-settings-pane { gap: 0; }
.dsh-dot-chat .dsh-dot-settings-pane > .dsh-ui-notice,
.dsh-dot-chat .dsh-dot-settings-pane > .dsh-ui-error { margin-bottom: 16px; }
/* Each settings topic is one quiet card on the drawer's base surface. */
.dsh-dot-chat .dsh-dot-pane-section {
  margin: 0 0 14px; padding: 14px 16px 4px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-chat .dsh-dot-pane-section:last-child { margin-bottom: 0; }
.dsh-dot-chat .dsh-dot-pane-section[data-tone='danger'] {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
}
.dsh-dot-chat .dsh-dot-pane-section .dsh-ui-form > .dsh-ui-field:first-child { padding-top: 4px; }
.dsh-dot-chat .dsh-dot-pane-section .dsh-ui-form > .dsh-ui-field:last-child { padding-bottom: 12px; }
.dsh-dot-chat .dsh-dot-pane-section-title {
  margin: 0 0 8px; font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-settings-note { margin: 0; padding-top: 16px; }
.dsh-dot-chat .dsh-dot-pane { display: flex; flex-direction: column; gap: 12px; }
.dsh-dot-chat .dsh-dot-log {
  display: flex; flex-direction: column; gap: 12px;
  max-width: 760px; margin: 0 auto; padding: 20px 16px 12px;
}
.dsh-dot-chat .dsh-dot-center {
  display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
  padding: 48px 24px;
}
.dsh-dot-chat .dsh-dot-greeting { font-size: 16px; line-height: 24px; font-weight: 600; }
.dsh-dot-chat .dsh-dot-muted { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); max-width: 420px; }
.dsh-dot-chat .dsh-dot-user { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-left: 48px; }
.dsh-dot-chat .dsh-dot-user > * { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-echo { opacity: 0.55; }
.dsh-dot-chat .dsh-dot-bot { display: flex; gap: 10px; align-items: flex-start; }
.dsh-dot-chat .dsh-dot-gutter { flex: 0 0 28px; width: 28px; min-height: 1px; }
.dsh-dot-chat .dsh-dot-body { flex: 1; min-width: 0; padding-top: 3px; }
.dsh-dot-chat .dsh-dot-view-number { margin-bottom: 4px; }
.dsh-dot-chat .dsh-dot-view[data-expired] { opacity: 0.7; }
.dsh-dot-chat .dsh-dot-activity { color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-row-content { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-row-layout { min-width: 0; }
.dsh-dot-chat .dsh-dot-row-sep {
  flex: none; width: 2px; height: 2px; margin: 0 8px;
  border-radius: 1px; background: var(--dsw-alias-label-caption);
}
.dsh-dot-chat .dsh-dot-row-summary {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption);
}
.dsh-dot-chat .dsh-dot-row-summary[data-tone="error"] { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-tool-group {
  display: flex; flex-direction: column; gap: 2px;
  margin: 4px 0 2px 7px; padding-left: 14px;
  border-left: 1px solid var(--dsw-alias-border-l2);
}
.dsh-dot-chat .dsh-dot-tool-body {
  display: flex; align-items: center; gap: 8px;
  margin: 3px 0 4px 22px; padding: 7px 11px; max-height: 200px; overflow-y: auto;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-tool-body[data-multiline] { flex-direction: column; align-items: stretch; gap: 6px; }
.dsh-dot-chat .dsh-dot-tool-body[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-tool-body[data-tone="error"] { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-tool-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-tool-foot { display: flex; justify-content: flex-end; }
.dsh-dot-chat .dsh-dot-notice { padding-left: 38px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-notice-list {
  display: flex; flex-direction: column; gap: 10px;
  margin: 4px 0 2px 7px; padding: 2px 0 2px 14px;
  border-left: 1px solid var(--dsw-alias-border-l2);
}
.dsh-dot-chat .dsh-dot-notice-entry { display: flex; flex-direction: column; gap: 5px; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-notice-entry + .dsh-dot-notice-entry { padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-dot-chat .dsh-dot-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-card-subject { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-code-pill {
  padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary); font: 12px/18px var(--ds-font-family-code);
}
.dsh-dot-chat .dsh-dot-req-id { font: 11px/17px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-card-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-card-body { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-card-error { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-card-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-cmd {
  margin: 0; padding: 7px 10px; max-height: 160px; overflow-y: auto;
  border: 0; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: 12px/18px var(--ds-font-family-code); white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-dot-chat .dsh-dot-questions { display: flex; flex-direction: column; gap: 6px; }
.dsh-dot-chat .dsh-dot-question-item { display: flex; flex-direction: column; gap: 4px; }
.dsh-dot-chat .dsh-dot-question-multi { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-question-opts { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-dot-chat .dsh-dot-kv-list { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; }
.dsh-dot-chat .dsh-dot-kv-row { display: flex; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-kv-key { flex-shrink: 0; font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-kv-val { min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-session-btn {
  display: inline-flex; align-items: center; gap: 3px; max-width: 220px; min-width: 0;
  padding: 1px 6px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-session-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-session-btn:focus-visible { outline: 1px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dsh-dot-chat .dsh-dot-session-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-turn-error {
  display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-error);
}
.dsh-dot-chat .dsh-dot-turn-error > [data-state] { margin-top: 6px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-segment {
  display: flex; align-items: center; gap: 10px; padding: 4px 0;
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-segment::before, .dsh-dot-chat .dsh-dot-segment::after { content: ''; flex: 1; height: 0.5px; background: var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-banner-wrap {
  width: 100%; max-width: 760px; margin: 0 auto; padding: 4px 16px 0; box-sizing: border-box;
}
.dsh-dot-chat .dsh-dot-banner {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 12px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-error);
}
.dsh-dot-chat .dsh-dot-banner-icon { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-error {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 12px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-error);
}
.dsh-dot-chat .dsh-dot-error-icon { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-error-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-error-dismiss {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-error-dismiss:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-composer {
  position: relative; display: flex; flex-direction: column; gap: 8px;
  width: 100%; max-width: 760px; margin: 0 auto; padding: 8px 16px 16px; box-sizing: border-box;
}
.dsh-dot-chat .dsh-dot-composer-card {
  position: relative; display: flex; flex-direction: column;
  border-radius: 14px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  transition: border-color var(--ds-transition-duration, 0.18s) ease, box-shadow var(--ds-transition-duration, 0.18s) ease, background-color var(--ds-transition-duration, 0.18s) ease;
}
.dsh-dot-chat .dsh-dot-composer-card:hover:not([data-disabled]) {
  border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.34));
}
.dsh-dot-chat .dsh-dot-composer-card:focus-within {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.16), 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 16%, transparent);
}
.dsh-dot-chat .dsh-dot-composer-card[data-running]:not(:focus-within) {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 40%, var(--dsw-alias-border-l2, transparent));
}
.dsh-dot-chat .dsh-dot-composer-card[data-disabled] { opacity: 0.65; }
.dsh-dot-chat .dsh-dot-composer-card[data-dragging] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dsh-dot-chat .dsh-dot-drop-mask {
  position: absolute; inset: 3px; z-index: 4; display: flex; align-items: center; justify-content: center; gap: 8px;
  border-radius: 11px; border: 1.5px dashed var(--dsw-alias-brand-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; pointer-events: none;
}
.dsh-dot-chat .dsh-dot-attachments {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 10px 12px 2px;
}
.dsh-dot-chat .dsh-dot-attachment {
  position: relative; display: inline-flex; align-items: center; gap: 8px; max-width: 200px;
  padding: 4px 26px 4px 4px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-chat .dsh-dot-attachment-thumb {
  width: 36px; height: 36px; border-radius: 6px; object-fit: cover; flex-shrink: 0;
  background: var(--dsw-alias-bg-base);
}
.dsh-dot-chat .dsh-dot-attachment-meta { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dsh-dot-chat .dsh-dot-attachment-name {
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-attachment-ext {
  font: 10px/13px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-attachment-remove {
  position: absolute; top: 4px; right: 4px; width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 0; border-radius: 9px; background: transparent; color: var(--dsw-alias-label-tertiary);
  font-size: 14px; line-height: 1; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-attachment-remove:hover {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-attachment-add {
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  width: 44px; height: 44px; padding: 0; border-radius: 9px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: 10px/12px var(--ds-font-family-code); cursor: pointer;
}
.dsh-dot-chat .dsh-dot-attachment-add:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-secondary); color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-dot-chat .dsh-dot-editor-wrap {
  position: relative; display: flex; align-items: flex-start; gap: 6px;
  padding: 11px 12px 4px 14px;
}
.dsh-dot-chat .dsh-dot-input {
  flex: 1; min-width: 0; min-height: 26px; max-height: 180px; resize: none;
  border: 0; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
  padding: 2px 0; overflow-y: auto;
}
.dsh-dot-chat .dsh-dot-composer-card[data-expanded] .dsh-dot-input {
  min-height: 132px; max-height: 360px;
}
.dsh-dot-chat .dsh-dot-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-dot-chat .dsh-dot-expand-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-expand-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-composer-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 8px 8px 10px; flex-wrap: wrap;
}
.dsh-dot-chat .dsh-dot-composer-tools {
  display: flex; align-items: center; gap: 4px; min-width: 0;
}
.dsh-dot-chat .dsh-dot-composer-right {
  display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-seg-feedback {
  display: inline-flex; align-items: center; gap: 4px; margin-left: 4px;
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-seg-feedback[data-done] { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-char-count {
  font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; white-space: nowrap; margin-right: 2px;
}
.dsh-dot-chat .dsh-dot-char-count[data-warn] { color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-stop-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 32px; min-width: 32px; height: 32px;
  padding: 0; border: 0; border-radius: 50%; gap: 0;
  background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff;
  font: inherit; white-space: nowrap; cursor: pointer;
  transition: filter 0.15s ease, transform 0.12s ease;
}
.dsh-dot-chat .dsh-dot-stop-btn:hover { filter: brightness(1.06); }
.dsh-dot-chat .dsh-dot-stop-btn:active { transform: scale(0.97); }
.dsh-dot-chat .dsh-dot-send-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 13px 0 11px; border: 0; border-radius: 15px;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  font: inherit; font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; cursor: pointer;
  transition: opacity 0.15s ease, transform 0.12s ease, background-color 0.15s ease;
}
.dsh-dot-chat .dsh-dot-send-btn:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-dot-chat .dsh-dot-send-btn:active:not(:disabled) { transform: scale(0.97); }
.dsh-dot-chat .dsh-dot-send-btn:disabled {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-dimmed);
  cursor: default; filter: none;
}
.dsh-dot-chat .dsh-dot-slash-menu {
  position: absolute; left: 16px; right: 16px; bottom: calc(100% - 4px); z-index: 8;
  max-width: 440px; border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-elevation-prominent);
  animation: dsh-dot-fade 0.14s ease-out;
}
.dsh-dot-chat .dsh-dot-slash-head {
  display: flex; align-items: center; justify-content: space-between; padding: 7px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-slash-kbd { font-family: var(--ds-font-family-code); font-weight: 400; }
.dsh-dot-chat .dsh-dot-slash-list {
  display: flex; flex-direction: column; gap: 2px; max-height: 256px; overflow-y: auto; padding: 5px;
}
.dsh-dot-chat .dsh-dot-slash-item {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 9px;
  border: 0; border-radius: 8px; background: transparent; text-align: left;
  color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-slash-item[data-active]:not(:disabled),
.dsh-dot-chat .dsh-dot-slash-item:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-dot-chat .dsh-dot-slash-item[data-active]:disabled,
.dsh-dot-chat .dsh-dot-slash-item[data-active][disabled] {
  background-color: rgba(128, 128, 128, 0.22);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.7);
}
.dsh-dot-chat .dsh-dot-slash-item:disabled { opacity: 0.45; cursor: default; }
.dsh-dot-chat .dsh-dot-slash-cmd {
  flex-shrink: 0; padding: 2px 6px; border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font: 11px/16px var(--ds-font-family-code);
}
.dsh-dot-chat .dsh-dot-slash-copy { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dsh-dot-chat .dsh-dot-slash-label {
  font-size: 13px; line-height: 18px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-slash-desc {
  font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-file { display: none; }
.dsh-dot-chat .dsh-dot-images { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-dot-chat .dsh-dot-image-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 2px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-image-chip button {
  border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; font: inherit;
}
.dsh-dot-chat .dsh-dot-dirty-dot {
  width: 6px; height: 6px; border-radius: 3px; flex-shrink: 0;
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-dot-chat .dsh-dot-unsaved-bar,
.dsh-dot-chat .dsh-dot-undo-bar {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke); font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-unsaved-bar {
  margin: 8px 12px; flex-wrap: wrap;
}
.dsh-dot-chat .dsh-dot-undo-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-image-thumb {
  display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 3px 8px 3px 3px;
  border: 0; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke); color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-image-thumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-image-thumb-img { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-image-thumb-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-lightbox { display: flex; justify-content: center; align-items: center; padding: 8px 0; }
.dsh-dot-chat .dsh-dot-lightbox-img { max-width: 100%; max-height: 72vh; object-fit: contain; border-radius: var(--dsw-radius-sm); }
.dsh-dot-chat .dsh-dot-approval-detail {
  margin-top: 8px; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); overflow: hidden;
}
.dsh-dot-chat .dsh-dot-approval-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px;
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-approval-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-approval-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-dot-chat .dsh-dot-approval-body {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px;
}
.dsh-dot-chat .dsh-dot-detail-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
.dsh-dot-chat .dsh-dot-detail-label { flex: 0 0 auto; min-width: 84px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.dsh-dot-chat .dsh-dot-detail-value {
  flex: 1 1 180px; min-width: 0; color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; overflow-wrap: anywhere;
}
.dsh-dot-chat .dsh-dot-detail-args {
  flex: 1 1 100%; margin: 2px 0 0; padding: 7px 10px; max-height: 220px; overflow: auto;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-elevation-stroke);
  color: var(--dsw-alias-label-secondary); font: 11px/17px var(--ds-font-family-code);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-dot-chat .dsh-dot-approval-missing {
  margin: 6px 0 0; padding: 6px 10px; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px;
}
.dsh-dot-chat .dsh-dot-notify-retry {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding: 7px 10px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-notify-retry [role='alert'] { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-retry-btn {
  padding: 2px 10px; border: 0; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover); box-shadow: var(--dsw-elevation-stroke);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-retry-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dsh-dot-chat .dsh-dot-retry-btn:disabled { opacity: 0.55; cursor: default; }
.dsh-dot-chat .dsh-dot-approval-card {
  display: flex; flex-direction: column; gap: 8px;
  margin: 16px 0; padding: 12px 14px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-chat .dsh-dot-approval-summary { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-approval-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-approval-desc { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-approval-why { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-approval-meta { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-approval-raw {
  margin: 0; max-height: 160px; overflow-y: auto;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-dot-chat .dsh-dot-approval-card .dsh-dot-approval-detail {
  margin-top: 0; border-radius: 0; background: transparent; box-shadow: none;
}
.dsh-dot-chat .dsh-dot-approval-card .dsh-dot-approval-toggle { width: auto; padding: 0; }
.dsh-dot-chat .dsh-dot-approval-card .dsh-dot-approval-toggle::before { content: '▸'; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-approval-card .dsh-dot-approval-toggle[aria-expanded='true']::before { content: '▾'; }
.dsh-dot-chat .dsh-dot-approval-card .dsh-dot-approval-body { padding: 6px 0 2px; border-top: 0; }
.dsh-dot-chat .dsh-dot-approval-card .dsh-dot-approval-missing { margin-top: 0; background: transparent; padding: 0; }
.dsh-dot-chat .dsh-dot-approval-card[data-expired] .dsh-dot-approval-summary,
.dsh-dot-chat .dsh-dot-approval-card[data-expired] .dsh-dot-approval-detail { opacity: 0.55; }
.dsh-dot-chat .dsh-dot-card-status { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-card-status[data-tone='error'] { color: var(--dsw-alias-label-error); }

.dsh-dot-chat .dsh-dot-plus-wrap { position: relative; display: inline-flex; }
.dsh-dot-chat .dsh-dot-plus-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; transition: background-color .15s ease, color .15s ease;
}
.dsh-dot-chat .dsh-dot-plus-btn:hover:not(:disabled), .dsh-dot-chat .dsh-dot-plus-btn[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-plus-btn:disabled { opacity: .4; cursor: default; }
.dsh-dot-chat .dsh-dot-plus-menu {
  position: absolute; left: 0; bottom: calc(100% + 7px); z-index: 10; min-width: 168px; padding: 4px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-elevation-prominent); animation: dsh-dot-fade .13s ease-out;
}
.dsh-dot-chat .dsh-dot-plus-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 8px;
  border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-plus-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-file-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-file-spinner {
  width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor; color: var(--dsw-alias-state-business-primary); animation: dsh-dot-spin .8s linear infinite; flex-shrink: 0;
}
@keyframes dsh-dot-spin { to { transform: rotate(360deg); } }
.dsh-dot-chat .dsh-dot-file-attachment[data-state='error'] { outline: 1px solid color-mix(in srgb, var(--dsw-alias-label-error) 55%, transparent); }
.dsh-dot-chat .dsh-dot-file-retry {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-error); cursor: pointer; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-file-retry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-send-btn { width: 32px; height: 32px; padding: 0; border-radius: 50%; gap: 0; }
.dsh-dot-chat .dsh-dot-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; max-width: min(76%, 620px); }
.dsh-dot-chat .dsh-dot-file-chip {
  display: inline-flex; align-items: center; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border-radius: 999px; padding: 4px 9px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 14px;
}
`
