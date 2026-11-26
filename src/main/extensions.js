// Extensions Chrome, uniquement dans la session normale (persist:main) :
//   - electron-chrome-extensions complète ce qu'Electron sait faire nativement
//     (chrome.tabs, chrome.windows, boutons d'extension et leurs popups,
//     chrome.contextMenus, chrome.cookies…) ;
//   - electron-chrome-web-store rend le bouton « Ajouter à Chrome » du Chrome
//     Web Store fonctionnel et met les extensions à jour.
// Les fenêtres privées n'ont pas d'extensions (comme Chrome par défaut).
const { app, dialog, session } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension, updateExtensions } = require('electron-chrome-web-store');
const { isResendExtension } = require('./resend');

const WEB_STORE_URL = 'https://chromewebstore.google.com/';

let extensions = null;
let extSession = null;
let ready = false;

// Résumé lisible des permissions demandées par une extension
const PERMISSION_LABELS = {
  '<all_urls>': 'lire et modifier toutes les pages',
  tabs: 'voir les onglets ouverts',
  history: "lire l'historique",
  bookmarks: 'lire les favoris',
  cookies: 'lire et modifier les cookies',
  downloads: 'gérer les téléchargements',
  clipboardRead: 'lire le presse-papiers',
  clipboardWrite: 'écrire dans le presse-papiers',
  webRequest: 'observer les requêtes réseau',
  declarativeNetRequest: 'bloquer ou modifier des requêtes réseau',
  storage: 'stocker des données',
  notifications: 'afficher des notifications',
  nativeMessaging: 'communiquer avec des programmes installés sur le PC',
};

function describePermissions(manifest) {
  const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  const out = new Set();
  for (const p of perms) {
    if (typeof p !== 'string') continue;
    if (PERMISSION_LABELS[p]) out.add(PERMISSION_LABELS[p]);
    else if (p.includes('://') || p.startsWith('*')) out.add(p === '*://*/*' ? PERMISSION_LABELS['<all_urls>'] : `accéder à ${p}`);
  }
  return [...out];
}

// Confirmation avant l'installation depuis le Chrome Web Store
async function beforeInstall({ localizedName, manifest, icon, browserWindow }) {
  const perms = describePermissions(manifest);
  const detail = [
    perms.length ? `Elle pourra :\n• ${perms.join('\n• ')}` : "Elle ne demande pas d'autorisation particulière.",
    '',
    "Explora n'est pas Chrome : certaines extensions ne fonctionnent qu'en partie, voire pas du tout.",
  ].join('\n');
  const options = {
    type: 'question',
    title: 'Ajouter une extension',
    message: `Ajouter « ${localizedName} » ?`,
    detail,
    icon,
    buttons: ['Ajouter l’extension', 'Annuler'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = browserWindow ? await dialog.showMessageBox(browserWindow, options) : await dialog.showMessageBox(options);
  return { action: response === 0 ? 'allow' : 'deny' };
}

// À appeler une fois l'app prête, avant la création des fenêtres.
// `impl` fournit la création / sélection / fermeture d'onglets pour chrome.tabs.
async function init(partition, impl) {
  extSession = session.fromPartition(partition);
  extensions = new ElectronChromeExtensions({ session: extSession, ...impl });
  // icônes des boutons d'extension : interface (session par défaut) et page interne
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
  ElectronChromeExtensions.handleCRXProtocol(extSession);
  try {
    await installChromeWebStore({ session: extSession, beforeInstall, autoUpdate: true });
  } catch (e) {
    console.error('Chrome Web Store indisponible :', e);
  }
  ready = true;
}

const isExtensionSession = (ses) => !!extSession && ses === extSession;

function addTab(webContents, win) {
  if (extensions && isExtensionSession(webContents.session)) extensions.addTab(webContents, win);
}

function selectTab(webContents) {
  if (extensions && isExtensionSession(webContents.session)) extensions.selectTab(webContents);
}

function removeTab(webContents) {
  if (extensions && isExtensionSession(webContents.session) && !webContents.isDestroyed()) extensions.removeTab(webContents);
}

// Éléments ajoutés au clic droit par les extensions (chrome.contextMenus)
function contextMenuItems(webContents, params) {
  if (!extensions || !isExtensionSession(webContents.session)) return [];
  try {
    return extensions.getContextMenuItems(webContents, params);
  } catch {
    return [];
  }
}

function optionsUrl(ext) {
  const page = ext.manifest.options_ui?.page || ext.manifest.options_page;
  return page ? `chrome-extension://${ext.id}/${page.replace(/^\//, '')}` : null;
}

// Liste affichée dans explora://extensions/
function list() {
  if (!extSession) return [];
  return extSession.extensions.getAllExtensions().filter((ext) => !isResendExtension(ext)).map((ext) => ({
    id: ext.id,
    name: ext.name,
    version: ext.version,
    description: ext.manifest.description || '',
    manifestVersion: ext.manifest.manifest_version,
    icon: `crx://extension-icon/${ext.id}/32/2`,
    optionsUrl: optionsUrl(ext),
    fromWebStore: !!ext.path && ext.path.includes(app.getPath('userData')),
  }));
}

async function remove(id) {
  const ext = extSession?.extensions.getExtension(id);
  if (!ext || isResendExtension(ext)) return { error: 'Extension introuvable.' };
  try {
    await uninstallExtension(id, { session: extSession });
  } catch (e) {
    return { error: `Impossible de supprimer l'extension : ${e.message || e}` };
  }
  return {};
}

async function checkUpdates() {
  if (!extSession) return { error: 'Extensions non initialisées.' };
  try {
    await updateExtensions(extSession);
  } catch (e) {
    return { error: `Mise à jour impossible : ${e.message || e}` };
  }
  return {};
}

module.exports = {
  WEB_STORE_URL, init, addTab, selectTab, removeTab, contextMenuItems, list, remove, checkUpdates,
  isReady: () => ready,
  onChange(cb) {
    if (!extSession) return;
    extSession.extensions.on('extension-loaded', cb);
    extSession.extensions.on('extension-unloaded', cb);
  },
};
