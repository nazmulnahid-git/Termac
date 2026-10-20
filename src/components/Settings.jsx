import { useEffect, useRef, useState } from 'react';
import '../styles/settings.css';
import { app, ui, defaultProfile } from '../state/model.js';
import * as A from '../state/actions.js';
import { THEMES } from '../term/registry.js';
import { ACTIONS, defaultBindings, eventToAccel, normalizeAccel, formatAccel } from '../lib/keys.js';
import { route, expandHome } from '../lib/routing.js';
import { uid } from '../lib/meta.js';
import { Switch, Seg } from './common.jsx';

const api = window.termac;
const RULE_MIME = 'application/x-termac-rule';

const TABS = [
  ['general', '⚙', 'General'],
  ['appearance', '◐', 'Appearance'],
  ['profiles', '>_', 'Profiles'],
  ['keybindings', '⌘', 'Keybindings'],
  ['gestures', '◎', 'Gestures'],
  ['rules', '⇢', 'Rules'],
];
const ALIASES = { keys: 'keybindings', shortcuts: 'keybindings', routing: 'rules' };
const tabId = (t) => {
  const id = ALIASES[t] || t;
  return TABS.some(([k]) => k === id) ? id : null;
};

export default function Settings({ onClose, initialTab }) {
  const [tab, setTab] = useState(() => tabId(initialTab) || 'general');
  const sheet = useRef(null);

  useEffect(() => {
    const t = tabId(initialTab);
    if (t) setTab(t);
  }, [initialTab]);

  // Take focus away from the terminal so keys don't reach the shell.
  useEffect(() => sheet.current?.focus(), []);

  // Bubble phase: shortcut recorders listen in capture phase and preventDefault, so Esc
  // while recording cancels the recording instead of closing the sheet.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const label = TABS.find(([k]) => k === tab)[2];
  return (
    <div className="modal st-sheet" role="dialog" aria-label="Settings" tabIndex={-1} ref={sheet}>
      <div className="st-head">
        <div className="st-titlebar">
          <span className="st-title">{label}</span>
          <button className="btn st-done" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="st-tabs">
          {TABS.map(([k, icon, name]) => (
            <button key={k} className={`st-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
              <span className={`st-tab-ic${k === 'profiles' ? ' mono' : ''}`}>{icon}</span>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className={`st-body st-body-${tab}`}>
        {tab === 'general' && <GeneralTab />}
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'profiles' && <ProfilesTab />}
        {tab === 'keybindings' && <KeysTab />}
        {tab === 'gestures' && <GesturesTab />}
        {tab === 'rules' && <RulesTab />}
      </div>
    </div>
  );
}

// ---- Shared bits ----------------------------------------------------------------------

function Group({ title, children }) {
  return (
    <>
      {title && <div className="st-group-title">{title}</div>}
      <div className="st-group">{children}</div>
    </>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="st-row">
      <div className="st-label">
        {label}
        {hint && <div className="st-hint">{hint}</div>}
      </div>
      <div className="st-ctl">{children}</div>
    </div>
  );
}

// Native select over arbitrary (number/string) values; keeps an unknown current value selectable.
function Select({ value, options, onChange, className = '' }) {
  const opts = options.some(([v]) => v === value) ? options : [...options, [value, String(value)]];
  return (
    <select className={`field ${className}`} value={String(value)} onChange={(e) => onChange(opts.find(([v]) => String(v) === e.target.value)[0])}>
      {opts.map(([v, l]) => (
        <option key={String(v)} value={String(v)}>
          {l}
        </option>
      ))}
    </select>
  );
}

// Text input that keeps a local draft and commits debounced, on blur, and on unmount, so
// typing doesn't write the persisted store on every keystroke.
function DraftInput({ value, onCommit, onDraft, delay = 300, as: Tag = 'input', ...rest }) {
  const [v, setV] = useState(value ?? '');
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const pending = useRef(null);
  const timer = useRef(0);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current && pending.current == null) setV(value ?? '');
  }, [value]);

  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current == null) return;
    const x = pending.current;
    pending.current = null;
    commit.current(x);
  };
  useEffect(() => flush, []);

  return (
    <Tag
      {...rest}
      value={v}
      onChange={(e) => {
        const x = e.target.value;
        setV(x);
        onDraft?.(x);
        pending.current = x;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, delay);
      }}
      onFocus={(e) => {
        focused.current = true;
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        flush();
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && Tag === 'input') flush();
        rest.onKeyDown?.(e);
      }}
    />
  );
}

const setSetting = (key) => (v) => A.setSettings({ [key]: v });

// Captures the next key combo while `active`. Capture phase + preventDefault keeps it from
// reaching App's shortcut handler and the sheet's Esc-to-close.
function useKeyCapture(active, onKey) {
  const cb = useRef(onKey);
  cb.current = onKey;
  useEffect(() => {
    if (!active) return;
    const fn = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mod = e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;
      if (!mod && e.key === 'Escape') return cb.current('cancel');
      if (!mod && (e.key === 'Backspace' || e.key === 'Delete')) return cb.current('clear');
      const a = eventToAccel(e);
      // A shortcut needs a modifier (except F-keys) or it would eat normal typing.
      if (!a || (!(e.ctrlKey || e.altKey || e.metaKey) && !/^F\d+$/.test(e.key))) return;
      cb.current('set', normalizeAccel(a));
    };
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, [active]);
}

// Registers the global Quick Terminal hotkey; restores the previous one if it's taken.
async function applyHotkey(accel, prev) {
  if (!api?.app?.setHotkey) return true;
  const ok = await api.app.setHotkey(accel || '');
  if (ok === false) {
    if (prev) await api.app.setHotkey(prev);
    return false;
  }
  return true;
}

async function saveBindings(patch) {
  const cur = app.get().settings.keybindings;
  if ('quickTerminal' in patch && (patch.quickTerminal || '') !== (cur.quickTerminal || '')) {
    if (!(await applyHotkey(patch.quickTerminal, cur.quickTerminal))) return false;
  }
  A.setSettings({ keybindings: { ...app.get().settings.keybindings, ...patch } });
  return true;
}

function Keycap({ accel, recording, onClick, onBlur, empty = '—' }) {
  return (
    <button className={`st-kbd${recording ? ' rec' : ''}${accel ? '' : ' none'}`} onClick={onClick} onBlur={onBlur}>
      {recording ? 'Press keys…' : formatAccel(accel) || empty}
    </button>
  );
}

// ---- General --------------------------------------------------------------------------

function GeneralTab() {
  const s = app.use((st) => st.settings);
  return (
    <div className="st-stack">
      <Group>
        <Row label="On launch">
          <Select value={s.onLaunch} onChange={setSetting('onLaunch')} options={[['restore', 'Restore all Spaces and sessions'], ['fresh', 'Start fresh — keeps pinned']]} />
        </Row>
        <Row label="New terminals open in">
          <Select value={s.newTerminalDir} onChange={setSetting('newTerminalDir')} options={[['current', "Current session's directory"], ['space', 'Space start directory'], ['home', 'Home']]} />
        </Row>
        <Row label="Quick Terminal hotkey">
          <HotkeyRecorder accel={s.keybindings.quickTerminal} />
        </Row>
      </Group>
      <Group>
        <Row label="Archive unpinned sessions after">
          <Select value={s.archiveAfterH} onChange={setSetting('archiveAfterH')} options={[[1, '1 hour idle'], [4, '4 hours idle'], [12, '12 hours idle'], [24, '24 hours idle'], [72, '3 days idle'], [0, 'Never']]} />
        </Row>
        <Row label="Keep Library history for">
          <Select value={s.libraryDays} onChange={setSetting('libraryDays')} options={[[30, '30 days'], [90, '90 days'], [365, '365 days'], [0, 'Forever']]} />
        </Row>
        <Row label="Never archive sessions with running processes">
          <Switch on={s.neverArchiveRunning} onChange={setSetting('neverArchiveRunning')} />
        </Row>
      </Group>
      <Group>
        <Row label="Notify when a command finishes after">
          <Select value={s.notifyAfterS} onChange={setSetting('notifyAfterS')} options={[[10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [0, 'Never']]} />
        </Row>
        <Row label="Also send a macOS notification">
          <Select value={s.osNotify} onChange={setSetting('osNotify')} options={[['always', 'Always'], ['background', 'Only when Termac is in background'], ['never', 'Never']]} />
        </Row>
        <Row label="Confirm quit with running processes">
          <Switch on={s.confirmQuit} onChange={setSetting('confirmQuit')} />
        </Row>
        <Row label="Use ⌥ as Meta key" hint="Sends Esc-prefixed keys to the shell instead of typing special characters.">
          <Switch on={s.optionAsMeta} onChange={setSetting('optionAsMeta')} />
        </Row>
      </Group>
    </div>
  );
}

function HotkeyRecorder({ accel }) {
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState(false);
  useKeyCapture(rec, async (kind, a) => {
    setRec(false);
    if (kind === 'cancel') return;
    setErr(!(await saveBindings({ quickTerminal: kind === 'clear' ? '' : a })));
  });
  return (
    <span className="row-inline">
      {err && <span className="st-err">Shortcut unavailable</span>}
      <Keycap
        accel={accel}
        recording={rec}
        empty="Off"
        onClick={() => {
          setErr(false);
          setRec(!rec);
        }}
        onBlur={() => setRec(false)}
      />
    </span>
  );
}

// ---- Appearance -----------------------------------------------------------------------

const FONTS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Hack', 'Source Code Pro'];

function AppearanceTab() {
  const s = app.use((st) => st.settings);
  const theme = ui.use((u) => u.termTheme);
  const [font, setFont] = useState(null); // live draft for the preview
  const t = THEMES[theme] || THEMES.dark;
  const clamp = (lo, hi, def) => (x) => {
    const n = parseFloat(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };

  return (
    <div className="st-stack">
      <div className="st-preview" style={{ background: t.background, color: t.foreground, fontFamily: `${font ?? s.fontFamily}, monospace`, fontSize: s.fontSize, lineHeight: s.lineHeight }}>
        <div>
          <span style={{ color: t.green }}>❯</span> kubectl get pods -n staging
        </div>
        <div style={{ color: t.brightBlack }}>NAME                      READY   STATUS</div>
        <div>
          api-7d9c6b9f5-2xkqp       1/1     <span style={{ color: t.green }}>Running</span>
        </div>
        <div>
          worker-5f8d77c4c-1p4mz    0/1     <span style={{ color: t.yellow }}>Pending</span>
        </div>
        <div>
          <span style={{ color: t.green }}>❯</span> <span className={`st-cursor ${s.cursorStyle}${s.cursorBlink ? ' blink' : ''}`} style={{ '--cur': t.cursor }} />
        </div>
      </div>
      <Group>
        <Row label="Font" hint="Only installed fonts are used; others fall back to SF Mono.">
          <span className="row-inline">
            <DraftInput className="field st-font" list="st-fonts" value={s.fontFamily} spellCheck={false} onDraft={setFont} onCommit={(v) => {
                setFont(null);
                A.setSettings({ fontFamily: v.trim() || 'SF Mono, Menlo, monospace' });
              }} delay={600} />
            <datalist id="st-fonts">
              {FONTS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <label className="st-unit">
              <DraftInput className="field st-num" type="number" min={9} max={28} step={1} value={s.fontSize} onCommit={(v) => A.setSettings({ fontSize: Math.round(clamp(9, 28, 13)(v)) })} />
              pt
            </label>
            <label className="st-unit">
              Line
              <DraftInput className="field st-num" type="number" min={1} max={2} step={0.05} value={s.lineHeight} onCommit={(v) => A.setSettings({ lineHeight: clamp(1, 2, 1.35)(v) })} />
            </label>
          </span>
        </Row>
        <Row label="Cursor">
          <span className="row-inline">
            <Seg value={s.cursorStyle} onChange={setSetting('cursorStyle')} options={[['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']]} />
            <span className="dim">Blink</span>
            <Switch on={s.cursorBlink} onChange={setSetting('cursorBlink')} />
          </span>
        </Row>
        <Row label="Terminal theme">
          <Seg value={s.termTheme} onChange={setSetting('termTheme')} options={[['system', 'Follow system'], ['dark', 'Dark'], ['light', 'Light']]} />
        </Row>
        <Row label="Scrollback lines">
          <Select value={s.scrollback} onChange={setSetting('scrollback')} options={[[1000, '1,000'], [5000, '5,000'], [10000, '10,000'], [50000, '50,000']]} />
        </Row>
      </Group>
    </div>
  );
}

// ---- Profiles -------------------------------------------------------------------------

function updateProfile(id, patch) {
  const s = app.get();
  const next = s.profiles.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p));
  A.setProfiles(next, s.defaultProfileId);
}

function ProfilesTab() {
  const profiles = app.use((s) => s.profiles);
  const defId = app.use((s) => s.defaultProfileId);
  const [selId, setSelId] = useState(defId);
  const sel = profiles.find((p) => p.id === selId) || profiles[0];

  const add = () => {
    const p = { ...defaultProfile(), id: uid('pf'), name: 'New profile' };
    A.setProfiles([...app.get().profiles, p], app.get().defaultProfileId);
    setSelId(p.id);
  };

  return (
    <div className="st-prof">
      <div className="st-prof-list">
        {profiles.map((p) => (
          <button key={p.id} className={`st-prof-item${p.id === sel?.id ? ' on' : ''}`} onClick={() => setSelId(p.id)}>
            <span className="ellipsis grow">{p.name || 'Untitled'}</span>
            {p.id === defId && <span className="st-badge">default</span>}
          </button>
        ))}
        <button className="st-prof-item st-new" onClick={add}>
          + New profile
        </button>
      </div>
      {sel && <ProfileEditor key={sel.id} profile={sel} isDefault={sel.id === defId} canDelete={profiles.length > 1} onDeleted={(id) => setSelId(id)} />}
    </div>
  );
}

function ProfileEditor({ profile: p, isDefault, canDelete, onDeleted }) {
  const spaces = app.use((s) => s.spaces);
  const home = ui.use((u) => u.home);
  const up = (patch) => updateProfile(p.id, patch);
  const usedBy = spaces.filter((sp) => sp.profileId === p.id || (isDefault && !sp.profileId));

  const setEnv = (i, j, val) =>
    up((cur) => ({
      env: cur.env.map((kv, k) => (k === i ? (j === 0 ? [val, kv[1]] : [kv[0], val]) : kv)),
    }));

  const choose = async () => {
    const dir = await api?.sys?.chooseDir(expandHome(p.cwd, home) || home);
    if (dir) up({ cwd: dir, cwdMode: 'custom' });
  };

  const remove = async () => {
    if (api?.sys?.confirm && !(await api.sys.confirm({ message: `Delete profile “${p.name}”?`, detail: 'Spaces and rules using it fall back to the default profile.', ok: 'Delete' }))) return;
    const s = app.get();
    const rest = s.profiles.filter((x) => x.id !== p.id);
    if (!rest.length) return;
    const def = s.defaultProfileId === p.id ? rest[0].id : s.defaultProfileId;
    for (const sp of s.spaces) if (sp.profileId === p.id) A.updateSpace(sp.id, { profileId: null });
    if (s.rules.some((r) => r.profileId === p.id)) A.setRules(s.rules.map((r) => (r.profileId === p.id ? { ...r, profileId: null } : r)));
    A.setProfiles(rest, def);
    onDeleted(def);
  };

  return (
    <div className="st-prof-edit">
      <div className="form st-form">
        <label>Name</label>
        <DraftInput className="field" value={p.name} onCommit={(v) => up({ name: v })} />

        <label>Command</label>
        <DraftInput className="field mono" value={p.command} placeholder="Login shell ($SHELL -l)" spellCheck={false} onCommit={(v) => up({ command: v })} />

        <label>Working directory</label>
        <div className="row-inline">
          <Select value={p.cwdMode} onChange={(v) => up({ cwdMode: v })} options={[['space', 'Space default (from Space settings)'], ['home', 'Home'], ['custom', 'Custom']]} />
          {p.cwdMode === 'custom' && (
            <>
              <DraftInput className="field mono grow" value={p.cwd} placeholder="~/path" spellCheck={false} onCommit={(v) => up({ cwd: v })} />
              <button className="btn" onClick={choose}>
                Choose…
              </button>
            </>
          )}
        </div>

        <label className="st-top">Environment</label>
        <div>
          <div className="st-env">
            <div className="st-env-head">
              <span>KEY</span>
              <span>VALUE</span>
            </div>
            {p.env.map(([k, v], i) => (
              <div className="st-env-row" key={i}>
                <DraftInput className="st-env-in mono" value={k} placeholder="NAME" spellCheck={false} onCommit={(x) => setEnv(i, 0, x.trim())} />
                <DraftInput className="st-env-in mono" value={v} placeholder="value" spellCheck={false} onCommit={(x) => setEnv(i, 1, x)} />
                <button className="st-x" title="Remove" onClick={() => up((cur) => ({ env: cur.env.filter((_, k2) => k2 !== i) }))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="st-link" onClick={() => up((cur) => ({ env: [...cur.env, ['', '']] }))}>
              + Add variable
            </button>
          </div>
          <div className="st-hint">
            <span className="mono">$space</span> expands to the Space name.
          </div>
        </div>

        <label className="st-top">Start commands</label>
        <DraftInput as="textarea" className="field mono st-startup" rows={4} value={p.startup} placeholder="# runs before the first prompt" spellCheck={false} onCommit={(v) => up({ startup: v })} />

        <label>Used by</label>
        <div className="st-chips">
          {usedBy.length ? (
            usedBy.map((sp) => (
              <span key={sp.id} className="st-space-chip" style={{ '--c': sp.color }}>
                <i>{sp.glyph}</i>
                {sp.name}
              </span>
            ))
          ) : (
            <span className="dim">No Spaces</span>
          )}
        </div>
      </div>
      <div className="st-prof-foot">
        <button className="btn" disabled={isDefault} onClick={() => A.setProfiles(app.get().profiles, p.id)}>
          {isDefault ? 'Default profile' : 'Set as default'}
        </button>
        <span className="grow" />
        <button className="btn" disabled={!canDelete} onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ---- Keybindings ----------------------------------------------------------------------

const EDIT_KEYS = new Set(['Cmd+A', 'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+Z', 'Shift+Cmd+Z']);
const actionLabel = (id) => ACTIONS.find((a) => a.id === id)?.label || id;

function KeysTab() {
  const kb = app.use((s) => s.settings.keybindings);
  const shellPriority = app.use((s) => s.settings.shellPriority);
  const [q, setQ] = useState('');
  const [qAccel, setQAccel] = useState(null);
  const [rec, setRec] = useState(null); // action id being recorded
  const [conflict, setConflict] = useState(null); // { id, accel, other }
  const [err, setErr] = useState(null); // action id whose shortcut couldn't be registered

  const commit = async (id, patch) => {
    setConflict(null);
    const ok = await saveBindings(patch);
    setErr(ok ? null : id);
  };

  useKeyCapture(!!rec, (kind, accel) => {
    const id = rec;
    setRec(null);
    if (kind === 'cancel') return;
    if (kind === 'clear') return commit(id, { [id]: '' });
    const other = ACTIONS.find((a) => a.id !== id && normalizeAccel(kb[a.id] || '') === accel);
    if (other) setConflict({ id, accel, other: other.id });
    else commit(id, { [id]: accel });
  });

  const onSearchKey = (e) => {
    if (e.key === 'Backspace' && !q && qAccel) return setQAccel(null);
    if (!(e.ctrlKey || e.altKey || e.metaKey)) return;
    const a = eventToAccel(e);
    if (!a) return;
    const n = normalizeAccel(a);
    if (EDIT_KEYS.has(n)) return;
    e.preventDefault();
    e.stopPropagation();
    setQAccel(n);
    setQ('');
  };

  const needle = q.trim().toLowerCase();
  const list = ACTIONS.filter((a) => (!needle || a.label.toLowerCase().includes(needle)) && (!qAccel || normalizeAccel(kb[a.id] || '') === qAccel));

  const reset = async () => {
    if (api?.sys?.confirm && !(await api.sys.confirm({ message: 'Reset all shortcuts to their defaults?', ok: 'Reset' }))) return;
    setConflict(null);
    commit('quickTerminal', defaultBindings());
  };

  return (
    <div className="st-stack">
      <div className="st-search">
        <span className="dim">⌕</span>
        {qAccel && (
          <button className="st-kbd st-qaccel" title="Clear" onClick={() => setQAccel(null)}>
            {formatAccel(qAccel)} ✕
          </button>
        )}
        <input className="grow" value={q} placeholder={qAccel ? 'Filter…' : 'Search actions or press a shortcut'} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} spellCheck={false} />
      </div>
      <div className="st-group st-keys">
        {list.map((a) => (
          <div key={a.id}>
            <div className={`st-row st-krow${rec === a.id ? ' rec' : ''}`}>
              <div className="st-label">
                {a.label}
                {a.global && <span className="st-badge">global</span>}
              </div>
              {err === a.id && <span className="st-err">Shortcut unavailable</span>}
              <Keycap
                accel={kb[a.id]}
                recording={rec === a.id}
                onClick={() => {
                  setErr(null);
                  setConflict(null);
                  setRec(rec === a.id ? null : a.id);
                }}
                onBlur={() => setRec((r) => (r === a.id ? null : r))}
              />
            </div>
            {conflict?.id === a.id && (
              <div className="st-conflict">
                <span className="grow">
                  <b>{formatAccel(conflict.accel)}</b> is already used by <b>{actionLabel(conflict.other)}</b>.
                </span>
                <button className="btn" onClick={() => commit(a.id, { [a.id]: conflict.accel, [conflict.other]: kb[a.id] || '' })}>
                  Swap
                </button>
                <button className="btn" onClick={() => commit(a.id, { [a.id]: conflict.accel, [conflict.other]: '' })}>
                  Clear other
                </button>
                <button className="btn" onClick={() => setConflict(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
        {!list.length && <div className="st-empty">No matching actions</div>}
      </div>
      <Group>
        <Row label="Shell takes priority" hint="Shortcuts that conflict with your shell (e.g. ⌃R) are passed through unless “Shell takes priority” is on.">
          <Switch on={shellPriority} onChange={setSetting('shellPriority')} />
        </Row>
      </Group>
      <div className="st-foot-row">
        <span className="dim">Click a shortcut to change it · Backspace clears · Esc cancels</span>
        <button className="btn" onClick={reset}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

// ---- Gestures -------------------------------------------------------------------------

const D = () => <i className="st-dot" />;

const GESTURES = [
  { key: 'swipeSpaces', title: 'Switch Space', sub: 'Two-finger swipe on sidebar', art: (<><span>←</span><D /><D /><span>→</span></>) },
  { key: 'pinch', title: 'All Spaces', sub: 'Pinch out · pinch in to return', art: (<><span className="st-diag"><span>↙</span><D /><span>↗</span></span></>) },
  { key: null, title: 'Scrollback', sub: 'Two-finger scroll in terminal', art: (<span className="st-vert"><span>↑</span><span className="row-inline"><D /><D /></span><span>↓</span></span>), always: true },
  { key: 'edgeReveal', title: 'Reveal sidebar', sub: 'Hover the left edge when hidden', art: (<><b className="st-edge" /><D /><D /><span>→</span></>) },
  { key: 'peek', title: 'Peek session', sub: 'Hover a sidebar row', art: <i className="st-dot big" /> },
  { key: null, title: 'Copy last output', sub: 'Three-finger tap', art: (<span className="st-vert"><span className="row-inline"><D /><D /><D /></span><small>tap</small></span>), accel: 'copyLastOutput' },
];

function GesturesTab() {
  const g = app.use((s) => s.settings.gestures);
  const copyAccel = app.use((s) => s.settings.keybindings.copyLastOutput);
  const set = (key, v) => A.setSettings({ gestures: { ...app.get().settings.gestures, [key]: v } });
  return (
    <div className="st-gestures">
      {GESTURES.map((x) => (
        <div key={x.title} className="st-gcard">
          <div className="st-gart">{x.art}</div>
          <div className="st-gmeta">
            <div className="grow">
              <div className="st-gtitle">{x.title}</div>
              <div className="st-gsub">
                {x.sub}
                {x.accel && copyAccel ? ` · or ${formatAccel(copyAccel)}` : ''}
              </div>
            </div>
            {x.key && <Switch on={!!g[x.key]} onChange={(v) => set(x.key, v)} />}
            {x.always && (
              <span className="st-disabled" title="Always on">
                <Switch on onChange={() => {}} />
              </span>
            )}
            {x.accel && <span className="st-kbd static">{formatAccel(copyAccel) || '—'}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Rules ----------------------------------------------------------------------------

const TRIGGERS = [
  ['dir', 'a terminal opens in'],
  ['ssh', 'I SSH to'],
  ['command', 'the command starts with'],
];
const PLACEHOLDER = { dir: '~/work/*', ssh: '*.prod.company.com', command: 'docker compose up' };
const EFFECTS = [
  ['danger', 'Red danger frame'],
  ['confirmPaste', 'Confirm multi-line paste'],
  ['noArchive', 'Never auto-archive'],
];
const SHORT_EFFECT = { danger: 'DANGER FRAME', confirmPaste: 'CONFIRM PASTE', noArchive: 'NO ARCHIVE' };

function mutRule(id, fn) {
  A.setRules(app.get().rules.map((r) => (r.id === id ? { ...r, ...fn(r) } : r)));
}

function testContext(input, home) {
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith('ssh ')) return { command: v };
  if (v.startsWith('/') || v.startsWith('~')) return { cwd: expandHome(v, home) };
  return { command: v };
}

function RulesTab() {
  const rules = app.use((s) => s.rules);
  const hits = app.use((s) => s.ruleHits);
  const spaces = app.use((s) => s.spaces);
  const profiles = app.use((s) => s.profiles);
  const home = ui.use((u) => u.home);
  const [arm, setArm] = useState(null); // rule id whose handle is pressed (enables drag)
  const [drop, setDrop] = useState(null); // { id, after }
  const [fresh, setFresh] = useState(null);
  const [test, setTest] = useState('');

  const ctx = testContext(test, home);
  const result = ctx ? route(rules, ctx, home) : null;

  const add = () => {
    const s = app.get();
    const r = {
      id: uid('rule'),
      enabled: true,
      trigger: { type: 'dir', pattern: '' },
      action: { type: 'space', spaceId: s.activeSpaceId },
      profileId: null,
      effects: { danger: false, confirmPaste: false, noArchive: false },
    };
    A.setRules([...s.rules, r]);
    setFresh(r.id);
  };

  const move = (from, to) => {
    const list = [...app.get().rules];
    if (from < 0 || to < 0 || to >= list.length || from === to) return;
    const [r] = list.splice(from, 1);
    list.splice(to, 0, r);
    A.setRules(list);
  };

  const onDrop = (e, targetId) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(RULE_MIME);
    const d = drop;
    setDrop(null);
    setArm(null);
    if (!id || !d || id === targetId) return;
    const list = app.get().rules;
    const from = list.findIndex((r) => r.id === id);
    let to = list.findIndex((r) => r.id === targetId) + (d.after ? 1 : 0);
    if (from < to) to--;
    move(from, to);
  };

  return (
    <div className="st-rules">
      <div className="st-rules-head">
        <div className="grow">
          <div className="st-h">Routing rules</div>
          <div className="dim">Checked top to bottom when a session opens. First match wins.</div>
        </div>
        <button className="btn primary" onClick={add}>
          + Add rule
        </button>
      </div>

      <div className="st-rule-list">
        {rules.map((r, i) => (
          <RuleCard
            key={r.id}
            rule={r}
            index={i}
            count={rules.length}
            hits={hits[r.id] || 0}
            spaces={spaces}
            profiles={profiles}
            matched={result?.rule.id === r.id}
            autoFocus={fresh === r.id}
            armed={arm === r.id}
            setArm={setArm}
            drop={drop?.id === r.id ? (drop.after ? 'after' : 'before') : null}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(RULE_MIME)) return;
              e.preventDefault();
              const b = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > b.top + b.height / 2;
              if (drop?.id !== r.id || drop.after !== after) setDrop({ id: r.id, after });
            }}
            onDrop={(e) => onDrop(e, r.id)}
            onDragEnd={() => {
              setArm(null);
              setDrop(null);
            }}
            onMove={(delta) => move(i, i + delta)}
          />
        ))}
        {!rules.length && <div className="st-empty">No rules yet — new sessions open in the current Space.</div>}
      </div>

      <div className="st-test">
        <div className="st-h">Test a rule</div>
        <div className="row-inline">
          <input className="field mono grow" value={test} placeholder="ssh deploy@web-01.prod.company.com  or  ~/work/api" spellCheck={false} onChange={(e) => setTest(e.target.value)} />
          <TestResult result={ctx ? result : undefined} spaces={spaces} />
        </div>
      </div>
    </div>
  );
}

function TestResult({ result, spaces }) {
  if (result === undefined) return <span className="st-test-res dim">Type a command or a path</span>;
  if (!result) return <span className="st-test-res dim">No rule matches — opens in the current Space</span>;
  const { rule, index } = result;
  const sp = rule.action.type === 'space' && spaces.find((s) => s.id === rule.action.spaceId);
  return (
    <span className="st-test-res">
      <span className="dim">→</span>
      {rule.action.type === 'space' ? (
        <b className="st-space-name" style={{ '--c': sp?.color }}>
          <i>{sp?.glyph || '◆'}</i>
          {sp?.name || 'Missing Space'}
        </b>
      ) : (
        <b>Split {rule.action.edge === 'down' ? 'down' : 'right'} of current</b>
      )}
      {EFFECTS.filter(([k]) => rule.effects?.[k]).map(([k]) => (
        <span key={k} className={`st-eff-tag${k === 'danger' ? ' danger' : ''}`}>
          {SHORT_EFFECT[k]}
        </span>
      ))}
      <span className="dim">rule {index + 1}</span>
    </span>
  );
}

function RuleCard({ rule: r, index, count, hits, spaces, profiles, matched, autoFocus, armed, setArm, drop, onDragOver, onDrop, onDragEnd, onMove }) {
  const [showFx, setShowFx] = useState(false);
  const fx = r.effects || {};
  const anyFx = EFFECTS.some(([k]) => fx[k]);
  const actionValue = r.action?.type === 'split' ? `split:${r.action.edge === 'down' ? 'down' : 'right'}` : `space:${r.action?.spaceId || ''}`;
  const sp = r.action?.type === 'space' && spaces.find((s) => s.id === r.action.spaceId);
  const actionOpts = [
    ...spaces.map((s) => [`space:${s.id}`, `${s.glyph} ${s.name}`]),
    ...(r.action?.type === 'space' && !sp ? [[actionValue, 'Missing Space']] : []),
    ['split:right', 'Split right of current'],
    ['split:down', 'Split down of current'],
  ];
  const profOpts = [['', 'Space default'], ...profiles.map((p) => [p.id, p.name || 'Untitled'])];
  if (r.profileId && !profiles.some((p) => p.id === r.profileId)) profOpts.push([r.profileId, 'Missing profile']);

  const cls = ['st-rule', !r.enabled && 'off', fx.danger && 'danger', matched && 'hit', drop && `drop-${drop}`].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      draggable={armed}
      onDragStart={(e) => {
        e.dataTransfer.setData(RULE_MIME, r.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="st-rule-line">
        <button
          className="st-handle"
          title="Drag to reorder (↑/↓ to move)"
          onMouseDown={() => setArm(r.id)}
          onMouseUp={() => setArm(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && index > 0) onMove(-1);
            else if (e.key === 'ArrowDown' && index < count - 1) onMove(1);
            else return;
            e.preventDefault();
          }}
        >
          ⋮⋮
        </button>
        <span className="st-w">When</span>
        <Select className="st-tok" value={r.trigger?.type || 'dir'} options={TRIGGERS} onChange={(type) => mutRule(r.id, (x) => ({ trigger: { ...x.trigger, type } }))} />
        <DraftInput className="field mono st-pat" value={r.trigger?.pattern || ''} placeholder={PLACEHOLDER[r.trigger?.type] || ''} spellCheck={false} autoFocus={autoFocus} onCommit={(pattern) => mutRule(r.id, (x) => ({ trigger: { ...x.trigger, pattern } }))} />
        <span className="st-w">→ {r.action?.type === 'space' ? 'put it in' : ''}</span>
        {sp && <i className="st-sp-dot" style={{ '--c': sp.color }} />}
        <Select
          className="st-tok"
          value={actionValue}
          options={actionOpts}
          onChange={(v) => {
            const [type, arg] = v.split(':');
            mutRule(r.id, () => ({ action: type === 'split' ? { type, edge: arg } : { type, spaceId: arg } }));
          }}
        />
        <span className="st-w">with profile</span>
        <Select className="st-tok" value={r.profileId || ''} options={profOpts} onChange={(v) => mutRule(r.id, () => ({ profileId: v || null }))} />
        <span className="grow" />
        <span className="st-hits">{r.enabled ? `${hits} ${hits === 1 ? 'match' : 'matches'}` : 'Off'}</span>
        <Switch on={r.enabled} onChange={(enabled) => mutRule(r.id, () => ({ enabled }))} />
        <button className="st-x st-rule-del" title="Delete rule" onClick={() => A.setRules(app.get().rules.filter((x) => x.id !== r.id))}>
          ✕
        </button>
      </div>
      <div className="st-rule-line st-fx">
        {anyFx || showFx ? (
          <>
            <span className="st-w">and</span>
            {EFFECTS.map(([k, label]) => (
              <button key={k} className={`st-eff${fx[k] ? ' on' : ''}${k === 'danger' ? ' danger' : ''}`} onClick={() => mutRule(r.id, (x) => ({ effects: { ...x.effects, [k]: !x.effects?.[k] } }))}>
                {k === 'danger' && <i className="st-eff-box" />}
                {label}
              </button>
            ))}
          </>
        ) : (
          <button className="st-link" onClick={() => setShowFx(true)}>
            + effect
          </button>
        )}
      </div>
    </div>
  );
}
