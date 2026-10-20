import { useEffect, useState } from 'react';
import { rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import * as reg from '../term/registry.js';
import { formatDuration, procLabel } from '../lib/meta.js';

const HEIGHT = 320;

// Read-only live preview of a sidebar row's last lines. Polls the buffer at 4Hz while open.
export default function Peek() {
  const peek = ui.use((s) => s.peek);
  const r = rt.use((s) => (peek ? s[peek.sid] : null));
  const [lines, setLines] = useState([]);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!peek) return;
    const read = () => {
      setLines(reg.peekLines(peek.sid, 14));
      tick((n) => n + 1);
    };
    read();
    const t = setInterval(read, 250);
    return () => clearInterval(t);
  }, [peek?.sid]);

  if (!peek) return null;
  const top = Math.max(8, Math.min(peek.top - 18, window.innerHeight - HEIGHT - 8));
  const status = r?.status;
  const color = { run: '#88adff', fail: '#ff8080', ok: '#80d49b' }[status] || '#7f8392';
  const state = status === 'run' ? `running ${formatDuration(Date.now() - (r.cmdStart || Date.now())).replace(/\.\d+s/, 's')}` : status === 'fail' ? `exit ${r.exitCode}` : status === 'ok' ? 'done' : 'idle';

  return (
    <div
      className={`peek${peek.pinned ? ' pinned' : ''}`}
      style={{ top, left: peek.left, '--arrow': `${peek.top - top + 9}px` }}
      onClick={() => {
        ui.set((u) => ({ ...u, peek: null }));
        A.activateTab(peek.tid);
      }}
    >
      <div className="ph">
        <span className="dot6" style={{ background: color }} />
        <b className="ellipsis">{r?.command || procLabel(r, r?.shell)}</b>
        <span style={{ color: '#7f8392', whiteSpace: 'nowrap' }}>{state}</span>
        <span className="live">{status === 'run' ? 'live' : ''}</span>
      </div>
      <div className="pb">
        {lines.length === 0 && <div style={{ color: '#7f8392' }}>No output yet</div>}
        {lines.map((spans, i) => (
          <div key={i}>
            {spans.length === 0
              ? ' '
              : spans.map((s, j) => (
                  <span key={j} style={{ color: s.fg || undefined, fontWeight: s.bold ? 700 : undefined, opacity: s.dim ? 0.6 : undefined }}>
                    {s.text}
                  </span>
                ))}
          </div>
        ))}
      </div>
      <div className="pf">
        <span>click to open</span>
        <span>⇧-click keeps peek open</span>
      </div>
    </div>
  );
}
