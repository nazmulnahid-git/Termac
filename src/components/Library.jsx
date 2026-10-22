import '../styles/library.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { app, ui } from '../state/model.js';
import { shallow } from '../state/store.js';
import * as A from '../state/actions.js';
import { THEMES, focus as focusTerm } from '../term/registry.js';
import { clockTime, dayLabel } from '../lib/meta.js';
import { tildify } from '../lib/routing.js';
import { monoStack } from '../lib/fonts.js';

const api = window.termac;

const ARCHIVE_OPTS = [
  [1, '1 hour idle'],
  [4, '4 hours idle'],
  [12, '12 hours idle'],
  [24, '24 hours idle'],
  [72, '3 days idle'],
  [0, 'Never'],
];
const STATUS_OPTS = [
  [null, 'any'],
  ['ok', 'ok'],
  ['fail', 'failed'],
  ['idle', 'idle'],
];
const DAYS_OPTS = [
  [1, 'Last 24 hours'],
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
  [0, 'All time'],
];
const HIT_LABEL = { command: 'in commands', path: 'in path', output: 'in output' };
const SEP = '\u0001';

const archiveLabel = (h) => ARCHIVE_OPTS.find(([v]) => v === h)?.[1] || `${h} hours idle`;

function shortLines(n = 0) {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const weekday = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short' });
const longDate = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

// "16:02 – 16:40" for recent entries, "Thu 11:20" within the week, "19 Oct 11:20" beyond.
function whenLabel(e, label) {
  if (label === 'Today' || label === 'Yesterday') return sameDay(e.startedAt, e.endedAt) ? `${clockTime(e.startedAt)} – ${clockTime(e.endedAt)}` : `${weekday(e.startedAt)} ${clockTime(e.startedAt)} – ${clockTime(e.endedAt)}`;
  if (Date.now() - e.endedAt < 7 * 86400000) return `${weekday(e.endedAt)} ${clockTime(e.endedAt)}`;
  return `${new Date(e.endedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clockTime(e.endedAt)}`;
}

function idleFor(e) {
  const ms = Math.max(0, (e.endedAt || 0) - (e.idleSince || e.endedAt || 0));
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < 72 * 3600000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

function distinct(list) {
  const counts = new Map();
  for (const v of list) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

export default function Library() {
  const spacesKey = app.use((s) => s.spaces.map((sp) => [sp.id, sp.name, sp.glyph, sp.color].join(SEP)).join('\n'));
  const settings = app.use((s) => ({ archiveAfterH: s.settings.archiveAfterH, fontSize: s.settings.fontSize, fontFamily: s.settings.fontFamily, lineHeight: s.settings.lineHeight, letterSpacing: s.settings.letterSpacing, fontWeight: s.settings.fontWeight, fontWeightBold: s.settings.fontWeightBold }), shallow);
  const theme = ui.use((s) => s.termTheme);
  const home = ui.use((s) => s.home);

  const spaces = useMemo(
    () =>
      spacesKey
        ? spacesKey.split('\n').map((line) => {
            const [id, name, glyph, color] = line.split(SEP);
            return { id, name, glyph, color };
          })
        : [],
    [spacesKey],
  );
  const spaceById = useMemo(() => Object.fromEntries(spaces.map((sp) => [sp.id, sp])), [spaces]);

  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [filters, setFilters] = useState({ spaceId: null, cwd: null, host: null, status: null, sinceDays: 30 });
  const [data, setData] = useState(null); // { total, results }
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [selId, setSelId] = useState(null);
  const reqId = useRef(0);
  const alive = useRef(true);
  const listRef = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Debounce the query; clearing applies immediately.
  useEffect(() => {
    if (!q.trim()) {
      setDq('');
      return;
    }
    const t = setTimeout(() => setDq(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const id = ++reqId.current;
    setBusy(true);
    api.library
      .search({ q: dq, ...filters })
      .then((res) => {
        if (!alive.current || id !== reqId.current) return;
        setData(res || { total: 0, results: [] });
        setBusy(false);
      })
      .catch(() => alive.current && id === reqId.current && setBusy(false));
  }, [dq, filters, version]);

  const refresh = () => setVersion((v) => v + 1);
  const results = data?.results || [];

  // Facets come from the results while their own filter is unset, and stick once it's set.
  const dirsRef = useRef([]);
  const hostsRef = useRef([]);
  const dirs = useMemo(() => (filters.cwd ? dirsRef.current : (dirsRef.current = distinct(results.map((e) => e.cwd)).slice(0, 40))), [results, filters.cwd]);
  const hosts = useMemo(() => (filters.host ? hostsRef.current : (hostsRef.current = distinct(['local', ...results.map((e) => e.host || 'local')]))), [results, filters.host]);

  const groups = useMemo(() => {
    const out = [];
    for (const e of results) {
      const label = dayLabel(e.endedAt);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [results]);

  const sel = results.find((e) => e.id === selId) || results[0] || null;
  const slotRef = usePreview(sel?.id, theme, settings);

  useEffect(() => {
    listRef.current?.querySelector('.lib-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel?.id]);

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

  const back = () => {
    ui.set((u) => ({ ...u, view: 'terminal' }));
    requestAnimationFrame(() => {
      const sid = A.focusedSid();
      if (sid) focusTerm(sid);
    });
  };

  const restoring = useRef(false);
  const restore = async (entry, spaceId) => {
    if (!entry || restoring.current) return;
    restoring.current = true;
    try {
      await A.restoreFromLibrary(entry, spaceId);
    } finally {
      restoring.current = false;
    }
    ui.set((u) => (u.view === 'terminal' ? u : { ...u, view: 'terminal' }));
    if (alive.current) refresh();
  };

  const restoreTo = async (entry) => {
    const id = await api.app.popupMenu(spaces.map((sp) => ({ id: sp.id, label: `${sp.glyph} ${sp.name}`, checked: sp.id === entry.spaceId })));
    if (id) restore(entry, id);
  };

  const remove = async (entry) => {
    const ok = await api.sys.confirm({ message: `Delete “${entry.name}” from the Library?`, detail: 'Its scrollback and command history will be removed.', ok: 'Delete' });
    if (!ok) return;
    const i = results.findIndex((e) => e.id === entry.id);
    const next = results[i + 1] || results[i - 1];
    await api.library.remove(entry.id);
    if (!alive.current) return;
    setSelId(next?.id || null);
    refresh();
  };

  const move = (delta) => {
    if (!results.length) return;
    const i = results.findIndex((e) => e.id === sel?.id);
    const n = Math.max(0, Math.min(results.length - 1, i + delta));
    setSelId(results[n].id);
  };

  const onListKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      restore(sel);
    }
  };

  const onInputKey = (e) => {
    if (e.key === 'Escape' && q) {
      e.preventDefault();
      e.stopPropagation();
      setQ('');
      return;
    }
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      listRef.current?.focus();
      move(sel ? 1 : 0);
    } else if (e.key === 'Enter' && sel) {
      e.preventDefault();
      restore(sel);
    }
  };

  const onRootKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      back();
    }
  };

  // ---- Filter menus ----
  const pickArchive = async () => {
    const id = await api.app.popupMenu(ARCHIVE_OPTS.map(([v, label]) => ({ id: `a${v}`, label, checked: v === settings.archiveAfterH })));
    if (id) A.setSettings({ archiveAfterH: Number(id.slice(1)) });
  };
  const pickSpace = async () => {
    const id = await api.app.popupMenu([{ id: '*', label: 'All Spaces', checked: !filters.spaceId }, { type: 'separator' }, ...spaces.map((sp) => ({ id: sp.id, label: `${sp.glyph} ${sp.name}`, checked: sp.id === filters.spaceId }))]);
    if (id) setFilter({ spaceId: id === '*' ? null : id });
  };
  const pickDir = async () => {
    const items = dirs.map((d, i) => ({ id: `d${i}`, label: tildify(d, home), checked: d === filters.cwd }));
    const id = await api.app.popupMenu([{ id: '*', label: 'Any directory', checked: !filters.cwd }, ...(items.length ? [{ type: 'separator' }, ...items] : [])]);
    if (id) setFilter({ cwd: id === '*' ? null : dirs[Number(id.slice(1))] });
  };
  const pickHost = async () => {
    const id = await api.app.popupMenu([{ id: '*', label: 'Any host', checked: !filters.host }, { type: 'separator' }, ...hosts.map((h, i) => ({ id: `h${i}`, label: h, checked: h === filters.host }))]);
    if (id) setFilter({ host: id === '*' ? null : hosts[Number(id.slice(1))] });
  };
  const pickStatus = async () => {
    const id = await api.app.popupMenu(STATUS_OPTS.map(([v, label]) => ({ id: `s${v}`, label: v ? label[0].toUpperCase() + label.slice(1) : 'Any status', checked: v === filters.status })));
    if (id) setFilter({ status: id === 'snull' ? null : id.slice(1) });
  };
  const pickDays = async () => {
    const id = await api.app.popupMenu(DAYS_OPTS.map(([v, label]) => ({ id: `t${v}`, label, checked: v === filters.sinceDays })));
    if (id) setFilter({ sinceDays: Number(id.slice(1)) });
  };

  const fSpace = filters.spaceId && spaceById[filters.spaceId];
  const total = data?.total ?? 0;
  const filtered = !!(dq || filters.spaceId || filters.cwd || filters.host || filters.status || filters.sinceDays !== 30);

  let body;
  if (!data) body = <div className="lib-body" />;
  else if (total === 0) body = <EmptyLibrary hours={settings.archiveAfterH} />;
  else if (!results.length)
    body = (
      <div className="lib-body lib-none">
        <h3>No sessions match</h3>
        <p>{dq ? `Nothing in names, commands, paths or output contains “${dq}”.` : 'No archived sessions match these filters.'}</p>
        {filtered && (
          <button
            className="btn"
            onClick={() => {
              setQ('');
              setFilters({ spaceId: null, cwd: null, host: null, status: null, sinceDays: 0 });
            }}
          >
            Clear search & filters
          </button>
        )}
      </div>
    );
  else
    body = (
      <div className="lib-body">
        <div className="lib-list" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
          {groups.map((g) => (
            <div key={g.label} className="lib-group">
              <div className="lib-day">{g.label}</div>
              {g.items.map((e) => (
                <Item key={e.id} e={e} label={g.label} home={home} hit={dq ? e.hit : null} on={e.id === sel?.id} onSelect={() => setSelId(e.id)} onOpen={() => restore(e)} />
              ))}
            </div>
          ))}
          {results.length >= 500 && <div className="lib-cap">Showing the first 500 — refine the search to see more.</div>}
        </div>
        {sel && <Detail e={sel} space={spaceById[sel.spaceId]} home={home} theme={theme} slotRef={slotRef} onRestore={() => restore(sel)} onRestoreTo={() => restoreTo(sel)} onDelete={() => remove(sel)} />}
      </div>
    );

  return (
    <div className="lib" onKeyDown={onRootKey}>
      <div className="lib-head">
        <div className="lib-titlebar">
          <span className="lib-title">Library</span>
          <span className="dim">
            {total.toLocaleString()} archived session{total === 1 ? '' : 's'}
          </span>
          <span className="grow" />
          <span className="dim">Archive after</span>
          <button className="lib-select" onClick={pickArchive}>
            {archiveLabel(settings.archiveAfterH)} ▾
          </button>
        </div>
        <label className="lib-search">
          <span className="dim">⌕</span>
          <input autoFocus value={q} placeholder="Search sessions" spellCheck={false} onChange={(e) => setQ(e.target.value)} onKeyDown={onInputKey} />
          <span className="lib-hint">{busy && dq ? 'searching…' : 'searching commands, output & paths'}</span>
        </label>
        <div className="lib-chips">
          {fSpace ? (
            <button className="lib-chip space" style={{ '--c': fSpace.color }} onClick={pickSpace}>
              {fSpace.glyph} {fSpace.name}
              <span
                className="x"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setFilter({ spaceId: null });
                }}
              >
                ✕
              </span>
            </button>
          ) : (
            <button className="lib-chip" onClick={pickSpace}>
              Space ▾
            </button>
          )}
          <button className={`lib-chip${filters.cwd ? ' on' : ''}`} onClick={pickDir} title={filters.cwd || ''}>
            {filters.cwd ? <span className="mono">{tildify(filters.cwd, home)}</span> : 'Directory'} ▾
          </button>
          <button className={`lib-chip${filters.host ? ' on' : ''}`} onClick={pickHost}>
            Host: {filters.host || 'any'} ▾
          </button>
          <button className={`lib-chip${filters.status ? ' on' : ''}`} onClick={pickStatus}>
            Status: {STATUS_OPTS.find(([v]) => v === filters.status)?.[1]} ▾
          </button>
          <button className={`lib-chip${filters.sinceDays !== 30 ? ' on' : ''}`} onClick={pickDays}>
            {DAYS_OPTS.find(([v]) => v === filters.sinceDays)?.[1]} ▾
          </button>
        </div>
      </div>
      {body}
    </div>
  );
}

function Item({ e, label, home, hit, on, onSelect, onOpen }) {
  const remote = e.host && e.host !== 'local';
  const last = e.commands?.[e.commands.length - 1]?.cmd;
  return (
    <div className={`lib-item${on ? ' sel' : ''}`} onMouseDown={onSelect} onDoubleClick={onOpen}>
      <div className="lib-l1">
        <span className="lib-name ellipsis">{e.name}</span>
        {remote && last && last !== e.name && <span className="lib-arrow ellipsis">→ {last}</span>}
        <span className="grow" />
        {hit && HIT_LABEL[hit] && <span className="lib-hit">{HIT_LABEL[hit]}</span>}
        <StatusEnd e={e} />
      </div>
      <div className="lib-l2">
        <span className="mono ellipsis">{remote ? e.host : tildify(e.cwd, home)}</span>
        <span>·</span>
        <span className="lib-when">{whenLabel(e, label)}</span>
      </div>
    </div>
  );
}

function StatusEnd({ e }) {
  if (e.status === 'ok') return <span className="lib-ok">✓</span>;
  if (e.status === 'fail') return <span className="lib-exit">exit {e.exitCode}</span>;
  return <span className="status st-idle" title="No finished commands" />;
}

function Detail({ e, space, home, theme, slotRef, onRestore, onRestoreTo, onDelete }) {
  const pill = e.exitCode == null ? ['idle', ''] : e.exitCode === 0 ? ['exit 0', ' ok'] : [`exit ${e.exitCode}`, ' fail'];
  const ended = `${sameDay(e.startedAt, e.endedAt) ? '' : longDate(e.endedAt) + ', '}${clockTime(e.endedAt)}${e.reason === 'idle' ? ` · idle ${idleFor(e)}` : e.reason === 'quick' ? ' · Quick Terminal' : ' · closed'}`;
  const cmds = e.commands || [];
  return (
    <div className="lib-detail">
      <div className="lib-dhead">
        <span className="lib-dtitle ellipsis" title={e.name}>
          {e.name}
        </span>
        <span className={`lib-pill${pill[1]}`}>{pill[0]}</span>
        <span className="grow" />
        <button className="lib-del" onClick={onDelete}>
          Delete
        </button>
        <button className="btn lib-btn" onClick={onRestoreTo}>
          Restore to… ▾
        </button>
        <button className="btn primary lib-btn" onClick={onRestore}>
          Restore ↵
        </button>
      </div>
      <div className="lib-meta">
        <Meta k="Space">
          <span className="lib-glyph" style={{ color: space?.color }}>
            {space?.glyph || '◇'}
          </span>{' '}
          {space?.name || e.spaceName || '—'}
        </Meta>
        <Meta k="Directory" mono>
          {tildify(e.cwd, home)}
        </Meta>
        <Meta k="Host">{e.host || 'local'}</Meta>
        <Meta k="Started">
          {longDate(e.startedAt)}, {clockTime(e.startedAt)}
        </Meta>
        <Meta k="Ended">{ended}</Meta>
        <Meta k="Commands">
          {cmds.length} run · {shortLines(e.lines)} lines
        </Meta>
      </div>
      {cmds.length > 0 && (
        <div className="lib-cmds">
          <div className="lib-sub">Commands run</div>
          <div className="lib-cmdlist">
            {cmds.map((c, i) => (
              <div key={i} className="lib-cmd">
                {c.exit === 0 ? <span className="lib-ok">✓</span> : c.exit == null ? <span className="dim">•</span> : <span className="lib-x" title={`exit ${c.exit}`}>✗</span>}
                <span className="ellipsis grow">{c.cmd}</span>
                <span className="lib-t">{c.at ? clockTime(c.at) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={`lib-preview t-${theme}`}>
        <div className="lib-slot" ref={slotRef} />
      </div>
    </div>
  );
}

function Meta({ k, mono, children }) {
  return (
    <div className="lib-mi">
      <div className="dim">{k}</div>
      <div className={`ellipsis${mono ? ' mono' : ''}`}>{children}</div>
    </div>
  );
}

// One read-only xterm for the Library's lifetime; re-parented into the detail slot whenever it mounts.
function usePreview(id, theme, settings) {
  const p = useRef({ term: null, fit: null, host: null, ro: null, raf: 0 }).current;
  const opts = useRef();
  opts.current = { theme, ...settings };

  const termOptions = () => ({
    fontFamily: monoStack(opts.current.fontFamily),
    fontSize: opts.current.fontSize,
    lineHeight: opts.current.lineHeight,
    letterSpacing: opts.current.letterSpacing,
    fontWeight: opts.current.fontWeight,
    fontWeightBold: opts.current.fontWeightBold,
    theme: THEMES[opts.current.theme] || THEMES.dark,
  });

  const refit = () => {
    cancelAnimationFrame(p.raf);
    p.raf = requestAnimationFrame(() => {
      try {
        p.fit?.fit();
      } catch {
        /* not measurable yet */
      }
    });
  };

  const slotRef = useCallback((el) => {
    p.ro?.disconnect();
    p.ro = null;
    if (!el) return;
    if (!p.host) {
      p.host = document.createElement('div');
      p.host.className = 'lib-term';
    }
    el.appendChild(p.host);
    if (!p.term) {
      p.term = new Terminal({ ...termOptions(), disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none', scrollback: 6000, convertEol: false, smoothScrollDuration: 0 });
      p.fit = new FitAddon();
      p.term.loadAddon(p.fit);
      p.term.attachCustomKeyEventHandler((ev) => ev.key !== 'Escape'); // let Esc reach the Library
      p.term.open(p.host);
    }
    p.ro = new ResizeObserver(refit);
    p.ro.observe(el);
    refit();
  }, []);

  useEffect(() => {
    if (!p.term) return;
    const o = termOptions();
    for (const [k, v] of Object.entries(o)) if (p.term.options[k] !== v) p.term.options[k] = v;
    refit();
  }, [theme, settings.fontSize, settings.fontFamily, settings.lineHeight, settings.letterSpacing, settings.fontWeight, settings.fontWeightBold]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.library.content(id).then((content) => {
      const t = p.term;
      if (cancelled || !t) return;
      t.reset();
      const body = content || '\x1b[2m(no scrollback was saved for this session)\x1b[0m';
      t.write(body + '\x1b[?25l', () => !cancelled && t.scrollToBottom());
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(
    () => () => {
      p.ro?.disconnect();
      cancelAnimationFrame(p.raf);
      p.term?.dispose();
      p.host?.remove();
      p.term = p.fit = p.host = null;
    },
    [],
  );

  return slotRef;
}

function EmptyLibrary({ hours }) {
  return (
    <div className="lib-body lib-none">
      <div className="lib-tile">▤</div>
      <h3>No archived sessions yet</h3>
      <p>
        {hours
          ? `Idle sessions from Today are tidied here automatically after ${archiveLabel(hours).replace(' idle', '')} of inactivity — with their scrollback, commands and directory — so you can search and restore them any time.`
          : 'Idle sessions from Today are tidied here automatically once auto-archive is on. Sessions you move to the Library keep their scrollback, commands and directory, so you can search and restore them any time.'}
      </p>
    </div>
  );
}
