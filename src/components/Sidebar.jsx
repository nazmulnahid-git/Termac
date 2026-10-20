import { useEffect, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import { useTabView, StatusMark, Chip, FailTip } from './common.jsx';
import { formatAccel } from '../lib/keys.js';
import { shortName, timeAgo, formatDuration } from '../lib/meta.js';
import { tildify } from '../lib/routing.js';

const api = window.termac;
const TAB_MIME = 'application/x-termac-tab';
const PANE_MIME = 'application/x-termac-pane';

export default function Sidebar({ floating, onLeave }) {
  const space = app.use((s) => A.activeSpace(s));
  const favorites = app.use((s) => s.favorites);
  const spaces = app.use((s) => s.spaces);
  const bindings = app.use((s) => s.settings.keybindings);
  const swipe = app.use((s) => s.settings.gestures.swipeSpaces);
  const [hint, setHint] = useState(null);
  const swipeAcc = useRef({ dx: 0, lock: 0 });

  const onWheel = (e) => {
    if (!swipe || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
    const acc = swipeAcc.current;
    if (Date.now() < acc.lock) return;
    acc.dx += e.deltaX;
    clearTimeout(acc.t);
    acc.t = setTimeout(() => (acc.dx = 0), 180);
    if (Math.abs(acc.dx) > 90) {
      A.switchSpace(acc.dx > 0 ? 1 : -1);
      acc.dx = 0;
      acc.lock = Date.now() + 450;
    }
  };

  const dropOn = (e) => {
    e.preventDefault();
    const pane = e.dataTransfer.getData(PANE_MIME);
    const tid = e.dataTransfer.getData(TAB_MIME);
    const h = hint;
    setHint(null);
    ui.set((u) => ({ ...u, dragging: null }));
    if (pane) return A.unsplit(pane);
    if (tid && h) A.moveTab(tid, h);
  };

  const dragProps = { hint, setHint };
  const isEmpty = !space.pinned.length && !space.folders.length;

  return (
    <aside className={`sidebar${floating ? ' floating' : ''}`} onWheel={onWheel} onMouseLeave={() => { if (!ui.get().peek?.pinned) ui.set((u) => ({ ...u, peek: null })); onLeave?.(); }} onDragOver={(e) => e.preventDefault()} onDrop={dropOn} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setHint(null)}>
      <div className="sb-head">
        <button className="icon-btn" title={`Toggle sidebar ${formatAccel(bindings.toggleSidebar)}`} onClick={() => A.setSettings({ sidebarHidden: !app.get().settings.sidebarHidden })}>
          <span className="sb-toggle" />
        </button>
      </div>
      <Location bindings={bindings} />
      <div className="sb-scroll">
        <Favorites ids={favorites} {...dragProps} />
        <div className="sec-title">
          <span className="glyph">{space.glyph}</span>
          <span className="grow ellipsis">{space.name}</span>
          <button className="more" onClick={() => spaceMenu(space)}>···</button>
        </div>
        {isEmpty && <div className="pin-empty">Drag a session here to pin it to this Space</div>}
        <Section list={space.pinned} dest={{ section: 'pinned', spaceId: space.id, folderId: null }} {...dragProps} />
        {space.folders.map((f) => (
          <Folder key={f.id} folder={f} spaceId={space.id} {...dragProps} />
        ))}
        <TodayHeader space={space} />
        <Section list={space.today} dest={{ section: 'today', spaceId: space.id, folderId: null }} {...dragProps} />
        <button className="row new" onClick={() => A.openTerminal()} style={{ marginTop: 2, width: 'calc(100% - 16px)' }}>
          <span className="chip">+</span>
          <span className="name" style={{ textAlign: 'left' }}>New Terminal</span>
          <kbd>{formatAccel(bindings.newTerminal)}</kbd>
        </button>
      </div>
      <SidebarCards />
      <BottomBar spaces={spaces} activeId={space.id} />
    </aside>
  );
}

function Location({ bindings }) {
  const sid = ui.use((s) => s.focusedSid);
  const cwd = rt.use((s) => s[sid]?.cwd);
  const danger = rt.use((s) => s[sid]?.dangerHost);
  const home = ui.use((s) => s.home);
  return (
    <button className="location" onClick={() => ui.set((u) => ({ ...u, overlay: 'commandBar' }))}>
      <span className="host">{danger ? 'ssh' : 'local'}</span>
      <span className="path">&lrm;{danger || tildify(cwd, home) || '~'}</span>
      <kbd>{formatAccel(bindings.commandBar)}</kbd>
    </button>
  );
}

// ---- Favorites -----------------------------------------------------------------------
function Favorites({ ids, hint, setHint }) {
  const dragging = ui.use((s) => s.dragging);
  const showDrop = dragging && !ids.includes(dragging.tabId);
  if (!ids.length && !showDrop) return null;
  return (
    <div
      className="favs"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setHint({ section: 'fav', spaceId: null, folderId: null, index: -1 });
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const tid = e.dataTransfer.getData(TAB_MIME);
        setHint(null);
        ui.set((u) => ({ ...u, dragging: null }));
        if (tid) A.moveTab(tid, { section: 'fav', spaceId: null });
      }}
    >
      {ids.map((tid) => (
        <FavTile key={tid} tid={tid} />
      ))}
      {showDrop && <div className={`fav-drop${hint?.section === 'fav' ? ' drop-into' : ''}`}>Drop to add to Favorites</div>}
    </div>
  );
}

function FavTile({ tid }) {
  const v = useTabView(tid);
  const on = app.use((s) => A.activeTabId(s) === tid);
  const peekHandlers = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const color = { run: 'var(--accent)', ok: 'var(--ok)', fail: 'var(--fail)', bell: 'var(--bell)', idle: 'var(--faint)' }[v.status];
  return (
    <div className={`fav${on ? ' on' : ''}`} title={v.name} draggable onDragStart={(e) => dragStart(e, tid)} onDragEnd={dragEnd} onClick={(e) => (e.shiftKey ? null : A.activateTab(tid))} onContextMenu={(e) => rowMenu(e, tid, v)} {...peekHandlers}>
      {shortName(v.tab.name || v.active?.name)}
      <span className={`corner dot6${v.status === 'run' ? ' st-run' : ''}`} style={{ background: color }} />
      {v.bell > 0 && <span className="badge status st-bell">{v.bell}</span>}
    </div>
  );
}

// ---- Rows ----------------------------------------------------------------------------
function Section({ list, dest, hint, setHint, indent }) {
  const sameDest = (h) => h && h.section === dest.section && h.spaceId === dest.spaceId && (h.folderId || null) === (dest.folderId || null);
  return (
    <div
      className="rows"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!sameDest(hint)) setHint({ ...dest, index: list.length });
      }}
      style={{ minHeight: dest.section === 'today' && !list.length ? 8 : undefined }}
    >
      {list.map((tid, i) => (
        <div key={tid}>
          {sameDest(hint) && hint.index === i && <div className="drop-line" />}
          <Row tid={tid} indent={indent} onDragOverRow={(after) => setHint({ ...dest, index: after ? i + 1 : i })} />
        </div>
      ))}
      {sameDest(hint) && hint.index >= list.length && list.length > 0 && <div className="drop-line" />}
    </div>
  );
}

function Row({ tid, indent, onDragOverRow }) {
  const v = useTabView(tid);
  const on = app.use((s) => A.activeTabId(s) === tid);
  const dragging = ui.use((s) => s.dragging?.tabId === tid);
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const peekHandlers = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const click = (e) => {
    if (e.shiftKey) return;
    if (v.status === 'fail' && !on) return A.jumpToFailure(v.fail.sid);
    A.activateTab(tid);
  };
  return (
    <div
      className={`row${on ? ' on' : ''}${indent ? ' indent' : ''}${dragging ? ' ghost' : ''}${v.dead ? ' dead' : ''}`}
      draggable={!renaming}
      onDragStart={(e) => dragStart(e, tid)}
      onDragEnd={dragEnd}
      onDragOver={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverRow(e.clientY > r.top + r.height / 2);
      }}
      onClick={click}
      onDoubleClick={() => setRenaming(true)}
      onContextMenu={(e) => rowMenu(e, tid, v, () => setRenaming(true))}
      onMouseEnter={(e) => {
        setHover(true);
        peekHandlers.onMouseEnter(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        peekHandlers.onMouseLeave(e);
      }}
      onMouseDown={peekHandlers.onMouseDown}
    >
      {v.panes.length > 1 ? (
        <span className="panes-chip">
          {v.panes.map((p) => (
            <Chip key={p.sid} kind={p.kind} />
          ))}
        </span>
      ) : (
        <Chip kind={v.active?.kind} />
      )}
      {renaming ? (
        <input
          className="rename"
          autoFocus
          defaultValue={v.tab.name || v.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            A.renameTab(tid, e.target.value === v.name && !v.tab.name ? '' : e.target.value);
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <span className="name">{v.name}</span>
      )}
      {v.danger && <span className="prod">PROD</span>}
      <button className="close" title="Close" onClick={(e) => (e.stopPropagation(), A.closeTab(tid))}>
        ✕
      </button>
      <StatusMark status={v.status} bell={v.bell} />
      {hover && v.status === 'fail' && !ui.get().peek && <FailTip rt={v.fail.rt} />}
    </div>
  );
}

function Folder({ folder, spaceId, hint, setHint }) {
  const into = hint && hint.folderId === folder.id;
  return (
    <>
      <div
        className={`folder${into && !folder.open ? ' drop-into' : ''}`}
        onClick={() => A.updateFolder(spaceId, folder.id, { open: !folder.open })}
        onContextMenu={(e) => folderMenu(e, spaceId, folder)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHint({ section: 'pinned', spaceId, folderId: folder.id, index: folder.tabs.length });
        }}
      >
        <span className="chev">{folder.open ? '▼' : '▶'}</span>
        <span>▭</span>
        <span className="ellipsis">{folder.name}</span>
        {!folder.open && <span className="count">{folder.tabs.length}</span>}
      </div>
      {folder.open && <Section list={folder.tabs} dest={{ section: 'pinned', spaceId, folderId: folder.id }} hint={hint} setHint={setHint} indent />}
    </>
  );
}

function TodayHeader({ space }) {
  if (!space.today.length) return <div className="today-head">Today<span className="rule" /></div>;
  return (
    <div className="today-head">
      Today
      <span className="rule" />
      <button title="Move idle sessions to the Library" onClick={() => tidyNow(space)}>
        Tidy
      </button>
    </div>
  );
}

function tidyNow(space) {
  const s = app.get();
  const r = rt.get();
  const tids = space.today.filter((tid) => {
    if (tid === space.activeTabId) return false;
    const tab = s.tabs[tid];
    return tab && !tab.effects?.noArchive && collectSids(tab.layout).every((sid) => r[sid]?.status !== 'run');
  });
  if (!tids.length) return A.toast({ title: 'Nothing to tidy', detail: 'Running sessions and the open one stay put.' });
  A.tidy(tids, { reason: 'idle' });
}

function collectSids(n) {
  return n.sid ? [n.sid] : [...collectSids(n.a), ...collectSids(n.b)];
}

// ---- Drag helpers --------------------------------------------------------------------
function dragStart(e, tid) {
  e.dataTransfer.setData(TAB_MIME, tid);
  e.dataTransfer.effectAllowed = 'move';
  ui.set((u) => ({ ...u, dragging: { tabId: tid }, peek: null }));
}
function dragEnd() {
  ui.set((u) => ({ ...u, dragging: null }));
}

// ---- Peek ----------------------------------------------------------------------------
let peekTimer = null;
function usePeek(tid, sid, isActive) {
  const enabled = app.use((s) => s.settings.gestures.peek);
  const show = (el, pinned = false) => {
    const r = el.getBoundingClientRect();
    ui.set((u) => ({ ...u, peek: { tid, sid, top: r.top, left: r.right + 14, pinned } }));
  };
  return {
    onMouseEnter(e) {
      if (!enabled || isActive || ui.get().dragging) return;
      clearTimeout(peekTimer);
      const el = e.currentTarget;
      if (ui.get().peek) show(el, ui.get().peek.pinned);
      else peekTimer = setTimeout(() => show(el), 400);
    },
    onMouseLeave() {
      clearTimeout(peekTimer);
    },
    onMouseDown(e) {
      if (!e.shiftKey || isActive) return;
      e.preventDefault();
      const p = ui.get().peek;
      if (p?.pinned && p.tid === tid) ui.set((u) => ({ ...u, peek: null }));
      else show(e.currentTarget, true);
    },
  };
}

// ---- Menus ---------------------------------------------------------------------------
async function rowMenu(e, tid, v, startRename) {
  e.preventDefault();
  const s = app.get();
  const loc = A.locate(tid, s);
  const sp = A.activeSpace(s);
  const eff = v.tab.effects || {};
  const cwd = v.active?.rt.cwd;
  const items = [
    startRename && { id: 'rename', label: 'Rename…' },
    { type: 'separator' },
    loc?.section === 'today' ? { id: 'pin', label: 'Pin to Space' } : { id: 'unpin', label: 'Move to Today' },
    loc?.section === 'fav' ? { id: 'unfav', label: 'Remove from Favorites' } : { id: 'fav', label: 'Add to Favorites' },
    {
      label: 'Move to Folder',
      submenu: [...sp.folders.map((f) => ({ id: `folder:${f.id}`, label: f.name })), sp.folders.length && { type: 'separator' }, { id: 'newfolder', label: 'New Folder…' }].filter(Boolean),
    },
    { label: 'Move to Space', submenu: s.spaces.map((x) => ({ id: `space:${x.id}`, label: `${x.glyph}  ${x.name}`, enabled: x.id !== loc?.spaceId })) },
    { type: 'separator' },
    A.activeTabId(s) !== tid && { id: 'split', label: 'Open in Split Right' },
    { id: 'dup', label: 'New Terminal Here' },
    cwd && { id: 'copypath', label: 'Copy Path' },
    cwd && { id: 'finder', label: 'Open in Finder' },
    { type: 'separator' },
    {
      label: 'Protection',
      submenu: [
        { id: 'fx:danger', label: 'Red danger frame', checked: !!eff.danger },
        { id: 'fx:confirmPaste', label: 'Confirm multi-line paste', checked: !!eff.confirmPaste },
        { id: 'fx:noArchive', label: 'Never auto-archive', checked: !!eff.noArchive },
      ],
    },
    { type: 'separator' },
    { id: 'archive', label: 'Move to Library' },
    { id: 'close', label: 'Close' },
  ].filter(Boolean);
  const id = await api.app.popupMenu(items);
  if (!id) return;
  if (id === 'rename') startRename();
  else if (id === 'pin') A.moveTab(tid, { section: 'pinned', spaceId: loc.spaceId });
  else if (id === 'unpin' || id === 'unfav') A.moveTab(tid, { section: 'today', spaceId: loc?.spaceId || sp.id });
  else if (id === 'fav') A.moveTab(tid, { section: 'fav', spaceId: null });
  else if (id === 'newfolder') {
    const fid = A.createFolder(sp.id);
    A.moveTab(tid, { section: 'pinned', spaceId: sp.id, folderId: fid });
  } else if (id.startsWith('folder:')) A.moveTab(tid, { section: 'pinned', spaceId: sp.id, folderId: id.slice(7) });
  else if (id.startsWith('space:')) A.moveTab(tid, { section: loc?.section === 'pinned' ? 'pinned' : 'today', spaceId: id.slice(6) });
  else if (id === 'split') A.mergeIntoActive(tid, 'right');
  else if (id === 'dup') A.openTerminal({ cwd, viaRules: false });
  else if (id === 'copypath') navigator.clipboard.writeText(cwd);
  else if (id === 'finder') api.sys.reveal(cwd);
  else if (id.startsWith('fx:')) A.setTabEffects(tid, { [id.slice(3)]: !eff[id.slice(3)] });
  else if (id === 'archive') A.archiveTab(tid);
  else if (id === 'close') A.closeTab(tid);
}

async function folderMenu(e, spaceId, folder) {
  e.preventDefault();
  const id = await api.app.popupMenu([
    { id: 'rename', label: 'Rename…' },
    { id: 'delete', label: 'Remove Folder (keep sessions)' },
  ]);
  if (id === 'rename') {
    const name = await promptText('Folder name', folder.name);
    if (name) A.updateFolder(spaceId, folder.id, { name });
  } else if (id === 'delete') A.deleteFolder(spaceId, folder.id);
}

async function spaceMenu(space) {
  const s = app.get();
  const id = await api.app.popupMenu([
    { id: 'edit', label: 'Edit Space…' },
    { id: 'folder', label: 'New Folder' },
    { id: 'notes', label: 'Notes' },
    { type: 'separator' },
    { id: 'new', label: 'New Space…' },
    { id: 'overview', label: 'All Spaces' },
    { type: 'separator' },
    { id: 'delete', label: 'Delete Space…', enabled: s.spaces.length > 1 },
  ]);
  if (id === 'edit') ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id }));
  else if (id === 'folder') {
    const name = await promptText('Folder name', 'New Folder');
    if (name) A.createFolder(space.id, name);
  } else if (id === 'notes') ui.set((u) => ({ ...u, notesOpen: true }));
  else if (id === 'new') ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }));
  else if (id === 'overview') ui.set((u) => ({ ...u, overlay: 'overview' }));
  else if (id === 'delete') A.deleteSpace(space.id);
}

// Tiny inline prompt rendered by App (window.prompt is unavailable in Electron).
export function promptText(title, value = '') {
  return new Promise((resolve) => ui.set((u) => ({ ...u, prompt: { title, value, resolve } })));
}

// ---- Bottom ------------------------------------------------------------------------
function SidebarCards() {
  const notify = ui.use((s) => s.notify);
  const toast = ui.use((s) => s.toast);
  const spaces = app.use((s) => s.spaces);
  return (
    <>
      {notify && (
        <div className="sb-card">
          <span className={`ic${notify.exit ? ' fail' : ''}`}>{notify.exit ? '!' : '✓'}</span>
          <div className="grow">
            <div className="t mono ellipsis" style={{ fontSize: 11.5 }}>
              {notify.command}
            </div>
            <div className="dim ellipsis">
              {notify.exit ? `Failed (exit ${notify.exit})` : 'Finished'} in {spaces.find((x) => x.id === notify.spaceId)?.name} · {formatDuration(notify.dur)}
            </div>
          </div>
          <button
            className="link"
            onClick={() => {
              A.jumpTo(notify.sid);
              ui.set((u) => ({ ...u, notify: null }));
            }}
          >
            Jump
          </button>
        </div>
      )}
      {toast && (
        <div className="sb-card">
          <div className="grow">
            <div className="t">{toast.title}</div>
            {toast.detail && <div className="dim">{toast.detail}</div>}
          </div>
          {toast.action && (
            <button className="link" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function BottomBar({ spaces, activeId }) {
  const unseen = app.use((s) => [...new Set(s.activity.filter((a) => !a.seen).map((a) => a.spaceId))], arrayEq);
  const hasActivity = app.use((s) => s.activity.some((a) => !a.seen));
  const view = ui.use((s) => s.view);
  const [open, setOpen] = useState(false);
  return (
    <div className="sb-bottom">
      <button className="icon-btn" title="Library" style={view === 'library' ? { background: 'var(--sel)', color: 'var(--ink)' } : null} onClick={() => ui.set((u) => ({ ...u, view: u.view === 'library' ? 'terminal' : 'library' }))}>
        ▤
      </button>
      <div className="space-dots">
        {spaces.map((sp, i) => (
          <button
            key={sp.id}
            className={`space-dot${sp.id === activeId ? ' on' : ''}`}
            style={{ '--c': sp.color }}
            title={`${sp.name}  ⌃${i + 1}`}
            onClick={() => A.switchSpace(sp.id)}
            onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: sp.id }))}
          >
            <i />
            {unseen.includes(sp.id) && sp.id !== activeId && <span className="badge" />}
          </button>
        ))}
        <button className="icon-btn" title="New Space" onClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }))}>
          +
        </button>
      </div>
      <button className="icon-btn activity-btn" title="Finished jobs" onClick={() => setOpen((o) => !o)}>
        <span className="ring">↓</span>
        {hasActivity && <span className="badge" />}
      </button>
      {open && <ActivityPopover onClose={() => setOpen(false)} />}
    </div>
  );
}

function ActivityPopover({ onClose }) {
  const items = app.use((s) => s.activity);
  const spaces = app.use((s) => s.spaces);
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && onClose();
    setTimeout(() => window.addEventListener('mousedown', off), 0);
    app.set((s) => (s.activity.some((a) => !a.seen) ? { ...s, activity: s.activity.map((a) => ({ ...a, seen: true })) } : s));
    return () => window.removeEventListener('mousedown', off);
  }, []);
  return (
    <div ref={ref} className="modal" style={{ left: 12, right: 'auto', top: 'auto', bottom: 52, transform: 'none', width: 300, maxHeight: 360, position: 'absolute' }}>
      <div className="modal-title" style={{ paddingBottom: 8 }}>Finished jobs</div>
      <div style={{ overflowY: 'auto', padding: '0 8px 8px' }}>
        {!items.length && <div className="dim" style={{ padding: '6px 12px 12px', fontSize: 12 }}>Commands that run longer than the notify threshold show up here.</div>}
        {items.map((a) => (
          <button
            key={a.id}
            className="row"
            style={{ height: 'auto', padding: '6px 10px', width: 'calc(100% - 16px)', textAlign: 'left' }}
            onClick={() => {
              A.jumpTo(a.sid);
              onClose();
            }}
          >
            <StatusMark status={a.exit ? 'fail' : 'ok'} />
            <span className="grow">
              <div className="mono ellipsis" style={{ fontSize: 12 }}>
                {a.command}
              </div>
              <div className="dim" style={{ fontSize: 11 }}>
                {spaces.find((x) => x.id === a.spaceId)?.name} · {formatDuration(a.dur)} · {timeAgo(a.at)}
              </div>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
