import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '../styles/commandbar.css';
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import * as reg from '../term/registry.js';
import * as L from '../lib/layout.js';
import { fuzzy, highlight } from '../lib/fuzzy.js';
import { route, tildify, expandHome } from '../lib/routing.js';
import { formatAccel } from '../lib/keys.js';
import { kindOf, sessionName, formatDuration, timeAgo, dayLabel } from '../lib/meta.js';
import { promptText } from './Sidebar.jsx';

const api = window.termac;

const GROUPS = [
  ['path', 'Directory'],
  ['run', 'Run'],
  ['session', 'Open sessions'],
  ['dir', 'Recent directories'],
  ['host', 'SSH hosts'],
  ['snippet', 'Snippets'],
  ['action', 'Actions'],
];
const FILTERS = [
  ['all', 'All'],
  ['session', 'Sessions'],
  ['dir', 'Directories'],
  ['host', 'Hosts'],
  ['snippet', 'Snippets'],
  ['action', 'Actions'],
];
const PREFIX = { '@': 'host', '/': 'snippet' };
const GROUP_CAP = 6;
const SOLO_CAP = 60;
const TOTAL_CAP = 40;
const EMPTY_CAP = { session: 6, dir: 4 };
const EMPTY_ACTIONS = ['newTerminal', 'openDir', 'splitRight', 'library', 'settings'];

export default function CommandBar({ onClose }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState(0);
  const [pathOk, setPathOk] = useState(null);
  const listRef = useRef(null);

  // Snapshot of everything searchable, taken once per open.
  const cands = useMemo(buildCandidates, []);

  const { prefix, term } = parseQuery(query);
  const scope = prefix === '>' ? 'run' : PREFIX[prefix] || filter;

  // Paths typed directly ("~/work/api", "/usr/local") get an "Open terminal in…" row.
  const pathQuery = looksLikePath(query) ? query.trim() : null;
  useEffect(() => {
    if (!pathQuery) return;
    const t = setTimeout(() => {
      Promise.resolve(api?.sys.isDir(expandHome(pathQuery, cands.home)))
        .then((ok) => setPathOk(ok ? pathQuery : null))
        .catch(() => setPathOk(null));
    }, 140);
    return () => clearTimeout(t);
  }, [pathQuery, cands.home]);

  const items = useMemo(() => rank(cands, { prefix, term, scope, path: pathQuery && pathOk === pathQuery ? pathQuery : null }), [cands, prefix, term, scope, pathQuery, pathOk]);

  useEffect(() => setSel(0), [query, filter]);
  const cur = Math.min(sel, items.length - 1);

  useLayoutEffect(() => {
    listRef.current?.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [cur, items]);

  const run = (item, mode) => {
    if (!item) return;
    onClose();
    item.run(mode);
  };

  const cycle = (d) => {
    if (prefix) return;
    const i = FILTERS.findIndex(([f]) => f === filter);
    setFilter(FILTERS[(i + d + FILTERS.length) % FILTERS.length][0]);
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) setSel((cur + 1) % Math.max(1, items.length));
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) setSel((cur - 1 + items.length) % Math.max(1, items.length));
    else if (e.key === 'Tab') cycle(e.shiftKey ? -1 : 1);
    else if (e.key === 'Enter') run(items[cur], e.metaKey ? 'new' : e.altKey ? 'split' : 'open');
    else if (e.key === 'Escape') onClose();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const chipText = prefix ? `${{ '>': 'Run', '@': 'Hosts', '/': 'Snippets' }[prefix]} only` : filter === 'all' ? 'All · ⇥ to filter' : `${FILTERS.find(([f]) => f === filter)[1]} · ⇥`;

  let lastGroup = null;
  return (
    <div className="palette cb" onMouseDown={(e) => e.target.tagName !== 'INPUT' && e.preventDefault()}>
      <div className="input-row">
        <span className="prompt">❯</span>
        <input autoFocus spellCheck={false} value={query} placeholder="Search sessions, directories, hosts, snippets, actions…" onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
        <button className="filter" onClick={() => cycle(1)}>
          {chipText}
        </button>
      </div>
      <div className="results" ref={listRef}>
        {items.length === 0 && <div className="none">{emptyText(prefix, term)}</div>}
        {items.map((it, i) => {
          const head = it.group !== lastGroup ? GROUPS.find(([g]) => g === it.group)[1] : null;
          const first = head != null;
          lastGroup = it.group;
          return (
            <Row
              key={it.key}
              item={it}
              head={head}
              selected={i === cur}
              first={first}
              onHover={() => i !== cur && setSel(i)}
              onPick={(e) => run(it, e.metaKey ? 'new' : e.altKey ? 'split' : 'open')}
            />
          );
        })}
      </div>
      <div className="footer">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>⌘↵ new terminal</span>
        <span>⌥↵ open in split</span>
        <span className="r">&gt; run · @ host · / snippet</span>
      </div>
    </div>
  );
}

function Row({ item, head, selected, first, onHover, onPick }) {
  const hint = item.hint || ((selected || first) && item.selHint) || null;
  return (
    <>
      {head && <div className="group">{head}</div>}
      <div className={`item${selected ? ' sel' : ''}`} onMouseMove={onHover} onClick={onPick}>
        {item.glyph ? (
          <span className="chip cb-glyph" style={{ '--c': item.color }}>
            {item.glyph}
          </span>
        ) : (
          <span className="chip">{item.chip}</span>
        )}
        <span className={`cb-label${item.mono ? ' cb-mono' : ''}`}>
          <Hl text={item.label} idx={item.hl} />
        </span>
        {item.prod && <span className="prod">PROD</span>}
        {item.sub && (
          <span className={`sub${item.subMono ? ' cb-mono' : ''}`}>
            <Hl text={item.sub} idx={item.subHl} />
          </span>
        )}
        {hint && (
          <span className="hint">
            {selected && item.group === 'session' && <span className="cb-dot" />}
            {hint}
          </span>
        )}
      </div>
    </>
  );
}

function Hl({ text, idx }) {
  if (!idx?.length) return text;
  return highlight(text, idx).map((p, i) => (p.hit ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>));
}

// ---- Query ---------------------------------------------------------------------------
function parseQuery(q) {
  const c = q[0];
  if (c === '>' || c === '@' || c === '/') return { prefix: c, term: q.slice(1).trim() };
  return { prefix: '', term: q.trim() };
}

function looksLikePath(q) {
  const t = q.trim();
  return /^~(\/|$)/.test(t) || /^\/[^\s]*$/.test(t);
}

function emptyText(prefix, term) {
  if (prefix === '>') return 'Type a command to run it in a new terminal';
  if (prefix === '@') return term ? 'No matching SSH hosts' : 'No SSH hosts found in ~/.ssh/config';
  if (prefix === '/') return term ? 'No matching snippets' : 'No snippets yet';
  return 'No matches';
}

// ---- Candidates ----------------------------------------------------------------------
function buildCandidates() {
  const s = app.get();
  const r = rt.get();
  const u = ui.get();
  const home = u.home;
  const now = Date.now();
  const activeTid = A.activeTabId(s);
  const keys = s.settings.keybindings;
  const spaceById = Object.fromEntries(s.spaces.map((sp) => [sp.id, sp]));
  const routeHint = (rule) => {
    if (rule?.action?.type !== 'space') return null;
    const sp = spaceById[rule.action.spaceId];
    return sp ? `Opens in ${sp.glyph} ${sp.name}` : null;
  };

  // Sessions: every tab across Favorites and all Spaces.
  const placed = [];
  for (const tid of s.favorites) placed.push({ tid, where: 'Favorites', spaceId: null });
  for (const sp of s.spaces) {
    for (const tid of sp.pinned) placed.push({ tid, where: `${sp.name} · Pinned`, spaceId: sp.id });
    for (const f of sp.folders) for (const tid of f.tabs) placed.push({ tid, where: `${sp.name} › ${f.name}`, spaceId: sp.id });
    for (const tid of sp.today) placed.push({ tid, where: `${sp.name} · Today`, spaceId: sp.id });
  }
  const sessions = [];
  for (const { tid, where, spaceId } of placed) {
    const tab = s.tabs[tid];
    if (!tab) continue;
    const sids = L.leaves(tab.layout);
    const names = sids.map((sid) => sessionName(s.sessions[sid], r[sid], home));
    const label = tab.name || names.join(' · ') || '~';
    const cur = r[tab.activeSid] || {};
    const meta = s.sessions[tab.activeSid] || {};
    const running = sids.map((sid) => r[sid]).find((x) => x?.status === 'run');
    const failed = sids.map((sid) => r[sid]).find((x) => x?.status === 'fail');
    const status = running ? (running.cmdStart ? ` · running ${formatDuration(now - running.cmdStart)}` : ' · running') : failed ? ` · exit ${failed.exitCode}` : '';
    const recency = Math.max(tab.createdAt || 0, ...sids.map((sid) => Math.max(reg.getHandle(sid)?.lastActivity || 0, r[sid]?.endedAt || 0, r[sid]?.cmdStart || 0)));
    const cwd = cur.cwd || meta.cwd;
    const active = tid === activeTid;
    sessions.push({
      key: `s:${tid}`,
      group: 'session',
      tid,
      label,
      sub: where + status,
      extra: [cwd && tildify(cwd, home), ...names].filter(Boolean).join(' '),
      chip: kindOf(cur.command || meta.command),
      selHint: 'Switch to session ↵',
      recency,
      spaceId,
      active,
      run(mode) {
        if (mode === 'new') return A.openTerminal({ cwd });
        if (mode === 'split' && !active && A.activeTab()) return A.mergeIntoActive(tid, 'right');
        A.activateTab(tid);
      },
    });
  }

  const dirs = s.recentDirs.map((d, i) => {
    const label = tildify(d.path, home);
    const when = dayLabel(d.last, now);
    return {
      key: `d:${d.path}`,
      group: 'dir',
      label,
      mono: true,
      sub: d.visits >= 3 ? `${d.visits} visits` : when === 'Today' ? timeAgo(d.last, now) : when.toLowerCase(),
      chip: '>_',
      selHint: 'New terminal ⌘↵',
      bonus: Math.log2(1 + (d.visits || 1)) * 2 - i * 0.02,
      run: (mode) => openDir(d.path, mode),
    };
  });

  const hosts = (u.sshHosts || []).map((h) => {
    const target = h.hostname || h.alias;
    const command = `ssh ${h.alias}`;
    const m = route(s.rules, { host: target, command }, home) || (target !== h.alias ? route(s.rules, { host: h.alias, command }, home) : null);
    const rule = m?.rule;
    return {
      key: `h:${h.alias}`,
      group: 'host',
      label: h.user ? `${h.user}@${target}` : target,
      mono: true,
      sub: h.alias !== target ? h.alias : '',
      subMono: true,
      chip: 'ssh',
      prod: !!rule?.effects?.danger,
      hint: routeHint(rule),
      selHint: 'Connect ↵',
      run: (mode) => A.openTerminal({ command, host: target, ...(mode === 'split' ? { splitOf: A.activeTabId(), edge: 'right' } : {}) }),
    };
  });

  const activeSpaceId = s.activeSpaceId;
  const snippets = s.snippets.map((sn) => {
    const other = sn.spaceId && sn.spaceId !== activeSpaceId ? spaceById[sn.spaceId] : null;
    return {
      key: `n:${sn.id}`,
      group: 'snippet',
      label: `/${sn.name}`,
      sub: sn.command.split('\n')[0] + (other ? `  · ${other.name}` : ''),
      subMono: true,
      chip: '{ }',
      bonus: other ? 0 : 3,
      selHint: 'Run ↵',
      run(mode) {
        if (mode === 'new') return A.openTerminal({ command: sn.command });
        if (mode === 'split') return A.openTerminal({ command: sn.command, splitOf: A.activeTabId(), edge: 'right', viaRules: false });
        A.runInSession(sn.command);
      },
    };
  });

  const k = (id) => formatAccel(keys[id]);
  const setUi = (patch) => ui.set((x) => ({ ...x, ...patch }));
  const act = (id, label, run, { words = '', hint, ...opt } = {}) => ({ key: `a:${id}`, group: 'action', id, label, chip: '›', ...opt, hint: hint ?? k(id), extra: words, run: () => run() });
  const actions = [
    act('newTerminal', 'New terminal', () => A.openTerminal(), { chip: '+' }),
    act('splitRight', 'Split right', () => A.splitActive('right'), { chip: '⇥' }),
    act('splitDown', 'Split down', () => A.splitActive('down'), { chip: '⤓' }),
    act('openDir', 'Open directory…', async () => {
      const dir = await api.sys.chooseDir(home);
      if (dir) A.openTerminal({ cwd: dir });
    }, { hint: '', words: 'folder choose' }),
    ...s.spaces.map((sp, i) =>
      act(`space:${sp.id}`, `Switch to Space · ${sp.name}`, () => A.switchSpace(sp.id), { glyph: sp.glyph, color: sp.color, hint: i < 9 ? `⌃${i + 1}` : '', current: sp.id === activeSpaceId }),
    ),
    act('newSpace', 'New Space', () => setUi({ overlay: 'spaceEditor', overlayArg: null })),
    act('overview', 'All Spaces', () => setUi({ overlay: 'overview' }), { words: 'overview' }),
    act('prevSpace', 'Previous Space', () => A.switchSpace(-1)),
    act('nextSpace', 'Next Space', () => A.switchSpace(1)),
    act('library', 'Library', () => setUi({ view: 'library' }), { words: 'archive history' }),
    act('notes', 'Notes', () => ui.set((x) => ({ ...x, notesOpen: !x.notesOpen })), { words: 'toggle panel' }),
    act('settings', 'Settings', () => setUi({ overlay: 'settings' }), { words: 'preferences' }),
    act('toggleSidebar', 'Collapse / expand sidebar', () => A.toggleSidebar()),
    act('focusMode', 'Focus mode (hide sidebar)', () => A.toggleFocusMode()),
    act('copyLastOutput', 'Copy last output', () => A.copyLastOutput()),
    act('find', 'Find in terminal', () => setUi({ find: true }), { words: 'search' }),
    act('clear', 'Clear scrollback', () => A.focusedSid() && reg.clear(A.focusedSid())),
    act('rename', 'Rename session…', async () => {
      const tid = A.activeTabId();
      const tab = tid && app.get().tabs[tid];
      if (!tab) return;
      const name = await promptText('Rename session', tab.name || '');
      if (name != null) A.renameTab(tid, name);
    }, { hint: '' }),
    act('tidy', 'Tidy idle sessions', () => A.tidy(), { hint: '', words: 'archive clean' }),
    act('closePane', 'Close pane', () => A.closePane()),
    act('nextTab', 'Next session', () => A.cycleTab(1)),
    act('prevTab', 'Previous session', () => A.cycleTab(-1)),
    act('zoomIn', 'Bigger text', () => A.zoom(1), { words: 'zoom font' }),
    act('zoomOut', 'Smaller text', () => A.zoom(-1), { words: 'zoom font' }),
    act('zoomReset', 'Actual size', () => A.zoom(0), { words: 'zoom font reset' }),
  ].filter((a) => !a.current);

  return { home, rules: s.rules, spaces: spaceById, activeTid, activeSpaceId, sessions, dirs, hosts, snippets, actions };
}

function openDir(path, mode) {
  if (mode === 'split') return A.openTerminal({ cwd: path, splitOf: A.activeTabId(), edge: 'right', viaRules: false });
  A.openTerminal({ cwd: path });
}

// ---- Ranking -------------------------------------------------------------------------
function match(item, term) {
  const m = fuzzy(term, item.label);
  if (m) return { ...item, hl: m.indices, subHl: null, score: m.score + (item.bonus || 0) };
  if (item.sub) {
    const ms = fuzzy(term, item.sub);
    if (ms) return { ...item, hl: null, subHl: ms.indices, score: ms.score * 0.6 + (item.bonus || 0) };
  }
  if (item.extra) {
    const me = fuzzy(term, item.extra);
    if (me) return { ...item, hl: null, subHl: null, score: me.score * 0.5 + (item.bonus || 0) };
  }
  return null;
}

function top(list, term, cap) {
  const out = [];
  for (const it of list) {
    const m = match(it, term);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, cap);
}

function rank(c, { prefix, term, scope, path }) {
  const out = [];
  if (path) out.push({ key: `p:${path}`, group: 'path', label: `Open terminal in ${path}`, chip: '>_', selHint: '↵', run: (mode) => openDir(path, mode) });

  if (prefix === '>') {
    if (!term) return out;
    const m = route(c.rules, { command: term }, c.home);
    const sp = m?.rule?.action?.type === 'space' ? c.spaces[m.rule.action.spaceId] : null;
    out.push({
      key: 'run',
      group: 'run',
      label: term,
      mono: true,
      sub: 'Run in a new terminal',
      chip: '>_',
      prod: !!m?.rule?.effects?.danger,
      hint: sp ? `Opens in ${sp.glyph} ${sp.name}` : m?.rule?.action?.type === 'split' ? 'Opens in split' : '↵',
      run: (mode) => A.openTerminal({ command: term, ...(mode === 'split' ? { splitOf: A.activeTabId(), edge: 'right' } : {}) }),
    });
    return out;
  }

  const solo = scope !== 'all';
  const want = (g) => scope === 'all' || scope === g;

  if (!term) {
    if (want('session')) {
      const list = c.sessions.filter((x) => solo || !x.active).sort((a, b) => (b.spaceId === c.activeSpaceId) - (a.spaceId === c.activeSpaceId) || b.recency - a.recency);
      out.push(...list.slice(0, solo ? SOLO_CAP : EMPTY_CAP.session));
    }
    if (want('dir')) out.push(...c.dirs.slice(0, solo ? SOLO_CAP : EMPTY_CAP.dir));
    if (want('host') && solo) out.push(...c.hosts.slice(0, SOLO_CAP));
    if (want('snippet') && solo) out.push(...[...c.snippets].sort((a, b) => b.bonus - a.bonus).slice(0, SOLO_CAP));
    if (want('action')) out.push(...(solo ? c.actions.slice(0, SOLO_CAP) : EMPTY_ACTIONS.map((id) => c.actions.find((a) => a.id === id)).filter(Boolean)));
    return out;
  }

  const cap = solo ? SOLO_CAP : GROUP_CAP;
  const sessions = want('session') ? top(c.sessions, term, cap) : [];
  if (want('session')) out.push(...sessions);
  if (want('dir')) out.push(...top(c.dirs, term, cap));
  if (want('host')) out.push(...top(c.hosts, term, cap));
  if (want('snippet')) {
    const sn = top(c.snippets, term, cap);
    // A typed path wins over snippets unless one actually matches it.
    if (path && prefix === '/' && sn.length && !path.slice(1).includes('/')) out.shift();
    out.push(...sn);
  }
  if (want('action')) {
    const acts = top(c.actions, term, cap);
    const best = sessions.find((x) => !x.active);
    if (best && c.activeTid && scope === 'all') {
      acts.unshift({
        key: `a:merge:${best.tid}`,
        group: 'action',
        label: `Split right with ${best.label}`,
        hl: shiftHl(best.hl, 'Split right with '.length),
        chip: '⇥',
        hint: '⌥↵',
        run: () => A.mergeIntoActive(best.tid, 'right'),
      });
    }
    out.push(...acts.slice(0, cap));
  }
  return out.slice(0, solo ? SOLO_CAP : TOTAL_CAP);
}

function shiftHl(idx, n) {
  return idx ? idx.map((i) => i + n) : null;
}
