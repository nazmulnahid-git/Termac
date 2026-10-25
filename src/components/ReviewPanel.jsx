// Code review panel (right side, or maximized over the terminal area). Three tabs:
//  - Changes: every changed file with its diff, unified or side by side. Stage, unstage and
//    discard per file or per hunk, leave comments on lines, and commit from the box below.
//  - Commits: the branch's history, unpushed commits marked, each one's diff on demand.
//  - Pull request: the branch's PR with its checks, or a form to open one (GitHub CLI).
// The header keeps the branch, sync (fetch / pull / push) and PR state in view.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { parseDiff, diffStats, hunkPatch, splitRows, splitFiles } from '../lib/diff.js';
import { highlightLines, langOf } from '../lib/highlight.js';
import { reviewMarkdown } from '../lib/review.js';
import { timeAgo } from '../lib/meta.js';
import { useProject, baseName, dirName } from './project.js';
import { promptText } from './sidebar-shared.js';
import { PanelResize } from './ToolsPanel.jsx';
import {
  IconClose, IconChevron, IconRefresh, IconPlus, IconMinus, IconUndo, IconFile, IconBranch, IconMaximize, IconMinimize, IconUnified, IconSplit,
  IconComment, IconCommentAdd, IconCommit, IconPR, IconArrowUp, IconArrowDown, IconChevronDown, IconMore, IconSend, IconTrash, IconPencil,
  IconCollapseAll, IconExpandAll, IconCopy, IconExternal, IconSpinner, IconCheckCircle, IconXCircle, IconDot, IconMerge,
} from './icons.jsx';

const api = window.termac;
const BIG = 1500; // lines; bigger diffs stay folded until asked
const NO_COMMENTS = [];

// ---- Data -----------------------------------------------------------------------------------
function useReviewData(root, open, bump) {
  const [tick, setTick] = useState(0);
  const [changes, setChanges] = useState(null);
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!open || !root) return;
    let on = true;
    const load = () => {
      api.sys.gitChanges(root).then((c) => on && setChanges(c || { root, files: [], notRepo: true }));
      api.review.overview(root).then((o) => on && setInfo({ ...o, root }));
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      on = false;
      window.removeEventListener('focus', load);
    };
  }, [open, root, bump, tick]);
  return { changes: changes?.root === root ? changes : null, info: info?.root === root ? info : null, refresh: () => setTick((t) => t + 1), tick };
}

function usePr(root, branch, open, tick) {
  const [pr, setPr] = useState(null);
  useEffect(() => {
    if (!open || !root || !branch) return;
    let on = true;
    setPr((p) => (p?.branch === branch ? p : null));
    api.review.pr(root).then((r) => on && setPr({ ...r, branch }));
    return () => {
      on = false;
    };
  }, [open, root, branch, tick]);
  return pr?.branch === branch ? pr : null;
}

// Runs one git/gh action with a busy flag; reports failures (and chosen successes) as toasts.
function useRunner(root, refresh) {
  const [busy, setBusy] = useState(null);
  const run = async (key, op, { done, quiet } = {}) => {
    setBusy(key);
    try {
      const r = await api.review.run(root, op);
      if (!r.ok) {
        A.toast({ title: `${label(op.op)} failed`, detail: firstLines(r.error) }, 9000);
        return null;
      }
      if (done && !quiet) A.toast({ title: typeof done === 'function' ? done(r) : done });
      return r;
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return { busy, run };
}

const LABELS = { commit: 'Commit', push: 'Push', pull: 'Pull', fetch: 'Fetch', apply: 'Update', stageAll: 'Stage', discardAll: 'Discard', switch: 'Switch branch', undoCommit: 'Undo commit', prCreate: 'Create pull request', prComment: 'Comment', prReady: 'Mark ready', prMerge: 'Merge' };
const label = (op) => LABELS[op] || 'Git';
const firstLines = (s) => String(s || '').split('\n').filter(Boolean).slice(-4).join(' · ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- Panel -----------------------------------------------------------------------------------
export default function ReviewPanel() {
  const open = ui.use((s) => s.review);
  const max = ui.use((s) => s.reviewMax);
  const width = app.use((s) => s.settings.reviewWidth);
  const view = app.use((s) => s.settings.reviewView);
  const [dragW, setDragW] = useState(null);
  const [tab, setTab] = useState('changes');
  const [fold, setFold] = useState({ n: 0, open: true });
  const project = useProject();
  const bump = rt.use((s) => s[project.sid]?.changes);
  const { changes, info, refresh, tick } = useReviewData(project.root, open, bump);
  const pr = usePr(project.root, info?.branch, open, tick);
  const { busy, run } = useRunner(project.root, refresh);
  const comments = app.use((s) => s.reviewComments?.[project.root]) || NO_COMMENTS;
  const scroller = useRef(null);

  useEffect(() => {
    if (!max) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) A.toggleReviewMax();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [max]);

  if (!open) return null;
  const root = changes?.root || project.root;
  const files = changes?.files || null;
  const notRepo = changes?.notRepo || !project.git;
  const ctx = { root, run, busy, refresh, view, comments, fold, info, pr };

  return (
    <aside className={`review${max ? ' max' : ''}`} style={max ? null : { width: dragW ?? width }}>
      {!max && <PanelResize side="left" width={width} min={380} max={1400} setting="reviewWidth" onDrag={setDragW} />}
      <div className="rv-head">
        <div className="seg rv-tabs">
          <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
            Changes{files?.length ? <span className="n">{files.length}</span> : null}
          </button>
          <button className={tab === 'commits' ? 'on' : ''} onClick={() => setTab('commits')}>
            Commits{info?.ahead ? <span className="n">{info.ahead}</span> : null}
          </button>
          <button className={tab === 'pr' ? 'on' : ''} onClick={() => setTab('pr')}>
            Pull request{pr?.pr ? <PrDot pr={pr.pr} /> : null}
          </button>
        </div>
        <span className="grow" />
        {tab !== 'pr' && (
          <div className="seg rv-view" title="Diff layout">
            <button className={view !== 'split' ? 'on' : ''} title="Unified" onClick={() => A.setSettings({ reviewView: 'unified' })}>
              <IconUnified size={14} />
            </button>
            <button className={view === 'split' ? 'on' : ''} title="Side by side" onClick={() => A.setSettings({ reviewView: 'split' })}>
              <IconSplit size={14} />
            </button>
          </div>
        )}
        {tab === 'changes' && (
          <button className="icon-btn" title={fold.open ? 'Collapse all' : 'Expand all'} onClick={() => setFold((f) => ({ n: f.n + 1, open: !f.open }))}>
            {fold.open ? <IconCollapseAll size={14} /> : <IconExpandAll size={14} />}
          </button>
        )}
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <IconRefresh size={14} />
        </button>
        <button className="icon-btn" title={max ? 'Restore (Esc)' : 'Maximize'} onClick={A.toggleReviewMax}>
          {max ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
        </button>
        <button className="icon-btn" title="Close" onClick={A.toggleReview}>
          <IconClose />
        </button>
      </div>
      {!notRepo && info && <BranchBar ctx={ctx} onPr={() => setTab('pr')} />}
      <div className="rv-main">
        {max && tab === 'changes' && files?.length > 0 && <FileNav files={files} comments={comments} scroller={scroller} />}
        <div className="rv-col">
          {notRepo ? (
            <div className="rv-empty">
              <IconBranch size={22} />
              <b>Not a git repository</b>
              <span>Code review follows the focused session's folder. Open a session inside a repository.</span>
            </div>
          ) : tab === 'changes' ? (
            <Changes ctx={ctx} files={files} scroller={scroller} />
          ) : tab === 'commits' ? (
            <Commits ctx={ctx} />
          ) : (
            <PullRequest ctx={ctx} />
          )}
        </div>
      </div>
    </aside>
  );
}

function PrDot({ pr }) {
  const c = pr.checks || {};
  const cls = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : c.failed ? 'fail' : c.pending ? 'pending' : 'ok';
  return <span className={`rv-prdot ${cls}`} />;
}

// ---- Branch & sync bar ---------------------------------------------------------------------------
function BranchBar({ ctx, onPr }) {
  const { root, info, run, busy, pr } = ctx;
  const switchMenu = async () => {
    const branches = await api.sys.gitBranches(root);
    const items = [
      ...branches.slice(0, 25).map((b) => ({ id: `b:${b}`, label: b, checked: b === info.branch })),
      { type: 'separator' },
      { id: 'new', label: 'New branch…' },
      { id: 'copy', label: 'Copy branch name', enabled: !info.detached },
    ];
    const id = await api.app.popupMenu(items);
    if (!id) return;
    if (id === 'copy') return navigator.clipboard.writeText(info.branch);
    if (id === 'new') {
      const name = (await promptText('New branch from here', ''))?.trim();
      if (name) run('switch', { op: 'switch', branch: name, create: true }, { done: `Switched to new branch ${name}` });
      return;
    }
    const branch = id.slice(2);
    if (branch !== info.branch) run('switch', { op: 'switch', branch }, { done: `Switched to ${branch}` });
  };
  const more = async () => {
    const id = await api.app.popupMenu([
      { id: 'fetch', label: 'Fetch' },
      { id: 'pull', label: 'Pull' },
      { id: 'push', label: 'Push' },
      { id: 'force', label: 'Force push (with lease)', enabled: !!info.upstream },
      { type: 'separator' },
      { id: 'undo', label: 'Undo last commit', enabled: !!info.head },
      { type: 'separator' },
      { id: 'web', label: 'Open repository on the web', enabled: !!info.webUrl },
    ]);
    if (id === 'fetch') run('fetch', { op: 'fetch' }, { done: 'Fetched' });
    else if (id === 'pull') run('pull', { op: 'pull' }, { done: 'Pulled' });
    else if (id === 'push') push(false);
    else if (id === 'force') {
      const ok = await api.sys.confirm({ message: `Force push ${info.branch}?`, detail: 'Overwrites the remote branch with yours. With lease: refused if someone else pushed since your last fetch.', ok: 'Force push' });
      if (ok) push(true);
    } else if (id === 'undo') undoCommit(ctx);
    else if (id === 'web') api.sys.openExternal(info.webUrl);
  };
  const push = (force) => run('push', { op: 'push', force }, { done: `Pushed ${info.branch}${info.upstream ? '' : ` to ${info.remote}`}` });
  const syncing = busy === 'push' || busy === 'pull' || busy === 'fetch';

  return (
    <div className="rv-bar">
      <button className="rv-branch" title="Switch branch" onClick={switchMenu} disabled={!!busy}>
        <IconBranch size={13} />
        <span className="ellipsis">{info.detached ? `detached at ${info.head?.short}` : info.branch}</span>
        <IconChevronDown size={12} />
      </button>
      {info.upstream ? <span className="rv-up ellipsis" title="Upstream">{info.upstream}</span> : info.remote ? <span className="rv-up">not published</span> : <span className="rv-up">no remote</span>}
      <span className="grow" />
      {info.behind > 0 && (
        <button className="rv-sync" title={`Pull ${plural(info.behind, 'commit')}`} disabled={!!busy} onClick={() => run('pull', { op: 'pull' }, { done: 'Pulled' })}>
          {busy === 'pull' ? <IconSpinner size={13} /> : <IconArrowDown size={13} />}
          {info.behind}
        </button>
      )}
      {info.remote && (
        <button
          className={`rv-sync${info.ahead || !info.upstream ? ' hot' : ''}`}
          title={info.upstream ? (info.ahead ? `Push ${plural(info.ahead, 'commit')}` : 'Up to date') : 'Publish branch'}
          disabled={!!busy || (info.upstream && !info.ahead)}
          onClick={() => push(false)}
        >
          {busy === 'push' ? <IconSpinner size={13} /> : <IconArrowUp size={13} />}
          {info.upstream ? info.ahead : 'Publish'}
        </button>
      )}
      <button className="icon-btn sm" title="Fetch" disabled={!!busy || !info.remote} onClick={() => run('fetch', { op: 'fetch' }, { done: 'Fetched' })}>
        {busy === 'fetch' ? <IconSpinner size={13} /> : <IconRefresh size={13} />}
      </button>
      {pr?.pr ? (
        <button className="rv-prpill" onClick={onPr} title={pr.pr.title}>
          <IconPR size={13} />#{pr.pr.number}
          <PrDot pr={pr.pr} />
        </button>
      ) : pr?.gh && info.remote && !info.detached && info.branch !== info.defaultBranch ? (
        <button className="rv-prpill ghost" onClick={onPr}>
          <IconPR size={13} />
          Create PR
        </button>
      ) : null}
      <button className="icon-btn sm" title="More" onClick={more} disabled={syncing}>
        <IconMore size={14} />
      </button>
    </div>
  );
}

async function undoCommit({ root, run, info }) {
  const ok = await api.sys.confirm({ message: `Undo "${info.head?.subject}"?`, detail: 'The commit is removed and its changes go back to staged. Avoid this for commits you already pushed.', ok: 'Undo commit' });
  if (ok) run('undo', { op: 'undoCommit' }, { done: 'Commit undone; its changes are staged' });
}

// ---- Changes -------------------------------------------------------------------------------------
function Changes({ ctx, files, scroller }) {
  const { root, run, comments } = ctx;
  if (!files) return <div className="rv-empty">Loading changes…</div>;
  const staged = files.filter((f) => f.x !== ' ' && f.x !== '?');
  const unstaged = files.filter((f) => f.y !== ' ' || f.untracked);
  const total = files.reduce(
    (t, f) => {
      for (const part of [f.staged, f.unstaged]) {
        t.add += part?.add || 0;
        t.del += part?.del || 0;
      }
      return t;
    },
    { add: 0, del: 0 }
  );
  const discardAll = async () => {
    const untracked = unstaged.filter((f) => f.untracked).map((f) => f.path);
    const ok = await api.sys.confirm({
      message: `Discard ${plural(unstaged.length, 'change')}?`,
      detail: `Unstaged edits are lost${untracked.length ? ` and ${plural(untracked.length, 'untracked file')} deleted` : ''}. Staged changes are kept. This cannot be undone.`,
      ok: 'Discard all',
    });
    if (ok) run('discardAll', { op: 'discardAll', untracked });
  };

  return (
    <>
      <div className="rv-scroll" ref={scroller}>
        {comments.length > 0 && <CommentsSummary ctx={ctx} />}
        {!files.length && (
          <div className="rv-empty">
            <IconCheckCircle size={22} />
            <b>Working tree clean</b>
            <span>Nothing to review. New edits show up here as you make them.</span>
          </div>
        )}
        {files.length > 0 && (
          <div className="rv-summary">
            {plural(files.length, 'file')} changed
            <span className="add">+{total.add}</span>
            <span className="del">−{total.del}</span>
          </div>
        )}
        {staged.length > 0 && (
          <Group title="Staged" files={staged} staged ctx={ctx} actions={<button className="rv-gbtn" onClick={() => run('stageAll', { op: 'stageAll', stage: false })}>Unstage all</button>} />
        )}
        {unstaged.length > 0 && (
          <Group
            title="Changes"
            files={unstaged}
            ctx={ctx}
            actions={
              <>
                <button className="rv-gbtn" onClick={discardAll}>Discard all</button>
                <button className="rv-gbtn" onClick={() => run('stageAll', { op: 'stageAll', stage: true })}>Stage all</button>
              </>
            }
          />
        )}
      </div>
      <CommitBox ctx={ctx} staged={staged} unstaged={unstaged} key={root} />
    </>
  );
}

function Group({ title, files, staged = false, ctx, actions }) {
  const autoOpen = files.length <= 12;
  return (
    <section className="rv-group">
      <div className="rv-gtitle">
        {title}
        <span className="n">{files.length}</span>
        <span className="grow" />
        {actions}
      </div>
      {files.map((f) => (
        <FileDiff key={`${staged}:${f.path}`} f={f} staged={staged} ctx={ctx} startOpen={autoOpen} />
      ))}
    </section>
  );
}

// Max mode: the changed files down the left, like a PR's file tree.
function FileNav({ files, comments, scroller }) {
  const counts = new Map();
  for (const c of comments) counts.set(c.path, (counts.get(c.path) || 0) + 1);
  const seen = new Set();
  const list = files.filter((f) => !seen.has(f.path) && seen.add(f.path));
  const jump = (path) => {
    const el = scroller.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    el.dispatchEvent(new CustomEvent('rv-open'));
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  return (
    <nav className="rv-nav">
      <div className="rv-nav-title">Files</div>
      {list.map((f) => {
        const code = f.untracked ? 'U' : f.x !== ' ' && f.x !== '?' ? f.x : f.y;
        return (
          <button key={f.path} className="rv-nav-row" onClick={() => jump(f.path)} title={f.path}>
            <span className={`rv-code c-${code}`}>{code}</span>
            <span className="ellipsis">{baseName(f.path)}</span>
            <span className="rv-dir ellipsis">{dirName(f.path)}</span>
            {counts.get(f.path) ? (
              <span className="rv-ncount">
                <IconComment size={11} />
                {counts.get(f.path)}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function FileDiff({ f, staged, ctx, startOpen, readOnly = false, text: given = null }) {
  const { root, run, fold } = ctx;
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState(given);
  const [force, setForce] = useState(false);
  const el = useRef(null);
  const known = readOnly ? null : staged ? f.staged : f.unstaged;
  const code = readOnly ? f.status : staged ? f.x : f.untracked ? 'U' : f.y;
  const abs = `${root}/${f.path}`;
  // Re-read the diff whenever git reports different counts for this file.
  const sig = `${known?.add}|${known?.del}|${code}`;

  useEffect(() => {
    if (fold.n) setOpen(fold.open);
  }, [fold.n]);
  useEffect(() => {
    const node = el.current;
    const onOpen = () => setOpen(true);
    node?.addEventListener('rv-open', onOpen);
    return () => node?.removeEventListener('rv-open', onOpen);
  }, []);
  useEffect(() => {
    if (!open || readOnly) return;
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

  const stage = (e) => {
    e.stopPropagation();
    api.sys.gitStage(root, f.path, !staged).then(ctx.refresh);
  };
  const discard = async (e) => {
    e.stopPropagation();
    const ok = await api.sys.confirm({ message: `Discard changes to ${baseName(f.path)}?`, detail: f.untracked ? 'This deletes the untracked file. It cannot be undone.' : 'Your edits to this file will be lost. This cannot be undone.', ok: 'Discard' });
    if (!ok) return;
    await api.sys.gitDiscard(root, f.path, f.untracked);
    ctx.refresh();
  };
  // Hunk actions build a one-hunk patch from this diff and hand it to `git apply`.
  const hunkAction = async (i, kind) => {
    const patch = hunkPatch(parsed, i);
    if (kind === 'discard') {
      const ok = await api.sys.confirm({ message: 'Discard this change?', detail: `The edits in this hunk of ${baseName(f.path)} will be lost. This cannot be undone.`, ok: 'Discard' });
      if (!ok) return;
      return run('apply', { op: 'apply', patch, reverse: true });
    }
    run('apply', { op: 'apply', patch, cached: true, reverse: kind === 'unstage' });
  };
  const hunkActions = readOnly || f.untracked ? null : staged ? [['unstage', 'Unstage hunk', IconMinus]] : [['discard', 'Discard hunk', IconUndo], ['stage', 'Stage hunk', IconPlus]];

  return (
    <div className={`rv-file${open ? ' open' : ''}`} data-path={f.path} ref={el}>
      <div className="rv-fhead" onClick={() => setOpen((o) => !o)}>
        <span className={`chev${open ? ' open' : ''}`}>
          <IconChevron size={11} />
        </span>
        <span className={`rv-code c-${code}`}>{code}</span>
        <span className="rv-name">
          {baseName(f.path)}
          <span className="rv-dir">{f.from ? `${f.from} → ` : ''}{dirName(f.path)}</span>
        </span>
        {counts && (
          <span className="rv-counts">
            {counts.add != null ? <span className="add">+{counts.add}</span> : <span className="dim">bin</span>} {counts.del ? <span className="del">−{counts.del}</span> : null}
          </span>
        )}
        <span className="rv-actions">
          <button className="icon-btn sm" title="Open file" onClick={(e) => (e.stopPropagation(), A.openFile(abs))}>
            <IconFile size={13} />
          </button>
          {!readOnly && !staged && (
            <button className="icon-btn sm" title="Discard changes" onClick={discard}>
              <IconUndo size={13} />
            </button>
          )}
          {!readOnly && (
            <button className="icon-btn sm" title={staged ? 'Unstage file' : 'Stage file'} onClick={stage}>
              {staged ? <IconMinus size={13} /> : <IconPlus size={13} />}
            </button>
          )}
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
            parsed?.hunks.map((h, i) => (
              <Hunk key={i} h={h} path={f.path} lang={langOf(f.path)} ctx={ctx} commentable={!readOnly} onOpen={(line) => A.openFile(abs, line)} actions={hunkActions} onAction={(kind) => hunkAction(i, kind)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---- Hunks: unified and side by side, with line comments ---------------------------------------
function Hunk({ h, path, lang, ctx, commentable, onOpen, actions, onAction }) {
  const { view, comments, root } = ctx;
  const tokens = useMemo(() => highlightLines(h.lines.map((l) => l.text), lang), [h, lang]);
  const [composing, setComposing] = useState(null); // { side, line, snippet }
  const forLine = (side, line) => comments.filter((c) => c.path === path && c.side === side && c.line === line);
  const split = view === 'split';
  const cols = split ? 6 : 4;

  const code = (i) =>
    h.lines[i].type === 'meta' ? <i>{h.lines[i].text}</i> : tokens[i].map(([cls, t], k) => <Fragment key={k}>{cls ? <span className={`hl-${cls}`}>{t}</span> : t}</Fragment>);
  const gutter = (l, side) => {
    const no = side === 'old' ? l.oldNo : l.newNo;
    return (
      <td className="no">
        {commentable && no != null && (
          <button className="rv-add-cmt" title="Comment on this line" onClick={() => setComposing({ side, line: no, snippet: l.text })}>
            <IconCommentAdd size={12} />
          </button>
        )}
        {no ?? ''}
      </td>
    );
  };
  // Comment threads and the composer sit under the line they belong to, across all columns.
  const threads = (pairs) => {
    const rows = [];
    for (const [side, no] of pairs) {
      if (no == null) continue;
      for (const c of forLine(side, no)) rows.push(<CommentRow key={c.id} c={c} root={root} cols={cols} />);
      if (composing?.side === side && composing.line === no)
        rows.push(
          <Composer
            key="composer"
            cols={cols}
            onCancel={() => setComposing(null)}
            onSave={(text) => {
              A.addReviewComment(root, { path, side, line: no, snippet: composing.snippet, text });
              setComposing(null);
            }}
          />
        );
    }
    return rows;
  };

  return (
    <div className="rv-hunk">
      <div className="rv-hhead">
        <span className="ellipsis">
          {h.header.replace(/@@(.*)@@.*/, '@@$1@@')}
          {h.context && <span className="ctx">{h.context}</span>}
        </span>
        {actions && (
          <span className="rv-hactions">
            {actions.map(([kind, title, Icon]) => (
              <button key={kind} className="rv-hbtn" onClick={() => onAction(kind)}>
                <Icon size={12} />
                {title}
              </button>
            ))}
          </span>
        )}
      </div>
      <table className={`rv-lines${split ? ' split' : ''}`}>
        {split && (
          <colgroup>
            <col className="c-no" />
            <col className="c-sign" />
            <col className="c-code" />
            <col className="c-no" />
            <col className="c-sign" />
            <col className="c-code" />
          </colgroup>
        )}
        <tbody>
          {split
            ? splitRows(h).map((r, k) =>
                r.meta ? (
                  <tr key={k} className="ln meta">
                    <td colSpan={6} className="code">
                      {code(r.mi)}
                    </td>
                  </tr>
                ) : (
                  <Fragment key={k}>
                    <tr className="ln" onDoubleClick={() => r.right?.newNo && onOpen(r.right.newNo)}>
                      {r.left ? gutter(r.left, 'old') : <td className="no empty" />}
                      <td className={`sign ${r.left?.type === 'del' ? 'del' : r.left ? '' : 'empty'}`}>{r.left?.type === 'del' ? '−' : ''}</td>
                      <td className={`code half ${r.left?.type === 'del' ? 'del' : r.left ? '' : 'empty'}`}>{r.left && code(r.li)}</td>
                      {r.right ? gutter(r.right, 'new') : <td className="no empty" />}
                      <td className={`sign ${r.right?.type === 'add' ? 'add' : r.right ? '' : 'empty'}`}>{r.right?.type === 'add' ? '+' : ''}</td>
                      <td className={`code half ${r.right?.type === 'add' ? 'add' : r.right ? '' : 'empty'}`}>{r.right && code(r.ri)}</td>
                    </tr>
                    {threads([
                      ['old', r.left?.type === 'del' ? r.left.oldNo : null],
                      ['new', r.right?.newNo],
                    ])}
                  </Fragment>
                )
              )
            : h.lines.map((l, i) => (
                <Fragment key={i}>
                  <tr className={`ln ${l.type}`} onDoubleClick={() => l.newNo && onOpen(l.newNo)}>
                    {l.type === 'del' ? gutter(l, 'old') : <td className="no">{l.oldNo ?? ''}</td>}
                    {l.type === 'del' ? <td className="no" /> : gutter(l, 'new')}
                    <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                    <td className="code">{code(i)}</td>
                  </tr>
                  {threads([[l.type === 'del' ? 'old' : 'new', l.type === 'del' ? l.oldNo : l.newNo]])}
                </Fragment>
              ))}
        </tbody>
      </table>
    </div>
  );
}

function Composer({ cols, initial = '', onSave, onCancel }) {
  const [text, setText] = useState(initial);
  const save = () => text.trim() && onSave(text.trim());
  return (
    <tr className="rv-cmt-row">
      <td colSpan={cols}>
        <div className="rv-composer">
          <textarea
            autoFocus
            className="field"
            rows={3}
            placeholder="Leave a comment…  ⌘↵ to save"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.metaKey) (e.preventDefault(), save());
              if (e.key === 'Escape') (e.stopPropagation(), onCancel());
            }}
          />
          <div className="rv-composer-actions">
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn primary" disabled={!text.trim()} onClick={save}>
              Comment
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

function CommentRow({ c, root, cols }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <Composer
        cols={cols}
        initial={c.text}
        onCancel={() => setEditing(false)}
        onSave={(text) => {
          A.updateReviewComment(root, c.id, text);
          setEditing(false);
        }}
      />
    );
  return (
    <tr className="rv-cmt-row">
      <td colSpan={cols}>
        <div className="rv-cmt">
          <IconComment size={13} />
          <div className="rv-cmt-text">{c.text}</div>
          <span className="rv-cmt-when">{timeAgo(c.at)}</span>
          <button className="icon-btn sm" title="Edit" onClick={() => setEditing(true)}>
            <IconPencil size={12} />
          </button>
          <button className="icon-btn sm" title="Delete" onClick={() => A.removeReviewComment(root, c.id)}>
            <IconTrash size={12} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// The draft review: every comment, and where to send it.
function CommentsSummary({ ctx }) {
  const { root, comments, pr, run } = ctx;
  const text = () => reviewMarkdown(comments);
  const send = () => {
    if (A.pasteIntoSession(text())) A.toast({ title: `Sent ${plural(comments.length, 'comment')} to the terminal`, detail: 'Pasted into the focused session. Press Return there to submit.' });
    else A.toast({ title: 'No session to send to', detail: 'Focus a terminal session first.' });
  };
  const post = async () => {
    const r = await run('prComment', { op: 'prComment', body: text() }, { done: `Posted to #${pr.pr.number}` });
    if (r) A.clearReviewComments(root);
  };
  const clear = async () => {
    const ok = await api.sys.confirm({ message: `Delete ${plural(comments.length, 'comment')}?`, detail: 'Your draft review comments for this repository are removed.', ok: 'Delete' });
    if (ok) A.clearReviewComments(root);
  };
  return (
    <div className="rv-review">
      <div className="rv-review-head">
        <IconComment size={14} />
        <b>{plural(comments.length, 'comment')}</b>
        <span className="dim">draft review</span>
        <span className="grow" />
        <button className="btn primary sm" onClick={send} title="Paste the comments into the focused session, e.g. for a coding agent">
          <IconSend size={13} />
          Send to terminal
        </button>
        {pr?.pr && (
          <button className="btn sm" onClick={post} title={`Post as one comment on #${pr.pr.number}`}>
            Post to PR
          </button>
        )}
        <button className="icon-btn sm" title="Copy as text" onClick={() => (navigator.clipboard.writeText(text()), A.toast({ title: 'Review copied' }))}>
          <IconCopy size={13} />
        </button>
        <button className="icon-btn sm" title="Delete all" onClick={clear}>
          <IconTrash size={13} />
        </button>
      </div>
      <div className="rv-review-list">
        {[...comments]
          .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
          .map((c) => (
            <div key={c.id} className="rv-review-item">
              <span className="loc">
                {baseName(c.path)}:{c.line}
              </span>
              <span className="ellipsis">{c.text}</span>
              <button className="icon-btn sm" title="Delete" onClick={() => A.removeReviewComment(root, c.id)}>
                <IconClose size={12} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---- Commit box ------------------------------------------------------------------------------------
function CommitBox({ ctx, staged, unstaged }) {
  const { info, run, busy, pr } = ctx;
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const all = !staged.length;
  const count = all ? new Set(unstaged.map((f) => f.path)).size : new Set(staged.map((f) => f.path)).size;
  const message = [summary.trim(), body.trim()].filter(Boolean).join('\n\n');
  const canCommit = !busy && (amend || (count > 0 && summary.trim()));

  const toggleAmend = () => {
    setAmend((a) => {
      if (!a && !summary.trim() && info?.head) setSummary(info.head.subject);
      return !a;
    });
  };
  const commit = async (then) => {
    if (!canCommit) return;
    const r = await run('commit', { op: 'commit', message, amend, all }, { done: amend ? 'Commit amended' : `Committed ${plural(count, 'file')}`, quiet: !!then });
    if (!r) return;
    setSummary('');
    setBody('');
    setAmend(false);
    // An amended commit that was already pushed needs a (leased) force push to replace it.
    if (then === 'push') run('push', { op: 'push', force: amend && !!info?.upstream && !info?.ahead }, { done: 'Committed and pushed' });
  };
  const menu = async () => {
    const id = await api.app.popupMenu([
      { id: 'commit', label: amend ? 'Amend' : 'Commit', enabled: !!canCommit },
      { id: 'push', label: amend ? 'Amend & Force Push' : 'Commit & Push', enabled: !!canCommit && !!info?.remote },
      { type: 'separator' },
      { id: 'amend', label: 'Amend previous commit', checked: amend },
    ]);
    if (id === 'commit') commit();
    else if (id === 'push') commit('push');
    else if (id === 'amend') toggleAmend();
  };

  return (
    <div className="rv-commit">
      <input
        className="field rv-summary-input"
        placeholder={amend ? 'Amend message (empty keeps it)' : all && count ? `Summary (commits all ${plural(count, 'file')})` : 'Summary'}
        value={summary}
        maxLength={300}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.metaKey && commit()}
      />
      <textarea className="field" rows={2} placeholder="Description" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.metaKey && commit()} />
      <div className="rv-commit-row">
        <label className={`rv-check${amend ? ' on' : ''}`}>
          <input type="checkbox" checked={amend} onChange={toggleAmend} />
          Amend
        </label>
        {summary.length > 72 && <span className="rv-warn">{summary.length}/72</span>}
        <span className="grow" />
        <div className="rv-splitbtn">
          <button className="btn primary" disabled={!canCommit} onClick={() => commit()} title="⌘↵">
            {busy === 'commit' ? <IconSpinner size={13} /> : <IconCommit size={14} />}
            {amend ? 'Amend' : all && count ? `Commit all ${count}` : count ? `Commit ${count}` : 'Commit'}
          </button>
          <button className="btn primary caret" disabled={!!busy} onClick={menu} title="More commit options">
            <IconChevronDown size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Commits -------------------------------------------------------------------------------------
function Commits({ ctx }) {
  const { root, info, tick } = ctx;
  const [commits, setCommits] = useState(null);
  const [openSha, setOpenSha] = useState(null);
  useEffect(() => {
    let on = true;
    api.review.log(root, 80).then((c) => on && setCommits(c));
    return () => {
      on = false;
    };
  }, [root, tick, info?.head?.short]);
  if (!commits) return <div className="rv-empty">Loading history…</div>;
  if (!commits.length)
    return (
      <div className="rv-empty">
        <IconCommit size={22} />
        <b>No commits yet</b>
        <span>Commit your changes from the Changes tab.</span>
      </div>
    );
  const firstPushed = commits.findIndex((c) => c.pushed);
  return (
    <div className="rv-scroll">
      {commits.map((c, i) => (
        <Fragment key={c.sha}>
          {i === firstPushed && i > 0 && <div className="rv-divider">{info?.upstream ? `on ${info.upstream}` : 'on the remote'}</div>}
          <CommitRow c={c} top={i === 0} ctx={ctx} open={openSha === c.sha} onToggle={() => setOpenSha((s) => (s === c.sha ? null : c.sha))} />
        </Fragment>
      ))}
    </div>
  );
}

function CommitRow({ c, top, ctx, open, onToggle }) {
  const { root, info } = ctx;
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!open || detail) return;
    api.review.show(root, c.sha).then(setDetail);
  }, [open]);
  const files = useMemo(() => (detail ? splitFiles(detail.patch) : null), [detail]);
  const body = detail?.message.split('\n').slice(1).join('\n').trim();
  const refs = c.refs
    .split(', ')
    .filter((r) => r && !r.startsWith('HEAD'))
    .slice(0, 3);
  const menu = async (e) => {
    e.stopPropagation();
    const id = await api.app.popupMenu([
      { id: 'copy', label: 'Copy SHA' },
      { id: 'msg', label: 'Copy message' },
      { id: 'web', label: 'Open on the web', enabled: !!info?.webUrl && c.pushed },
      { type: 'separator' },
      { id: 'undo', label: 'Undo this commit', enabled: top && !c.pushed },
    ]);
    if (id === 'copy') navigator.clipboard.writeText(c.sha);
    else if (id === 'msg') navigator.clipboard.writeText(detail?.message || c.subject);
    else if (id === 'web') api.sys.openExternal(`${info.webUrl}/commit/${c.sha}`);
    else if (id === 'undo') undoCommit(ctx);
  };
  return (
    <div className={`rv-commit-item${open ? ' open' : ''}`}>
      <div className="rv-crow" onClick={onToggle}>
        <span className={`rv-cdot${c.pushed ? '' : ' local'}`} title={c.pushed ? 'Pushed' : 'Not pushed yet'} />
        <span className="rv-csubject ellipsis">{c.subject}</span>
        {refs.map((r) => (
          <span key={r} className="rv-ref ellipsis">
            {r.replace('tag: ', '')}
          </span>
        ))}
        <span className="rv-cmeta">
          {c.author} · {timeAgo(c.time)}
        </span>
        <span className="rv-sha mono">{c.short}</span>
        <button className="icon-btn sm rv-cmore" onClick={menu}>
          <IconMore size={13} />
        </button>
      </div>
      {open && (
        <div className="rv-cbody">
          {body && <pre className="rv-cmsg">{body}</pre>}
          {!files && <div className="rv-note">Loading…</div>}
          {files?.map((f) => (
            <FileDiff key={f.path} f={f} ctx={ctx} readOnly startOpen={files.length <= 6} text={f.text} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Pull request ----------------------------------------------------------------------------------
function PullRequest({ ctx }) {
  const { pr, info } = ctx;
  if (!pr) return <div className="rv-empty">Checking for a pull request…</div>;
  if (!pr.gh)
    return (
      <div className="rv-empty">
        <IconPR size={22} />
        <b>GitHub CLI needed</b>
        <span>
          Install <code>gh</code> and run <code>gh auth login</code> to see and open pull requests here.
        </span>
        <button className="btn" onClick={() => A.runInSession('brew install gh && gh auth login')}>
          Install in terminal
        </button>
      </div>
    );
  if (pr.pr) return <PrCard ctx={ctx} p={pr.pr} />;
  if (info?.detached) return <div className="rv-empty">Check out a branch to open a pull request.</div>;
  if (!info?.remote) return <div className="rv-empty">Add a GitHub remote to open pull requests.</div>;
  if (info.branch === info.defaultBranch)
    return (
      <div className="rv-empty">
        <IconBranch size={22} />
        <b>You're on {info.branch}</b>
        <span>Create a branch for your changes, then open a pull request from it.</span>
      </div>
    );
  return <CreatePr ctx={ctx} error={pr.error} />;
}

function PrCard({ ctx, p }) {
  const { run, busy, info } = ctx;
  const [comment, setComment] = useState('');
  const c = p.checks || { list: [] };
  const state = p.state === 'MERGED' ? 'Merged' : p.state === 'CLOSED' ? 'Closed' : p.isDraft ? 'Draft' : 'Open';
  const review = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }[p.reviewDecision];
  const merge = async () => {
    const method = await api.app.popupMenu([
      { id: 'squash', label: 'Squash and merge' },
      { id: 'merge', label: 'Create a merge commit' },
      { id: 'rebase', label: 'Rebase and merge' },
    ]);
    if (!method) return;
    const ok = await api.sys.confirm({ message: `Merge #${p.number} into ${p.baseRefName}?`, detail: p.title, ok: 'Merge' });
    if (ok) run('merge', { op: 'prMerge', method }, { done: `Merged #${p.number}` });
  };
  const post = async () => {
    if (await run('prComment', { op: 'prComment', body: comment }, { done: 'Comment posted' })) setComment('');
  };
  return (
    <div className="rv-scroll">
      <div className="rv-pr">
        <div className="rv-pr-top">
          <span className={`rv-state s-${state.toLowerCase()}`}>
            {state === 'Merged' ? <IconMerge size={13} /> : <IconPR size={13} />}
            {state}
          </span>
          <span className="dim">#{p.number}</span>
          <span className="grow" />
          <button className="icon-btn sm" title="Copy link" onClick={() => navigator.clipboard.writeText(p.url)}>
            <IconCopy size={13} />
          </button>
          <button className="btn sm" onClick={() => api.sys.openExternal(p.url)}>
            <IconExternal size={13} />
            Open on GitHub
          </button>
        </div>
        <h3 className="rv-pr-title">{p.title}</h3>
        <div className="rv-pr-meta">
          <span className="mono">{p.headRefName}</span> → <span className="mono">{p.baseRefName}</span>
          <span>·</span>
          <span className="add">+{p.additions}</span>
          <span className="del">−{p.deletions}</span>
          <span>· {plural(p.changedFiles, 'file')}</span>
          {p.comments > 0 && <span>· {plural(p.comments, 'comment')}</span>}
        </div>
        {review && <div className={`rv-review-state r-${p.reviewDecision.toLowerCase()}`}>{review}</div>}
        {info?.ahead > 0 && p.state === 'OPEN' && (
          <div className="rv-pr-warn">
            {plural(info.ahead, 'local commit')} not on the PR yet.{' '}
            <button className="link" onClick={() => run('push', { op: 'push' }, { done: 'Pushed' })}>
              Push now
            </button>
          </div>
        )}
      </div>

      {c.list.length > 0 && (
        <div className="rv-checks">
          <div className="rv-checks-head">
            Checks
            <span className="grow" />
            {c.failed > 0 && <span className="fail">{c.failed} failing</span>}
            {c.pending > 0 && <span className="pending">{c.pending} running</span>}
            {c.passed > 0 && <span className="pass">{c.passed} passed</span>}
          </div>
          {c.list.map((k, i) => (
            <button key={i} className="rv-check-row" disabled={!k.url} onClick={() => k.url && api.sys.openExternal(k.url)}>
              {k.state === 'pass' ? <IconCheckCircle size={14} className="pass" /> : k.state === 'fail' ? <IconXCircle size={14} className="fail" /> : <IconDot size={14} className="pending" />}
              <span className="ellipsis">{k.name}</span>
            </button>
          ))}
        </div>
      )}

      {p.state === 'OPEN' && (
        <div className="rv-pr-actions">
          {p.isDraft && (
            <button className="btn" disabled={!!busy} onClick={() => run('ready', { op: 'prReady' }, { done: 'Marked ready for review' })}>
              Ready for review
            </button>
          )}
          <button className="btn primary" disabled={!!busy || p.isDraft} onClick={merge}>
            <IconMerge size={13} />
            Merge…
          </button>
        </div>
      )}

      <div className="rv-pr-comment">
        <textarea className="field" rows={3} placeholder={`Comment on #${p.number}…  ⌘↵ to post`} value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.metaKey && comment.trim() && post()} />
        <div className="rv-composer-actions">
          <button className="btn" disabled={!comment.trim() || !!busy} onClick={post}>
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

function CreatePr({ ctx, error }) {
  const { root, info, run, busy, refresh } = ctx;
  const [bases, setBases] = useState([]);
  const [base, setBase] = useState(info.defaultBranch || '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [commits, setCommits] = useState([]);
  useEffect(() => {
    api.review.remoteBranches(root).then((b) => setBases(b.filter((x) => x !== info.branch)));
    api.review.log(root, 30).then((cs) => {
      const local = cs.filter((c) => !c.pushed);
      const mine = local.length ? local : cs.slice(0, 1);
      setCommits(mine);
      // Prefill like GitHub: one commit → its subject; several → the branch name and a list.
      setTitle((t) => t || (mine.length === 1 ? mine[0].subject : humanize(info.branch)));
      setBody((b) => b || (mine.length > 1 ? mine.map((c) => `- ${c.subject}`).join('\n') : ''));
    });
  }, [root, info.branch]);
  const create = async () => {
    const r = await run('prCreate', { op: 'prCreate', title, body, base, draft }, { quiet: true });
    if (r) {
      const url = r.output.split('\n').find((l) => l.startsWith('http'));
      if (url) A.toast({ title: 'Pull request opened', detail: url, action: { label: 'Open', run: () => api.sys.openExternal(url) } }, 8000);
      refresh();
    }
  };
  return (
    <div className="rv-scroll">
      <div className="rv-create">
        <div className="rv-create-head">
          <IconPR size={16} />
          <b>Open a pull request</b>
        </div>
        <div className="rv-create-flow">
          <span className="mono">{info.branch}</span>
          <span className="dim">into</span>
          <select className="field" value={base} onChange={(e) => setBase(e.target.value)}>
            {[...new Set([info.defaultBranch, ...bases].filter(Boolean))].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <input className="field" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="field" rows={8} placeholder="Describe the change (Markdown)" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="rv-commit-row">
          <label className={`rv-check${draft ? ' on' : ''}`}>
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Draft
          </label>
          <span className="dim rv-create-note">{info.upstream ? (info.ahead ? `Pushes ${plural(info.ahead, 'commit')} first` : '') : 'Publishes the branch first'}</span>
          <span className="grow" />
          <button className="btn primary" disabled={!title.trim() || !!busy} onClick={create}>
            {busy === 'prCreate' ? <IconSpinner size={13} /> : <IconPR size={13} />}
            {draft ? 'Create draft' : 'Create pull request'}
          </button>
        </div>
        {error && <div className="rv-pr-warn">{firstLines(error)}</div>}
        {commits.length > 0 && (
          <div className="rv-create-commits">
            <div className="rv-nav-title">{plural(commits.length, 'commit')}</div>
            {commits.map((c) => (
              <div key={c.sha} className="rv-create-commit">
                <span className="rv-sha mono">{c.short}</span>
                <span className="ellipsis">{c.subject}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const humanize = (branch) => {
  const s = branch.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
