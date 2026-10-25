// Warp-style context chips in the pane header: directory, git branch, changed files, PR.
// The directory and branch chips double as switchers; picking an entry types the command
// (cd / git switch) into the shell so it shows up in history like anything else.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { app, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import * as reg from '../term/registry.js';
import { tildify, expandHome } from '../lib/routing.js';
import { fuzzy, highlight } from '../lib/fuzzy.js';
import { IconFolder, IconFolderOpen, IconBranch, IconPullRequest, IconCheck, IconArrowUp, IconClock, IconCopy, IconExternal, IconPlus, IconSearch, IconDiff } from './icons.jsx';

const api = window.termac;
const MENU_W = 420;
const MENU_MAX_H = 480;

export default function PaneChips({ sid, r, cwd }) {
  const home = ui.use((s) => s.home);
  const [menu, setMenu] = useState(null); // { kind, rect }
  const toggle = (kind) => (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu((m) => (m?.kind === kind ? null : { kind, rect }));
  };
  const close = (refocus = true) => {
    setMenu(null);
    if (refocus) requestAnimationFrame(() => reg.focus(sid));
  };
  const on = (kind) => (menu?.kind === kind ? ' open' : '');

  if (r.dangerHost) {
    return (
      <span className="pchip host" title="Remote session">
        <IconExternal size={13} />
        <span className="txt">{r.dangerHost}</span>
      </span>
    );
  }

  const Menu = { dir: DirMenu, branch: BranchMenu, diff: DiffMenu }[menu?.kind];
  return (
    <>
      <button className={`pchip dir${on('dir')}`} title={`${cwd}\nClick to change directory`} onClick={toggle('dir')}>
        <IconFolder size={14} />
        <span className="txt path">&lrm;{tildify(cwd, home) || '~'}</span>
      </button>
      {r.branch && (
        <button className={`pchip git${on('branch')}`} title="Switch branch" onClick={toggle('branch')}>
          <IconBranch size={14} />
          <span className="txt">{r.branch}</span>
        </button>
      )}
      {r.branch && r.changes != null && (
        <button className={`pchip diff${r.changes ? ' dirty' : ''}${on('diff')}`} title={r.changes ? `${r.changes} changed file${r.changes === 1 ? '' : 's'}` : 'Working tree clean'} onClick={toggle('diff')}>
          <IconDiff size={13} />
          <span className="txt">{r.changes}</span>
        </button>
      )}
      {r.pr && (
        <button className={`pchip pr${r.pr.state && r.pr.state !== 'OPEN' ? ' closed' : ''}`} title={`Open PR #${r.pr.number} in the browser${r.pr.state && r.pr.state !== 'OPEN' ? ` (${r.pr.state.toLowerCase()})` : ''}`} onClick={() => api.sys.openExternal(r.pr.url)}>
          <IconPullRequest size={14} />
          <span className="txt">PR #{r.pr.number}</span>
        </button>
      )}
      {Menu && createPortal(<Menu sid={sid} r={r} cwd={cwd} home={home} rect={menu.rect} onClose={close} />, document.body)}
    </>
  );
}

// ---- Switchers ---------------------------------------------------------------------
function DirMenu({ sid, cwd, home, rect, onClose }) {
  const [dirs, setDirs] = useState(null);
  const recent = app.use((s) => s.recentDirs);
  useEffect(() => {
    api.sys.listDirs(cwd).then(setDirs);
  }, [cwd]);

  const cd = (path) => A.typeCommand(sid, `cd ${A.shellQuote(path)}`);
  const parent = cwd && cwd !== '/' ? cwd.replace(/\/[^/]+\/?$/, '') || '/' : null;
  const join = (name) => (cwd === '/' ? `/${name}` : `${cwd}/${name}`);
  const sections = [
    {
      title: 'Folders',
      loading: !dirs,
      items: [
        parent && { key: 'up', icon: IconArrowUp, label: '..', sub: tildify(parent, home), run: () => cd(parent) },
        ...(dirs || []).map((n) => ({ key: `d:${n}`, icon: IconFolder, label: `${n}/`, run: () => cd(join(n)) })),
      ].filter(Boolean),
    },
    {
      title: 'Recent',
      items: recent
        .filter((d) => d.path !== cwd)
        .slice(0, 8)
        .map((d) => ({ key: `r:${d.path}`, icon: IconClock, label: tildify(d.path, home), run: () => cd(d.path) })),
    },
    {
      title: null,
      fixed: true,
      items: [
        {
          key: 'browse',
          icon: IconFolderOpen,
          label: 'Browse…',
          keep: true,
          run: async () => {
            const p = await api.sys.chooseDir(cwd);
            if (p) cd(p);
          },
        },
        { key: 'finder', icon: IconExternal, label: 'Open in Finder', run: () => api.sys.reveal(cwd) },
        { key: 'copy', icon: IconCopy, label: 'Copy path', run: () => navigator.clipboard.writeText(cwd) },
      ],
    },
  ];
  // A typed path that isn't in the list can still be jumped to directly.
  const extra = (q) => (/^[~/.]/.test(q) ? { key: 'goto', icon: IconArrowUp, label: `cd ${q}`, sub: 'Go to this path', run: () => cd(q.startsWith('~') ? expandHome(q, home) : q.startsWith('.') ? `${cwd}/${q}` : q) } : null);
  return <ChipMenu rect={rect} placeholder="Change directory…" sections={sections} extra={extra} onClose={onClose} />;
}

function BranchMenu({ sid, r, cwd, rect, onClose }) {
  const [branches, setBranches] = useState(null);
  useEffect(() => {
    api.sys.gitBranches(cwd).then(setBranches);
  }, [cwd]);
  const current = r.branch;
  const sections = [
    {
      title: 'Branches',
      loading: !branches,
      items: (branches || []).sort((a, b) => (b === current) - (a === current)).map((b) => ({
        key: `b:${b}`,
        icon: b === current ? IconCheck : IconBranch,
        label: b,
        current: b === current,
        run: () => b !== current && A.typeCommand(sid, `git switch ${A.shellQuote(b)}`),
      })),
    },
    { title: null, fixed: true, items: [{ key: 'copy', icon: IconCopy, label: 'Copy branch name', run: () => navigator.clipboard.writeText(current) }] },
  ];
  const extra = (q) => {
    const name = q.trim().replace(/\s+/g, '-');
    if (!name || branches?.includes(name)) return null;
    return { key: 'new', icon: IconPlus, label: `Create branch “${name}”`, sub: 'git switch -c', run: () => A.typeCommand(sid, `git switch -c ${A.shellQuote(name)}`) };
  };
  return <ChipMenu rect={rect} placeholder="Switch branch…" sections={sections} extra={extra} onClose={onClose} />;
}

function DiffMenu({ sid, r, rect, onClose }) {
  const run = (cmd) => () => A.typeCommand(sid, cmd);
  const sections = [
    {
      title: r.changes ? `${r.changes} changed file${r.changes === 1 ? '' : 's'}` : 'Working tree clean',
      items: [
        { key: 'status', icon: IconDiff, label: 'Show status', sub: 'git status', run: run('git status') },
        { key: 'diff', icon: IconDiff, label: 'Show diff', sub: 'git diff', run: run('git diff') },
        { key: 'stat', icon: IconDiff, label: 'Diff summary', sub: 'git diff --stat', run: run('git diff --stat') },
      ],
    },
  ];
  return <ChipMenu rect={rect} sections={sections} onClose={onClose} />;
}

// ---- Dropdown --------------------------------------------------------------------------
// Searchable list anchored under a chip. ↑/↓ to move, ↵ to pick, esc to close.
function ChipMenu({ rect, placeholder, sections, extra, onClose }) {
  const ref = useRef(null);
  const listRef = useRef(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const view = useMemo(() => {
    const query = q.trim();
    const out = [];
    for (const sec of sections) {
      let items = sec.items;
      if (query && !sec.fixed) {
        items = items
          .map((it) => ({ it, m: fuzzy(query, it.label) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m.score - a.m.score)
          .map(({ it, m }) => ({ ...it, hits: m.indices }));
      }
      if (items.length || sec.loading) out.push({ ...sec, items });
    }
    const x = query && extra?.(query);
    if (x) out.unshift({ title: null, items: [x] });
    return out;
  }, [sections, q, extra]);
  const flat = view.flatMap((s) => s.items);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('.pchip') && onClose(false);
    window.addEventListener('mousedown', off, true);
    return () => window.removeEventListener('mousedown', off, true);
  }, []);
  useLayoutEffect(() => {
    listRef.current?.querySelector('.cm-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel, view]);

  const pick = (it) => {
    if (!it) return;
    onClose(!it.keep);
    it.run();
  };
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') setSel((i) => Math.min(flat.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setSel((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') pick(flat[sel]);
    else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
  };

  // Open downward unless the chip sits too low for a usable list; then flip above it,
  // with the search field next to the chip. Either way, cap the height to the room left.
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8));
  const below = window.innerHeight - rect.bottom - 14;
  const above = rect.top - 14;
  const up = below < Math.min(MENU_MAX_H, 260) && above > below;
  const pos = up
    ? { bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(MENU_MAX_H, above) }
    : { top: rect.bottom + 6, maxHeight: Math.min(MENU_MAX_H, below) };
  let n = -1;
  return (
    <div ref={ref} className={`chip-menu${up ? ' up' : ''}`} style={{ left, width: MENU_W, ...pos }} onKeyDown={onKeyDown}>
      {placeholder ? (
        <label className="cm-search">
          <IconSearch size={13} />
          <input autoFocus value={q} placeholder={placeholder} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        </label>
      ) : (
        <input className="cm-keys" autoFocus readOnly aria-label="Menu" />
      )}
      <div className="cm-list" ref={listRef}>
        {view.map((sec, si) => (
          <div key={si} className="cm-sec">
            {sec.title && <div className="cm-title">{sec.title}</div>}
            {sec.loading && !sec.items.length && <div className="cm-empty">Loading…</div>}
            {sec.items.map((it) => {
              const i = ++n;
              const Icon = it.icon;
              return (
                <button key={it.key} className={`cm-item${i === sel ? ' sel' : ''}${it.current ? ' current' : ''}`} onMouseMove={() => sel !== i && setSel(i)} onClick={() => pick(it)}>
                  <Icon size={14} />
                  <span className="cm-label">{it.hits ? <Hl text={it.label} hits={it.hits} /> : it.label}</span>
                  {it.sub && <span className="cm-sub">{it.sub}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length && !view.some((s) => s.loading) && <div className="cm-empty">No matches</div>}
      </div>
    </div>
  );
}

function Hl({ text, hits }) {
  return highlight(text, hits).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text));
}
