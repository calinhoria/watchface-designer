const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  openBinDialog: () => ipcRenderer.invoke('open-bin-dialog'),
  openBinPath: (p) => ipcRenderer.invoke('open-bin-path', p),
  openProject: () => ipcRenderer.invoke('open-project'),
  openProjectPath: (dir) => ipcRenderer.invoke('open-project-path', dir),
  recentList: () => ipcRenderer.invoke('recent-list'),
  compileBin: (payload) => ipcRenderer.invoke('compile-bin', payload),
  exportProject: (payload) => ipcRenderer.invoke('export-project', payload),
});
