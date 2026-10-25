'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (fn) => {
  const handler = (e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('textream', {
  // Editor
  getState: () => ipcRenderer.invoke('editor:state'),
  updateDoc: (patch) => ipcRenderer.send('doc:update', patch),
  start: (index) => ipcRenderer.invoke('session:start', index),
  stop: () => ipcRenderer.send('session:stop'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (file) => ipcRenderer.invoke('file:openPath', file),
  saveFile: () => ipcRenderer.invoke('file:save'),
  saveFileAs: () => ipcRenderer.invoke('file:saveAs'),
  newFile: () => ipcRenderer.invoke('file:new'),
  downloadModel: (id) => ipcRenderer.invoke('models:download', id),
  removeModel: (id) => ipcRenderer.invoke('models:remove', id),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onDoc: listen('doc'),
  onDocMeta: listen('docMeta'),
  onSettings: listen('settings'),
  onModels: listen('models'),
  onLan: listen('lan'),
  onDisplays: listen('displays'),
  onSession: listen('session'),

  // Prompter views
  initPrompter: () => ipcRenderer.invoke('prompter:init'),
  control: (cmd, arg) => ipcRenderer.send('prompter:control', cmd, arg),
  sendAudio: (level, samples) => ipcRenderer.send('prompter:audio', level, samples),
  micError: (message) => ipcRenderer.send('prompter:micError', message),
  onContent: listen('content'),
  onTick: listen('tick'),
  onStyle: listen('style'),
});
