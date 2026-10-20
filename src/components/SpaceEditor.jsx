import '../styles/spaces-notes.css';
import { useEffect, useRef, useState } from 'react';
import { app, ui, newSpace } from '../state/model.js';
import * as A from '../state/actions.js';
import { SPACE_COLORS, SPACE_GLYPHS } from '../lib/meta.js';
import { expandHome, tildify } from '../lib/routing.js';
import { BG_PRESETS, DEFAULT_LOOK, resolveBg, terminalLook } from '../lib/termtheme.js';
import { useImageUrl } from './common.jsx';

const api = window.termac;
const ARCHIVE = [
  [1, '1h'],
  [4, '4h'],
  [12, '12h'],
  [24, '24h'],
  [72, '3 days'],
  [0, 'Never'],
];

const PRESET_BGS = new Set(BG_PRESETS.filter((p) => p.bg && p.bg !== 'tint').map((p) => p.bg.toLowerCase()));
const isCustomBg = (bg) => !!bg && bg !== 'tint' && !PRESET_BGS.has(bg.toLowerCase());
const fileName = (p) => (p ? p.split('/').pop() : '');

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
  const [orig] = useState(() => (form.id ? form.term : null)); // look to restore on cancel
  const termTheme = ui.use((u) => u.termTheme);
  const nameRef = useRef(null);
  const saved = useRef(false);
  const pendingLook = useRef(null);
  const lookTimer = useRef(0);
  const editing = !!form.id;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Editing an existing Space previews the look live on its terminals; sliders are debounced.
  const flushLook = () => {
    clearTimeout(lookTimer.current);
    const p = pendingLook.current;
    pendingLook.current = null;
    if (p && form.id) A.setSpaceLook(form.id, p);
  };
  const setTerm = (patch, slow) => {
    setForm((f) => ({ ...f, term: { ...f.term, ...patch } }));
    if (!form.id) return;
    pendingLook.current = { ...pendingLook.current, ...patch };
    clearTimeout(lookTimer.current);
    if (slow) lookTimer.current = setTimeout(flushLook, 90);
    else flushLook();
  };

  // Any close without saving (Cancel, Esc, backdrop, another overlay) restores the original look.
  useEffect(
    () => () => {
      clearTimeout(lookTimer.current);
      pendingLook.current = null;
      if (orig && !saved.current) A.setSpaceLook(form.id, orig);
    },
    [],
  );

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
    const term = { ...form.term };
    saved.current = true;
    clearTimeout(lookTimer.current);
    pendingLook.current = null;
    if (editing) A.updateSpace(form.id, { ...fields, term });
    else A.createSpace({ ...newSpace(fields), archiveAfterH: fields.archiveAfterH, term });
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

  const chooseImage = async () => {
    const picked = await api.sys.chooseImage();
    if (picked) setTerm({ image: picked });
  };

  const custom = !SPACE_COLORS.includes(form.color.toLowerCase());
  const t = form.term;
  const look = terminalLook({ color: form.color, term: t }, termTheme);
  const preset = BG_PRESETS.find((p) => p.bg === t.bg);
  const bgName = preset ? preset.name : `Custom ${t.bg}`;

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

        <div className="se-sec">Terminal</div>
        <div className="se-term">
          <div className="form">
            <label>Background</label>
            <div>
              <div className="se-bgs">
                {BG_PRESETS.map((p) => {
                  const bg = p.bg === 'tint' ? resolveBg({ bg: 'tint' }, form.color) : p.bg;
                  return <button type="button" key={p.id} className={`se-bg${t.bg === p.bg ? ' on' : ''}${p.bg ? '' : ' def'}`} style={bg ? { '--bg': bg } : undefined} title={p.name} aria-label={p.name} onClick={() => setTerm({ bg: p.bg })} />;
                })}
                <label className={`se-bg se-bg-custom${isCustomBg(t.bg) ? ' on' : ''}`} style={isCustomBg(t.bg) ? { '--bg': t.bg } : undefined} title="Custom color">
                  {isCustomBg(t.bg) ? '' : '+'}
                  <input type="color" value={look.bg} onChange={(e) => setTerm({ bg: e.target.value }, true)} />
                </label>
              </div>
              <div className="se-bgname">{bgName}</div>
            </div>

            <label>Image</label>
            <div className="row-inline se-img">
              {t.image && (
                <span className="se-file ellipsis" title={t.image}>
                  {fileName(t.image)}
                </span>
              )}
              <button type="button" className="btn" onClick={chooseImage}>
                {t.image ? 'Change…' : 'Choose image…'}
              </button>
              {t.image && (
                <button type="button" className="btn" onClick={() => setTerm({ image: null })}>
                  Remove
                </button>
              )}
            </div>

            {t.image && (
              <>
                <label htmlFor="se-dim">Dim</label>
                <div className="se-range">
                  <input id="se-dim" type="range" min={0} max={95} step={1} value={Math.round(t.dim * 100)} onChange={(e) => setTerm({ dim: Number(e.target.value) / 100 }, true)} />
                  <span>{Math.round(t.dim * 100)}%</span>
                </div>
                <label htmlFor="se-blur">Blur</label>
                <div className="se-range">
                  <input id="se-blur" type="range" min={0} max={20} step={1} value={t.blur} onChange={(e) => setTerm({ blur: Number(e.target.value) }, true)} />
                  <span>{t.blur}px</span>
                </div>
              </>
            )}
          </div>
          <TermPreview look={look} />
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

// Fake terminal lines painted with the Space's resolved look.
function TermPreview({ look }) {
  const url = useImageUrl(look.image);
  const x = look.xterm;
  return (
    <div className="se-prev" style={{ background: look.bg, color: x.foreground }}>
      {look.image && url && <div className="se-prev-img" style={{ backgroundImage: `url("${url}")`, filter: look.blur ? `blur(${look.blur / 2}px)` : undefined }} />}
      {look.image && <div className="se-prev-dim" style={{ background: look.bg, opacity: look.dim }} />}
      <div className="se-prev-lines">
        <div>
          <span style={{ color: x.blue }}>~/work/api</span> <span style={{ color: x.magenta }}>main</span> <span style={{ color: x.green }}>❯</span> npm test
        </div>
        <div style={{ color: x.green }}>✓ 42 passing (1.3s)</div>
        <div style={{ color: x.red }}>✗ 1 failing (auth.spec.ts)</div>
        <div style={{ color: x.brightBlack }}>Done in 2.14s</div>
        <div>
          <span style={{ color: x.green }}>❯</span> <i className="se-prev-cur" style={{ background: x.cursor }} />
        </div>
      </div>
    </div>
  );
}

function initialForm(spaceId) {
  const s = app.get();
  const sp = spaceId && s.spaces.find((x) => x.id === spaceId);
  if (sp) return { id: sp.id, name: sp.name, glyph: sp.glyph, color: sp.color, profileId: sp.profileId, startDir: sp.startDir || '~', archiveAfterH: sp.archiveAfterH ?? null, term: { ...DEFAULT_LOOK, ...sp.term } };
  // New Space: first color and glyph not already taken.
  const color = SPACE_COLORS.find((c) => !s.spaces.some((x) => x.color.toLowerCase() === c)) || SPACE_COLORS[s.spaces.length % SPACE_COLORS.length];
  const glyph = SPACE_GLYPHS.find((g) => !s.spaces.some((x) => x.glyph === g)) || SPACE_GLYPHS[0];
  return { id: null, name: '', glyph, color, profileId: null, startDir: '~', archiveAfterH: null, term: { ...DEFAULT_LOOK } };
}
