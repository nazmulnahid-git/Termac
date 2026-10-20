import { app, BrowserWindow, ipcMain, Menu, dialog, shell, screen, globalShortcut, Notification, nativeTheme } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PtyHost } from './pty-host.js';
import { Library } from './library.js';
import { readJSON, debouncedWriter } from './store.js';
import * as sys from './system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const USER = app.getPath('userData');
const STATE_FILE = path.join(USER, 'state.json');
const SCROLLBACK_DIR = path.join(USER, 'scrollback');
const integrationDir = path.join(__dirname, 'shell-integration').replace('app.asar', 'app.asar.unpacked');

const ptys = new PtyHost({ integrationDir });
const library = new Library(path.join(USER, 'library'));
const stateWriter = debouncedWriter(STATE_FILE, 400);
let state = readJSON(STATE_FILE, null);

let mainWin = null;
let quickWin = null;
let quitting = false;
let quitReady = false;
let hotkey = null;
let quitTimer = null;

if (!app.requestSingleInstanceLock()) app.quit();

function load(win, page) {
  if (DEV_URL) win.loadURL(`${DEV_URL}/${page}`);
  else win.loadFile(path.join(__dirname, '..', 'dist', page));
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  backgroundThrottling: false,
};

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 420,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1013' : '#f2f2f0',
    webPreferences,
  });
  load(mainWin, 'index.html');
  mainWin.once('ready-to-show', () => mainWin.show());
  // Closing the window hides it so sessions keep running; ⌘Q quits.
  mainWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => (mainWin = null));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createQuickWindow() {
  quickWin = new BrowserWindow({
    width: 640,
    height: 380,
    show: false,
    frame: false,
    resizable: true,
    minWidth: 420,
    minHeight: 200,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131417' : '#fcfcfa',
    webPreferences,
  });
  quickWin.setAlwaysOnTop(true, 'floating');
  quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  load(quickWin, 'quick.html');
  quickWin.on('blur', () => {
    if (quickWin && !quickWin.webContents.isDevToolsFocused()) hideQuick();
  });
  quickWin.on('closed', () => (quickWin = null));
}

function hideQuick() {
  if (!quickWin?.isVisible()) return;
  quickWin.hide();
  quickWin.webContents.send('quick:visibility', { visible: false });
}

async function toggleQuick() {
  if (!quickWin) {
    createQuickWindow();
    await new Promise((resolve) => quickWin.webContents.once('did-finish-load', resolve));
  }
  if (quickWin.isVisible() && quickWin.isFocused()) return hideQuick();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  const [w] = quickWin.getSize();
  quickWin.setPosition(Math.round(x + (width - w) / 2), y + 8);
  const cwd = await sys.frontmostFolder().catch(() => null);
  quickWin.show();
  quickWin.focus();
  quickWin.webContents.send('quick:visibility', { visible: true, cwd });
}

function setHotkey(accel) {
  if (hotkey) globalShortcut.unregister(hotkey);
  hotkey = null;
  if (!accel) return true;
  try {
    if (globalShortcut.register(accel, toggleQuick)) {
      hotkey = accel;
      return true;
    }
  } catch {
    /* invalid accelerator */
  }
  return false;
}

// ---- Menu ---------------------------------------------------------------------------
function buildMenu(bindings = {}) {
  const send = (action) => () => {
    const win = BrowserWindow.getFocusedWindow() || mainWin;
    win?.webContents.send('menu:action', action);
  };
  const item = (label, action) => ({
    label,
    click: send(action),
    accelerator: bindings[action] || undefined,
    registerAccelerator: false,
  });
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'settings'),
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Shell',
      submenu: [
        item('New Terminal', 'newTerminal'),
        item('Command Bar', 'commandBar'),
        item('Find Session…', 'findTab'),
        { type: 'separator' },
        item('Split Right', 'splitRight'),
        item('Split Down', 'splitDown'),
        item('Close Pane', 'closePane'),
        { type: 'separator' },
        item('Copy Last Output', 'copyLastOutput'),
        item('Clear', 'clear'),
        item('Find…', 'find'),
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        item('Collapse Sidebar', 'toggleSidebar'),
        item('Focus Mode', 'focusMode'),
        item('Library', 'library'),
        item('Notes', 'notes'),
        item('Project Explorer', 'toggleFiles'),
        item('Find File…', 'quickOpen'),
        item('Code Review', 'toggleReview'),
        item('All Spaces', 'overview'),
        { type: 'separator' },
        item('Bigger', 'zoomIn'),
        item('Smaller', 'zoomOut'),
        item('Actual Size', 'zoomReset'),
        ...(DEV_URL ? [{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
    {
      label: 'Spaces',
      submenu: [item('Next Space', 'nextSpace'), item('Previous Space', 'prevSpace'), { type: 'separator' }, item('New Space…', 'newSpace')],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC ----------------------------------------------------------------------------
const owner = (e) => e.sender;

ipcMain.handle('pty:spawn', (e, opts) => ptys.spawn(owner(e), opts));
ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
ipcMain.on('pty:kill', (_e, id) => ptys.kill(id));
ipcMain.on('pty:ack', (_e, id, bytes) => ptys.ack(id, bytes));
ipcMain.handle('pty:hold', (_e, id) => ptys.hold(id));
ipcMain.on('pty:release', (_e, id) => ptys.release(id));
ipcMain.handle('pty:cwd', (_e, id) => ptys.cwdOf(id));

ipcMain.handle('state:load', () => ({ state, home: app.getPath('home'), dark: nativeTheme.shouldUseDarkColors }));
ipcMain.on('state:save', (_e, next) => {
  state = next;
  stateWriter.save(next);
  quickWin?.webContents.send('state:changed', { spaces: next.spaces, settings: next.settings, profiles: next.profiles, activeSpaceId: next.activeSpaceId, defaultProfileId: next.defaultProfileId });
});

ipcMain.handle('scrollback:save', async (_e, id, data) => {
  await fsp.mkdir(SCROLLBACK_DIR, { recursive: true });
  await fsp.writeFile(path.join(SCROLLBACK_DIR, `${id.replace(/[^\w-]/g, '')}.ans`), data);
});
ipcMain.handle('scrollback:load', (_e, id) => fsp.readFile(path.join(SCROLLBACK_DIR, `${id.replace(/[^\w-]/g, '')}.ans`), 'utf8').catch(() => ''));
ipcMain.handle('scrollback:delete', (_e, id) => fsp.rm(path.join(SCROLLBACK_DIR, `${id.replace(/[^\w-]/g, '')}.ans`), { force: true }));

ipcMain.handle('library:add', (_e, entry, ansi) => library.add(entry, ansi));
ipcMain.handle('library:search', (_e, query) => library.search(query));
ipcMain.handle('library:content', (_e, id) => library.content(id));
ipcMain.handle('library:remove', (_e, id) => library.remove(id));

ipcMain.handle('sys:sshHosts', () => sys.sshHosts());
ipcMain.handle('sys:gitBranch', (_e, cwd) => sys.gitBranch(cwd));
ipcMain.handle('sys:gitStatus', (_e, cwd) => sys.gitStatus(cwd));
ipcMain.handle('sys:gitBranches', (_e, cwd) => sys.gitBranches(cwd));
ipcMain.handle('sys:gitPr', (_e, cwd, branch) => sys.gitPr(cwd, branch));
ipcMain.handle('sys:listDirs', (_e, dir) => sys.listDirs(dir));
ipcMain.handle('sys:gitRoot', (_e, cwd) => sys.gitRoot(cwd));
ipcMain.handle('sys:listDir', (_e, dir) => sys.listDir(dir));
ipcMain.handle('sys:readFile', (_e, file) => sys.readFile(file).catch((err) => ({ error: err.message })));
ipcMain.handle('sys:projectFiles', (_e, root) => sys.projectFiles(root));
ipcMain.handle('sys:gitChanges', (_e, cwd) => sys.gitChanges(cwd));
ipcMain.handle('sys:gitDiff', (_e, root, file, opts) => sys.gitDiff(root, file, opts));
ipcMain.handle('sys:gitStage', (_e, root, file, stage) => sys.gitStage(root, file, stage));
ipcMain.handle('sys:gitDiscard', (_e, root, file, untracked) => sys.gitDiscard(root, file, untracked));
ipcMain.handle('sys:detectImports', () => sys.detectImports());
ipcMain.handle('sys:isDir', (_e, p) => sys.isDir(p));
ipcMain.handle('sys:chooseDir', async (e, defaultPath) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('sys:chooseImage', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] }] });
  return r.canceled ? null : r.filePaths[0];
});
// Background images are read once and handed over as data URLs (CSP allows data: images).
ipcMain.handle('sys:readImage', async (_e, file) => {
  try {
    const st = await fsp.stat(file);
    if (st.size > 20 * 1024 * 1024) return null;
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${(await fsp.readFile(file)).toString('base64')}`;
  } catch {
    return null;
  }
});
ipcMain.on('sys:reveal', (_e, p) => shell.openPath(p));
ipcMain.on('sys:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('sys:notify', (_e, { title, body, sessionId }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    mainWin?.show();
    mainWin?.webContents.send('app:jumpTo', sessionId);
  });
  n.show();
});
ipcMain.handle('sys:confirm', async (e, { message, detail, ok = 'OK' }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1 });
  return r.response === 0;
});

ipcMain.handle('menu:popup', (e, items) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return new Promise((resolve) => {
    let picked = null;
    const toTemplate = (list) =>
      list.map((it) =>
        it.type === 'separator'
          ? { type: 'separator' }
          : {
              label: it.label,
              enabled: it.enabled !== false,
              type: it.checked != null ? 'checkbox' : 'normal',
              checked: !!it.checked,
              submenu: it.submenu ? toTemplate(it.submenu) : undefined,
              click: it.submenu ? undefined : () => (picked = it.id),
            },
      );
    Menu.buildFromTemplate(toTemplate(items)).popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
  });
});

ipcMain.on('app:setMenu', (_e, bindings) => buildMenu(bindings));
ipcMain.handle('app:setHotkey', (_e, accel) => setHotkey(accel));
ipcMain.on('app:trafficLights', (e, visible) => BrowserWindow.fromWebContents(e.sender)?.setWindowButtonVisibility(!!visible));
ipcMain.on('app:focusMain', () => {
  mainWin?.show();
  mainWin?.focus();
});

ipcMain.on('quick:hide', () => hideQuick());
ipcMain.on('quick:resize', (_e, height) => quickWin?.setSize(quickWin.getSize()[0], Math.round(height)));
ipcMain.handle('quick:promote', (_e, payload) => {
  if (!mainWin) createMainWindow();
  if (!ptys.transfer(payload.sessionId, mainWin.webContents)) return false;
  mainWin.webContents.send('session:adopt', payload);
  hideQuick();
  mainWin.show();
  mainWin.focus();
  return true;
});

ipcMain.on('app:quitReady', () => {
  quitReady = true;
  app.quit();
});
ipcMain.on('app:quitCancel', () => {
  quitting = false;
  clearTimeout(quitTimer);
});

// ---- Lifecycle ----------------------------------------------------------------------
app.on('second-instance', () => {
  mainWin?.show();
  mainWin?.focus();
});

app.on('activate', () => {
  if (!mainWin) createMainWindow();
  else mainWin.show();
});

// The renderer saves scrollback and asks about running processes before we exit.
app.on('before-quit', (e) => {
  if (quitReady || !mainWin || mainWin.webContents.isCrashed()) {
    quitting = true;
    return;
  }
  e.preventDefault();
  if (quitting) return;
  quitting = true;
  mainWin.webContents.send('app:willQuit', { running: ptys.runningCount() });
  quitTimer = setTimeout(() => {
    if (quitting && !quitReady) {
      quitReady = true;
      app.quit();
    }
  }, 8000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stateWriter.flushSync();
  library.flushSync();
  ptys.killAll();
});

app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  app.setName('Termac');
  buildMenu();
  createMainWindow();
  setHotkey(state?.settings?.keybindings?.quickTerminal ?? 'Alt+Space');
  library.prune(state?.settings?.libraryDays ?? 90);
});
