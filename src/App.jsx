import { useEffect, useRef, useState } from 'react';
import { app, ui } from './state/model.js';
import * as A from './state/actions.js';
import * as reg from './term/registry.js';
import { eventToAccel, normalizeAccel, isShellKey } from './lib/keys.js';
import Sidebar from './components/Sidebar.jsx';
import Card, { resolveConfirm } from './components/Card.jsx';
import Peek from './components/Peek.jsx';
import CommandBar from './components/CommandBar.jsx';
import Library from './components/Library.jsx';
import Notes from './components/Notes.jsx';
import Settings from './components/Settings.jsx';
import SpaceEditor from './components/SpaceEditor.jsx';
import Overview from './components/Overview.jsx';
import Onboarding from './components/Onboarding.jsx';
import TopBar from './components/TopBar.jsx';
import ToolsPanel from './components/ToolsPanel.jsx';
import ReviewPanel from './components/ReviewPanel.jsx';
import FileViewer from './components/FileViewer.jsx';
import StatusBar from './components/StatusBar.jsx';
import TabStyle from './components/TabStyle.jsx';
import { terminalLook, mix } from './lib/termtheme.js';

const api = window.termac;
const setUi = (patch) => ui.set((u) => ({ ...u, ...(typeof patch === 'function' ? patch(u) : patch) }));
const toggleOverlay = (name, arg = null) => setUi((u) => (u.overlay === name ? { overlay: null } : { overlay: name, overlayArg: arg }));

// Every shortcut and menu item lands here.
export function runAction(action) {
  const sid = A.focusedSid();
  switch (action) {
    case 'commandBar':
      return toggleOverlay('commandBar');
    case 'findTab':
      // The filter lives in the expanded sidebar, so bring that out first.
      if (app.get().settings.sidebarMode !== 'expanded') A.setSidebarMode('expanded');
      return setUi((u) => ({ view: 'terminal', tabFind: (u.tabFind || 0) + 1 }));
    case 'newTerminal':
      return A.openTerminal();
    case 'toggleSidebar':
      return A.toggleSidebar();
    case 'focusMode':
      return A.toggleFocusMode();
    case 'splitRight':
      return A.splitActive('right');
    case 'splitDown':
      return A.splitActive('bottom');
    case 'closePane':
      return A.closePane(sid);
    case 'copyLastOutput':
      return sid && A.copyLastOutput(sid);
    case 'prevSpace':
      return A.switchSpace(-1);
    case 'nextSpace':
      return A.switchSpace(1);
    case 'overview':
      return toggleOverlay('overview');
    case 'library':
      return setUi((u) => ({ view: u.view === 'library' ? 'terminal' : 'library', overlay: null }));
    case 'notes':
      return setUi((u) => ({ notesOpen: !u.notesOpen }));
    case 'toggleFiles':
      return A.togglePanel('files');
    case 'quickOpen':
      return setUi((u) => ({ tools: 'search', searchFocus: (u.searchFocus || 0) + 1 }));
    case 'toggleReview':
      return A.toggleReview();
    case 'settings':
      return A.toggleSettings();
    case 'newSpace':
      return setUi({ overlay: 'spaceEditor', overlayArg: null });
    case 'prevTab':
      return A.cycleTab(-1);
    case 'nextTab':
      return A.cycleTab(1);
    case 'focusLeft':
      return A.focusDirection('left');
    case 'focusRight':
      return A.focusDirection('right');
    case 'focusUp':
      return A.focusDirection('up');
    case 'focusDown':
      return A.focusDirection('down');
    case 'jumpBottom':
      return sid && reg.getHandle(sid)?.term.scrollToBottom();
    case 'clear':
      return sid && reg.clear(sid);
    case 'find':
      return sid && setUi((u) => ({ find: !u.find }));
    case 'reconnect':
      return sid && A.reconnect(sid);
    case 'zoomIn':
      return A.zoom(1);
    case 'zoomOut':
      return A.zoom(-1);
    case 'zoomReset':
      return A.zoom(0);
    default:
      return undefined;
  }
}

// Keys the code editor (Editor.jsx) keeps for itself: save, find and replace, next match.
const EDITOR_KEYS = new Set(['Cmd+S', 'Cmd+F', 'Alt+Cmd+F', 'Cmd+D', 'Cmd+G', 'Cmd+/', 'Cmd+[', 'Cmd+]']);

// Actions that still work while typing in a text field (not the terminal).
const FROM_INPUTS = new Set(['commandBar', 'findTab', 'newTerminal', 'settings', 'library', 'notes', 'toggleSidebar', 'focusMode', 'prevSpace', 'nextSpace', 'overview', 'newSpace', 'toggleFiles', 'quickOpen', 'toggleReview']);

function onKeyDown(e) {
  const u = ui.get();
  const s = app.get();
  if (!s.onboarded || u.prompt) return;
  if (u.confirm) {
    if (e.key === 'Escape') resolveConfirm(false);
    else if (e.key === 'Enter' && e.metaKey) resolveConfirm(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const raw = eventToAccel(e);
  if (!raw) return;
  const accel = normalizeAccel(raw);
  const inTerminal = !!e.target.closest?.('.xterm, .composer');
  const inEditor = !!e.target.closest?.('.cm-editor');
  const inInput = inEditor || (!inTerminal && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
  if (inEditor && EDITOR_KEYS.has(accel)) return;

  if (e.defaultPrevented || u.capturingKeys) return;
  if (u.overlay) {
    // Overlays own their keys; only the toggles that opened them close them again.
    const action = A.getKeymap().get(accel);
    if (action && ['commandBar', 'overview'].includes(action) && u.overlay === action) {
      e.preventDefault();
      e.stopPropagation();
      setUi({ overlay: null });
    }
    return;
  }
  if (e.key === 'Escape' && u.peek) {
    setUi({ peek: null });
    return;
  }
  // The file viewer covers the terminal, so Esc closes it unless you're typing in a field.
  if (e.key === 'Escape' && u.viewer && !inInput) {
    e.preventDefault();
    e.stopPropagation();
    A.closeFile();
    return;
  }

  // A field can claim shortcuts for itself (data-keys="Cmd+S"), like the settings.json editor's save.
  if (inInput && e.target.dataset.keys?.split(' ').includes(accel)) return;

  const digit = /^(Cmd|Ctrl)\+([1-9])$/.exec(accel);
  if (digit && !inInput) {
    if (digit[1] === 'Ctrl' && s.settings.shellPriority && inTerminal) return;
    e.preventDefault();
    e.stopPropagation();
    const n = Number(digit[2]) - 1;
    if (digit[1] === 'Cmd') A.activateIndex(n);
    else if (s.spaces[n]) A.switchSpace(s.spaces[n].id);
    return;
  }

  const action = A.getKeymap().get(accel);
  if (!action) return;
  if (inInput && !FROM_INPUTS.has(action)) return;
  if (inTerminal && s.settings.shellPriority && isShellKey(accel)) return;
  if (action === 'reconnect' && !A.focusedSid()) return;
  e.preventDefault();
  e.stopPropagation();
  runAction(action);
}

export default function App() {
  const color = app.use((s) => A.activeSpace(s)?.color);
  const term = app.use((s) => A.activeSpace(s)?.term);
  const termTheme = ui.use((s) => s.termTheme);
  const dark = ui.use((s) => s.dark);
  const mode = app.use((s) => s.settings.sidebarMode);
  const hidden = mode === 'hidden';
  const edgeReveal = app.use((s) => s.settings.gestures.edgeReveal);
  const onboarded = app.use((s) => s.onboarded);
  const spaceId = app.use((s) => s.activeSpaceId);
  const view = ui.use((s) => s.view);
  const overlay = ui.use((s) => s.overlay);
  const overlayArg = ui.use((s) => s.overlayArg);
  const notesOpen = ui.use((s) => s.notesOpen);
  const toast = ui.use((s) => s.toast);
  const [reveal, setReveal] = useState(false);
  const pinch = useRef(0);

  useEffect(() => {
    document.documentElement.style.setProperty('--space', color || '#3b82f6');
  }, [color]);

  // The chrome is a shade of the terminal itself, so the window reads as one surface. A
  // terminal that fights the system scheme (or shows an image) keeps the stock chrome.
  useEffect(() => {
    const look = terminalLook({ color, term }, termTheme);
    const root = document.documentElement.style;
    if (look.dark === dark && !look.image) {
      root.setProperty('--chrome', mix(look.bg, '#000', dark ? 0.24 : 0.035));
      root.setProperty('--term-bg', look.bg);
    } else {
      root.removeProperty('--chrome');
      root.removeProperty('--term-bg');
    }
  }, [color, term, termTheme, dark]);

  // The top bar always has room for the traffic lights, so they stay visible in every mode.
  useEffect(() => {
    api.app.trafficLights(true);
  }, []);

  useEffect(() => {
    const onWheel = (e) => {
      if (!e.ctrlKey || !app.get().settings.gestures.pinch) return;
      e.preventDefault();
      e.stopPropagation();
      pinch.current += e.deltaY;
      clearTimeout(pinch.t);
      pinch.t = setTimeout(() => (pinch.current = 0), 200);
      const open = ui.get().overlay === 'overview';
      if (pinch.current > 40 && !open) {
        pinch.current = 0;
        setUi({ overlay: 'overview' });
      } else if (pinch.current < -40 && open) {
        pinch.current = 0;
        setUi({ overlay: null });
      }
    };
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      setUi({ dark: mq.matches });
      A.applySettings();
    };
    const onCopy = () => {
      const sid = document.activeElement?.closest?.('.term-host')?.dataset.sid;
      const text = sid && reg.getHandle(sid)?.term.getSelection();
      if (text) A.rememberCopy({ text, sid, mark: reg.getHandle(sid).term.getSelectionPosition()?.start.y ?? null });
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('copy', onCopy, true);
    mq.addEventListener('change', onScheme);
    // Each folder Finder hands over opens as a new tab there.
    const takeFolders = () => api.app.takeFolders().then((dirs) => dirs.forEach((cwd) => A.openTerminal({ cwd })));
    takeFolders();
    const offs = [api.app.onMenu(runAction), api.app.onJumpTo(A.jumpTo), api.app.onWillQuit(A.prepareQuit), api.app.onAdopt(A.adopt), api.app.onFoldersOpened(takeFolders)];
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('copy', onCopy, true);
      mq.removeEventListener('change', onScheme);
      offs.forEach((off) => off());
    };
  }, []);

  const close = () => {
    setUi({ overlay: null });
    requestAnimationFrame(() => A.focusedSid() && reg.focus(A.focusedSid()));
  };

  return (
    <div className={`app${hidden ? ' focus-mode' : ''}${view === 'settings' ? ' on-settings' : ''}`}>
      <TopBar />
      <div className="app-body">
        {!hidden && <Sidebar />}
        {hidden && edgeReveal && !reveal && <div className="edge-reveal" onMouseEnter={() => setReveal(true)} />}
        {hidden && reveal && <Sidebar floating onLeave={() => setReveal(false)} />}
        <main className="main">
          <ToolsPanel />
          <div className="stage">
            {view === 'library' ? <Library /> : view === 'settings' ? <Settings /> : <Card />}
            {view === 'terminal' && <FileViewer />}
          </div>
          {notesOpen && <Notes key={spaceId} spaceId={spaceId} onClose={() => setUi({ notesOpen: false })} />}
          <ReviewPanel />
        </main>
      </div>
      <StatusBar />
      <Peek />
      {overlay && <div className={`backdrop${overlay === 'overview' ? ' dark' : ''}`} onMouseDown={close} />}
      {overlay === 'commandBar' && <CommandBar onClose={close} initial={typeof overlayArg === 'string' ? overlayArg : ''} />}
      {overlay === 'spaceEditor' && <SpaceEditor key={overlayArg ?? 'new'} spaceId={overlayArg} onClose={close} />}
      {overlay === 'overview' && <Overview onClose={close} />}
      {overlay === 'tabStyle' && <TabStyle tid={overlayArg} onClose={close} />}
      {!onboarded && <Onboarding onDone={() => A.focusedSid() && reg.focus(A.focusedSid())} />}
      <Prompt />
      {hidden && !reveal && toast && (
        <div className="toast">
          <div>
            <div className="t">{toast.title}</div>
            {toast.detail && <div className="d">{toast.detail}</div>}
          </div>
          {toast.action && <button onClick={toast.action.run}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}

function Prompt() {
  const p = ui.use((s) => s.prompt);
  if (!p) return null;
  const done = (value) => {
    ui.set((u) => ({ ...u, prompt: null }));
    p.resolve(value);
  };
  return (
    <>
      <div className="backdrop" onMouseDown={() => done(null)} />
      <form
        className="modal"
        style={{ width: 360 }}
        onSubmit={(e) => {
          e.preventDefault();
          done(new FormData(e.currentTarget).get('v')?.toString().trim() || null);
        }}
      >
        <div className="modal-title">{p.title}</div>
        <div className="modal-body">
          <input name="v" className="field" style={{ width: '100%' }} autoFocus defaultValue={p.value} onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Escape' && done(null)} />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            OK
          </button>
        </div>
      </form>
    </>
  );
}
