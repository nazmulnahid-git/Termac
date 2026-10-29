// The window's bottom bar, as in Finder or Xcode: the Spaces as tabs (a dot marks one with
// unseen finished jobs) and a button for a new one.
import { app, ui } from '../state/model.js';
import { arrayEq } from '../state/store.js';
import * as A from '../state/actions.js';
import { SpaceGlyph } from './common.jsx';
import { IconPlus } from './icons.jsx';

export default function StatusBar() {
  return (
    <footer className="statusbar">
      <SpaceTabs />
    </footer>
  );
}

// Also the drop targets for moving a dragged session to another Space.
function SpaceTabs() {
  const spaces = app.use((s) => s.spaces);
  const activeId = app.use((s) => s.activeSpaceId);
  const unseen = app.use((s) => [...new Set(s.activity.filter((a) => !a.seen).map((a) => a.spaceId))], arrayEq);
  const dragTab = ui.use((s) => s.dragging?.kind === 'tab');
  const hot = ui.use((s) => (s.dragging?.target?.kind === 'space' ? s.dragging.target.spaceId : null));
  return (
    <div className="sl-spaces">
      {spaces.map((sp, i) => {
        const on = sp.id === activeId;
        const flag = !on && unseen.includes(sp.id);
        return (
          <button
            key={sp.id}
            className={`sl-space${on ? ' on' : ''}${hot === sp.id ? ' drop-into' : ''}`}
            data-drop-space={dragTab ? sp.id : undefined}
            style={{ '--c': sp.color }}
            title={`${sp.name}  ⌃${i + 1}`}
            onClick={() => A.switchSpace(sp.id)}
            onDoubleClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: sp.id }))}
          >
            <SpaceGlyph space={sp} className="g" />
            {sp.name}
            {flag && <span className="flag" />}
          </button>
        );
      })}
      <button className="sl-btn add" title="New Space" onClick={() => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: null }))}>
        <IconPlus size={13} />
      </button>
    </div>
  );
}
