import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import { useTabView, StatusMark, Chip, FailTip } from './common.jsx';
import { formatAccel } from '../lib/keys.js';
import { shortName, timeAgo, formatDuration } from '../lib/meta.js';
import { tildify } from '../lib/routing.js';
import { IconSidebar, IconFolder, IconFolderOpen, IconFolderPlus, IconChevron, IconPlus, IconMore, IconSearch, IconLibrary, IconActivity, IconGear } from './icons.jsx';
import Rail from './SidebarRail.jsx';
import { TAB_MIME, PANE_MIME, FOLDER_MIME, renameFolder, dragStart, dragEnd, usePeek, closePeek, rowMenu, folderMenu, spaceMenu, newFolder, promptText } from './sidebar-shared.js';

export { promptText };

const RAIL_WIDTH = 68;
const isTabDrag = (e) => e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(PANE_MIME);

export default function Sidebar({ floating, onLeave }) {
  const mode = app.use((s) => s.settings.sidebarMode);
  const width = app.use((s) => s.settings.sidebarWidth);
  const swipe = app.use((s) => s.settings.gestures.swipeSpaces);
  const [dragW, setDragW] = useState(null);
  const swipeAcc = useRef({ dx: 0, lock: 0 });
  const compact = mode === 'compact' && !floating;

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

  return (
    <aside
      className={`sidebar${compact ? ' compact' : ''}${floating ? ' floating' : ''}${dragW != null ? ' resizing' : ''}`}
      style={{ width: compact ? RAIL_WIDTH : (dragW ?? width) }}
      onWheel={onWheel}
      onMouseLeave={() => {
        closePeek();
        onLeave?.();
      }}
    >
      {compact ? <Rail /> : <Expanded />}
      {!compact && !floating && <ResizeHandle width={width} onDrag={setDragW} />}
    </aside>
  );
}

function ResizeHandle({ width, onDrag }) {
  const onMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    let w = width;
    const move = (ev) => {
      w = Math.min(380, Math.max(200, width + ev.clientX - startX));
      onDrag(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onDrag(null);
      A.setSettings({ sidebarWidth: Math.round(w) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className="sb-resize" onMouseDown={onMouseDown} onDoubleClick={() => A.setSettings({ sidebarWidth: 256 })} title="Drag to resize · double-click to reset" />;
}

// ---- Expanded -----------------------------------------------------------------------
function Expanded() {
  const space = app.use((s) => A.activeSpace(s));
  const favorites = app.use((s) => s.favorites);
  const bindings = app.use((s) => s.settings.keybindings);
  const [hint, setHint] = useState(null);

  const dropOn = (e) => {
    e.preventDefault();
    const pane = e.dataTransfer.getData(PANE_MIME);
    const tid = e.dataTransfer.getData(TAB_MIME);
    const h = hint;
    setHint(null);
    dragEnd();
    if (pane) return A.unsplit(pane);
    if (tid && h) A.moveTab(tid, h);
  };

  const dragProps = { hint, setHint };
  const isEmpty = !space.pinned.length && !space.folders.length;

  return (
    <div className="sb-expanded" onDragOver={(e) => isTabDrag(e) && e.preventDefault()} onDrop={dropOn} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setHint(null)}>
      <div className="sb-head">
        <button className="icon-btn" title={`Collapse sidebar  ${formatAccel(bindings.toggleSidebar)}`} onClick={A.toggleSidebar}>
          <IconSidebar />
        </button>
      </div>
      <Location bindings={bindings} />
      <div className="sb-scroll">
        <Favorites ids={favorites} {...dragProps} />
        <SpaceHeader space={space} />
        <Section list={space.pinned} dest={{ section: 'pinned', spaceId: space.id, folderId: null }} {...dragProps} />
        {space.folders.map((f, i) => (
          <Folder key={f.id} folder={f} index={i} spaceId={space.id} {...dragProps} />
        ))}
        {isEmpty && (
          <div className="pin-empty" onDragOver={(e) => isTabDrag(e) && setHint({ section: 'pinned', spaceId: space.id, folderId: null, index: 0 })}>
            Drag a session here to keep it in {space.name}
          </div>
        )}
        <TodayHeader space={space} />
        <Section list={space.today} dest={{ section: 'today', spaceId: space.id, folderId: null }} {...dragProps} />
        <button className="row new" onClick={() => A.openTerminal()}>
          <span className="chip">
            <IconPlus size={11} />
          </span>
          <span className="name">New Terminal</span>
          <kbd>{formatAccel(bindings.newTerminal)}</kbd>
        </button>
      </div>
      <SidebarCards />
      <BottomBar />
    </div>
  );
}

function Location({ bindings }) {
  const sid = ui.use((s) => s.focusedSid);
  const cwd = rt.use((s) => s[sid]?.cwd);
  const host = rt.use((s) => s[sid]?.dangerHost);
  const home = ui.use((s) => s.home);
  return (
    <button className="location" title="Search sessions, folders, hosts and actions" onClick={() => ui.set((u) => ({ ...u, overlay: 'commandBar' }))}>
      <IconSearch size={14} />
      <span className="path">&lrm;{host || tildify(cwd, home) || '~'}</span>
      <kbd>{formatAccel(bindings.commandBar)}</kbd>
    </button>
  );
}

function SpaceHeader({ space }) {
  return (
    <div className="sec-title" onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id }))}>
      <span className="glyph">{space.glyph}</span>
      <span className="grow ellipsis">{space.name}</span>
      <span className="sec-actions">
        <button className="icon-btn sm" title="New folder" onClick={() => newFolder(space.id)}>
          <IconFolderPlus size={14} />
        </button>
        <button className="icon-btn sm" title="Space options" onClick={() => spaceMenu(space)}>
          <IconMore size={14} />
        </button>
      </span>
    </div>
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
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setHint({ section: 'fav', spaceId: null, folderId: null, index: -1 });
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const tid = e.dataTransfer.getData(TAB_MIME);
        setHint(null);
        dragEnd();
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
  const peek = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const color = { run: 'var(--accent)', ok: 'var(--ok)', fail: 'var(--fail)', bell: 'var(--bell)', idle: 'var(--faint)' }[v.status];
  return (
    <div className={`fav${on ? ' on' : ''}`} title={v.name} draggable onDragStart={(e) => dragStart(e, tid)} onDragEnd={dragEnd} onClick={(e) => !e.shiftKey && A.activateTab(tid)} onContextMenu={(e) => rowMenu(e, tid, v)} {...peek}>
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
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!sameDest(hint)) setHint({ ...dest, index: list.length });
      }}
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
  const peek = usePeek(tid, v?.active?.sid, on);
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
        if (!isTabDrag(e)) return;
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverRow(e.clientY > r.top + r.height / 2);
      }}
      onClick={click}
      onDoubleClick={() => setRenaming(true)}
      onContextMenu={(e) => rowMenu(e, tid, v, () => setRenaming(true))}
      onMouseEnter={(e) => {
        setHover(true);
        peek.onMouseEnter(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        peek.onMouseLeave(e);
      }}
      onMouseDown={peek.onMouseDown}
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
        <InlineName
          value={v.tab.name || v.name}
          onDone={(name) => {
            if (name != null) A.renameTab(tid, name === v.name && !v.tab.name ? '' : name);
            setRenaming(false);
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

function InlineName({ value, onDone }) {
  const ref = useRef(null);
  const done = useRef(false);
  const finish = (v) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  useLayoutEffect(() => {
    ref.current.focus();
    ref.current.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename"
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.target.value);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

// ---- Folders -------------------------------------------------------------------------
function Folder({ folder, index, spaceId, hint, setHint }) {
  const [editing, setEditing] = useState(renameFolder.id === folder.id);
  const [reorder, setReorder] = useState(null); // 'before' | 'after' while a folder is dragged over
  const spring = useRef(null);
  const running = rt.use((s) => {
    const tabs = app.get().tabs;
    return folder.tabs.some((tid) => tabs[tid] && collectSids(tabs[tid].layout).some((sid) => s[sid]?.status === 'run'));
  });
  const into = hint && hint.folderId === folder.id;

  useEffect(() => {
    if (renameFolder.id === folder.id) renameFolder.id = null;
  }, [folder.id]);

  const toggle = () => A.updateFolder(spaceId, folder.id, { open: !folder.open });
  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes(FOLDER_MIME)) {
      const r = e.currentTarget.getBoundingClientRect();
      setReorder(e.clientY > r.top + r.height / 2 ? 'after' : 'before');
      return;
    }
    if (!isTabDrag(e)) return;
    if (!into) setHint({ section: 'pinned', spaceId, folderId: folder.id, index: folder.tabs.length });
    // Spring-loaded: hovering a closed folder while dragging opens it.
    if (!folder.open && !spring.current) spring.current = setTimeout(() => A.updateFolder(spaceId, folder.id, { open: true }), 600);
  };
  const clearDrag = () => {
    clearTimeout(spring.current);
    spring.current = null;
    setReorder(null);
  };
  const onDrop = (e) => {
    const fid = e.dataTransfer.getData(FOLDER_MIME);
    clearDrag();
    if (!fid) return;
    e.preventDefault();
    e.stopPropagation();
    if (fid !== folder.id) {
      const folders = app.get().spaces.find((x) => x.id === spaceId).folders.filter((f) => f.id !== fid);
      const at = folders.findIndex((f) => f.id === folder.id);
      A.moveFolder(spaceId, fid, reorder === 'after' ? at + 1 : at);
    }
  };

  return (
    <div className={`folder-wrap${reorder ? ` reorder-${reorder}` : ''}`}>
      <div
        className={`folder${into ? ' drop-into' : ''}`}
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_MIME, folder.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={onDragOver}
        onDragLeave={clearDrag}
        onDrop={onDrop}
        onClick={() => !editing && toggle()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        onContextMenu={(e) => folderMenu(e, spaceId, folder, () => setEditing(true))}
      >
        <span className={`chev${folder.open ? ' open' : ''}`}>
          <IconChevron size={11} />
        </span>
        <span className="ficon">{folder.open ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}</span>
        {editing ? (
          <InlineName
            value={folder.name}
            onDone={(name) => {
              if (name?.trim()) A.updateFolder(spaceId, folder.id, { name: name.trim() });
              setEditing(false);
            }}
          />
        ) : (
          <span className="fname">{folder.name}</span>
        )}
        {!folder.open && running && <span className="status st-run" />}
        {!folder.open && <span className="count">{folder.tabs.length}</span>}
        <span className="folder-actions">
          <button
            className="icon-btn sm"
            title="New terminal in folder"
            onClick={(e) => {
              e.stopPropagation();
              A.openTerminal({ section: 'pinned', spaceId, folderId: folder.id, viaRules: false });
            }}
          >
            <IconPlus size={12} />
          </button>
        </span>
      </div>
      <div className={`folder-body${folder.open ? ' open' : ''}`}>
        <div className="folder-inner">
          {folder.tabs.length ? (
            <Section list={folder.tabs} dest={{ section: 'pinned', spaceId, folderId: folder.id }} hint={hint} setHint={setHint} indent />
          ) : (
            <div
              className={`folder-empty${into ? ' drop-into' : ''}`}
              onDragOver={(e) => {
                if (!isTabDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setHint({ section: 'pinned', spaceId, folderId: folder.id, index: 0 });
              }}
            >
              Drop sessions here
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function collectSids(n) {
  if (!n) return [];
  return n.sid ? [n.sid] : [...collectSids(n.a), ...collectSids(n.b)];
}

function TodayHeader({ space }) {
  return (
    <div className="today-head">
      Today
      <span className="rule" />
      {space.today.length > 0 && (
        <button title="Move idle sessions to the Library" onClick={() => tidyNow(space)}>
          Tidy
        </button>
      )}
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

// ---- Bottom ------------------------------------------------------------------------
export function SidebarCards() {
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

export function SpaceDots({ vertical }) {
  const spaces = app.use((s) => s.spaces);
  const activeId = app.use((s) => s.activeSpaceId);
  const unseen = app.use((s) => [...new Set(s.activity.filter((a) => !a.seen).map((a) => a.spaceId))], arrayEq);
  return (
    <div className={`space-dots${vertical ? ' vertical' : ''}`}>
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
      <button className="icon-btn sm" title="New Space" onClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }))}>
        <IconPlus size={13} />
      </button>
    </div>
  );
}

export function useActivityButton() {
  const [open, setOpen] = useState(false);
  const hasActivity = app.use((s) => s.activity.some((a) => !a.seen));
  const button = (
    <button className="icon-btn activity-btn" title="Finished jobs" onClick={() => setOpen((o) => !o)}>
      <IconActivity />
      {hasActivity && <span className="badge" />}
    </button>
  );
  return { button, popover: open && <ActivityPopover onClose={() => setOpen(false)} /> };
}

export const openLibrary = () => ui.set((u) => ({ ...u, view: u.view === 'library' ? 'terminal' : 'library' }));
export const openSettings = () => ui.set((u) => ({ ...u, overlay: 'settings', overlayArg: null }));

function BottomBar() {
  const view = ui.use((s) => s.view);
  const activity = useActivityButton();
  return (
    <div className="sb-bottom">
      <button className={`icon-btn${view === 'library' ? ' on' : ''}`} title="Library" onClick={openLibrary}>
        <IconLibrary />
      </button>
      <SpaceDots />
      {activity.button}
      <button className="icon-btn" title="Settings" onClick={openSettings}>
        <IconGear />
      </button>
      {activity.popover}
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
    <div ref={ref} className="activity-pop">
      <div className="modal-title" style={{ paddingBottom: 8 }}>
        Finished jobs
      </div>
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
