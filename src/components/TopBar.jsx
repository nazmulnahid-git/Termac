// Window title bar over the content column. The expanded sidebar hosts the traffic lights;
// otherwise (`lights`) they sit in this bar's left inset, with the sidebar toggle after them.
// The bar itself is a window drag region with buttons carved out. Like a native toolbar it
// leads with a title (the Space, or the open page) and a quiet subtitle; the search field
// reads like a terminal's title (where you are, what's running) and opens the command bar.
import { app, rt, ui } from '../state/model.js';
import * as A from '../state/actions.js';
import * as L from '../lib/layout.js';
import { formatAccel } from '../lib/keys.js';
import { tildify } from '../lib/routing.js';
import { procLabel } from '../lib/meta.js';
import { IconSidebar, IconGrid, IconGear, IconSearch } from './icons.jsx';
import { openSettings } from './Sidebar.jsx';

export default function TopBar({ lights }) {
  const bindings = app.use((s) => s.settings.keybindings);
  const overlay = ui.use((s) => s.overlay);
  const sid = ui.use((s) => s.focusedSid);
  const r = rt.use((s) => s[sid]);
  const home = ui.use((s) => s.home);
  const space = app.use((s) => A.activeSpace(s));
  const cwd = r?.cwd || app.get().sessions[sid]?.cwd;
  const k = (id) => (bindings[id] ? `  ${formatAccel(bindings[id])}` : '');

  return (
    <header className={`topbar${lights ? ' lights' : ''}`}>
      <div className="tb-group">
        {lights && (
          <button className="tb-btn" title={`Show sidebar${k('toggleSidebar')}`} onClick={A.toggleSidebar}>
            <IconSidebar size={17} />
          </button>
        )}
        <Heading />
      </div>
      <button className="tb-title" title={`Command bar${k('commandBar')}`} onClick={() => ui.set((u) => ({ ...u, overlay: 'commandBar', overlayArg: null }))}>
        <IconSearch size={14} className="tb-ic" />
        {sid && cwd ? (
          <>
            <span className="tb-path">{tildify(cwd, home) || '~'}</span>
            <span className="tb-sep">·</span>
            <span className="tb-proc">{procLabel(r, r?.shell)}</span>
          </>
        ) : (
          <span className="tb-path">{space?.name.toLowerCase()}</span>
        )}
        <kbd>{formatAccel(bindings.commandBar)}</kbd>
      </button>
      <div className="tb-group right">
        <button className={`tb-btn round${overlay === 'overview' ? ' on' : ''}`} title={`All Spaces${k('overview')}`} onClick={() => ui.set((u) => ({ ...u, overlay: u.overlay === 'overview' ? null : 'overview' }))}>
          <IconGrid />
        </button>
        <button className="tb-btn round" title="Settings" onClick={openSettings}>
          <IconGear />
        </button>
      </div>
    </header>
  );
}

// "work" over "4 sessions · 1 running", or the page that covers the terminal.
function Heading() {
  const view = ui.use((s) => s.view);
  const space = app.use((s) => A.activeSpace(s));
  const tids = space ? A.tabsOfSpace(space) : [];
  const running = rt.use((r) => {
    const tabs = app.get().tabs;
    return tids.filter((tid) => tabs[tid] && L.leaves(tabs[tid].layout).some((sid) => r[sid]?.status === 'run')).length;
  });
  const page = { settings: 'Settings', library: 'Library' }[view];
  if (page) {
    return (
      <div className="tb-heading">
        <span className="t">{page}</span>
      </div>
    );
  }
  if (!space) return null;
  const n = tids.length;
  return (
    <div className="tb-heading">
      <span className="t">{space.name}</span>
      <span className="s">
        {n === 1 ? '1 session' : `${n} sessions`}
        {running > 0 && ` · ${running} running`}
      </span>
    </div>
  );
}
