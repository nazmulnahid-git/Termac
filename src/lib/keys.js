// Keybindings are stored as Electron accelerator strings ("Shift+Cmd+D") so the same
// value drives the renderer key handler, the app menu and the global hotkey.

export const ACTIONS = [
  { id: 'commandBar', label: 'Command bar', def: 'Cmd+T' },
  { id: 'newTerminal', label: 'New terminal in current directory', def: 'Cmd+N' },
  { id: 'quickTerminal', label: 'Quick Terminal (global)', def: 'Alt+Space', global: true },
  { id: 'toggleSidebar', label: 'Collapse / expand sidebar', def: 'Cmd+S' },
  { id: 'focusMode', label: 'Hide sidebar (focus mode)', def: 'Ctrl+Cmd+S' },
  { id: 'splitRight', label: 'Split right', def: 'Cmd+D' },
  { id: 'splitDown', label: 'Split down', def: 'Shift+Cmd+D' },
  { id: 'closePane', label: 'Close pane', def: 'Cmd+W' },
  { id: 'copyLastOutput', label: "Copy last command's output", def: 'Shift+Cmd+C' },
  { id: 'prevSpace', label: 'Previous Space', def: 'Ctrl+Left' },
  { id: 'nextSpace', label: 'Next Space', def: 'Ctrl+Right' },
  { id: 'overview', label: 'All Spaces overview', def: 'Ctrl+Up' },
  { id: 'library', label: 'Library', def: 'Cmd+Y' },
  { id: 'notes', label: 'Notes panel', def: 'Shift+Cmd+N' },
  { id: 'settings', label: 'Settings', def: 'Cmd+,' },
  { id: 'prevTab', label: 'Previous session', def: 'Shift+Cmd+[' },
  { id: 'nextTab', label: 'Next session', def: 'Shift+Cmd+]' },
  { id: 'focusLeft', label: 'Focus pane left', def: 'Alt+Cmd+Left' },
  { id: 'focusRight', label: 'Focus pane right', def: 'Alt+Cmd+Right' },
  { id: 'focusUp', label: 'Focus pane up', def: 'Alt+Cmd+Up' },
  { id: 'focusDown', label: 'Focus pane down', def: 'Alt+Cmd+Down' },
  { id: 'jumpBottom', label: 'Jump to bottom', def: 'Cmd+Down' },
  { id: 'clear', label: 'Clear scrollback', def: 'Cmd+K' },
  { id: 'find', label: 'Find in terminal', def: 'Cmd+F' },
  { id: 'reconnect', label: 'Reconnect dropped SSH', def: 'Cmd+R' },
  { id: 'newSpace', label: 'New Space', def: 'Ctrl+N' },
  { id: 'zoomIn', label: 'Bigger text', def: 'Cmd+=' },
  { id: 'zoomOut', label: 'Smaller text', def: 'Cmd+-' },
  { id: 'zoomReset', label: 'Actual size', def: 'Cmd+0' },
];

export const defaultBindings = () => Object.fromEntries(ACTIONS.map((a) => [a.id, a.def]));

const KEY_NAMES = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
};

// Uses `code` so ⌥ / ⇧ don't change the key (⌥Space must not become a nbsp).
function baseKey(e) {
  const c = e.code || '';
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  const codeMap = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space' };
  if (codeMap[c]) return codeMap[c];
  return KEY_NAMES[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

export function eventToAccel(e) {
  if (['Meta', 'Shift', 'Control', 'Alt'].includes(e.key)) return null;
  const mods = [];
  if (e.shiftKey) mods.push('Shift');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Cmd');
  return [...mods, baseKey(e)].join('+');
}

export function normalizeAccel(a) {
  if (!a) return '';
  const parts = a.split('+');
  const key = parts.pop();
  const order = ['Shift', 'Ctrl', 'Alt', 'Cmd'];
  const alias = { Command: 'Cmd', CommandOrControl: 'Cmd', CmdOrCtrl: 'Cmd', Control: 'Ctrl', Option: 'Alt', Meta: 'Cmd' };
  const mods = parts.map((m) => alias[m] || m).sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

const GLYPH = { Shift: '⇧', Ctrl: '⌃', Alt: '⌥', Cmd: '⌘', Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↵', Esc: 'esc', Space: 'Space', Tab: '⇥', Backspace: '⌫' };

export function formatAccel(a) {
  if (!a) return '';
  const parts = normalizeAccel(a).split('+');
  const key = parts.pop();
  const order = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
  parts.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return parts.map((m) => GLYPH[m]).join('') + (GLYPH[key] ? (key === 'Space' ? ' Space' : GLYPH[key]) : key);
}

// Builds accel → action lookup, including the fixed ⌘1–9 / ⌃1–9 families.
export function buildKeymap(bindings) {
  const map = new Map();
  for (const a of ACTIONS) {
    if (a.global) continue;
    const accel = bindings[a.id];
    if (accel) map.set(normalizeAccel(accel), a.id);
  }
  return map;
}

// Shortcuts the shell normally owns; with "Shell takes priority" they pass through.
export function isShellKey(accel) {
  return /^Ctrl\+/.test(accel) || /^Alt\+/.test(accel);
}
