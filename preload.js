const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  openBinDialog: () => ipcRenderer.invoke('open-bin-dialog'),
  openBinPath: (p) => ipcRenderer.invoke('open-bin-path', p),
  openProject: () => ipcRenderer.invoke('open-project'),
  openProjectPath: (dir) => ipcRenderer.invoke('open-project-path', dir),
  recentList: () => ipcRenderer.invoke('recent-list'),
  deviceCatalog: () => ipcRenderer.invoke('device-catalog'),
  deviceInfo: () => ipcRenderer.invoke('device-info'),
  pickFont: () => ipcRenderer.invoke('pick-font'),
  fontSave: (payload) => ipcRenderer.invoke('fonts-save', payload),
  fontsList: () => ipcRenderer.invoke('fonts-list'),
  compileBin: (payload) => ipcRenderer.invoke('compile-bin', payload),
  exportProject: (payload) => ipcRenderer.invoke('export-project', payload),
});
