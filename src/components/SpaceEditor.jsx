import '../styles/spaces-notes.css';
import { useEffect, useRef, useState } from 'react';
import { app, ui, newSpace } from '../state/model.js';
import * as A from '../state/actions.js';
import { SPACE_COLORS, SPACE_GLYPHS } from '../lib/meta.js';
import { expandHome, tildify } from '../lib/routing.js';

const api = window.termac;
const ARCHIVE = [
  [1, '1h'],
  [4, '4h'],
  [12, '12h'],
  [24, '24h'],
  [72, '3 days'],
  [0, 'Never'],
];

function hoursLabel(h) {
  if (!h) return 'never';
  return h % 24 === 0 && h >= 48 ? `${h / 24} days` : `${h}h`;
}

// Create (spaceId null) or edit a Space. App renders the .backdrop behind it.
export default function SpaceEditor({ spaceId, onClose }) {
  const profiles = app.use((s) => s.profiles);
  const spaceCount = app.use((s) => s.spaces.length);
  const defaultHours = app.use((s) => s.settings.archiveAfterH);
  const [form, setForm] = useState(() => initialForm(spaceId));
  const nameRef = useRef(null);
  const editing = !!form.id;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const submit = (e) => {
    e?.preventDefault();
    const name = form.name.trim();
    if (!name) return nameRef.current?.focus();
    const fields = { name, glyph: form.glyph, color: form.color, profileId: form.profileId || null, startDir: form.startDir.trim() || '~', archiveAfterH: form.archiveAfterH };
    if (editing) A.updateSpace(form.id, fields);
    else A.createSpace({ ...newSpace(fields), archiveAfterH: fields.archiveAfterH });
    onClose();
  };

  const chooseDir = async () => {
    const home = ui.get().home;
    const picked = await api.sys.chooseDir(expandHome(form.startDir || '~', home));
    if (picked) set({ startDir: tildify(picked, home) });
  };

  const remove = async () => {
    await A.deleteSpace(form.id);
    if (!app.get().spaces.some((x) => x.id === form.id)) onClose();
  };

  const custom = !SPACE_COLORS.includes(form.color.toLowerCase());

  return (
    <form className="modal se" style={{ '--c': form.color }} onSubmit={submit}>
      <div className="se-strip">
        <span className="g">{form.glyph}</span>
        <span className={`n${form.name.trim() ? '' : ' ph'}`}>{form.name.trim() || (editing ? 'Untitled Space' : 'New Space')}</span>
      </div>
      <div className="modal-body">
        <div className="form">
          <label htmlFor="se-name">Name</label>
          <input id="se-name" ref={nameRef} className="field" value={form.name} placeholder="Work, Side project, Servers…" onChange={(e) => set({ name: e.target.value })} />

          <label>Icon</label>
          <div className="glyphs">
            {SPACE_GLYPHS.map((g) => (
              <button type="button" key={g} className={`glyph-btn${form.glyph === g ? ' on' : ''}`} onClick={() => set({ glyph: g })}>
                {g}
              </button>
            ))}
          </div>

          <label>Color</label>
          <div className="swatches">
            {SPACE_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch${form.color.toLowerCase() === c ? ' on' : ''}`} style={{ '--c': c }} title={c} onClick={() => set({ color: c })} />
            ))}
            <label className={`se-custom${custom ? ' on' : ''}`} title="Custom color">
              +
              <input type="color" value={form.color} onChange={(e) => set({ color: e.target.value })} />
            </label>
          </div>

          <label htmlFor="se-profile">Shell profile</label>
          <select id="se-profile" className="field" value={form.profileId || ''} onChange={(e) => set({ profileId: e.target.value || null })}>
            <option value="">Default profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <label htmlFor="se-dir">Start directory</label>
          <div className="row-inline">
            <input id="se-dir" className="field mono" value={form.startDir} spellCheck={false} placeholder="~" onChange={(e) => set({ startDir: e.target.value })} />
            <button type="button" className="btn" onClick={chooseDir}>
              Choose…
            </button>
          </div>

          <label htmlFor="se-archive">Archive after</label>
          <select id="se-archive" className="field" value={form.archiveAfterH == null ? '' : String(form.archiveAfterH)} onChange={(e) => set({ archiveAfterH: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">Default ({hoursLabel(defaultHours)})</option>
            {ARCHIVE.map(([h, label]) => (
              <option key={h} value={String(h)}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="modal-foot">
        {editing && spaceCount > 1 && (
          <button type="button" className="btn left" style={{ color: 'var(--fail)' }} onClick={remove}>
            Delete Space…
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary" style={{ background: 'color-mix(in oklab, var(--c) 88%, black)', color: '#fff' }}>
          {editing ? 'Save Space' : 'Create Space'}
        </button>
      </div>
    </form>
  );
}

function initialForm(spaceId) {
  const s = app.get();
  const sp = spaceId && s.spaces.find((x) => x.id === spaceId);
  if (sp) return { id: sp.id, name: sp.name, glyph: sp.glyph, color: sp.color, profileId: sp.profileId, startDir: sp.startDir || '~', archiveAfterH: sp.archiveAfterH ?? null };
  // New Space: first color and glyph not already taken.
  const color = SPACE_COLORS.find((c) => !s.spaces.some((x) => x.color.toLowerCase() === c)) || SPACE_COLORS[s.spaces.length % SPACE_COLORS.length];
  const glyph = SPACE_GLYPHS.find((g) => !s.spaces.some((x) => x.glyph === g)) || SPACE_GLYPHS[0];
  return { id: null, name: '', glyph, color, profileId: null, startDir: '~', archiveAfterH: null };
}
