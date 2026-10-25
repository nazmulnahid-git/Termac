// Quick Terminal: a frameless panel dropped from the top of the screen on ⌥Space.
// It reads (never writes) the persisted state and owns one live session at a time.
import './bridge.js';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import './styles/quick.css';
import { app, rt, ui, migrate, patchRt } from './state/model.js';
import { createStore } from './state/store.js';
import * as reg from './term/registry.js';
import { StatusMark } from './components/common.jsx';
import { uid, splitCwd, sessionName, leafOf } from './lib/meta.js';
import { sshTarget } from './lib/routing.js';
import { applyFontVars } from './lib/fonts.js';
import { formatAccel } from './lib/keys.js';

const api = window.termac;
const ARCHIVE_AFTER_MS = 10 * 60 * 1000;
const LAST_CWD_KEY = 'termac.quick.lastCwd';

// sid: live session, startCwd: where it was spawned, menu: Move-to-Space dropdown open.
const q = createStore({ sid: null, startCwd: '', startedAt: 0, visible: false, menu: false });

let slotEl = null;
let archiveTimer = null;
let pending = null;
let booted = false;
let sawVisibility = false;

const readLastCwd = () => {
  try {
    return localStorage.getItem(LAST_CWD_KEY) || '';
  } catch {
    return '';
  }
};
const writeLastCwd = (cwd) => {
  try {
    localStorage.setItem(LAST_CWD_KEY, cwd);
  } catch {
    /* storage unavailable */
  }
};

function defaultProfile() {
  const s = app.get();
  const p = s.profiles.find((x) => x.id === s.defaultProfileId) || s.profiles[0];
  return { command: p?.command || '', env: Object.fromEntries((p?.env || []).filter(([k]) => k)), startup: p?.startup || '' };
}

function applyTheme() {
  applyFontVars(app.get().settings);
  const termTheme = reg.configure(app.get().settings, ui.get().dark);
  ui.set((u) => (u.termTheme === termTheme ? u : { ...u, termTheme }));
}

// ---- Session lifecycle --------------------------------------------------------------
async function ensureSession(cwdHint) {
  const cur = q.get().sid;
  if (cur && reg.getHandle(cur)) return cur;
  if (pending) return pending;
  pending = (async () => {
    let cwd = cwdHint || '';
    if (!cwd) {
      const last = readLastCwd();
      if (last && (await api.sys.isDir(last).catch(() => false))) cwd = last;
    }
    cwd = cwd || ui.get().home;
    const sid = uid('q');
    reg.create(sid);
    q.set((st) => ({ ...st, sid, startCwd: cwd, startedAt: Date.now() }));
    patchRt(sid, { cwd, status: 'idle' });
    if (slotEl) reg.mount(sid, slotEl); // size the terminal before the pty spawns
    await reg.start(sid, { cwd, profile: defaultProfile(), spaceName: '', initialCommand: '' });
    return sid;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// kill=false leaves the pty running (it now belongs to the main window).
function endSession({ kill }) {
  const { sid } = q.get();
  if (!sid) return;
  const h = reg.getHandle(sid);
  if (h && !kill) h.alive = false;
  if (slotEl) reg.unmount(sid, slotEl);
  reg.dispose(sid);
  q.set((st) => ({ ...st, sid: null, menu: false }));
}

function show(cwd) {
  clearTimeout(archiveTimer);
  q.set((st) => ({ ...st, visible: true }));
  ensureSession(cwd).then((sid) => {
    const h = reg.getHandle(sid);
    if (!h) return;
    if (!h.integrated && h.alive) api.pty.cwd(sid).then((c) => c && patchRt(sid, { cwd: c }));
    requestAnimationFrame(() => {
      reg.fit(sid);
      reg.focus(sid);
    });
  });
}

function hide() {
  q.set((st) => ({ ...st, visible: false, menu: false }));
  clearTimeout(archiveTimer);
  if (q.get().sid) archiveTimer = setTimeout(archiveQuick, ARCHIVE_AFTER_MS);
}

async function archiveQuick() {
  const { sid, visible, startCwd, startedAt } = q.get();
  if (!sid || visible) return;
  const h = reg.getHandle(sid);
  const r = rt.get()[sid] || {};
  if (r.status === 'run' && app.get().settings.neverArchiveRunning) {
    archiveTimer = setTimeout(archiveQuick, ARCHIVE_AFTER_MS);
    return;
  }
  const home = ui.get().home;
  const cmds = (h?.cmds || []).filter((c) => c.cmd).map((c) => ({ cmd: c.cmd, exit: c.exit, at: c.at }));
  // A panel that was opened and dismissed without running anything isn't worth keeping.
  if (h && (cmds.length || !h.integrated)) {
    const ssh = [...cmds].reverse().map((c) => sshTarget(c.cmd)).find(Boolean);
    const lastExit = [...cmds].reverse().find((c) => c.exit != null)?.exit;
    const cwd = r.cwd || startCwd || home;
    const entry = {
      id: sid,
      name: sessionName(null, r, home) || leafOf(cwd, home),
      spaceId: null,
      spaceName: 'Quick Terminal',
      cwd,
      host: ssh?.host || 'local',
      status: lastExit == null ? 'idle' : lastExit === 0 ? 'ok' : 'fail',
      exitCode: lastExit ?? null,
      startedAt: startedAt || Date.now(),
      endedAt: Date.now(),
      idleSince: h.lastActivity || Date.now(),
      reason: 'quick',
      commands: cmds.slice(-100),
      lines: h.term.buffer.active.length,
    };
    await api.library.add(entry, reg.serializeBuffer(sid, 5000)).catch(() => {});
  }
  if (q.get().sid === sid && !q.get().visible) endSession({ kill: true });
}

async function moveTo(spaceId, pinned = false) {
  const { sid, startCwd } = q.get();
  const h = reg.getHandle(sid);
  if (!h?.alive) return;
  q.set((st) => ({ ...st, menu: false }));
  const r = rt.get()[sid] || {};
  // Freeze output, let everything already sent land in the buffer, then snapshot it.
  await api.pty.hold(sid);
  await new Promise((resolve) => h.term.write('', resolve));
  const content = reg.serializeBuffer(sid, 5000);
  const ok = await api.quick.promote({
    sessionId: sid,
    spaceId,
    pinned,
    content,
    cwd: r.cwd || startCwd,
    meta: { shell: h.shell, integrated: h.integrated, status: r.status || 'idle', command: r.command || '' },
  });
  if (!ok) return api.pty.release(sid);
  clearTimeout(archiveTimer);
  endSession({ kill: false });
}

// ---- Registry hooks -----------------------------------------------------------------
reg.setHooks({
  input: (sid, data) => api.pty.write(sid, data),
  cwd: (sid, cwd) => {
    patchRt(sid, { cwd });
    if (sid === q.get().sid) writeLastCwd(cwd);
  },
  commandStart: (sid, command) => patchRt(sid, { status: 'run', command }),
  commandEnd: (sid, entry) => patchRt(sid, { status: entry.exit ? 'fail' : 'ok', exitCode: entry.exit, duration: entry.dur, endedAt: Date.now() }),
  exit: (sid) => {
    if (sid !== q.get().sid) return;
    endSession({ kill: false });
    if (q.get().visible) api.quick.hide();
  },
});

// Registered before boot so the first show (sent while the page loads) isn't lost.
api.quick.onVisibility(({ visible, cwd }) => {
  sawVisibility = true;
  if (!booted) {
    q.set((st) => ({ ...st, visible, bootCwd: cwd }));
    return;
  }
  if (visible) show(cwd);
  else hide();
});

// ---- UI -----------------------------------------------------------------------------
let fitRaf = 0;
const slotObserver = new ResizeObserver(() => {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => q.get().sid && reg.fit(q.get().sid));
});

// Stable ref callback: the slot element lives as long as the window does.
function setSlot(el) {
  if (!el || el === slotEl) return;
  if (slotEl) slotObserver.unobserve(slotEl);
  slotEl = el;
  slotObserver.observe(el);
  const cur = q.get().sid;
  if (cur) reg.mount(cur, el);
}

function Quick() {
  const sid = q.use((s) => s.sid);
  const menu = q.use((s) => s.menu);
  const theme = ui.use((s) => s.termTheme);
  const home = ui.use((s) => s.home);
  const cwd = rt.use((s) => (sid ? s[sid]?.cwd : null)) || q.get().startCwd || home;
  const status = rt.use((s) => (sid ? s[sid]?.status : null)) || 'idle';
  const hotkey = app.use((s) => s.settings.keybindings.quickTerminal);
  const { dir, leaf } = splitCwd(cwd, home);

  return (
    <div className={`qt t-${theme}`}>
      <div className="qt-head">
        <StatusMark status={status} />
        <span className="qt-cwd ellipsis">
          <span>{dir}</span>
          <b>{leaf}</b>
        </span>
        <span className="grow" />
        <button className={`qt-move${menu ? ' on' : ''}`} disabled={!sid} onClick={() => q.set((st) => ({ ...st, menu: !st.menu }))}>
          ↗ Move to Space <span className="qt-caret">▾</span>
        </button>
        <button className="qt-hint" title="Hide" onClick={() => api.quick.hide()}>
          {formatAccel(hotkey || 'Alt+Space')}
        </button>
      </div>
      <div className="qt-term" onMouseDown={() => menu && q.set((st) => ({ ...st, menu: false }))}>
        <div className="qt-slot" ref={setSlot} />
      </div>
      {menu && <MoveMenu />}
    </div>
  );
}

function MoveMenu() {
  const spaces = app.use((s) => s.spaces);
  const activeId = app.use((s) => s.activeSpaceId);
  const current = spaces.find((x) => x.id === activeId) || spaces[0];
  const [sel, setSel] = useState(0);
  const count = spaces.length + 1; // + "Keep pinned in …"

  const pick = (i) => {
    if (i < spaces.length) moveTo(spaces[i].id, false);
    else if (current) moveTo(current.id, true);
  };

  useEffect(() => {
    const onKey = (e) => {
      let handled = true;
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const i = Number(e.code.slice(5)) - 1;
        if (i < spaces.length) pick(i);
      } else if (e.key === 'Escape') {
        q.set((st) => ({ ...st, menu: false }));
        reg.focus(q.get().sid);
      }
      else if (e.key === 'ArrowDown') setSel((n) => (n + 1) % count);
      else if (e.key === 'ArrowUp') setSel((n) => (n - 1 + count) % count);
      else if (e.key === 'Enter') pick(sel);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="qt-menu" onMouseLeave={() => setSel(-1)}>
      {spaces.map((sp, i) => (
        <button key={sp.id} className={`qt-item${sel === i ? ' sel' : ''}`} style={{ '--c': sp.color }} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
          <span className="qt-glyph">{sp.glyph}</span>
          <span className="grow ellipsis">{sp.name}</span>
          {i < 9 && <kbd>⌃{i + 1}</kbd>}
        </button>
      ))}
      <div className="qt-sep" />
      {current && (
        <button className={`qt-item${sel === spaces.length ? ' sel' : ''}`} style={{ '--c': current.color }} onMouseEnter={() => setSel(spaces.length)} onClick={() => pick(spaces.length)}>
          <span className="grow ellipsis qt-dimtxt">Keep pinned in {current.name}…</span>
        </button>
      )}
    </div>
  );
}

// ---- Boot ---------------------------------------------------------------------------
async function boot() {
  document.body.classList.add('quick-body');
  const { state, home, dark } = await api.state.load();
  ui.set((u) => ({ ...u, home, dark }));
  app.set(migrate(state));
  applyTheme();

  api.state.onChanged(({ spaces, settings, profiles, activeSpaceId, defaultProfileId }) => {
    const prev = app.get().settings;
    app.set((s) => ({
      ...s,
      spaces: spaces?.length ? spaces : s.spaces,
      settings: settings ? { ...s.settings, ...settings } : s.settings,
      profiles: profiles?.length ? profiles : s.profiles,
      activeSpaceId: activeSpaceId || s.activeSpaceId,
      defaultProfileId: defaultProfileId || s.defaultProfileId,
      activeSpaceId: spaces?.some((x) => x.id === s.activeSpaceId) ? s.activeSpaceId : spaces?.[0]?.id || s.activeSpaceId,
    }));
    if (app.get().settings !== prev) applyTheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    ui.set((u) => ({ ...u, dark: e.matches }));
    applyTheme();
  });

  createRoot(document.getElementById('root')).render(<Quick />);
  booted = true;

  // Replay a show that arrived while loading, or recover if it was sent before we listened.
  const early = q.get();
  if (early.visible) show(early.bootCwd);
  else if (!sawVisibility && document.visibilityState === 'visible') show(null);
}

boot();
