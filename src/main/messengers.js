// Barre latérale (messageries et autres sites intégrés) : une barre verticale
// à gauche de la fenêtre normale, avec une icône par intégration. Un clic
// ouvre l'intégration dans un panneau ancré à côté de la barre (les onglets se
// décalent vers la droite) ; un second clic le referme.
//
// La liste se règle dans Paramètres > Barre latérale : intégrations prêtes à
// l'emploi (WhatsApp, Discord, Messenger, Telegram, Slack, Instagram,
// Spotify…) et sites personnalisés (nom + adresse + icône), dans l'ordre voulu.
//
// Chaque intégration activée tourne dans son propre WebContentsView, chargé au
// démarrage et gardé en vie quand le panneau est fermé : les messages
// arrivent, le badge de non-lus se met à jour et les notifications Windows
// s'affichent même quand on ne la regarde pas. Chacune a sa propre session
// persistante (`persist:messenger-<id>`), séparée de celle des onglets : on
// reste connecté entre les lancements, et « Effacer les données de
// navigation » ne déconnecte pas WhatsApp / Discord…

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, WebContentsView, Menu, dialog, session, nativeImage, ipcMain } = require('electron');

const RAIL_WIDTH = 48;
const WIDTHS = { narrow: 420, medium: 640, wide: 900 };
const WIDTH_LABELS = { narrow: 'Étroit', medium: 'Moyen', wide: 'Large', full: 'Toute la fenêtre' };
const MAX_ITEMS = 30;
const MAX_ICON_BYTES = 256 * 1024;

// Intégrations prêtes à l'emploi. `badge: false` : pas de compteur de non-lus
// (le titre de ces pages contient autre chose, ex. le morceau en cours).
const PRESETS = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/', color: '#25d366', width: 'medium' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', color: '#5865f2', width: 'wide' },
  { id: 'messenger', name: 'Messenger', url: 'https://www.messenger.com/', color: '#0866ff', width: 'medium' },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/', color: '#2aabee', width: 'medium' },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', color: '#4a154b', width: 'wide' },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/direct/inbox/', color: '#e1306c', width: 'medium' },
  { id: 'teams', name: 'Microsoft Teams', url: 'https://teams.microsoft.com/v2/', color: '#5b5fc7', width: 'wide' },
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/mail/', color: '#ea4335', width: 'wide' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.live.com/mail/', color: '#0f6cbd', width: 'wide' },
  { id: 'gcalendar', name: 'Google Agenda', url: 'https://calendar.google.com/', color: '#1a73e8', width: 'wide', badge: false },
  { id: 'x', name: 'X (Twitter)', url: 'https://x.com/messages', color: '#000000', width: 'medium' },
  { id: 'snapchat', name: 'Snapchat', url: 'https://web.snapchat.com/', color: '#fffc00', width: 'medium' },
  { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/messaging/', color: '#0a66c2', width: 'wide' },
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/', color: '#1db954', width: 'medium', badge: false },
  { id: 'deezer', name: 'Deezer', url: 'https://www.deezer.com/', color: '#a238ff', width: 'medium', badge: false },
  { id: 'ytmusic', name: 'YouTube Music', url: 'https://music.youtube.com/', color: '#ff0000', width: 'medium', badge: false },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f', width: 'medium', badge: false },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', color: '#d97757', width: 'medium', badge: false },
];
const DEFAULT_PRESETS = ['whatsapp', 'discord'];
const presetById = (id) => PRESETS.find((p) => p.id === id);

// Permissions accordées aux intégrations : notifications, micro / caméra (notes
// vocales, appels), presse-papiers, plein écran. Le reste est refusé.
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'speaker-selection',
]);

const partitionFor = (id) => `persist:messenger-${id}`;

function normalizeUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.href;
  } catch {
    return null;
  }
}

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);

// --- État enregistré (dans son propre fichier, pas dans settings.json) ---
// items : liste ordonnée de { id, preset, name, url, enabled, width, badge,
// icon (data: URL ou ''), customIcon (true si l'icône vient de l'utilisateur) }
const statePath = () => path.join(app.getPath('userData'), 'messengers.json');

function itemFromPreset(p, extra = {}) {
  return {
    id: p.id,
    preset: p.id,
    name: p.name,
    url: p.url,
    enabled: true,
    width: p.width,
    badge: p.badge !== false,
    icon: '',
    customIcon: false,
    ...extra,
  };
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
  const preset = presetById(raw.preset) ? raw.preset : null;
  const url = normalizeUrl(raw.url) || (preset ? presetById(preset).url : null);
  if (!url) return null;
  return {
    id,
    preset,
    name: cleanName(raw.name) || (preset ? presetById(preset).name : new URL(url).hostname),
    url,
    enabled: raw.enabled !== false,
    width: raw.width in WIDTHS || raw.width === 'full' ? raw.width : 'medium',
    badge: raw.badge !== false,
    icon: typeof raw.icon === 'string' && raw.icon.startsWith('data:image/') ? raw.icon : '',
    customIcon: !!raw.customIcon && typeof raw.icon === 'string' && raw.icon.startsWith('data:image/'),
  };
}

function defaultState() {
  return {
    railVisible: true,
    open: null, // intégration affichée dans le panneau, rouverte au lancement suivant
    items: DEFAULT_PRESETS.map((id) => itemFromPreset(presetById(id))),
  };
}

let state = null;
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    let items;
    if (Array.isArray(saved.items)) {
      const seen = new Set();
      items = saved.items.map(sanitizeItem).filter((it) => it && !seen.has(it.id) && seen.add(it.id));
    } else {
      // ancien format (WhatsApp + Discord seulement) : { whatsapp: { enabled, width }, … }
      items = DEFAULT_PRESETS.map((id) => {
        const s = saved.items?.[id] || {};
        return itemFromPreset(presetById(id), {
          enabled: s.enabled !== false,
          width: s.width in WIDTHS || s.width === 'full' ? s.width : presetById(id).width,
        });
      });
    }
    state = {
      railVisible: saved.railVisible !== false,
      open: items.some((it) => it.id === saved.open) ? saved.open : null,
      items: items.slice(0, MAX_ITEMS),
    };
  } catch {
    state = defaultState();
  }
}

function ensureState() {
  if (!state) loadState();
  return state;
}

const itemById = (id) => ensureState().items.find((it) => it.id === id);

let saveTimer = null;
function writeStateNow() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch {
    /* disque plein / dossier en lecture seule : on garde l'état en mémoire */
  }
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStateNow, 300);
}

// Prévenu à chaque changement de la liste (pour mettre à jour les Paramètres)
let changeListener = null;
function changed() {
  saveState();
  if (panel) panel.sync();
  if (changeListener) changeListener(settingsState());
}

// --- Sessions des intégrations (une seule fois par partition) ---
const preparedSessions = new Set();
function prepareSession(id) {
  if (preparedSessions.has(id)) return;
  preparedSessions.add(id);
  const ses = session.fromPartition(partitionFor(id));
  // Même user-agent que les onglets (Chrome sans « Electron/x ») : WhatsApp Web
  // affiche sinon « Mettez à jour votre navigateur ».
  ses.setUserAgent(app.userAgentFallback);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

// Télécharge une image et la renvoie en data: URL (icônes mises en cache dans
// messengers.json : la barre s'affiche tout de suite, même hors ligne).
async function fetchIcon(url, ses = session.defaultSession) {
  const res = await ses.fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_ICON_BYTES) throw new Error('taille');
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) {
    // certains serveurs renvoient les favicons en application/octet-stream
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new Error('pas une image');
    return img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
  }
  return `data:${type};base64,${buf.toString('base64')}`;
}

// Nombre de non-lus d'après le titre de la page :
// « (3) WhatsApp », « Boîte de réception (12) - Gmail », « Telegram (3) » ;
// « • Discord | … » ou « * Slack » : messages non lus sans compteur.
function unreadFromTitle(title) {
  const t = title || '';
  const m = /\((\d{1,4})\+?\)/.exec(t);
  if (m) return { count: Number(m[1]), dot: false };
  if (/^\s*[•●*!]/.test(t)) return { count: 0, dot: true };
  return { count: 0, dot: false };
}

class MessengerPanel {
  constructor({ win, tabs, openInTab, onShortcut }) {
    this.win = win;
    this.tabs = tabs;
    this.openInTab = openInTab;
    this.onShortcut = onShortcut;
    this.views = new Map(); // id -> { view, unread, url }
    this.openId = null;
    this.lastUnreadTotal = 0;

    this.rail = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'messengers-rail-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.rail.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'messengers.html'));
    this.rail.webContents.on('before-input-event', (e, input) => this.handleKeys(e, input));
    this.rail.webContents.once('did-finish-load', () => this.sendState());

    this.onResize = () => this.layout();
    this.onLayout = () => this.layout();
    win.on('resize', this.onResize);
    tabs.on('layout', this.onLayout);

    if (state.railVisible) win.contentView.addChildView(this.rail);
    this.sync();
    const open = itemById(state.open);
    if (open && open.enabled && state.railVisible) this.show(open.id, { focus: false });
    this.layout();
  }

  // Aligne les vues sur la liste enregistrée (ajouts, retraits, adresses)
  sync() {
    for (const [id, entry] of this.views) {
      const item = itemById(id);
      if (!item || !item.enabled) this.destroyView(id);
      else if (entry.url !== item.url) {
        entry.url = item.url;
        entry.view.webContents.loadURL(item.url).catch(() => {});
      }
    }
    for (const item of state.items) if (item.enabled) this.createView(item);
    if (this.openId && !this.views.has(this.openId)) this.hide();
    this.layout();
    this.sendState();
  }

  createView(item) {
    if (this.views.has(item.id)) return this.views.get(item.id);
    prepareSession(item.id);
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionFor(item.id),
        preload: path.join(__dirname, '..', 'preload', 'messenger-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // messages et notifications à l'heure, panneau fermé ou non
        spellcheck: true,
      },
    });
    const entry = { view, unread: { count: 0, dot: false }, url: item.url };
    this.views.set(item.id, entry);
    const wc = view.webContents;

    wc.on('page-title-updated', (_e, title) => {
      const it = itemById(item.id);
      entry.unread = it && it.badge ? unreadFromTitle(title) : { count: 0, dot: false };
      this.sendState();
    });
    // Icône du site, mise en cache (sauf si l'utilisateur en a choisi une)
    wc.on('page-favicon-updated', async (_e, favicons) => {
      const it = itemById(item.id);
      if (!it || it.customIcon || it.icon || !favicons[0]) return;
      try {
        it.icon = await fetchIcon(favicons[0], wc.session);
        changed();
      } catch {
        /* on garde la lettre */
      }
    });
    wc.on('before-input-event', (e, input) => this.handleKeys(e, input));

    // Liens (target=_blank) : nouvel onglet du navigateur, dans la session
    // normale. Les fenêtres surgissantes (connexion « avec Google »…) restent
    // dans la session de l'intégration pour que la connexion aboutisse.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window' && /^https:/i.test(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, parent: this.win },
        };
      }
      if (/^https?:/i.test(url)) this.openInTab(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => {
      if (!/^https?:/i.test(e.url)) e.preventDefault();
    });

    wc.loadURL(item.url).catch(() => {});
    return entry;
  }

  destroyView(id) {
    const entry = this.views.get(id);
    if (!entry) return;
    if (this.openId === id) this.hide();
    this.views.delete(id);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  // Ouvre / ferme le panneau d'une intégration
  toggle(id) {
    if (this.openId === id) this.hide();
    else this.show(id);
  }

  show(id, { focus = true } = {}) {
    const item = itemById(id);
    if (!item) return;
    if (!item.enabled) {
      item.enabled = true;
      changed();
    }
    if (!state.railVisible) this.setRailVisible(true);
    const entry = this.createView(item);
    if (this.openId && this.openId !== id) {
      const prev = this.views.get(this.openId);
      if (prev) this.win.contentView.removeChildView(prev.view);
    }
    this.openId = id;
    this.win.contentView.addChildView(entry.view);
    state.open = id;
    saveState();
    this.layout();
    if (focus) entry.view.webContents.focus();
    this.sendState();
  }

  hide() {
    if (!this.openId) return;
    const entry = this.views.get(this.openId);
    if (entry) this.win.contentView.removeChildView(entry.view);
    this.openId = null;
    state.open = null;
    saveState();
    this.layout();
    this.tabs.active()?.view.webContents.focus();
    this.sendState();
  }

  applyRailVisibility() {
    const attached = this.win.contentView.children.includes(this.rail);
    if (state.railVisible && !attached) this.win.contentView.addChildView(this.rail);
    if (!state.railVisible) {
      this.hide();
      if (attached) this.win.contentView.removeChildView(this.rail);
    }
    this.layout();
    this.sendState();
  }

  setRailVisible(visible) {
    setRailVisible(visible);
  }

  panelWidth(id, available) {
    const w = itemById(id)?.width || 'medium';
    if (w === 'full') return available;
    // laisse toujours au moins 320 px aux onglets
    return Math.max(0, Math.min(WIDTHS[w], available - 320));
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const top = this.tabs.topOffset;
    const h = Math.max(0, height - top);
    let left = 0;
    if (state.railVisible) {
      this.rail.setBounds({ x: 0, y: top, width: RAIL_WIDTH, height: h });
      left = RAIL_WIDTH;
    }
    if (this.openId) {
      const entry = this.views.get(this.openId);
      const w = this.panelWidth(this.openId, width - left);
      entry.view.setBounds({ x: left, y: top, width: w, height: h });
      left += w;
    }
    this.tabs.setLeftInset(left);
  }

  handleKeys(event, input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (ctrl && input.shift && key === 'm') {
      toggleRail();
      event.preventDefault();
    } else if (key === 'f5' || (ctrl && key === 'r')) {
      // recharge l'intégration affichée, pas l'onglet
      if (this.openId) this.views.get(this.openId)?.view.webContents.reload();
      event.preventDefault();
    } else if (ctrl && key === 'w') {
      // Ctrl+W dans une intégration referme le panneau, pas un onglet
      this.hide();
      event.preventDefault();
    } else if (this.onShortcut && !input.alt) {
      // autres raccourcis du navigateur (Ctrl+T, Ctrl+L, Ctrl+1…)
      this.onShortcut(event, input);
    }
  }

  // Menu du clic droit sur une icône de la barre (ou sur la barre elle-même)
  showContextMenu(id) {
    const item = itemById(id);
    const settingsItems = [
      { label: 'Gérer la barre latérale…', click: () => this.openInTab(SETTINGS_URL) },
      { label: 'Masquer la barre latérale (Ctrl+Shift+M)', click: () => setRailVisible(false) },
    ];
    if (!item) {
      Menu.buildFromTemplate(settingsItems).popup({ window: this.win });
      return;
    }
    const entry = this.views.get(id);
    const template = [
      { label: this.openId === id ? `Fermer ${item.name}` : `Ouvrir ${item.name}`, click: () => this.toggle(id) },
      { label: 'Recharger', enabled: !!entry, click: () => entry?.view.webContents.reload() },
      { type: 'separator' },
      {
        label: 'Largeur du panneau',
        submenu: Object.entries(WIDTH_LABELS).map(([value, label]) => ({
          label,
          type: 'radio',
          checked: item.width === value,
          click: () => updateItem(id, { width: value }),
        })),
      },
      { type: 'separator' },
      item.enabled
        ? { label: `Désactiver ${item.name}`, click: () => updateItem(id, { enabled: false }) }
        : { label: `Activer ${item.name}`, click: () => updateItem(id, { enabled: true }) },
      { label: 'Se déconnecter…', click: () => this.logout(item) },
      { type: 'separator' },
      ...settingsItems,
    ];
    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  async logout(item) {
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'question',
      buttons: ['Se déconnecter', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: `Se déconnecter de ${item.name}`,
      message: `Se déconnecter de ${item.name} ?`,
      detail: 'Les cookies et données locales de ce site dans la barre latérale seront effacés. '
        + 'Il faudra vous reconnecter (pour WhatsApp : rescanner le QR code).',
    });
    if (response !== 0) return;
    await clearItemData(item.id);
    const entry = this.views.get(item.id);
    if (entry) {
      entry.unread = { count: 0, dot: false };
      entry.view.webContents.loadURL(item.url).catch(() => {});
    }
    this.sendState();
  }

  // Clic sur une notification : on ramène la fenêtre et on ouvre le panneau.
  notificationClicked(webContents) {
    for (const [id, entry] of this.views) {
      if (entry.view.webContents === webContents) {
        if (this.win.isMinimized()) this.win.restore();
        this.win.show();
        this.win.focus();
        if (this.openId !== id) this.show(id);
        return;
      }
    }
  }

  ownsWebContents(wc) {
    if (wc === this.rail.webContents) return true;
    for (const entry of this.views.values()) if (entry.view.webContents === wc) return true;
    return false;
  }

  getState() {
    return {
      railVisible: state.railVisible,
      openId: this.openId,
      messengers: state.items.map((it) => {
        const entry = this.views.get(it.id);
        return {
          id: it.id,
          preset: it.preset,
          name: it.name,
          icon: it.icon,
          customIcon: it.customIcon,
          color: it.preset ? presetById(it.preset).color : null,
          enabled: it.enabled,
          unread: entry && it.badge ? entry.unread : { count: 0, dot: false },
        };
      }),
    };
  }

  sendState() {
    const s = this.getState();
    if (!this.rail.webContents.isDestroyed()) this.rail.webContents.send('messengers:state', s);

    // Barre des tâches : clignote quand un nouveau message arrive fenêtre en
    // arrière-plan (la pastille de nombre est dessinée par la barre, voir
    // setOverlay).
    const total = s.messengers.reduce((n, m) => n + (m.enabled ? m.unread.count : 0), 0);
    if (total > this.lastUnreadTotal && !this.win.isDestroyed() && !this.win.isFocused()) {
      this.win.flashFrame(true);
    }
    this.lastUnreadTotal = total;
  }

  setOverlay(dataUrl, description) {
    if (this.win.isDestroyed() || process.platform !== 'win32') return;
    const img = dataUrl ? nativeImage.createFromDataURL(dataUrl) : null;
    this.win.setOverlayIcon(img && !img.isEmpty() ? img : null, description || '');
  }

  destroy() {
    writeStateNow();
    this.win.removeListener('resize', this.onResize);
    this.tabs.removeListener('layout', this.onLayout);
    for (const id of [...this.views.keys()]) {
      const entry = this.views.get(id);
      this.views.delete(id);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    }
    if (!this.rail.webContents.isDestroyed()) this.rail.webContents.close();
  }
}

const SETTINGS_URL = 'explora://settings/#sidebar';

async function clearItemData(id) {
  const ses = session.fromPartition(partitionFor(id));
  await ses.clearStorageData().catch(() => {});
  await ses.clearCache().catch(() => {});
}

// --- Réglages de la liste (Paramètres > Barre latérale) ---
let panel = null;

function settingsState() {
  ensureState();
  return {
    railVisible: state.railVisible,
    widths: WIDTH_LABELS,
    items: state.items.map(({ id, preset, name, url, enabled, width, badge, icon, customIcon }) => ({
      id, preset, name, url, enabled, width, badge, icon, customIcon,
      color: preset ? presetById(preset).color : null,
    })),
    catalog: PRESETS.map(({ id, name, url, color }) => ({
      id, name, url, color, added: state.items.some((it) => it.preset === id),
    })),
  };
}

function setRailVisible(visible) {
  ensureState();
  if (state.railVisible === !!visible) return settingsState();
  state.railVisible = !!visible;
  saveState();
  if (panel) panel.applyRailVisibility();
  if (changeListener) changeListener(settingsState());
  return settingsState();
}

function toggleRail() {
  return setRailVisible(!ensureState().railVisible);
}

// Ajoute une intégration du catalogue (`{ preset }`) ou un site personnalisé
// (`{ name, url, iconUrl? }`).
async function addItem(data = {}) {
  ensureState();
  if (state.items.length >= MAX_ITEMS) return { error: `${MAX_ITEMS} intégrations au maximum.` };
  if (data.preset) {
    const p = presetById(data.preset);
    if (!p) return { error: 'Intégration inconnue.' };
    if (state.items.some((it) => it.preset === p.id)) return { error: `${p.name} est déjà dans la barre.` };
    // l'identifiant (et donc la session) du modèle est réutilisé s'il est libre
    const id = state.items.some((it) => it.id === p.id) ? `${p.id}-${crypto.randomBytes(3).toString('hex')}` : p.id;
    state.items.push(itemFromPreset(p, { id }));
    changed();
    return settingsState();
  }
  const url = normalizeUrl(data.url);
  if (!url) return { error: 'Adresse invalide (ex. https://exemple.com).' };
  const name = cleanName(data.name) || new URL(url).hostname.replace(/^www\./, '');
  const item = {
    id: `custom-${crypto.randomBytes(4).toString('hex')}`,
    preset: null,
    name,
    url,
    enabled: true,
    width: WIDTHS[data.width] || data.width === 'full' ? data.width : 'medium',
    badge: true,
    icon: '',
    customIcon: false,
  };
  if (data.iconUrl) {
    const r = await setIcon(item, data.iconUrl);
    if (r?.error) return r;
  }
  state.items.push(item);
  changed();
  return settingsState();
}

async function setIcon(item, iconUrl) {
  const src = normalizeUrl(iconUrl);
  if (!src) return { error: "Adresse de l'icône invalide." };
  try {
    item.icon = await fetchIcon(src);
    item.customIcon = true;
    return null;
  } catch {
    return { error: "Impossible de récupérer l'icône (image de 256 Ko max)." };
  }
}

async function updateItem(id, patch = {}) {
  const item = itemById(String(id));
  if (!item) return { error: 'Intégration introuvable.' };
  if ('name' in patch) {
    const name = cleanName(patch.name);
    if (!name) return { error: 'Le nom ne peut pas être vide.' };
    item.name = name;
  }
  if ('url' in patch) {
    const url = normalizeUrl(patch.url);
    if (!url) return { error: 'Adresse invalide (ex. https://exemple.com).' };
    if (url !== item.url && !item.customIcon) item.icon = ''; // nouvelle icône au prochain chargement
    item.url = url;
  }
  if ('enabled' in patch) item.enabled = !!patch.enabled;
  if ('badge' in patch) item.badge = !!patch.badge;
  if ('width' in patch && (patch.width in WIDTHS || patch.width === 'full')) item.width = patch.width;
  if ('iconUrl' in patch) {
    if (patch.iconUrl) {
      const r = await setIcon(item, patch.iconUrl);
      if (r?.error) return r;
    } else {
      item.icon = ''; // revient à l'icône du site
      item.customIcon = false;
    }
  }
  changed();
  return settingsState();
}

async function removeItem(id) {
  ensureState();
  const i = state.items.findIndex((it) => it.id === id);
  if (i < 0) return { error: 'Intégration introuvable.' };
  state.items.splice(i, 1);
  if (state.open === id) state.open = null;
  changed(); // ferme d'abord la vue, puis efface ses données de connexion
  await clearItemData(id);
  return settingsState();
}

function moveItem(id, delta) {
  ensureState();
  const i = state.items.findIndex((it) => it.id === id);
  const j = i + (delta < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= state.items.length) return settingsState();
  [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
  changed();
  return settingsState();
}

// --- Point d'entrée : une barre latérale pour la fenêtre normale ---
let ipcReady = false;

function setupIpc() {
  if (ipcReady) return;
  ipcReady = true;
  const fromRail = (fn) => (event, ...args) => {
    if (panel && event.sender === panel.rail.webContents) return fn(...args);
    return undefined;
  };
  ipcMain.handle('messengers:get-state', fromRail(() => panel.getState()));
  ipcMain.on('messengers:toggle', fromRail((id) => panel.toggle(String(id))));
  ipcMain.on('messengers:context-menu', fromRail((id) => panel.showContextMenu(String(id || ''))));
  ipcMain.on('messengers:overlay', fromRail((dataUrl, description) => {
    panel.setOverlay(typeof dataUrl === 'string' ? dataUrl : null, String(description || ''));
  }));
  ipcMain.on('messenger:notification-click', (event) => {
    if (panel) panel.notificationClicked(event.sender);
  });
}

// Attache la barre à la fenêtre normale. `openInTab(url)` ouvre un lien dans
// un onglet ; `onShortcut(event, input)` relaie les autres raccourcis clavier.
function attach({ win, tabs, openInTab, onShortcut }) {
  ensureState();
  setupIpc();
  if (panel) panel.destroy();
  panel = new MessengerPanel({ win, tabs, openInTab, onShortcut });
  win.on('closed', () => {
    if (panel && panel.win === win) {
      panel.destroy();
      panel = null;
    }
  });
  return panel;
}

const ownsWebContents = (wc) => !!panel && panel.ownsWebContents(wc);
const onSettingsChange = (fn) => {
  changeListener = fn;
};

module.exports = {
  attach,
  toggleRail,
  setRailVisible,
  ownsWebContents,
  settingsState,
  addItem,
  updateItem,
  removeItem,
  moveItem,
  onSettingsChange,
  unreadFromTitle,
  PRESETS,
};
