// Pont entre la liste de suggestions (suggest.html) et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggest', {
  onRender: (cb) => ipcRenderer.on('suggest:render', (_e, data) => cb(data)),
  // newTab : ouvrir dans un nouvel onglet (clic molette ou Ctrl+clic)
  pick: (index, newTab) => ipcRenderer.send('suggest-popup:pick', index, !!newTab),
});
