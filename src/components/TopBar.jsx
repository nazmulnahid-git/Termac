// Window-wide top bar (Warp-style). The traffic lights sit in its left inset; the bar
// itself is a window drag region with buttons carved out.
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import { formatAccel } from '../lib/keys.js';
import { IconSidebar, IconFiles, IconGrid, IconSearch, IconReview, IconGear } from './icons.jsx';
import { openSettings } from './Sidebar.jsx';

export default function TopBar() {
  const bindings = app.use((s) => s.settings.keybindings);
  const mode = app.use((s) => s.settings.sidebarMode);
  const tools = ui.use((s) => s.tools);
  const review = ui.use((s) => s.review);
  const overlay = ui.use((s) => s.overlay);
  const sid = ui.use((s) => s.focusedSid);
  const changes = rt.use((s) => s[sid]?.changes);
  const k = (id) => (bindings[id] ? `  ${formatAccel(bindings[id])}` : '');

  return (
    <header className="topbar">
      <div className="tb-group">
        <button className={`tb-btn${mode !== 'hidden' ? ' on' : ''}`} title={`Sidebar${k('toggleSidebar')}`} onClick={() => (mode === 'hidden' ? A.toggleFocusMode() : A.toggleSidebar())}>
          <IconSidebar />
        </button>
        <button className={`tb-btn${tools ? ' on' : ''}`} title={`Project explorer${k('toggleFiles')}`} onClick={() => A.togglePanel(tools && tools !== 'files' ? tools : 'files')}>
          <IconFiles />
        </button>
        <button className={`tb-btn${overlay === 'overview' ? ' on' : ''}`} title="All Spaces" onClick={() => ui.set((u) => ({ ...u, overlay: u.overlay === 'overview' ? null : 'overview' }))}>
          <IconGrid />
        </button>
      </div>
      <button className="tb-search" onClick={() => ui.set((u) => ({ ...u, overlay: 'commandBar', overlayArg: null }))}>
        <IconSearch size={15} />
        <span className="ph">Search sessions, files, folders, actions…</span>
        <kbd>{formatAccel(bindings.commandBar)}</kbd>
      </button>
      <div className="tb-group right">
        <button className={`tb-btn${review ? ' on' : ''}`} title={`Code review${k('toggleReview')}`} onClick={A.toggleReview}>
          <IconReview />
          {changes > 0 && <span className="tb-count">{changes > 99 ? '99+' : changes}</span>}
        </button>
        <button className="tb-btn" title="Settings" onClick={openSettings}>
          <IconGear />
        </button>
      </div>
    </header>
  );
}
