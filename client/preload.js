'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bfw', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  probe: (baseUrl) => ipcRenderer.invoke('probe', baseUrl),
  connect: (baseUrl) => ipcRenderer.invoke('connect', baseUrl),
  togglePin: (next) => ipcRenderer.invoke('observer:togglePin', next),
  toggleFullscreen: () => ipcRenderer.invoke('observer:fullscreen'),
  closeObserver: () => ipcRenderer.invoke('observer:close'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onObserverState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('observer:state', listener);
    return () => ipcRenderer.removeListener('observer:state', listener);
  },
  onReconnect: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('ui:reconnect', listener);
    return () => ipcRenderer.removeListener('ui:reconnect', listener);
  },
});
