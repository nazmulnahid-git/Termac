// Read-only file viewer shown over the terminal card: line numbers, light syntax colors,
// and only the visible rows rendered so large files stay quick. Esc closes.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { highlightLines, langOf } from '../lib/highlight.js';
import { useProject, relPath, baseName } from './project.js';
import { FileGlyph } from './ToolsPanel.jsx';
import { IconClose, IconCopy, IconInsert, IconExternal, IconReview } from './icons.jsx';

const api = window.termac;
const ROW = 22.5; // 15px text at 1.5 line height (.vw-scroll)
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

export default function FileViewer() {
  const v = ui.use((s) => s.viewer);
  const project = useProject();
  const [file, setFile] = useState(null);
  const [image, setImage] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!v) return;
    let on = true;
    setFile(null);
    setImage(null);
    if (IMAGE.test(v.path)) api.sys.readImage(v.path).then((url) => on && (url ? setImage(url) : setFile({ error: 'Could not read image' })));
    else api.sys.readFile(v.path).then((f) => on && setFile(f));
    return () => {
      on = false;
    };
  }, [v?.path]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [v?.path, !!file || !!image]);

  const lines = useMemo(() => {
    if (file?.text == null) return null;
    const l = file.text.split('\n');
    if (l.length > 1 && l[l.length - 1] === '') l.pop();
    return l;
  }, [file]);

  if (!v) return null;
  const rel = project.root ? relPath(project.root, v.path) : v.path;
  const parts = rel.split('/');

  return (
    <div
      className="viewer"
      tabIndex={-1}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          A.closeFile();
        }
      }}
    >
      <div className="vw-head">
        <FileGlyph name={baseName(v.path)} />
        <span className="vw-path" title={v.path}>
          {parts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              <span className={i === parts.length - 1 ? 'leaf' : ''}>{p}</span>
            </Fragment>
          ))}
        </span>
        {lines && <span className="vw-meta">{lines.length.toLocaleString()} lines · {formatSize(file.size)}</span>}
        <span className="grow" />
        <button className="icon-btn" title="Insert path at the prompt" onClick={() => A.insertText(project.sid, A.shellQuote(rel) + ' ')}>
          <IconInsert size={14} />
        </button>
        <button className="icon-btn" title="Copy path" onClick={() => navigator.clipboard.writeText(v.path)}>
          <IconCopy size={14} />
        </button>
        <button className="icon-btn" title="Show changes" onClick={() => ui.set((u) => ({ ...u, review: true }))}>
          <IconReview size={14} />
        </button>
        <button className="icon-btn" title="Open with default app" onClick={() => api.sys.reveal(v.path)}>
          <IconExternal size={14} />
        </button>
        <button className="icon-btn" title="Close  esc" onClick={A.closeFile}>
          <IconClose />
        </button>
      </div>
      {!file && !image && <div className="vw-note">Loading…</div>}
      {file?.error && <div className="vw-note">{file.error}</div>}
      {file?.binary && <div className="vw-note">Binary file · {formatSize(file.size)}</div>}
      {image && (
        <div className="vw-image">
          <img src={image} alt={baseName(v.path)} />
        </div>
      )}
      {lines && <Code lines={lines} lang={langOf(v.path)} line={v.line} truncated={file.truncated} />}
    </div>
  );
}

function Code({ lines, lang, line, truncated }) {
  const scroller = useRef(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(800);
  // Highlighting is cheap but not free; do it once per file, not per scroll.
  const tokens = useMemo(() => highlightLines(lines, lang), [lines, lang]);
  const gutter = String(lines.length).length;

  useLayoutEffect(() => {
    const el = scroller.current;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    if (line) el.scrollTop = Math.max(0, (line - 6) * ROW);
    return () => ro.disconnect();
  }, [lines, line]);

  const first = Math.max(0, Math.floor(top / ROW) - 20);
  const last = Math.min(lines.length, Math.ceil((top + height) / ROW) + 20);
  const rows = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div key={i} className={`vw-ln${line === i + 1 ? ' hit' : ''}`} style={{ top: i * ROW }}>
        <span className="no" style={{ width: `${gutter + 2}ch` }}>
          {i + 1}
        </span>
        <span className="code">{tokens[i].map(([cls, t], k) => (cls ? <span key={k} className={`hl-${cls}`}>{t}</span> : <Fragment key={k}>{t}</Fragment>))}</span>
      </div>
    );
  }
  return (
    <div className="vw-scroll" ref={scroller} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div className="vw-lines" style={{ height: lines.length * ROW + (truncated ? 40 : 12) }}>
        {rows}
        {truncated && (
          <div className="vw-trunc" style={{ top: lines.length * ROW + 8 }}>
            File is larger than 2 MB; showing the beginning.
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
