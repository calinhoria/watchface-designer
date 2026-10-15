const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  openBinDialog: () => ipcRenderer.invoke('open-bin-dialog'),
  openBinPath: (p) => ipcRenderer.invoke('open-bin-path', p),
  compileBin: (payload) => ipcRenderer.invoke('compile-bin', payload),
  exportProject: (payload) => ipcRenderer.invoke('export-project', payload),
});
