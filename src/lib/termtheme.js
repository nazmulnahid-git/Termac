// Per-Space terminal look: background color (preset, custom or tinted with the Space
// color) or an image with dim/blur. Text colors follow the background's lightness.

export const TERMINAL_THEMES = {
  dark: {
    background: '#17181d',
    foreground: '#d8dae0',
    cursor: '#d8dae0',
    cursorAccent: '#17181d',
    selectionBackground: 'rgba(136,173,255,.28)',
    black: '#2a2c33',
    red: '#ff8080',
    green: '#80d49b',
    yellow: '#ecc576',
    blue: '#88adff',
    magenta: '#c8a0f5',
    cyan: '#7dd3d3',
    white: '#d8dae0',
    brightBlack: '#7f8392',
    brightRed: '#ff9e9e',
    brightGreen: '#9de3b3',
    brightYellow: '#f3d595',
    brightBlue: '#a6c2ff',
    brightMagenta: '#d8bbf8',
    brightCyan: '#9ee2e2',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#fcfcfa',
    foreground: '#2b2d33',
    cursor: '#2b2d33',
    cursorAccent: '#fcfcfa',
    selectionBackground: 'rgba(43,91,199,.18)',
    black: '#2b2d33',
    red: '#c93535',
    green: '#1b8048',
    yellow: '#93650a',
    blue: '#2b5bc7',
    magenta: '#7f42c4',
    cyan: '#10767f',
    white: '#c9cac4',
    brightBlack: '#80838c',
    brightRed: '#de4a4a',
    brightGreen: '#239a58',
    brightYellow: '#b07c10',
    brightBlue: '#3d6fe0',
    brightMagenta: '#9455d8',
    brightCyan: '#178c96',
    brightWhite: '#111216',
  },
};

// `bg: null` = follow the app's terminal theme; 'tint' = Space color mixed into a dark base.
export const BG_PRESETS = [
  { id: 'default', name: 'Default', bg: null },
  { id: 'tint', name: 'Space tint', bg: 'tint' },
  { id: 'graphite', name: 'Graphite', bg: '#17181d' },
  { id: 'midnight', name: 'Midnight', bg: '#0f1726' },
  { id: 'deepsea', name: 'Deep Sea', bg: '#0c1e24' },
  { id: 'forest', name: 'Forest', bg: '#111e17' },
  { id: 'plum', name: 'Plum', bg: '#1c1424' },
  { id: 'espresso', name: 'Espresso', bg: '#1f1915' },
  { id: 'paper', name: 'Paper', bg: '#fcfcfa' },
  { id: 'sand', name: 'Sand', bg: '#f5efe3' },
  { id: 'mist', name: 'Mist', bg: '#eef2f6' },
];

export const DEFAULT_LOOK = { bg: null, image: null, dim: 0.6, blur: 0 };

export function parseHex(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(full, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

export function mix(a, b, t) {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

export function rgba(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// WCAG relative luminance.
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isDarkColor = (hex) => luminance(hex) < 0.22;

export function resolveBg(look, spaceColor, fallbackTheme) {
  if (look?.bg === 'tint') return mix(spaceColor || '#3b82f6', '#121318', 0.84);
  if (look?.bg) return look.bg;
  return TERMINAL_THEMES[fallbackTheme].background;
}

// Everything a card needs to paint one Space's terminals.
export function terminalLook(space, fallbackTheme = 'dark') {
  const look = { ...DEFAULT_LOOK, ...(space?.term || {}) };
  const bg = resolveBg(look, space?.color, fallbackTheme);
  const dark = isDarkColor(bg);
  const base = TERMINAL_THEMES[dark ? 'dark' : 'light'];
  const image = look.image || null;
  const fg = base.foreground;
  const xterm = { ...base, background: image ? 'rgba(0,0,0,0)' : bg, cursorAccent: bg };
  const vars = {
    '--t-bg': bg,
    '--t-surface': image ? 'transparent' : bg,
    '--t-hd': image ? rgba(bg, 0.55) : mix(bg, fg, dark ? 0.045 : 0.035),
    '--t-bd': rgba(fg, dark ? 0.08 : 0.08),
    '--t-fg': fg,
    '--t-dim': base.brightBlack,
    '--t-pill': rgba(fg, dark ? 0.08 : 0.06),
    '--t-chip': dark ? '#f3f3f1' : '#1d1e24',
    '--t-chip-fg': dark ? '#17181d' : '#f3f3f1',
    '--t-branch': base.magenta,
    '--t-green': base.green,
    '--t-yellow': base.yellow,
  };
  return { key: `${bg}|${image || ''}|${look.dim}|${look.blur}`, bg, dark, xterm, vars, image, dim: look.dim, blur: look.blur, transparent: !!image };
}
