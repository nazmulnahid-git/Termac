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
import { useSpaceMotion } from './space-motion.js';
import { PANE_MIME, renameFolder, usePeek, closePeek, rowMenu, folderMenu, spaceMenu, newFolder, promptText } from './sidebar-shared.js';
import { PH, pressTab, pressPane, pressFolder, useDropList, useDropFolders, destAttr } from './sidebar-drag.js';

export { promptText };

const RAIL_WIDTH = 68;
const HIDE_SLOP = 8; // px past the right edge before a revealed sidebar starts to hide
const HIDE_DELAY = 150;
const isPaneDrag = (e) => e.dataTransfer.types.includes(PANE_MIME);

export default function Sidebar({ floating, onLeave }) {
  const mode = app.use((s) => s.settings.sidebarMode);
  const width = app.use((s) => s.settings.sidebarWidth);
  const [dragW, setDragW] = useState(null);
  const ref = useRef(null);
  const loader = useRef(null);
  const onWheel = useSpaceMotion(ref, loader);
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const compact = mode === 'compact' && !floating;

  // A revealed sidebar hides only once the pointer has really moved off to the right.
  // mouseleave can't be trusted for this: Electron fires it over drag regions and the
  // traffic lights, and when a native menu opens, all while the pointer is still on top.
  useEffect(() => {
    if (!floating) return;
    let timer = null;
    const check = (e) => {
      const u = ui.get();
      const r = ref.current?.getBoundingClientRect();
      const out = !!r && e.clientX > r.right + HIDE_SLOP && !u.dragging && !u.prompt;
      if (out && !timer) timer = setTimeout(() => leave.current?.(), HIDE_DELAY);
      else if (!out && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    window.addEventListener('mousemove', check);
    return () => {
      window.removeEventListener('mousemove', check);
      clearTimeout(timer);
    };
  }, [floating]);

  return (
    <aside
      ref={ref}
      className={`sidebar${compact ? ' compact' : ''}${floating ? ' floating' : ''}${dragW != null ? ' resizing' : ''}`}
      style={{ width: compact ? RAIL_WIDTH : (dragW ?? width) }}
      onWheel={onWheel}
      onMouseLeave={closePeek}
    >
      {compact ? <Rail /> : <Expanded onDismiss={floating ? () => leave.current?.() : null} />}
      {/* Swiping past the last Space fills this ring; completing it makes a new Space. */}
      <div className="space-new" ref={loader} aria-hidden="true">
        <svg className="progress" viewBox="0 0 40 40">
          <circle className="track" cx="20" cy="20" r="17" />
          <circle className="ring" cx="20" cy="20" r="17" pathLength="100" />
        </svg>
        <IconPlus size={15} />
        <span className="lbl">New Space</span>
      </div>
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
function Expanded({ onDismiss }) {
  const space = app.use((s) => A.activeSpace(s));
  const favorites = app.use((s) => s.favorites);
  const bindings = app.use((s) => s.settings.keybindings);
  const pinned = useDropList(space.pinned, { section: 'pinned', spaceId: space.id });
  const today = useDropList(space.today, { section: 'today', spaceId: space.id });
  const folders = useDropFolders(space);
  const [paneOver, setPaneOver] = useState(false);

  // Panes dragged out of a split (HTML5 drag from the card header) land in Today.
  const dropPane = (e) => {
    const pane = e.dataTransfer.getData(PANE_MIME);
    setPaneOver(false);
    if (!pane) return;
    e.preventDefault();
    A.unsplit(pane);
  };

  const isEmpty = !pinned.length && !space.folders.length;
  const todayEnd = destAttr('today', space.id);

  return (
    <div
      className={`sb-expanded${paneOver ? ' pane-over' : ''}`}
      onDragOver={(e) => {
        if (!isPaneDrag(e)) return;
        e.preventDefault();
        setPaneOver(true);
      }}
      onDrop={dropPane}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setPaneOver(false)}
    >
      <div className="sb-top">
        <Location bindings={bindings} noFavorites={!favorites.length} />
        {/* Revealed over a hidden sidebar: just put it away again; don't leave focus mode. */}
        <button className="icon-btn" title={onDismiss ? 'Hide sidebar' : `Collapse sidebar  ${formatAccel(bindings.toggleSidebar)}`} onClick={onDismiss || A.toggleSidebar}>
          <IconSidebar />
        </button>
      </div>
      <div className="sb-scroll">
        <Favorites ids={favorites} />
        <div className="space-pane">
          <SpaceHeader space={space} />
          <Section items={pinned} dest={{ section: 'pinned', spaceId: space.id }} />
          {folders.map((f) => (f === PH ? <div key="folder-ph" className="folder-ph" data-drop-ph /> : <Folder key={f.id} folder={f} spaceId={space.id} />))}
          {isEmpty && (
            <div className="pin-empty" data-drop-into={destAttr('pinned', space.id, null, 0)}>
              Drag a session here to keep it in {space.name}
            </div>
          )}
          <TodayHeader space={space} />
          <Section items={today} dest={{ section: 'today', spaceId: space.id }} />
          <button className="row new" data-drop-into={todayEnd} onClick={() => A.openTerminal()}>
            <span className="chip">
              <IconPlus size={11} />
            </span>
            <span className="name">New Terminal</span>
            <kbd>{formatAccel(bindings.newTerminal)}</kbd>
          </button>
          <div className="sb-fill" data-drop-into={todayEnd} />
        </div>
      </div>
      <SidebarCards />
      <BottomBar />
    </div>
  );
}

function Location({ bindings, noFavorites }) {
  const sid = ui.use((s) => s.focusedSid);
  const cwd = rt.use((s) => s[sid]?.cwd);
  const host = rt.use((s) => s[sid]?.dangerHost);
  const home = ui.use((s) => s.home);
  const dragTab = ui.use((s) => s.dragging?.kind === 'tab');
  const hot = ui.use((s) => s.dragging?.target?.section === 'fav');
  return (
    <button
      className={`location${dragTab ? ' drop-fav' : ''}${hot ? ' drop-into' : ''}`}
      title="Search sessions, folders, hosts and actions"
      data-drop-into={dragTab ? destAttr('fav') : undefined}
      onClick={() => ui.set((u) => ({ ...u, overlay: 'commandBar' }))}
    >
      <IconSearch size={14} />
      {dragTab && noFavorites ? <span className="path hint">Drop here to add to Favorites</span> : <span className="path">&lrm;{host || tildify(cwd, home) || '~'}</span>}
      <kbd>{formatAccel(bindings.commandBar)}</kbd>
    </button>
  );
}

function SpaceHeader({ space }) {
  return (
    <div className="sec-title" data-drop-into={destAttr('pinned', space.id, null, 0)} onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id }))}>
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
function Favorites({ ids }) {
  const items = useDropList(ids, { section: 'fav' });
  if (!items.length) return null;
  return (
    <div className="favs" data-drop-list={destAttr('fav')} data-axis="x">
      {items.map((tid) => (tid === PH ? <div key="fav-ph" className="fav-ph" data-drop-ph /> : <FavTile key={tid} tid={tid} />))}
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
    <div className={`fav${on ? ' on' : ''}`} title={v.name} data-drag-tid={tid} onPointerDown={(e) => pressTab(e, tid)} onClick={(e) => !e.shiftKey && A.activateTab(tid)} onContextMenu={(e) => rowMenu(e, tid, v)} {...peek}>
      {shortName(v.tab.name || v.active?.name)}
      <span className={`corner dot6${v.status === 'run' ? ' st-run' : ''}`} style={{ background: color }} />
      {v.bell > 0 && <span className="badge status st-bell">{v.bell}</span>}
    </div>
  );
}

// ---- Rows ----------------------------------------------------------------------------
function Section({ items, dest, indent }) {
  return (
    <div className="rows" data-drop-list={destAttr(dest.section, dest.spaceId, dest.folderId)}>
      {items.map((tid) => (tid === PH ? <div key="row-ph" className={`row-ph${indent ? ' indent' : ''}`} data-drop-ph /> : <Row key={tid} tid={tid} indent={indent} />))}
    </div>
  );
}

function Row({ tid, indent }) {
  const v = useTabView(tid);
  const on = app.use((s) => A.activeTabId(s) === tid);
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const merge = ui.use((s) => (s.dragging?.target?.tid === tid ? s.dragging.target.kind : null));
  const peek = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const split = v.panes.length > 1 && !renaming;
  const click = (e) => {
    if (e.shiftKey) return;
    if (v.status === 'fail' && !on) return A.jumpToFailure(v.fail.sid);
    A.activateTab(tid);
  };
  return (
    <div
      className={`row${on ? ' on' : ''}${indent ? ' indent' : ''}${v.dead ? ' dead' : ''}${split ? ' split' : ''}${merge ? ` merge-${merge}` : ''}`}
      data-drag-tid={tid}
      onPointerDown={(e) => !renaming && pressTab(e, tid)}
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
      {split ? (
        // Arc-style split: one segment per pane on the same line. Click one to focus that
        // pane; ⌥-drag one to pull it out into its own row.
        <span className="segs" title={v.tab.name || undefined}>
          {v.panes.map((p) => (
            <span
              key={p.sid}
              className={`tab-seg${on && p.sid === v.tab.activeSid ? ' cur' : ''}`}
              title={`${p.name}  ·  ⌥-drag to pull out`}
              onPointerDown={(e) => {
                if (!e.altKey) return;
                e.stopPropagation();
                pressPane(e, tid, p.sid);
              }}
              onClick={(e) => {
                if (e.shiftKey) return;
                e.stopPropagation();
                A.focusSession(p.sid);
              }}
            >
              <Chip kind={p.kind} />
              <span className="name">{p.name}</span>
            </span>
          ))}
        </span>
      ) : (
        <Chip kind={v.active?.kind} />
      )}
      {split ? null : renaming ? (
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
      {hover && v.status === 'fail' && !ui.get().peek && !ui.get().dragging && <FailTip rt={v.fail.rt} />}
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
function Folder({ folder, spaceId }) {
  const [editing, setEditing] = useState(renameFolder.id === folder.id);
  const items = useDropList(folder.tabs, { section: 'pinned', spaceId, folderId: folder.id });
  const into = ui.use((s) => s.dragging?.target?.kind === 'list' && s.dragging.target.folderId === folder.id);
  const running = rt.use((s) => {
    const tabs = app.get().tabs;
    return folder.tabs.some((tid) => tabs[tid] && collectSids(tabs[tid].layout).some((sid) => s[sid]?.status === 'run'));
  });

  useEffect(() => {
    if (renameFolder.id === folder.id) renameFolder.id = null;
  }, [folder.id]);

  const toggle = () => A.updateFolder(spaceId, folder.id, { open: !folder.open });

  return (
    <div className="folder-wrap">
      <div
        className={`folder${into ? ' drop-into' : ''}`}
        data-folder-head={folder.id}
        data-drop-into={destAttr('pinned', spaceId, folder.id)}
        data-spring={folder.open ? undefined : folder.id}
        onPointerDown={(e) => !editing && pressFolder(e, spaceId, folder.id)}
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
          {items.length ? (
            <Section items={items} dest={{ section: 'pinned', spaceId, folderId: folder.id }} indent />
          ) : (
            <div className="folder-empty" data-drop-into={destAttr('pinned', spaceId, folder.id, 0)}>
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
  const dragTab = ui.use((s) => s.dragging?.kind === 'tab');
  const hot = ui.use((s) => (s.dragging?.target?.kind === 'space' ? s.dragging.target.spaceId : null));
  return (
    <div className={`space-dots${vertical ? ' vertical' : ''}`}>
      {spaces.map((sp, i) => (
        <button
          key={sp.id}
          className={`space-dot${sp.id === activeId ? ' on' : ''}${hot === sp.id ? ' drop-into' : ''}`}
          data-drop-space={dragTab ? sp.id : undefined}
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
