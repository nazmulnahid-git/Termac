// Narrow, typed bridge between the renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('termac', {
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    ack: (id, bytes) => ipcRenderer.send('pty:ack', id, bytes),
    release: (id) => ipcRenderer.send('pty:release', id),
    cwd: (id) => ipcRenderer.invoke('pty:cwd', id),
    onData: on('pty:data'),
    onExit: on('pty:exit'),
    onProc: on('pty:proc'),
  },
  state: {
    load: () => ipcRenderer.invoke('state:load'),
    save: (s) => ipcRenderer.send('state:save', s),
    onChanged: on('state:changed'),
  },
  scrollback: {
    save: (id, data) => ipcRenderer.invoke('scrollback:save', id, data),
    load: (id) => ipcRenderer.invoke('scrollback:load', id),
    remove: (id) => ipcRenderer.invoke('scrollback:delete', id),
  },
  library: {
    add: (entry, ansi) => ipcRenderer.invoke('library:add', entry, ansi),
    search: (q) => ipcRenderer.invoke('library:search', q),
    content: (id) => ipcRenderer.invoke('library:content', id),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
  },
  sys: {
    sshHosts: () => ipcRenderer.invoke('sys:sshHosts'),
    gitBranch: (cwd) => ipcRenderer.invoke('sys:gitBranch', cwd),
    detectImports: () => ipcRenderer.invoke('sys:detectImports'),
    isDir: (p) => ipcRenderer.invoke('sys:isDir', p),
    chooseDir: (p) => ipcRenderer.invoke('sys:chooseDir', p),
    reveal: (p) => ipcRenderer.send('sys:reveal', p),
    openExternal: (url) => ipcRenderer.send('sys:openExternal', url),
    notify: (n) => ipcRenderer.send('sys:notify', n),
    confirm: (o) => ipcRenderer.invoke('sys:confirm', o),
  },
  app: {
    popupMenu: (items) => ipcRenderer.invoke('menu:popup', items),
    setMenu: (bindings) => ipcRenderer.send('app:setMenu', bindings),
    setHotkey: (accel) => ipcRenderer.invoke('app:setHotkey', accel),
    focusMain: () => ipcRenderer.send('app:focusMain'),
    quitReady: () => ipcRenderer.send('app:quitReady'),
    quitCancel: () => ipcRenderer.send('app:quitCancel'),
    onMenu: on('menu:action'),
    onWillQuit: on('app:willQuit'),
    onJumpTo: on('app:jumpTo'),
    onAdopt: on('session:adopt'),
  },
  quick: {
    hide: () => ipcRenderer.send('quick:hide'),
    promote: (p) => ipcRenderer.invoke('quick:promote', p),
    onVisibility: on('quick:visibility'),
  },
});
