const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('termac', {
  // PTY
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  writePty: (opts) => ipcRenderer.invoke('pty:write', opts),
  resizePty: (opts) => ipcRenderer.invoke('pty:resize', opts),
  destroyPty: (opts) => ipcRenderer.invoke('pty:destroy', opts),
  getCwd: (opts) => ipcRenderer.invoke('pty:getCwd', opts),

  onPtyData: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },

  onPtyExit: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke('bookmarks:get'),
  setBookmarks: (bookmarks) => ipcRenderer.invoke('bookmarks:set', bookmarks),

  // Sidebar
  getSidebarState: () => ipcRenderer.invoke('sidebar:getState'),
  setSidebarState: (state) => ipcRenderer.invoke('sidebar:setState', state),

  // Native Utilities
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
})
