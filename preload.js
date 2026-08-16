const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  setInteractive: v => ipcRenderer.send('set-interactive', !!v),
  dragWindow: (dx, dy) => ipcRenderer.send('drag-window', dx, dy),
  adjustScale: d => ipcRenderer.send('adjust-scale', d),
  setScale: v => ipcRenderer.send('set-scale', v),
  setResizeMode: v => ipcRenderer.send('set-resize-mode', !!v),
  setCalibrating: v => ipcRenderer.send('set-calibrating', !!v),
  setCameraState: v => ipcRenderer.send('camera-state', !!v),
  chatSend: text => ipcRenderer.invoke('chat-send', text),
  chatState: () => ipcRenderer.invoke('chat-state'),
  chatGetConfig: () => ipcRenderer.invoke('chat-get-config'),
  chatSaveConfig: cfg => ipcRenderer.invoke('chat-save-config', cfg),
  chatTts: text => ipcRenderer.invoke('chat-tts', text),
  chatGetHistory: () => ipcRenderer.invoke('chat-get-history'),
  chatClearHistory: () => ipcRenderer.invoke('chat-clear-history'),
  voiceStt: buf => ipcRenderer.invoke('voice-stt', buf),
  voiceSttReady: () => ipcRenderer.invoke('voice-stt-ready'),
  setTtsActive: v => ipcRenderer.send('set-tts-active', !!v),
  reportAspect: a => ipcRenderer.send('report-aspect', a),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  smokeResult: (ok, msg) => ipcRenderer.send('smoke-result', !!ok, String(msg || '')),
  on: (channel, cb) => {
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
