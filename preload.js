'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Context isolation is on and node integration is off, so the renderer gets exactly this
// surface and nothing else — no fs, no require, no ipcRenderer. Every call is a named
// operation the main process validates before touching disk.
contextBridge.exposeInMainWorld('loopAPI', {
  list: () => ipcRenderer.invoke('loops:list'),
  save: (name, data) => ipcRenderer.invoke('loops:save', name, data),
  read: (name) => ipcRenderer.invoke('loops:read', name),
  rename: (from, to) => ipcRenderer.invoke('loops:rename', from, to),
  remove: (name) => ipcRenderer.invoke('loops:delete', name),
  reveal: () => ipcRenderer.invoke('loops:reveal'),
  dir: () => ipcRenderer.invoke('loops:dir')
});

contextBridge.exposeInMainWorld('audioAPI', {
  open: () => ipcRenderer.invoke('audio:open')
});
