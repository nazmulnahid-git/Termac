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
import { monoStack } from '../lib/fonts.js';

const api = window.termac;

export const THEMES = TERMINAL_THEMES;

const handles = new Map();
let parking = null;
let hooks = {};
let termOptions = {};
let themeName = 'dark';
let clickToMove = true;
let ownPrompt = true;

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
  clickToMove = settings.clickToMove !== false;
  ownPrompt = settings.promptStyle !== 'shell';
  termOptions = {
    fontFamily: monoStack(settings.fontFamily),
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    fontWeight: settings.fontWeight,
    fontWeightBold: settings.fontWeightBold,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    macOptionIsMeta: settings.optionAsMeta,
    // With Termorc's input bar, the terminal only has focus while a command runs; hide the
    // idle cursor so it doesn't sit on the blank prompt line.
    cursorInactiveStyle: ownPrompt ? 'none' : 'outline',
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
    ownPrompt: false, // this session's shell runs with its prompt blanked (TERMORC_PROMPT)
    atPrompt: false, // the shell is waiting at a prompt (between marks A and C)
    composer: null, // the input bar's textarea, while one is mounted for this session
    promptMarker: null,
  };
  handles.set(sid, h);

  term.parser.registerOscHandler(633, (data) => {
    onShellMark(h, data);
    return true;
  });
  term.onData((d) => {
    // At a prompt the input bar owns typing; keys that reach the terminal go there instead.
    if (composerActive(h)) {
      hooks.composerInput?.(sid, d);
      return;
    }
    // The first keystroke after a prompt marks where the editable input begins: the cursor
    // hasn't moved yet, so it's sitting right after the prompt.
    if (h.awaitInput) {
      h.awaitInput = false;
      h.inputStart?.marker.dispose();
      const b = term.buffer.active;
      h.inputStart = b.type === 'normal' ? { marker: term.registerMarker(0), x: b.cursorX } : null;
    }
    hooks.input?.(sid, d);
  });
  let down = null;
  el.addEventListener(
    'mousedown',
    (e) => {
      down = e.button === 0 && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey ? { x: e.clientX, y: e.clientY } : null;
    },
    true
  );
  el.addEventListener(
    'mouseup',
    (e) => {
      const d = down;
      down = null;
      if (d && e.detail === 1 && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 3) moveCursorTo(h, e.clientX, e.clientY);
    },
    true
  );
  term.onBinary((d) => api.pty.write(sid, d));
  term.onResize(({ cols, rows }) => {
    api.pty.resize(sid, cols, rows);
    patchRt(sid, { cols, rows });
  });
  term.onBell(() => hooks.bell?.(sid));
  term.buffer.onBufferChange((b) => patchRt(sid, { alt: b.type === 'alternate' }));
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
// `inputBar: false` keeps the shell's own prompt (the Quick Terminal has no input bar).
export async function start(sid, { cwd, profile, spaceName, initialCommand, inputBar = true }) {
  const h = handles.get(sid);
  if (!h || h.alive) return;
  h.started = true;
  h.alive = true;
  const { cols, rows } = h.term;
  h.ownPrompt = ownPrompt && inputBar;
  const res = await api.pty.spawn({ id: sid, cwd, cols, rows, profile, spaceName, initialCommand, ownPrompt: h.ownPrompt });
  if (!res?.ok) {
    h.alive = false;
    h.term.write(`\r\n\x1b[31mCould not start shell: ${res?.error || 'unknown error'}\x1b[0m\r\n`);
    patchRt(sid, { status: 'fail', alive: false });
    return;
  }
  h.integrated = !!res.integrated;
  h.shell = res.shell;
  if (!h.integrated) h.ownPrompt = false;
  patchRt(sid, { shell: res.shell, proc: res.shell, alive: true, integrated: h.integrated, ownPrompt: h.ownPrompt, status: rt.get()[sid]?.status === 'fail' ? 'fail' : 'idle' });
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
    patchRectangles(w);
  } catch {
    h.webgl = null; // DOM renderer fallback
  }
}

// The WebGL addon draws a "default background" rectangle under dim/italic cells (those
// flags live in the bg word) and forces it opaque, so with a transparent theme (image
// looks) faint text sits on black boxes. Collapse those rectangles to zero width; the
// cleared canvas already is the background. Patched once on the shared prototype.
let rectanglesPatched = false;
function patchRectangles(w) {
  if (rectanglesPatched) return;
  const proto = w._renderer?._rectangleRenderer?.value && Object.getPrototypeOf(w._renderer._rectangleRenderer.value);
  if (typeof proto?._updateRectangle !== 'function') return;
  rectanglesPatched = true;
  const update = proto._updateRectangle;
  proto._updateRectangle = function (vertices, offset, fg, bg, startX, endX, y) {
    update.call(this, vertices, offset, fg, bg, startX, endX, y);
    const inverse = fg & 0x4000000;
    const defaultBg = (bg & 0x3000000) === 0;
    if (!inverse && defaultBg && (this._themeService.colors.background.rgba & 0xff) < 0xff) vertices.attributes[offset + 2] = 0;
  };
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
  const h = handles.get(sid);
  if (!h) return;
  if (composerActive(h)) h.composer.focus();
  else h.term.focus();
}

// ---- Input bar ------------------------------------------------------------------------
// Sessions started with Termorc's prompt take input from the input bar while the shell is
// at a prompt; once a command runs (or a full-screen app opens), keys go to the terminal.
export const composerActive = (h) => !!(h?.ownPrompt && h.atPrompt && h.composer?.isConnected && h.term.buffer.active.type === 'normal');

export function setComposer(sid, el) {
  const h = handles.get(sid);
  if (h) h.composer = el;
}

export function commandsOf(sid) {
  return handles.get(sid)?.cmds || [];
}

// Block headers: the line each command was typed on gets a tinted band, a hairline above
// it, and (once it finishes) its status, duration and time on the right. A failed block
// gets a red edge down its whole output.
function mixHex(a, b, t) {
  const p = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function themeOf(h) {
  return h.look?.xterm?.background?.startsWith('#') && h.look.xterm.background.length === 7 ? h.look.xterm : THEMES[themeName];
}

function decorateHead(h, entry) {
  const t = themeOf(h);
  const marker = entry.head;
  if (!marker || marker.isDisposed) return;
  const band = h.term.registerDecoration({ marker, width: h.term.cols, backgroundColor: mixHex(t.background, t.foreground, 0.055), layer: 'bottom' });
  const top = h.term.registerDecoration({ marker, width: h.term.cols, layer: 'top' });
  entry.decos = [band, top].filter(Boolean);
  top?.onRender((el) => {
    el.classList.add('blk-head');
    el.style.width = '100%';
    if (!el.firstChild) {
      const meta = document.createElement('span');
      meta.className = 'blk-meta';
      el.appendChild(meta);
    }
    entry.metaEl = el.firstChild;
    paintMeta(entry);
  });
}

function paintMeta(entry) {
  const meta = entry.metaEl;
  if (!meta) return;
  const text = blockMeta(entry);
  if (meta.textContent !== text) meta.textContent = text;
  meta.dataset.state = entry.exit == null ? 'run' : entry.exit === 0 ? 'ok' : entry.exit === 130 ? 'int' : 'fail';
}

function decorateEnd(h, entry) {
  paintMeta(entry);
  if (!entry.head || entry.head.isDisposed || entry.exit === 0 || entry.exit === 130) return;
  const height = Math.max(1, entry.end.line - entry.head.line);
  const edge = h.term.registerDecoration({ marker: entry.head, width: h.term.cols, height, layer: 'top' });
  edge?.onRender((el) => {
    el.classList.add('blk-fail');
    el.style.width = '100%';
  });
  if (edge) entry.decos.push(edge);
}

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
function blockMeta(e) {
  const dur = e.dur == null ? '' : e.dur < 1000 ? `${e.dur}ms` : e.dur < 60000 ? `${(e.dur / 1000).toFixed(1)}s` : `${Math.floor(e.dur / 60000)}m ${Math.round((e.dur % 60000) / 1000)}s`;
  const status = e.exit == null ? '' : e.exit === 0 ? '✓' : e.exit === 130 ? '⌃C' : `✗ ${e.exit}`;
  // Running blocks show when they started; finished ones how long they took and how it went.
  return e.exit == null ? `started ${clock(e.at)}` : [dur, status].filter(Boolean).join('  ');
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
    case 'A':
      h.awaitInput = true;
      h.inputStart?.marker.dispose();
      h.inputStart = null;
      h.atPrompt = true;
      // The prompt line is where the command will be echoed: the block's header line.
      if (!h.promptMarker?.isDisposed) h.promptMarker?.dispose();
      h.promptMarker = h.term.registerMarker(0);
      patchRt(h.sid, { atPrompt: true });
      break;
    case 'C': {
      h.awaitInput = false;
      h.inputStart?.marker.dispose();
      h.inputStart = null;
      const cmd = h.pendingCmd;
      h.pendingCmd = '';
      const entry = { cmd, at: now, start: h.term.registerMarker(0), head: h.promptMarker, end: null, exit: null, dur: null, decos: [] };
      h.promptMarker = null;
      h.atPrompt = false;
      if (h.ownPrompt) decorateHead(h, entry);
      h.cmds.push(entry);
      if (h.cmds.length > 200) {
        const old = h.cmds.shift();
        old?.start?.dispose();
        old?.head?.dispose();
        old?.decos?.forEach((d) => d.dispose());
      }
      patchRt(h.sid, { status: 'run', atPrompt: false, command: cmd, cmdStart: now, exitCode: null, dropped: null });
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
      if (h.ownPrompt) decorateEnd(h, entry);
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

// ---- Click to move the cursor --------------------------------------------------------
// Like Ghostty: clicking inside the command being typed moves the shell's cursor there by
// sending left/right arrows. Only at an idle prompt we've seen start (shell integration),
// never in full-screen apps or while a command runs, and never past the typed text (so a
// grey autosuggestion isn't accepted by accident).
function moveCursorTo(h, clientX, clientY) {
  const t = h.term;
  const b = t.buffer.active;
  const start = h.inputStart;
  if (!clickToMove || !start || start.marker.isDisposed || b.type !== 'normal' || t.modes.mouseTrackingMode !== 'none') return;
  if (rt.get()[h.sid]?.status === 'run' || t.hasSelection()) return;
  const screen = h.el.querySelector('.xterm-screen');
  if (!screen) return;
  const r = screen.getBoundingClientRect();
  const col = Math.floor(((clientX - r.left) / r.width) * t.cols);
  const row = Math.floor(((clientY - r.top) / r.height) * t.rows);
  if (col < 0 || row < 0 || col >= t.cols || row >= t.rows) return;

  const cy = b.baseY + b.cursorY;
  const first = start.marker.line;
  // The input must be one logical line from the prompt to the cursor (soft-wrapped is fine).
  for (let y = cy; y > first; y--) if (!b.getLine(y)?.isWrapped) return;
  let last = cy;
  while (b.getLine(last + 1)?.isWrapped) last++;
  const y = b.viewportY + row;
  if (y < first || y > last || (y === first && col < start.x)) return;

  // One pass over the input cells, counting characters (wide glyphs once) to find the
  // cursor's index, the clicked index, and the end of what was actually typed: the last
  // non-blank cell, ignoring autosuggestion grey after the cursor.
  const cell = b.getNullCell();
  let n = 0;
  let cur = null;
  let hit = null;
  let end = 0;
  for (let yy = first; yy <= last; yy++) {
    const line = b.getLine(yy);
    for (let xx = yy === first ? start.x : 0; xx < t.cols; xx++) {
      if (yy === cy && xx === b.cursorX) cur = n;
      if (yy === y && xx === col) hit = n;
      if (!line?.getCell(xx, cell) || cell.getWidth() === 0) continue;
      if (cell.getChars().trim()) {
        const fg = cell.isFgPalette() ? cell.getFgColor() : -1;
        const grey = fg === 8 || (fg >= 238 && fg <= 246);
        if (!grey || cur === null) end = n + 1;
      }
      n++;
    }
  }
  if (cur === null) cur = n;
  if (hit === null) hit = n;
  const delta = Math.min(hit, Math.max(end, cur)) - cur;
  if (!delta) return;
  const app = t.modes.applicationCursorKeysMode;
  const key = delta > 0 ? (app ? '\x1bOC' : '\x1b[C') : app ? '\x1bOD' : '\x1b[D';
  api.pty.write(h.sid, key.repeat(Math.min(Math.abs(delta), 4000)));
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
