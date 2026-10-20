// One xterm instance per session, kept alive while the session lives. Terminals that
// aren't on screen sit in an off-screen parking lot where xterm pauses rendering; only
// visible terminals hold a WebGL context.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { patchRt, rt } from '../state/model.js';
import { TERMINAL_THEMES } from '../lib/termtheme.js';

const api = window.termac;

export const THEMES = TERMINAL_THEMES;

const handles = new Map();
let parking = null;
let hooks = {};
let termOptions = {};
let themeName = 'dark';

export const setHooks = (h) => (hooks = h);
export const getHandle = (sid) => handles.get(sid);
export const allHandles = () => handles.values();
export const themeColors = () => THEMES[themeName];

function parkingLot() {
  if (!parking) {
    parking = document.createElement('div');
    parking.className = 'term-parking';
    document.body.appendChild(parking);
  }
  return parking;
}

// ---- IPC fan-in ---------------------------------------------------------------------
api.pty.onData((batch) => {
  for (const [id, data] of batch) {
    const h = handles.get(id);
    if (!h) {
      api.pty.ack(id, data.length);
      continue;
    }
    h.lastActivity = Date.now();
    h.term.write(data, () => api.pty.ack(id, data.length));
    hooks.output?.(id);
  }
});
api.pty.onExit(({ id, exitCode }) => {
  const h = handles.get(id);
  if (h) h.alive = false;
  hooks.exit?.(id, exitCode);
});
api.pty.onProc(({ id, proc }) => {
  const h = handles.get(id);
  if (!h) return;
  const patch = { proc };
  if (!h.integrated) patch.status = proc === h.shell || proc === 'login' ? 'idle' : 'run';
  patchRt(id, patch);
});

// ---- Options ------------------------------------------------------------------------
export function configure(settings, dark) {
  themeName = settings.termTheme === 'system' ? (dark ? 'dark' : 'light') : settings.termTheme;
  termOptions = {
    fontFamily: /monospace\s*$/.test(settings.fontFamily) ? settings.fontFamily : `${settings.fontFamily}, 'SF Mono', Menlo, monospace`,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    macOptionIsMeta: settings.optionAsMeta,
    theme: THEMES[themeName],
  };
  for (const h of handles.values()) {
    for (const [k, v] of Object.entries(termOptions)) {
      if (k === 'theme' && h.look) continue;
      if (h.term.options[k] !== v) h.term.options[k] = v;
    }
    if (h.visible) fit(h.sid);
  }
  return themeName;
}

// ---- Lifecycle ----------------------------------------------------------------------
export function create(sid) {
  if (handles.has(sid)) return handles.get(sid);
  const term = new Terminal({
    ...termOptions,
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    smoothScrollDuration: 0,
    scrollOnUserInput: true,
  });
  const fitAddon = new FitAddon();
  const serialize = new SerializeAddon();
  const search = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(serialize);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((e, uri) => (e.metaKey ? api.sys.openExternal(uri) : null)));

  const el = document.createElement('div');
  el.className = 'term-host';
  el.dataset.sid = sid;
  parkingLot().appendChild(el);
  term.open(el);

  const h = {
    sid,
    term,
    el,
    fit: fitAddon,
    serialize,
    search,
    webgl: null,
    visible: false,
    alive: false,
    started: false,
    integrated: false,
    shell: '',
    lastActivity: Date.now(),
    pendingCmd: '',
    cmds: [],
    newLines: 0,
  };
  handles.set(sid, h);

  term.parser.registerOscHandler(633, (data) => {
    onShellMark(h, data);
    return true;
  });
  term.onData((d) => hooks.input?.(sid, d));
  term.onBinary((d) => api.pty.write(sid, d));
  term.onResize(({ cols, rows }) => {
    api.pty.resize(sid, cols, rows);
    patchRt(sid, { cols, rows });
  });
  term.onBell(() => hooks.bell?.(sid));
  term.attachCustomKeyEventHandler((e) => hooks.key?.(sid, e) ?? true);
  term.textarea?.addEventListener('focus', () => hooks.focus?.(sid));

  let scrollTimer = null;
  const updateScroll = () => {
    scrollTimer = null;
    const b = term.buffer.active;
    const up = b.viewportY < b.baseY;
    if (!up) h.newLines = 0;
    patchRt(sid, { scrolledUp: up, newLines: h.newLines });
  };
  term.onScroll(() => {
    if (!scrollTimer) scrollTimer = setTimeout(updateScroll, 120);
  });
  term.onLineFeed(() => {
    const b = term.buffer.active;
    if (b.viewportY < b.baseY) {
      h.newLines++;
      if (!scrollTimer) scrollTimer = setTimeout(updateScroll, 250);
    }
  });
  return h;
}

// Spawns the PTY for a handle. Called lazily the first time a session is shown.
export async function start(sid, { cwd, profile, spaceName, initialCommand }) {
  const h = handles.get(sid);
  if (!h || h.alive) return;
  h.started = true;
  h.alive = true;
  const { cols, rows } = h.term;
  const res = await api.pty.spawn({ id: sid, cwd, cols, rows, profile, spaceName, initialCommand });
  if (!res?.ok) {
    h.alive = false;
    h.term.write(`\r\n\x1b[31mCould not start shell: ${res?.error || 'unknown error'}\x1b[0m\r\n`);
    patchRt(sid, { status: 'fail', alive: false });
    return;
  }
  h.integrated = !!res.integrated;
  h.shell = res.shell;
  patchRt(sid, { shell: res.shell, proc: res.shell, alive: true, integrated: h.integrated, status: rt.get()[sid]?.status === 'fail' ? 'fail' : 'idle' });
}

export function dispose(sid) {
  const h = handles.get(sid);
  if (!h) return;
  if (h.alive) api.pty.kill(sid);
  h.webgl?.dispose();
  h.term.dispose();
  h.el.remove();
  handles.delete(sid);
  rt.set((s) => {
    if (!s[sid]) return s;
    const { [sid]: _, ...rest } = s;
    return rest;
  });
}

// ---- Visibility ---------------------------------------------------------------------
export function mount(sid, container) {
  const h = handles.get(sid);
  if (!h) return;
  if (h.el.parentNode !== container) container.appendChild(h.el);
  h.visible = true;
  attachWebgl(h);
  fit(sid);
}

function attachWebgl(h) {
  if (h.webgl) return;
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => {
      w.dispose();
      h.webgl = null;
    });
    h.term.loadAddon(w);
    h.webgl = w;
  } catch {
    h.webgl = null; // DOM renderer fallback
  }
}

// Applies a Space's terminal look (see lib/termtheme.js) to one session.
export function setLook(sid, look) {
  const h = handles.get(sid);
  if (!h || h.look?.key === look.key) return;
  h.look = look;
  if (!!h.term.options.allowTransparency !== look.transparent) {
    h.term.options.allowTransparency = look.transparent;
    if (h.webgl) {
      h.webgl.dispose();
      h.webgl = null;
      if (h.visible) attachWebgl(h);
    }
  }
  h.term.options.theme = look.xterm;
}

export function unmount(sid, container) {
  const h = handles.get(sid);
  if (!h || h.el.parentNode !== container) return;
  parkingLot().appendChild(h.el);
  h.visible = false;
  h.webgl?.dispose();
  h.webgl = null;
}

export function fit(sid) {
  const h = handles.get(sid);
  if (!h?.el.parentNode || h.el.parentNode === parking) return;
  try {
    h.fit.fit();
  } catch {
    /* not measurable yet */
  }
}

export function focus(sid) {
  handles.get(sid)?.term.focus();
}

// ---- Shell integration marks --------------------------------------------------------
function onShellMark(h, data) {
  const sep = data.indexOf(';');
  const code = sep === -1 ? data : data.slice(0, sep);
  const arg = sep === -1 ? '' : data.slice(sep + 1);
  h.integrated = true;
  const now = Date.now();
  switch (code) {
    case 'E':
      h.pendingCmd = arg.trim();
      break;
    case 'C': {
      const cmd = h.pendingCmd;
      h.pendingCmd = '';
      const entry = { cmd, at: now, start: h.term.registerMarker(0), end: null, exit: null, dur: null };
      h.cmds.push(entry);
      if (h.cmds.length > 200) h.cmds.shift()?.start?.dispose();
      patchRt(h.sid, { status: 'run', command: cmd, cmdStart: now, exitCode: null, dropped: null });
      hooks.commandStart?.(h.sid, cmd);
      break;
    }
    case 'D': {
      const exit = Number.parseInt(arg, 10) || 0;
      const entry = h.cmds[h.cmds.length - 1];
      if (!entry || entry.end) break;
      entry.end = h.term.registerMarker(0);
      entry.exit = exit;
      entry.dur = now - entry.at;
      hooks.commandEnd?.(h.sid, entry);
      break;
    }
    case 'P': {
      const m = /^Cwd=(.*)$/.exec(arg);
      if (m) hooks.cwd?.(h.sid, m[1]);
      break;
    }
    default:
      break;
  }
}

// ---- Reading the buffer -------------------------------------------------------------
export function lastFinished(sid) {
  const h = handles.get(sid);
  if (!h) return null;
  for (let i = h.cmds.length - 1; i >= 0; i--) if (h.cmds[i].end) return h.cmds[i];
  return null;
}

export function outputOf(sid, entry) {
  const h = handles.get(sid);
  if (!h || !entry?.start || entry.start.isDisposed || !entry.end) return null;
  const b = h.term.buffer.active;
  const lines = [];
  for (let y = entry.start.line; y < entry.end.line; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

export function flashRange(sid, entry) {
  const h = handles.get(sid);
  if (!h || !entry?.start || !entry.end) return;
  const height = Math.max(1, entry.end.line - entry.start.line);
  const deco = h.term.registerDecoration({ marker: entry.start, width: h.term.cols, height, backgroundColor: (h.look ? h.look.dark : themeName === 'dark') ? '#88adff' : '#2b5bc7', layer: 'bottom' });
  if (deco) {
    deco.onRender((el) => (el.style.opacity = '0.18'));
    setTimeout(() => deco.dispose(), 700);
  }
}

export function scrollToEntry(sid, entry) {
  const h = handles.get(sid);
  if (!h || !entry?.start || entry.start.isDisposed) return;
  h.term.scrollToLine(Math.max(0, entry.start.line - 1));
}

// Text of the line the cursor is on (used by the production guard rail).
export function cursorLine(sid) {
  const h = handles.get(sid);
  if (!h) return '';
  const b = h.term.buffer.active;
  let y = b.baseY + b.cursorY;
  let text = b.getLine(y)?.translateToString(true) ?? '';
  while (y > 0 && b.getLine(y)?.isWrapped) text = (b.getLine(--y)?.translateToString(true) ?? '') + text;
  return text;
}

export function serializeBuffer(sid, scrollback = 3000) {
  const h = handles.get(sid);
  if (!h) return '';
  try {
    return h.serialize.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true });
  } catch {
    return '';
  }
}

export function plainTail(sid, n = 40) {
  const h = handles.get(sid);
  if (!h) return '';
  const b = h.term.buffer.active;
  const end = b.baseY + b.cursorY;
  const out = [];
  for (let y = Math.max(0, end - n); y <= end; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
  return out.join('\n');
}

// Last `n` non-empty lines as colored spans, for Peek. Reads cells directly — no reflow.
export function peekLines(sid, n = 12) {
  const h = handles.get(sid);
  if (!h) return [];
  const b = h.term.buffer.active;
  let end = b.baseY + b.cursorY;
  while (end > 0 && !(b.getLine(end)?.translateToString(true) ?? '').trim()) end--;
  const start = Math.max(0, end - n + 1);
  const pal = h.look?.xterm || THEMES[themeName];
  const ansi = [pal.black, pal.red, pal.green, pal.yellow, pal.blue, pal.magenta, pal.cyan, pal.white, pal.brightBlack, pal.brightRed, pal.brightGreen, pal.brightYellow, pal.brightBlue, pal.brightMagenta, pal.brightCyan, pal.brightWhite];
  const color = (mode, v) => {
    if (mode === 'rgb') return `#${v.toString(16).padStart(6, '0')}`;
    if (mode === 'p') {
      if (v < 16) return ansi[v];
      if (v >= 232) {
        const g = 8 + (v - 232) * 10;
        return `rgb(${g},${g},${g})`;
      }
      const i = v - 16;
      const c = (x) => (x ? 55 + x * 40 : 0);
      return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
    }
    return null;
  };
  const lines = [];
  const cell = b.getNullCell();
  for (let y = start; y <= end; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const spans = [];
    const width = line.translateToString(true).length;
    for (let x = 0; x < width; x++) {
      line.getCell(x, cell);
      const chars = cell.getChars() || ' ';
      if (cell.getWidth() === 0) continue;
      const fg = cell.isFgRGB() ? color('rgb', cell.getFgColor()) : cell.isFgPalette() ? color('p', cell.getFgColor()) : null;
      const bold = !!cell.isBold();
      const dim = !!cell.isDim();
      const last = spans[spans.length - 1];
      if (last && last.fg === fg && last.bold === bold && last.dim === dim) last.text += chars;
      else spans.push({ text: chars, fg, bold, dim });
    }
    lines.push(spans);
  }
  return lines;
}

export function clear(sid) {
  handles.get(sid)?.term.clear();
}
