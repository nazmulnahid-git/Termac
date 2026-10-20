// Pointer-driven drag for the sidebar, modelled on Arc: the item lifts off and follows the
// cursor, its neighbours slide apart to open a gap where it will land, and on release it
// settles into that gap. Drop targets are plain DOM attributes so the expanded sidebar and
// the compact rail share one engine:
//   data-drag-tid      a session row/tile (also a hit target inside its list)
//   data-drop-list     JSON dest of a list of sessions; data-axis="x" for grids
//   data-drop-into     JSON dest (optional index) for headers and empty zones
//   data-spring        folder id to spring open after hovering it for a moment
//   data-drop-space    a Space dot: hover switches Space, drop moves the session there
//   data-folder-head   a folder header, for reordering folders
//   data-drop-ph       the gap itself (hovering it holds the current target)
import { flushSync } from 'react-dom';
import { app, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import * as L from '../lib/layout.js';

export const PH = '\u0000ph';
const THRESHOLD = 4;
const SPRING_MS = 550;
const MERGE_MS = 420; // hover the middle of a row this long to merge into a split
const SETTLE_MS = 170;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const FLIP_SEL = '.sidebar :is(.row, .fav, .folder, .sec-title, .today-head, .pin-empty, .folder-empty, .rail-tile, .rail-btn, .rail-space, .rail-sep):not(.space-ghost *)';

let drag = null;

export const pressTab = (e, tid) => press(e, { kind: 'tab', tabId: tid });
// ⌥-drag one segment of a split row to pull that pane out into its own row.
export const pressPane = (e, tid, sid) => press(e, { kind: 'pane', tabId: tid, sid }, true);
export const pressFolder = (e, spaceId, folderId) => press(e, { kind: 'folder', spaceId, folderId });

function press(e, item, altOk = false) {
  if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || (e.altKey && !altOk) || drag) return;
  const ctl = e.target.closest('button, input');
  if (ctl && ctl !== e.currentTarget) return;
  const el = e.currentTarget;
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    // Chromium sends button-less "fake" moves after layout changes; they aren't the drag.
    if (!(ev.buttons & 1)) return;
    if (!drag) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
      begin(el, item, sx, sy, ev.pointerId);
    }
    if (!drag.settling) update(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    off();
    if (drag && !drag.settling) finish(ev.type === 'pointercancel');
  };
  const key = (ev) => {
    if (ev.key !== 'Escape' || !drag || drag.settling) return;
    ev.preventDefault();
    ev.stopPropagation();
    off();
    finish(true);
  };
  const blur = () => {
    off();
    if (drag && !drag.settling) finish(true);
  };
  const off = () => {
    document.documentElement.removeEventListener('lostpointercapture', up);
    window.removeEventListener('blur', blur);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('keydown', key, true);
  };
  // Once the drag starts the root captures the pointer (see begin), so a release outside the
  // window still arrives; losing capture without a pointerup ends the drag the same way.
  document.documentElement.addEventListener('lostpointercapture', up);
  window.addEventListener('blur', blur);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('keydown', key, true);
}

function begin(el, item, sx, sy, pointerId) {
  try {
    document.documentElement.setPointerCapture(pointerId);
  } catch {
    /* pointer already gone; pointerup will still end the drag */
  }
  const r = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.removeAttribute('title');
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
  document.body.appendChild(ghost);
  requestAnimationFrame(() => ghost.classList.add('lifted'));
  document.documentElement.classList.add('is-dragging');

  const s = app.get();
  let origin = null;
  if (item.kind === 'tab') {
    const loc = A.locate(item.tabId, s);
    if (loc) origin = { kind: 'list', ...loc, index: listIds(loc, s).indexOf(item.tabId) };
  } else if (item.kind === 'folder') {
    origin = s.spaces.find((x) => x.id === item.spaceId)?.folders.findIndex((f) => f.id === item.folderId) ?? 0;
  }
  drag = { item, ghost, dx: sx - r.left, dy: sy - r.top, target: null, spring: null, springKey: null, mergeTimer: null };
  flip(() => ui.set((u) => ({ ...u, dragging: { ...item, origin, target: null }, peek: null })));
}

function update(x, y) {
  drag.ghost.style.left = `${x - drag.dx}px`;
  drag.ghost.style.top = `${y - drag.dy}px`;
  const t = drag.item.kind === 'folder' ? hitFolder(x, y) : hitTab(x, y);
  drag.ghost.classList.toggle('over-card', t?.kind === 'card');
  drag.ghost.classList.toggle('over-merge', t?.kind === 'arming' || t?.kind === 'merge');
  armSpring(t);
  setTarget(t);
}

function setTarget(t) {
  if (sameTarget(t, drag.target)) return;
  drag.target = t;
  // Arming a merge starts the dwell; anything else cancels it.
  clearTimeout(drag.mergeTimer);
  if (t?.kind === 'arming')
    drag.mergeTimer = setTimeout(() => {
      if (drag && !drag.settling && drag.target === t) setTarget({ ...t, kind: 'merge' });
    }, MERGE_MS);
  flip(() => ui.set((u) => (u.dragging ? { ...u, dragging: { ...u.dragging, target: t } } : u)));
}

// While a merge is armed the gap stays wherever it was, so the list doesn't shift under the pointer.
const holdOf = (t) => (t?.kind === 'list' ? t : t?.kind === 'arming' || t?.kind === 'merge' ? t.hold : null);

function hitTab(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const tid = drag.item.tabId;
  const pane = drag.item.kind === 'pane';
  // Rows still shown during the drag: a pulled-out pane leaves its split row in place.
  const visible = (ids) => (pane ? ids : ids.filter((x) => x !== tid));
  if (!el.closest('.sidebar')) {
    const card = el.closest('.card');
    if (pane || !card || !canMerge(tid)) return null;
    const r = card.getBoundingClientRect();
    const d = { left: x - r.left, right: r.right - x, top: y - r.top, bottom: r.bottom - y };
    return { kind: 'card', edge: Object.entries(d).sort((a, b) => a[1] - b[1])[0][0] };
  }
  if (el.closest('[data-drop-ph]')) return drag.target;
  const dot = el.closest('[data-drop-space]');
  if (dot) return pane ? drag.target : { kind: 'space', spaceId: dot.dataset.dropSpace };
  const item = el.closest('[data-drag-tid]');
  const list = item?.closest('[data-drop-list]');
  if (item && list) {
    const over = item.dataset.dragTid;
    if (over === tid) return drag.target;
    const dest = JSON.parse(list.dataset.dropList);
    const ids = visible(listIds(dest));
    const r = item.getBoundingClientRect();
    const rel = (y - r.top) / r.height;
    // The middle of another row (in a vertical list) merges the two into one split session.
    if (!pane && list.dataset.axis !== 'x' && rel > 0.28 && rel < 0.72 && canMergeTabs(tid, over)) {
      if ((drag.target?.kind === 'arming' || drag.target?.kind === 'merge') && drag.target.tid === over) return drag.target;
      return { kind: 'arming', tid: over, hold: holdOf(drag.target) };
    }
    const after = list.dataset.axis === 'x' ? x > r.left + r.width / 2 : rel > 0.5;
    return { kind: 'list', ...dest, index: ids.indexOf(over) + (after ? 1 : 0) };
  }
  const into = el.closest('[data-drop-into]');
  if (into) {
    const { index, ...dest } = JSON.parse(into.dataset.dropInto);
    if (pane && dest.section === 'fav') return drag.target;
    return { kind: 'list', ...dest, index: index ?? visible(listIds(dest)).length, spring: into.dataset.spring || null };
  }
  const bare = el.closest('[data-drop-list]');
  if (bare) {
    const dest = JSON.parse(bare.dataset.dropList);
    if (drag.target?.kind === 'list' && sameList(drag.target, dest)) return drag.target;
    if (pane && dest.section === 'fav') return drag.target;
    return { kind: 'list', ...dest, index: visible(listIds(dest)).length };
  }
  // Gaps between sections: keep whatever we had rather than flicker back to the origin.
  return drag.target;
}

function hitFolder(x, y) {
  const el = document.elementFromPoint(x, y);
  const sb = el?.closest('.sidebar');
  if (!sb) return null;
  const heads = [...sb.querySelectorAll('[data-folder-head]')].filter((h) => h.dataset.folderHead !== drag.item.folderId);
  const index = heads.filter((h) => {
    const r = h.getBoundingClientRect();
    return r.top + r.height / 2 < y;
  }).length;
  return { kind: 'folders', index };
}

// Hovering a closed folder opens it; hovering a Space dot switches to that Space.
function armSpring(t) {
  const key = t?.kind === 'space' ? `space:${t.spaceId}` : t?.spring ? `folder:${t.spring}` : null;
  if (key === drag.springKey) return;
  clearTimeout(drag.spring);
  drag.springKey = key;
  if (!key) return;
  drag.spring = setTimeout(() => {
    if (!drag || drag.springKey !== key) return;
    if (t.kind === 'space') {
      if (app.get().activeSpaceId !== t.spaceId) flip(() => A.switchSpace(t.spaceId));
    } else flip(() => A.updateFolder(t.spaceId, t.spring, { open: true }));
  }, SPRING_MS);
}

function finish(cancel) {
  const { item, ghost } = drag;
  const t = cancel ? null : drag.target?.kind === 'arming' ? holdOf(drag.target) : drag.target;
  clearTimeout(drag.spring);
  clearTimeout(drag.mergeTimer);
  drag.settling = true;
  swallowClick();

  const commit = () => {
    ghost.remove();
    document.documentElement.classList.remove('is-dragging');
    drag = null;
    flip(() => {
      if (item.kind === 'pane') {
        if (t?.kind === 'list') A.unsplit(item.sid, { section: t.section, spaceId: t.spaceId, folderId: t.folderId || null, index: t.index });
      } else if (item.kind === 'tab') {
        if (t?.kind === 'merge') A.mergeTabs(item.tabId, t.tid);
        else if (t?.kind === 'card') A.mergeIntoActive(item.tabId, t.edge);
        else if (t?.kind === 'list') A.moveTab(item.tabId, t);
        else if (t?.kind === 'space') {
          const loc = A.locate(item.tabId);
          A.moveTab(item.tabId, { section: loc?.section === 'pinned' ? 'pinned' : 'today', spaceId: t.spaceId });
        }
      } else if (t?.kind === 'folders') A.moveFolder(item.spaceId, item.folderId, t.index);
      ui.set((u) => ({ ...u, dragging: null }));
    });
  };

  // A merge lands on the target row: shrink into it.
  if (t?.kind === 'merge') {
    const row = document.querySelector(`.sidebar [data-drag-tid="${CSS.escape(t.tid)}"]`)?.getBoundingClientRect();
    ghost.style.transition = `left ${SETTLE_MS}ms ${EASE}, top ${SETTLE_MS}ms ${EASE}, transform ${SETTLE_MS}ms ${EASE}, opacity ${SETTLE_MS}ms`;
    ghost.classList.remove('lifted');
    ghost.classList.add('dropped');
    if (row) Object.assign(ghost.style, { left: `${row.left}px`, top: `${row.top}px` });
    return setTimeout(commit, SETTLE_MS);
  }
  // Card and Space drops have no gap to land in: just let the ghost fade where it is.
  const ph = t?.kind === 'card' || t?.kind === 'space' ? null : document.querySelector('[data-drop-ph]');
  if (!ph) {
    ghost.classList.add('dropped');
    return setTimeout(commit, 120);
  }
  // A gap inside a closed folder isn't visible; fly into the folder header and fade instead.
  const shut = ph.closest('.folder-wrap:has(> .folder-body:not(.open))')?.querySelector('.folder');
  const r = (shut || ph).getBoundingClientRect();
  ghost.style.transition = `left ${SETTLE_MS}ms ${EASE}, top ${SETTLE_MS}ms ${EASE}, transform ${SETTLE_MS}ms ${EASE}, box-shadow ${SETTLE_MS}ms, opacity ${SETTLE_MS}ms`;
  ghost.classList.remove('lifted', 'over-card');
  if (shut) ghost.classList.add('dropped');
  Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px` });
  setTimeout(commit, SETTLE_MS);
}

// The pointerup that ends a drag would otherwise land as a click on whatever is underneath.
function swallowClick() {
  const stop = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, true);
  setTimeout(() => window.removeEventListener('click', stop, true), 0);
}

function canMergeTabs(src, target) {
  const s = app.get();
  const a = s.tabs[src];
  const b = s.tabs[target];
  return !!(a && b && L.leaves(a.layout).length + L.leaves(b.layout).length <= L.MAX_PANES);
}

function canMerge(tid) {
  const s = app.get();
  const target = A.activeTab(s);
  const src = s.tabs[tid];
  return !!(target && src && target.id !== tid && L.leaves(target.layout).length + L.leaves(src.layout).length <= L.MAX_PANES);
}

export function listIds(dest, s = app.get()) {
  if (dest.section === 'fav') return s.favorites;
  const sp = s.spaces.find((x) => x.id === dest.spaceId);
  if (!sp) return [];
  if (dest.folderId) return sp.folders.find((f) => f.id === dest.folderId)?.tabs || [];
  return dest.section === 'pinned' ? sp.pinned : sp.today;
}

const sameList = (a, b) => a.section === b.section && (a.section === 'fav' || ((a.spaceId || null) === (b.spaceId || null) && (a.folderId || null) === (b.folderId || null)));

function sameTarget(a, b) {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'card') return a.edge === b.edge;
  if (a.kind === 'space') return a.spaceId === b.spaceId;
  if (a.kind === 'arming' || a.kind === 'merge') return a.tid === b.tid;
  if (a.kind === 'folders') return a.index === b.index;
  return sameList(a, b) && a.index === b.index;
}

// FLIP: measure, apply the state change synchronously, then slide everything that moved
// from where it was to where it is now.
const settleTimers = new WeakMap();
export function flip(fn) {
  const before = new Map([...document.querySelectorAll(FLIP_SEL)].map((el) => [el, el.getBoundingClientRect()]));
  flushSync(fn);
  const moved = [];
  for (const el of document.querySelectorAll(FLIP_SEL)) {
    const b = before.get(el);
    if (!b) continue;
    el.style.transition = 'none';
    el.style.transform = '';
    const a = el.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      if (!settleTimers.has(el)) el.style.transition = '';
      continue;
    }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return;
  document.body.offsetWidth; // commit the inverted positions before animating back
  for (const el of moved) {
    el.style.transition = `transform 0.22s ${EASE}`;
    el.style.transform = '';
    clearTimeout(settleTimers.get(el));
    settleTimers.set(
      el,
      setTimeout(() => {
        el.style.transition = '';
        settleTimers.delete(el);
      }, 240)
    );
  }
}

// ---- Hooks for rendering the gap ------------------------------------------------------
// A list of tab ids as it should render right now: the dragged one lifted out, PH where it would land.
export function useDropList(list, dest) {
  const d = ui.use((s) => s.dragging);
  if (d?.kind !== 'tab' && d?.kind !== 'pane') return list;
  const pane = d.kind === 'pane';
  const ids = pane ? [...list] : list.filter((x) => x !== d.tabId);
  const t = holdOf(d.target) || (pane ? null : d.origin);
  if (t && sameList(t, dest)) ids.splice(Math.max(0, Math.min(t.index, ids.length)), 0, PH);
  return ids;
}

export function useDropFolders(space) {
  const d = ui.use((s) => s.dragging);
  if (d?.kind !== 'folder' || d.spaceId !== space.id) return space.folders;
  const list = space.folders.filter((f) => f.id !== d.folderId);
  const i = d.target?.kind === 'folders' ? d.target.index : d.origin;
  list.splice(Math.max(0, Math.min(i, list.length)), 0, PH);
  return list;
}

export const destAttr = (section, spaceId = null, folderId = null, index) => JSON.stringify(index == null ? { section, spaceId, folderId } : { section, spaceId, folderId, index });
