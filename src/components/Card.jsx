import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import * as reg from '../term/registry.js';
import * as L from '../lib/layout.js';
import { splitCwd, procLabel, clockTime, formatDuration, sessionName } from '../lib/meta.js';
import { formatAccel } from '../lib/keys.js';

const api = window.termac;
const TAB_MIME = 'application/x-termac-tab';
const PANE_MIME = 'application/x-termac-pane';

export default function Card() {
  const tab = app.use((s) => A.activeTab(s));
  const theme = ui.use((s) => s.termTheme);
  const sids = tab ? L.leaves(tab.layout) : [];
  const sshDanger = rt.use((s) => sids.some((id) => s[id]?.sshEffects?.danger));
  const dragging = ui.use((s) => s.dragging);
  const [edge, setEdge] = useState(null);

  if (!tab) return <EmptySpace />;
  const danger = !!tab.effects?.danger || sshDanger;
  const canDrop = dragging?.tabId && dragging.tabId !== tab.id && sids.length < L.MAX_PANES;

  const onDragOver = (e) => {
    if (!canDrop) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const d = { left: e.clientX - r.left, right: r.right - e.clientX, top: e.clientY - r.top, bottom: r.bottom - e.clientY };
    const best = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
    if (best !== edge) setEdge(best);
  };
  const onDrop = (e) => {
    const tid = e.dataTransfer.getData(TAB_MIME);
    setEdge(null);
    ui.set((u) => ({ ...u, dragging: null }));
    if (tid && edge) A.mergeIntoActive(tid, edge);
  };

  return (
    <div className={`card t-${theme}${danger ? ' danger' : ''}`} onDragOver={onDragOver} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setEdge(null)} onDrop={onDrop}>
      <Layout node={tab.layout} tid={tab.id} path={[]} activeSid={tab.activeSid} multi={sids.length > 1} danger={danger} />
      {canDrop && <EdgeZones edge={edge} tabId={dragging.tabId} />}
    </div>
  );
}

function Layout({ node, tid, path, activeSid, multi, danger }) {
  if (node.sid) return <Pane sid={node.sid} focused={node.sid === activeSid} multi={multi} danger={danger} />;
  return (
    <div className={`split split-${node.dir}`}>
      <div className="slot" style={{ flex: `${node.ratio} 1 0` }}>
        <Layout node={node.a} tid={tid} path={[...path, 'a']} activeSid={activeSid} multi={multi} danger={danger} />
      </div>
      <Divider node={node} tid={tid} path={path} />
      <div className="slot" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <Layout node={node.b} tid={tid} path={[...path, 'b']} activeSid={activeSid} multi={multi} danger={danger} />
      </div>
    </div>
  );
}

function Divider({ node, tid, path }) {
  const [drag, setDrag] = useState(false);
  const onMouseDown = (e) => {
    e.preventDefault();
    const parent = e.currentTarget.parentElement.getBoundingClientRect();
    let raf = 0;
    setDrag(true);
    const move = (ev) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = node.dir === 'row' ? (ev.clientX - parent.left) / parent.width : (ev.clientY - parent.top) / parent.height;
        A.setRatio(tid, path, L.snapRatio(r));
      });
    };
    const up = () => {
      setDrag(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const pct = Math.round(node.ratio * 100);
  return (
    <div className={`divider${drag ? ' active' : ''}`} onMouseDown={onMouseDown} onDoubleClick={() => A.setRatio(tid, path, 0.5)}>
      {drag && (
        <span className="ratio">
          {pct} : {100 - pct}
        </span>
      )}
    </div>
  );
}

function EdgeZones({ edge, tabId }) {
  const name = app.use((s) => {
    const t = s.tabs[tabId];
    return t?.name || null;
  });
  const sid = app.use((s) => s.tabs[tabId]?.activeSid);
  const r = rt.use((s) => s[sid]);
  const home = ui.use((s) => s.home);
  const label = name || sessionName(null, r, home);
  const verb = { left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down' }[edge];
  return (
    <div className="edge-zones">
      {['left', 'right', 'top', 'bottom'].map((z) => (
        <div key={z} className={`zone ${z}${edge === z ? ' hot' : ''}`} />
      ))}
      {edge && (
        <span className="label">
          {verb} · {label}
        </span>
      )}
    </div>
  );
}

// ---- Pane ----------------------------------------------------------------------------
function Pane({ sid, focused, multi, danger }) {
  const slot = useRef(null);
  const r = rt.use((s) => s[sid]) || {};
  const home = ui.use((s) => s.home);
  const meta = app.use((s) => s.sessions[sid]);
  const confirm = ui.use((s) => (s.confirm?.sid === sid ? s.confirm : null));
  const copied = ui.use((s) => s.copied?.sid === sid);
  const find = ui.use((s) => s.find && s.focusedSid === sid);

  useLayoutEffect(() => {
    const el = slot.current;
    reg.create(sid);
    reg.mount(sid, el);
    A.ensureStarted(sid);
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => reg.fit(sid));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      reg.unmount(sid, el);
    };
  }, [sid]);

  useEffect(() => {
    if (focused && document.activeElement?.tagName !== 'INPUT') reg.focus(sid);
  }, [focused, sid]);

  const { dir, leaf } = splitCwd(r.cwd || meta?.cwd, home);
  const procColor = { run: 'var(--accent)', fail: 'var(--fail)', ok: 'var(--ok)' }[r.status] || 'var(--t-dim)';

  return (
    <div className={`pane${multi && !focused ? ' dim-pane' : ''}${r.dropped ? ' faded' : ''}`} onMouseDown={() => !focused && A.focusSession(sid)}>
      <div
        className="pane-head"
        draggable={multi}
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_MIME, sid);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        {danger && <span className="prod-chip">PRODUCTION</span>}
        <span className="cwd">
          {r.dangerHost ? (
            <b>{r.dangerHost}</b>
          ) : (
            <>
              <span>{dir}</span>
              <b>{leaf}</b>
            </>
          )}
        </span>
        {r.branch && (
          <span className="pill">
            <span className="br">⎇</span>
            {r.branch}
          </span>
        )}
        <span className="pill" title={r.command || ''}>
          <span className={`dot6${r.status === 'run' ? ' st-run' : ''}`} style={{ background: procColor }} />
          {procLabel(r, r.shell)}
        </span>
        <span className="grow" />
        {r.cols && (
          <span className="size">
            {r.shell || 'zsh'} · {r.cols}×{r.rows}
          </span>
        )}
      </div>
      <div className="term-wrap">
        <div className="term-slot" ref={slot} />
      </div>
      {r.scrolledUp && (
        <button className="float-pill" onClick={() => reg.getHandle(sid)?.term.scrollToBottom()}>
          ↓ Jump to bottom{r.newLines ? <span>· {r.newLines} new lines</span> : null}
        </button>
      )}
      {copied && (
        <div className="copied">
          ✓ Copied output of last command <span>{formatAccel(app.get().settings.keybindings.copyLastOutput)}</span>
        </div>
      )}
      {find && <FindBar sid={sid} />}
      {confirm && <ConfirmSheet c={confirm} />}
      {r.dropped && <DroppedSheet sid={sid} d={r.dropped} />}
    </div>
  );
}

export function resolveConfirm(run) {
  const c = ui.get().confirm;
  ui.set((u) => ({ ...u, confirm: null }));
  if (run) c?.run();
  if (c) reg.focus(c.sid);
}

function ConfirmSheet({ c }) {
  return (
    <div className="sheet bottom">
      <span className="bang">!</span>
      <div className="msg">
        <b>{c.title}</b> {c.detail}
      </div>
      <button className="btn ghost" onClick={() => resolveConfirm(false)}>
        Cancel
      </button>
      <button className={`btn ${c.danger ? 'danger' : 'light'}`} onClick={() => resolveConfirm(true)}>
        {c.label || 'Run'} <kbd>⌘↵</kbd>
      </button>
    </div>
  );
}

function DroppedSheet({ sid, d }) {
  return (
    <div className="sheet center">
      <div className="row-inline" style={{ gap: 8 }}>
        <span className="dot6" style={{ background: 'var(--fail)', width: 8, height: 8 }} />
        <b className="grow">Disconnected from {d.host}</b>
        <span className="mono" style={{ opacity: 0.6, fontSize: 11 }}>
          {clockTime(d.at)}
        </span>
      </div>
      <div style={{ opacity: 0.75, lineHeight: 1.5 }}>Connection closed after {formatDuration(d.dur)}. Scrollback is kept.</div>
      <div className="row-inline" style={{ marginTop: 4 }}>
        <button className="btn light" onClick={() => A.reconnect(sid)}>
          Reconnect <kbd>⌘R</kbd>
        </button>
        <span className="grow" />
        <button className="btn ghost" onClick={() => rt.set((s) => ({ ...s, [sid]: { ...s[sid], dropped: null } }))}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function FindBar({ sid }) {
  const [q, setQ] = useState('');
  const h = reg.getHandle(sid);
  const opts = { decorations: { matchOverviewRuler: '#ecc576', activeMatchColorOverviewRuler: '#f0a862', matchBackground: '#ecc57655', activeMatchBackground: '#f0a862' } };
  const close = () => {
    h?.search.clearDecorations();
    ui.set((u) => ({ ...u, find: false }));
    reg.focus(sid);
  };
  return (
    <div className="find-bar">
      <input
        autoFocus
        value={q}
        placeholder="Find"
        onChange={(e) => {
          setQ(e.target.value);
          h?.search.findNext(e.target.value, { ...opts, incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.shiftKey ? h?.search.findPrevious(q, opts) : h?.search.findNext(q, opts));
          if (e.key === 'Escape') close();
        }}
      />
      <button onClick={() => h?.search.findPrevious(q, opts)}>↑</button>
      <button onClick={() => h?.search.findNext(q, opts)}>↓</button>
      <button onClick={close}>✕</button>
    </div>
  );
}

// ---- Empty Space ---------------------------------------------------------------------
function EmptySpace() {
  const space = app.use((s) => A.activeSpace(s));
  const recent = app.use((s) => s.recentDirs.slice(0, 4), arrayEq);
  const key = app.use((s) => s.settings.keybindings.newTerminal);
  const home = ui.use((s) => s.home);
  const open = async () => {
    const dir = await api.sys.chooseDir(home);
    if (dir) A.openTerminal({ cwd: dir });
  };
  return (
    <div className="empty">
      <div className="tile">{space.glyph}</div>
      <h2>{space.name} is ready</h2>
      <p>Open a terminal to get going. Anything you pin here stays with this Space; everything else tidies itself away.</p>
      <div className="actions">
        <button className="btn primary" onClick={() => A.openTerminal()}>
          New Terminal <kbd>{formatAccel(key)}</kbd>
        </button>
        <button className="btn" onClick={open}>
          Open directory…
        </button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          Recent:
          {recent.map((d) => (
            <button key={d.path} className="tag" onClick={() => A.openTerminal({ cwd: d.path })}>
              {d.path.replace(home, '~')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
