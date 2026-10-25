import '../styles/spaces-notes.css';
import { useEffect, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import * as L from '../lib/layout.js';
import { useTabView, StatusMark, SpaceGlyph } from './common.jsx';

const OV_MIME = 'application/x-termac-ov-tab';

// "All Spaces": one card per Space. App renders a dark backdrop; this layer sits above it.
export default function Overview({ onClose }) {
  const spaces = app.use((s) => s.spaces);
  const activeId = app.use((s) => s.activeSpaceId);
  const [hl, setHl] = useState(() => Math.max(0, spaces.findIndex((x) => x.id === activeId)));
  const [drop, setDrop] = useState(null);
  const [dragTid, setDragTid] = useState(null);
  const state = useRef({});
  state.current = { hl, spaces };

  useEffect(() => {
    const onKey = (e) => {
      const { hl: i, spaces: list } = state.current;
      const n = list.length + 1; // last slot is "New Space"
      let handled = true;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setHl((i + 1) % n);
      else if (e.key === 'ArrowLeft') setHl((i - 1 + n) % n);
      else if (e.key === 'Enter') {
        if (i < list.length) pick(list[i].id);
        else newSpace();
      } else if (e.ctrlKey && /^[1-9]$/.test(e.key) && list[Number(e.key) - 1]) pick(list[Number(e.key) - 1].id);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Capture phase so the focused terminal never sees these keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const pick = (id) => {
    A.switchSpace(id);
    onClose();
  };
  const newSpace = () => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }));

  const dropOn = (e, spaceId) => {
    e.preventDefault();
    setDrop(null);
    const tid = e.dataTransfer.getData(OV_MIME);
    const loc = tid && A.locate(tid);
    if (!loc || loc.spaceId === spaceId) return;
    A.moveTab(tid, { section: loc.section === 'pinned' ? 'pinned' : 'today', spaceId });
  };

  return (
    <div className="ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ov-title">All Spaces</div>
      <div className="ov-cards" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {spaces.map((sp, i) => (
          <SpaceCard
            key={sp.id}
            space={sp}
            current={sp.id === activeId}
            highlighted={hl === i}
            dropping={drop === sp.id}
            dragTid={dragTid}
            onPick={() => pick(sp.id)}
            onHover={() => setHl(i)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(OV_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (drop !== sp.id) setDrop(sp.id);
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDrop((d) => (d === sp.id ? null : d))}
            onDrop={(e) => dropOn(e, sp.id)}
            onRowDrag={setDragTid}
            onActivate={(tid) => {
              A.activateTab(tid);
              onClose();
            }}
          />
        ))}
        <button className={`ov-new${hl === spaces.length ? ' hl' : ''}`} onClick={newSpace} onMouseEnter={() => setHl(spaces.length)}>
          <span className="plus">+</span>
          New Space
          <kbd>⌃N</kbd>
        </button>
      </div>
      <div className="ov-foot">Drag sessions between cards to move them · Pinch in or esc to return · ⌃1–9 jumps</div>
    </div>
  );
}

function SpaceCard({ space, current, highlighted, dropping, dragTid, onPick, onHover, onDragOver, onDragLeave, onDrop, onRowDrag, onActivate }) {
  const sids = app.use((s) => [...space.pinned, ...space.folders.flatMap((f) => f.tabs), ...space.today].flatMap((tid) => L.leaves(s.tabs[tid]?.layout)), arrayEq);
  const running = rt.use((r) => sids.reduce((n, sid) => n + (r[sid]?.status === 'run' ? 1 : 0), 0));
  const activeTid = current ? space.activeTabId : null;
  const rowProps = { activeTid, dragTid, onRowDrag, onActivate };
  const empty = !space.pinned.length && !space.folders.some((f) => f.tabs.length) && !space.today.length;
  const cls = `ov-card${current ? ' cur' : ''}${highlighted ? ' hl' : ''}${dropping ? ' drop' : ''}`;
  return (
    <div className={cls} style={{ '--c': space.color }} onClick={onPick} onMouseEnter={onHover} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="ov-head">
        <div className="top">
          <SpaceGlyph space={space} className="g" />
          <span className="grow ellipsis">{space.name}</span>
          {current && <span className="badge">Current</span>}
        </div>
        <div className="sub">
          {sids.length} session{sids.length === 1 ? '' : 's'}
          {running ? ` · ${running} running` : ''}
        </div>
      </div>
      <div className="ov-body">
        {empty && <div className="ov-none">No sessions yet</div>}
        {space.pinned.map((tid) => (
          <OvRow key={tid} tid={tid} {...rowProps} />
        ))}
        {space.folders.map((f) =>
          f.tabs.length ? (
            <div key={f.id}>
              <div className="ov-group ellipsis">{f.name}</div>
              {f.tabs.map((tid) => (
                <OvRow key={tid} tid={tid} {...rowProps} />
              ))}
            </div>
          ) : null,
        )}
        {space.today.length > 0 && <div className="ov-group">Today</div>}
        {space.today.map((tid) => (
          <OvRow key={tid} tid={tid} {...rowProps} />
        ))}
      </div>
    </div>
  );
}

function OvRow({ tid, activeTid, dragTid, onRowDrag, onActivate }) {
  const v = useTabView(tid);
  if (!v) return null;
  return (
    <div
      className={`ov-row${tid === activeTid ? ' on' : ''}${dragTid === tid ? ' ghost' : ''}`}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData(OV_MIME, tid);
        e.dataTransfer.effectAllowed = 'move';
        onRowDrag(tid);
      }}
      onDragEnd={() => onRowDrag(null)}
      onClick={(e) => {
        e.stopPropagation();
        onActivate(tid);
      }}
    >
      <span className="name">{v.name}</span>
      {v.danger && <span className="prod">PROD</span>}
      {v.status !== 'idle' && <StatusMark status={v.status} bell={v.bell} />}
    </div>
  );
}
