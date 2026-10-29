// The window's bottom bar, as in Finder or Xcode: the Spaces as tabs on the left (a dot
// marks one with unseen finished jobs), finished jobs and the Library, then the focused
// session's process, size and a clock in small secondary type.
import { useEffect, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import { procLabel, timeAgo, formatDuration } from '../lib/meta.js';
import { StatusMark, SpaceGlyph } from './common.jsx';
import { openLibrary } from './Sidebar.jsx';
import { IconActivity, IconLibrary, IconPlus } from './icons.jsx';

export default function StatusBar() {
  const view = ui.use((s) => s.view);
  const sid = ui.use((s) => s.focusedSid);
  const r = rt.use((s) => s[sid]);
  const unseen = app.use((s) => s.activity.filter((a) => !a.seen).length);
  const [jobs, setJobs] = useState(false);
  const clock = useClock();
  const run = r?.status === 'run';

  return (
    <footer className="statusbar">
      <SpaceTabs />
      <span className="grow" />
      <button className={`sl-btn${jobs ? ' on' : ''}${unseen ? ' hot' : ''}`} title="Finished jobs" onClick={() => setJobs((o) => !o)}>
        <IconActivity size={13} />
        Jobs{unseen > 0 && <b>{unseen}</b>}
      </button>
      <button className={`sl-btn${view === 'library' ? ' on' : ''}`} title="Library" onClick={openLibrary}>
        <IconLibrary size={13} />
        Library
      </button>
      {sid && r && (
        <>
          <span className={`sl-seg proc${run ? ' run' : ''}${r.status === 'fail' ? ' fail' : ''}`} title={r.command || ''}>
            {run && <span className="status st-run" />}
            {procLabel(r, r.shell)}
          </span>
          {r.cols && (
            <span className="sl-seg">
              {r.cols}×{r.rows}
            </span>
          )}
        </>
      )}
      <span className="sl-seg clock">{clock}</span>
      {jobs && <ActivityPopover onClose={() => setJobs(false)} />}
    </footer>
  );
}

function useClock() {
  const fmt = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setT(fmt()), 15 * 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

// Also the drop targets for moving a dragged session to another Space.
function SpaceTabs() {
  const spaces = app.use((s) => s.spaces);
  const activeId = app.use((s) => s.activeSpaceId);
  const unseen = app.use((s) => [...new Set(s.activity.filter((a) => !a.seen).map((a) => a.spaceId))], arrayEq);
  const dragTab = ui.use((s) => s.dragging?.kind === 'tab');
  const hot = ui.use((s) => (s.dragging?.target?.kind === 'space' ? s.dragging.target.spaceId : null));
  return (
    <div className="sl-spaces">
      {spaces.map((sp, i) => {
        const on = sp.id === activeId;
        const flag = !on && unseen.includes(sp.id);
        return (
          <button
            key={sp.id}
            className={`sl-space${on ? ' on' : ''}${hot === sp.id ? ' drop-into' : ''}`}
            data-drop-space={dragTab ? sp.id : undefined}
            style={{ '--c': sp.color }}
            title={`${sp.name}  ⌃${i + 1}`}
            onClick={() => A.switchSpace(sp.id)}
            onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: sp.id }))}
          >
            <SpaceGlyph space={sp} className="g" />
            {sp.name}
            {flag && <span className="flag" />}
          </button>
        );
      })}
      <button className="sl-btn add" title="New Space" onClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }))}>
        <IconPlus size={13} />
      </button>
    </div>
  );
}

function ActivityPopover({ onClose }) {
  const items = app.use((s) => s.activity);
  const spaces = app.use((s) => s.spaces);
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('.statusbar .sl-btn') && onClose();
    setTimeout(() => window.addEventListener('mousedown', off), 0);
    app.set((s) => (s.activity.some((a) => !a.seen) ? { ...s, activity: s.activity.map((a) => ({ ...a, seen: true })) } : s));
    return () => window.removeEventListener('mousedown', off);
  }, []);
  return (
    <div ref={ref} className="activity-pop">
      <div className="ap-title">Finished Jobs</div>
      <div className="ap-list">
        {!items.length && <div className="ap-empty">Commands that run longer than the notify threshold show up here.</div>}
        {items.map((a) => (
          <button
            key={a.id}
            className="ap-item"
            onClick={() => {
              A.jumpTo(a.sid);
              onClose();
            }}
          >
            <StatusMark status={a.exit ? 'fail' : 'ok'} />
            <span className="grow">
              <div className="ellipsis">{a.command}</div>
              <div className="dim">
                {spaces.find((x) => x.id === a.spaceId)?.name} · {formatDuration(a.dur)} · {timeAgo(a.at)}
              </div>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
