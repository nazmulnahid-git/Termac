// The "project" the explorer and code review panels follow: the git root of the focused
// session's directory, or the directory itself outside a repo.
import { useEffect, useState } from 'react';
import { app, rt, ui } from '../state/model.js';

const api = window.termac;
const roots = new Map(); // cwd -> Promise<root>

export function rootOf(cwd) {
  if (!cwd) return Promise.resolve(null);
  if (!roots.has(cwd)) {
    roots.set(
      cwd,
      api.sys.gitRoot(cwd).then((r) => ({ root: r || cwd, git: !!r }))
    );
    if (roots.size > 300) roots.delete(roots.keys().next().value);
  }
  return roots.get(cwd);
}

export function useProject() {
  const sid = ui.use((s) => s.focusedSid);
  const live = rt.use((s) => s[sid]?.cwd);
  const saved = app.use((s) => s.sessions[sid]?.cwd);
  const home = ui.use((s) => s.home);
  const cwd = live || saved || home;
  const [p, setP] = useState(null);
  useEffect(() => {
    let on = true;
    rootOf(cwd).then((r) => on && setP(r && { ...r, cwd }));
    return () => {
      on = false;
    };
  }, [cwd]);
  // Keep showing the previous project until the new root resolves, so the tree doesn't blink.
  return { sid, cwd, root: p?.root || null, git: !!p?.git };
}

export const relPath = (root, p) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
export const baseName = (p) => p.split('/').pop();
export const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// Changed-file map for decorating the tree: relative path -> 'mod' | 'add' | 'new' | 'del'
// ('new' is untracked, 'add' is staged as added).
export function statusMap(changes) {
  const m = new Map();
  for (const f of changes?.files || []) {
    const code = f.untracked ? 'new' : f.x === 'A' ? 'add' : f.x === 'D' || f.y === 'D' ? 'del' : 'mod';
    m.set(f.path, code);
  }
  return m;
}
