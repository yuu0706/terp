const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terp', {
  // サンドボックスの preload では os を読めないため、本体から受け取る
  home: ipcRenderer.sendSync('home'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  onConfig: (fn) => ipcRenderer.on('config', (_e, config) => fn(config)),
  createPty:(opts) => ipcRenderer.invoke('pty:create', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (fn) => ipcRenderer.on('pty:data', (_e, id, data) => fn(id, data)),
  onExit: (fn) => ipcRenderer.on('pty:exit', (_e, id, code) => fn(id, code)),
  onInfo: (fn) => ipcRenderer.on('pty:info', (_e, info) => fn(info)),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, action, arg) => fn(action, arg)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
