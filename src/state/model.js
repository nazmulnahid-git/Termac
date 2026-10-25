// Persisted app model, its defaults, and the three stores the UI reads from.
import { createStore } from './store.js';
import { defaultBindings } from '../lib/keys.js';
import { uid } from '../lib/meta.js';
import { DEFAULT_LOOK } from '../lib/termtheme.js';

export const DEFAULT_SETTINGS = {
  onLaunch: 'restore', // restore | fresh
  newTerminalDir: 'current', // current | space | home
  archiveAfterH: 12, // 0 = never
  libraryDays: 90, // 0 = forever
  neverArchiveRunning: true,
  notifyAfterS: 30, // 0 = never
  osNotify: 'background', // always | background | never
  confirmQuit: true,
  zoomLevel: 125,
  uiFontFamily: 'system-ui',
  uiFontSize: 12.5,
  uiLineHeight: 1.4,
  fontFamily: 'SF Mono, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.4,
  letterSpacing: 0,
  fontWeight: 'normal',
  fontWeightBold: '600',
  cursorStyle: 'block',
  cursorBlink: true,
  termTheme: 'system', // system | dark | light
  optionAsMeta: false,
  scrollback: 10000,
  keybindings: defaultBindings(),
  shellPriority: false,
  gestures: { swipeSpaces: true, pinch: true, edgeReveal: true, peek: true },
  sidebarMode: 'expanded', // expanded | compact | hidden
  sidebarWidth: 248,
  toolsWidth: 300,
  reviewWidth: 520,
  reviewView: 'unified', // unified | split
  clickToMove: true,
  promptStyle: 'termorc', // termorc (input bar + blocks) | shell (the shell's own prompt)
  terminalWelcome: true, // tips card in a new, empty session
};

export function defaultProfile() {
  return { id: 'default', name: 'Login shell', command: '', cwdMode: 'space', cwd: '', env: [], startup: '' };
}

export function newSpace({ name = 'Space', glyph = '◆', color = '#3b82f6', startDir = '~', profileId = null } = {}) {
  return { id: uid('sp'), name, glyph, color, startDir, profileId, archiveAfterH: null, term: { ...DEFAULT_LOOK }, pinned: [], folders: [], today: [], activeTabId: null };
}

export function initialState() {
  const space = newSpace({ name: 'Home', glyph: '◆', color: '#3b82f6' });
  return {
    version: 2,
    onboarded: false,
    spaces: [space],
    activeSpaceId: space.id,
    favorites: [],
    tabs: {},
    sessions: {},
    settings: DEFAULT_SETTINGS,
    profiles: [defaultProfile()],
    defaultProfileId: 'default',
    rules: [],
    ruleHits: {},
    snippets: [],
    notes: {},
    recentDirs: [],
    activity: [],
    reviewComments: {}, // git root -> [{ id, path, side, line, snippet, text, at }]
  };
}

// Fills in anything an older or partial state file is missing.
export function migrate(saved) {
  const base = initialState();
  if (!saved || saved.version !== 2) return base;
  const s = { ...base, ...saved };
  s.settings = { ...DEFAULT_SETTINGS, ...saved.settings, keybindings: { ...DEFAULT_SETTINGS.keybindings, ...saved.settings?.keybindings }, gestures: { ...DEFAULT_SETTINGS.gestures, ...saved.settings?.gestures } };
  if (saved.settings?.sidebarHidden && !saved.settings?.sidebarMode) s.settings.sidebarMode = 'hidden';
  delete s.settings.sidebarHidden;
  if (!s.spaces?.length) s.spaces = base.spaces;
  s.spaces = s.spaces.map((sp) => ({ ...sp, term: { ...DEFAULT_LOOK, ...sp.term } }));
  if (!s.spaces.some((sp) => sp.id === s.activeSpaceId)) s.activeSpaceId = s.spaces[0].id;
  if (!s.profiles?.length) s.profiles = [defaultProfile()];
  return s;
}

// Persisted state.
export const app = createStore(initialState());

// Per-session runtime status (not persisted): status, command, cwd, branch, bell…
export const rt = createStore({});

// Transient UI state.
export const ui = createStore({
  view: 'terminal', // terminal | library | settings
  settingsOpen: false, // Settings has a tab in the sidebar (it stays there while you visit sessions)
  settingsTab: 'general', // section shown in Settings
  capturingKeys: false, // a shortcut recorder in Settings owns the keyboard
  overlay: null, // commandBar | settings | spaceEditor | overview | onboarding
  overlayArg: null,
  notesOpen: false,
  focusedSid: null,
  peek: null, // { sid, top, pinned }
  toast: null, // { id, kind, title, detail, action, expires }
  confirm: null, // { sid, title, detail, onRun }
  dragging: null, // sidebar drag: { kind: 'tab', tabId } | { kind: 'folder', spaceId, folderId }, plus origin and target
  sidebarReveal: false,
  copied: null,
  find: false,
  dark: false,
  home: '',
  sshHosts: [],
  termTheme: 'dark', // resolved terminal theme: dark | light
  notify: null, // finished job in another Space { id, sid, spaceId, command, exit, dur, at }
  prompt: null, // { title, value, resolve }
  tools: null, // left tool panel: files | search
  searchFocus: 0, // bumped by ⌘P to refocus the find-file box
  tabFind: 0, // bumped by ⌘J to focus the sidebar's session filter
  review: false, // code review panel (right)
  reviewMax: false, // the review panel covers the whole terminal area
  viewer: null, // { path, line } file shown over the terminal card
  viewerDirty: false, // the open file has unsaved edits
  settingsFile: { path: '', text: null, error: null, warnings: [] }, // ~/.termorc/settings.json: its text on disk and last parse result
});

export function patchRt(sid, patch) {
  rt.set((s) => {
    const prev = s[sid] || {};
    for (const k in patch) {
      if (!Object.is(prev[k], patch[k])) return { ...s, [sid]: { ...prev, ...patch } };
    }
    return s;
  });
}
