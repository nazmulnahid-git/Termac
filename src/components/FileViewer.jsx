// The file viewer and editor shown over the terminal card. Text files open in the editor
// (Editor.jsx): edit, ⌘S to save, and an edited file asks before it's closed. If the file
// changes on disk, an untouched copy reloads by itself; an edited one says so and lets you
// choose. Images are shown as they are; binaries and files over 2 MB are read-only.
import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { app, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { useProject, relPath, baseName } from './project.js';
import { FileIcon } from './fileicons.jsx';
import { IconClose, IconCopy, IconInsert, IconExternal, IconReview, IconUndo } from './icons.jsx';

// CodeMirror is sizeable; load it the first time a file is opened, not at startup.
const Editor = lazy(() => import('./Editor.jsx'));

const api = window.termac;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

export default function FileViewer() {
  const v = ui.use((s) => s.viewer);
  const dirty = ui.use((s) => s.viewerDirty);
  const fontSize = app.use((s) => s.settings.fontSize);
  const project = useProject();
  const [file, setFile] = useState(null); // { text, size, truncated, binary, error }
  const [image, setImage] = useState(null);
  const [conflict, setConflict] = useState(null); // text on disk that differs from ours
  const [cursor, setCursor] = useState(null);
  const [lang, setLang] = useState({ name: null, indent: null });
  const [saving, setSaving] = useState(false);
  const draft = useRef(null); // the editor's current text, kept without re-rendering
  const base = useRef(null); // the text last read from or written to disk

  const setDirty = (d) => ui.set((u) => (u.viewerDirty === d ? u : { ...u, viewerDirty: d }));

  useEffect(() => {
    if (!v) return;
    let on = true;
    setFile(null);
    setImage(null);
    setConflict(null);
    setCursor(null);
    draft.current = null;
    if (IMAGE.test(v.path)) api.sys.readImage(v.path).then((url) => on && (url ? setImage(url) : setFile({ error: 'Could not read image' })));
    else
      api.sys.readFile(v.path).then((f) => {
        if (!on) return;
        base.current = f?.text ?? null;
        setFile(f);
      });
    return () => {
      on = false;
    };
  }, [v?.path]);

  // Coming back to the window: has someone else changed the file?
  useEffect(() => {
    if (!v || !file || file.text == null) return;
    const check = () =>
      api.sys.readFile(v.path).then((f) => {
        if (f?.text == null || f.text === base.current) return;
        if (!ui.get().viewerDirty) {
          base.current = f.text;
          setFile(f);
        } else setConflict(f.text);
      });
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [v?.path, !!file]);

  if (!v) return null;
  const rel = project.root ? relPath(project.root, v.path) : v.path;
  const parts = rel.split('/');
  const editable = file && file.text != null && !file.binary && !file.truncated;

  const save = async (text = draft.current ?? base.current) => {
    if (!editable || text == null) return;
    setSaving(true);
    const r = await api.sys.writeFile(v.path, text);
    setSaving(false);
    if (!r?.ok) return A.toast({ title: `Couldn't save ${baseName(v.path)}`, detail: r?.error }, 8000);
    base.current = text;
    setConflict(null);
    setDirty(draft.current != null && draft.current !== text);
  };
  const revert = async () => {
    const ok = await api.sys.confirm({ message: `Revert ${baseName(v.path)}?`, detail: 'Your unsaved changes are thrown away and the file is read again from disk.', ok: 'Revert' });
    if (!ok) return;
    const f = await api.sys.readFile(v.path);
    base.current = f?.text ?? null;
    draft.current = null;
    setDirty(false);
    setConflict(null);
    setFile({ ...f, rev: (file?.rev || 0) + 1 });
  };
  const takeDisk = () => {
    base.current = conflict;
    draft.current = null;
    setDirty(false);
    setFile((f) => ({ ...f, text: conflict, rev: (f?.rev || 0) + 1 }));
    setConflict(null);
  };

  return (
    <div
      className="viewer"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Esc closes, unless the editor used it (closing its search bar, say).
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.stopPropagation();
          A.closeFile();
        }
      }}
    >
      <div className="vw-head">
        <FileIcon name={baseName(v.path)} />
        <span className="vw-path" title={v.path}>
          {parts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              <span className={i === parts.length - 1 ? 'leaf' : ''}>{p}</span>
            </Fragment>
          ))}
        </span>
        {dirty && <span className="vw-dirty" title="Unsaved changes" />}
        <span className="grow" />
        {dirty && (
          <>
            <button className="btn sm ghosty" onClick={revert}>
              <IconUndo size={13} />
              Revert
            </button>
            <button className="btn sm primary" disabled={saving} onClick={() => save()}>
              {saving ? 'Saving…' : 'Save'} <kbd>⌘S</kbd>
            </button>
          </>
        )}
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
      {conflict != null && (
        <div className="vw-banner">
          <b>{baseName(v.path)} changed on disk.</b>
          <span className="dim">You have unsaved edits too.</span>
          <span className="grow" />
          <button className="btn sm" onClick={takeDisk}>
            Load theirs
          </button>
          <button className="btn sm primary" onClick={() => save()}>
            Keep mine and save
          </button>
        </div>
      )}
      {!file && !image && <div className="vw-note">Loading…</div>}
      {file?.error && <div className="vw-note">{file.error}</div>}
      {file?.binary && <div className="vw-note">Binary file · {formatSize(file.size)}</div>}
      {image && (
        <div className="vw-image">
          <img src={image} alt={baseName(v.path)} />
        </div>
      )}
      {file && file.text != null && !file.binary && (
        <Suspense fallback={<div className="vw-note">Loading editor…</div>}>
          <Editor
            key={`${v.path}:${file.rev || 0}`}
            path={v.path}
            text={file.text}
            line={v.line}
            readOnly={!editable}
            fontSize={fontSize}
            onChange={(doc) => {
              const text = doc.toString();
              draft.current = text;
              setDirty(text !== base.current);
            }}
            onSave={save}
            onCursor={setCursor}
            onLanguage={(name, indent) => setLang({ name, indent })}
          />
          <div className="vw-status">
            {file.truncated && <span className="warn">Read-only: the file is larger than 2 MB and only its beginning is shown</span>}
            {cursor && (
              <span>
                Ln {cursor.line}, Col {cursor.col}
                {cursor.selections > 1 ? ` · ${cursor.selections} cursors` : ''}
              </span>
            )}
            <span className="grow" />
            {lang.indent && <span>{lang.indent.tabs ? 'Tabs' : `Spaces: ${lang.indent.size}`}</span>}
            <span>{lang.name || 'Plain text'}</span>
            <span>{formatSize(file.size)}</span>
            {editable && <span className={dirty ? 'unsaved' : 'saved'}>{dirty ? 'Edited' : 'Saved'}</span>}
          </div>
        </Suspense>
      )}
    </div>
  );
}

function formatSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
