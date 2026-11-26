// Preload des onglets. Il est chargé pour toutes les pages, mais n'expose
// son API QUE sur les pages internes explora:// : les sites web n'y ont
// pas accès. Le processus principal revérifie de toute façon l'origine de
// chaque message (isInternalSender).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'explora:') {
  const call = (action, ...args) => ipcRenderer.invoke('internal', action, ...args);

  contextBridge.exposeInMainWorld('customNav', {
    getConfig: () => call('get-config'),
    setEngines: (list) => call('set-engines', list),
    resetEngines: () => call('reset-engines'),
    setActiveEngine: (id) => call('set-active-engine', id),
    setHomepage: (homepage) => call('set-homepage', homepage),
    setTheme: (theme) => call('set-theme', theme),
    setRestoreTabs: (on) => call('set-restore-tabs', on),
    setFavorites: (list) => call('set-favorites', list),
    clearBrowsingData: () => call('clear-browsing-data'),
    newPrivateWindow: () => call('new-private-window'),
    // recherche depuis la page d'accueil (newTab : ouvrir dans un nouvel onglet)
    search: (text, engineId, newTab) => call('search', text, engineId, newTab),
    // newTab : true (nouvel onglet) ou 'background' (sans l'afficher)
    open: (url, newTab) => call('open', url, newTab),
    // historique de navigation
    historyList: (opts) => call('history-list', opts),
    historyRemove: (ids) => call('history-remove', ids),
    historyClear: (range) => call('history-clear', range),
    // gestionnaire de favoris
    bookmarks: {
      get: () => call('bookmarks-get'),
      addLink: (data) => call('bookmarks-add-link', data),
      addFolder: (data) => call('bookmarks-add-folder', data),
      update: (id, data) => call('bookmarks-update', id, data),
      remove: (id) => call('bookmarks-remove', id),
      move: (id, parentId, index) => call('bookmarks-move', id, parentId, index),
      importSources: () => call('bookmarks-import-sources'),
      importFrom: (browserId) => call('bookmarks-import', browserId),
      setShowBar: (on) => call('bookmarks-set-show-bar', on),
      onChange: (cb) => ipcRenderer.on('internal:bookmarks', (_e, state) => cb(state)),
    },
    // extensions Chrome
    extensions: {
      list: () => call('extensions-list'),
      remove: (id) => call('extensions-remove', id),
      checkUpdates: () => call('extensions-update'),
      openWebStore: () => call('open-web-store'),
      openOptions: (id) => call('open-extension-options', id),
      onChange: (cb) => ipcRenderer.on('internal:extensions', (_e, list) => cb(list)),
    },
    // bloqueur de pub
    adblock: {
      status: () => call('adblock-status'),
      setEnabled: (on) => call('adblock-set-enabled', on),
      setAllowed: (host, allowed) => call('adblock-set-allowed', host, allowed),
      updateLists: () => call('adblock-update'),
      onChange: (cb) => ipcRenderer.on('internal:adblock', (_e, s) => cb(s)),
    },
    // serveur MCP
    mcp: {
      status: () => call('mcp-status'),
      setEnabled: (on) => call('mcp-set-enabled', on),
      regenerateToken: () => call('mcp-regenerate-token'),
      onChange: (cb) => ipcRenderer.on('internal:mcp', (_e, s) => cb(s)),
    },
    // barre latérale (messageries et sites intégrés)
    sidebar: {
      get: () => call('sidebar-get'),
      add: (data) => call('sidebar-add', data),
      update: (id, patch) => call('sidebar-update', id, patch),
      remove: (id) => call('sidebar-remove', id),
      move: (id, delta) => call('sidebar-move', id, delta),
      setVisible: (on) => call('sidebar-set-visible', on),
      onChange: (cb) => ipcRenderer.on('internal:sidebar', (_e, s) => cb(s)),
    },
    // traduction intégrée (langues téléchargées sur le PC)
    translation: {
      status: () => call('translation-status'),
      install: (code) => call('translation-install', code),
      remove: (code) => call('translation-remove', code),
      setTarget: (code) => call('translation-set-target', code),
      setAlways: (code, on) => call('translation-set-always', code, on),
      onChange: (cb) => ipcRenderer.on('internal:translation', (_e, s) => cb(s)),
    },
    // client mail (page customnav://mail/ uniquement, revérifié côté principal)
    mail: location.hostname === 'mail' ? {
      call: (action, ...args) => ipcRenderer.invoke('mail', action, ...args),
      onEvent: (cb) => ipcRenderer.on('internal:mail', (_e, ev) => cb(ev)),
    } : undefined,
    onConfig: (cb) => ipcRenderer.on('internal:config', (_e, config) => cb(config)),
  });
}
