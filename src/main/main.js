const path = require('path');
const { app, BrowserWindow, Menu, clipboard, ipcMain, nativeTheme, session, webContents: allWebContents } = require('electron');
const { TabManager, PARTITION, GROUP_COLORS } = require('./tabs');
const { getEngines, getEngine, iconFor, buildEngineTarget, resolveInput, isHttpUrl } = require('./search');
const internal = require('./internal');
const messengers = require('./messengers');
const config = require('./config');
const history = require('./history');
const bookmarks = require('./bookmarks');
const extensions = require('./extensions');
const adblock = require('./adblock');
const resend = require('./resend');
const mcp = require('./mcp');
const googleLogin = require('./google-login');

const mail = require('./mail');

const { migrateUserData, upgradeLegacyUrl } = require('./migrate');


// Hauteur initiale de l'interface ; l'interface envoie ensuite sa vraie hauteur.
const CHROME_HEIGHT = 80;

// Dossier des réglages et sessions : toujours %APPDATA%\Explora, que l'app
// soit lancée avec npm start (nom du package « explora ») ou installée.
app.setPath('userData', path.join(app.getPath('appData'), 'Explora'));
// Ancien nom « Custom Nav » : copie %APPDATA%\custom-nav vers le nouveau dossier,
// avant tout accès aux réglages ou aux partitions (cookies, connexions).
migrateUserData(path.join(app.getPath('appData'), 'custom-nav'), app.getPath('userData'));

const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

// User-agent sans « Electron/x » ni le nom de l'app : certains sites (Google,
// Gemini…) refusent la connexion ou dégradent la page pour un UA Electron.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(/\sExplora\/\S+/gi, '');
// Pages de connexion Google : user-agent Firefox (voir google-login.js).
googleLogin.init();

internal.registerScheme([resend.schemePrivileges]);

// Notifications Windows (WhatsApp, Discord…) : sans identifiant d'application,
// les notifications ne s'affichent pas quand l'app est lancée depuis les sources.
if (process.platform === 'win32') app.setAppUserModelId('com.vanix38.explora');

// Une entrée par fenêtre ouverte : { win, tabs, isPrivate, partition }.
// Il y a au plus une fenêtre normale (celle dont les onglets sont rouverts au
// lancement suivant) et autant de fenêtres privées que l'on veut.
const windows = new Set();
let mainCtx = null; // la fenêtre normale, si elle est ouverte
let privateCount = 0;

const activeEngineId = () => config.getConfig().activeEngine;

function sendToUi(ctx, channel, payload) {
  if (ctx && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload);
}

function sendToAllUis(channel, payload) {
  for (const ctx of windows) sendToUi(ctx, channel, payload);
}

// Fenêtre à laquelle appartient un webContents (interface ou onglet)
function ctxFor(webContents) {
  for (const ctx of windows) {
    if (ctx.win.webContents === webContents || ctx.tabs.tabFor(webContents)) return ctx;
  }
  return null;
}

function enginesState() {
  return {
    activeId: activeEngineId(),
    engines: getEngines().map((e) => ({ id: e.id, name: e.name, type: e.type, icon: iconFor(e) })),
  };
}

// Configuration envoyée aux pages internes (avec les icônes pour l'affichage)
function internalConfig() {
  const cfg = config.getConfig();
  return { ...cfg, engines: cfg.engines.map((e) => ({ ...e, icon: iconFor(e) })) };
}

function applyTheme() {
  nativeTheme.themeSource = config.getConfig().theme; // pilote aussi prefers-color-scheme des pages
}

// Après chaque modification des réglages : tout le monde se met à jour
function configChanged() {
  applyTheme();
  sendToAllUis('engines:state', enginesState());
  for (const ctx of windows) ctx.tabs.broadcastInternal('internal:config', internalConfig());
}

function setActiveEngine(id) {
  config.setActiveEngine(id);
  configChanged();
}

// « Renvoyer vers » : la question est posée à un autre moteur, dans un nouvel
// onglet. Question = texte en cours de saisie dans la barre d'adresse s'il y en
// a un, sinon la dernière question mémorisée pour l'onglet courant.
function resendTo(ctx, engineId, typed) {
  const query = (typed || ctx.tabs.active()?.query || '').trim();
  ctx.tabs.create({ ...buildEngineTarget(getEngine(engineId), query), query: query || null });
}

// Écran partagé : ouvre un panneau à droite (barre d'adresse prête, comme
// pour un nouvel onglet), ou ferme l'écran partagé de l'onglet actif
function toggleSplit(ctx) {
  const wasSplit = !!ctx.tabs.splitOf(ctx.tabs.activeId);
  ctx.tabs.toggleSplit();
  if (!wasSplit) {
    ctx.win.webContents.focus();
    sendToUi(ctx, 'ui:focus-address');
  }
}

function openSettings(ctx) {
  ctx.tabs.focusOrCreate(config.SETTINGS_PAGE);
}

function openHistory(ctx) {
  ctx.tabs.focusOrCreate(config.HISTORY_PAGE);
}

// Client mail : toujours dans la fenêtre normale (pas de courrier en navigation privée)
function openMail(ctx) {
  const target = ctx && !ctx.isPrivate ? ctx : createWindow({ restore: false });
  target.tabs.focusOrCreate(mail.PAGE);
  if (target.win.isMinimized()) target.win.restore();
  target.win.focus();
}

function newTab(ctx) {
  ctx.tabs.create();
  ctx.win.webContents.focus();
  sendToUi(ctx, 'ui:focus-address');
}

// --- Favoris ---
function bookmarksState() {
  return { tree: bookmarks.getTree(), showBar: config.getConfig().showBookmarksBar };
}

// Après chaque modification des favoris : barres et pages internes à jour
function bookmarksChanged() {
  const state = bookmarksState();
  sendToAllUis('bookmarks:state', state);
  for (const ctx of windows) ctx.tabs.broadcastInternal('internal:bookmarks', state);
}

// Ctrl+D / étoile : ajoute la page courante aux favoris, ou l'en retire
function toggleBookmark(ctx) {
  const tab = ctx.tabs.active();
  if (!tab || !isHttpUrl(tab.url)) return;
  if (bookmarks.findByUrl(tab.url)) bookmarks.removeUrl(tab.url);
  else bookmarks.addLink({ title: tab.title, url: tab.url });
  bookmarksChanged();
}

function toggleBookmarksBar() {
  config.setShowBookmarksBar(!config.getConfig().showBookmarksBar);
  bookmarksChanged();
}

function openBookmarksManager(ctx) {
  ctx.tabs.focusOrCreate(config.BOOKMARKS_PAGE);
}

function openBookmark(ctx, node, inNewTab) {
  if (!node || node.type !== 'link' || !isHttpUrl(node.url)) return;
  if (inNewTab) ctx.tabs.create(node.url, { activate: false });
  else ctx.tabs.navigate(node.url);
}

function openAllInFolder(ctx, folder) {
  for (const n of folder.children) if (n.type === 'link') ctx.tabs.create(n.url, { activate: false });
}

// Éléments de menu natif pour une liste de favoris (sous-menus pour les dossiers)
function bookmarkMenuItems(ctx, nodes) {
  if (nodes.length === 0) return [{ label: '(vide)', enabled: false }];
  return nodes.map((n) => {
    const label = (n.title || n.url || '').replace(/&/g, '&&').slice(0, 80);
    if (n.type === 'folder') {
      const links = n.children.filter((c) => c.type === 'link').length;
      return {
        label,
        submenu: [
          ...bookmarkMenuItems(ctx, n.children),
          ...(links ? [{ type: 'separator' }, { label: `Tout ouvrir (${links})`, click: () => openAllInFolder(ctx, n) }] : []),
        ],
      };
    }
    return { label: label || n.url, click: (_item, _win, e) => openBookmark(ctx, n, e?.ctrlKey) };
  });
}

function popupMenu(ctx, template, x, y) {
  Menu.buildFromTemplate(template).popup({ window: ctx.win, x: Math.round(x), y: Math.round(y) });
}

function bookmarkContextMenu(ctx, node) {
  const remove = { label: 'Supprimer', click: () => { bookmarks.remove(node.id); bookmarksChanged(); } };
  const manage = { label: 'Gérer les favoris…', click: () => openBookmarksManager(ctx) };
  if (node.type === 'folder') {
    const links = node.children.filter((c) => c.type === 'link').length;
    return [
      { label: `Tout ouvrir (${links})`, enabled: links > 0, click: () => openAllInFolder(ctx, node) },
      { type: 'separator' }, manage, remove,
    ];
  }
  return [
    { label: 'Ouvrir', click: () => openBookmark(ctx, node, false) },
    { label: 'Ouvrir dans un nouvel onglet', click: () => openBookmark(ctx, node, true) },
    { type: 'separator' }, manage, remove,
  ];
}

// Ctrl+chiffre / Ctrl+Shift+chiffre : on lit `code` (Digit1…) et non `key`,
// pour que ça marche aussi en AZERTY où les chiffres demandent Shift.
function digitIndex(input) {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(input.code || '');
  return m ? Number(m[1]) - 1 : -1;
}

// Raccourcis clavier, interceptés à la fois dans l'interface et dans les pages
function handleShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    const ctx = ctxFor(webContents);
    if (ctx) runShortcut(ctx, event, input);
  });
}

function runShortcut(ctx, event, input) {
  if (input.type !== 'keyDown') return;
  const { tabs } = ctx;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const digit = digitIndex(input);
  const engines = getEngines();
  let handled = true;

  if (ctrl && digit >= 0 && digit < engines.length) {
    if (input.shift) {
      // passe par l'interface, qui connaît le texte en cours de saisie
      sendToUi(ctx, 'ui:resend', engines[digit].id);
    } else {
      setActiveEngine(engines[digit].id);
    }
  } else if (ctrl && input.shift && key === 's') {
    toggleSplit(ctx);
  } else if (ctrl && input.shift && key === 'm') {
    messengers.toggleRail();
  } else if (ctrl && input.shift && key === 'n') {
    createWindow({ isPrivate: true });
  } else if (ctrl && !input.shift && key === 'n') {
    openNormalWindow();
  } else if (key === 'f12' || (ctrl && input.shift && key === 'i')) {
    tabs.toggleDevTools();
  } else if (ctrl && !input.shift && key === 'd') {
    toggleBookmark(ctx);
  } else if (ctrl && input.shift && key === 'b') {
    toggleBookmarksBar();
  } else if (ctrl && input.shift && key === 'o') {
    openBookmarksManager(ctx);
  } else if (ctrl && !input.shift && key === 't') {
    newTab(ctx);
  } else if (ctrl && key === 'w') {
    tabs.close();
  } else if (ctrl && key === 'l') {
    ctx.win.webContents.focus();
    sendToUi(ctx, 'ui:focus-address');
  } else if (ctrl && key === ',') {
    openSettings(ctx);
  } else if (ctrl && input.shift && key === 'e') {
    openMail(ctx);
  } else if (ctrl && !input.shift && key === 'h') {
    openHistory(ctx);
  } else if (key === 'f5' || (ctrl && key === 'r')) {
    tabs.reload();
  } else if (input.alt && key === 'arrowleft') {
    tabs.goBack();
  } else if (input.alt && key === 'arrowright') {
    tabs.goForward();
  } else if (ctrl && key === 'tab') {
    // les onglets des groupes repliés sont sautés
    const visible = tabs.order.filter((t) => t === tabs.activeId || tabs.isVisible(t));
    const i = visible.indexOf(tabs.activeId);
    const n = visible.length;
    tabs.activate(visible[(i + (input.shift ? n - 1 : 1)) % n]);
  } else {
    handled = false;
  }
  if (handled) event.preventDefault();
}

// --- Session : onglets rouverts au prochain lancement ---
// Seule la fenêtre normale est enregistrée : rien de ce qui se passe dans une
// fenêtre privée n'est écrit sur le disque.
let saveTimer = null;
function saveSessionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessionNow, 1000);
}
function saveSessionNow() {
  clearTimeout(saveTimer);
  if (!mainCtx) return;
  config.saveSession(config.getConfig().restoreTabs ? mainCtx.tabs.snapshot() : null);
}

function openInitialTabs(ctx, restore) {
  const last = restore && config.getConfig().restoreTabs ? config.getLastSession() : null;
  const saved = (last?.tabs || []).map((t) => ({ ...t, url: upgradeLegacyUrl(t.url) })).filter((t) => isHttpUrl(t.url) || internal.isInternalUrl(t.url));
  if (saved.length === 0) {
    newTab(ctx);
    return;
  }
  const ids = saved.map((t) => ctx.tabs.create({ url: t.url, query: t.query }, { activate: false }));
  // groupes d'onglets
  (Array.isArray(last.groups) ? last.groups : []).forEach((g, gi) => {
    const members = ids.filter((_id, i) => saved[i].group === gi);
    if (members.length && g) ctx.tabs.createGroup(members, { title: g.title || '', color: g.color, collapsed: !!g.collapsed });
  });
  // indices de l'enregistrement -> onglets rouverts (les adresses invalides sont sautées)
  const byIndex = new Map(saved.map((t, i) => [last.tabs.indexOf(t), ids[i]]));
  // écrans partagés
  for (const sp of Array.isArray(last.splits) ? last.splits : []) {
    if (!Array.isArray(sp?.tabs)) continue;
    ctx.tabs.restoreSplit(sp.tabs.map((i) => byIndex.get(i)).filter(Boolean), sp.sizes);
  }
  // l'onglet actif : de préférence un onglet visible (hors groupe replié)
  let active = byIndex.get(last.active || 0) ?? ids[ids.length - 1];
  if (!ctx.tabs.isVisible(active)) active = ids.find((id) => ctx.tabs.isVisible(id)) ?? active;
  ctx.tabs.activate(active);
}

// Barre de titre intégrée : les onglets sont sur la même ligne que les boutons
// Windows (réduire, agrandir, fermer), dessinés par le système par-dessus
// l'interface avec les couleurs de la barre d'onglets.
const TITLEBAR_HEIGHT = 36; // = --tabbar-height dans styles.css

function titleBarOverlay(isPrivate) {
  const dark = nativeTheme.shouldUseDarkColors;
  let color = dark ? '#1e1f24' : '#dfe1e6';
  if (isPrivate) color = dark ? '#221c30' : '#dcd5ee';
  return { color, symbolColor: dark ? '#e6e7eb' : '#1d1e22', height: TITLEBAR_HEIGHT };
}

const windowBackground = (isPrivate) => {
  if (isPrivate) return nativeTheme.shouldUseDarkColors ? '#221c30' : '#dcd5ee';
  return nativeTheme.shouldUseDarkColors ? '#1e1f24' : '#e9eaee';
};

// Ctrl+N : ramène la fenêtre normale (ou la rouvre si elle a été fermée)
function openNormalWindow() {
  if (!mainCtx) {
    createWindow({ restore: false });
    return;
  }
  if (mainCtx.win.isMinimized()) mainCtx.win.restore();
  mainCtx.win.focus();
}

// Fenêtre normale (session persistante `persist:main`) ou privée : session en
// mémoire seulement (pas de préfixe « persist: »), propre à la fenêtre et vidée
// dès sa fermeture ; ses onglets ne sont jamais enregistrés.
function createWindow({ isPrivate = false, restore = true } = {}) {
  if (!isPrivate && mainCtx) {
    openNormalWindow();
    return mainCtx;
  }
  const partition = isPrivate ? `private-${Date.now()}-${++privateCount}` : PARTITION;
  if (isPrivate) internal.handleProtocol(session.fromPartition(partition));

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    title: isPrivate ? 'Explora – Navigation privée' : 'Explora',
    icon: APP_ICON,
    backgroundColor: windowBackground(isPrivate),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(isPrivate),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // L'interface (fichier local, jamais de contenu web) a besoin d'un preload
      // non sandboxé pour charger <browser-action-list> depuis node_modules.
      // Les onglets, eux, restent sandboxés.
      sandbox: false,
    },
  });
  win.setMenu(null);
  // L'interface ne doit jamais quitter index.html
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const tabs = new TabManager(win, {
    topOffset: CHROME_HEIGHT,
    partition,
    // en privé, toujours la page d'accueil interne (elle affiche le bandeau « privé »)
    getHomeUrl: () => (isPrivate ? config.HOME_PAGE : config.homeUrl()),
    onWebContentsCreated: (wc, { devtools = false } = {}) => {
      handleShortcuts(wc);
      if (!devtools) handleContextMenu(wc); // les outils ont leur propre clic droit
      else resend.attachDevTools(wc);
    },
  });
  adblock.addSession(session.fromPartition(partition)); // pubs bloquées aussi en privé
  resend.addSession(session.fromPartition(partition)); // onglet « Renvoyer » des DevTools
  const ctx = { win, tabs, isPrivate, partition };
  windows.add(ctx);
  if (!isPrivate) mainCtx = ctx;

  tabs.on('state', (state) => {
    sendToUi(ctx, 'tabs:state', state);
    if (!isPrivate) saveSessionSoon();
  });
  // écran partagé : l'interface dessine les séparateurs entre les pages
  tabs.on('split-layout', (layout) => sendToUi(ctx, 'split:layout', layout));
  if (!isPrivate) tabs.on('split-resized', saveSessionSoon);
  // Les onglets de la session normale sont visibles des extensions (chrome.tabs)
  tabs.on('tab-created', (tab) => extensions.addTab(tab.view.webContents, win));
  tabs.on('tab-activated', (tab) => extensions.selectTab(tab.view.webContents));
  tabs.on('tab-closed', (tab) => extensions.removeTab(tab.view.webContents));

  // Historique : seulement la fenêtre normale, rien n'est écrit en navigation privée
  if (!isPrivate) {
    tabs.on('visit', (tab, { inPage }) => {
      tab.historyId = history.addVisit(tab.url, inPage ? tab.title : '');
    });
    tabs.on('title', (tab) => history.setTitle(tab.historyId, tab.url, tab.title));
  }

  handleShortcuts(win.webContents);
  // Barre des messageries (WhatsApp, Discord) : fenêtre normale uniquement
  if (!isPrivate) {
    messengers.onSettingsChange((state) => {
    for (const c of windows) c.tabs.broadcastInternal('internal:sidebar', state);
  });
  messengers.attach({
      win,
      tabs,
      openInTab: (url) => tabs.create(url),
      onShortcut: (event, input) => runShortcut(ctx, event, input),
    });
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: isPrivate ? { private: '1' } : {},
  });
  win.webContents.once('did-finish-load', () => openInitialTabs(ctx, !isPrivate && restore));

  if (!isPrivate) win.on('close', saveSessionNow);
  win.on('closed', () => {
    windows.delete(ctx);
    if (mainCtx === ctx) mainCtx = null;
    if (isPrivate) {
      const ses = session.fromPartition(partition);
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
      ses.clearAuthCache().catch(() => {});
      adblock.removeSession(ses);
    }
  });
  return ctx;
}

nativeTheme.on('updated', () => {
  for (const ctx of windows) {
    if (ctx.win.isDestroyed()) continue;
    ctx.win.setBackgroundColor(windowBackground(ctx.isPrivate));
  }
});

// --- IPC : actions venant de l'interface (barre d'onglets / d'outils) ---
// Ces canaux ne sont exposés qu'au preload de l'interface : on vérifie quand
// même que l'expéditeur est bien l'interface d'une de nos fenêtres.
const fromUi = (handler) => (event, ...args) => {
  for (const ctx of windows) {
    if (event.sender === ctx.win.webContents) return handler(ctx, ...args);
  }
  return undefined;
};

ipcMain.on('tabs:new', fromUi((ctx, input) => {
  if (input) ctx.tabs.create(resolveInput(input, activeEngineId()));
  else newTab(ctx);
}));
ipcMain.on('tabs:close', fromUi(({ tabs }, id) => tabs.close(id)));
ipcMain.on('tabs:activate', fromUi(({ tabs }, id) => tabs.activate(id)));
// Clic droit sur un onglet
ipcMain.on('tabs:context-menu', fromUi((ctx, id, x, y) => {
  const { tabs } = ctx;
  const i = tabs.order.indexOf(id);
  if (i < 0) return;
  const tab = tabs.tabs.get(id);
  const others = tabs.order.filter((t) => t !== id);
  const right = tabs.order.slice(i + 1);
  const left = tabs.order.slice(0, i);
  // « Ajouter l'onglet au groupe » : nouveau groupe ou un groupe existant
  const otherGroups = [...tabs.groups.values()].filter((g) => g.id !== tab.groupId);
  const newGroup = () => {
    const gid = tabs.createGroup([id]);
    if (gid) renameGroupInUi(ctx, gid); // on propose tout de suite de le nommer
  };
  const groupItems = otherGroups.length
    ? [{
        label: "Ajouter l'onglet au groupe",
        submenu: [
          { label: 'Nouveau groupe', click: newGroup },
          { type: 'separator' },
          ...otherGroups.map((g) => ({ label: groupLabel(tabs, g), click: () => tabs.addToGroup([id], g.id) })),
        ],
      }]
    : [{ label: "Ajouter l'onglet à un nouveau groupe", click: newGroup }];
  if (tab.groupId) groupItems.push({ label: 'Retirer du groupe', click: () => tabs.removeFromGroup([id]) });
  // écran partagé
  const split = [];
  const group = tabs.splitOf(id);
  if (id !== tabs.activeId && tabs.canSplitWith(id)) {
    split.push({ label: "Afficher à côté de l'onglet actif", click: () => tabs.splitWith(id) });
  }
  if (group) {
    split.push(
      { label: "Retirer de l'écran partagé", click: () => tabs.removeFromSplit(id) },
      { label: 'Inverser les panneaux', click: () => tabs.swapSplit(id) },
      { label: "Fermer l'écran partagé", click: () => tabs.unsplit(id) },
    );
  } else if (id === tabs.activeId) {
    split.push({ label: 'Ouvrir un écran partagé', accelerator: 'Ctrl+Shift+S', click: () => toggleSplit(ctx) });
  }
  Menu.buildFromTemplate([
    { label: 'Nouvel onglet', click: () => newTab(ctx) },
    { label: 'Recharger', click: () => tab.view.webContents.reload() },
    { label: 'Dupliquer', enabled: isHttpUrl(tab.url) || internal.isInternalUrl(tab.url), click: () => tabs.create({ url: tab.url, query: tab.query }, { groupId: tab.groupId }) },
    { type: 'separator' },
    ...groupItems,
    { type: 'separator' },
    ...(split.length ? [...split, { type: 'separator' }] : []),
    { label: 'Fermer', accelerator: 'Ctrl+W', click: () => tabs.close(id) },
    { label: 'Fermer les autres onglets', enabled: others.length > 0, click: () => { tabs.closeMany(others); tabs.activate(id); } },
    { label: 'Fermer les onglets à droite', enabled: right.length > 0, click: () => tabs.closeMany(right) },
    { label: 'Fermer les onglets à gauche', enabled: left.length > 0, click: () => tabs.closeMany(left) },
  ]).popup({ window: ctx.win, x: Math.round(x), y: Math.round(y) });
}));

// --- Groupes d'onglets ---
// Nom affiché d'un groupe dans les menus (sans nom : couleur + nombre d'onglets)
function groupLabel(tabs, g) {
  if (g.title) return g.title;
  const color = GROUP_COLORS.find((c) => c.id === g.color)?.name || 'Groupe';
  const n = tabs.groupTabIds(g.id).length;
  return `${color} (${n} onglet${n > 1 ? 's' : ''})`;
}

// Champ de saisie du nom dans l'étiquette du groupe (l'interface prend le focus clavier)
function renameGroupInUi(ctx, gid) {
  ctx.win.webContents.focus();
  sendToUi(ctx, 'ui:rename-group', gid);
}

ipcMain.on('groups:toggle', fromUi(({ tabs }, gid) => tabs.toggleGroupCollapsed(gid)));
ipcMain.on('groups:rename', fromUi(({ tabs }, gid, title) => {
  if (typeof title === 'string') tabs.updateGroup(gid, { title });
}));
// Clic droit sur l'étiquette d'un groupe
ipcMain.on('groups:context-menu', fromUi((ctx, gid, x, y) => {
  const { tabs } = ctx;
  const group = tabs.groups.get(gid);
  if (!group) return;
  popupMenu(ctx, [
    { label: 'Renommer le groupe…', click: () => renameGroupInUi(ctx, gid) },
    {
      label: 'Couleur',
      submenu: GROUP_COLORS.map((c) => ({
        label: c.name,
        type: 'radio',
        checked: group.color === c.id,
        click: () => tabs.updateGroup(gid, { color: c.id }),
      })),
    },
    { type: 'separator' },
    { label: 'Nouvel onglet dans le groupe', click: () => {
      tabs.create(undefined, { groupId: gid });
      ctx.win.webContents.focus();
      sendToUi(ctx, 'ui:focus-address');
    } },
    { label: group.collapsed ? 'Déplier le groupe' : 'Replier le groupe', click: () => tabs.toggleGroupCollapsed(gid) },
    { label: 'Dissocier le groupe', click: () => tabs.ungroup(gid) },
    { type: 'separator' },
    { label: 'Fermer le groupe', click: () => tabs.closeGroup(gid) },
  ], x, y);
}));

// Écran partagé : bouton de la barre d'outils et séparateurs
ipcMain.on('split:toggle', fromUi((ctx) => toggleSplit(ctx)));
ipcMain.on('split:resize-start', fromUi(({ tabs }, index) => {
  if (Number.isInteger(index)) tabs.startResize(index);
}));
ipcMain.on('split:reset', fromUi(({ tabs }) => tabs.resetSplitSizes()));
ipcMain.handle('split:get-layout', fromUi(({ tabs }) => tabs.splitLayout));
ipcMain.on('nav:go', fromUi(({ tabs }, input) => tabs.navigate(resolveInput(input, activeEngineId()))));
ipcMain.on('nav:back', fromUi(({ tabs }) => tabs.goBack()));
ipcMain.on('nav:forward', fromUi(({ tabs }) => tabs.goForward()));
ipcMain.on('nav:reload', fromUi(({ tabs }) => tabs.reload()));
ipcMain.on('nav:stop', fromUi(({ tabs }) => tabs.stop()));
ipcMain.on('ui:chrome-height', fromUi(({ tabs }, px) => {
  if (Number.isFinite(px) && px > 0) tabs.setTopOffset(Math.round(px));
}));
// L'interface envoie les couleurs réellement affichées de sa barre d'onglets :
// les boutons Windows prennent exactement les mêmes (thème clair / sombre / privé)
const HEX = /^#[0-9a-f]{6}$/i;
ipcMain.on('ui:titlebar-colors', fromUi((ctx, color, symbolColor) => {
  if (HEX.test(color) && HEX.test(symbolColor)) {
    ctx.win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  }
}));
// Menu ☰ en haut à droite (aligné sur le bord droit du bouton)
const APP_MENU_WIDTH = 270;
ipcMain.on('ui:app-menu', fromUi((ctx, x, y) => {
  Menu.buildFromTemplate([
    { label: 'Nouvel onglet', accelerator: 'Ctrl+T', click: () => newTab(ctx) },
    { label: 'Nouvelle fenêtre privée', accelerator: 'Ctrl+Shift+N', click: () => createWindow({ isPrivate: true }) },
    { label: 'Écran partagé', type: 'checkbox', checked: !!ctx.tabs.splitOf(ctx.tabs.activeId), accelerator: 'Ctrl+Shift+S', click: () => toggleSplit(ctx) },
    { type: 'separator' },
    { label: 'Historique', accelerator: 'Ctrl+H', click: () => openHistory(ctx) },
    { label: 'Favoris', accelerator: 'Ctrl+Shift+O', click: () => openBookmarksManager(ctx) },
    { label: mail.totalUnseen() ? `Courrier (${mail.totalUnseen()} non lus)` : 'Courrier', accelerator: 'Ctrl+Shift+E', click: () => openMail(ctx) },
    { label: 'Extensions', click: () => ctx.tabs.focusOrCreate(config.EXTENSIONS_PAGE) },
    ...(ctx.isPrivate ? [] : [{ label: 'Barre latérale', accelerator: 'Ctrl+Shift+M', click: () => messengers.toggleRail() }]),
    { label: 'Outils de développement', accelerator: 'F12', click: () => ctx.tabs.toggleDevTools() },
    { type: 'separator' },
    { label: 'Paramètres', accelerator: 'Ctrl+,', click: () => openSettings(ctx) },
  ]).popup({ window: ctx.win, x: Math.max(0, Math.round(x) - APP_MENU_WIDTH), y: Math.round(y) });
}));
ipcMain.on('ui:open-settings', fromUi((ctx) => openSettings(ctx)));
ipcMain.on('ui:open-history', fromUi((ctx) => openHistory(ctx)));
ipcMain.on('ui:new-private-window', fromUi(() => createWindow({ isPrivate: true })));
// --- Serveur MCP ---
function mcpChanged() {
  for (const ctx of windows) ctx.tabs.broadcastInternal('internal:mcp', mcp.status());
}

// --- Bloqueur de pub : bouton bouclier ---
function adblockChanged() {
  sendToAllUis('adblock:state', adblock.status());
  for (const ctx of windows) ctx.tabs.broadcastInternal('internal:adblock', adblock.status());
}

function adblockMenu(ctx, x, y) {
  const tab = ctx.tabs.active();
  const url = tab?.url || '';
  const host = adblock.hostOf(url);
  const st = adblock.status();
  const allowed = host && adblock.isAllowed(url);
  const reload = () => tab?.view.webContents.reload();
  const items = [
    { label: !st.enabled ? 'Bloqueur de pub désactivé' : allowed ? `Pubs autorisées sur ${host}` : `${tab?.blocked || 0} élément(s) bloqué(s) sur cette page`, enabled: false },
    { type: 'separator' },
  ];
  if (host && st.enabled) {
    items.push(allowed
      ? { label: `Bloquer à nouveau sur ${host}`, click: () => { adblock.setAllowed(host, false); adblockChanged(); reload(); } }
      : { label: `Autoriser les pubs sur ${host}`, click: () => { adblock.setAllowed(host, true); adblockChanged(); reload(); } });
  }
  items.push(
    st.enabled
      ? { label: 'Désactiver le bloqueur partout', click: () => { adblock.setEnabled(false); adblockChanged(); reload(); } }
      : { label: 'Activer le bloqueur', click: () => { adblock.setEnabled(true); adblockChanged(); reload(); } },
    { type: 'separator' },
    { label: 'Réglages du bloqueur…', click: () => ctx.tabs.focusOrCreate(config.SETTINGS_PAGE) },
  );
  Menu.buildFromTemplate(items).popup({ window: ctx.win, x: Math.round(x), y: Math.round(y) });
}

ipcMain.handle('adblock:get-state', fromUi(() => adblock.status()));
ipcMain.on('adblock:menu', fromUi((ctx, x, y) => adblockMenu(ctx, x, y)));
ipcMain.on('ui:open-extensions', fromUi((ctx) => ctx.tabs.focusOrCreate(config.EXTENSIONS_PAGE)));
ipcMain.on('engines:set-active', fromUi((_ctx, id) => setActiveEngine(id)));
ipcMain.on('engines:resend', fromUi((ctx, id, typed) => resendTo(ctx, id, typed)));
ipcMain.handle('tabs:get-state', fromUi(({ tabs }) => tabs.getState()));
ipcMain.handle('engines:get-state', fromUi(() => enginesState()));

ipcMain.handle('bookmarks:get-state', fromUi(() => bookmarksState()));
ipcMain.on('bookmarks:toggle', fromUi((ctx) => toggleBookmark(ctx)));
ipcMain.on('bookmarks:open', fromUi((ctx, id, inNewTab) => openBookmark(ctx, bookmarks.getNode(id), !!inNewTab)));
ipcMain.on('bookmarks:manage', fromUi((ctx) => openBookmarksManager(ctx)));
// Menus natifs : dossier de la barre, favoris qui ne tiennent pas (»), clic droit
ipcMain.on('bookmarks:folder-menu', fromUi((ctx, id, x, y) => {
  const node = bookmarks.getNode(id);
  if (node?.type !== 'folder') return;
  const links = node.children.filter((c) => c.type === 'link').length;
  popupMenu(ctx, [
    ...bookmarkMenuItems(ctx, node.children),
    ...(links ? [{ type: 'separator' }, { label: `Tout ouvrir (${links})`, click: () => openAllInFolder(ctx, node) }] : []),
  ], x, y);
}));
ipcMain.on('bookmarks:overflow-menu', fromUi((ctx, ids, x, y) => {
  const nodes = (Array.isArray(ids) ? ids : []).map((id) => bookmarks.getNode(id)).filter(Boolean);
  popupMenu(ctx, bookmarkMenuItems(ctx, nodes), x, y);
}));
ipcMain.on('bookmarks:context-menu', fromUi((ctx, id, x, y) => {
  const node = bookmarks.getNode(id);
  if (node) popupMenu(ctx, bookmarkContextMenu(ctx, node), x, y);
}));

// --- IPC : pages internes (accueil, réglages) ---
const INTERNAL_ACTIONS = {
  'set-engines': (list) => config.setEngines(list),
  'reset-engines': () => config.resetEngines(),
  'set-active-engine': (id) => config.setActiveEngine(id),
  'set-homepage': (homepage) => config.setHomepage(homepage),
  'set-theme': (theme) => config.setTheme(theme),
  'set-restore-tabs': (on) => {
    const r = config.setRestoreTabs(on);
    saveSessionNow();
    return r;
  },
  'set-favorites': (list) => config.setFavorites(list),
  'history-list': (opts) => history.list(opts || {}),
  'history-remove': (ids) => history.remove(ids),
  'history-clear': (range) => history.clear(range),
  // gestionnaire de favoris (explora://bookmarks/)
  'bookmarks-get': () => bookmarksState(),
  'bookmarks-add-link': (data) => bookmarks.addLink(data),
  'bookmarks-add-folder': (data) => bookmarks.addFolder(data),
  'bookmarks-update': (id, data) => bookmarks.update(id, data),
  'bookmarks-remove': (id) => bookmarks.remove(id),
  'bookmarks-move': (id, parentId, index) => bookmarks.move(id, parentId, index),
  'bookmarks-import-sources': () => bookmarks.importSources(),
  'bookmarks-import': (browserId) => bookmarks.importFrom(browserId),
  'bookmarks-set-show-bar': (on) => config.setShowBookmarksBar(on),
  // extensions (explora://extensions/)
  'extensions-list': () => extensions.list(),
  'extensions-remove': (id) => extensions.remove(String(id)),
  'extensions-update': () => extensions.checkUpdates(),
  // bloqueur de pub (réglages)
  'adblock-status': () => adblock.status(),
  'adblock-set-enabled': (on) => adblock.setEnabled(on),
  'adblock-set-allowed': (host, allowed) => adblock.setAllowed(String(host || ''), !!allowed),
  'adblock-update': () => adblock.updateLists(),
  // serveur MCP (pilotage par une IA)
  'mcp-status': () => mcp.status(),
  'mcp-set-enabled': (on) => mcp.setEnabled(on),
  'mcp-regenerate-token': () => mcp.regenerateToken(),
  // barre latérale (messageries et sites intégrés)
  'sidebar-get': () => messengers.settingsState(),
  'sidebar-add': (data) => messengers.addItem(data || {}),
  'sidebar-update': (id, patch) => messengers.updateItem(String(id || ''), patch || {}),
  'sidebar-remove': (id) => messengers.removeItem(String(id || '')),
  'sidebar-move': (id, delta) => messengers.moveItem(String(id || ''), Number(delta) || 0),
  'sidebar-set-visible': (on) => messengers.setRailVisible(!!on),
  'clear-browsing-data': async () => {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData(); // cookies, localStorage, IndexedDB, service workers…
    await ses.clearCache();
    await ses.clearAuthCache();
    return { ok: true };
  },
};
const CHANGES_CONFIG = new Set(['set-engines', 'reset-engines', 'set-active-engine', 'set-homepage', 'set-theme', 'set-restore-tabs', 'set-favorites']);

ipcMain.handle('internal', async (event, action, ...args) => {
  const ctx = ctxFor(event.sender);
  if (!internal.isInternalSender(event) || !ctx) throw new Error('Accès refusé');
  const { tabs } = ctx;
  const tab = tabs.tabFor(event.sender);

  if (action === 'get-config') return { ...internalConfig(), isPrivate: ctx.isPrivate };
  if (action === 'open-web-store') {
    if (ctx.isPrivate) openNormalWindow();
    (mainCtx || ctx).tabs.create(extensions.WEB_STORE_URL);
    return {};
  }
  if (action === 'open-extension-options') {
    const ext = extensions.list().find((x) => x.id === args[0]);
    if (!ext?.optionsUrl) return { error: "Cette extension n'a pas de page d'options." };
    if (ctx.isPrivate) openNormalWindow();
    (mainCtx || ctx).tabs.create(ext.optionsUrl);
    return {};
  }
  if (action === 'new-private-window') {
    createWindow({ isPrivate: true });
    return {};
  }
  if (action === 'search') {
    const [text, engineId, newTab] = args;
    const target = resolveInput(String(text || ''), engineId || activeEngineId());
    if (newTab || !tab) tabs.create(target);
    else tabs.navigate(target, tab);
    return {};
  }
  if (action === 'open') {
    const url = String(args[0] || '');
    if (!isHttpUrl(url)) return { error: 'Adresse invalide.' };
    if (args[1] || !tab) tabs.create(url, { activate: args[1] !== 'background' });
    else tabs.navigate(url, tab);
    return {};
  }

  const fn = INTERNAL_ACTIONS[action];
  if (!fn) throw new Error(`Action inconnue : ${action}`);
  const result = await fn(...args);
  if (CHANGES_CONFIG.has(action) && !result?.error) configChanged();
  if (action.startsWith('adblock-') && action !== 'adblock-status' && !result?.error) adblockChanged();
  if (action.startsWith('mcp-') && action !== 'mcp-status' && !result?.error) mcpChanged();
  if (action.startsWith('bookmarks-') && action !== 'bookmarks-get' && action !== 'bookmarks-import-sources' && !result?.error) {
    bookmarksChanged();
  }
  return result;
});

// --- Extensions : ce que chrome.tabs / chrome.windows font dans Explora ---
function tabFromWebContents(wc) {
  const ctx = ctxFor(wc);
  const tab = ctx?.tabs.tabFor(wc);
  return ctx && tab ? { ctx, tab } : null;
}

// Ouvre une URL d'extension dans la fenêtre normale (rouverte si besoin)
function createTabForExtension(details = {}) {
  const ctx = mainCtx || createWindow({ restore: false });
  const url = typeof details.url === 'string' && details.url ? details.url : config.homeUrl();
  const id = ctx.tabs.create(url, { activate: details.active !== false });
  return [ctx.tabs.tabs.get(id).view.webContents, ctx.win];
}

const extensionImpl = {
  createTab: async (details) => createTabForExtension(details),
  selectTab(wc) {
    const t = tabFromWebContents(wc);
    if (t) t.ctx.tabs.activate(t.tab.id);
  },
  removeTab(wc) {
    const t = tabFromWebContents(wc);
    if (t) t.ctx.tabs.close(t.tab.id);
  },
  // une seule fenêtre normale : chrome.windows.create ouvre un onglet dedans
  createWindow: async (details = {}) => {
    const urls = Array.isArray(details.url) ? details.url : [details.url];
    let win = mainCtx?.win;
    for (const url of urls) [, win] = createTabForExtension({ url });
    return win || mainCtx.win;
  },
  removeWindow() {
    // on ne laisse pas une extension fermer la fenêtre principale
  },
};

function extensionsChanged() {
  for (const ctx of windows) ctx.tabs.broadcastInternal('internal:extensions', extensions.list());
}

// Clic droit dans une page : lien, édition, sélection + éléments des extensions
function handleContextMenu(webContents) {
  webContents.on('context-menu', (_e, params) => {
    const ctx = ctxFor(webContents);
    if (!ctx) return;
    const items = [];
    if (params.linkURL && isHttpUrl(params.linkURL)) {
      items.push(
        { label: 'Ouvrir le lien dans un nouvel onglet', click: () => ctx.tabs.create(params.linkURL, { activate: false }) },
        { label: "Ouvrir le lien dans l'écran partagé", click: () => ctx.tabs.openInSplit(params.linkURL, ctx.tabs.tabFor(webContents)?.id ?? ctx.tabs.activeId) },
        { label: "Copier l'adresse du lien", click: () => clipboard.writeText(params.linkURL) },
      );
    }
    if (params.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'undo', label: 'Annuler' }, { type: 'separator' },
        { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' }, { role: 'selectAll', label: 'Tout sélectionner' });
    } else if (params.selectionText) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'copy', label: 'Copier' });
    }
    if (!items.length) {
      items.push(
        { label: 'Précédent', enabled: webContents.navigationHistory.canGoBack(), click: () => webContents.navigationHistory.goBack() },
        { label: 'Suivant', enabled: webContents.navigationHistory.canGoForward(), click: () => webContents.navigationHistory.goForward() },
        { label: 'Recharger', click: () => webContents.reload() },
      );
    }
    const extItems = extensions.contextMenuItems(webContents, params);
    if (extItems.length) items.push({ type: 'separator' }, ...extItems);
    items.push({ type: 'separator' }, { label: "Inspecter l'élément", click: () => ctx.tabs.inspectElement(webContents, params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: ctx.win });
  });
}

app.whenReady().then(async () => {
  config.load();
  internal.handleProtocol(session.fromPartition(PARTITION));
  applyTheme();
  // avant la première fenêtre : les extensions doivent connaître tous les onglets
  // le moteur se charge en arrière-plan (cache disque, sinon téléchargement) ;
  // les sessions déjà ouvertes sont protégées dès qu'il est prêt
  adblock.init({
    onBlockedRequest(webContentsId) {
      const wc = allWebContents.fromId(webContentsId);
      if (wc) ctxFor(wc)?.tabs.countBlocked(wc);
    },
  }).then(adblockChanged);
  await extensions.init(PARTITION, extensionImpl);
  // serveur MCP : l'IA ne voit que la fenêtre normale (jamais les fenêtres privées)
  mcp.init({
    getCtx: () => mainCtx || createWindow({ restore: false }),
    resolveInput: (input) => resolveInput(input, activeEngineId()),
    listEngines: () => getEngines().map((e) => ({ id: e.id, name: e.name, type: e.type === 'ai' ? 'IA' : 'moteur', active: e.id === activeEngineId() })),
    searchTarget(query, engineId) {
      if (engineId && !getEngines().some((e) => e.id === engineId)) return { error: `Moteur inconnu : ${engineId} (voir list_engines).` };
      return { ...buildEngineTarget(getEngine(engineId || activeEngineId()), query), query };
    },
    onStatusChange: mcpChanged,
  });
  extensions.onChange(extensionsChanged);

  // clic sur une notification de nouveau message : ouvre la page Courrier
  mail.init({ openPage: () => openMail(mainCtx) });

  // onglet « Renvoyer » des outils de développement (modifier et renvoyer une requête)
  await resend.init({
    isTab: (wc) => {
      const tab = ctxFor(wc)?.tabs.tabFor(wc);
      return !!tab && tab.view.webContents === wc;
    },
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  history.saveNow();
  mail.shutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
