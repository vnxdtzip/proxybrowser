// Ponte segura entre o processo principal e a UI (contextIsolation ligado).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pb', {
  getConfig: () => ipcRenderer.invoke('get-config')
});
