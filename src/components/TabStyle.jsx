// Icon & color for one session (row context menu → Icon & Color…). Picks apply right
// away, so the sidebar row behind the sheet previews them.
import { useEffect } from 'react';
import * as A from '../state/actions.js';
import { useTabView, Chip } from './common.jsx';
import { SPACE_COLORS } from '../lib/meta.js';
import { Ban } from 'lucide-react';
import { TAB_ICONS } from './tabicons.jsx';

export default function TabStyle({ tid, onClose }) {
  const v = useTabView(tid);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!v) return null;
  const { icon = null, color = null } = v.tab;
  const set = (patch) => A.setTabStyle(tid, patch);

  return (
    <div className="modal ts">
      <div className="modal-title">Icon & color</div>
      <div className="modal-body">
        <div className={`row ts-preview${color ? ' tinted' : ''}`} style={color ? { '--tc': color } : undefined}>
          <Chip kind={v.active?.kind} icon={icon} />
          <span className="name">{v.name}</span>
        </div>
        <div className="ts-label">Icon</div>
        <div className="ts-icons">
          <button className={`ts-icon none${!icon ? ' on' : ''}`} title="No icon" onClick={() => set({ icon: null })}>
            <Ban size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {Object.entries(TAB_ICONS).map(([id, Icon]) => (
            <button key={id} className={`ts-icon${icon === id ? ' on' : ''}`} title={id} onClick={() => set({ icon: id })}>
              <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="ts-label">Color</div>
        <div className="swatches">
          <button className={`swatch ts-nocolor${!color ? ' on' : ''}`} title="No color" onClick={() => set({ color: null })} />
          {SPACE_COLORS.map((c) => (
            <button key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ '--c': c }} onClick={() => set({ color: c })} />
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn left" onClick={() => set({ icon: null, color: null })}>
          Reset
        </button>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
