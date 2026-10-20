import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as L from '../lib/layout.js';
import { kindOf, sessionName, timeAgo, formatDuration } from '../lib/meta.js';

// Aggregated view of a sidebar row: names, chips and the most urgent status of its panes.
export function useTabView(tid) {
  const tab = app.use((s) => s.tabs[tid]);
  const sids = tab ? L.leaves(tab.layout) : [];
  const rts = rt.use((s) => sids.map((id) => s[id]), arrayEq);
  const home = ui.use((s) => s.home);
  const metas = app.use((s) => sids.map((id) => s.sessions[id]), arrayEq);
  if (!tab) return null;
  const panes = sids.map((sid, i) => {
    const r = rts[i] || {};
    return { sid, rt: r, kind: kindOf(r.status === 'run' ? r.command : r.command || metas[i]?.command), name: sessionName(null, r, home) };
  });
  const bell = panes.reduce((n, p) => n + (p.rt.bell || 0), 0);
  const pick = (st) => panes.find((p) => p.rt.status === st);
  const fail = pick('fail');
  const status = bell ? 'bell' : fail ? 'fail' : pick('run') ? 'run' : pick('ok') ? 'ok' : 'idle';
  const active = panes.find((p) => p.sid === tab.activeSid) || panes[0];
  const name = tab.name || (panes.length > 1 ? panes.map((p) => p.name).join(' · ') : active?.name || '~');
  const danger = !!tab.effects?.danger || panes.some((p) => p.rt.sshEffects?.danger);
  const dead = panes.length === 1 && active?.rt.alive === false;
  return { tab, panes, active, name, status, bell, fail, danger, dead };
}

export function StatusMark({ status, bell }) {
  if (status === 'bell') return <span className="status st-bell">{bell}</span>;
  if (status === 'fail') return <span className="status st-fail">!</span>;
  if (status === 'run') return <span className="status st-run" />;
  if (status === 'ok') return <span className="status st-ok">✓</span>;
  return <span className="status st-idle" />;
}

export function FailTip({ rt: r }) {
  if (!r) return null;
  return (
    <div className="tip">
      <b>exit {r.exitCode}</b>
      <span>
        failed {r.endedAt ? timeAgo(r.endedAt) : ''} · {formatDuration(r.duration)}
      </span>
    </div>
  );
}

export function Chip({ kind }) {
  return <span className="chip">{kind}</span>;
}

export function Switch({ on, onChange, disabled }) {
  return <button className={`switch${on ? ' on' : ''}`} disabled={disabled} style={disabled ? { opacity: 0.5 } : undefined} onClick={() => onChange(!on)} role="switch" aria-checked={!!on} />;
}

export function Seg({ value, options, onChange }) {
  return (
    <span className="seg">
      {options.map(([v, label]) => (
        <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}
