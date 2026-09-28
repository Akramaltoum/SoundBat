// Lets the main process tell the splash screen when the app is ready
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', {
  onReady: (cb) => ipcRenderer.once('splash:ready', () => cb()),
});
