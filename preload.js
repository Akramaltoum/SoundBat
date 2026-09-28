// Gives the panel its own window buttons (the window has no system frame)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appWindow', {
  minimize: () => ipcRenderer.send('win', 'minimize'),
  maximize: () => ipcRenderer.send('win', 'maximize'),
  close: () => ipcRenderer.send('win', 'close'),
  restart: () => ipcRenderer.send('app:restart'),
  focus: () => ipcRenderer.send('win', 'focus'),
  clipToken: () => ipcRenderer.invoke('setup:clip-token'),
  onUpdateReady: (cb) => ipcRenderer.on('app:update-ready', () => cb()),
});
