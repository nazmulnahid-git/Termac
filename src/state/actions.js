// Everything that changes sessions, tabs and Spaces goes through here.
import { app, rt, ui, patchRt, migrate } from './model.js';
import * as reg from '../term/registry.js';
import * as L from '../lib/layout.js';
import { route, ruleMatches, sshTarget, expandHome, isRiskyCommand } from '../lib/routing.js';
import { uid, formatDuration, leafOf } from '../lib/meta.js';
import { buildKeymap } from '../lib/keys.js';

const api = window.termac;
const home = () => ui.get().home;
const RESTORED = (t) => `\r\n\x1b[2m──── restored · ${t} ────\x1b[0m\r\n`;

// ---- Persistence --------------------------------------------------------------------
let saveTimer = null;
let loaded = false;
app.subscribe(() => {
  if (!loaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.state.save(app.get()), 300);
});
function saveNow() {
  clearTimeout(saveTimer);
  api.state.save(app.get());
}

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
  if (meta.cwd) api.sys.gitBranch(meta.cwd).then((branch) => patchRt(sid, { branch }));
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
  let { cwd, command = '', host = '', spaceId, section = 'today', folderId = null, splitOf = null, edge = 'right', name = null, profileId = null, activate = true, viaRules = true, content = '' } = opts;
  const s0 = app.get();
  let targetSpace = s0.spaces.find((x) => x.id === spaceId) || activeSpace(s0);
  let dir = cwd ? expandHome(cwd, home()) : defaultCwd(targetSpace);
  let effects = {};
  let profile = profileId || targetSpace.profileId || s0.defaultProfileId;
  let ruleId = null;

  if (viaRules) {
    const m = route(s0.rules, { cwd: dir, command, host }, home());
    if (m) {
      const r = m.rule;
      ruleId = r.id;
      if (r.action?.type === 'space' && !spaceId) targetSpace = s0.spaces.find((x) => x.id === r.action.spaceId) || targetSpace;
      if (r.action?.type === 'split' && !splitOf && targetSpace.id === s0.activeSpaceId && activeTab(s0)) {
        splitOf = activeTabId(s0);
        edge = r.action.edge || 'right';
      }
      if (r.profileId) profile = r.profileId;
      if (!cwd && r.action?.type === 'space') dir = defaultCwd(targetSpace);
      effects = { ...(r.effects || {}) };
    }
  }

  const sid = uid('s');
  const now = Date.now();
  let tid = null;
  app.set((s) => {
    let next = { ...s, sessions: { ...s.sessions, [sid]: { id: sid, cwd: dir, profileId: profile, command, createdAt: now } } };
    if (ruleId) next.ruleHits = { ...next.ruleHits, [ruleId]: (next.ruleHits[ruleId] || 0) + 1 };
    const host = splitOf && next.tabs[splitOf];
    if (host && L.leaves(host.layout).length < L.MAX_PANES) {
      tid = splitOf;
      next.tabs = { ...next.tabs, [tid]: { ...host, layout: L.insert(host.layout, host.activeSid, sid, edge), activeSid: sid, effects: { ...host.effects, ...effects } } };
    } else {
      tid = uid('t');
      next.tabs = { ...next.tabs, [tid]: { id: tid, name, layout: L.leaf(sid), activeSid: sid, effects, createdAt: now } };
      next = attach(next, tid, { section, spaceId: targetSpace.id, folderId });
    }
    if (activate) next = setActiveTab(next, section === 'fav' ? next.activeSpaceId : spaceForTab(tid, next), tid);
    return next;
  });

  const h = reg.create(sid);
  if (content) h.term.write(content + RESTORED(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
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

export async function closePane(sid = focusedSid(), { force = false } = {}) {
  if (!sid) return;
  const r = rt.get()[sid];
  if (!force && r?.status === 'run') {
    const ok = await api.sys.confirm({ message: `Close “${r.command || 'this session'}”?`, detail: 'The running process will be stopped.', ok: 'Close' });
    if (!ok) return;
  }
  removeSessionFromTab(sid);
}

export function closeTab(tid) {
  const tab = app.get().tabs[tid];
  if (!tab) return;
  for (const sid of L.leaves(tab.layout)) removeSessionFromTab(sid);
}

function onExit(sid, exitCode) {
  const s = app.get();
  const tab = tabOfSession(sid, s);
  const loc = tab && locate(tab.id, s);
  const keep = loc && (loc.section === 'pinned' || loc.section === 'fav') && L.leaves(tab.layout).length === 1;
  if (keep) {
    reg.getHandle(sid)?.term.write(`\r\n\x1b[2m[process exited${exitCode ? ` with code ${exitCode}` : ''} — click to restart]\x1b[0m\r\n`);
    patchRt(sid, { alive: false, status: 'idle' });
  } else {
    removeSessionFromTab(sid);
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

export function updateSpace(id, patch) {
  app.set((s) => ({ ...s, spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, ...patch } : sp)) }));
}

export async function deleteSpace(id) {
  const s = app.get();
  if (s.spaces.length < 2) return;
  const sp = s.spaces.find((x) => x.id === id);
  const n = tabsOfSpace(sp).length;
  if (n) {
    const ok = await api.sys.confirm({ message: `Delete “${sp.name}”?`, detail: `Its ${n} session${n > 1 ? 's' : ''} will be moved to the Library.`, ok: 'Delete Space' });
    if (!ok) return;
    await commitArchive(tabsOfSpace(sp), 'closed');
  }
  app.set((st) => {
    const spaces = st.spaces.filter((x) => x.id !== id);
    const notes = { ...st.notes };
    delete notes[id];
    return { ...st, spaces, notes, activeSpaceId: st.activeSpaceId === id ? spaces[0].id : st.activeSpaceId };
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
  openTerminal({ cwd, splitOf: tab.id, edge, viaRules: false });
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

// Pull one pane out of a split into its own Today row.
export function unsplit(sid) {
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
    return attach(next, tid, { section: 'today', spaceId });
  });
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
  const tab = tabOfSession(sid);
  const r = rt.get()[sid];
  return { ...(tab?.effects || {}), ...(r?.sshEffects || {}) };
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
    const host = rt.get()[sid]?.dangerHost || 'production';
    confirmThen(sid, { title: `Run this on ${host}?`, detail: "You're about to run a privileged command on production.", label: 'Run', danger: true }, () => api.pty.write(sid, '\r'));
    return false;
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
    api.sys.gitBranch(cwd).then((branch) => patchRt(sid, { branch }));
    app.set((s) => {
      if (!s.sessions[sid]) return s;
      const recent = s.recentDirs.filter((d) => d.path !== cwd);
      const prev = s.recentDirs.find((d) => d.path === cwd);
      const recentDirs = cwd === home() ? s.recentDirs : [{ path: cwd, visits: (prev?.visits || 0) + 1, last: Date.now() }, ...recent].slice(0, 200);
      return { ...s, recentDirs, sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], cwd } } };
    });
  },
  commandStart(sid, cmd) {
    const s = app.get();
    const target = sshTarget(cmd);
    if (!target) return;
    const m = s.rules.find((r) => r.trigger?.type === 'ssh' && ruleMatches(r, { command: cmd }, home()));
    if (m?.effects && Object.values(m.effects).some(Boolean)) patchRt(sid, { sshEffects: m.effects, dangerHost: target.host });
  },
  commandEnd(sid, entry) {
    const s = app.get();
    const h = reg.getHandle(sid);
    const visible = !!h?.visible && document.hasFocus();
    const interrupted = entry.exit === 130;
    const failed = entry.exit !== 0 && !interrupted;
    const status = failed ? 'fail' : !interrupted && (entry.dur >= 3000 || !visible) ? 'ok' : 'idle';
    const patch = { status, exitCode: entry.exit, duration: entry.dur, endedAt: Date.now(), sshEffects: null, dangerHost: null };
    const ssh = sshTarget(entry.cmd);
    if (ssh && entry.exit === 255 && entry.dur > 5000) patch.dropped = { host: ssh.host, cmd: entry.cmd, at: Date.now(), dur: entry.dur };
    patchRt(sid, patch);
    const cwd = rt.get()[sid]?.cwd;
    if (cwd && /^git\s/.test(entry.cmd)) api.sys.gitBranch(cwd).then((branch) => patchRt(sid, { branch }));

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
        const r = rt.get()[sid];
        if (!h) return true;
        if (r?.status === 'run' || (r?.proc && r.proc !== h.shell && r.proc !== 'login' && h.alive)) return false;
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
      if (h) await api.library.add(entry, reg.serializeBuffer(sid, 5000));
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

export function archiveTab(tid) {
  tidy([tid], { reason: 'closed' });
}

export async function restoreFromLibrary(entry, spaceId = entry.spaceId) {
  const content = await api.library.content(entry.id);
  const s = app.get();
  const target = s.spaces.some((x) => x.id === spaceId) ? spaceId : s.activeSpaceId;
  openTerminal({ cwd: entry.cwd, spaceId: target, content, viaRules: false, name: null });
  await api.library.remove(entry.id);
}

// ---- Snippets, notes, rules, profiles, settings -------------------------------------
export function addSnippet({ name, command, spaceId = app.get().activeSpaceId }) {
  const clean = name.replace(/^\/+/, '').trim().replace(/\s+/g, '-') || 'snippet';
  app.set((s) => ({ ...s, snippets: [...s.snippets.filter((x) => !(x.name === clean && x.spaceId === spaceId)), { id: uid('sn'), name: clean, command, spaceId, createdAt: Date.now() }] }));
  toast({ title: `Saved /${clean}`, detail: 'It now shows up in the command bar.' });
}

export function removeSnippet(id) {
  app.set((s) => ({ ...s, snippets: s.snippets.filter((x) => x.id !== id) }));
}

export function setNotes(spaceId, text) {
  app.set((s) => ({ ...s, notes: { ...s.notes, [spaceId]: text } }));
}

export function setRules(rules) {
  app.set((s) => ({ ...s, rules }));
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
  const termTheme = reg.configure(s.settings, ui.get().dark);
  ui.set((u) => (u.termTheme === termTheme ? u : { ...u, termTheme }));
  keymap = buildKeymap(s.settings.keybindings);
  api.app.setMenu(s.settings.keybindings);
}

export function zoom(delta) {
  const size = app.get().settings.fontSize;
  setSettings({ fontSize: delta === 0 ? 13 : Math.min(28, Math.max(9, size + delta)) });
}

// ---- Boot, quit ---------------------------------------------------------------------
export async function boot() {
  const { state, home: homeDir, dark } = await api.state.load();
  ui.set((u) => ({ ...u, home: homeDir, dark }));
  let s = migrate(state);

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

  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const favSids = new Set(s.favorites.flatMap((tid) => L.leaves(tabs[tid]?.layout)));
  await Promise.all(
    Object.keys(sessions).map(async (sid) => {
      const h = reg.create(sid);
      const content = await api.scrollback.load(sid);
      if (content) h.term.write(content + RESTORED(stamp));
      patchRt(sid, { cwd: sessions[sid].cwd, status: 'idle' });
      if (favSids.has(sid)) startSession(sid);
    }),
  );
  syncFocus();
  api.sys.sshHosts().then((sshHosts) => ui.set((u) => ({ ...u, sshHosts })));
  setInterval(() => tidy(), 5 * 60 * 1000);
  setTimeout(() => tidy(), 30 * 1000);
  return s;
}

export async function prepareQuit({ running }) {
  const s = app.get();
  if (s.settings.confirmQuit && running > 0) {
    const ok = await api.sys.confirm({ message: `Quit Termac with ${running} running process${running > 1 ? 'es' : ''}?`, detail: 'Running commands will be stopped. Sessions and scrollback are restored next launch.', ok: 'Quit' });
    if (!ok) return api.app.quitCancel();
  }
  const writes = [];
  for (const h of reg.allHandles()) {
    if (s.sessions[h.sid]) writes.push(api.scrollback.save(h.sid, reg.serializeBuffer(h.sid, 3000)));
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
