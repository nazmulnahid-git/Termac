// Narrow, typed bridge between the renderer and the native side (src-tauri). Imported
// first by each page so `window.termac` exists before any module reads it.
import { invoke, Channel } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { eventToAccel, normalizeAccel } from './lib/keys.js';

const win = getCurrentWebviewWindow();
const call = (cmd, args) => invoke(cmd, args);
// Fire-and-forget, like ipcRenderer.send.
const send = (cmd, args) => {
  invoke(cmd, args).catch((e) => console.error(cmd, e));
};

// Subscribes to an event aimed at this window; returns a synchronous unsubscribe.
const on = (event, onListening) => (fn) => {
  let off = null;
  let dead = false;
  win.listen(event, (e) => fn(e.payload)).then((u) => {
    if (dead) return u();
    off = u;
    onListening?.();
  });
  return () => {
    dead = true;
    off?.();
  };
};

// ---- PTY stream: one channel per window carries output, exits and process changes. ------
const listeners = { data: new Set(), exit: new Set(), proc: new Set() };
const channel = new Channel();
channel.onmessage = (m) => {
  const arg = m.t === 'data' ? m.b : m;
  for (const fn of listeners[m.t] || []) fn(arg);
};
const attached = call('pty_attach', { channel });
const subscribe = (set) => (fn) => {
  set.add(fn);
  return () => set.delete(fn);
};

// Acks arrive once per xterm write; sending them a few ms apart saves a round trip each.
const acks = new Map();
let ackTimer = null;
const flushAcks = () => {
  ackTimer = null;
  for (const [id, bytes] of acks) send('pty_ack', { id, bytes });
  acks.clear();
};

// ---- Window chrome --------------------------------------------------------------------
// Title bars mark themselves with `--app-region: drag` (it inherits, and `no-drag` opts a
// control back out), the way -webkit-app-region worked in Chromium.
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !(e.target instanceof Element)) return;
  if (getComputedStyle(e.target).getPropertyValue('--app-region').trim() !== 'drag') return;
  e.preventDefault();
  if (e.detail === 2) send('app_titlebar_double_click');
  else win.startDragging();
});

// Mirrors the window's key state onto <html data-inactive>, for the quieter inactive chrome.
const setInactive = () => document.documentElement.toggleAttribute('data-inactive', !document.hasFocus());
window.addEventListener('focus', setInactive);
window.addEventListener('blur', setInactive);

// Menu items show their shortcuts, but keys belong to the page (App.jsx). WebKit hands a
// key the page left alone to the menu, so swallow menu shortcuts the page didn't handle.
const MENU_ACTIONS = ['settings', 'newTerminal', 'commandBar', 'splitRight', 'splitDown', 'closePane', 'copyLastOutput', 'clear', 'find', 'toggleSidebar', 'focusMode', 'library', 'overview', 'zoomIn', 'zoomOut', 'zoomReset', 'nextSpace', 'prevSpace', 'newSpace'];
let menuAccels = new Set();
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !menuAccels.size) return;
  const raw = eventToAccel(e);
  if (raw && menuAccels.has(normalizeAccel(raw))) e.preventDefault();
});

// WebKit only lets the page write the clipboard straight after a click or key, and many
// copies here follow an awaited native menu, so they go through the native pasteboard.
if (navigator.clipboard) {
  Object.defineProperty(navigator.clipboard, 'writeText', { value: (text) => call('sys_copy', { text: String(text ?? '') }) });
}

// Show the window once the page has rendered, so it never flashes empty.
if (win.label === 'main') {
  const ready = () => setTimeout(() => send('app_ready'), 30);
  const root = document.getElementById('root');
  if (root?.childElementCount) ready();
  else if (root) {
    const mo = new MutationObserver(() => {
      if (!root.childElementCount) return;
      mo.disconnect();
      ready();
    });
    mo.observe(root, { childList: true });
  }
}

window.termac = {
  pty: {
    spawn: async (opts) => {
      await attached;
      return call('pty_spawn', { opts });
    },
    write: (id, data) => send('pty_write', { id, data }),
    resize: (id, cols, rows) => send('pty_resize', { id, cols, rows }),
    kill: (id) => send('pty_kill', { id }),
    ack: (id, bytes) => {
      acks.set(id, (acks.get(id) || 0) + bytes);
      ackTimer ??= setTimeout(flushAcks, 4);
    },
    hold: (id) => call('pty_hold', { id }),
    release: (id) => send('pty_release', { id }),
    cwd: (id) => call('pty_cwd', { id }),
    onData: subscribe(listeners.data),
    onExit: subscribe(listeners.exit),
    onProc: subscribe(listeners.proc),
  },
  state: {
    load: () => call('state_load'),
    save: (next) => send('state_save', { next }),
    onChanged: on('state:changed'),
  },
  settings: {
    load: () => call('settings_load'),
    save: (text) => send('settings_save', { text }),
    saveSchema: (text) => send('settings_save_schema', { text }),
    open: () => call('settings_open'),
    onChanged: on('settings:changed'),
  },
  scrollback: {
    save: (id, data) => call('scrollback_save', { id, data }),
    load: (id) => call('scrollback_load', { id }),
    remove: (id) => call('scrollback_delete', { id }),
  },
  library: {
    add: (entry, ansi) => call('library_add', { entry, ansi }),
    search: (query) => call('library_search', { query }),
    content: (id) => call('library_content', { id }),
    remove: (id) => call('library_remove', { id }),
  },
  sys: {
    sshHosts: () => call('sys_ssh_hosts'),
    gitBranch: (cwd) => call('sys_git_branch', { cwd }),
    gitStatus: (cwd) => call('sys_git_status', { cwd }),
    gitBranches: (cwd) => call('sys_git_branches', { cwd }),
    gitPr: (cwd, branch) => call('sys_git_pr', { cwd, branch }),
    listDirs: (dir) => call('sys_list_dirs', { dir }),
    detectImports: () => call('sys_detect_imports'),
    isDir: (p) => call('sys_is_dir', { p }),
    chooseDir: (defaultPath) => call('sys_choose_dir', { defaultPath }),
    chooseImage: () => call('sys_choose_image'),
    readImage: (file) => call('sys_read_image', { file }),
    reveal: (p) => send('sys_reveal', { p }),
    openExternal: (url) => send('sys_open_external', { url }),
    notify: (n) => send('sys_notify', { n }),
    confirm: (o) => call('sys_confirm', { o }),
  },
  shell: {
    history: () => call('shell_history'),
    complete: (cwd, line) => call('shell_complete', { cwd, line }),
  },
  app: {
    popupMenu: (items) => call('menu_popup', { items }),
    setMenu: (bindings) => {
      menuAccels = new Set(MENU_ACTIONS.map((a) => bindings?.[a]).filter(Boolean).map(normalizeAccel));
      send('app_set_menu', { bindings });
    },
    setHotkey: (accel) => call('app_set_hotkey', { accel }),
    focusMain: () => send('app_focus_main'),
    trafficLights: (visible) => send('app_traffic_lights', { visible: !!visible }),
    // SF Symbols drawn by AppKit: items [{ name, size, weight }], scale in pixels per CSS pixel.
    symbols: (items, scale) => call('app_symbols', { items, scale }),
    setZoom: (percent) => send('app_set_zoom', { percent }),
    setTheme: (theme) => send('app_set_theme', { theme }),
    quit: () => send('app_quit'),
    quitReady: () => send('app_quit_ready'),
    quitCancel: () => send('app_quit_cancel'),
    onMenu: on('menu:action'),
    onWillQuit: on('app:willQuit'),
    onJumpTo: on('app:jumpTo'),
    onAdopt: on('session:adopt'),
    // Folders from Finder's "New Termorc Tab Here", a Dock drop or `open -a Termorc dir`.
    takeFolders: () => call('app_take_folders'),
    onFoldersOpened: on('app:foldersOpened'),
  },
  quick: {
    hide: () => send('quick_hide'),
    promote: (payload) => call('quick_promote', { payload }),
    // The Quick Terminal is built on first use and shown once it's listening.
    onVisibility: on('quick:visibility', () => send('quick_loaded')),
  },
};
