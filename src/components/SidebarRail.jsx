import { useState } from 'react';
import { app, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { useTabView } from './common.jsx';
import { formatAccel } from '../lib/keys.js';
import { IconSidebar, IconSearch, IconPlus, IconFolder, IconFolderOpen, IconLibrary, IconGear } from './icons.jsx';
import { SpaceDots, SidebarCards, useActivityButton, openLibrary, openSettings } from './Sidebar.jsx';
import { dragStart, dragEnd, usePeek, rowMenu, folderMenu } from './sidebar-shared.js';

// Compact sidebar: one icon tile per session, folders expand in place.
export default function Rail() {
  const space = app.use((s) => A.activeSpace(s));
  const favorites = app.use((s) => s.favorites);
  const bindings = app.use((s) => s.settings.keybindings);
  const view = ui.use((s) => s.view);
  const [tip, setTip] = useState(null);
  const activity = useActivityButton();
  const showTip = (e, text) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text, top: r.top + r.height / 2, left: r.right + 10 });
  };
  const tipProps = (text) => ({ onMouseEnter: (e) => showTip(e, text), onMouseLeave: () => setTip(null) });

  return (
    <div className="rail" onMouseLeave={() => setTip(null)}>
      <div className="rail-head" />
      <button className="rail-btn" onClick={A.toggleSidebar} {...tipProps(`Expand sidebar  ${formatAccel(bindings.toggleSidebar)}`)}>
        <IconSidebar />
      </button>
      <button className="rail-btn" onClick={() => ui.set((u) => ({ ...u, overlay: 'commandBar' }))} {...tipProps(`Search  ${formatAccel(bindings.commandBar)}`)}>
        <IconSearch />
      </button>
      <div className="rail-scroll">
        {favorites.length > 0 && (
          <>
            {favorites.map((tid) => (
              <RailTile key={tid} tid={tid} onTip={showTip} onTipEnd={() => setTip(null)} />
            ))}
            <div className="rail-sep" />
          </>
        )}
        <div className="rail-space" style={{ color: space.color }} {...tipProps(space.name)} onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: space.id }))}>
          {space.glyph}
        </div>
        {space.pinned.map((tid) => (
          <RailTile key={tid} tid={tid} onTip={showTip} onTipEnd={() => setTip(null)} />
        ))}
        {space.folders.map((f) => (
          <div key={f.id} className={`rail-folder${f.open ? ' open' : ''}`}>
            <button className="rail-btn folder" onClick={() => A.updateFolder(space.id, f.id, { open: !f.open })} onContextMenu={(e) => folderMenu(e, space.id, f, () => A.toggleSidebar())} {...tipProps(`${f.name} · ${f.tabs.length}`)}>
              {f.open ? <IconFolderOpen /> : <IconFolder />}
              {!f.open && f.tabs.length > 0 && <span className="rail-count">{f.tabs.length}</span>}
            </button>
            {f.open && f.tabs.map((tid) => <RailTile key={tid} tid={tid} onTip={showTip} onTipEnd={() => setTip(null)} />)}
          </div>
        ))}
        {space.today.length > 0 && <div className="rail-sep" />}
        {space.today.map((tid) => (
          <RailTile key={tid} tid={tid} onTip={showTip} onTipEnd={() => setTip(null)} />
        ))}
        <button className="rail-btn new" onClick={() => A.openTerminal()} {...tipProps(`New terminal  ${formatAccel(bindings.newTerminal)}`)}>
          <IconPlus />
        </button>
      </div>
      <SidebarCardsCompact />
      <div className="rail-bottom">
        <SpaceDots vertical />
        <button className={`rail-btn${view === 'library' ? ' on' : ''}`} onClick={openLibrary} {...tipProps('Library')}>
          <IconLibrary />
        </button>
        {activity.button}
        <button className="rail-btn" onClick={openSettings} {...tipProps('Settings')}>
          <IconGear />
        </button>
      </div>
      {activity.popover}
      {tip && (
        <div className="rail-tip" style={{ top: tip.top, left: tip.left }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function RailTile({ tid, onTip, onTipEnd }) {
  const v = useTabView(tid);
  const on = app.use((s) => A.activeTabId(s) === tid);
  const peek = usePeek(tid, v?.active?.sid, on);
  if (!v) return null;
  const color = { run: 'var(--accent)', ok: 'var(--ok)', fail: 'var(--fail)', bell: 'var(--bell)' }[v.status];
  const label = v.panes.length > 1 ? `${v.panes.length}▦` : v.active?.kind === '>_' ? (v.tab.name || v.name).replace(/^[~/.]+/, '').slice(0, 2) || '>_' : v.active?.kind;
  return (
    <button
      className={`rail-tile${on ? ' on' : ''}${v.danger ? ' danger' : ''}`}
      draggable
      onDragStart={(e) => dragStart(e, tid)}
      onDragEnd={dragEnd}
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
