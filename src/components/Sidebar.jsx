import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { useTabView, StatusMark, Chip, FailTip } from './common.jsx';
import { formatAccel } from '../lib/keys.js';
import { shortName, sessionName, formatDuration } from '../lib/meta.js';
import { tildify } from '../lib/routing.js';
import { highlight } from '../lib/fuzzy.js';
import { findTabs } from '../lib/tabfind.js';
import { IconFolder, IconFolderOpen, IconFolderPlus, IconChevron, IconPlus, IconMore, IconSearch, IconClose } from './icons.jsx';
import Rail from './SidebarRail.jsx';
import { SpaceTrack, useSpaceMotion } from './space-motion.jsx';
import { PANE_MIME, renameFolder, usePeek, closePeek, rowMenu, folderMenu, spaceMenu, newFolder, promptText } from './sidebar-shared.js';
import { PH, pressTab, pressPane, pressFolder, useDropList, useDropFolders, destAttr } from './sidebar-drag.js';

export { promptText };

const RAIL_WIDTH = 68;
const HIDE_SLOP = 8; // px past the right edge before a revealed sidebar starts to hide
const HIDE_DELAY = 150;
const isPaneDrag = (e) => e.dataTransfer.types.includes(PANE_MIME);
let findTickSeen = 0; // last ⌘J press the filter answered, so a remount doesn't steal focus

export default function Sidebar({ floating, onLeave }) {
  const mode = app.use((s) => s.settings.sidebarMode);
  const width = app.use((s) => s.settings.sidebarWidth);
  const [dragW, setDragW] = useState(null);
  const ref = useRef(null);
  const loader = useRef(null);
  const onWheel = useSpaceMotion(loader);
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
      {compact ? <Rail /> : <Expanded />}
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
function Expanded() {
  const favorites = app.use((s) => s.favorites);
  const bindings = app.use((s) => s.settings.keybindings);
  const [paneOver, setPaneOver] = useState(false);
  const [find, setFind] = useState({ query: '', sel: 0 });
  const hits = useTabHits(find.query);
  const finding = !!find.query.trim();
  const sel = Math.min(find.sel, Math.max(0, hits.length - 1)); // sessions can close mid-search
  const setQuery = (query) => setFind({ query, sel: 0 });
  const setSel = (sel) => setFind((f) => ({ ...f, sel }));
  const open = (hit) => {
    setQuery('');
    A.activateTab(hit.tid);
  };
  const everywhere = () => {
    const q = find.query.trim();
    setQuery('');
    ui.set((u) => ({ ...u, overlay: 'commandBar', overlayArg: q }));
  };

  // Panes dragged out of a split (HTML5 drag from the card header) land in Today.
  const dropPane = (e) => {
    const pane = e.dataTransfer.getData(PANE_MIME);
    setPaneOver(false);
    if (!pane) return;
    e.preventDefault();
    A.unsplit(pane);
  };

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
        <TabFind query={find.query} onQuery={setQuery} hits={hits} sel={sel} onSel={setSel} onOpen={open} onEverywhere={everywhere} accel={bindings.findTab} noFavorites={!favorites.length} />
      </div>
      <div className="sb-scroll">
        {finding ? (
          <FindResults query={find.query} hits={hits} sel={sel} onSel={setSel} onOpen={open} onEverywhere={everywhere} accel={bindings.commandBar} />
        ) : (
          <>
            <Favorites ids={favorites} />
            <SpaceTrack render={(space) => <SpaceBody space={space} bindings={bindings} />} />
          </>
        )}
      </div>
      <SidebarCards />
    </div>
  );
}

// One Space's sessions. The carousel renders this for neighbouring Spaces too while sliding.
function SpaceBody({ space, bindings }) {
  const pinned = useDropList(space.pinned, { section: 'pinned', spaceId: space.id });
  const today = useDropList(space.today, { section: 'today', spaceId: space.id });
  const folders = useDropFolders(space);
  const isEmpty = !pinned.length && !space.folders.length;
  const todayEnd = destAttr('today', space.id);
  return (
    <>
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
    </>
  );
}

// ---- Find ----------------------------------------------------------------------------
// Inline session filter: it narrows the sidebar in place rather than opening the command
// bar (the top bar's search covers files, folders and actions). While a session is being
// dragged it doubles as the drop target for Favorites.
function TabFind({ query, onQuery, hits, sel, onSel, onOpen, onEverywhere, accel, noFavorites }) {
  const ref = useRef(null);
  const tick = ui.use((s) => s.tabFind);
  const dragTab = ui.use((s) => s.dragging?.kind === 'tab');
  const hot = ui.use((s) => s.dragging?.target?.section === 'fav');

  useEffect(() => {
    if (tick === findTickSeen) return;
    findTickSeen = tick;
    ref.current?.focus();
    ref.current?.select();
  }, [tick]);

  const backToTerminal = () => {
    ref.current?.blur();
    const sid = A.focusedSid();
    if (sid) A.focusSession(sid);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) onSel((sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[sel]) onOpen(hits[sel]);
      else if (query.trim()) onEverywhere();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) onQuery('');
      else backToTerminal();
    }
  };

  return (
    <label className={`tab-find${query ? ' has-query' : ''}${dragTab ? ' drop-fav' : ''}${hot ? ' drop-into' : ''}`} data-drop-into={dragTab ? destAttr('fav') : undefined}>
      <span className="slash">/</span>
      {dragTab && noFavorites ? (
        <span className="hint">Drop here to add to Favorites</span>
      ) : (
        <input ref={ref} value={query} placeholder="filter sessions" spellCheck={false} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKeyDown} />
      )}
      {query ? (
        <button
          className="clear"
          title="Clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onQuery('');
            ref.current?.focus();
          }}
        >
          <IconClose size={11} />
        </button>
      ) : (
        accel && !dragTab && <kbd>{formatAccel(accel)}</kbd>
      )}
    </label>
  );
}

// Every session in every Space (Favorites first), ranked against the query. Subscribes to
// the stores only while there is a query, so an idle filter costs nothing.
function useTabHits(query) {
  const live = !!query.trim();
  const s = app.use((st) => (live ? st : null));
  const r = rt.use((st) => (live ? st : null));
  const home = ui.use((u) => u.home);
  return useMemo(() => {
    if (!s) return [];
    const items = [];
    const add = (tid, spaceId) => {
      const tab = s.tabs[tid];
      if (!tab) return;
      const sids = collectSids(tab.layout);
      const name = tab.name || sids.map((sid) => sessionName(null, r[sid], home)).join(' · ') || '~';
      const lead = tab.activeSid && sids.includes(tab.activeSid) ? tab.activeSid : sids[0];
      items.push({ tid, name, path: tildify(r[lead]?.cwd || s.sessions[lead]?.cwd, home) || '', spaceId });
    };
    for (const tid of s.favorites) add(tid, null);
    for (const sp of s.spaces) for (const tid of A.tabsOfSpace(sp)) add(tid, sp.id);
    return findTabs(query, items, s.activeSpaceId);
  }, [s, r, home, query]);
}

function FindResults({ query, hits, sel, onSel, onOpen, onEverywhere, accel }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('.find-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!hits.length) {
    return (
      <div className="find-empty">
        <div className="t">No sessions match “{query.trim()}”</div>
        <button className="find-more" onClick={onEverywhere}>
          <IconSearch size={12} />
          <span>Search files, folders & actions</span>
          <kbd>↵</kbd>
        </button>
        {accel && <div className="dim">Command bar · {formatAccel(accel)}</div>}
      </div>
    );
  }
  return (
    <div className="find-results" ref={ref}>
      <div className="today-head">
        {hits.length === 1 ? '1 session' : `${hits.length} sessions`}
        <span className="rule" />
      </div>
      <div className="rows">
        {hits.map((h, i) => (
          <FindRow key={h.tid} hit={h} sel={i === sel} onHover={() => onSel(i)} onOpen={() => onOpen(h)} />
        ))}
      </div>
      <div className="find-keys">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> clear
        </span>
      </div>
    </div>
  );
}

function FindRow({ hit, sel, onHover, onOpen }) {
  const v = useTabView(hit.tid);
  const on = app.use((s) => A.activeTabId(s) === hit.tid);
  // Sessions parked in another Space say where they live.
  const elsewhere = app.use((s) => (hit.spaceId && hit.spaceId !== s.activeSpaceId ? s.spaces.find((x) => x.id === hit.spaceId) : null));
  if (!v) return null;
  const byPath = hit.on === 'path';
  return (
    <div className={`row find-row${on ? ' on' : ''}${sel ? ' sel' : ''}${v.dead ? ' dead' : ''}`} onMouseMove={sel ? undefined : onHover} onMouseDown={(e) => e.preventDefault()} onClick={onOpen}>
      <Chip kind={v.active?.kind} />
      <span className="name">{byPath ? hit.name : <Marked text={hit.name} indices={hit.indices} />}</span>
      {(byPath || elsewhere) && (
        <span className={`where${byPath ? ' path' : ''}`}>
          {elsewhere && (
            <span className="glyph" style={{ color: elsewhere.color }}>
              {elsewhere.glyph}
            </span>
          )}
          {byPath ? <span className="txt">&lrm;<Marked text={hit.path} indices={hit.indices} /></span> : <span className="txt">{elsewhere.name}</span>}
        </span>
      )}
      {v.danger && <span className="prod">PROD</span>}
      <StatusMark status={v.status} bell={v.bell} />
    </div>
  );
}

function Marked({ text, indices }) {
  return highlight(text, indices).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>));
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
  // While a session hovers this row to merge, preview the split it would make.
  const merge = ui.use((s) => (s.dragging?.target?.tid === tid ? s.dragging.target.kind : null));
  const incoming = useTabView(ui.use((s) => (s.dragging?.target?.tid === tid ? s.dragging.tabId : null)));
  const peek = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const segs = merge && incoming ? [...v.panes, ...incoming.panes.map((p) => ({ ...p, incoming: true }))] : v.panes;
  const split = segs.length > 1 && !renaming;
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
        // pane, ✕ closes just that pane, ⌥-drag pulls it out into its own row.
        <span className="segs" title={v.tab.name || undefined}>
          {segs.map((p) =>
            p.incoming ? (
              <span key={p.sid} className={`tab-seg incoming${merge === 'merge' ? ' ready' : ''}`}>
                <Chip kind={p.kind} />
                <span className="name">{p.name}</span>
              </span>
            ) : (
              <span
                key={p.sid}
                className={`tab-seg${on && p.sid === v.tab.activeSid ? ' cur' : ''}`}
                title={v.panes.length > 1 ? `${p.name}  ·  ⌥-drag to pull out` : p.name}
                onPointerDown={(e) => {
                  if (!e.altKey || v.panes.length < 2) return;
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
                {v.panes.length > 1 && (
                  <button
                    className="seg-close"
                    title="Close this pane"
                    onClick={(e) => {
                      e.stopPropagation();
                      A.closePane(p.sid);
                    }}
                  >
                    ✕
                  </button>
                )}
              </span>
            )
          )}
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
      {!split && (
        <button className="close" title="Close" onClick={(e) => (e.stopPropagation(), A.closeTab(tid))}>
          ✕
        </button>
      )}
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

export const openLibrary = () => ui.set((u) => ({ ...u, view: u.view === 'library' ? 'terminal' : 'library' }));
export const openSettings = () => ui.set((u) => ({ ...u, overlay: 'settings', overlayArg: null }));
