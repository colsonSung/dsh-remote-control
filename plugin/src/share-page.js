/**
 * The guest page of a shared conversation.
 *
 * The page is the app seen from the outside: a rail, the shared conversation
 * beside it, the conversation itself with the tabs the host shows (Chat,
 * Trajectory, Context), the files of the task's project folder on the side,
 * and — for a write share — the composer at the bottom.
 *
 * It carries everything it needs: no build step, no bundle, no asset the host
 * would have to serve. It asks for the state once, follows the event stream,
 * browses the project folder through the host's own boundary, and — for a
 * write share — puts a message into the session.
 */

import { highlightCode, languageOf } from './share-highlight.js'
import { fileIconSvg, fileKindOf, fileSizeLabel } from './share-files.js'
import { GUEST_COLORS } from './share-identity.js'
import { DIAGRAM_CSS, diagramMathBundle, diagramRuntime } from './share-diagram.js'
import { markdownToHtml } from './share-markdown.js'

/**
 * The dark palette of the page.
 *
 * It is written once and used twice: once for the visitor whose system is
 * dark, and once for the visitor who asks for dark.
 */
const DARK_PALETTE = `  --bg: #151517;
  --surface: #1c1c1f;
  --surface-2: #242427;
  --surface-3: #2c2c2e;
  --line: rgba(255, 255, 255, 0.09);
  --line-strong: rgba(255, 255, 255, 0.16);
  --text: #f9fafb;
  --muted: #cfd3d6;
  --faint: #adb2b8;
  --accent: #7aaaff;
  --accent-soft: rgba(122, 170, 255, 0.14);
  --accent-contrast: #0d1016;
  --code-key: #c39bff;
  --code-string: #85d996;
  --code-number: #f0a97a;
  --code-comment: #7d838c;
  --code-punct: #aab0b8;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.45), 0 4px 14px -6px rgba(0, 0, 0, 0.55);
  --shadow-float: 0 2px 6px rgba(0, 0, 0, 0.5), 0 20px 48px -16px rgba(0, 0, 0, 0.75);`

/**
 * Escape one string for the HTML page.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}


/**
 * The guest page.
 *
 * @param {{ share: any, unlocked: boolean }} options
 * @returns {string}
 */
export function renderGuestPage(options = {}) {
  const share = options.share ?? {}
  const unlocked = options.unlocked === true
  const title = escapeHtml(share.title ?? 'Shared session')
  const permission = share.permission === 'write' ? 'write' : 'read'
  const id = escapeHtml(share.id ?? '')
  const writable = permission === 'write'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>
${DIAGRAM_CSS}
:root {
  color-scheme: light dark;
  /* The palette of the Harness app itself, measured from the running host.
     The guest page stands outside the app, so it carries the values itself —
     but they are the app's values, so the two read as one product. */
  --bg: #ffffff;
  --surface: #f6f7f9;
  --surface-2: #eceef2;
  --surface-3: #e2e5ea;
  --line: rgba(15, 17, 21, 0.10);
  --line-strong: rgba(15, 17, 21, 0.18);
  --text: #0f1115;
  --muted: #61666b;
  --faint: #81858c;
  --accent: #4176e6;
  --accent-soft: rgba(65, 118, 230, 0.10);
  --accent-contrast: #ffffff;
  --code-key: #7a3fb8;
  --code-string: #1a7f45;
  --code-number: #b5561a;
  --code-comment: #8a8f98;
  --code-punct: #61666b;
  --danger: #c0392b;
  --shadow-card: 0 1px 2px rgba(15, 17, 21, 0.06), 0 4px 14px -6px rgba(15, 17, 21, 0.10);
  --shadow-float: 0 2px 6px rgba(15, 17, 21, 0.08), 0 20px 48px -16px rgba(15, 17, 21, 0.24);
  --radius-sm: 6px;
  --radius-md: 12px;
  --radius-lg: 16px;
}
/* The dark palette follows the visitor's system, unless the visitor says
   otherwise: the same values serve the system and the toggle. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${DARK_PALETTE}
  }
}
:root[data-theme="dark"] {
${DARK_PALETTE}
}
* { box-sizing: border-box; }
/* The scrollbars are thin and out of the way: they appear when the area they
   belong to is under the pointer. */
.tree, .view, .file-panel-body, .shell {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.tree:hover, .view:hover, .file-panel-body:hover, .shell:hover {
  scrollbar-color: var(--line-strong) transparent;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: transparent; border-radius: 999px;
  border: 3px solid transparent; background-clip: padding-box;
}
.tree:hover::-webkit-scrollbar-thumb, .view:hover::-webkit-scrollbar-thumb,
.file-panel-body:hover::-webkit-scrollbar-thumb, .shell:hover::-webkit-scrollbar-thumb {
  background-color: var(--line-strong); background-clip: padding-box;
}
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
button, input { font: inherit; color: inherit; }
.shell { display: grid; grid-template-columns: 56px var(--side-width, 268px) minmax(0, 1fr); height: 100vh; }
body[data-side="collapsed"] .shell { grid-template-columns: 56px 0 minmax(0, 1fr); }
.side-handle {
  position: absolute; right: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize;
  background: transparent; border: 0; padding: 0; touch-action: none; z-index: 2;
}
.side-handle::after {
  content: ""; position: absolute; right: 3px; top: 0; bottom: 0; width: 1px; background: transparent; transition: background .12s ease;
}
.side-handle:hover::after, .side-handle:focus-visible::after { background: var(--accent); }
.side-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
body[data-side="collapsed"] .side { overflow: hidden; border-right: 0; }
.side {
  position: relative; display: flex; flex-direction: column; min-height: 0;
  background: var(--surface); border-right: 1px solid var(--line);
}
.rail {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 12px 0; background: var(--surface); border-right: 1px solid var(--line);
}
.rail-mark {
  width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
  background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; letter-spacing: .02em;
}
.rail-toggle {
  display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer;
}
.rail-toggle:hover { background: var(--surface-2); color: var(--text); }
.rail-chip {
  margin-top: auto; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
  background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 600;
}

.side-head {
  padding: 14px 16px 8px; font-size: 11px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--faint);
}
.share-card { padding: 0 16px 14px; display: flex; flex-direction: column; gap: 6px; }
.share-name { font-size: 14px; font-weight: 600; line-height: 1.35; }
.share-meta { font-size: 12px; color: var(--muted); }
.chip {
  display: inline-flex; align-items: center; gap: 5px; align-self: flex-start;
  padding: 2px 8px; border: 1px solid var(--line-strong); border-radius: 999px;
  background: var(--surface-2); color: var(--muted); font-size: 11px; font-weight: 600;
}
.chip[data-permission="write"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.files { flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.presence {
  border-top: 1px solid var(--line); padding: 10px 16px 12px; display: flex; flex-direction: column; gap: 6px;
}
.presence-head { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.presence-guest { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.presence-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent); flex: none; }
.presence-guest[data-editing="true"] .presence-dot { background: var(--code-string); }
.presence-file { color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.presence-locked { color: var(--code-number); }
/* A guest that is writing says so with three dots that travel: the owner of
   the conversation sees the same sign, and the guest that is writing sees it
   in the others. */
.presence-guest[data-typing="true"] { color: var(--text); }
.presence-dots { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.presence-dots i {
  width: 4px; height: 4px; border-radius: 999px; background: currentColor; opacity: .3;
  animation: presence-blink 1.2s ease-in-out infinite;
}
.presence-dots i:nth-child(2) { animation-delay: .16s; }
.presence-dots i:nth-child(3) { animation-delay: .32s; }
.presence-typing { color: var(--muted); }
@keyframes presence-blink {
  0%, 70%, 100% { opacity: .3; transform: translateY(0); }
  35% { opacity: 1; transform: translateY(-1px); }
}
@media (prefers-reduced-motion: reduce) {
  .presence-dots i { animation: none; opacity: .7; }
}
.files-head {
  padding: 12px 16px 8px; display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint);
}
/* The tree of the project: the root scrolls, the folders inside it do not.
   A folder inside the tree steps to the right, and carries the line that says
   where it begins. */
#tree { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 16px; }
.tree {
  display: block; overflow: visible; margin-left: 7px; padding-left: 12px;
  border-left: 1px solid var(--line);
}
.tree-row {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px;
  border: 0; border-radius: var(--radius-sm); background: none; color: var(--text);
  font-size: 13px; text-align: left; cursor: pointer;
}
.tree-row:hover { background: var(--surface-2); }
.tree-row[data-selected="true"] { background: var(--accent-soft); color: var(--accent); }
.tree-row[data-open="true"] .tree-name { color: var(--accent); }
.tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-icon { flex: none; display: inline-flex; align-items: center; color: var(--faint); }
.tree-row[data-open="true"] .tree-icon, .tree-row[data-selected="true"] .tree-icon { color: var(--accent); }
.tree-svg { display: block; }
.tree-size { margin-left: auto; flex: none; padding-left: 8px; color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.tree-empty { padding: 8px; color: var(--faint); font-size: 12px; }
.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; transition: margin-right .12s ease; }
body[data-panel="open"] .main { margin-right: var(--file-panel-width, 520px); }
.top {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 14px 20px 12px; background: var(--surface); border-bottom: 1px solid var(--line);
}
.top-tools { display: flex; align-items: center; gap: 6px; }
.top-tool {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--muted);
  font-size: 12px; cursor: pointer;
}
.top-tool:hover { color: var(--text); border-color: var(--line-strong); }
.top-tool[aria-pressed="true"] { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent); }
.top-tool-icon { padding: 0 7px; }
/* The name of the guest: the owner of the conversation and the other guests
   see it, so it stands in the header where it can be changed at any time. */
.whoami {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted);
}
.whoami-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--accent); flex: none; }
.whoami-input {
  width: 92px; padding: 0; border: 0; background: none; color: var(--text);
  font-family: inherit; font-size: 12px;
}
.whoami-input:focus { outline: none; }
.whoami-input::placeholder { color: var(--faint); }
.theme-moon { display: none; }
:root[data-theme="dark"] .theme-sun { display: none; }
:root[data-theme="dark"] .theme-moon { display: block; }
:root[data-theme="light"] .theme-sun { display: block; }
:root[data-theme="light"] .theme-moon { display: none; }
.top-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.35; }
.top-meta { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
.tabs {
  display: flex; gap: 2px; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--line);
}
.tab {
  padding: 9px 2px; margin-right: 18px; border: 0; border-bottom: 2px solid transparent;
  background: none; color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
}
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.view { flex: 1; min-height: 0; overflow-y: auto; padding: 20px; }
/* The transcript wears the app's own type: the numbers below are the ones
   measured from the running host - a body of 13px on a 23px line, a column
   of 742px in the middle of the canvas. */
.stream { display: flex; flex-direction: column; gap: 6px; max-width: 742px; margin: 0 auto; }
.turn {
  display: flex; flex-direction: column; gap: 2px; padding: 0;
  border: 0; border-radius: 0; background: none; box-shadow: none;
}
.turn-role {
  display: block; margin-bottom: 2px; font-size: 11px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; color: var(--faint);
}
.turn-body { font-size: 13px; line-height: 23px; color: var(--text); }
.turn[data-role="user"] {
  margin: 6px 0 2px; padding: 8px 12px; border-radius: var(--radius-md);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent);
}
.turn[data-role="user"] .turn-role { color: var(--accent); }
.turn[data-role="tool"] { border-color: var(--line); background: var(--surface-1); padding: 10px 12px; }
.turn[data-role="tool"] .turn-role { color: var(--faint); }
.turn[data-role="tool"] .turn-body { color: var(--muted); font-size: 13px; }
.turn-group {
  border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-1);
  padding: 2px 4px;
}
.turn-group-head {
  cursor: pointer; padding: 8px 10px; color: var(--muted); font-size: 12px; list-style: none;
}
.turn-group-head::-webkit-details-marker { display: none; }
.turn-group-head::before { content: "▸ "; color: var(--faint); }
.turn-group[open] > .turn-group-head::before { content: "▾ "; }
.turn-group-head:hover { color: var(--text); }
.turn-group-body { display: flex; flex-direction: column; gap: 6px; padding: 0 10px 10px; }
.turn-group-item { display: block; padding: 4px 0; }
.turn-step { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.turn-step-kind {
  flex: none; padding: 1px 7px; border-radius: 999px; background: var(--surface-2);
  color: var(--muted); font-size: 11px; font-weight: 600; text-transform: lowercase;
}
.turn-step-title { font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
.turn-step-detail { display: block; margin: 2px 0 4px; }
.turn-step-detail summary {
  cursor: pointer; color: var(--muted); font-size: 12px; list-style: none;
}
.turn-step-detail summary::-webkit-details-marker { display: none; }
.turn-step-detail summary::before { content: "▸ "; color: var(--faint); }
.turn-step-detail[open] summary::before { content: "▾ "; }
.turn-step-detail pre {
  margin: 8px 0 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface-2); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.turn-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.turn-body:empty::after { content: "(empty)"; color: var(--faint); }
.steps { display: flex; flex-direction: column; gap: 8px; max-width: 860px; margin: 0 auto; }
.step {
  display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px;
  border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface);
}
.step-kind {
  flex: none; padding: 2px 7px; border-radius: 999px; background: var(--surface-2);
  color: var(--muted); font-size: 11px; font-weight: 600;
}
.step-title { font-size: 13px; font-weight: 500; }
.step-detail { font-size: 12px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.files-list { display: flex; flex-direction: column; gap: 8px; max-width: 860px; margin: 0 auto; }
.context-note {
  max-width: 860px; margin: 0 auto 16px; padding: 12px 14px; border: 1px solid var(--line);
  border-radius: var(--radius-md); background: var(--surface-2); color: var(--muted); font-size: 13px;
}
.empty { max-width: 860px; margin: 0 auto; color: var(--faint); font-size: 13px; }
/* The composer is as wide as the conversation it belongs to: the same column,
   the same centre. */
.shortened[hidden] { display: none; }
.shortened {
  margin: 0 0 8px; padding: 7px 12px; border: 1px solid var(--code-number);
  border-radius: var(--radius-md); background: color-mix(in srgb, var(--code-number) 10%, transparent);
  color: var(--text); font-size: 12px;
}
/* The queue of the conversation: a small strip above the composer. The dot
   pulses while the agent works, so a guest who is not reading the transcript
   still sees that the conversation is alive. */
.queue[hidden] { display: none; }
.queue {
  display: flex; align-items: flex-start; gap: 10px; margin: 0 0 8px; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-2);
  font-size: 12px; color: var(--muted);
}
.queue::before {
  content: ""; width: 7px; height: 7px; flex: none; margin-top: 5px; border-radius: 999px;
  background: var(--accent); animation: queue-pulse 1.4s ease-in-out infinite;
}
@keyframes queue-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
/* The strip is a column of lines, and every line of it wraps: on a phone the
   bar grows downwards instead of running past the edge of the screen. */
.queue-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.queue-working { color: var(--text); overflow-wrap: anywhere; }
.queue-waiting { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.queue-item { color: var(--faint); overflow-wrap: anywhere; }
.queue-name { color: var(--muted); font-weight: 600; }
/* The message of the guest who reads the page is told apart from the
   messages of the others: the name of it is in the accent of the page. */
.queue-item[data-mine="true"] .queue-name,
.queue-working[data-mine="true"] .queue-name { color: var(--accent); }
.jump-latest {
  position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%); z-index: 6;
  height: 30px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--muted); font-size: 12px; cursor: pointer;
  box-shadow: var(--shadow-card);
}
.jump-latest:hover { color: var(--text); border-color: var(--line-strong); }
.composer { position: relative; padding: 0 0 4px; background: none; max-width: 742px; margin: 0 auto; width: 100%; }
.composer-card {
  display: flex; flex-direction: column; gap: 12px; padding: 8px 0 0;
  border-radius: 28px; background: var(--bg);
  box-shadow: 0 0 0 0.5px rgba(15, 17, 21, 0.1), 0 1px 2px rgba(15, 17, 21, 0.04), 0 6px 20px -12px rgba(15, 17, 21, 0.18);
}
.composer-input {
  width: 100%; min-height: 36px; max-height: 220px; padding: 4px 8px 0 14px;
  border: 0; border-radius: 0; background: none; color: var(--text); resize: none; outline: none;
  font-family: inherit; font-size: 13px; line-height: 23px;
}
.composer-input::placeholder { color: var(--faint); }
.composer-row { display: flex; align-items: center; gap: 12px; padding: 0 14px 10px 8px; }
.composer-spacer { flex: 1; }
.composer-note { padding: 8px 16px 0; color: var(--faint); font-size: 12px; }
.composer-card.composer-readonly { padding: 14px 16px; }
.composer-card.composer-readonly .composer-note { padding: 0; }
/* The offer of an annotation: a small pill next to the passage the reader
   picked. It is quiet on purpose — the passage is the content, and the pill
   only says that the passage can be talked about. */
.annotate-bar {
  position: absolute; z-index: 8; display: none; align-items: center;
  padding: 2px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); box-shadow: var(--shadow-float);
}
.annotate-bar[data-open="true"] { display: flex; }
.annotate-bar-button {
  display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 8px;
  border: 0; border-radius: 999px; background: transparent; color: var(--text);
  font-size: 12px; cursor: pointer;
}
.annotate-bar-button:hover { background: var(--surface-2); }
.annotate-bar-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.annotate-bar-button svg { display: block; color: var(--muted); }
.annotate-bar-button:hover svg { color: var(--accent); }
/* The panel: a card with a head, the passage that was picked, what has to
   change, and the wording the agent proposes. */
.annotate-panel {
  position: absolute; z-index: 9; display: none; flex-direction: column; gap: 10px; width: 320px;
  padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-md);
  background: var(--surface); box-shadow: var(--shadow-float);
}
.annotate-panel[data-open="true"] { display: flex; }
.annotate-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.annotate-title { font-size: 12px; font-weight: 600; color: var(--text); }
.annotate-close {
  display: grid; place-items: center; width: 24px; height: 24px; flex: none; padding: 0;
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer;
}
.annotate-close:hover { background: var(--surface-2); color: var(--text); }
.annotate-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.annotate-quote {
  margin: 0; padding: 2px 0 2px 10px; border-left: 2px solid var(--line-strong);
  color: var(--muted); font-size: 12px; line-height: 1.5; max-height: 54px; overflow: hidden;
}
.annotate-quote:empty { display: none; }
.annotate-panel textarea {
  width: 100%; min-height: 56px; padding: 8px 10px; border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm); background: var(--bg); color: var(--text); resize: vertical;
  font: inherit; font-size: 13px; line-height: 1.5; outline: none;
}
.annotate-panel textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.annotate-panel textarea:disabled { color: var(--muted); }
.annotate-draft {
  padding: 8px 10px; border-radius: var(--radius-sm); background: var(--surface-2);
  color: var(--text); font-size: 12px; line-height: 1.5; max-height: 140px; overflow: auto;
}
.annotate-draft:empty { display: none; }
.annotate-panel-actions { display: flex; align-items: center; gap: 8px; }
.annotate-button {
  height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--muted); font-size: 12px; white-space: nowrap; cursor: pointer;
}
.annotate-button:hover { color: var(--text); border-color: var(--line-strong); }
.annotate-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.annotate-button:disabled { opacity: .6; cursor: default; }
.annotate-send {
  margin-left: auto; height: 28px; padding: 0 12px; border: 0; border-radius: var(--radius-sm);
  background: var(--accent); color: var(--accent-contrast); font-size: 12px; white-space: nowrap; cursor: pointer;
}
.annotate-send:hover { filter: brightness(1.06); }
.annotate-send:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.annotate-send:disabled { background: var(--surface-3); color: var(--faint); cursor: default; }
.annotate-error { color: var(--code-number); font-size: 12px; }
.annotate-error:empty { display: none; }
.composer-attach {
  display: grid; place-items: center; width: 28px; height: 28px; flex: none; padding: 0;
  border: 0; border-radius: 999px; background: var(--surface-2); color: var(--muted); cursor: pointer;
}
.composer-attach:hover { color: var(--text); }
.composer-pending { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; }
.composer-pending:empty { display: none; }
.composer-pending-item {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px;
  border-radius: 999px; background: var(--surface-2); color: var(--muted); font-size: 11px;
}
.composer-chip {
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
  border-radius: 999px; background: var(--surface-2); color: var(--muted); font-size: 12px;
}
.composer-send {
  display: grid; place-items: center; width: 32px; height: 32px; padding: 0; flex: none;
  border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-contrast); cursor: pointer;
}
.composer-send:disabled { background: var(--surface-3); color: var(--faint); cursor: default; }
.composer-send:disabled { opacity: .5; cursor: not-allowed; }
.gate { display: grid; place-items: center; min-height: 100vh; padding: 24px; }
.gate-card {
  width: min(420px, 100%); padding: 24px; border: 1px solid var(--line); border-radius: var(--radius-lg);
  background: var(--surface); box-shadow: var(--shadow-float);
}
.gate-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.gate-sub { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
.gate-row { display: flex; gap: 8px; }
.gate-input {
  flex: 1; min-height: 42px; padding: 10px 12px; border: 1px solid var(--line-strong);
  border-radius: var(--radius-md); background: var(--bg); color: var(--text); outline: none;
}
.gate-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.gate-button {
  min-height: 42px; padding: 0 18px; border: 0; border-radius: var(--radius-md);
  background: var(--accent); color: #fff; font-weight: 500; cursor: pointer;
}
.gate-error { margin: 12px 0 0; color: #c0392b; font-size: 12px; }
.file-panel {
  position: fixed; inset: 0 0 0 auto; width: var(--file-panel-width, 520px); max-width: 100%;
  display: flex; flex-direction: column;
  background: var(--surface); border-left: 1px solid var(--line); box-shadow: var(--shadow-float); z-index: 20;
}
body[data-panel="max"] .file-panel { width: 100vw; max-width: 100vw; }
body[data-panel="max"] .main { margin-right: 0; }
body[data-panel="max"] .file-panel-handle { display: none; }
.file-panel-handle {
  position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize;
  background: transparent; border: 0; padding: 0; touch-action: none;
}
.file-panel-handle::after {
  content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: transparent; transition: background .12s ease;
}
.file-panel-handle:hover::after, .file-panel-handle:focus-visible::after { background: var(--accent); }
.file-panel-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.file-panel[data-resizing="true"] { user-select: none; }
.file-panel[data-resizing="true"] .file-panel-handle::after { background: var(--accent); }
.file-panel[hidden] { display: none; }
.file-panel-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-panel-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; }
/* A document in the panel is a document: the same marks, at the size of a
   document. */
.file-panel-body .md { font-size: 14px; line-height: 1.65; }
.file-panel-body .md h1 { font-size: 20px; } .file-panel-body .md h2 { font-size: 17px; }
.file-panel-body .md h3 { font-size: 15px; } .file-panel-body .md h4 { font-size: 14px; }
.file-panel-body .md p { margin: 0 0 10px; }
.file-panel-body .md ul, .file-panel-body .md ol { margin: 0 0 10px; }
.file-panel-body .md table { font-size: 13px; }
.file-panel-body .md th, .file-panel-body .md td { padding: 6px 10px; }
.file-panel-body pre {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.file-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.file-panel-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.file-panel-tools { display: flex; align-items: center; gap: 6px; flex: none; }
.file-tool {
  height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--muted); font-size: 12px; cursor: pointer;
}
.file-tool:hover { color: var(--text); border-color: var(--line-strong); }
.file-tool-icon { display: grid; place-items: center; width: 28px; padding: 0; }
.max-restore { display: none; }
body[data-panel="max"] .max-open { display: none; }
body[data-panel="max"] .max-restore { display: block; }
.file-panel-path { font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-code { margin: 0; padding: 14px 16px; }
.file-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.file-editor-area {
  flex: 1; min-height: 0; width: 100%; padding: 14px 16px; border: 0; outline: none; resize: none;
  background: var(--bg); color: var(--text); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.collab-cursors { position: absolute; inset: 0; pointer-events: none; }
.file-editor { position: relative; }
.collab-caret { position: absolute; width: 2px; height: 18px; border-radius: 1px; }
.collab-caret-name {
  position: absolute; left: 0; top: -16px; padding: 0 5px; border-radius: 4px 4px 4px 0;
  background: inherit; color: #fff; font-size: 10px; line-height: 15px; white-space: nowrap;
}
.file-editor-foot {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--line);
  color: var(--faint); font-size: 12px;
}
/* The notice of a write that was refused: what did not reach the file, and
   the one thing that puts it there. */
.file-editor-note { color: var(--code-number); }
.file-editor-again {
  height: 26px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text); font-size: 12px; white-space: nowrap; cursor: pointer;
}
.file-editor-again:hover { border-color: var(--accent); }
.file-editor-again:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.file-editor-again:disabled { opacity: .6; cursor: default; }
.file-editor-save {
  margin-left: auto; height: 28px; padding: 0 12px; border: 0; border-radius: 8px;
  background: var(--accent); color: var(--accent-contrast); font-size: 12px; cursor: pointer;
}
.file-editor-save:disabled { background: var(--surface-3); color: var(--faint); cursor: default; }
.file-conflict {
  margin: 12px 16px 0; padding: 10px 12px; border: 1px solid var(--code-number); border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--code-number) 12%, transparent); color: var(--text); font-size: 12px;
}
.file-conflict pre {
  margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--surface-2);
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 220px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.file-image { display: block; max-width: 100%; height: auto; margin: 14px auto; border-radius: var(--radius-sm); }
.file-note { padding: 0 16px 14px; color: var(--faint); font-size: 12px; }
.file-frame { width: 100%; height: calc(100vh - 120px); border: 0; background: #fff; }
.turn-frame { width: 100%; height: 420px; border: 1px solid var(--line); border-radius: var(--radius-md); background: #fff; }
.turn-body a[href^="#file="] { cursor: pointer; }
/* A message is a message: the type of the app's own transcript. A document in
   the file panel is a document: the same marks, at the size of a document. */
.md { font-size: 13px; line-height: 23px; display: flex; flex-direction: column; gap: 3px; }
.md > * { margin: 0; }
.md h1, .md h2, .md h3, .md h4 { margin: 12px 0 4px; line-height: 1.45; font-weight: 600; }
.md h1 { font-size: 15px; } .md h2 { font-size: 14px; } .md h3 { font-size: 13px; } .md h4 { font-size: 13px; }
.md p { margin: 0 0 3px; }
.md ul, .md ol { margin: 0 0 4px; padding-left: 20px; }
.md li { margin: 1px 0; }
.md li > p { margin: 0 0 1px; }
.md code { padding: 1px 4px; border-radius: 4px; background: var(--surface-2); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.md pre { margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-2); overflow-x: auto; }
.md pre code { padding: 0; background: none; }
.md blockquote { margin: 0 0 6px; padding: 0 10px; border-left: 2px solid var(--line-strong); color: var(--muted); }
.md table { width: 100%; margin: 0 0 8px; border-collapse: collapse; font-size: 13px; }
.md th, .md td { padding: 4px 8px; border: 1px solid var(--line); text-align: left; }
.md th { background: var(--surface-2); font-weight: 600; }
.md a { color: var(--accent); }
.md img { max-width: 100%; height: auto; border-radius: var(--radius-sm); }
.md hr { margin: 12px 0; border: 0; border-top: 1px solid var(--line); }
.md .mermaid {
  margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface-2); text-align: center; overflow-x: auto;
}
.md .mermaid svg { max-width: 100%; height: auto; }
/* A document in the panel is a document: the same marks, at the size of a
   document. */
/* The document follows the panel. A panel that is wider gives the document
   the width it can use: the tables, the code and the diagrams need it, and a
   reader who drags the panel open is asking for exactly that.
   The lines of the prose keep a measure of their own — about forty Chinese
   characters — so that a wide panel does not make them hard to read. */
.file-markdown { padding: 4px 20px 28px; width: 100%; font-size: 14px; line-height: 1.65; }
/* The measure belongs to the text: a paragraph, a list item, a heading. The
   containers around them — a list, a quotation, a table, a diagram — take the
   width of the panel, so that a table inside a quotation is not squeezed
   into the measure of a paragraph. */
.file-markdown p, .file-markdown li, .file-markdown h1, .file-markdown h2,
.file-markdown h3, .file-markdown h4, .file-markdown h5, .file-markdown h6 { max-width: 72ch; }
.file-markdown h1 { font-size: 20px; } .file-markdown h2 { font-size: 17px; }
.file-markdown h3 { font-size: 15px; } .file-markdown h4 { font-size: 14px; }
.file-markdown p { margin: 0 0 10px; }
.file-markdown ul, .file-markdown ol { margin: 0 0 10px; }
.file-markdown table { font-size: 13px; }
.file-markdown th, .file-markdown td { padding: 6px 10px; }
.tok-key { color: var(--code-key); }
.tok-str { color: var(--code-string); }
.tok-num { color: var(--code-number); }
.tok-com { color: var(--code-comment); font-style: italic; }
.tok-tag { color: var(--accent); }
.tok-link { color: var(--accent); }
.tok-head { color: var(--accent); font-weight: 600; }
.tok-code { color: var(--code-string); }
.file-close { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm); }
.file-close:hover { background: var(--surface-2); }
@media (max-width: 900px) {
  /* The rail stays: it holds the button that opens the files. The files
     themselves are folded away until that button is pressed, so the
     conversation has the whole width of a phone. */
  .shell { grid-template-columns: 56px 0 minmax(0, 1fr); }
  body[data-side="open"] .shell { grid-template-columns: 56px var(--side-width, 268px) minmax(0, 1fr); }
  .side { overflow: hidden; }
  .file-panel { width: 100%; }
  .file-panel-handle { display: none; }
  body[data-panel="open"] .main { margin-right: 0; }
  .top, .tabs, .view, .composer { padding-left: 14px; padding-right: 14px; }
  .tab { margin-right: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
${unlocked ? guestShell(title, permission, id, writable) : gate(title, id)}
<script>
${unlocked ? guestScript() : gateScript()}
</script>
</body>
</html>
`
}

/**
 * The shell of the guest page.
 *
 * @param {string} title
 * @param {'read' | 'write'} permission
 * @param {string} id
 * @param {boolean} writable
 * @returns {string}
 */
function guestShell(title, permission, id, writable) {
  const permissionLabel = permission === 'write' ? 'Read and write' : 'Read only'
  return `<div class="shell">
  <aside class="rail">
    <div class="rail-mark">DSH</div>
    <button class="rail-toggle" id="sideToggle" type="button" aria-label="Fold the files away" title="Fold the files away">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
    <div class="rail-chip" title="Guest">G</div>
  </aside>
  <aside class="side">
    <div class="side-handle" id="sideHandle" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the files column"></div>
    <div class="side-head">Shared conversation</div>
    <div class="share-card">
      <div class="share-name">${title}</div>
      <div class="share-meta">Shared with you</div>
      <span class="chip" data-permission="${permission}">${permissionLabel}</span>
      <div class="share-meta">Share id ${id}</div>
    </div>
    <div class="files">
      <div class="files-head"><span>Project files</span></div>
      <div class="tree" id="tree"></div>
    </div>
    <div class="presence" id="presence" hidden></div>
  </aside>
  <main class="main">
    <header class="top">
      <div>
        <h1 class="top-title">${title}</h1>
        <div class="top-meta">
          <span class="chip" data-permission="${permission}">${permissionLabel}</span>
          <span>Shared conversation</span>
        </div>
      </div>
      <div class="top-tools">
        <label class="whoami" title="The name the owner and the other guests see">
          <span class="whoami-dot" id="whoamiDot"></span>
          <input class="whoami-input" id="whoamiInput" type="text" maxlength="24" placeholder="Your name" aria-label="Your name">
        </label>
        <button class="top-tool top-tool-icon" id="themeToggle" type="button" aria-label="Switch the theme" title="Switch the theme">
          <svg class="theme-sun" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3.1" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          <svg class="theme-moon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        </button>
        <button class="top-tool" id="filesToggle" type="button" aria-pressed="false">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.3 1.5h4.1a1 1 0 0 1 1 1v5.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
          <span>Files</span>
        </button>
      </div>
    </header>
    <nav class="tabs" role="tablist">
      <button class="tab" role="tab" data-tab="chat" aria-selected="true">Chat</button>
    </nav>
    <section class="view" id="view"></section>
    ${writable ? composer() : '<div class="composer"><button class="jump-latest" id="jumpLatest" type="button" hidden>Latest</button><div class="composer-card composer-readonly"><div class="composer-note">This conversation is read-only. You can follow it, but not type in it.</div></div></div>'}
  </main>
</div>
<div class="file-panel" id="filePanel" hidden>
  <div class="file-panel-handle" id="fileHandle" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the file panel"></div>
  <div class="file-panel-head">
    <div class="file-panel-heading">
      <span class="file-panel-title" id="fileTitle"></span>
      <span class="file-panel-path" id="filePath"></span>
    </div>
    <div class="file-panel-tools">
      ${writable ? '<button class="file-tool" id="fileEdit" type="button" hidden>Edit</button>' : ''}
      <button class="file-tool file-tool-icon" id="fileMax" type="button" aria-label="Take the whole page" title="Take the whole page">
        <svg class="max-open" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M13.5 10v3.5H10M2.5 10v3.5H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <svg class="max-restore" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 6H2.5V2.5M10 6h3.5V2.5M13.5 10v3.5H10M2.5 10v3.5H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="file-tool" id="fileToggle" type="button" hidden>Source</button>
      <button class="file-close" id="fileClose" type="button" aria-label="Close the file">✕</button>
    </div>
  </div>
  <div class="file-panel-body" id="fileBody"></div>
  <div class="annotate-bar" id="annotateBar" data-open="false">
    <button class="annotate-bar-button" id="annotateStart" type="button" title="Ask the agent to change this" aria-label="Ask the agent to change this">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.1 2.6 13.4 4.9 5.6 12.7 2.8 13.2l.5-2.8 7.8-7.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      <span>Annotate</span>
    </button>
  </div>
  <div class="annotate-panel" id="annotatePanel" data-open="false">
    <div class="annotate-head">
      <span class="annotate-title">Ask the agent to change this</span>
      <button class="annotate-close" id="annotateClose" type="button" aria-label="Close" title="Close">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </div>
    <blockquote class="annotate-quote" id="annotateQuote"></blockquote>
    <textarea placeholder="What has to change here?"></textarea>
    <div class="annotate-draft"></div>
    <div class="annotate-error"></div>
    <div class="annotate-panel-actions">
      <button class="annotate-button" id="annotateDraft" type="button">Let the agent write it</button>
      <button class="annotate-send" id="annotateSend" type="button" disabled>Send</button>
    </div>
  </div>
</div>`
}

/**
 * The composer of a write share.
 *
 * @returns {string}
 */
function composer() {
  // The composer of the app: a card with a ring around it, the input on top
  // and the row of controls under it.
  return `<form class="composer" id="composer">
  <button class="jump-latest" id="jumpLatest" type="button" hidden>Latest</button>
  <div class="queue" id="queue" hidden>
    <div class="queue-body">
      <div class="queue-working"></div>
      <ol class="queue-waiting"></ol>
    </div>
  </div>
  <div class="shortened" id="shortened" hidden></div>
  <div class="composer-card">
    <textarea class="composer-input" id="composerInput" rows="1" placeholder="Message or run a task, / commands, @ files"></textarea>
    <div class="composer-pending" id="composerPending" hidden></div>
    <div class="composer-row">
      <button class="composer-attach" id="composerAttach" type="button" aria-label="Attach a file" title="Attach an image or a file">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 4.2 5.1 8.6a2.2 2.2 0 0 0 3.1 3.1l4.6-4.6a3.7 3.7 0 0 0-5.2-5.2L3 6.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <input class="composer-file" id="composerFile" type="file" multiple hidden>
      <span class="composer-chip" title="The agent runs with the owner's permissions">Shared with the owner</span>
      <span class="composer-spacer"></span>
      <button class="composer-send" id="composerSend" type="submit" aria-label="Send">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M8 3 4 7M8 3l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>
  <div class="composer-note">Your message goes into this conversation and waits its turn: the agent answers one message at a time. The agent runs with the owner's permissions.</div>
</form>`
}

/**
 * The page a visitor sees before the passcode.
 *
 * @param {string} title
 * @param {string} id
 * @returns {string}
 */
function gate(title, id) {
  return `<div class="gate">
  <form class="gate-card" id="gateForm">
    <h1 class="gate-title">${title}</h1>
    <p class="gate-sub">This conversation is shared with you. Enter the passcode to open it.</p>
    <div class="gate-row">
      <input class="gate-input" id="gateInput" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="Passcode" aria-label="Passcode">
      <button class="gate-button" type="submit">Open</button>
    </div>
    <p class="gate-error" id="gateError"></p>
  </form>
</div>`
}

/**
 * The script of the passcode gate.
 *
 * @returns {string}
 */
function gateScript() {
  return `(function () {
  var form = document.getElementById('gateForm');
  var input = document.getElementById('gateInput');
  var error = document.getElementById('gateError');
  var base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    error.textContent = '';
    fetch(base + 'unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: input.value }) })
      .then(function (response) {
        if (!response.ok) { error.textContent = 'The passcode is wrong.'; return; }
        location.reload();
      })
      .catch(function () { error.textContent = 'The passcode could not be checked.'; });
  });
  input.focus();
})();`
}

/**
 * The script of the guest shell.
 *
 * @returns {string}
 */
function guestScript() {
  return `(function () {
  // The highlighter and the language reader travel with the page: the browser
  // has no build step and no module loader of its own here.
  var languageOf = (${languageOf.toString()});
  var highlight = (${highlightCode.toString()});
  var fileKindOf = (${fileKindOf.toString()});
  var fileIconSvg = (${fileIconSvg.toString()});
  var fileSizeLabel = (${fileSizeLabel.toString()});
  var markdown = (${markdownToHtml.toString()});
  // The viewer of a diagram travels with it: a drawing is drawn at the size
  // it needs, and the reader zooms into it when the whole of it is too much
  // to read at once.
  var diagramMath = (${diagramMathBundle.toString()})();
  var diagram = (${diagramRuntime.toString()})(diagramMath);
  // The palette of the guests travels with the page as well: it is written
  // once, in the module the Host reads it from, so the colour of a guest is
  // the same in every place it is shown.
  var GUEST_COLORS = ${JSON.stringify(GUEST_COLORS)};
  var base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  var view = document.getElementById('view');
  var tree = document.getElementById('tree');
  var tab = 'chat';
  var messages = [];
  var loaded = { chat: false, trajectory: false, context: false };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  // The mermaid library is heavy - five megabytes of it - so it arrives only
  // when a document asks for a diagram. A host without it keeps the code as
  // code, which is what the reader sees anyway.
  var mermaidPromise = null;
  function loadMermaid() {
    if (window.mermaid !== undefined) return Promise.resolve(window.mermaid);
    if (mermaidPromise !== null) return mermaidPromise;
    mermaidPromise = new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = base + 'api/asset?name=mermaid';
      script.onload = function () { resolve(window.mermaid === undefined ? null : window.mermaid); };
      script.onerror = function () { resolve(null); };
      document.head.appendChild(script);
    });
    return mermaidPromise;
  }

  function renderDiagrams(article) {
    if (article === null || article === undefined) return;
    var blocks = article.querySelectorAll('code.language-mermaid');
    if (blocks.length === 0) return;
    var dark = isDark();
    var styles = getComputedStyle(document.documentElement);
    var pick = function (name, fallback) {
      var value = styles.getPropertyValue(name);
      return value.trim().length > 0 ? value.trim() : fallback;
    };
    var draw = function (mermaid, holder) {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            fontSize: '13px',
            primaryColor: dark ? 'rgba(65, 118, 230, 0.16)' : 'rgba(65, 118, 230, 0.10)',
            primaryTextColor: pick('--text', '#0f1115'),
            primaryBorderColor: pick('--accent', '#4176e6'),
            secondaryColor: pick('--surface-2', '#eceef2'),
            tertiaryColor: pick('--surface-3', '#e2e5ea'),
            lineColor: pick('--muted', '#61666b'),
            textColor: pick('--text', '#0f1115'),
            mainBkg: pick('--surface', '#f6f7f9'),
            nodeBorder: pick('--accent', '#4176e6'),
            clusterBkg: pick('--surface-2', '#eceef2'),
            clusterBorder: pick('--line-strong', 'rgba(15,17,21,0.18)'),
            edgeLabelBackground: pick('--bg', '#ffffff'),
          },
        });
      } catch (error) { return; }
      var run = mermaid.run({ nodes: [holder] });
      if (run !== undefined && typeof run.then === 'function') {
        run.then(function () {
          // The drawing is there now: the viewer takes its size and lets the
          // reader zoom into it.
          var svg = holder.querySelector('svg');
          if (svg === null || svg === undefined) return;
          diagram.mount(holder, svg);
        }).catch(function () { /* the code stays as code */ });
        return;
      }
      if (run !== undefined && typeof run.catch === 'function') {
        run.catch(function () { /* the code stays as code */ });
      }
    };

    var holders = [];
    for (var index = 0; index < blocks.length; index++) {
      var code = blocks[index];
      var pre = code.parentNode;
      if (pre === null || pre.tagName !== 'PRE') continue;
      var holder = document.createElement('pre');
      holder.className = 'mermaid';
      holder.textContent = code.textContent;
      pre.parentNode.replaceChild(holder, pre);
      holders.push(holder);
    }
    if (holders.length === 0) return;

    // The library comes in the background, and a diagram is drawn when it
    // comes into view: the document itself is there at once.
    loadMermaid().then(function (mermaid) {
      if (mermaid === null || mermaid === undefined) return;
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          draw(mermaid, entry.target);
        });
      }, { rootMargin: '200px' });
      holders.forEach(function (holder) { observer.observe(holder); });
    }).catch(function () { /* the code stays as code */ });
  }

  // A relative path in a message names a file of the project. The guest opens
  // it in the panel, so the link carries the path and the click is ours.
  function fileSource(source) {
    if (/^(https?:|data:|mailto:|#)/i.test(source)) return source;
    var parts = [];
    String(source).split('/').forEach(function (part) {
      if (part === '.' || part.length === 0) return;
      if (part === '..') { parts.pop(); return; }
      parts.push(part);
    });
    var path = parts.join('/');
    if (path.length === 0) return '#';
    return '#file=' + encodeURIComponent(path);
  }

  function get(url) {
    return fetch(base + url, { headers: { accept: 'application/json' } }).then(function (response) {
      if (!response.ok) throw new Error('refused');
      return response.json();
    });
  }
  // A file comes back as text, not as JSON. The version of the file travels
  // with it, so the guest knows what it is looking at.
  function getText(url) {
    return fetch(base + url).then(function (response) {
      if (!response.ok) {
        var failure = new Error('refused');
        failure.status = response.status;
        throw failure;
      }
      var version = response.headers.get('x-dsh-share-version') ?? '';
      return response.text().then(function (text) { return { text: text, version: version }; });
    });
  }
  function timeOf(value) {
    if (typeof value !== 'number' || value <= 0) return '';
    return new Date(value).toLocaleTimeString();
  }

  // The transcript is the one the app shows: what was asked, what the agent
  // did and what it answered. The agent writes Markdown, so the guest reads
  // Markdown; a step of the agent's work carries its name, and its detail
  // waits folded away.
  function paintMessage(turn, step) {
    var kind = step.kind || 'answer';
    var text = step.detail === undefined ? (step.text || '') : step.detail;

    // A question is a question: whoever asked it - the owner, a guest, a
    // teammate finishing its work - the guest reads it as it was written,
    // with its headings, its lists and its code.
    if (kind === 'prompt' || kind === 'answer') {
      var asked = kind === 'prompt';
      turn.setAttribute('data-role', asked ? 'user' : 'assistant');
      turn.appendChild(el('span', 'turn-role', asked ? 'You asked' : 'The agent replied'));
      var body = el('div', 'turn-body');
      if (/^\s*(<!doctype html|<html[\s>])/i.test(text)) {
        var frame = el('iframe', 'turn-frame');
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = text;
        body.appendChild(frame);
      } else {
        body.className = 'turn-body md';
        body.innerHTML = markdown(text, { resolve: fileSource });
        renderDiagrams(body);
      }
      turn.appendChild(body);
      return;
    }

    // A step of the agent's work.
    turn.setAttribute('data-role', 'tool');
    turn.appendChild(el('span', 'turn-role', 'Tool'));
    var head = el('div', 'turn-step');
    head.appendChild(el('span', 'turn-step-kind', kind));
    head.appendChild(el('span', 'turn-step-title', step.title || 'A tool ran'));
    turn.appendChild(head);
    if (text.length > 0) {
      var details = el('details', 'turn-step-detail');
      var summary = el('summary', null, 'Details');
      var pre = el('pre');
      pre.textContent = text;
      details.appendChild(summary);
      details.appendChild(pre);
      turn.appendChild(details);
    }
  }

  // The work of the agent gathers into one folded group: the guest reads the
  // conversation, and opens the steps when the steps are what they care about.
  // The conversation is long: the guest scrolls up to read, and a button takes
  // them back to the newest message.
  var newMessages = 0;
  var jumpButton = document.getElementById('jumpLatest');
  var atBottom = function () {
    return view.scrollHeight - view.scrollTop - view.clientHeight < 48;
  };
  var paintJump = function () {
    if (jumpButton === null) return;
    var bottom = atBottom();
    jumpButton.hidden = bottom && newMessages === 0;
    jumpButton.textContent = newMessages > 0 ? newMessages + ' new' : 'Latest';
  };
  var toBottom = function () {
    newMessages = 0;
    view.scrollTop = view.scrollHeight;
    paintJump();
  };
  if (jumpButton !== null) {
    jumpButton.addEventListener('click', toBottom);
    view.addEventListener('scroll', paintJump, { passive: true });
  }

  function renderChat() {
    view.innerHTML = '';
    if (messages.length === 0) { view.appendChild(el('p', 'empty', 'No messages yet.')); return; }
    var stream = el('div', 'stream');
    var group = null;
    var count = 0;
    var flush = function () {
      if (group === null) return;
      group.firstChild.textContent = count === 1 ? '1 tool call' : count + ' tool calls';
      stream.appendChild(group);
      group = null;
      count = 0;
    };
    messages.forEach(function (step) {
      var kind = step.kind || 'answer';
      if (kind === 'prompt' || kind === 'answer') {
        flush();
        // A message with nothing in it is noise, not a turn.
        var content = step.detail === undefined ? '' : step.detail;
        if (content.trim().length === 0) return;
        var turn = el('article', 'turn');
        paintMessage(turn, step);
        stream.appendChild(turn);
        return;
      }
      if (group === null) {
        group = el('details', 'turn-group');
        group.appendChild(el('summary', 'turn-group-head', ''));
        group.appendChild(el('div', 'turn-group-body'));
      }
      var item = el('div', 'turn-group-item');
      var line = el('div', 'turn-step');
      line.appendChild(el('span', 'turn-step-kind', kind));
      line.appendChild(el('span', 'turn-step-title', step.title || 'A tool ran'));
      item.appendChild(line);
      var detail = step.detail === undefined ? '' : step.detail;
      if (detail.length > 0) {
        var more = el('details', 'turn-step-detail');
        more.appendChild(el('summary', null, 'Details'));
        var pre = el('pre');
        pre.textContent = detail;
        more.appendChild(pre);
        item.appendChild(more);
      }
      group.lastChild.appendChild(item);
      count += 1;
    });
    flush();
    view.appendChild(stream);
    if (newMessages === 0) {
      view.scrollTop = view.scrollHeight;
    } else {
      paintJump();
    }
  }

  function renderTrajectory(data) {
    view.innerHTML = '';
    var steps = (data && data.steps) || [];
    if (steps.length === 0) { view.appendChild(el('p', 'empty', 'No steps recorded yet.')); return; }
    var list = el('div', 'steps');
    steps.forEach(function (step) {
      var row = el('div', 'step');
      row.appendChild(el('span', 'step-kind', step.kind || 'step'));
      var body = el('div');
      body.appendChild(el('div', 'step-title', step.title || ''));
      if (step.detail) body.appendChild(el('div', 'step-detail', step.detail));
      row.appendChild(body);
      list.appendChild(row);
    });
    view.appendChild(list);
  }

  function renderContext(data) {
    view.innerHTML = '';
    var files = (data && data.files) || [];
    var note = el('div', 'context-note', (data && data.summary) || 'The files this conversation produced.');
    view.appendChild(note);
    if (files.length === 0) { view.appendChild(el('p', 'empty', 'No files recorded yet.')); return; }
    var list = el('div', 'files-list');
    files.forEach(function (file) {
      var row = el('button', 'tree-row');
      row.type = 'button';
      row.appendChild(el('span', 'tree-name', file.path));
      row.addEventListener('click', function () { openFile(file.path); });
      list.appendChild(row);
    });
    view.appendChild(list);
  }

  function renderTab() {
    if (tab === 'chat') { renderChat(); return; }
    if (loaded[tab]) return;
    loaded[tab] = true;
    get('api/' + tab).then(function (data) {
      if (tab === 'trajectory') renderTrajectory(data); else renderContext(data);
    }).catch(function () {
      view.innerHTML = '';
      view.appendChild(el('p', 'empty', 'This view is not available.'));
    });
  }

  // The tree of the project folder: a folder opens and closes, a file opens in
  // the panel. Folders come first, so the shape of the folder reads at a
  // glance.
  function loadTree(path, container) {
    var query = path ? '?path=' + encodeURIComponent(path) : '';
    return get('api/tree' + query).then(function (data) {
      var entries = (data && data.entries) || [];
      if (entries.length === 0 && container.getAttribute('data-loaded') === 'true') return;
      container.setAttribute('data-loaded', 'true');
      container.innerHTML = '';
      var folders = entries.filter(function (entry) { return entry.kind === 'directory'; });
      var files = entries.filter(function (entry) { return entry.kind !== 'directory'; });
      var byName = function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); };
      folders.sort(byName);
      files.sort(byName);
      folders.concat(files).forEach(function (entry) {
        var row = el('button', 'tree-row');
        row.type = 'button';
        row.setAttribute('data-path', entry.path);
        row.setAttribute('data-kind', entry.kind);
        row.title = entry.path;
        var icon = el('span', 'tree-icon');
        var paint = function (open) {
          icon.innerHTML = entry.kind === 'directory'
            ? fileIconSvg('directory', { open: open })
            : fileIconSvg(fileKindOf(entry.name));
        };
        paint(false);
        row.appendChild(icon);
        row.appendChild(el('span', 'tree-name', entry.name));
        var size = fileSizeLabel(entry.size);
        if (size.length > 0) row.appendChild(el('span', 'tree-size', size));
        if (entry.kind === 'directory') {
          row.setAttribute('data-open', 'false');
          row.addEventListener('click', function () {
            var open = row.getAttribute('data-open') === 'true';
            row.setAttribute('data-open', open ? 'false' : 'true');
            paint(!open);
            var child = row.parentNode.querySelector('[data-children-of="' + entry.path + '"]');
            if (open) { if (child) child.remove(); return; }
            if (child) return;
            child = el('div', 'tree');
            child.setAttribute('data-children-of', entry.path);
            row.parentNode.insertBefore(child, row.nextSibling);
            loadTree(entry.path, child);
          });
        } else {
          row.addEventListener('click', function () {
            var rows = document.querySelectorAll('.tree-row');
            for (var index = 0; index < rows.length; index++) rows[index].removeAttribute('data-selected');
            row.setAttribute('data-selected', 'true');
            openFile(entry.path);
          });
        }
        container.appendChild(row);
      });
    }).catch(function () {
      container.innerHTML = '';
      container.appendChild(el('p', 'tree-empty', 'The project folder is not available.'));
    });
  }

  // What the panel shows: the name of the file, the path it came from, and
  // the file itself — a Markdown document as a document, an HTML file in a
  // sandbox of its own, a picture as a picture, and source as source.
  var currentFile = null;
  var currentRaw = null;
  // The text the guest is editing: a write that was refused has to be able
  // to send it again.
  var editorText = '';
  var currentView = 'preview';
  var currentVersion = '';
  var editing = false;
  var editVersion = '';

  function setEditing(on) {
    editing = on === true;
    var button = document.getElementById('fileEdit');
    if (button !== null) button.textContent = editing ? 'Done' : 'Edit';
    var toggle = document.getElementById('fileToggle');
    if (toggle !== null) toggle.hidden = editing || currentFile === null || !isTextual(currentFile);
    if (editing) {
      roomPost({ action: 'editing', file: currentFile, editing: true });
      paintEditor();
    } else {
      roomPost({ action: 'editing', file: currentFile, editing: false });
    }
  }

  function isTextual(path) {
    var kind = fileKindOf(path);
    return kind === 'code' || kind === 'text' || kind === 'data' || kind === 'markdown' || kind === 'plain';
  }

  // The collaborative editor: the guests of a share edit one document, and
  // the document is written to the file when they stop typing.
  var yjsPromise = null;
  var collab = null;

  function loadYjs() {
    if (window.YShare !== undefined) return Promise.resolve(window.YShare);
    if (yjsPromise !== null) return yjsPromise;
    yjsPromise = new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = base + 'api/asset?name=yjs';
      script.onload = function () { resolve(window.YShare ?? null); };
      script.onerror = function () { resolve(null); };
      document.head.appendChild(script);
    });
    return yjsPromise;
  }

  function caretBox(textarea, offset) {
    var mirror = document.createElement('div');
    var style = getComputedStyle(textarea);
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordBreak = 'break-word';
    mirror.style.width = textarea.clientWidth + 'px';
    mirror.style.font = style.font;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.padding = style.padding;
    mirror.style.boxSizing = style.boxSizing;
    mirror.textContent = textarea.value.substring(0, offset);
    var mark = document.createElement('span');
    mark.textContent = textarea.value.substring(offset) || '.';
    mirror.appendChild(mark);
    document.body.appendChild(mirror);
    var top = mark.offsetTop - textarea.scrollTop;
    var left = mark.offsetLeft - textarea.scrollLeft;
    document.body.removeChild(mirror);
    return { top: top, left: left };
  }

  // The annotation: the guest picks a passage of the document, writes what
  // has to change, and the model is asked for the wording of it.
  var annotateBar = null;
  var annotatePanel = null;
  var annotateSelection = null;

  function closeAnnotate() {
    if (annotateBar !== null) annotateBar.setAttribute('data-open', 'false');
    if (annotatePanel !== null) annotatePanel.setAttribute('data-open', 'false');
    annotateSelection = null;
  }

  function openAnnotate(box) {
    var selection = window.getSelection();
    var text = selection === null ? '' : String(selection.toString() ?? '');
    if (text.trim().length === 0) return;
    var range = selection.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    var host = document.querySelector('.file-panel-body');
    if (host === null) return;
    var hostBox = host.getBoundingClientRect();
    var picked = text.trim();
    // The same passage: the offer only moves. What the guest has written so
    // far stays where it is — a selection that grows must not wipe it.
    var same = annotateSelection !== null && annotateSelection.text === picked;
    annotateSelection = {
      text: picked,
      before: text.slice(0, 4000),
      path: currentFile ?? '',
    };
    var top = rect.top - hostBox.top - 44;
    var left = rect.left - hostBox.left;
    annotateBar.style.top = Math.max(4, top) + 'px';
    annotateBar.style.left = Math.max(8, Math.min(left, hostBox.width - 200)) + 'px';
    annotateBar.setAttribute('data-open', 'true');
    annotatePanel.style.top = Math.max(44, top + 38) + 'px';
    annotatePanel.style.left = Math.max(8, Math.min(left, hostBox.width - 336)) + 'px';
    if (same) return;
    // The panel is prepared for this passage, but it does not open: the
    // reader says so. A panel that opens over a document nobody asked about
    // is an interruption, and it takes the focus away from the passage.
    var area = annotatePanel.querySelector('textarea');
    area.value = '';
    area.disabled = false;
    var quote = annotatePanel.querySelector('.annotate-quote');
    if (quote !== null) quote.textContent = picked.length > 220 ? picked.slice(0, 220) + '…' : picked;
    var draft = annotatePanel.querySelector('.annotate-draft');
    if (draft !== null) draft.textContent = '';
    var error = annotatePanel.querySelector('.annotate-error');
    if (error !== null) error.textContent = '';
    var send = annotatePanel.querySelector('.annotate-send');
    if (send !== null) send.disabled = true;
  }

  function draftAnnotation() {
    var area = annotatePanel.querySelector('textarea');
    var button = annotatePanel.querySelector('.annotate-button');
    var draft = annotatePanel.querySelector('.annotate-draft');
    var error = annotatePanel.querySelector('.annotate-error');
    var send = annotatePanel.querySelector('.annotate-send');
    error.textContent = '';
    draft.textContent = '';
    send.disabled = true;
    button.disabled = true;
    button.textContent = 'Writing...';
    fetch(base + 'api/annotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: {
          intent: 'issue',
          path: annotateSelection?.path ?? '',
          kind: 'region',
          tag: 'div',
          selector: annotateSelection?.path ?? '',
          area: 'the selected passage',
          subject: annotateSelection?.before ?? '',
          comment: area.value,
        },
      }),
    }).then(function (response) { return response.json(); }).then(function (answer) {
      button.disabled = false;
      button.textContent = 'Let the agent write it';
      if (answer === undefined || answer.ok !== true) {
        error.textContent = answer?.error?.message ?? 'The host could not draft this.';
        return;
      }
      draft.textContent = answer.result?.text ?? '';
      send.disabled = draft.textContent.length === 0;
    }).catch(function () {
      button.disabled = false;
      button.textContent = 'Let the agent write it';
      error.textContent = 'The host could not be reached.';
    });
  }

  function sendAnnotation() {
    var draft = annotatePanel.querySelector('.annotate-draft');
    var text = draft.textContent ?? '';
    if (text.length === 0) return;
    var message = 'On ' + (annotateSelection?.path ?? 'the file') + ':\\n\\n> ' + (annotateSelection?.before ?? '') + '\\n\\n' + text;
    fetch(base + 'api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
    }).then(function () { closeAnnotate(); }).catch(function () { /* the message did not make it */ });
  }

  // The annotation bar and its panel.
  var annotateBar = document.getElementById('annotateBar');
  var annotatePanel = document.getElementById('annotatePanel');
  if (annotateBar !== null && annotatePanel !== null) {
    document.getElementById('annotateStart').addEventListener('click', function () {
      // The reader asked for it: the panel opens over the passage.
      var area = annotatePanel.querySelector('textarea');
      area.value = '';
      area.disabled = false;
      annotateBar.setAttribute('data-open', 'false');
      annotatePanel.setAttribute('data-open', 'true');
      area.focus();
    });
    document.getElementById('annotateDraft').addEventListener('click', draftAnnotation);
    document.getElementById('annotateSend').addEventListener('click', sendAnnotation);
    // A click elsewhere closes the panel.
    document.addEventListener('mousedown', function (event) {
      if (annotatePanel.getAttribute('data-open') !== 'true') return;
      if (annotatePanel.contains(event.target) || annotateBar.contains(event.target)) return;
      closeAnnotate();
    });
    document.getElementById('annotateClose').addEventListener('click', closeAnnotate);
    // A selection in the preview offers the annotation.
    document.addEventListener('selectionchange', function () {
      var selection = window.getSelection();
      var host = document.querySelector('.file-panel-body');
      if (selection === null || selection.isCollapsed) {
        // The passage is not picked any more: the offer goes with it. The
        // panel stays while the guest writes in it — the writing is worth
        // more than the offer.
        if (annotatePanel.getAttribute('data-open') === 'true' &&
            !annotatePanel.contains(document.activeElement)) {
          closeAnnotate();
          return;
        }
        annotateBar.setAttribute('data-open', 'false');
        return;
      }
      // While the guest is typing in the editor, a selection means nothing:
      // the offer would open over the text they are writing.
      if (collab !== null) return;
      var node = selection.anchorNode;
      if (node === null || host === null || !host.contains(node)) return;
      if (currentFile === null || !isTextual(currentFile)) return;
      openAnnotate(host);
    });
  }

  function openCollaborative(path) {
    var body = document.getElementById('fileBody');
    body.innerHTML = '';
    var wrap = el('div', 'file-editor');
    var area = el('textarea', 'file-editor-area');
    area.spellcheck = false;
    area.value = currentRaw ?? '';
    var cursors = el('div', 'collab-cursors');
    var foot = el('div', 'file-editor-foot');
    foot.appendChild(el('span', null, 'Editing together. The file is written when you stop typing.'));
    wrap.appendChild(area);
    wrap.appendChild(cursors);
    wrap.appendChild(foot);
    body.appendChild(wrap);

    loadYjs().then(function (lib) {
      if (lib === null) {
        foot.textContent = 'The collaborative editor could not be loaded.';
        return;
      }
      var doc = new lib.Y.Doc();
      var text = doc.getText('content');
      var client = Math.floor(Math.random() * 0x7fffffff);
      var awareness = new lib.Awareness(doc);
      collab = { path: path, doc: doc, text: text, client: client, awareness: awareness, area: area, cursors: cursors, applying: false };
      awareness.setLocalStateField('user', { name: guestName || 'guest', color: guestColor(guestId) });
      awareness.on('update', function (changes, origin) {
        if (origin === 'remote') return;
        var update = lib.encodeAwarenessUpdate(awareness, [doc.clientID]);
        collabPost({ action: 'awareness', path: path, update: bytesToBase64(update), client: client });
      });
      doc.on('update', function (update, origin) {
        if (origin === 'remote') return;
        collabPost({ action: 'update', path: path, update: bytesToBase64(update), client: client });
      });
      collabPost({ action: 'open', path: path, client: client }).then(function (answer) {
        if (answer === undefined || answer.ok !== true) return;
        lib.Y.applyUpdate(doc, base64ToBytes(answer.state));
        if (answer.awareness !== undefined && answer.awareness.length > 0) {
          lib.applyAwarenessUpdate(awareness, base64ToBytes(answer.awareness), 'remote');
        }
        area.value = text.toString();
        paintCursors();
      });
      area.addEventListener('input', function () {
        var next = area.value;
        var previous = text.toString();
        var start = 0;
        while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
        var endPrevious = previous.length;
        var endNext = next.length;
        while (endPrevious > start && endNext > start && previous[endPrevious - 1] === next[endNext - 1]) { endPrevious -= 1; endNext -= 1; }
        doc.transact(function () {
          if (endPrevious > start) text.delete(start, endPrevious - start);
          if (endNext > start) text.insert(start, next.slice(start, endNext));
        }, 'local');
      });
      area.addEventListener('keyup', function () { sendCursor(); });
      area.addEventListener('click', function () { sendCursor(); });
      function sendCursor() {
        if (collab === null) return;
        awareness.setLocalStateField('cursor', { anchor: area.selectionStart, head: area.selectionEnd });
      }
      collab.sendCursor = sendCursor;
    });
  }

  function guestColor(id) {
    var sum = 0;
    for (var index = 0; index < String(id).length; index++) sum += String(id).charCodeAt(index);
    return GUEST_COLORS[sum % GUEST_COLORS.length];
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function collabPost(payload) {
    return fetch(base + 'api/collab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (response) { return response.ok ? response.json() : undefined; }).catch(function () { return undefined; });
  }

  // The cursors of the other guests, drawn over the text.
  function paintCursors() {
    if (collab === null) return;
    var lib = window.YShare;
    if (lib === undefined) return;
    var box = collab.cursors;
    box.innerHTML = '';
    var states = collab.awareness.getStates();
    states.forEach(function (state, client) {
      if (client === collab.client) return;
      var cursor = state.cursor;
      var user = state.user;
      if (cursor === undefined || user === undefined) return;
      var place = caretBox(collab.area, Math.min(cursor.head ?? 0, collab.area.value.length));
      var mark = el('span', 'collab-caret');
      mark.style.left = place.left + 'px';
      mark.style.top = place.top + 'px';
      mark.style.background = user.color ?? '#4176e6';
      mark.appendChild(el('span', 'collab-caret-name', user.name ?? 'guest'));
      box.appendChild(mark);
    });
  }

  function paintEditor() {
    var body = document.getElementById('fileBody');
    if (!editing || currentFile === null) return;
    body.innerHTML = '';
    var wrap = el('div', 'file-editor');
    var area = el('textarea', 'file-editor-area');
    area.value = currentRaw ?? '';
    area.spellcheck = false;
    var foot = el('div', 'file-editor-foot');
    foot.appendChild(el('span', null, 'You are editing this file. It is held for you while you do.'));
    var save = el('button', 'file-editor-save', 'Save');
    save.type = 'button';
    foot.appendChild(save);
    wrap.appendChild(area);
    wrap.appendChild(foot);
    body.appendChild(wrap);
    editorText = area.value;
    area.addEventListener('input', function () {
      editorText = area.value;
      save.disabled = area.value === currentRaw;
    });
    save.addEventListener('click', function () {
      save.disabled = true;
      saveFile(area.value);
    });
  }

  function saveFile(text, version) {
    fetch(base + 'api/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: currentFile,
        content: text,
        version: version ?? editVersion,
        guest: guestId,
      }),
    }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data }; });
    }).then(function (answer) {
      var body = document.getElementById('fileBody');
      if (answer.status === 200 && answer.data && answer.data.ok) {
        currentRaw = text;
        editVersion = answer.data.version ?? editVersion;
        currentVersion = editVersion;
        var conflict = body.querySelector('.file-conflict');
        if (conflict !== null) conflict.remove();
        return;
      }
      if (answer.status === 409) {
        // The file moved on: the guest keeps its text and sees what is there.
        var note = el('div', 'file-conflict');
        note.appendChild(el('div', null, answer.data?.error ?? 'The file changed while you were editing it.'));
        var pre = el('pre');
        pre.textContent = String(answer.data?.current ?? '');
        note.appendChild(pre);
        var keep = el('div', 'file-editor-foot');
        keep.appendChild(el('span', null, 'Your text was kept.'));
        var again = el('button', 'file-editor-again', 'Save anyway');
        again.type = 'button';
        again.addEventListener('click', function () {
          again.disabled = true;
          // The guest has seen what the file holds now, and says what it
          // should hold instead: the text that is on the screen.
          saveFile(editorText, answer.data?.version ?? '');
        });
        keep.appendChild(again);
        note.appendChild(keep);
        body.insertBefore(note, body.firstChild);
        return;
      }
      if (answer.status === 423) {
        var locked = el('div', 'file-conflict');
        locked.appendChild(el('div', null, (answer.data?.guest ?? 'Someone') + ' is editing this file.'));
        body.insertBefore(locked, body.firstChild);
        return;
      }
      var failed = el('div', 'file-conflict');
      failed.appendChild(el('div', null, answer.data?.error ?? 'The file could not be written.'));
      body.insertBefore(failed, body.firstChild);
    }).catch(function () {
      var failed = el('div', 'file-conflict');
      failed.appendChild(el('div', null, 'The file could not be written.'));
      document.getElementById('fileBody').insertBefore(failed, document.getElementById('fileBody').firstChild);
    });
  }

  /**
   * Tell the guest that their writing did not reach the file, and give them
   * the one thing that puts it there.
   *
   * @param {string} version the version the file holds now
   */
  function showSaveFailure(version) {
    if (collab === null) return;
    var foot = document.querySelector('.file-editor-foot');
    if (foot === null) return;
    foot.textContent = '';
    var note = el('span', 'file-editor-note', 'Not saved: the file changed while you were editing.');
    foot.appendChild(note);
    var again = el('button', 'file-editor-again', 'Save anyway');
    again.type = 'button';
    again.addEventListener('click', function () {
      again.disabled = true;
      fetch(base + 'api/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: collab.path,
          content: collab.text.toString(),
          version: version,
          guest: guestId,
        }),
      }).then(function (response) { return response.json(); }).then(function (answer) {
        if (answer !== undefined && answer.ok === true) {
          foot.textContent = '';
          foot.appendChild(el('span', null, 'Saved to the file.'));
          return;
        }
        again.disabled = false;
        note.textContent = answer?.error ?? 'The file could not be written.';
      }).catch(function () {
        again.disabled = false;
        note.textContent = 'The host could not be reached.';
      });
    });
    foot.appendChild(again);
  }

  function showFile(path, title, pathLabel, size) {
    currentFile = path;
    currentRaw = null;
    currentView = 'preview';
    currentVersion = '';
    roomPost({ action: 'focus', file: path });
    document.getElementById('fileTitle').textContent = title;
    document.getElementById('filePath').textContent = pathLabel;
    var toggle = document.getElementById('fileToggle');
    toggle.hidden = true;
    var body = document.getElementById('fileBody');
    body.innerHTML = '';
    document.getElementById('filePanel').hidden = false;
    document.body.setAttribute('data-panel', 'open');
    var filesToggle = document.getElementById('filesToggle');
  var fileEdit = document.getElementById('fileEdit');
  if (fileEdit) {
    fileEdit.addEventListener('click', function () {
      if (currentFile === null) return;
      if (editing) {
        setEditing(false);
        paintFile(fileKindOf(currentFile), currentFile);
        return;
      }
      setEditing(true);
      openCollaborative(currentFile);
    });
  }
    if (filesToggle !== null) filesToggle.setAttribute('aria-pressed', 'true');

    var kind = fileKindOf(path);
    if (kind === 'image') {
      var picture = el('img', 'file-image');
      picture.alt = title;
      // The page sits at /s/<id> without a trailing slash, so a relative
      // path would lose the share: the base carries it.
      picture.src = base + 'api/blob?path=' + encodeURIComponent(path);
      body.appendChild(picture);
      if (size.length > 0) body.appendChild(el('div', 'file-note', size));
      return;
    }

    getText('api/file?path=' + encodeURIComponent(path)).then(function (read) {
      currentRaw = read.text;
      currentVersion = read.version;
      editVersion = read.version;
      if (editing) paintEditor();
      else paintFile(kind, path);
    }).catch(function (error) {
      body.textContent = error && error.status === 415
        ? 'This file is not text, so it cannot be previewed here.'
        : 'This file could not be read.';
    });
  }

  function paintFile(kind, path) {
    var body = document.getElementById('fileBody');
    var toggle = document.getElementById('fileToggle');
    var edit = document.getElementById('fileEdit');
    var textual = isTextual(path);
    // The Edit button belongs to a file that may be written as text.
    if (edit !== null) edit.hidden = !textual;
    body.innerHTML = '';
    if (kind === 'markdown' || kind === 'html') {
      toggle.hidden = false;
      toggle.textContent = currentView === 'preview' ? 'Source' : 'Preview';
    } else {
      toggle.hidden = true;
    }
    if (kind === 'markdown') {
      if (currentView === 'source') {
        var pre = el('pre', 'file-code');
        var code = el('code');
        // The highlighter escapes the source before it colours it, so the file
        // can never inject markup into the page.
        code.innerHTML = highlight(currentRaw, languageOf(path));
        pre.appendChild(code);
        body.appendChild(pre);
        return;
      }
      var article = el('article', 'file-markdown');
      article.innerHTML = markdown(currentRaw, {
        resolve: function (source) {
          if (/^(https?:|data:|mailto:|#)/i.test(source)) return source;
          var base = path.indexOf('/') === -1 ? '' : path.slice(0, path.lastIndexOf('/'));
          var joined = base.length === 0 ? source : base + '/' + source;
          var parts = [];
          joined.split('/').forEach(function (part) {
            if (part === '.' || part.length === 0) return;
            if (part === '..') { parts.pop(); return; }
            parts.push(part);
          });
          return base + 'api/blob?path=' + encodeURIComponent(parts.join('/'));
        },
      });
      body.appendChild(article);
      renderDiagrams(article);
      return;
    }
    if (kind === 'html') {
      if (currentView === 'source') {
        var raw = el('pre', 'file-code');
        raw.appendChild(el('code', null, currentRaw));
        body.appendChild(raw);
        return;
      }
      // The document runs in a sandbox of its own: it may run its own scripts
      // and answer a click, but it has no same origin, so it cannot reach the
      // guest's session, its storage or the page around it.
      var frame = el('iframe', 'file-frame');
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = currentRaw;
      body.appendChild(frame);
      return;
    }
    var pre = el('pre', 'file-code');
    var code = el('code');
    code.innerHTML = highlight(currentRaw, languageOf(path));
    pre.appendChild(code);
    body.appendChild(pre);
  }

  function openFile(path) {
    var name = path.split('/').pop() || path;
    showFile(path, name, path, '');
  }

  var close = document.getElementById('fileClose');
  var filesToggle = document.getElementById('filesToggle');
  var panelHidden = function () { document.getElementById('filePanel').hidden = true; document.body.removeAttribute('data-panel'); };
  if (close) {
    close.addEventListener('click', panelHidden);
  }
  // The header opens the panel again, with the file that was open in it.
  if (filesToggle) {
    filesToggle.addEventListener('click', function () {
      var panel = document.getElementById('filePanel');
      if (panel.hidden === false) {
        panelHidden();
        filesToggle.setAttribute('aria-pressed', 'false');
        return;
      }
      if (currentFile !== null) {
        panel.hidden = false;
        document.body.setAttribute('data-panel', 'open');
        filesToggle.setAttribute('aria-pressed', 'true');
        return;
      }
      filesToggle.setAttribute('aria-pressed', 'true');
      var first = document.querySelector('.tree-row[data-kind="file"]');
      if (first !== null) first.click();
      else {
        filesToggle.setAttribute('aria-pressed', 'false');
        panelHidden();
      }
    });
  }

  // The room: who else is in this conversation, what they have open and
  // what changed under them.
  var guestId = window.localStorage.getItem('dsh-share-guest-id')
  if (guestId === null || guestId.length === 0) {
    guestId = 'g' + Math.random().toString(36).slice(2, 10)
    window.localStorage.setItem('dsh-share-guest-id', guestId)
  }
  var guestName = window.localStorage.getItem('dsh-share-guest-name') || ''
  var roomGuests = [];
  var roomLocks = [];

  function roomPost(payload) {
    return fetch(base + 'api/room', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ id: guestId, name: guestName }, payload)),
    }).then(function (response) { return response.ok ? response.json() : undefined; }).catch(function () { return undefined; });
  }

  // The name of the guest. The owner of the conversation sees who is in the
  // room, and a name is what tells one guest from another: an id cannot.
  var nameInput = document.getElementById('whoamiInput');
  var nameDot = document.getElementById('whoamiDot');
  if (nameDot !== null) nameDot.style.background = guestColor(guestId);
  if (nameInput !== null) {
    nameInput.value = guestName;
    var sayName = function () {
      guestName = nameInput.value.trim().slice(0, 24);
      window.localStorage.setItem('dsh-share-guest-name', guestName);
      // The room learns the name at once: the owner sees the new one.
      roomPost({ action: 'hello' }).then(function (view) { applyPresence(view); });
    };
    nameInput.addEventListener('change', sayName);
    nameInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      sayName();
      nameInput.blur();
    });
  }

  // The id of the message this guest sent last: the Host answers with it, and
  // the bar needs it to tell the guest which message is their own.
  var myMessageId = '';

  // The sender of a message in the queue: the guest that wrote it, or the
  // guest that reads this page, when the message is its own. The name alone
  // does not tell the two apart - two guests may carry the same name.
  function queueSender(item) {
    if (item === null || item === undefined) return '';
    var id = item.id === undefined || item.id === null ? '' : String(item.id);
    if (id !== '' && id === myMessageId) return 'yours';
    return String(item.from ?? '').trim();
  }

  // The queue of the conversation: what the agent works on now, and what waits
  // behind it. Every guest of the share is told the same queue, so the bar
  // reads the same way for everyone who looks at it.
  function paintQueue(frame) {
    var box = document.getElementById('queue');
    if (box === null) return;
    var working = frame?.working ?? null;
    var waiting = Array.isArray(frame?.waiting) ? frame.waiting : [];
    if (working === null && waiting.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    var head = box.querySelector('.queue-working');
    var rest = box.querySelector('.queue-waiting');
    if (working !== null) {
      head.innerHTML = '';
      head.removeAttribute('data-mine');
      head.appendChild(el('span', 'queue-text', 'Working on: ' + String(working.text ?? '')));
      var sender = queueSender(working);
      if (sender === 'yours') head.setAttribute('data-mine', 'true');
      if (sender !== '') head.appendChild(el('span', 'queue-name', ' — ' + sender));
    } else {
      // Nothing is worked on, but messages wait: the agent is about to take
      // one of them.
      head.textContent = 'Waiting for the agent.';
    }
    rest.innerHTML = '';
    waiting.forEach(function (entry) {
      var item = el('li', 'queue-item');
      var name = queueSender(entry);
      if (name === 'yours') item.setAttribute('data-mine', 'true');
      item.appendChild(el('span', 'queue-name', (name === '' ? 'a guest' : name) + ': '));
      item.appendChild(el('span', 'queue-text', String(entry?.text ?? '')));
      rest.appendChild(item);
    });
  }

  function paintPresence() {
    var box = document.getElementById('presence');
    if (box === null) return;
    var others = roomGuests.filter(function (guest) { return guest.id !== guestId; });
    if (others.length === 0) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('div', 'presence-head', others.length === 1 ? '1 other guest' : others.length + ' other guests'));
    others.forEach(function (guest) {
      var row = el('div', 'presence-guest');
      row.setAttribute('data-editing', guest.editing === true ? 'true' : 'false');
      row.setAttribute('data-typing', guest.typing === true ? 'true' : 'false');
      if (guest.typing === true) {
        // The sign of a guest that is writing: three dots that travel.
        var dots = el('span', 'presence-dots');
        dots.appendChild(el('i'));
        dots.appendChild(el('i'));
        dots.appendChild(el('i'));
        row.appendChild(dots);
      }
      var dot = el('span', 'presence-dot');
      // The Host carries the colour of the guest, so the owner of the
      // conversation sees the same face as the other guests do.
      dot.style.background = guest.color || guestColor(guest.id);
      row.appendChild(dot);
      row.appendChild(el('span', null, guest.name));
      if (guest.typing === true) row.appendChild(el('span', 'presence-typing', 'is typing'));
      if (guest.file) {
        var file = el('span', 'presence-file', (guest.editing === true ? 'editing ' : 'viewing ') + guest.file);
        row.appendChild(file);
      }
      box.appendChild(row);
    });
    roomLocks.forEach(function (lock) {
      // A guest does not need to be told that it holds the file itself.
      if (lock.path === currentFile && lock.guest !== guestId) {
        var holder = roomGuests.find(function (guest) { return guest.id === lock.guest; });
        var note = el('div', 'presence-guest presence-locked', (holder === undefined ? 'someone' : holder.name) + ' is editing this file');
        box.appendChild(note);
      }
    });
  }

  function applyPresence(frame) {
    if (frame === undefined || frame === null) return;
    roomGuests = frame.guests ?? [];
    roomLocks = frame.locks ?? [];
    paintPresence();
  }

  // The visitor chooses the theme: the page follows their system until they
  // say otherwise, and the choice stays where they left it.
  var themeToggle = document.getElementById('themeToggle');
  var THEME_KEY = 'dsh-share-theme';
  var isDark = function () {
    var chosen = document.documentElement.getAttribute('data-theme');
    if (chosen === 'dark') return true;
    if (chosen === 'light') return false;
    return window.matchMedia !== undefined && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  var paintTheme = function () {
    var dark = isDark();
    var button = document.getElementById('themeToggle');
    if (button !== null) {
      button.setAttribute('aria-label', dark ? 'Use the light theme' : 'Use the dark theme');
      button.setAttribute('title', dark ? 'Use the light theme' : 'Use the dark theme');
    }
  };
  var savedTheme = window.localStorage.getItem(THEME_KEY);
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);
  paintTheme();
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch (error) { /* the browser may refuse */ }
      paintTheme();
      // A diagram wears the theme it was drawn in, so it is drawn again.
      if (currentFile !== null && currentRaw !== null) paintFile(fileKindOf(currentFile), currentFile);
    });
  }

  // The panel takes the whole page and gives it back.
  var fileMax = document.getElementById('fileMax');
  if (fileMax) {
    fileMax.addEventListener('click', function () {
      var maximized = document.body.getAttribute('data-panel') === 'max';
      if (maximized) {
        document.body.setAttribute('data-panel', 'open');
        fileMax.setAttribute('aria-label', 'Take the whole page');
        fileMax.setAttribute('title', 'Take the whole page');
        return;
      }
      document.body.setAttribute('data-panel', 'max');
      fileMax.setAttribute('aria-label', 'Give the page back');
      fileMax.setAttribute('title', 'Give the page back');
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (document.body.getAttribute('data-panel') !== 'max') return;
    document.body.setAttribute('data-panel', 'open');
    if (fileMax !== null) {
      fileMax.setAttribute('aria-label', 'Take the whole page');
      fileMax.setAttribute('title', 'Take the whole page');
    }
  });

  // The files column folds away and opens again, and it keeps a width of its
  // own: the guest drags its edge and the width stays where they left it.
  var sideToggle = document.getElementById('sideToggle');
  var sideHandle = document.getElementById('sideHandle');
  var SIDE_WIDTH_KEY = 'dsh-share-side-width';
  var sideWidth = function () {
    var value = Number(window.localStorage.getItem(SIDE_WIDTH_KEY));
    if (!Number.isFinite(value) || value < 200) return 268;
    return Math.min(value, Math.round(window.innerWidth * 0.5));
  };
  var setSideWidth = function (width) {
    var clamped = Math.max(200, Math.min(Math.round(width), Math.round(window.innerWidth * 0.5)));
    document.body.style.setProperty('--side-width', clamped + 'px');
    try { window.localStorage.setItem(SIDE_WIDTH_KEY, String(clamped)); } catch (error) { /* the browser may refuse */ }
  };
  if (sideHandle) {
    setSideWidth(sideWidth());
    sideHandle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      var startX = event.clientX;
      var startWidth = document.querySelector('.side').getBoundingClientRect().width;
      var move = function (moveEvent) { setSideWidth(startWidth + (moveEvent.clientX - startX)); };
      var stop = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    sideHandle.addEventListener('keydown', function (event) {
      var step = event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0;
      if (step === 0) return;
      event.preventDefault();
      setSideWidth(document.querySelector('.side').getBoundingClientRect().width + step);
    });
  }
  if (sideToggle) {
    // The files are folded away on a phone until the guest asks for them.
    var narrow = window.matchMedia !== undefined && window.matchMedia('(max-width: 900px)').matches;
    var saved = window.localStorage.getItem('dsh-share-side');
    var state = saved === 'collapsed' || saved === 'open' ? saved : (narrow ? 'collapsed' : 'open');
    document.body.setAttribute('data-side', state);
    var label = function () {
      var open = document.body.getAttribute('data-side') === 'open';
      var text = open ? 'Fold the files away' : 'Open the files';
      sideToggle.setAttribute('aria-label', text);
      sideToggle.setAttribute('title', text);
    };
    label();
    sideToggle.addEventListener('click', function () {
      var open = document.body.getAttribute('data-side') === 'open';
      var next = open ? 'collapsed' : 'open';
      document.body.setAttribute('data-side', next);
      label();
      try { window.localStorage.setItem('dsh-share-side', next); } catch (error) { /* the browser may refuse */ }
    });
  }

  // The panel is the guest's own width: they drag its edge and the width
  // stays where they left it.
  var panel = document.getElementById('filePanel');
  var handle = document.getElementById('fileHandle');
  var PANEL_WIDTH_KEY = 'dsh-share-panel-width';
  function panelWidth() {
    var value = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (!Number.isFinite(value) || value < 280) return 520;
    return Math.min(value, Math.round(window.innerWidth * 0.85));
  }
  function setPanelWidth(width) {
    var clamped = Math.max(280, Math.min(Math.round(width), Math.round(window.innerWidth * 0.85)));
    document.body.style.setProperty('--file-panel-width', clamped + 'px');
    try { window.localStorage.setItem(PANEL_WIDTH_KEY, String(clamped)); } catch (error) { /* the browser may refuse */ }
  }
  if (panel && handle) {
    setPanelWidth(panelWidth());
    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      panel.setAttribute('data-resizing', 'true');
      var startX = event.clientX;
      var startWidth = panel.getBoundingClientRect().width;
      var move = function (moveEvent) { setPanelWidth(startWidth + (startX - moveEvent.clientX)); };
      var stop = function () {
        panel.removeAttribute('data-resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    handle.addEventListener('keydown', function (event) {
      var step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
      if (step === 0) return;
      event.preventDefault();
      setPanelWidth(panel.getBoundingClientRect().width + step);
    });
  }

  // A link in a message that names a file opens it in the panel.
  view.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href^="#file="]');
    if (link === null || link === undefined) return;
    event.preventDefault();
    var path = decodeURIComponent(link.getAttribute('href').slice('#file='.length));
    openFile(path);
  });
  var toggle = document.getElementById('fileToggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      if (currentFile === null) return;
      currentView = currentView === 'preview' ? 'source' : 'preview';
      paintFile(fileKindOf(currentFile), currentFile);
    });
  }

  document.querySelectorAll('.tab').forEach(function (button) {
    button.addEventListener('click', function () {
      tab = button.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (other) {
        other.setAttribute('aria-selected', other === button ? 'true' : 'false');
      });
      renderTab();
    });
  });

  var form = document.getElementById('composer');
  if (form) {
    var input = document.getElementById('composerInput');
    var send = document.getElementById('composerSend');
    // The uploads that wait to go with the message.
    var pending = [];
    var pendingBox = document.getElementById('composerPending');
    var picker = document.getElementById('composerAttach');
    var fileInput = document.getElementById('composerFile');

    var paintPending = function () {
      if (pendingBox === null) return;
      pendingBox.innerHTML = '';
      pendingBox.hidden = pending.length === 0;
      pending.forEach(function (item) {
        var chip = el('span', 'composer-pending-item', item.name);
        pendingBox.appendChild(chip);
      });
    };

    // The guest says that it is writing, so the owner of the conversation sees
    // that the words are on their way before they arrive.
    var writing = false;
    var writingBeat = null;
    var setWriting = function (on) {
      if (on === writing) return;
      writing = on;
      roomPost({ action: 'typing', typing: on });
      if (writingBeat !== null) {
        window.clearInterval(writingBeat);
        writingBeat = null;
      }
      if (!on) return;
      // The words of a guest expire on their own, so a guest that writes for
      // a while says again that it is writing.
      writingBeat = window.setInterval(function () {
        roomPost({ action: 'typing', typing: true });
      }, 2500);
    };

    var upload = function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var data = String(reader.result ?? '');
        var comma = data.indexOf(',');
        if (comma >= 0) data = data.slice(comma + 1);
        pending.push({ name: file.name, mediaType: file.type, data: data });
        paintPending();
      };
      reader.readAsDataURL(file);
    };

    if (picker !== null && fileInput !== null) {
      picker.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var files = fileInput.files ?? [];
        for (var index = 0; index < files.length; index++) upload(files[index]);
        fileInput.value = '';
      });
    }
    // The input grows with the text, the way the app's own does.
    var grow = function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 220) + 'px';
    };
    var ready = function () { send.disabled = input.value.trim().length === 0; };
    input.addEventListener('input', function () {
      grow();
      ready();
      // The guest writes: the owner of the conversation sees that the words
      // are on their way, and stops seeing it when the guest stops.
      setWriting(input.value.trim().length > 0);
    });
    input.addEventListener('blur', function () { setWriting(false); });
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      form.requestSubmit();
    });
    grow();
    ready();
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (text.length === 0 && pending.length === 0) return;
      send.disabled = true;
      // The words are on their way: the guest is not writing any more.
      setWriting(false);
      // The guest says who it is: the Host tells every guest of the share who
      // wrote what, so a message in the queue carries its sender.
      var payload = { text: text, guest: guestId, from: guestName };
      if (pending.length > 0) payload.upload = pending[0];
      fetch(base + 'api/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (response) {
          if (!response.ok) throw new Error('refused');
          return response.json().catch(function () { return undefined; });
        })
        .then(function (answer) {
          // The Host answers with the id the message has in the queue: the bar
          // needs it to tell the guest which message is their own.
          if (answer !== undefined && answer !== null && answer.id !== undefined && answer.id !== null) {
            myMessageId = String(answer.id);
          }
          input.value = '';
          pending = [];
          paintPending();
          grow();
        })
        .catch(function () { input.value = text; })
        .then(function () { ready(); });
    });
  }

  // The guest is in the room from the first moment, and it says so now and
  // then: a guest that stops saying anything is forgotten, and what it held
  // is free again.
  roomPost({ action: 'hello' }).then(function (view) { applyPresence(view); });
  window.setInterval(function () {
    roomPost({ action: 'focus', file: currentFile ?? '' });
  }, 30_000);
  window.addEventListener('beforeunload', function () {
    roomPost({ action: 'leave', file: currentFile ?? '' });
  });

  get('api/state').then(function (state) {
    messages = (state && state.messages) || [];
    renderTab();
  }).catch(function () { renderTab(); });

  loadTree('', tree);

  try {
    var stream = new EventSource(base + 'api/stream');
    stream.addEventListener('message', function (event) {
      var payload = JSON.parse(event.data);
      if (payload.kind === 'snapshot') { messages = payload.messages || []; if (tab === 'chat') renderChat(); return; }
      if (payload.kind === 'message') {
        messages.push(payload.message);
        if (tab === 'chat') {
          // A message that arrives while the guest reads is counted, and the
          // conversation stays where the guest left it.
          if (atBottom()) newMessages = 0;
          else newMessages += 1;
          renderChat();
        }
        return;
      }
      if (payload.kind === 'shortened') {
        // The Host recorded the message shorter than it was sent: the guest
        // is told, so nobody wonders where the rest of the words went.
        var box = document.getElementById('shortened');
        if (box !== null) {
          box.hidden = false;
          box.textContent = 'The host recorded your message shorter than you sent it: "' + String(payload.recorded ?? '') + '". Please say it again.';
        }
        return;
      }
      if (payload.kind === 'queue') {
        // The queue of the conversation: what is worked on now, and what
        // waits behind it. The Host keeps the queue and tells it to every
        // guest of the share, so everybody sees the same thing.
        paintQueue(payload);
        return;
      }
      if (payload.kind === 'presence') {
        applyPresence(payload);
        return;
      }
      if (payload.kind === 'collab') {
        // A change of another guest reaches the document.
        if (collab !== null && payload.path === collab.path && window.YShare !== undefined) {
          window.YShare.Y.applyUpdate(collab.doc, base64ToBytes(payload.update), 'remote');
          var after = collab.text.toString();
          if (collab.area.value !== after) {
            var at = collab.area.selectionStart;
            collab.area.value = after;
            collab.area.setSelectionRange(Math.min(at, after.length), Math.min(at, after.length));
          }
          paintCursors();
        }
        return;
      }
      if (payload.kind === 'awareness') {
        if (collab !== null && payload.path === collab.path && window.YShare !== undefined) {
          if (payload.update !== undefined && payload.update.length > 0) {
            window.YShare.applyAwarenessUpdate(collab.awareness, base64ToBytes(payload.update), 'remote');
          }
          paintCursors();
        }
        return;
      }
      if (payload.kind === 'collab-saved') {
        // The document reached the file.
        if (collab !== null && payload.path === collab.path) {
          var note = document.querySelector('.file-editor-foot span');
          if (note !== null) note.textContent = 'Saved to the file (' + (payload.length ?? 0) + ' characters).';
        }
        return;
      }
      if (payload.kind === 'collab-save-failed') {
        // The file moved on while the guest was writing. What they wrote is
        // still on their screen, and they are told that it did not reach the
        // file.
        if (collab !== null && payload.path === collab.path) {
          showSaveFailure(payload.version ?? '');
        }
        return;
      }
      if (payload.kind === 'collab-reset') {
        // The agent rewrote the file: the document starts again.
        if (collab !== null && payload.path === collab.path) {
          getText('api/file?path=' + encodeURIComponent(collab.path)).then(function (read) {
            currentRaw = read.text;
            if (collab !== null && window.YShare !== undefined) {
              window.YShare.Y.transact(function () {
                collab.text.delete(0, collab.text.length);
                collab.text.insert(0, read.text);
              }, 'remote');
              collab.area.value = read.text;
              paintCursors();
            }
          }).catch(function () { /* the file may be gone */ });
        }
        return;
      }
      if (payload.kind === 'file') {
        // A file changed under the guest: the one they have open is read
        // again, so nobody works on a text that is no longer there.
        if (payload.path === currentFile && !editing) {
          var kind = fileKindOf(currentFile);
          getText('api/file?path=' + encodeURIComponent(currentFile)).then(function (read) {
            currentRaw = read.text;
            currentVersion = read.version;
            editVersion = read.version;
            paintFile(kind, currentFile);
          }).catch(function () { /* the file may be gone */ });
        }
        return;
      }
    });
  } catch (error) { /* the page still shows the last known state */ }
})();`
}
