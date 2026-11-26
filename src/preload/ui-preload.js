// Pont sécurisé entre l'interface (renderer) et le processus principal.
// Seule cette API limitée est exposée : pas d'accès à Node dans la page.
const { contextBridge, ipcRenderer } = require('electron');

// Boutons des extensions Chrome (<browser-action-list>), seulement dans la
// fenêtre normale : les fenêtres privées n'ont pas d'extensions.
if (new URLSearchParams(location.search).get('private') !== '1') {
  require('electron-chrome-extensions/browser-action').injectBrowserAction();
}

contextBridge.exposeInMainWorld('nav', {
  // onglets / navigation
  newTab: (input) => ipcRenderer.send('tabs:new', input),
  closeTab: (id) => ipcRenderer.send('tabs:close', id),
  activateTab: (id) => ipcRenderer.send('tabs:activate', id),
  tabContextMenu: (id, x, y) => ipcRenderer.send('tabs:context-menu', id, x, y),
  // groupes d'onglets
  toggleGroup: (id) => ipcRenderer.send('groups:toggle', id),
  renameGroup: (id, title) => ipcRenderer.send('groups:rename', id, title),
  groupContextMenu: (id, x, y) => ipcRenderer.send('groups:context-menu', id, x, y),
  onRenameGroup: (cb) => ipcRenderer.on('ui:rename-group', (_e, id) => cb(id)),
  go: (input) => ipcRenderer.send('nav:go', input),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  stop: () => ipcRenderer.send('nav:stop'),
  getState: () => ipcRenderer.invoke('tabs:get-state'),
  // écran partagé
  toggleSplit: () => ipcRenderer.send('split:toggle'),
  splitResizeStart: (index) => ipcRenderer.send('split:resize-start', index),
  splitReset: () => ipcRenderer.send('split:reset'),
  getSplitLayout: () => ipcRenderer.invoke('split:get-layout'),
  onSplitLayout: (cb) => ipcRenderer.on('split:layout', (_e, layout) => cb(layout)),
  onState: (cb) => ipcRenderer.on('tabs:state', (_e, state) => cb(state)),
  onFocusAddress: (cb) => ipcRenderer.on('ui:focus-address', () => cb()),
  setChromeHeight: (px) => ipcRenderer.send('ui:chrome-height', px),
  setTitlebarColors: (color, symbolColor) => ipcRenderer.send('ui:titlebar-colors', color, symbolColor),
  openSettings: () => ipcRenderer.send('ui:open-settings'),
  openHistory: () => ipcRenderer.send('ui:open-history'),
  newPrivateWindow: () => ipcRenderer.send('ui:new-private-window'),
  appMenu: (x, y) => ipcRenderer.send('ui:app-menu', x, y),
  openExtensions: () => ipcRenderer.send('ui:open-extensions'),
  // bloqueur de pub
  getAdblock: () => ipcRenderer.invoke('adblock:get-state'),
  onAdblock: (cb) => ipcRenderer.on('adblock:state', (_e, state) => cb(state)),
  adblockMenu: (x, y) => ipcRenderer.send('adblock:menu', x, y),

  // moteurs de recherche / IA
  getEngines: () => ipcRenderer.invoke('engines:get-state'),
  onEngines: (cb) => ipcRenderer.on('engines:state', (_e, state) => cb(state)),
  setEngine: (id) => ipcRenderer.send('engines:set-active', id),
  // favoris
  getBookmarks: () => ipcRenderer.invoke('bookmarks:get-state'),
  onBookmarks: (cb) => ipcRenderer.on('bookmarks:state', (_e, state) => cb(state)),
  toggleBookmark: () => ipcRenderer.send('bookmarks:toggle'),
  openBookmark: (id, newTab) => ipcRenderer.send('bookmarks:open', id, newTab),
  manageBookmarks: () => ipcRenderer.send('bookmarks:manage'),
  bookmarkFolderMenu: (id, x, y) => ipcRenderer.send('bookmarks:folder-menu', id, x, y),
  bookmarkOverflowMenu: (ids, x, y) => ipcRenderer.send('bookmarks:overflow-menu', ids, x, y),
  bookmarkContextMenu: (id, x, y) => ipcRenderer.send('bookmarks:context-menu', id, x, y),

  // suggestions de la barre d'adresse
  suggestLocal: (text) => ipcRenderer.invoke('suggest:local', text),
  suggestRemote: (text) => ipcRenderer.invoke('suggest:remote', text),
  showSuggestions: (data) => ipcRenderer.send('suggest:show', data),
  hideSuggestions: () => ipcRenderer.send('suggest:hide'),
  onSuggestionPick: (cb) => ipcRenderer.on('suggest:pick', (_e, pick) => cb(pick)),

  resendTo: (id, fallbackQuery) => ipcRenderer.send('engines:resend', id, fallbackQuery),
  onResendShortcut: (cb) => ipcRenderer.on('ui:resend', (_e, id) => cb(id)),
});
