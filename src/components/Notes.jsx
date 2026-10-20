import '../styles/spaces-notes.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import { parseBlocks, parseInline, toggleTask } from '../lib/markdown.js';
import { sessionName, clockTime } from '../lib/meta.js';
import { formatAccel } from '../lib/keys.js';
import { promptText } from './Sidebar.jsx';

const api = window.termac;
const PROVENANCE_MS = 10 * 60 * 1000;
const PLACEHOLDER = '# Notes\n- [ ] …\n\n```\ncommand to keep handy\n```';
const ERRORISH = /\b(error|exception|failed|failure|fatal|traceback|panic|denied|cannot|refused)\b|ERR!|✗|✕/i;

// One markdown doc per Space, docked to the right of the terminal card.
export default function Notes({ spaceId, onClose }) {
  const space = app.use((s) => s.spaces.find((x) => x.id === spaceId));
  const stored = app.use((s) => s.notes[spaceId] || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const taRef = useRef(null);
  const caret = useRef(null);
  const timer = useRef(null);
  const pending = useRef(null); // { spaceId, text } not yet written

  const flush = () => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) A.setNotes(p.spaceId, p.text);
    setSaving(false);
  };

  // Write any pending edit to the Space it belongs to before switching or unmounting.
  useEffect(() => {
    setEditing(false);
    return flush;
  }, [spaceId]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!editing || !ta) return;
    ta.focus();
    const pos = caret.current ?? ta.value.length;
    ta.setSelectionRange(pos, pos);
    caret.current = null;
  }, [editing]);

  if (!space) return null;

  const startEdit = (line) => {
    if (editing) return;
    caret.current = line == null ? null : offsetOfLine(stored, line);
    setDraft(stored);
    setEditing(true);
  };
  const stopEdit = () => {
    flush();
    setEditing(false);
  };
  const change = (text) => {
    setDraft(text);
    pending.current = { spaceId, text };
    setSaving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const write = (text) => {
    A.setNotes(spaceId, text);
    setSaving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaving(false), 350);
  };

  return (
    <section className="nt">
      <div className="nt-head">
        <span className="glyph" style={{ color: space.color }}>{space.glyph}</span>
        <b className="grow ellipsis">{space.name} notes</b>
        <span className="state">{saving ? 'Saving…' : 'Saved'}</span>
        <button className="link" onMouseDown={(e) => editing && e.preventDefault()} onClick={() => (editing ? stopEdit() : startEdit())}>
          {editing ? 'Done' : 'Edit'}
        </button>
        <button className="x" title="Close notes" onClick={() => (flush(), onClose?.())}>
          ✕
        </button>
      </div>
      <div className="nt-body">
        {editing ? (
          <textarea
            ref={taRef}
            className="nt-edit"
            value={draft}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            onChange={(e) => change(e.target.value)}
            onBlur={stopEdit}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <Rendered text={stored} spaceId={spaceId} onEdit={startEdit} onWrite={write} />
        )}
        <Snippets spaceId={spaceId} />
      </div>
    </section>
  );
}

function offsetOfLine(text, line) {
  const lines = text.split('\n');
  let n = 0;
  for (let i = 0; i < Math.min(line, lines.length); i++) n += lines[i].length + 1;
  return Math.min(n, text.length);
}

// Pasting output that was just copied from a session keeps a link back to it.
function onPaste(e) {
  const clip = e.clipboardData.getData('text/plain');
  const c = A.getLastCopy();
  const norm = (t) => (t || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!clip || !c || Date.now() - c.at > PROVENANCE_MS || norm(c.text) !== norm(clip)) return;
  e.preventDefault();
  const ta = e.currentTarget;
  const before = ta.value.slice(0, ta.selectionStart);
  const name = sessionName(null, rt.get()[c.sid], ui.get().home) || 'session';
  const tag = c.sid ? ` {${c.sid}${c.mark != null ? `:${c.mark}` : ''}}` : '';
  const body = norm(clip)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  insertText(ta, `${before && !before.endsWith('\n') ? '\n' : ''}> pasted from ${name} · ${clockTime(c.at)}${tag}\n${body}\n`);
}

function insertText(ta, text) {
  ta.focus();
  // execCommand keeps the native undo stack; fall back if it is unavailable.
  if (document.execCommand?.('insertText', false, text)) return;
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---- Rendered view -------------------------------------------------------------------
function Rendered({ text, spaceId, onEdit, onWrite }) {
  // Consecutive tasks/bullets render as one tight list.
  const groups = useMemo(() => {
    const out = [];
    let firstH1 = true;
    for (const b of parseBlocks(text)) {
      const listy = b.type === 'task' || b.type === 'bullet';
      const last = out[out.length - 1];
      if (listy && last?.type === 'list') last.items.push(b);
      else if (listy) out.push({ type: 'list', line: b.line, items: [b] });
      else {
        if (b.type === 'heading' && b.level === 1) {
          b.first = firstH1;
          firstH1 = false;
        }
        out.push(b);
      }
    }
    return out;
  }, [text]);

  const onDocClick = (e) => {
    if (e.target === e.currentTarget) onEdit();
  };

  return (
    <div className="nt-doc" onClick={onDocClick}>
      {!groups.length && (
        <div className="nt-empty" onClick={() => onEdit()}>
          Click to start writing. Markdown works: <code># heading</code>, <code>- [ ] task</code>, and <code>```</code> code blocks you can run or save as snippets. Output copied from a session keeps a link back to it.
        </div>
      )}
      {groups.map((b) => {
        const edit = () => onEdit(b.line);
        if (b.type === 'list')
          return (
            <div key={b.line} className="nt-list">
              {b.items.map((it) =>
                it.type === 'task' ? (
                  <div key={it.line} className={`nt-task${it.done ? ' done' : ''}`} onDoubleClick={() => onEdit(it.line)}>
                    <button className={`nt-box${it.done ? ' on' : ''}`} role="checkbox" aria-checked={it.done} onClick={() => onWrite(toggleTask(text, it.line))}>
                      {it.done ? '✓' : ''}
                    </button>
                    <span className="txt">
                      <Inline text={it.text} />
                    </span>
                  </div>
                ) : (
                  <div key={it.line} className="nt-bullet" onDoubleClick={() => onEdit(it.line)}>
                    <span>
                      <Inline text={it.text} />
                    </span>
                  </div>
                ),
              )}
            </div>
          );
        if (b.type === 'heading')
          return (
            <div key={b.line} className={`nt-h${b.level === 1 && b.first ? ' h1' : b.level <= 2 ? ' h2' : ''}`} onDoubleClick={edit}>
              <Inline text={b.text} />
            </div>
          );
        if (b.type === 'code') return <CodeBlock key={b.line} code={b.text} spaceId={spaceId} onEdit={edit} />;
        if (b.type === 'paste') return <PasteBlock key={b.line} block={b} onEdit={edit} />;
        return (
          <div key={b.line} className="nt-p" onDoubleClick={edit}>
            <Inline text={b.text} />
          </div>
        );
      })}
    </div>
  );
}

function Inline({ text }) {
  return parseInline(text).map((s, i) => (s.t === 'code' ? <code key={i} className="nt-code-i">{s.v}</code> : s.t === 'bold' ? <b key={i}>{s.v}</b> : <span key={i}>{s.v}</span>));
}

function CodeBlock({ code, spaceId, onEdit }) {
  const save = async () => {
    const guess = code.trim().split(/\s+/).slice(0, 2).join('-').replace(/[^\w.-]+/g, '').toLowerCase();
    const name = await promptText('Snippet name', guess);
    if (name && name.trim()) A.addSnippet({ name, command: code, spaceId });
  };
  return (
    <div className="nt-cb" onDoubleClick={onEdit}>
      <pre>
        <span className="pr">❯ </span>
        {code}
      </pre>
      <div className="acts">
        <button disabled={!code.trim()} onClick={() => A.runInSession(code)}>
          ▶ Run in session
        </button>
        <button className="save" disabled={!code.trim()} onClick={save}>
          Save as snippet
        </button>
      </div>
    </div>
  );
}

function PasteBlock({ block, onEdit }) {
  const { source, sessionId: sid, mark } = block;
  const jump = () => {
    if (!A.tabOfSession(sid)) return A.toast({ title: 'That session is gone', detail: 'It was closed or moved to the Library.' });
    A.jumpTo(sid, mark);
  };
  return (
    <div className="nt-paste" onDoubleClick={onEdit}>
      <div className={`cap${sid ? ' jump' : ''}`} title={sid ? 'Jump to that session' : undefined} onClick={sid ? jump : undefined}>
        <span className="grow ellipsis">pasted from {source}</span>
        {sid && <span>↗</span>}
      </div>
      <pre className={ERRORISH.test(block.text) ? 'err' : ''}>{block.text}</pre>
    </div>
  );
}

// ---- Snippets --------------------------------------------------------------------------
function Snippets({ spaceId }) {
  const snippets = app.use((s) => s.snippets.filter((x) => x.spaceId === spaceId), arrayEq);
  const accel = app.use((s) => s.settings.keybindings.commandBar);
  const now = Date.now();
  const menu = async (e, sn) => {
    e.preventDefault();
    const id = await api.app.popupMenu([
      { id: 'run', label: 'Run in Session' },
      { id: 'copy', label: 'Copy Command' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete Snippet' },
    ]);
    if (id === 'run') A.runInSession(sn.command);
    else if (id === 'copy') navigator.clipboard.writeText(sn.command);
    else if (id === 'delete') A.removeSnippet(sn.id);
  };
  return (
    <div className="nt-snips">
      <div className="title">
        Snippets in this Space · show in {formatAccel(accel) || '⌘T'}
      </div>
      {!snippets.length && <div className="dim" style={{ fontSize: 11.5 }}>Save a code block as a snippet to reuse it here and in the command bar.</div>}
      {snippets.map((sn) => (
        <button key={sn.id} className="nt-snip" title={sn.command} onClick={() => A.runInSession(sn.command)} onContextMenu={(e) => menu(e, sn)}>
          <span className="n">/{sn.name}</span>
          <span className="c">{sn.command}</span>
          {now - (sn.createdAt || 0) < 86400000 && <span className="nt-new">NEW</span>}
        </button>
      ))}
    </div>
  );
}
