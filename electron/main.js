const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron')
const path = require('path')
const { PtyManager } = require('./pty-manager')
const ElectronStore = require('electron-store')
const Store = ElectronStore.default || ElectronStore

let store
function getStore() {
  if (!store) {
    store = new Store({
      name: 'termac-config',
      defaults: {
        bookmarks: [
          { id: 'home', name: 'Home', path: process.env.HOME || '/Users' },
          { id: 'desktop', name: 'Desktop', path: path.join(process.env.HOME || '/Users', 'Desktop') },
          { id: 'downloads', name: 'Downloads', path: path.join(process.env.HOME || '/Users', 'Downloads') },
        ],
        sidebarWidth: 260,
        sidebarCollapsed: false,
      },
    })
  }
  return store
}

let mainWindow
const ptyManager = new PtyManager()

function createWindow() {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    minHeight: 450,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  })

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  getStore()
  createWindow()
})

app.on('window-all-closed', () => {
  ptyManager.destroyAll()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ---- PTY IPC ----
ipcMain.handle('pty:create', (event, { id, cwd, cols, rows }) => {
  const pty = ptyManager.create(id, cwd || process.env.HOME, cols || 80, rows || 24)
  pty.onData((data) => {
    mainWindow?.webContents.send('pty:data', { id, data })
  })
  pty.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('pty:exit', { id, exitCode })
  })
  return { success: true }
})

ipcMain.handle('pty:write', (event, { id, data }) => {
  ptyManager.write(id, data)
})

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  ptyManager.resize(id, cols, rows)
})

ipcMain.handle('pty:destroy', (event, { id }) => {
  ptyManager.destroy(id)
})

ipcMain.handle('pty:getCwd', async (event, { id }) => {
  return ptyManager.getCwd(id)
})

// ---- Bookmarks IPC ----
ipcMain.handle('bookmarks:get', () => {
  return getStore().get('bookmarks')
})

ipcMain.handle('bookmarks:set', (event, bookmarks) => {
  getStore().set('bookmarks', bookmarks)
})

// ---- Sidebar State IPC ----
ipcMain.handle('sidebar:getState', () => {
  return {
    width: getStore().get('sidebarWidth'),
    collapsed: getStore().get('sidebarCollapsed'),
  }
})

ipcMain.handle('sidebar:setState', (event, state) => {
  if (state.width !== undefined) getStore().set('sidebarWidth', state.width)
  if (state.collapsed !== undefined) getStore().set('sidebarCollapsed', state.collapsed)
})

// ---- Native Dialogs & Shell IPC ----
ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Directory to Bookmark',
    buttonLabel: 'Bookmark Directory',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('shell:openPath', async (event, dirPath) => {
  if (dirPath) {
    shell.openPath(dirPath)
  }
})
