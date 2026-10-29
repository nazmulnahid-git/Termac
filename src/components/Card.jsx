import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import * as reg from '../term/registry.js';
import * as L from '../lib/layout.js';
import { procLabel, clockTime, formatDuration, sessionName } from '../lib/meta.js';
import { formatAccel } from '../lib/keys.js';
import { terminalLook } from '../lib/termtheme.js';
import { useImageUrl } from './common.jsx';
import PaneChips from './PaneChips.jsx';
import Composer from './Composer.jsx';

const PANE_MIME = 'application/x-termac-pane';

export default function Card() {
  const tab = app.use((s) => A.activeTab(s));
  const theme = ui.use((s) => s.termTheme);
  const sids = tab ? L.leaves(tab.layout) : [];
  const dragging = ui.use((s) => s.dragging);
  const space = app.use((s) => A.activeSpace(s));
  const look = useMemo(() => terminalLook(space, theme), [space.term, space.color, theme]);
  const image = useImageUrl(look.image);

  // Never empty for long: actions.js opens a terminal or quits when a Space runs out.
  if (!tab) return null;
  const danger = !!tab.effects?.danger;
  // The sidebar drag engine hit-tests the card and reports the nearest edge as its target.
  const canDrop = dragging?.kind === 'tab' && dragging.tabId !== tab.id && sids.length < L.MAX_PANES;
  const edge = dragging?.target?.kind === 'card' ? dragging.target.edge : null;

  return (
    <div className={`card t-${look.dark ? 'dark' : 'light'}${danger ? ' danger' : ''}`} style={{ ...look.vars, background: look.bg }}>
      {look.image && image && (
        <>
          <div className="card-bg" style={{ backgroundImage: `url(${image})`, filter: look.blur ? `blur(${look.blur}px)` : undefined, inset: look.blur ? -look.blur * 2 : 0 }} />
          <div className="card-dim" style={{ background: look.bg, opacity: look.dim }} />
        </>
      )}
      <Layout node={tab.layout} tid={tab.id} path={[]} activeSid={tab.activeSid} multi={sids.length > 1} danger={danger} look={look} />
      {canDrop && <EdgeZones edge={edge} tabId={dragging.tabId} />}
    </div>
  );
}

function Layout({ node, tid, path, activeSid, multi, danger, look }) {
  if (node.sid) return <Pane sid={node.sid} focused={node.sid === activeSid} multi={multi} danger={danger} look={look} />;
  return (
    <div className={`split split-${node.dir}`}>
      <div className="slot" style={{ flex: `${node.ratio} 1 0` }}>
        <Layout node={node.a} tid={tid} path={[...path, 'a']} activeSid={activeSid} multi={multi} danger={danger} look={look} />
      </div>
      <Divider node={node} tid={tid} path={path} />
      <div className="slot" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <Layout node={node.b} tid={tid} path={[...path, 'b']} activeSid={activeSid} multi={multi} danger={danger} look={look} />
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
function Pane({ sid, focused, multi, danger, look }) {
  const slot = useRef(null);
  const r = rt.use((s) => s[sid]) || {};
  const home = ui.use((s) => s.home);
  const meta = app.use((s) => s.sessions[sid]);
  const confirm = ui.use((s) => (s.confirm?.sid === sid ? s.confirm : null));
  const copied = ui.use((s) => s.copied?.sid === sid);
  const find = ui.use((s) => s.find && s.focusedSid === sid);
  const fontSize = app.use((s) => s.settings.fontSize);
  const lineHeight = app.use((s) => s.settings.lineHeight);
  const composer = r.ownPrompt && !r.alt;

  useLayoutEffect(() => {
    reg.create(sid);
    reg.setLook(sid, look);
  }, [sid, look.key]);

  useLayoutEffect(() => {
    const el = slot.current;
    reg.mount(sid, el);
    A.ensureStarted(sid);
    // Throttled refit: animations (sidebar collapse, divider drags) shouldn't spam the PTY with resizes.
    let timer = 0;
    let last = 0;
    const refit = () => {
      timer = 0;
      last = performance.now();
      reg.fit(sid);
    };
    const ro = new ResizeObserver(() => {
      if (timer) return;
      timer = setTimeout(refit, Math.max(0, 90 - (performance.now() - last)));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
      reg.unmount(sid, el);
    };
  }, [sid]);

  useEffect(() => {
    if (focused && document.activeElement?.tagName !== 'INPUT') reg.focus(sid);
  }, [focused, sid]);

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
        {/* With the input bar, the folder and branch chips live in it instead. */}
        {!composer && <PaneChips sid={sid} r={r} cwd={r.cwd || meta?.cwd || home} />}
        <span className="grow" />
        <span className="pill proc" title={r.command || ''}>
          <span className={`dot6${r.status === 'run' ? ' st-run' : ''}`} style={{ background: procColor }} />
          {procLabel(r, r.shell)}
        </span>
      </div>
      <div
        className="term-wrap"
        onMouseUp={() => {
          // Clicking the output at a prompt goes back to the input bar, unless text was selected.
          const h = reg.getHandle(sid);
          if (composer && r.atPrompt && !h?.term.hasSelection()) requestAnimationFrame(() => reg.focus(sid));
        }}
      >
        <div className="term-slot" ref={slot} />
      </div>
      {composer && (
        // Fixed height whatever the bar shows, so the terminal never resizes under a command;
        // extra input lines and popups grow upward over the output.
        <div className="composer-slot" style={{ height: Math.round(fontSize * lineHeight) + 86 }}>
          <Composer sid={sid} focused={focused} cwd={r.cwd || meta?.cwd || home} home={home} />
        </div>
      )}
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
