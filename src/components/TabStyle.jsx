// Icon & color for one session (row context menu → Icon & Color…). Picks apply right
// away, so the sidebar row behind the sheet previews them.
import { useEffect, useState } from 'react';
import * as A from '../state/actions.js';
import { useTabView, Chip } from './common.jsx';
import { SPACE_COLORS, SPACE_GLYPHS } from '../lib/meta.js';

const ICONS = [...SPACE_GLYPHS, 'λ', '❯', '#', '$', '⚡', '⚙', '☁', '♥', '∞', '🚀', '🐳', '🔥', '🐍', '📦', '🧪', '🗄️', '🌐', '🔒', '🐛', '🛠️', '📝', '🎯'];

const firstGrapheme = (text) => [...new Intl.Segmenter().segment(text.trim())][0]?.segment || null;

export default function TabStyle({ tid, onClose }) {
  const v = useTabView(tid);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!v) return null;
  const { icon = null, color = null } = v.tab;
  const set = (patch) => A.setTabStyle(tid, patch);
  const custom = icon && !ICONS.includes(icon);

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
            ∅
          </button>
          {ICONS.map((g) => (
            <button key={g} className={`ts-icon${icon === g ? ' on' : ''}`} onClick={() => set({ icon: g })}>
              {g}
            </button>
          ))}
          <input
            className={`field ts-custom${custom ? ' on' : ''}`}
            placeholder="any"
            title="Type or paste any character or emoji"
            spellCheck={false}
            value={typed || (custom ? icon : '')}
            onChange={(e) => {
              setTyped(e.target.value);
              const g = firstGrapheme(e.target.value);
              if (g) set({ icon: g });
            }}
          />
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
