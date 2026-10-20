// Split layouts are binary trees: a leaf holds one session id, a split holds two
// children laid out in a row (side by side) or column (stacked) with a ratio.
export const MAX_PANES = 4;

export const leaf = (sid) => ({ sid });

export function leaves(node) {
  if (!node) return [];
  return node.sid ? [node.sid] : [...leaves(node.a), ...leaves(node.b)];
}

// Insert `sid` next to `target`. `edge` is where the new pane goes: right | left | bottom | top.
export function insert(node, target, sid, edge = 'right') {
  if (leaves(node).length >= MAX_PANES) return node;
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const first = edge === 'left' || edge === 'top';
  const wrap = (n) => ({ dir, ratio: 0.5, a: first ? leaf(sid) : n, b: first ? n : leaf(sid) });
  const walk = (n) => {
    if (n.sid) return n.sid === target ? wrap(n) : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(node);
}

// Put a whole subtree on one edge of the card (used when dragging a session onto it).
export function insertRoot(node, sub, edge = 'right') {
  if (leaves(node).length + leaves(sub).length > MAX_PANES) return node;
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const first = edge === 'left' || edge === 'top';
  return { dir, ratio: 0.5, a: first ? sub : node, b: first ? node : sub };
}

export function remove(node, sid) {
  if (!node) return null;
  if (node.sid) return node.sid === sid ? null : node;
  const a = remove(node.a, sid);
  const b = remove(node.b, sid);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

// Ratio at `path` (array of 'a'/'b' steps to the split node).
export function setRatio(node, path, ratio) {
  if (!path.length) return { ...node, ratio };
  const [step, ...rest] = path;
  return { ...node, [step]: setRatio(node[step], rest, ratio) };
}

export function snapRatio(r) {
  for (const s of [1 / 3, 1 / 2, 2 / 3]) if (Math.abs(r - s) < 0.025) return s;
  return Math.min(0.85, Math.max(0.15, r));
}

// Computes pane rectangles (fractions 0..1) — used for focus movement.
export function rects(node, x = 0, y = 0, w = 1, h = 1, out = {}) {
  if (!node) return out;
  if (node.sid) {
    out[node.sid] = { x, y, w, h };
    return out;
  }
  if (node.dir === 'row') {
    rects(node.a, x, y, w * node.ratio, h, out);
    rects(node.b, x + w * node.ratio, y, w * (1 - node.ratio), h, out);
  } else {
    rects(node.a, x, y, w, h * node.ratio, out);
    rects(node.b, x, y + h * node.ratio, w, h * (1 - node.ratio), out);
  }
  return out;
}

// The pane in `direction` from `sid` whose centre is nearest, or null.
export function neighbor(node, sid, direction) {
  const all = rects(node);
  const from = all[sid];
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best = null;
  let bestD = Infinity;
  for (const [id, r] of Object.entries(all)) {
    if (id === sid) continue;
    const ox = r.x + r.w / 2;
    const oy = r.y + r.h / 2;
    const ok = (direction === 'left' && ox < cx - 1e-6) || (direction === 'right' && ox > cx + 1e-6) || (direction === 'up' && oy < cy - 1e-6) || (direction === 'down' && oy > cy + 1e-6);
    if (!ok) continue;
    const d = Math.hypot(ox - cx, oy - cy);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
