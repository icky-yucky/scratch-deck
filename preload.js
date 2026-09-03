'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Context isolation is on, node integration is off and the renderer is sandboxed, so the
// page gets exactly this surface and nothing else — no fs, no require, no ipcRenderer.
// Every call is a named operation the main process validates before touching disk.
contextBridge.exposeInMainWorld('loopAPI', {
  list: () => ipcRenderer.invoke('loops:list'),
  save: (name, data) => ipcRenderer.invoke('loops:save', name, data),
  rename: (from, to) => ipcRenderer.invoke('loops:rename', from, to),
  remove: (name) => ipcRenderer.invoke('loops:delete', name),
  reveal: () => ipcRenderer.invoke('loops:reveal'),
  dir: () => ipcRenderer.invoke('loops:dir'),
  // Reading goes through a URL the page fetches rather than an ArrayBuffer cloned across
  // IPC, so a long file streams instead of existing several times over at once. The main
  // process still resolves the name inside the loops folder before serving it.
  url: (name) => 'app://scratchdeck/__loop__/' + encodeURIComponent(name)
});

contextBridge.exposeInMainWorld('audioAPI', {
  open: () => ipcRenderer.invoke('audio:open')
});
