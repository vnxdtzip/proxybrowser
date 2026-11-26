// Ponte segura entre o processo principal e a UI (contextIsolation ligado).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pb', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  checkExit: () => ipcRenderer.invoke('check-exit'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: patch => ipcRenderer.invoke('set-settings', patch),
  relaunch: () => ipcRenderer.invoke('relaunch-app')
});
