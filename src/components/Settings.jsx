import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import '../styles/settings.css';
import { app, ui, defaultProfile, DEFAULT_SETTINGS } from '../state/model.js';
import * as A from '../state/actions.js';
import { THEMES } from '../term/registry.js';
import { ACTIONS, defaultBindings, eventToAccel, normalizeAccel, formatAccel } from '../lib/keys.js';
import { expandHome, tildify } from '../lib/routing.js';
import { uid } from '../lib/meta.js';
import { BG_PRESETS, terminalLook } from '../lib/termtheme.js';
import { highlightLines } from '../lib/highlight.js';
import { parseSettingsFile } from '../lib/settingsfile.js';
import { Switch, Seg, useImageUrl, SpaceGlyph } from './common.jsx';
import { monoStack } from '../lib/fonts.js';
import { Sym, IconExternal, IconClose } from './icons.jsx';

const api = window.termac;

// [id, SF Symbol, label]
const TABS = [
  ['general', 'gearshape', 'General'],
  ['appearance', 'paintpalette', 'Appearance'],
  ['profiles', 'terminal', 'Profiles'],
  ['keybindings', 'keyboard', 'Keybindings'],
  ['gestures', 'hand.draw', 'Gestures'],
  ['file', 'curlybraces', 'settings.json'],
];
const ALIASES = { keys: 'keybindings', shortcuts: 'keybindings', json: 'file' };
const tabId = (t) => {
  const id = ALIASES[t] || t;
  return TABS.some(([k]) => k === id) ? id : null;
};
const setTab = (settingsTab) => ui.set((u) => ({ ...u, settingsTab }));

// Settings as a page in place of the terminal (see A.openSettings); its sidebar row is in Sidebar.jsx.
export default function Settings() {
  const tab = ui.use((u) => tabId(u.settingsTab)) || 'general';
  const file = ui.use((u) => u.settingsFile);
  const page = useRef(null);

  // Take focus away from the terminal so keys don't reach the shell.
  useEffect(() => page.current?.focus(), []);

  // Bubble phase: shortcut recorders listen in capture phase and preventDefault, so Esc
  // while recording cancels the recording instead of closing Settings. The JSON editor
  // keeps Esc for itself.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.target.closest?.('.sf')) return;
      e.preventDefault();
      A.closeSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const label = TABS.find(([k]) => k === tab)[2];
  return (
    <div className="st-page" aria-label="Settings" tabIndex={-1} ref={page}>
      <nav className="st-nav">
        {TABS.map(([k, symbol, name]) => (
          <Fragment key={k}>
            {k === 'file' && <div className="st-nav-sep" />}
            <button className={`st-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
              <Sym name={symbol} size={17} className="st-ic" />
              {name}
              {k === 'file' && file.error && <span className="st-tab-err" title={file.error} />}
            </button>
          </Fragment>
        ))}
        <div className="grow" />
        <button className="btn st-file" onClick={A.openSettingsFile} title={file.path}>
          <IconExternal size={14} />
          Open in external editor
        </button>
      </nav>
      <div className="st-main">
        <div className="st-head">
          <span className="st-title">{label}</span>
          <button className="icon-btn" title="Close Settings (Esc)" onClick={A.closeSettings}>
            <IconClose size={14} />
          </button>
        </div>
        {tab !== 'file' && (file.error || file.warnings.length > 0) && (
          <div className="st-filebar">
            <span className="grow">
              <b>{file.error ? 'settings.json has an error' : 'settings.json has problems'}</b> — {file.error || file.warnings.join(' · ')}
              {file.error && '. Changes made here are not saved to the file until it is fixed.'}
            </span>
            <button className="st-link" onClick={() => setTab('file')}>
              Fix it
            </button>
          </div>
        )}
        <div className={`st-body st-body-${tab}`}>
          {tab === 'general' && <GeneralTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'profiles' && <ProfilesTab />}
          {tab === 'keybindings' && <KeysTab />}
          {tab === 'gestures' && <GesturesTab />}
          {tab === 'file' && <FileTab />}
        </div>
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
    ui.set((u) => ({ ...u, capturingKeys: true }));
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
    return () => {
      window.removeEventListener('keydown', fn, true);
      ui.set((u) => ({ ...u, capturingKeys: false }));
    };
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
          <Select value={s.osNotify} onChange={setSetting('osNotify')} options={[['always', 'Always'], ['background', 'Only when Termorc is in background'], ['never', 'Never']]} />
        </Row>
        <Row label="Confirm quit with running processes">
          <Switch on={s.confirmQuit} onChange={setSetting('confirmQuit')} />
        </Row>
        <Row label="Use ⌥ as Meta key" hint="Sends Esc-prefixed keys to the shell instead of typing special characters.">
          <Switch on={s.optionAsMeta} onChange={setSetting('optionAsMeta')} />
        </Row>
        <Row label="Prompt" hint="Termorc: an input bar with history, completion and suggestions, and each command in its own block. Shell: your shell's own prompt and theme. Applies to new sessions.">
          <Seg value={s.promptStyle} onChange={setSetting('promptStyle')} options={[['termorc', 'Termorc'], ['shell', 'Shell']]} />
        </Row>
        <Row label="Tips in new sessions" hint="A short card of shortcuts above the input bar until you run something.">
          <Switch on={s.terminalWelcome} onChange={setSetting('terminalWelcome')} />
        </Row>
        <Row label="Click to move the cursor" hint="Click inside the command you're typing to put the cursor there. Needs shell integration.">
          <Switch on={s.clickToMove} onChange={setSetting('clickToMove')} />
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
const UI_FONTS = ['system-ui', 'Inter', 'Helvetica Neue', 'Avenir Next', 'Roboto', 'SF Mono'];

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
      <Group title="Interface">
        <Row label="Font" hint="Sidebar, bars and menus. system-ui is SF Pro.">
          <span className="row-inline">
            <DraftInput className="field st-font" list="st-ui-fonts" value={s.uiFontFamily} spellCheck={false} onCommit={(v) => A.setSettings({ uiFontFamily: v.trim() || 'system-ui' })} delay={600} />
            <datalist id="st-ui-fonts">
              {UI_FONTS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <label className="st-unit">
              <DraftInput className="field st-num" type="number" min={10} max={20} step={0.5} value={s.uiFontSize} onCommit={(v) => A.setSettings({ uiFontSize: clamp(10, 20, 12.5)(v) })} />
              px
            </label>
            <label className="st-unit">
              Line
              <DraftInput className="field st-num" type="number" min={1} max={2} step={0.05} value={s.uiLineHeight} onCommit={(v) => A.setSettings({ uiLineHeight: clamp(1, 2, 1.4)(v) })} />
            </label>
          </span>
        </Row>
        <Row label="Zoom" hint="Scales the whole window.">
          <Select value={s.zoomLevel} onChange={setSetting('zoomLevel')} options={[[80, '80%'], [90, '90%'], [100, '100%'], [110, '110%'], [125, '125%'], [150, '150%']]} />
        </Row>
      </Group>
      <div className="st-group-title">Terminal</div>
      <div className="st-preview" style={{ background: t.background, color: t.foreground, fontFamily: monoStack(font ?? s.fontFamily), fontSize: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, fontWeight: s.fontWeight }}>
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
        <Row label="Weight">
          <span className="row-inline">
            <Select value={s.fontWeight} onChange={setSetting('fontWeight')} options={[['300', 'Light'], ['normal', 'Regular'], ['500', 'Medium'], ['600', 'Semibold']]} />
            <span className="dim">Bold</span>
            <Select value={s.fontWeightBold} onChange={setSetting('fontWeightBold')} options={[['500', 'Medium'], ['600', 'Semibold'], ['bold', 'Bold'], ['800', 'Heavy']]} />
            <label className="st-unit">
              Spacing
              <DraftInput className="field st-num" type="number" min={-2} max={4} step={0.5} value={s.letterSpacing} onCommit={(v) => A.setSettings({ letterSpacing: clamp(-2, 4, 0)(v) })} />
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
        <Row label="Appearance" hint="The window, sidebar and terminals. Spaces with a custom background keep it.">
          <Seg value={s.termTheme} onChange={setSetting('termTheme')} options={[['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']]} />
        </Row>
        <Row label="Scrollback lines">
          <Select value={s.scrollback} onChange={setSetting('scrollback')} options={[[1000, '1,000'], [5000, '5,000'], [10000, '10,000'], [50000, '50,000']]} />
        </Row>
      </Group>
      <SidebarGroup s={s} />
      <SpaceLooks />
    </div>
  );
}

function SidebarGroup({ s }) {
  const kb = s.keybindings;
  const hint = [kb.toggleSidebar && `${formatAccel(kb.toggleSidebar)} shows and hides it`, 'hover the left edge to peek while hidden'].filter(Boolean).join(' · ');
  return (
    <Group title="Sidebar">
      <Row label="Sidebar" hint={hint || null}>
        <Seg value={s.sidebarMode} onChange={(m) => A.setSidebarMode(m)} options={[['expanded', 'Expanded'], ['compact', 'Compact'], ['hidden', 'Hidden']]} />
      </Row>
    </Group>
  );
}

function lookLabel(term) {
  const bg = term?.bg ?? null;
  const p = BG_PRESETS.find((x) => x.bg === bg);
  const name = p ? p.name : `Custom ${bg}`;
  return term?.image ? `${name} · ${term.image.split('/').pop()}` : name;
}

function SpaceLooks() {
  const spaces = app.use((s) => s.spaces);
  const theme = ui.use((u) => u.termTheme);
  const edit = (id) => ui.set((u) => ({ ...u, overlay: 'spaceEditor', overlayArg: id }));
  return (
    <Group title="Per-Space backgrounds">
      {spaces.map((sp) => (
        <Row
          key={sp.id}
          label={
            <span className="st-sp">
              <SpaceGlyph space={sp} style={{ color: sp.color }} /> {sp.name}
            </span>
          }
          hint={lookLabel(sp.term)}
        >
          <span className="row-inline">
            <LookSwatch space={sp} theme={theme} />
            <button className="btn" onClick={() => edit(sp.id)}>
              Edit…
            </button>
          </span>
        </Row>
      ))}
    </Group>
  );
}

function LookSwatch({ space, theme }) {
  const look = terminalLook(space, theme);
  const url = useImageUrl(look.image);
  return (
    <span className="st-look" style={{ background: look.bg }}>
      {look.image && url && <i style={{ backgroundImage: `url("${url}")` }} />}
      {look.image && <b style={{ background: look.bg, opacity: look.dim }} />}
    </span>
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
    if (api?.sys?.confirm && !(await api.sys.confirm({ message: `Delete profile “${p.name}”?`, detail: 'Spaces using it fall back to the default profile.', ok: 'Delete' }))) return;
    const s = app.get();
    const rest = s.profiles.filter((x) => x.id !== p.id);
    if (!rest.length) return;
    const def = s.defaultProfileId === p.id ? rest[0].id : s.defaultProfileId;
    for (const sp of s.spaces) if (sp.profileId === p.id) A.updateSpace(sp.id, { profileId: null });
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
                <SpaceGlyph space={sp} />
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
  { key: 'edgeReveal', title: 'Reveal sidebar', sub: 'When the sidebar is hidden, hover the left edge', art: (<><b className="st-edge" /><D /><D /><span>→</span></>) },
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

// ---- settings.json --------------------------------------------------------------------

// JSON keys get their own color: a string followed by a colon.
const markKeys = (lines) => lines.map((toks) => toks.map((t, i) => (t[0] === 'str' && /^\s*:/.test(toks[i + 1]?.[1] || '') ? ['fn', t[1]] : t)));

// The file itself, edited in place: highlighted text under a transparent textarea, checked
// as you type. ⌘S saves and applies it; edits made in another editor load in unless you
// have unsaved changes here.
function FileTab() {
  const file = ui.use((u) => u.settingsFile);
  const home = ui.use((u) => u.home);
  const [text, setText] = useState(file.text ?? '');
  const [base, setBase] = useState(file.text ?? ''); // the file on disk as of the last load or save
  const area = useRef(null);
  const dirty = text !== base;

  useEffect(() => {
    if (file.text == null || file.text === base) return;
    if (!dirty) setText(file.text);
    setBase(file.text);
  }, [file.text]);

  const lines = useMemo(() => text.split('\n'), [text]);
  const tokens = useMemo(() => markKeys(highlightLines(lines, 'jsonc')), [lines]);
  const check = useMemo(() => parseSettingsFile(text, DEFAULT_SETTINGS), [text]);
  const errLine = Number(/line (\d+)/.exec(check.error || '')?.[1]) || null;

  const save = () => {
    if (!dirty) return;
    A.saveSettingsText(text);
    setBase(text);
  };

  // insertText keeps the textarea's own undo stack intact.
  const insert = (s) => document.execCommand('insertText', false, s);
  const onKeyDown = (e) => {
    if (e.metaKey && e.key === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      insert('  ');
    } else if (e.key === 'Enter' && !e.metaKey && !e.shiftKey) {
      // Keep the indentation, one level deeper after an opening brace or bracket.
      const el = e.currentTarget;
      const before = el.value.slice(0, el.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const indent = /^\s*/.exec(line)[0] + (/[{[]\s*$/.test(line) ? '  ' : '');
      e.preventDefault();
      insert('\n' + indent);
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  if (file.text == null && !text) return <div className="st-empty">settings.json hasn't been written yet. Change any setting to create it.</div>;
  return (
    <div className="sf">
      <div className="sf-bar">
        <span className="sf-path">{tildify(file.path, home)}</span>
        {dirty && <span className="sf-dirty">Unsaved</span>}
        <span className="grow" />
        <button className="btn" disabled={!dirty} onClick={() => setText(base)}>
          Revert
        </button>
        <button className="btn primary" disabled={!dirty} onClick={save}>
          Save <kbd>⌘S</kbd>
        </button>
      </div>
      <div className="sf-scroll" onMouseDown={(e) => e.target === e.currentTarget && area.current?.focus()}>
        <div className="sf-gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={errLine === i + 1 ? 'err' : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="sf-code">
          <pre aria-hidden="true">
            {tokens.map((line, i) => (
              <div key={i} className={errLine === i + 1 ? 'err' : undefined}>
                {line.map(([cls, t], k) => (cls ? <span key={k} className={`hl-${cls}`}>{t}</span> : <Fragment key={k}>{t}</Fragment>))}
              </div>
            ))}
          </pre>
          <textarea ref={area} value={text} spellCheck={false} wrap="off" autoCapitalize="off" autoComplete="off" autoCorrect="off" data-keys="Cmd+S" onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        </div>
      </div>
      <div className={`sf-status${check.error ? ' err' : check.warnings.length ? ' warn' : ''}`}>
        <span className="sf-msg">{check.error ? `✕ ${check.error.replace(/ in JSON at position \d+/, '')}` : check.warnings.length ? `⚠ ${check.warnings.join(' · ')}` : '✓ Valid'}</span>
        <span className="dim">Comments and trailing commas are fine</span>
      </div>
    </div>
  );
}
