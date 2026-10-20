import { useState } from 'react';
import { app, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { useTabView } from './common.jsx';
import { formatAccel } from '../lib/keys.js';
import { IconPlus, IconFolder, IconFolderOpen } from './icons.jsx';
import { SidebarCards } from './Sidebar.jsx';
import { usePeek, rowMenu, folderMenu } from './sidebar-shared.js';
import { PH, pressTab, pressFolder, useDropList, useDropFolders, destAttr } from './sidebar-drag.js';
import { SpaceTrack } from './space-motion.jsx';

// Compact sidebar: one icon tile per session, folders expand in place. Expanding, search
// and settings live in the top bar.
export default function Rail() {
  const favorites = app.use((s) => s.favorites);
  const bindings = app.use((s) => s.settings.keybindings);
  const dragging = ui.use((s) => !!s.dragging);
  const favs = useDropList(favorites, { section: 'fav' });
  const [tip, setTip] = useState(null);
  const showTip = (e, text) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text, top: r.top + r.height / 2, left: r.right + 10 });
  };
  const tipProps = (text) => ({ onMouseEnter: (e) => showTip(e, text), onMouseLeave: () => setTip(null) });

  return (
    <div className="rail" onMouseLeave={() => setTip(null)}>
      <div className="rail-scroll">
        {favs.length > 0 && (
          <>
            <RailList items={favs} dest={destAttr('fav')} onTip={showTip} onTipEnd={() => setTip(null)} />
            <div className="rail-sep" />
          </>
        )}
        <SpaceTrack render={(space) => <RailBody space={space} bindings={bindings} tipProps={tipProps} onTip={showTip} onTipEnd={() => setTip(null)} />} />
      </div>
      <SidebarCardsCompact />
      {tip && !dragging && (
        <div className="rail-tip" style={{ top: tip.top, left: tip.left }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

// One Space's tiles; the carousel renders neighbouring Spaces with this too while sliding.
function RailBody({ space, bindings, tipProps, onTip, onTipEnd }) {
  const pinned = useDropList(space.pinned, { section: 'pinned', spaceId: space.id });
  const today = useDropList(space.today, { section: 'today', spaceId: space.id });
  const folders = useDropFolders(space);
  return (
    <>
      <div className="rail-space" style={{ color: space.color }} data-drop-into={destAttr('pinned', space.id, null, 0)} {...tipProps(space.name)} onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id }))}>
        {space.glyph}
      </div>
      <RailList items={pinned} dest={destAttr('pinned', space.id)} onTip={onTip} onTipEnd={onTipEnd} />
      {folders.map((f) => (f === PH ? <div key="folder-ph" className="rail-ph folder" data-drop-ph /> : <RailFolder key={f.id} folder={f} spaceId={space.id} tipProps={tipProps} onTip={onTip} onTipEnd={onTipEnd} />))}
      {today.length > 0 && <div className="rail-sep" />}
      <RailList items={today} dest={destAttr('today', space.id)} onTip={onTip} onTipEnd={onTipEnd} />
      <button className="rail-btn new" data-drop-into={destAttr('today', space.id)} onClick={() => A.openTerminal()} {...tipProps(`New terminal  ${formatAccel(bindings.newTerminal)}`)}>
        <IconPlus />
      </button>
      <div className="sb-fill" data-drop-into={destAttr('today', space.id)} />
    </>
  );
}

function RailList({ items, dest, onTip, onTipEnd }) {
  if (!items.length) return null;
  return (
    <div className="rail-list" data-drop-list={dest}>
      {items.map((tid) => (tid === PH ? <div key="rail-ph" className="rail-ph" data-drop-ph /> : <RailTile key={tid} tid={tid} onTip={onTip} onTipEnd={onTipEnd} />))}
    </div>
  );
}

function RailFolder({ folder: f, spaceId, tipProps, onTip, onTipEnd }) {
  const items = useDropList(f.tabs, { section: 'pinned', spaceId, folderId: f.id });
  const into = ui.use((s) => s.dragging?.target?.kind === 'list' && s.dragging.target.folderId === f.id);
  return (
    <div className={`rail-folder${f.open ? ' open' : ''}`}>
      <button
        className={`rail-btn folder${into ? ' drop-into' : ''}`}
        data-folder-head={f.id}
        data-drop-into={destAttr('pinned', spaceId, f.id)}
        data-spring={f.open ? undefined : f.id}
        onPointerDown={(e) => pressFolder(e, spaceId, f.id)}
        onClick={() => A.updateFolder(spaceId, f.id, { open: !f.open })}
        onContextMenu={(e) => folderMenu(e, spaceId, f, () => A.toggleSidebar())}
        {...tipProps(`${f.name} · ${f.tabs.length}`)}
      >
        {f.open ? <IconFolderOpen /> : <IconFolder />}
        {!f.open && f.tabs.length > 0 && <span className="rail-count">{f.tabs.length}</span>}
      </button>
      {f.open && <RailList items={items} dest={destAttr('pinned', spaceId, f.id)} onTip={onTip} onTipEnd={onTipEnd} />}
    </div>
  );
}

function RailTile({ tid, onTip, onTipEnd }) {
  const v = useTabView(tid);
  const on = app.use((s) => A.activeTabId(s) === tid);
  const merge = ui.use((s) => (s.dragging?.target?.tid === tid ? s.dragging.target.kind : null));
  const peek = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const color = { run: 'var(--accent)', ok: 'var(--ok)', fail: 'var(--fail)', bell: 'var(--bell)' }[v.status];
  const label = v.panes.length > 1 ? `${v.panes.length}▦` : v.active?.kind === '>_' ? (v.tab.name || v.name).replace(/^[~/.]+/, '').slice(0, 2) || '>_' : v.active?.kind;
  return (
    <button
      className={`rail-tile${on ? ' on' : ''}${v.danger ? ' danger' : ''}${merge ? ` merge-${merge}` : ''}`}
      data-drag-tid={tid}
      onPointerDown={(e) => pressTab(e, tid)}
      onClick={(e) => !e.shiftKey && A.activateTab(tid)}
      onContextMenu={(e) => rowMenu(e, tid, v)}
      onMouseEnter={(e) => {
        onTip(e, v.name);
        peek.onMouseEnter(e);
      }}
      onMouseLeave={(e) => {
        onTipEnd();
        peek.onMouseLeave(e);
      }}
      onMouseDown={peek.onMouseDown}
    >
      <span className="lbl">{label}</span>
      {color && <span className={`corner${v.status === 'run' ? ' st-run' : ''}`} style={{ background: color }} />}
      {v.bell > 0 && <span className="badge">{v.bell}</span>}
    </button>
  );
}

// Notifications and undo toasts don't fit the rail; show them as a floating card instead.
function SidebarCardsCompact() {
  const has = ui.use((s) => !!(s.notify || s.toast));
  if (!has) return null;
  return (
    <div className="rail-cards">
      <SidebarCards />
    </div>
  );
}
