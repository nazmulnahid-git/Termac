// Everything that changes sessions, tabs and Spaces goes through here.
import { app, rt, ui, patchRt, migrate, newSpace, DEFAULT_SETTINGS } from './model.js';
import * as reg from '../term/registry.js';
import * as L from '../lib/layout.js';
import { sshTarget, expandHome, isRiskyCommand } from '../lib/routing.js';
import { uid, formatDuration, leafOf, sessionName, SPACE_COLORS, SPACE_GLYPHS } from '../lib/meta.js';
import { buildKeymap, ACTIONS } from '../lib/keys.js';
import { parseSettingsFile, settingsToFile, settingsSchema } from '../lib/settingsfile.js';
import { applyFontVars } from '../lib/fonts.js';

const api = window.termac;
const home = () => ui.get().home;

// ---- Persistence --------------------------------------------------------------------
let saveTimer = null;
let loaded = false;
let quitting = false; // past the quit confirmation: the saved state is final
app.subscribe(() => {
  if (!loaded || quitting) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.state.save(app.get()), 300);
  if (app.get().settings !== fileSettings && !ui.get().settingsFile.error) {
    clearTimeout(fileTimer);
    fileTimer = setTimeout(writeSettingsFile, 400);
  }
});
function saveNow() {
  clearTimeout(saveTimer);
  api.state.save(app.get());
  if (fileTimer) writeSettingsFile();
}

// ---- settings.json ------------------------------------------------------------------
// `fileSettings` is the settings object last read from or written to the file: changes
// made in the app write it back, edits made in an editor are applied live. While the file
// has a syntax error it isn't overwritten, so a half-finished edit is never lost.
let fileSettings = null;
let fileTimer = null;
let schemaUrl = '';

function writeSettingsFile() {
  clearTimeout(fileTimer);
  fileTimer = null;
  fileSettings = app.get().settings;
  const text = settingsToFile(fileSettings, schemaUrl);
  setFileStatus({ text });
  api.settings.save(text);
}

function setFileStatus(patch) {
  ui.set((u) => ({ ...u, settingsFile: { ...u.settingsFile, ...patch } }));
}

// Parses the file over the current settings. Returns the merged settings, or null on a syntax error.
function readSettingsFile(text, current) {
  const r = parseSettingsFile(text, DEFAULT_SETTINGS);
  if (r.error) {
    setFileStatus({ error: r.error, warnings: [] });
    return null;
  }
  setFileStatus({ error: null, warnings: r.warnings });
  return { ...current, ...r.settings };
}

function onSettingsFileChanged(text) {
  setFileStatus({ text });
  const prev = app.get().settings;
  const next = readSettingsFile(text, prev);
  const { error, warnings } = ui.get().settingsFile;
  if (error) return toast({ title: 'settings.json has an error', detail: `${error}. Keeping the last good settings.`, action: { label: 'Open', run: () => openSettings('file') } }, 8000);
  fileSettings = next;
  app.set((s) => ({ ...s, settings: next }));
  applySettings();
  if (next.keybindings.quickTerminal !== prev.keybindings.quickTerminal) api.app.setHotkey(next.keybindings.quickTerminal || '');
  if (warnings.length) toast({ title: `settings.json: ${warnings.length} problem${warnings.length > 1 ? 's' : ''}`, detail: warnings.slice(0, 2).join(' · '), action: { label: 'Open', run: () => openSettings('file') } }, 8000);
  else toast({ title: 'Settings reloaded', detail: 'Applied changes from settings.json.' });
}

export const openSettingsFile = () => api.settings.open();

// Saves text typed in the in-app editor and applies it, as if it had been edited on disk.
export function saveSettingsText(text) {
  api.settings.save(text);
  onSettingsFileChanged(text);
}

// ---- Settings tab -------------------------------------------------------------------
// Settings opens in place of the terminal and keeps a tab in the sidebar until closed.
export function openSettings(tab) {
  ui.set((u) => ({ ...u, view: 'settings', settingsOpen: true, settingsTab: tab || u.settingsTab, overlay: null }));
}

export function closeSettings() {
  const wasShown = ui.get().view === 'settings';
  ui.set((u) => ({ ...u, settingsOpen: false, capturingKeys: false, view: u.view === 'settings' ? 'terminal' : u.view }));
  if (wasShown) requestAnimationFrame(() => focusedSid() && reg.focus(focusedSid()));
}

export const toggleSettings = () => (ui.get().view === 'settings' ? closeSettings() : openSettings());

// ---- Lookups ------------------------------------------------------------------------
export const activeSpace = (s = app.get()) => s.spaces.find((x) => x.id === s.activeSpaceId) || s.spaces[0];
export const activeTabId = (s = app.get()) => activeSpace(s)?.activeTabId || null;
export const activeTab = (s = app.get()) => s.tabs[activeTabId(s)] || null;
export const focusedSid = () => activeTab()?.activeSid || null;

export function locate(tid, s = app.get()) {
  if (s.favorites.includes(tid)) return { section: 'fav', spaceId: null, folderId: null };
  for (const sp of s.spaces) {
    if (sp.pinned.includes(tid)) return { section: 'pinned', spaceId: sp.id, folderId: null };
    if (sp.today.includes(tid)) return { section: 'today', spaceId: sp.id, folderId: null };
    for (const f of sp.folders) if (f.tabs.includes(tid)) return { section: 'pinned', spaceId: sp.id, folderId: f.id };
  }
  return null;
}

export function tabOfSession(sid, s = app.get()) {
  for (const t of Object.values(s.tabs)) if (L.leaves(t.layout).includes(sid)) return t;
  return null;
}

function spaceForTab(tid, s = app.get()) {
  const loc = locate(tid, s);
  return loc?.spaceId || s.activeSpaceId;
}

export function tabsOfSpace(sp) {
  return [...sp.pinned, ...sp.folders.flatMap((f) => f.tabs), ...sp.today];
}

function profileFor(id, s = app.get()) {
  const p = s.profiles.find((x) => x.id === id) || s.profiles.find((x) => x.id === s.defaultProfileId) || s.profiles[0];
  return p;
}

function profilePayload(p) {
  return { command: p?.command || '', env: Object.fromEntries((p?.env || []).filter(([k]) => k)), startup: p?.startup || '' };
}

function spaceStartDir(sp, s = app.get()) {
  const p = profileFor(sp?.profileId, s);
  if (p?.cwdMode === 'home') return home();
  if (p?.cwdMode === 'custom' && p.cwd) return expandHome(p.cwd, home());
  return expandHome(sp?.startDir || '~', home());
}

function defaultCwd(sp) {
  const s = app.get();
  const mode = s.settings.newTerminalDir;
  if (mode === 'home') return home();
  if (mode === 'current') {
    const sid = focusedSid();
    const cwd = sid && (rt.get()[sid]?.cwd || s.sessions[sid]?.cwd);
    if (cwd && sp.id === s.activeSpaceId) return cwd;
  }
  return spaceStartDir(sp, s);
}

// ---- List surgery -------------------------------------------------------------------
function without(list, id) {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

function detach(s, tid) {
  return {
    ...s,
    favorites: without(s.favorites, tid),
    spaces: s.spaces.map((sp) => ({
      ...sp,
      pinned: without(sp.pinned, tid),
      today: without(sp.today, tid),
      folders: sp.folders.map((f) => (f.tabs.includes(tid) ? { ...f, tabs: without(f.tabs, tid) } : f)),
      activeTabId: sp.activeTabId === tid ? null : sp.activeTabId,
    })),
  };
}

function attach(s, tid, { section, spaceId, folderId = null, index = -1 }) {
  const put = (list) => {
    const l = list.filter((x) => x !== tid);
    if (index < 0 || index > l.length) l.push(tid);
    else l.splice(index, 0, tid);
    return l;
  };
  if (section === 'fav') return { ...s, favorites: put(s.favorites) };
  return {
    ...s,
    spaces: s.spaces.map((sp) => {
      if (sp.id !== spaceId) return sp;
      if (folderId) return { ...sp, folders: sp.folders.map((f) => (f.id === folderId ? { ...f, open: true, tabs: put(f.tabs) } : f)) };
      return section === 'pinned' ? { ...sp, pinned: put(sp.pinned) } : { ...sp, today: put(sp.today) };
    }),
  };
}

function setActiveTab(s, spaceId, tid) {
  return { ...s, activeSpaceId: spaceId, spaces: s.spaces.map((sp) => (sp.id === spaceId ? { ...sp, activeTabId: tid } : sp)) };
}

// ---- Sessions -----------------------------------------------------------------------
function startSession(sid, initialCommand = '') {
  const s = app.get();
  const meta = s.sessions[sid];
  if (!meta) return;
  const tab = tabOfSession(sid, s);
  const sp = s.spaces.find((x) => x.id === (tab ? spaceForTab(tab.id, s) : s.activeSpaceId));
  reg.start(sid, {
    cwd: meta.cwd || home(),
    profile: profilePayload(profileFor(meta.profileId, s)),
    spaceName: sp?.name || '',
    initialCommand,
  });
  patchRt(sid, { cwd: meta.cwd, startedAt: Date.now() });
  if (meta.cwd) refreshGit(sid, meta.cwd);
}

// Mounting a pane calls this; restored sessions only get a shell when first shown.
export function ensureStarted(sid) {
  const h = reg.getHandle(sid);
  if (!h || h.alive) return;
  const meta = app.get().sessions[sid];
  const rerun = !h.started && meta?.command && sshTarget(meta.command) ? meta.command : '';
  startSession(sid, rerun);
}

export function openTerminal(opts = {}) {
  const { cwd, command = '', spaceId, section = 'today', folderId = null, splitOf = null, edge = 'right', name = null, profileId = null, activate = true, content = '' } = opts;
  const s0 = app.get();
  const targetSpace = s0.spaces.find((x) => x.id === spaceId) || activeSpace(s0);
  const dir = cwd ? expandHome(cwd, home()) : defaultCwd(targetSpace);
  const profile = profileId || targetSpace.profileId || s0.defaultProfileId;

  const sid = uid('s');
  const now = Date.now();
  let tid = null;
  app.set((s) => {
    let next = { ...s, sessions: { ...s.sessions, [sid]: { id: sid, cwd: dir, profileId: profile, command, createdAt: now } } };
    const host = splitOf && next.tabs[splitOf];
    if (host && L.leaves(host.layout).length < L.MAX_PANES) {
      tid = splitOf;
      next.tabs = { ...next.tabs, [tid]: { ...host, layout: L.insert(host.layout, host.activeSid, sid, edge), activeSid: sid } };
    } else {
      tid = uid('t');
      next.tabs = { ...next.tabs, [tid]: { id: tid, name, layout: L.leaf(sid), activeSid: sid, effects: {}, createdAt: now } };
      next = attach(next, tid, { section, spaceId: targetSpace.id, folderId });
    }
    if (activate) next = setActiveTab(next, section === 'fav' ? next.activeSpaceId : spaceForTab(tid, next), tid);
    return next;
  });

  const h = reg.create(sid);
  if (content) reg.restore(sid, content);
  startSession(sid, command);
  if (activate) {
    ui.set((u) => ({ ...u, view: 'terminal', focusedSid: sid }));
    requestAnimationFrame(() => reg.focus(sid));
  }
  return { sid, tid };
}

function removeSessionFromTab(sid) {
  const s = app.get();
  const tab = tabOfSession(sid, s);
  app.set((st) => {
    const sessions = { ...st.sessions };
    delete sessions[sid];
    let next = { ...st, sessions };
    if (!tab) return next;
    const layout = L.remove(tab.layout, sid);
    if (layout) {
      const leaves = L.leaves(layout);
      next.tabs = { ...next.tabs, [tab.id]: { ...tab, layout, activeSid: leaves.includes(tab.activeSid) ? tab.activeSid : leaves[leaves.length - 1] } };
    } else {
      const loc = locate(tab.id, next);
      const sp = next.spaces.find((x) => x.id === (loc?.spaceId || next.activeSpaceId));
      const order = sp ? tabsOfSpace(sp) : [];
      const idx = order.indexOf(tab.id);
      const tabs = { ...next.tabs };
      delete tabs[tab.id];
      next = detach({ ...next, tabs }, tab.id);
      if (sp && sp.activeTabId === tab.id) {
        const rest = order.filter((x) => x !== tab.id);
        const fallback = rest[Math.min(idx, rest.length - 1)] || null;
        next = { ...next, spaces: next.spaces.map((x) => (x.id === sp.id ? { ...x, activeTabId: fallback } : x)) };
      }
    }
    return next;
  });
  reg.dispose(sid);
  api.scrollback.remove(sid);
  syncFocus();
}

// A command is running, or a program other than the shell holds the terminal.
function isBusy(sid) {
  const h = reg.getHandle(sid);
  const r = rt.get()[sid];
  return r?.status === 'run' || !!(h?.alive && r?.proc && r.proc !== h.shell && r.proc !== 'login');
}

// An idle Today session just closes. A pinned or Favorite one, or one with something
// running, asks first. `sids` alone means panes leaving a split that stays open.
async function okToClose({ tids = [], sids = tids.flatMap((tid) => L.leaves(app.get().tabs[tid]?.layout)), archive = false }) {
  const s = app.get();
  const r = rt.get();
  const busy = sids.filter(isBusy);
  const kept = tids.filter((tid) => ['pinned', 'fav'].includes(locate(tid, s)?.section));
  if (!busy.length && !kept.length) return true;
  const what = tids.length > 1 ? `${tids.length} sessions` : `“${s.tabs[tids[0]]?.name || sessionName(null, r[busy[0] || sids[0]], home()) || 'this session'}”`;
  const detail = [];
  if (busy.length === 1) detail.push(`${r[busy[0]]?.command || r[busy[0]]?.proc || 'A process'} is still running and will be stopped.`);
  else if (busy.length) detail.push(`${busy.length} running processes will be stopped.`);
  if (archive) detail.push('Scrollback and history are kept in the Library.');
  else if (kept.length > 1) detail.push(`${kept.length} of them are pinned.`);
  else if (kept.length) detail.push(locate(kept[0], s).section === 'fav' ? "It's a Favorite, shared by every Space." : "It's pinned to this Space.");
  return api.sys.confirm({ message: archive ? `Move ${what} to the Library?` : `Close ${what}?`, detail: detail.join(' '), ok: archive ? 'Move to Library' : 'Close' });
}

export async function closePane(sid = focusedSid(), { force = false } = {}) {
  const tab = sid && tabOfSession(sid);
  if (!tab) return;
  const whole = L.leaves(tab.layout).length === 1;
  if (!force && !(await okToClose(whole ? { tids: [tab.id] } : { sids: [sid] }))) return;
  removeSessionFromTab(sid);
  ensureSession({ closed: true });
}

export async function closeTab(tid) {
  const tab = app.get().tabs[tid];
  if (!tab || !(await okToClose({ tids: [tid] }))) return;
  for (const sid of L.leaves(tab.layout)) removeSessionFromTab(sid);
  ensureSession({ closed: true });
}

// ---- Always a session ---------------------------------------------------------------
// The active Space always shows a session: another of its own, or a fresh terminal. When
// the user closes the last one in a Space they move to the nearest Space that has
// sessions, and closing the very last session quits.
let quitRequested = false;
let ensureQueued = false;

function ensureSession({ closed = false } = {}) {
  const s = app.get();
  if (!loaded || quitting || quitRequested || !s.onboarded) return;
  const sp = activeSpace(s);
  if (s.tabs[sp.activeTabId]) return;
  const fallback = [...tabsOfSpace(sp), ...s.favorites].find((tid) => s.tabs[tid]);
  if (fallback) {
    app.set((st) => setActiveTab(st, sp.id, fallback));
    return syncFocus();
  }
  if (closed) {
    const at = s.spaces.indexOf(sp);
    const near = s.spaces
      .map((x, i) => ({ x, d: Math.abs(i - at) }))
      .filter(({ x }) => x !== sp && tabsOfSpace(x).some((tid) => s.tabs[tid]))
      .sort((a, b) => a.d - b.d)[0];
    if (near) return switchSpace(near.x.id);
    quitRequested = true;
    return api.app.quit();
  }
  openTerminal({ spaceId: sp.id });
}

// Catches every other way a Space ends up empty: switching to it, creating it, archiving
// or moving its sessions away. Deferred so a close can decide first.
app.subscribe(() => {
  if (ensureQueued || !loaded) return;
  const s = app.get();
  if (s.tabs[activeSpace(s)?.activeTabId]) return;
  ensureQueued = true;
  queueMicrotask(() => {
    ensureQueued = false;
    ensureSession();
  });
});

function onExit(sid, exitCode) {
  // Shells die because we're quitting: keep their tabs for the next launch.
  if (quitting) return;
  const s = app.get();
  const tab = tabOfSession(sid, s);
  const loc = tab && locate(tab.id, s);
  const keep = loc && (loc.section === 'pinned' || loc.section === 'fav') && L.leaves(tab.layout).length === 1;
  if (keep) {
    reg.getHandle(sid)?.term.write(`\r\n\x1b[2m[process exited${exitCode ? ` with code ${exitCode}` : ''} — click to restart]\x1b[0m\r\n`);
    patchRt(sid, { alive: false, status: 'idle' });
  } else {
    removeSessionFromTab(sid);
    ensureSession({ closed: true });
  }
}

// ---- Activation ---------------------------------------------------------------------
export function activateTab(tid, { focus = true } = {}) {
  const s = app.get();
  const tab = s.tabs[tid];
  if (!tab) return;
  const loc = locate(tid, s);
  const spaceId = loc?.spaceId || s.activeSpaceId;
  app.set((st) => setActiveTab(st, spaceId, tid));
  ui.set((u) => ({ ...u, view: 'terminal', peek: null }));
  for (const sid of L.leaves(tab.layout)) {
    if (rt.get()[sid]?.bell) patchRt(sid, { bell: 0 });
    const h = reg.getHandle(sid);
    if (h && !h.alive && h.started) startSession(sid);
  }
  markSpaceSeen(spaceId);
  syncFocus(focus);
}

export function focusSession(sid) {
  const tab = tabOfSession(sid);
  if (!tab) return;
  if (tab.activeSid !== sid) app.set((s) => ({ ...s, tabs: { ...s.tabs, [tab.id]: { ...s.tabs[tab.id], activeSid: sid } } }));
  if (activeTabId() !== tab.id) activateTab(tab.id);
  else syncFocus();
}

function syncFocus(doFocus = true) {
  const sid = focusedSid();
  ui.set((u) => (u.focusedSid === sid ? u : { ...u, focusedSid: sid }));
  if (sid && doFocus) requestAnimationFrame(() => reg.focus(sid));
}

export function jumpTo(sid, line = null) {
  focusSession(sid);
  if (line != null) requestAnimationFrame(() => reg.getHandle(sid)?.term.scrollToLine(Math.max(0, line - 1)));
}

export function cycleTab(delta) {
  const s = app.get();
  const sp = activeSpace(s);
  const order = [...s.favorites, ...tabsOfSpace(sp)];
  if (!order.length) return;
  const i = order.indexOf(sp.activeTabId);
  activateTab(order[(i + delta + order.length) % order.length]);
}

export function activateIndex(n) {
  const s = app.get();
  const order = [...s.favorites, ...tabsOfSpace(activeSpace(s))];
  if (order[n]) activateTab(order[n]);
}

// ---- Spaces -------------------------------------------------------------------------
export function switchSpace(target) {
  const s = app.get();
  let id = target;
  if (typeof target === 'number') {
    const i = s.spaces.findIndex((x) => x.id === s.activeSpaceId);
    id = s.spaces[(i + target + s.spaces.length) % s.spaces.length].id;
  }
  if (!s.spaces.some((x) => x.id === id)) return;
  app.set((st) => ({ ...st, activeSpaceId: id }));
  ui.set((u) => ({ ...u, peek: null }));
  markSpaceSeen(id);
  syncFocus();
}

export function createSpace(space) {
  app.set((s) => ({ ...s, spaces: [...s.spaces, space], activeSpaceId: space.id }));
  syncFocus();
}

// A fresh, empty Space with the next unused color and glyph (swiping past the last Space).
export function createBlankSpace() {
  const s = app.get();
  const used = new Set(s.spaces.map((x) => x.color.toLowerCase()));
  const color = SPACE_COLORS.find((c) => !used.has(c)) || SPACE_COLORS[s.spaces.length % SPACE_COLORS.length];
  const glyph = SPACE_GLYPHS[s.spaces.length % SPACE_GLYPHS.length];
  const space = newSpace({ name: `Space ${s.spaces.length + 1}`, glyph, color });
  createSpace(space);
  toast({ title: `${space.name} created`, detail: 'Swipe back to return.', action: { label: 'Rename', run: () => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id, toast: null })) } });
  return space.id;
}

export function updateSpace(id, patch) {
  app.set((s) => ({ ...s, spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, ...patch } : sp)) }));
}

export async function deleteSpace(id) {
  const s = app.get();
  if (s.spaces.length < 2) return;
  const sp = s.spaces.find((x) => x.id === id);
  const n = tabsOfSpace(sp).length;
  const detail = n ? `Its ${n} session${n > 1 ? 's' : ''} will be moved to the Library.` : "This can't be undone.";
  const ok = await api.sys.confirm({ message: `Delete “${sp.name}”?`, detail, ok: 'Delete Space' });
  if (!ok) return;
  if (n) await commitArchive(tabsOfSpace(sp), 'closed');
  app.set((st) => {
    const spaces = st.spaces.filter((x) => x.id !== id);
    return { ...st, spaces, activeSpaceId: st.activeSpaceId === id ? spaces[0].id : st.activeSpaceId };
  });
  syncFocus();
}

export function reorderSpaces(from, to) {
  app.set((s) => {
    const spaces = [...s.spaces];
    const [m] = spaces.splice(from, 1);
    spaces.splice(to, 0, m);
    return { ...s, spaces };
  });
}

function markSpaceSeen(spaceId) {
  const s = app.get();
  if (s.activity.some((a) => a.spaceId === spaceId && !a.seen)) {
    app.set((st) => ({ ...st, activity: st.activity.map((a) => (a.spaceId === spaceId ? { ...a, seen: true } : a)) }));
  }
}

// ---- Moving tabs --------------------------------------------------------------------
export function moveTab(tid, dest) {
  app.set((s) => {
    let next = attach(detach(s, tid), tid, dest);
    if (dest.section !== 'fav' && dest.spaceId === s.activeSpaceId && s.spaces.find((x) => x.id === s.activeSpaceId)?.activeTabId === tid) next = setActiveTab(next, dest.spaceId, tid);
    return next;
  });
}

export function renameTab(tid, name) {
  app.set((s) => ({ ...s, tabs: { ...s.tabs, [tid]: { ...s.tabs[tid], name: name.trim() || null } } }));
}

// Per-tab look: an icon shown in the sidebar gutter and a color that tints the row.
// Either can be null to fall back to the defaults.
export function setTabStyle(tid, patch) {
  app.set((s) => (s.tabs[tid] ? { ...s, tabs: { ...s.tabs, [tid]: { ...s.tabs[tid], ...patch } } } : s));
}

export function setTabEffects(tid, effects) {
  app.set((s) => ({ ...s, tabs: { ...s.tabs, [tid]: { ...s.tabs[tid], effects: { ...s.tabs[tid].effects, ...effects } } } }));
}

export function createFolder(spaceId, name = 'New Folder') {
  const id = uid('f');
  app.set((s) => ({ ...s, spaces: s.spaces.map((sp) => (sp.id === spaceId ? { ...sp, folders: [...sp.folders, { id, name, open: true, tabs: [] }] } : sp)) }));
  return id;
}

export function updateFolder(spaceId, folderId, patch) {
  app.set((s) => ({ ...s, spaces: s.spaces.map((sp) => (sp.id === spaceId ? { ...sp, folders: sp.folders.map((f) => (f.id === folderId ? { ...f, ...patch } : f)) } : sp)) }));
}

export function deleteFolder(spaceId, folderId) {
  app.set((s) => ({
    ...s,
    spaces: s.spaces.map((sp) => {
      if (sp.id !== spaceId) return sp;
      const f = sp.folders.find((x) => x.id === folderId);
      return { ...sp, pinned: [...sp.pinned, ...(f?.tabs || [])], folders: sp.folders.filter((x) => x.id !== folderId) };
    }),
  }));
}

// ---- Splits -------------------------------------------------------------------------
export function splitActive(edge = 'right') {
  const tab = activeTab();
  if (!tab) return openTerminal();
  if (L.leaves(tab.layout).length >= L.MAX_PANES) return;
  const cwd = rt.get()[tab.activeSid]?.cwd || app.get().sessions[tab.activeSid]?.cwd;
  openTerminal({ cwd, splitOf: tab.id, edge });
}

// Drop a sidebar tab onto an edge of the active card.
export function mergeIntoActive(tid, edge) {
  const s = app.get();
  const target = activeTab(s);
  const src = s.tabs[tid];
  if (!target || !src || target.id === tid) return;
  if (L.leaves(target.layout).length + L.leaves(src.layout).length > L.MAX_PANES) return;
  app.set((st) => {
    const tabs = { ...st.tabs, [target.id]: { ...target, layout: L.insertRoot(target.layout, src.layout, edge), activeSid: src.activeSid } };
    delete tabs[tid];
    return detach({ ...st, tabs }, tid);
  });
  syncFocus();
}

// Drop one sidebar session onto another (Arc-style): they become one split session.
export function mergeTabs(srcTid, targetTid, edge = 'right') {
  const s = app.get();
  const src = s.tabs[srcTid];
  const target = s.tabs[targetTid];
  if (!src || !target || srcTid === targetTid) return false;
  if (L.leaves(target.layout).length + L.leaves(src.layout).length > L.MAX_PANES) {
    toast({ title: 'That split is full', detail: `A session holds up to ${L.MAX_PANES} panes.` });
    return false;
  }
  app.set((st) => {
    const tabs = { ...st.tabs, [targetTid]: { ...target, layout: L.insertRoot(target.layout, src.layout, edge), activeSid: src.activeSid } };
    delete tabs[srcTid];
    return detach({ ...st, tabs }, srcTid);
  });
  activateTab(targetTid);
  return true;
}

// Pull one pane out of a split into its own row: Today by default, or wherever it was dropped.
export function unsplit(sid, dest = null) {
  const s = app.get();
  const tab = tabOfSession(sid, s);
  if (!tab || L.leaves(tab.layout).length < 2) return;
  const tid = uid('t');
  const spaceId = spaceForTab(tab.id, s);
  app.set((st) => {
    const layout = L.remove(tab.layout, sid);
    const leaves = L.leaves(layout);
    let next = {
      ...st,
      tabs: {
        ...st.tabs,
        [tab.id]: { ...tab, layout, activeSid: leaves.includes(tab.activeSid) ? tab.activeSid : leaves[0] },
        [tid]: { id: tid, name: null, layout: L.leaf(sid), activeSid: sid, effects: { ...tab.effects }, createdAt: Date.now() },
      },
    };
    return attach(next, tid, dest || { section: 'today', spaceId });
  });
  return tid;
}

export function setRatio(tid, path, ratio) {
  app.set((s) => ({ ...s, tabs: { ...s.tabs, [tid]: { ...s.tabs[tid], layout: L.setRatio(s.tabs[tid].layout, path, ratio) } } }));
}

export function focusDirection(dir) {
  const tab = activeTab();
  if (!tab) return;
  const n = L.neighbor(tab.layout, tab.activeSid, dir);
  if (n) focusSession(n);
}

// ---- Guard rails & shell hooks -------------------------------------------------------
function effectsOf(sid) {
  return tabOfSession(sid)?.effects || {};
}

export function isDanger(sid) {
  return !!effectsOf(sid).danger;
}

function confirmThen(sid, conf, run) {
  ui.set((u) => ({ ...u, confirm: { sid, ...conf, run } }));
}

reg.setHooks({
  input(sid, data) {
    const eff = effectsOf(sid);
    const body = data.replace(/^\x1b\[200~|\x1b\[201~$/g, '');
    if (eff.confirmPaste && body.length > 1 && /[\r\n]/.test(body.replace(/[\r\n]+$/, ''))) {
      const lines = body.split(/\r\n|\r|\n/).filter(Boolean).length;
      confirmThen(sid, { title: `Paste ${lines} lines?`, detail: 'Multi-line pastes run each line as a command on this session.', label: 'Paste' }, () => api.pty.write(sid, data));
      return;
    }
    api.pty.write(sid, data);
  },
  key(sid, e) {
    if (e.type !== 'keydown' || e.key !== 'Enter' || e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return true;
    if (!isDanger(sid)) return true;
    const line = reg.cursorLine(sid);
    if (!isRiskyCommand(line)) return true;
    confirmThen(sid, { title: 'Run this on production?', detail: "You're about to run a privileged command on production.", label: 'Run', danger: true }, () => api.pty.write(sid, '\r'));
    return false;
  },
  // Keys that reached the terminal while the input bar owns the prompt (Composer.jsx).
  composerInput(sid, data) {
    window.dispatchEvent(new CustomEvent('composer-input', { detail: { sid, data } }));
  },
  bell(sid) {
    const h = reg.getHandle(sid);
    if (h?.visible && document.hasFocus()) return;
    patchRt(sid, { bell: (rt.get()[sid]?.bell || 0) + 1 });
  },
  focus(sid) {
    if (ui.get().focusedSid !== sid) focusSession(sid);
  },
  cwd(sid, cwd) {
    if (rt.get()[sid]?.cwd === cwd) return;
    patchRt(sid, { cwd });
    refreshGit(sid, cwd);
    app.set((s) => {
      if (!s.sessions[sid]) return s;
      const recent = s.recentDirs.filter((d) => d.path !== cwd);
      const prev = s.recentDirs.find((d) => d.path === cwd);
      const recentDirs = cwd === home() ? s.recentDirs : [{ path: cwd, visits: (prev?.visits || 0) + 1, last: Date.now() }, ...recent].slice(0, 200);
      return { ...s, recentDirs, sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], cwd } } };
    });
  },
  commandEnd(sid, entry) {
    const s = app.get();
    const h = reg.getHandle(sid);
    const visible = !!h?.visible && document.hasFocus();
    const interrupted = entry.exit === 130;
    const failed = entry.exit !== 0 && !interrupted;
    const status = failed ? 'fail' : !interrupted && (entry.dur >= 3000 || !visible) ? 'ok' : 'idle';
    const patch = { status, exitCode: entry.exit, duration: entry.dur, endedAt: Date.now() };
    const ssh = sshTarget(entry.cmd);
    if (ssh && entry.exit === 255 && entry.dur > 5000) patch.dropped = { host: ssh.host, cmd: entry.cmd, at: Date.now(), dur: entry.dur };
    patchRt(sid, patch);
    const cwd = rt.get()[sid]?.cwd;
    // Any command can touch the working tree, so the change count is re-read after each one.
    if (cwd) refreshGit(sid, cwd);

    const threshold = s.settings.notifyAfterS * 1000;
    if (threshold && entry.dur >= threshold && !visible && !interrupted) notifyFinished(sid, entry);
  },
  exit: onExit,
});

function notifyFinished(sid, entry) {
  const s = app.get();
  const tab = tabOfSession(sid, s);
  if (!tab) return;
  const spaceId = spaceForTab(tab.id, s);
  const sp = s.spaces.find((x) => x.id === spaceId);
  const item = { id: uid('a'), sid, spaceId, command: entry.cmd, exit: entry.exit, dur: entry.dur, at: Date.now(), seen: spaceId === s.activeSpaceId && document.hasFocus() };
  app.set((st) => ({ ...st, activity: [item, ...st.activity].slice(0, 50) }));
  ui.set((u) => ({ ...u, notify: item }));
  setTimeout(() => ui.set((u) => (u.notify?.id === item.id ? { ...u, notify: null } : u)), 12000);
  const os = s.settings.osNotify;
  if (os === 'always' || (os === 'background' && !document.hasFocus())) {
    api.sys.notify({ title: `${entry.cmd} ${entry.exit ? `failed (exit ${entry.exit})` : 'finished'}`, body: `${sp?.name || ''} · ${formatDuration(entry.dur)}`, sessionId: sid });
  }
}

// ---- Copy output, scroll, reconnect -------------------------------------------------
export function copyLastOutput(sid = focusedSid()) {
  const entry = reg.lastFinished(sid);
  const text = entry && reg.outputOf(sid, entry);
  if (text == null) {
    toast({ title: 'Nothing to copy yet', detail: 'Run a command first — output is tracked per command.' });
    return;
  }
  navigator.clipboard.writeText(text);
  rememberCopy({ text, sid, mark: entry.start?.line ?? null });
  reg.flashRange(sid, entry);
  ui.set((u) => ({ ...u, copied: { sid, at: Date.now() } }));
  setTimeout(() => ui.set((u) => (u.copied?.sid === sid ? { ...u, copied: null } : u)), 1600);
}

let lastCopy = null;
export function rememberCopy(c) {
  lastCopy = { ...c, at: Date.now() };
}
export const getLastCopy = () => lastCopy;

export function jumpToFailure(sid) {
  const h = reg.getHandle(sid);
  const entry = h && [...h.cmds].reverse().find((c) => c.exit && c.exit !== 130);
  focusSession(sid);
  if (entry) requestAnimationFrame(() => reg.scrollToEntry(sid, entry));
}

export function reconnect(sid = focusedSid()) {
  const d = rt.get()[sid]?.dropped;
  if (!d) return;
  patchRt(sid, { dropped: null });
  api.pty.write(sid, d.cmd + '\r');
  reg.focus(sid);
}

// ---- Pane header chips ----------------------------------------------------------------
// Branch, changed-file count and open PR for a session's directory. Results for a cwd the
// session has since left are dropped.
export async function refreshGit(sid, cwd) {
  const still = () => (rt.get()[sid]?.cwd || app.get().sessions[sid]?.cwd) === cwd;
  const [branch, status] = await Promise.all([api.sys.gitBranch(cwd), api.sys.gitStatus(cwd)]);
  if (!still()) return;
  patchRt(sid, { branch, changes: status?.changes ?? null, ...(branch === rt.get()[sid]?.branch ? {} : { pr: null }) });
  if (!branch) return;
  const pr = await api.sys.gitPr(cwd, branch);
  if (still() && rt.get()[sid]?.branch === branch) patchRt(sid, { pr });
}

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Type a command at the prompt the way a person would, replacing anything half-typed.
// Refuses while something is running so we never feed keystrokes into another program.
export function typeCommand(sid, command) {
  if (!sid) return false;
  if (rt.get()[sid]?.status === 'run') {
    toast({ title: 'Finish the running command first', detail: 'Switching runs a command in this shell.' });
    return false;
  }
  const h = reg.getHandle(sid);
  if (h && !h.alive) startSession(sid);
  api.pty.write(sid, '\x05\x15' + command + '\r');
  focusSession(sid);
  return true;
}

// Runs a command typed in the input bar, with the same production guard as typing it in
// the terminal. Multi-line input goes as one bracketed paste so the shell runs it whole.
export function submitCommand(sid, command) {
  const h = reg.getHandle(sid);
  if (h && !h.alive) startSession(sid);
  const data = command.includes('\n') ? `\x1b[200~${command}\x1b[201~\r` : command + '\r';
  if (isDanger(sid) && isRiskyCommand(command)) {
    confirmThen(sid, { title: 'Run this on production?', detail: "You're about to run a privileged command on production.", label: 'Run', danger: true }, () => api.pty.write(sid, data));
    return false;
  }
  api.pty.write(sid, data);
  return true;
}

// Type text at the cursor without running it (e.g. a path from the explorer).
export function insertText(sid, text) {
  if (!sid) return;
  const h = reg.getHandle(sid);
  if (h && !h.alive) startSession(sid);
  if (reg.composerActive(h)) window.dispatchEvent(new CustomEvent('composer-input', { detail: { sid, data: text } }));
  else api.pty.write(sid, text);
  focusSession(sid);
}

// Pastes text into the focused session as one bracketed paste, so a coding agent running
// there gets it as a single message instead of line-by-line commands.
export function pasteIntoSession(text, sid = focusedSid()) {
  const h = sid && reg.getHandle(sid);
  if (!h) return false;
  if (!h.alive) startSession(sid);
  h.term.paste(text);
  focusSession(sid);
  return true;
}
export function runInSession(command, sid = focusedSid()) {
  if (!sid) return openTerminal({ command });
  const h = reg.getHandle(sid);
  if (h && !h.alive) startSession(sid);
  api.pty.write(sid, command + '\r');
  focusSession(sid);
}

// ---- Toasts -------------------------------------------------------------------------
let toastTimer = null;
export function toast(t, ms = 4000) {
  const id = uid('toast');
  ui.set((u) => ({ ...u, toast: { id, ...t } }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.set((u) => (u.toast?.id === id ? { ...u, toast: null } : u)), ms);
  return id;
}

// ---- Auto-archive & Library ---------------------------------------------------------
function archiveCandidates() {
  const s = app.get();
  const now = Date.now();
  const out = [];
  for (const sp of s.spaces) {
    const hours = sp.archiveAfterH ?? s.settings.archiveAfterH;
    if (!hours) continue;
    for (const tid of sp.today) {
      if (sp.id === s.activeSpaceId && sp.activeTabId === tid) continue;
      const tab = s.tabs[tid];
      if (!tab || tab.effects?.noArchive) continue;
      const idle = L.leaves(tab.layout).every((sid) => {
        const h = reg.getHandle(sid);
        if (!h) return true;
        if (isBusy(sid)) return false;
        return now - h.lastActivity > hours * 3600000;
      });
      if (idle) out.push(tid);
    }
  }
  return out;
}

export function tidy(tids = archiveCandidates(), { reason = 'idle', quiet = false } = {}) {
  if (!tids.length) return;
  const s = app.get();
  const refs = tids.map((tid) => ({ tid, loc: locate(tid, s) })).filter((r) => r.loc);
  app.set((st) => refs.reduce((acc, r) => detach(acc, r.tid), st));
  syncFocus(false);
  let undone = false;
  const locs = Object.fromEntries(refs.map((r) => [r.tid, r.loc]));
  const commit = setTimeout(() => !undone && commitArchive(refs.map((r) => r.tid), reason, locs), 8000);
  if (quiet) return;
  const hours = activeSpace(s).archiveAfterH ?? s.settings.archiveAfterH;
  toast(
    {
      title: reason === 'idle' ? `Tidied ${refs.length} idle session${refs.length > 1 ? 's' : ''}` : `Moved ${refs.length} session${refs.length > 1 ? 's' : ''} to the Library`,
      detail: reason === 'idle' ? `Idle for ${hours}h · moved to Library` : 'Scrollback and history are kept',
      action: {
        label: 'Undo',
        run: () => {
          undone = true;
          clearTimeout(commit);
          app.set((st) => refs.reduce((acc, r) => attach(acc, r.tid, r.loc), st));
          ui.set((u) => ({ ...u, toast: null }));
        },
      },
    },
    8000,
  );
}

async function commitArchive(tids, reason, locs = {}) {
  const s = app.get();
  for (const tid of tids) {
    const tab = s.tabs[tid];
    if (!tab) continue;
    const spaceId = locs[tid]?.spaceId || locate(tid, s)?.spaceId || s.activeSpaceId;
    const sp = s.spaces.find((x) => x.id === spaceId);
    for (const sid of L.leaves(tab.layout)) {
      const h = reg.getHandle(sid);
      const r = rt.get()[sid] || {};
      const meta = s.sessions[sid] || {};
      const cmds = (h?.cmds || []).filter((c) => c.cmd).map((c) => ({ cmd: c.cmd, exit: c.exit, at: c.at }));
      const ssh = [...cmds].reverse().map((c) => sshTarget(c.cmd)).find(Boolean);
      const lastExit = [...cmds].reverse().find((c) => c.exit != null)?.exit;
      const entry = {
        id: sid,
        name: tab.name || r.command || cmds[cmds.length - 1]?.cmd || leafOf(r.cwd || meta.cwd, home()),
        spaceId,
        spaceName: sp?.name || '',
        cwd: r.cwd || meta.cwd || home(),
        host: ssh?.host || 'local',
        status: lastExit == null ? 'idle' : lastExit === 0 ? 'ok' : 'fail',
        exitCode: lastExit ?? null,
        startedAt: meta.createdAt || Date.now(),
        endedAt: Date.now(),
        idleSince: h?.lastActivity || Date.now(),
        reason,
        commands: cmds.slice(-100),
        lines: h ? h.term.buffer.active.length : 0,
      };
      if (h) await api.library.add(entry, reg.saveHistory(sid, 5000));
      reg.dispose(sid);
      api.scrollback.remove(sid);
    }
  }
  app.set((st) => {
    const tabs = { ...st.tabs };
    const sessions = { ...st.sessions };
    for (const tid of tids) {
      for (const sid of L.leaves(st.tabs[tid]?.layout)) delete sessions[sid];
      delete tabs[tid];
    }
    return tids.reduce((acc, tid) => detach(acc, tid), { ...st, tabs, sessions });
  });
}

export async function archiveTabs(tids) {
  if (!tids.length || !(await okToClose({ tids, archive: true }))) return;
  tidy(tids, { reason: 'closed' });
}

export const archiveTab = (tid) => archiveTabs([tid]);

export async function restoreFromLibrary(entry, spaceId = entry.spaceId) {
  const content = await api.library.content(entry.id);
  const s = app.get();
  const target = s.spaces.some((x) => x.id === spaceId) ? spaceId : s.activeSpaceId;
  openTerminal({ cwd: entry.cwd, spaceId: target, content, name: null });
  await api.library.remove(entry.id);
}

// ---- Snippets, profiles, settings -------------------------------------
export function addSnippet({ name, command, spaceId = app.get().activeSpaceId }) {
  const clean = name.replace(/^\/+/, '').trim().replace(/\s+/g, '-') || 'snippet';
  app.set((s) => ({ ...s, snippets: [...s.snippets.filter((x) => !(x.name === clean && x.spaceId === spaceId)), { id: uid('sn'), name: clean, command, spaceId, createdAt: Date.now() }] }));
  toast({ title: `Saved /${clean}`, detail: 'It now shows up in the command bar.' });
}

export function removeSnippet(id) {
  app.set((s) => ({ ...s, snippets: s.snippets.filter((x) => x.id !== id) }));
}

export function setProfiles(profiles, defaultProfileId = app.get().defaultProfileId) {
  app.set((s) => ({ ...s, profiles, defaultProfileId }));
}

export function setSettings(patch) {
  app.set((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  applySettings();
}

let keymap = new Map();
export const getKeymap = () => keymap;

export function applySettings() {
  const s = app.get();
  applyFontVars(s.settings);
  api.app.setZoom(s.settings.zoomLevel);
  api.app.setTheme(s.settings.termTheme);
  const termTheme = reg.configure(s.settings, ui.get().dark);
  ui.set((u) => (u.termTheme === termTheme ? u : { ...u, termTheme }));
  keymap = buildKeymap(s.settings.keybindings);
  api.app.setMenu(s.settings.keybindings);
}

export function zoom(delta) {
  const size = app.get().settings.fontSize;
  setSettings({ fontSize: delta === 0 ? DEFAULT_SETTINGS.fontSize : Math.min(28, Math.max(9, size + delta)) });
}

// ---- Boot, quit ---------------------------------------------------------------------
export async function boot() {
  const [{ state, home: homeDir, dark }, file] = await Promise.all([api.state.load(), api.settings.load()]);
  ui.set((u) => ({ ...u, home: homeDir, dark, settingsFile: { ...u.settingsFile, path: file.path, text: file.text } }));
  let s = migrate(state);

  // settings.json wins over state.json. With no file yet, write one from the current settings.
  schemaUrl = file.schemaUrl;
  api.settings.saveSchema(settingsSchema(DEFAULT_SETTINGS, ACTIONS));
  const fromFile = file.text == null ? null : readSettingsFile(file.text, s.settings);
  if (fromFile) {
    if (fromFile.keybindings.quickTerminal !== s.settings.keybindings.quickTerminal) api.app.setHotkey(fromFile.keybindings.quickTerminal || '');
    s = { ...s, settings: fromFile };
    fileSettings = fromFile;
  }
  api.settings.onChanged(onSettingsFileChanged);

  // Drop dangling references left by a crash.
  const referenced = new Set([...s.favorites, ...s.spaces.flatMap(tabsOfSpace)]);
  const tabs = Object.fromEntries(Object.entries(s.tabs).filter(([id]) => referenced.has(id)));
  if (s.settings.onLaunch === 'fresh') {
    for (const sp of s.spaces) for (const tid of sp.today) delete tabs[tid];
    s = { ...s, spaces: s.spaces.map((sp) => ({ ...sp, today: [] })) };
  }
  const live = new Set(Object.values(tabs).flatMap((t) => L.leaves(t.layout)));
  const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([id]) => live.has(id)));
  s = { ...s, tabs, sessions, spaces: s.spaces.map((sp) => ({ ...sp, activeTabId: tabs[sp.activeTabId] ? sp.activeTabId : null })) };
  app.set(s);
  loaded = true;
  applySettings();
  if (file.text == null) writeSettingsFile();
  const { error, warnings } = ui.get().settingsFile;
  if (error || warnings.length) toast({ title: error ? 'settings.json has an error' : 'settings.json has problems', detail: error || warnings.slice(0, 2).join(' · '), action: { label: 'Open', run: () => openSettings('file') } }, 8000);

  const restoredAt = Date.now();
  const favSids = new Set(s.favorites.flatMap((tid) => L.leaves(tabs[tid]?.layout)));
  await Promise.all(
    Object.keys(sessions).map(async (sid) => {
      const h = reg.create(sid);
      const content = await api.scrollback.load(sid);
      reg.restore(sid, content, restoredAt);
      patchRt(sid, { cwd: sessions[sid].cwd, status: 'idle' });
      if (favSids.has(sid)) startSession(sid);
    }),
  );
  syncFocus();
  ensureSession();
  api.sys.sshHosts().then((sshHosts) => ui.set((u) => ({ ...u, sshHosts })));
  setInterval(() => tidy(), 5 * 60 * 1000);
  setInterval(checkpointScrollback, 60 * 1000);
  setTimeout(() => tidy(), 30 * 1000);
  return s;
}

// Scrollback is otherwise written only on a clean quit. Checkpoint sessions that printed
// something since the last pass, so a crash or force-quit still restores their output.
const checkpointedAt = new Map();
function checkpointScrollback() {
  const s = app.get();
  for (const h of reg.allHandles()) {
    if (!s.sessions[h.sid] || (checkpointedAt.get(h.sid) || 0) >= h.lastActivity) continue;
    checkpointedAt.set(h.sid, Date.now());
    api.scrollback.save(h.sid, reg.saveHistory(h.sid));
  }
}

export async function prepareQuit({ running }) {
  const s = app.get();
  if (s.settings.confirmQuit && running > 0) {
    const ok = await api.sys.confirm({ message: `Quit Termorc with ${running} running process${running > 1 ? 'es' : ''}?`, detail: 'Running commands will be stopped. Sessions and scrollback are restored next launch.', ok: 'Quit' });
    if (!ok) {
      quitRequested = false;
      ensureSession();
      return api.app.quitCancel();
    }
  }
  quitting = true;
  const writes = [];
  for (const h of reg.allHandles()) {
    if (s.sessions[h.sid]) writes.push(api.scrollback.save(h.sid, reg.saveHistory(h.sid)));
  }
  await Promise.allSettled(writes);
  saveNow();
  api.app.quitReady();
}

// Quick Terminal promoted into a Space: adopt the live PTY with its scrollback.
export function adopt({ sessionId, spaceId, pinned, content, cwd, meta }) {
  const now = Date.now();
  const tid = uid('t');
  app.set((s) => {
    const sp = s.spaces.find((x) => x.id === spaceId) || activeSpace(s);
    let next = {
      ...s,
      sessions: { ...s.sessions, [sessionId]: { id: sessionId, cwd, profileId: s.defaultProfileId, command: '', createdAt: now } },
      tabs: { ...s.tabs, [tid]: { id: tid, name: null, layout: L.leaf(sessionId), activeSid: sessionId, effects: {}, createdAt: now } },
    };
    next = attach(next, tid, { section: pinned ? 'pinned' : 'today', spaceId: sp.id });
    return setActiveTab(next, sp.id, tid);
  });
  const h = reg.create(sessionId);
  h.started = true;
  h.alive = true;
  h.integrated = !!meta?.integrated;
  h.shell = meta?.shell || 'zsh';
  if (content) h.term.write(content);
  patchRt(sessionId, { cwd, shell: h.shell, proc: h.shell, alive: true, status: meta?.status || 'idle', command: meta?.command || '' });
  h.term.write('', () => api.pty.release(sessionId));
  ui.set((u) => ({ ...u, view: 'terminal' }));
  syncFocus();
}

// ---- Sidebar modes ------------------------------------------------------------------
let lastVisibleMode = 'expanded';
export function setSidebarMode(mode) {
  const cur = app.get().settings.sidebarMode;
  if (cur !== 'hidden') lastVisibleMode = cur;
  setSettings({ sidebarMode: mode });
}

// ⌘S and ⌃⌘S: hide completely, like a native sidebar, then restore whichever mode was showing.
export const toggleSidebar = () => toggleFocusMode();

export function toggleFocusMode() {
  const cur = app.get().settings.sidebarMode;
  setSidebarMode(cur === 'hidden' ? lastVisibleMode : 'hidden');
}

export function setSpaceLook(spaceId, patch) {
  app.set((s) => ({ ...s, spaces: s.spaces.map((sp) => (sp.id === spaceId ? { ...sp, term: { ...sp.term, ...patch } } : sp)) }));
}

export function moveFolder(spaceId, folderId, toIndex) {
  app.set((s) => ({
    ...s,
    spaces: s.spaces.map((sp) => {
      if (sp.id !== spaceId) return sp;
      const folders = sp.folders.filter((f) => f.id !== folderId);
      const f = sp.folders.find((x) => x.id === folderId);
      if (!f) return sp;
      folders.splice(Math.max(0, Math.min(toIndex, folders.length)), 0, f);
      return { ...sp, folders };
    }),
  }));
}
