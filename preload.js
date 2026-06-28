const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onInit: (cb) => ipcRenderer.on('init', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, data) => cb(data)),
  addColor: (color) => ipcRenderer.send('palette:add', color),
  removeColor: (index) => ipcRenderer.send('palette:remove', index),
  resetColors: () => ipcRenderer.send('palette:reset'),
  update: (data) => ipcRenderer.send('note:update', data),
  newNote: () => ipcRenderer.send('note:new'),
  deleteNote: (id) => ipcRenderer.send('note:delete', id),
  pinNote: (id, pinned) => ipcRenderer.send('note:pin', { id, pinned }),
  search: {
    list: () => ipcRenderer.invoke('search:list'),
    focus: (id) => ipcRenderer.send('search:focus', id),
    close: () => ipcRenderer.send('search:close'),
  },
});
