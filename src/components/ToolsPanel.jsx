// Left tool panel next to the sidebar (Warp-style): project explorer and file search.
// Both follow the focused session's project (see project.js).
import { useEffect, useMemo, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { fuzzy, highlight } from '../lib/fuzzy.js';
import { useProject, relPath, baseName, dirName, statusMap } from './project.js';
import { IconFiles, IconSearch, IconReview, IconClose, IconChevron, IconFolder, IconFolderOpen, IconFile, IconRefresh } from './icons.jsx';

const api = window.termac;
const DIM_NAMES = new Set(['.git', 'node_modules', '.turbo', '.next', 'dist', 'build', '.cache', '.DS_Store']);

export default function ToolsPanel() {
  const tab = ui.use((s) => s.tools);
  const width = app.use((s) => s.settings.toolsWidth);
  const review = ui.use((s) => s.review);
  const [dragW, setDragW] = useState(null);
  const project = useProject();
  if (!tab) return null;
  const tabs = [
    { id: 'files', icon: IconFiles, title: 'Project explorer' },
    { id: 'search', icon: IconSearch, title: 'Find file' },
  ];
  return (
    <aside className="tools" style={{ width: dragW ?? width }}>
      <div className="tools-head">
        {tabs.map((t) => (
          <button key={t.id} className={`icon-btn${tab === t.id ? ' on' : ''}`} title={t.title} onClick={() => ui.set((u) => ({ ...u, tools: t.id }))}>
            <t.icon />
          </button>
        ))}
        <button className={`icon-btn${review ? ' on' : ''}`} title="Code review" onClick={A.toggleReview}>
          <IconReview />
        </button>
        <span className="grow" />
        <button className="icon-btn" title="Close panel" onClick={() => ui.set((u) => ({ ...u, tools: null }))}>
          <IconClose />
        </button>
      </div>
      {!project.root ? <div className="tools-empty">Open a terminal to browse its project.</div> : tab === 'files' ? <Explorer key={project.root} project={project} /> : <FileSearch key={project.root} project={project} />}
      <PanelResize side="right" width={width} min={220} max={560} setting="toolsWidth" onDrag={setDragW} />
    </aside>
  );
}

// Drag handle on one edge of a panel; writes the width setting on release.
export function PanelResize({ side, width, min, max, setting, onDrag }) {
  const onMouseDown = (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    let w = width;
    const move = (ev) => {
      const dx = side === 'right' ? ev.clientX - x0 : x0 - ev.clientX;
      w = Math.min(max, Math.max(min, width + dx));
      onDrag(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onDrag(null);
      A.setSettings({ [setting]: Math.round(w) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`panel-resize ${side}`} onMouseDown={onMouseDown} />;
}

// ---- Explorer -----------------------------------------------------------------------
// Expanded folders survive closing the panel and switching sessions within a project.
const openByRoot = new Map();

function useChanges(project) {
  const bump = rt.use((s) => s[project.sid]?.changes);
  const [changes, setChanges] = useState(null);
  useEffect(() => {
    if (!project.git) return setChanges(null);
    let on = true;
    const load = () => api.sys.gitChanges(project.root).then((c) => on && setChanges(c));
    load();
    window.addEventListener('focus', load);
    return () => {
      on = false;
      window.removeEventListener('focus', load);
    };
  }, [project.root, project.git, bump]);
  return changes;
}

function Explorer({ project }) {
  const { root } = project;
  if (!openByRoot.has(root)) openByRoot.set(root, new Set([root]));
  const [open, setOpen] = useState(() => openByRoot.get(root));
  const [kids, setKids] = useState(() => new Map());
  const [sel, setSel] = useState(null);
  const changes = useChanges(project);
  const status = useMemo(() => statusMap(changes), [changes]);
  const changedDirs = useMemo(() => {
    const d = new Set();
    for (const p of status.keys()) for (let x = dirName(p); x; x = dirName(x)) d.add(x);
    return d;
  }, [status]);
  const viewing = ui.use((s) => s.viewer?.path);

  const load = (dir) => api.sys.listDir(dir).then((list) => setKids((m) => new Map(m).set(dir, list || [])));
  useEffect(() => {
    for (const d of open) load(d);
  }, [root]);

  const toggle = (dir) => {
    const next = new Set(open);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      load(dir);
    }
    openByRoot.set(root, next);
    setOpen(next);
  };
  const refresh = () => {
    setKids(new Map());
    for (const d of open) load(d);
  };

  // Flatten the visible tree into rows.
  const rows = [];
  const walk = (dir, depth) => {
    for (const e of kids.get(dir) || []) {
      const path = `${dir}/${e.name}`;
      rows.push({ ...e, path, depth });
      if (e.dir && open.has(path)) walk(path, depth + 1);
    }
  };
  if (open.has(root)) walk(root, 1);

  const menu = async (e, row) => {
    e.preventDefault();
    setSel(row.path);
    const rel = relPath(root, row.path);
    const items = row.dir
      ? [
          { id: 'cd', label: 'cd Here' },
          { id: 'term', label: 'New Terminal Here' },
          { type: 'separator' },
          { id: 'insert', label: 'Insert Path' },
          { id: 'copy', label: 'Copy Path' },
          { id: 'copyrel', label: 'Copy Relative Path' },
          { id: 'reveal', label: 'Reveal in Finder' },
        ]
      : [
          { id: 'open', label: 'Open' },
          { id: 'insert', label: 'Insert Path' },
          { type: 'separator' },
          { id: 'copy', label: 'Copy Path' },
          { id: 'copyrel', label: 'Copy Relative Path' },
          { id: 'reveal', label: 'Reveal in Finder' },
        ];
    const id = await api.app.popupMenu(items);
    if (id === 'open') A.openFile(row.path);
    else if (id === 'cd') A.typeCommand(project.sid, `cd ${A.shellQuote(row.path)}`);
    else if (id === 'term') A.openTerminal({ cwd: row.path, viaRules: false });
    else if (id === 'insert') A.insertText(project.sid, A.shellQuote(rel) + ' ');
    else if (id === 'copy') navigator.clipboard.writeText(row.path);
    else if (id === 'copyrel') navigator.clipboard.writeText(rel);
    else if (id === 'reveal') api.sys.reveal(row.dir ? row.path : dirName(row.path));
  };

  return (
    <div className="tree">
      <div className="tree-row root" onClick={() => toggle(root)} title={root}>
        <span className={`chev${open.has(root) ? ' open' : ''}`}>
          <IconChevron size={11} />
        </span>
        <IconFolder size={15} />
        <span className="nm">{baseName(root) || root}</span>
        <button
          className="icon-btn sm tree-refresh"
          title="Refresh"
          onClick={(e) => {
            e.stopPropagation();
            refresh();
          }}
        >
          <IconRefresh size={13} />
        </button>
      </div>
      <div className="tree-scroll">
        {rows.map((r) => {
          const rel = relPath(root, r.path);
          const st = r.dir ? (changedDirs.has(rel) ? 'dirty' : null) : status.get(rel);
          const cls = ['tree-row', r.dir && 'dir', st && `st-${st}`, (sel === r.path || viewing === r.path) && 'sel', DIM_NAMES.has(r.name) ? 'ignored' : r.name.startsWith('.') && 'faded'].filter(Boolean).join(' ');
          return (
            <div
              key={r.path}
              className={cls}
              style={{ paddingLeft: 8 + r.depth * 14 }}
              title={rel}
              onClick={() => {
                setSel(r.path);
                r.dir ? toggle(r.path) : A.openFile(r.path);
              }}
              onContextMenu={(e) => menu(e, r)}
            >
              {r.dir ? (
                <span className={`chev${open.has(r.path) ? ' open' : ''}`}>
                  <IconChevron size={11} />
                </span>
              ) : (
                <span className="chev" />
              )}
              {r.dir ? open.has(r.path) ? <IconFolderOpen size={15} /> : <IconFolder size={15} /> : <FileGlyph name={r.name} />}
              <span className="nm">{r.name}</span>
              {st && <span className="st-dot" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Small type badges like Warp's: braces for JSON, M↓ for Markdown, otherwise a page.
export function FileGlyph({ name }) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'json' || ext === 'jsonc') return <span className="fglyph json">{'{ }'}</span>;
  if (ext === 'md' || ext === 'mdx') return <span className="fglyph md">M↓</span>;
  return <IconFile size={15} />;
}

// ---- Find file ----------------------------------------------------------------------
const fileCache = new Map(); // root -> { at, files }

function FileSearch({ project }) {
  const { root } = project;
  const [q, setQ] = useState('');
  const [files, setFiles] = useState(() => fileCache.get(root)?.files || null);
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const focusTick = ui.use((s) => s.searchFocus);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  useEffect(() => {
    const hit = fileCache.get(root);
    if (hit && Date.now() - hit.at < 30_000) return;
    api.sys.projectFiles(root).then((list) => {
      fileCache.set(root, { at: Date.now(), files: list });
      setFiles(list);
    });
  }, [root]);

  const results = useMemo(() => {
    if (!files) return [];
    const query = q.trim();
    if (!query) return files.slice(0, 200).map((f) => ({ f, hits: [] }));
    const out = [];
    for (const f of files) {
      const m = fuzzy(query, f);
      if (m) out.push({ f, hits: m.indices, score: m.score + (fuzzy(query, baseName(f))?.score || 0) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 200);
  }, [files, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const open = (r) => r && A.openFile(`${root}/${r.f}`);
  return (
    <div className="fsearch">
      <label className="fs-input">
        <IconSearch size={13} />
        <input
          ref={inputRef}
          value={q}
          spellCheck={false}
          placeholder={`Find in ${baseName(root)}…`}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((i) => Math.min(results.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setSel((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter') open(results[sel]);
            else if (e.key === 'Escape') (ui.get().viewer ? A.closeFile() : ui.set((u) => ({ ...u, tools: 'files' })));
            else return;
            e.preventDefault();
          }}
        />
      </label>
      <div className="fs-list" ref={listRef}>
        {!files && <div className="tools-empty">Indexing…</div>}
        {files && !results.length && <div className="tools-empty">No files match</div>}
        {results.map((r, i) => {
          const base = baseName(r.f);
          const dir = dirName(r.f);
          const off = r.f.length - base.length;
          return (
            <div key={r.f} className={`fs-item${i === sel ? ' sel' : ''}`} onMouseMove={() => sel !== i && setSel(i)} onClick={() => open(r)}>
              <FileGlyph name={base} />
              <span className="nm">
                {highlight(base, r.hits.filter((x) => x >= off).map((x) => x - off)).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : p.text))}
              </span>
              <span className="dir">{dir}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
