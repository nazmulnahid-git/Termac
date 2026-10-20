// Code review panel (right side, Warp-style): every changed file in the focused session's
// repo with its diff inline. Stage, unstage and discard per file.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { parseDiff, diffStats } from '../lib/diff.js';
import { highlightLines, langOf } from '../lib/highlight.js';
import { useProject, baseName, dirName } from './project.js';
import { PanelResize } from './ToolsPanel.jsx';
import { IconClose, IconChevron, IconRefresh, IconPlus, IconMinus, IconUndo, IconFile, IconBranch } from './icons.jsx';

const api = window.termac;
const BIG = 1500; // lines; bigger diffs stay folded until asked

export default function ReviewPanel() {
  const open = ui.use((s) => s.review);
  const width = app.use((s) => s.settings.reviewWidth);
  const [dragW, setDragW] = useState(null);
  const project = useProject();
  const branch = rt.use((s) => s[project.sid]?.branch);
  const bump = rt.use((s) => s[project.sid]?.changes);
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open || !project.root) return;
    let on = true;
    const load = () => api.sys.gitChanges(project.root).then((c) => on && setData(c || { root: project.root, files: [], notRepo: true }));
    load();
    window.addEventListener('focus', load);
    return () => {
      on = false;
      window.removeEventListener('focus', load);
    };
  }, [open, project.root, bump, tick]);

  if (!open) return null;
  const refresh = () => setTick((t) => t + 1);
  const files = data?.root === project.root ? data.files : null;
  const staged = (files || []).filter((f) => f.x !== ' ' && f.x !== '?');
  const unstaged = (files || []).filter((f) => f.y !== ' ' || f.untracked);
  const total = (files || []).reduce(
    (t, f) => {
      for (const part of [f.staged, f.unstaged]) {
        t.add += part?.add || 0;
        t.del += part?.del || 0;
      }
      return t;
    },
    { add: 0, del: 0 }
  );

  return (
    <aside className="review" style={{ width: dragW ?? width }}>
      <PanelResize side="left" width={width} min={340} max={1100} setting="reviewWidth" onDrag={setDragW} />
      <div className="rv-head">
        <b>Code review</b>
        {branch && (
          <span className="rv-branch">
            <IconBranch size={13} />
            {branch}
          </span>
        )}
        {files && files.length > 0 && (
          <span className="rv-total">
            <span className="add">+{total.add}</span> <span className="del">−{total.del}</span>
          </span>
        )}
        <span className="grow" />
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <IconRefresh size={14} />
        </button>
        <button className="icon-btn" title="Close" onClick={A.toggleReview}>
          <IconClose />
        </button>
      </div>
      <div className="rv-scroll">
        {!files && <div className="tools-empty">Loading changes…</div>}
        {data?.notRepo && <div className="tools-empty">Not a git repository.</div>}
        {files && !files.length && !data?.notRepo && <div className="tools-empty">No changes. The working tree is clean.</div>}
        {staged.length > 0 && <Group title="Staged" files={staged} staged root={data.root} onChange={refresh} />}
        {unstaged.length > 0 && <Group title={staged.length ? 'Changes' : `${unstaged.length} changed file${unstaged.length === 1 ? '' : 's'}`} files={unstaged} root={data.root} onChange={refresh} />}
      </div>
    </aside>
  );
}

function Group({ title, files, staged = false, root, onChange }) {
  const autoOpen = files.length <= 12;
  return (
    <section className="rv-group">
      <div className="rv-gtitle">
        {title}
        <span className="n">{files.length}</span>
      </div>
      {files.map((f) => (
        <FileDiff key={`${staged}:${f.path}`} f={f} staged={staged} root={root} startOpen={autoOpen} onChange={onChange} />
      ))}
    </section>
  );
}

function FileDiff({ f, staged, root, startOpen, onChange }) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState(null);
  const [force, setForce] = useState(false);
  const known = staged ? f.staged : f.unstaged;
  const code = staged ? f.x : f.untracked ? 'A' : f.y;
  const abs = `${root}/${f.path}`;
  // Re-read the diff whenever git reports different counts for this file.
  const sig = `${known?.add}|${known?.del}|${code}`;

  useEffect(() => {
    if (!open) return;
    let on = true;
    api.sys.gitDiff(root, f.path, { staged, untracked: f.untracked }).then((t) => on && setText(t ?? ''));
    return () => {
      on = false;
    };
  }, [open, root, f.path, staged, sig]);

  const parsed = useMemo(() => (text == null ? null : parseDiff(text)), [text]);
  const lineCount = parsed ? parsed.hunks.reduce((n, h) => n + h.lines.length, 0) : 0;
  // git's numstat skips untracked files; count them from the diff once it's loaded.
  const counts = known || (parsed && !parsed.binary ? diffStats(parsed) : null);

  const stage = async (e) => {
    e.stopPropagation();
    await api.sys.gitStage(root, f.path, !staged);
    onChange();
  };
  const discard = async (e) => {
    e.stopPropagation();
    const ok = await api.sys.confirm({ message: `Discard changes to ${baseName(f.path)}?`, detail: f.untracked ? 'This deletes the untracked file. It cannot be undone.' : 'Your edits to this file will be lost. This cannot be undone.', ok: 'Discard' });
    if (!ok) return;
    await api.sys.gitDiscard(root, f.path, f.untracked);
    onChange();
  };

  return (
    <div className={`rv-file${open ? ' open' : ''}`}>
      <div className="rv-fhead" onClick={() => setOpen((o) => !o)}>
        <span className={`chev${open ? ' open' : ''}`}>
          <IconChevron size={11} />
        </span>
        <span className={`rv-code c-${code === '?' ? 'U' : code}`}>{code === '?' ? 'U' : code}</span>
        <span className="rv-name">
          {baseName(f.path)}
          <span className="rv-dir">{dirName(f.path)}</span>
        </span>
        {counts && (
          <span className="rv-counts">
            {counts.add != null ? <span className="add">+{counts.add}</span> : <span className="dim">bin</span>} {counts.del ? <span className="del">−{counts.del}</span> : null}
          </span>
        )}
        <span className="rv-actions">
          <button
            className="icon-btn sm"
            title="Open file"
            onClick={(e) => {
              e.stopPropagation();
              A.openFile(abs);
            }}
          >
            <IconFile size={13} />
          </button>
          {!staged && (
            <button className="icon-btn sm" title="Discard changes" onClick={discard}>
              <IconUndo size={13} />
            </button>
          )}
          <button className="icon-btn sm" title={staged ? 'Unstage' : 'Stage'} onClick={stage}>
            {staged ? <IconMinus size={13} /> : <IconPlus size={13} />}
          </button>
        </span>
      </div>
      {open && (
        <div className="rv-body">
          {!parsed && <div className="rv-note">Loading diff…</div>}
          {parsed?.binary && <div className="rv-note">Binary file</div>}
          {parsed && !parsed.binary && !parsed.hunks.length && <div className="rv-note">No textual changes (mode or rename only).</div>}
          {parsed && lineCount > BIG && !force ? (
            <div className="rv-note">
              Large diff ({lineCount.toLocaleString()} lines).{' '}
              <button className="link" onClick={() => setForce(true)}>
                Show anyway
              </button>
            </div>
          ) : (
            parsed?.hunks.map((h, i) => <Hunk key={i} h={h} lang={langOf(f.path)} onOpen={(line) => A.openFile(abs, line)} />)
          )}
        </div>
      )}
    </div>
  );
}

function Hunk({ h, lang, onOpen }) {
  const tokens = useMemo(() => highlightLines(h.lines.map((l) => l.text), lang), [h, lang]);
  return (
    <div className="rv-hunk">
      <div className="rv-hhead">{h.header.replace(/@@(.*)@@.*/, '@@$1@@')}{h.context && <span className="ctx">{h.context}</span>}</div>
      <table className="rv-lines">
        <tbody>
          {h.lines.map((l, i) => (
            <tr key={i} className={`ln ${l.type}`} onDoubleClick={() => l.newNo && onOpen(l.newNo)}>
              <td className="no">{l.oldNo ?? ''}</td>
              <td className="no">{l.newNo ?? ''}</td>
              <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
              <td className="code">
                {l.type === 'meta' ? (
                  <i>{l.text}</i>
                ) : (
                  tokens[i].map(([cls, t], k) => (
                    <Fragment key={k}>{cls ? <span className={`hl-${cls}`}>{t}</span> : t}</Fragment>
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
