// App icons are SF Symbols, drawn by AppKit (macos.rs render_symbol) at the screen's scale
// and shown as masks, so they take the color of the text around them. Callers keep the
// Icon* names; `size` is the box in CSS pixels (default 16) and the symbol's point size
// follows from it, as a toolbar or list glyph sits in its control. A name may list
// fallbacks for older macOS: 'flowchart|arrow.triangle.branch'.
import { useSyncExternalStore } from 'react';

const WEIGHTS = { light: -0.4, regular: 0, medium: 0.23, semibold: 0.3, bold: 0.4 };
const ptFor = (size) => Math.round(size * 0.82 * 2) / 2;

const cache = new Map(); // `name@pt@weight` -> { src, w, h } | null (not on this macOS)
const queued = new Map();
const pending = new Set();
const subs = new Set();
let version = 0;
let timer = 0;
let scale = window.devicePixelRatio || 2;
const keyOf = (name, pt, weight) => `${name}@${pt}@${weight}`;
const notify = () => {
  version++;
  for (const fn of subs) fn();
};

function request(name, pt, weight) {
  const key = keyOf(name, pt, weight);
  if (cache.has(key) || pending.has(key) || queued.has(key)) return key;
  queued.set(key, { name, size: pt, weight });
  if (!timer) timer = setTimeout(flush, 0);
  return key;
}

// One native round trip per batch of new symbols.
async function flush() {
  timer = 0;
  const items = [...queued.values()];
  queued.clear();
  const keys = items.map((it) => keyOf(it.name, it.size, it.weight));
  keys.forEach((k) => pending.add(k));
  const at = scale;
  const out = await window.termac.app.symbols(items, at).catch(() => ({}));
  keys.forEach((k) => pending.delete(k));
  if (at !== scale) return;
  for (const k of keys) cache.set(k, out[k] ?? null);
  notify();
}

// Zooming or moving to another display changes the scale; redraw everything sharply.
function watchScale() {
  const mq = matchMedia(`(resolution: ${scale}dppx)`);
  mq.addEventListener(
    'change',
    () => {
      scale = window.devicePixelRatio || 2;
      cache.clear();
      notify();
      watchScale();
    },
    { once: true }
  );
}
watchScale();

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
const getVersion = () => version;

// Draws the first name in `name` (split on |) that this macOS has.
export function Sym({ name, size = 16, weight = 'regular', className, style, title }) {
  useSyncExternalStore(subscribe, getVersion);
  const pt = ptFor(size);
  const w = WEIGHTS[weight] ?? 0;
  let img = null;
  for (const n of name.split('|')) {
    const key = request(n, pt, w);
    if (!cache.has(key)) break;
    img = cache.get(key);
    if (img) break;
  }
  return (
    <span className={className ? `sym ${className}` : 'sym'} style={{ width: size, height: size, ...style }} title={title} aria-hidden="true">
      {img && <i style={{ width: img.w, height: img.h, WebkitMaskImage: `url("${img.src}")` }} />}
    </span>
  );
}

// Warms the cache before the first paint, so the chrome never shows empty icon boxes.
export function preloadSymbols(names, sizes = [13, 14, 16, 17]) {
  for (const size of sizes) for (const n of names) request(n.split('|')[0], ptFor(size), 0);
  return new Promise((resolve) => {
    const done = () => (queued.size || pending.size ? setTimeout(done, 5) : resolve());
    setTimeout(done, 0);
    setTimeout(resolve, 600);
  });
}

const sym = (name, weight) => {
  const C = ({ size = 16, className, style, title }) => <Sym name={name} size={size} weight={weight} className={className} style={style} title={title} />;
  C.symbol = name;
  return C;
};

export const IconSidebar = sym('sidebar.left');
export const IconFolder = sym('folder');
export const IconFolderOpen = sym('folder');
export const IconFolderPlus = sym('folder.badge.plus');
export const IconChevron = sym('chevron.right', 'medium');
export const IconPlus = sym('plus');
export const IconMore = sym('ellipsis');
export const IconSearch = sym('magnifyingglass');
export const IconLibrary = sym('books.vertical');
export const IconActivity = sym('checklist|list.bullet');
export const IconGear = sym('gearshape');
export const IconTerminal = sym('terminal');
export const IconClose = sym('xmark');
export const IconBranch = sym('arrow.triangle.branch');
export const IconPullRequest = sym('arrow.triangle.pull');
export const IconDiff = sym('plus.forwardslash.minus');
export const IconCheck = sym('checkmark');
export const IconArrowUp = sym('arrow.up');
export const IconClock = sym('clock');
export const IconCopy = sym('doc.on.doc');
export const IconExternal = sym('arrow.up.forward.square|arrow.up.right.square');
export const IconFiles = sym('list.bullet.indent');
export const IconFile = sym('doc');
export const IconGrid = sym('square.grid.2x2');
export const IconReview = sym('plus.forwardslash.minus');
export const IconRefresh = sym('arrow.clockwise');
export const IconUndo = sym('arrow.uturn.backward');
export const IconMinus = sym('minus');
export const IconInsert = sym('return');
export const IconMaximize = sym('arrow.up.left.and.arrow.down.right');
export const IconMinimize = sym('arrow.down.right.and.arrow.up.left');
export const IconComment = sym('text.bubble');
export const IconCommentAdd = sym('plus.bubble');
export const IconCommit = sym('smallcircle.filled.circle');
export const IconPR = sym('arrow.triangle.pull');
export const IconMerge = sym('arrow.triangle.merge');
export const IconArrowDown = sym('arrow.down');
export const IconChevronDown = sym('chevron.down', 'medium');
export const IconSend = sym('paperplane');
export const IconTrash = sym('trash');
export const IconPencil = sym('pencil');
export const IconCollapseAll = sym('rectangle.compress.vertical|arrow.down.right.and.arrow.up.left');
export const IconExpandAll = sym('rectangle.expand.vertical|arrow.up.left.and.arrow.down.right');
export const IconCheckCircle = sym('checkmark.circle.fill');
export const IconXCircle = sym('xmark.circle.fill');
export const IconDot = sym('circle.dotted|circle');
export const IconImagePlus = sym('photo.badge.plus|photo');
export const IconBan = sym('nosign');
// Spins while a git or gh action runs (.spin in app.css).
export const IconSpinner = ({ size = 16 }) => <Sym name="arrow.triangle.2.circlepath" size={size} className="spin" />;

// Every chrome symbol, for preloadSymbols().
export const CHROME_SYMBOLS = ['sidebar.left', 'magnifyingglass', 'gearshape', 'list.bullet.indent', 'square.grid.2x2', 'plus.forwardslash.minus', 'plus', 'xmark', 'terminal', 'books.vertical', 'checklist', 'folder', 'chevron.right', 'ellipsis', 'folder.badge.plus'];

// App mark: a prompt and cursor, bracketed out to three sessions. Same drawing as build/icon.svg.
// Mint parts take currentColor; the session tiles stay paper-white on any background.
export const LogoMark = ({ size = 28, ...rest }) => (
  <svg width={size} height={(size * 438) / 612} viewBox="-306 -219 612 438" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    <path strokeWidth="70" d="M-271 -121L-169 -19L-271 83" />
    <path strokeWidth="34" d="M133 -162H131A50 50 0 0 0 81 -112V112A50 50 0 0 0 131 162H133M81 0H128" />
    <g stroke="none">
      <rect x="-149" y="46" width="179" height="51" rx="25.5" fill="#fbfbfc" />
      <g fill="#fbfbfc">
        <rect x="165" y="-219" width="141" height="114" rx="30" />
        <rect x="165" y="-57" width="141" height="114" rx="30" />
        <rect x="165" y="105" width="141" height="114" rx="30" />
      </g>
      <g fill="currentColor">
        <circle cx="235.5" cy="-162" r="26" />
        <circle cx="235.5" cy="0" r="26" />
        <circle cx="235.5" cy="162" r="26" />
      </g>
    </g>
  </svg>
);
