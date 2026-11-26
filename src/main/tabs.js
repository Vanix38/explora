// Gestion des onglets : chaque onglet est un WebContentsView ajouté à la
// fenêtre principale, sous la barre d'interface (onglets + barre d'outils).

const path = require('path');
const { WebContentsView } = require('electron');
const { EventEmitter } = require('events');
const { extractQuery } = require('./search');
const { isInternalUrl } = require('./internal');

const PRELOAD = path.join(__dirname, '..', 'preload', 'internal-preload.js');

const PARTITION = 'persist:main'; // garde cookies / connexions entre les lancements

// Écran partagé : plusieurs onglets côte à côte dans la fenêtre
const SPLIT_MAX = 4; // panneaux au plus par écran partagé
const SPLIT_GAP = 8; // largeur du séparateur (dessiné par l'interface, sous les pages)
const SPLIT_MARGIN = 2; // marge autour des panneaux : liseré du panneau actif
const SPLIT_MIN_WIDTH = 200; // largeur minimale d'un panneau

// Script exécuté dans la page pour écrire une question dans son champ de saisie
// (sites qui n'acceptent pas la question dans l'URL). N'envoie rien.
function injectScript({ selector, text }) {
  return `(async () => {
    for (let i = 0; i < 60; i++) {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) {
        el.focus();
        if ('value' in el && el.tagName !== 'DIV') {
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('insertText', false, ${JSON.stringify(text)});
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })()`;
}

// Couleurs des groupes d'onglets (comme Chrome). Les teintes sont dans styles.css.
const GROUP_COLORS = [
  { id: 'grey', name: 'Gris' },
  { id: 'blue', name: 'Bleu' },
  { id: 'red', name: 'Rouge' },
  { id: 'yellow', name: 'Jaune' },
  { id: 'green', name: 'Vert' },
  { id: 'pink', name: 'Rose' },
  { id: 'purple', name: 'Violet' },
  { id: 'cyan', name: 'Cyan' },
  { id: 'orange', name: 'Orange' },
];
const isGroupColor = (c) => GROUP_COLORS.some((g) => g.id === c);

// Normalise une cible : chaîne (URL) ou { url, inject?, query? }
const toTarget = (t) => (typeof t === 'string' ? { url: t } : t);

class TabManager extends EventEmitter {
  constructor(win, { topOffset, partition = PARTITION, getHomeUrl, onWebContentsCreated }) {
    super();
    this.win = win;
    this.topOffset = topOffset;
    this.leftInset = 0; // place réservée à gauche (barre des messageries)
    this.partition = partition;
    this.getHomeUrl = getHomeUrl;
    this.onWebContentsCreated = onWebContentsCreated;
    this.tabs = new Map(); // id -> { id, view, title, url, favicon, loading, query }
    this.order = [];
    this.activeId = null;
    this.nextId = 1;
    // Groupes d'onglets : id -> { id, title, color, collapsed }. Les onglets d'un
    // groupe se suivent toujours dans this.order (tab.groupId).
    this.groups = new Map();
    this.nextGroupId = 1;
    // Écrans partagés : { ids: [onglets de gauche à droite], sizes: [fractions] }
    this.splits = [];
    this.attached = new Set(); // vues actuellement affichées dans la fenêtre
    this.splitLayout = null; // dernière disposition envoyée à l'interface
    this.resizing = null; // { group, index } pendant le glissement d'un séparateur

    win.on('resize', () => this.layout());
    // glissement d'un séparateur : la souris peut passer au-dessus d'une page
    win.webContents.on('before-mouse-event', (e, m) => this.onResizeMouse(e, m, 0));
  }

  // `groupId` : ajoute l'onglet à ce groupe (placé à la fin du groupe)
  create(target, { activate = true, groupId = null } = {}) {
    const { url = this.getHomeUrl(), inject, query = null } = toTarget(target || {});
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        preload: PRELOAD, // n'expose rien aux sites web, voir internal-preload.js
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const id = this.nextId++;
    const tab = { id, view, title: 'Nouvel onglet', url, favicon: null, loading: true, query, blocked: 0, groupId: null };
    this.tabs.set(id, tab);
    this.order.push(id);
    if (groupId && this.groups.has(groupId)) this.addToGroup([id], groupId, { silent: true });

    const wc = view.webContents;
    const update = (patch) => {
      Object.assign(tab, patch);
      this.emitState();
    };

    wc.on('page-title-updated', (_e, title) => {
      update({ title });
      this.emit('title', tab);
    });
    wc.on('page-favicon-updated', (_e, favicons) => update({ favicon: favicons[0] || null }));
    wc.on('did-start-loading', () => update({ loading: true }));
    // compteur du bloqueur de pub : remis à zéro à chaque nouvelle page
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) tab.blocked = 0;
    });
    wc.on('did-stop-loading', () => update({ loading: false }));
    // clic dans un panneau de l'écran partagé : il devient l'onglet actif
    wc.on('focus', () => this.focusPane(id));
    wc.on('before-mouse-event', (e, m) => this.onResizeMouse(e, m, view.getBounds().x));
    wc.on('did-navigate', (_e, navUrl, httpCode) => {
      // Mémorise la question si la page est une page de résultats connue
      update({ url: navUrl, favicon: null, query: extractQuery(navUrl) || tab.query });
      // pas de page d'erreur réseau (code <= 0) dans l'historique
      if (httpCode > 0) this.emit('visit', tab, { inPage: false });
    });
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (!isMainFrame) return;
      update({ url: navUrl, query: extractQuery(navUrl) || tab.query });
      this.emit('visit', tab, { inPage: true }); // le titre courant vaut encore pour la page
    });
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3 /* ABORTED */) {
        update({ title: `Erreur : ${desc}`, url: failedUrl, loading: false });
      }
    });

    // Un site web ne peut pas ouvrir une page interne (ni dans un cadre, ni
    // par redirection) : seules l'app et les pages internes elles-mêmes le peuvent.
    const guard = (e) => {
      if (isInternalUrl(e.url) && (!e.isMainFrame || !isInternalUrl(wc.getURL()))) e.preventDefault();
    };
    wc.on('will-frame-navigate', guard);
    wc.on('will-redirect', guard);

    // Liens target=_blank et window.open -> nouvel onglet
    wc.setWindowOpenHandler(({ url: openUrl }) => {
      if (!isInternalUrl(openUrl) || isInternalUrl(wc.getURL())) this.create(openUrl);
      return { action: 'deny' };
    });

    if (this.onWebContentsCreated) this.onWebContentsCreated(wc);
    this.emit('tab-created', tab); // pour les extensions (chrome.tabs)

    this.load(tab, { url, inject });
    if (activate) this.activate(id);
    else this.emitState();
    return id;
  }

  load(tab, { url, inject }) {
    const wc = tab.view.webContents;
    if (inject) {
      wc.once('did-finish-load', () => {
        wc.executeJavaScript(injectScript(inject)).catch(() => {});
      });
    }
    wc.loadURL(url).catch(() => {}); // les erreurs sont gérées par did-fail-load
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // un onglet d'un groupe replié devient visible : on déplie le groupe
    const group = this.groups.get(tab.groupId);
    if (group) group.collapsed = false;
    this.activeId = id;
    this.syncViews();
    this.layout();
    tab.view.webContents.focus();
    this.emit('tab-activated', tab);
    this.emitState();
  }

  // Affiche exactement les vues voulues : l'onglet actif (ou tous les panneaux
  // de son écran partagé) et les outils de développement de l'onglet actif.
  syncViews() {
    const want = new Set();
    for (const id of this.visibleIds()) want.add(this.tabs.get(id).view);
    const devtools = this.active()?.devtools;
    if (devtools) want.add(devtools);
    for (const view of this.attached) {
      if (!want.has(view)) this.win.contentView.removeChildView(view);
    }
    for (const view of want) {
      if (!this.attached.has(view)) this.win.contentView.addChildView(view);
    }
    this.attached = want;
  }

  detach(view) {
    if (!view) return;
    this.win.contentView.removeChildView(view);
    this.attached.delete(view);
  }

  // --- Écran partagé ---
  splitOf(id) {
    return this.splits.find((g) => g.ids.includes(id)) || null;
  }

  // Onglets affichés : le groupe de l'onglet actif, sinon l'onglet actif seul
  visibleIds() {
    if (!this.tabs.has(this.activeId)) return [];
    return this.splitOf(this.activeId)?.ids || [this.activeId];
  }

  // Le focus est passé dans un autre panneau du même écran partagé
  focusPane(id) {
    if (id === this.activeId || !this.visibleIds().includes(id)) return;
    this.activeId = id;
    this.syncViews(); // les outils de développement suivent l'onglet actif
    this.layout();
    this.emit('tab-activated', this.tabs.get(id));
    this.emitState();
  }

  // Ajoute aux onglets donnés les autres panneaux de leurs écrans partagés
  withSplitPartners(tabIds) {
    const all = new Set(tabIds);
    for (const id of tabIds) for (const p of this.splitOf(id)?.ids || []) all.add(p);
    return [...all];
  }

  // Un nouveau panneau rejoint le groupe d'onglets du panneau de base (ou en sort)
  alignTabGroup(id, baseId) {
    const gid = this.tabs.get(baseId)?.groupId || null;
    if (this.tabs.get(id)?.groupId === gid) return;
    if (gid) this.addToGroup([id], gid, { silent: true });
    else this.removeFromGroup([id]);
  }

  // Les onglets d'un écran partagé restent côte à côte dans la barre d'onglets
  packSplitOrder(group) {
    const first = Math.min(...group.ids.map((id) => this.order.indexOf(id)));
    const rest = this.order.filter((id) => !group.ids.includes(id));
    const before = this.order.slice(0, first).filter((id) => !group.ids.includes(id)).length;
    rest.splice(before, 0, ...group.ids);
    this.order = rest;
  }

  // Retire un onglet de son écran partagé (le groupe disparaît s'il reste seul)
  leaveSplit(id) {
    const g = this.splitOf(id);
    if (!g) return;
    const i = g.ids.indexOf(id);
    g.ids.splice(i, 1);
    const [freed] = g.sizes.splice(i, 1);
    if (g.ids.length < 2) {
      this.splits.splice(this.splits.indexOf(g), 1);
    } else {
      // la place libérée va au voisin
      g.sizes[Math.min(i, g.sizes.length - 1)] += freed;
    }
  }

  // Affiche l'onglet `otherId` à droite de `baseId` (l'onglet actif par défaut)
  splitWith(otherId, baseId = this.activeId) {
    if (otherId === baseId || !this.tabs.has(otherId) || !this.tabs.has(baseId)) return false;
    let g = this.splitOf(baseId);
    if (g?.ids.includes(otherId)) {
      this.activate(otherId);
      return true;
    }
    if (g && g.ids.length >= SPLIT_MAX) return false;
    this.leaveSplit(otherId);
    this.alignTabGroup(otherId, baseId);
    if (!g) {
      g = { ids: [baseId], sizes: [1] };
      this.splits.push(g);
    }
    g.ids.splice(g.ids.indexOf(baseId) + 1, 0, otherId);
    g.sizes = g.ids.map(() => 1 / g.ids.length); // parts égales
    this.packSplitOrder(g);
    this.activate(otherId);
    return true;
  }

  canSplitWith(otherId, baseId = this.activeId) {
    const g = this.splitOf(baseId);
    return otherId !== baseId && !g?.ids.includes(otherId) && (g?.ids.length || 1) < SPLIT_MAX;
  }

  // Ouvre une cible (page d'accueil par défaut) dans un nouveau panneau à droite
  openInSplit(target, baseId = this.activeId) {
    const g = this.splitOf(baseId);
    if (g && g.ids.length >= SPLIT_MAX) {
      const id = this.create(target); // plus de place : simple nouvel onglet
      return id;
    }
    const id = this.create(target, { activate: false });
    this.splitWith(id, baseId);
    return id;
  }

  // Ferme l'écran partagé : chaque onglet redevient un onglet normal
  unsplit(id = this.activeId) {
    const g = this.splitOf(id);
    if (!g) return;
    this.splits.splice(this.splits.indexOf(g), 1);
    this.activate(this.tabs.has(id) ? id : this.activeId);
  }

  // Bouton / Ctrl+Shift+S : ouvre un écran partagé, ou le ferme
  toggleSplit() {
    if (this.splitOf(this.activeId)) this.unsplit();
    else this.openInSplit();
  }

  // Retire un onglet de l'écran partagé sans le fermer
  removeFromSplit(id) {
    if (!this.splitOf(id)) return;
    this.leaveSplit(id);
    this.activate(id);
  }

  // Inverse l'ordre des panneaux
  swapSplit(id = this.activeId) {
    const g = this.splitOf(id);
    if (!g) return;
    g.ids.reverse();
    g.sizes.reverse();
    this.packSplitOrder(g);
    this.layout();
    this.emitState();
  }

  // Séparateurs : partager l'espace également (double-clic)
  resetSplitSizes() {
    const g = this.splitOf(this.activeId);
    if (!g) return;
    g.sizes = g.ids.map(() => 1 / g.ids.length);
    this.layout();
  }

  // Recrée un écran partagé au lancement (onglets rouverts)
  restoreSplit(ids, sizes) {
    const valid = ids.filter((id) => this.tabs.has(id) && !this.splitOf(id));
    if (valid.length < 2) return;
    const ok = Array.isArray(sizes) && sizes.length === valid.length && sizes.every((s) => Number.isFinite(s) && s > 0);
    const total = ok ? sizes.reduce((a, b) => a + b, 0) : 1;
    const g = { ids: valid.slice(0, SPLIT_MAX), sizes: [] };
    for (const id of g.ids.slice(1)) this.alignTabGroup(id, g.ids[0]);
    g.sizes = g.ids.map((_, i) => (ok ? sizes[i] / total : 1 / g.ids.length));
    this.splits.push(g);
    this.packSplitOrder(g);
  }

  // L'interface signale le début du glissement du séparateur n° index
  startResize(index) {
    const g = this.splitOf(this.activeId);
    if (!g || !this.splitLayout || index < 0 || index >= g.ids.length - 1) return;
    this.resizing = { group: g, index };
  }

  // Pendant le glissement, tous les mouvements de souris (interface et pages)
  // arrivent ici (x relatif à la vue, d'où offsetX) ; le bouton relâché
  // termine le glissement.
  onResizeMouse(event, mouse, offsetX) {
    if (!this.resizing) return;
    event.preventDefault();
    // pendant un déplacement, `button` indique le bouton enfoncé (« none » s'il
    // a été relâché hors de la fenêtre)
    if (mouse.type === 'mouseUp' || (mouse.type === 'mouseMove' && mouse.button !== 'left')) {
      this.resizing = null;
      this.emit('split-resized');
      return;
    }
    if (mouse.type !== 'mouseMove') return;
    const { group: g, index: i } = this.resizing;
    const panes = this.splitLayout?.panes;
    if (!panes || !this.splits.includes(g) || panes.length !== g.ids.length) return;
    const x = mouse.x + offsetX;
    const a = panes[i];
    const b = panes[i + 1];
    const pair = a.width + b.width;
    const left = Math.max(SPLIT_MIN_WIDTH, Math.min(pair - SPLIT_MIN_WIDTH, x - SPLIT_GAP / 2 - a.x));
    const share = g.sizes[i] + g.sizes[i + 1];
    g.sizes[i] = (share * left) / pair;
    g.sizes[i + 1] = share - g.sizes[i];
    this.layout();
  }

  close(id = this.activeId) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    // si l'onglet était dans un écran partagé, un autre panneau prend le relais
    const partners = this.splitOf(id)?.ids.filter((t) => t !== id) || [];
    this.leaveSplit(id);
    if (this.resizing && !this.splits.includes(this.resizing.group)) this.resizing = null;
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    this.detach(tab.view);
    if (tab.devtools) {
      this.detach(tab.devtools);
      tab.devtools.webContents.close();
    }
    this.emit('tab-closed', tab);
    tab.view.webContents.close();
    for (const sp of this.splits) this.packSplitOrder(sp); // panneaux dans l'ordre
    this.pruneGroups();

    if (this.order.length === 0) {
      this.activeId = null;
      this.create(); // toujours garder au moins un onglet
      return;
    }
    if (this.activeId === id) {
      this.activeId = null;
      // de préférence un autre panneau de l'écran partagé, sinon un onglet
      // visible (pas dans un groupe replié)
      const visible = this.order.filter((t) => this.isVisible(t));
      const next = partners[0] ?? visible.find((t) => this.order.indexOf(t) >= idx) ?? visible[visible.length - 1];
      this.activate(next ?? this.order[Math.min(idx, this.order.length - 1)]);
    } else {
      this.syncViews();
      this.layout();
      this.emitState();
    }
  }

  // Ferme plusieurs onglets d'un coup (clic droit sur un onglet)
  closeMany(ids) {
    for (const id of ids) if (this.tabs.has(id)) this.close(id);
  }

  active() {
    return this.tabs.get(this.activeId) || null;
  }

  // --- Groupes d'onglets ---

  // Un onglet est visible s'il n'est pas dans un groupe replié
  isVisible(id) {
    const tab = this.tabs.get(id);
    return !!tab && !this.groups.get(tab.groupId)?.collapsed;
  }

  // Crée un groupe avec ces onglets (regroupés à la place du premier). Renvoie son id.
  createGroup(tabIds, { title = '', color, collapsed = false } = {}) {
    const ids = tabIds.filter((t) => this.tabs.has(t));
    if (ids.length === 0) return null;
    const id = this.nextGroupId++;
    if (!isGroupColor(color)) {
      // couleur pas encore utilisée si possible, comme Chrome
      const used = new Set([...this.groups.values()].map((g) => g.color));
      color = (GROUP_COLORS.find((c) => !used.has(c.id)) || GROUP_COLORS[(id - 1) % GROUP_COLORS.length]).id;
    }
    this.groups.set(id, { id, title: String(title).slice(0, 80), color, collapsed: false });
    this.addToGroup(ids, id, { silent: true });
    if (collapsed) this.setGroupCollapsed(id, true, { silent: true });
    this.emitState();
    return id;
  }

  // Met ces onglets dans le groupe, à la suite de ses onglets actuels
  addToGroup(tabIds, groupId, { silent = false } = {}) {
    if (!this.groups.has(groupId)) return;
    tabIds = this.withSplitPartners(tabIds); // un écran partagé change de groupe en entier
    const ids = this.order.filter((t) => tabIds.includes(t)); // garde l'ordre actuel
    if (ids.length === 0) return;
    const members = this.order.filter((t) => this.tabs.get(t).groupId === groupId && !ids.includes(t));
    // point d'insertion : après le dernier onglet du groupe, sinon à la place du premier onglet déplacé
    const anchor = members.length ? members[members.length - 1] : null;
    const firstIdx = this.order.indexOf(ids[0]);
    this.order = this.order.filter((t) => !ids.includes(t));
    let at = anchor !== null ? this.order.indexOf(anchor) + 1 : Math.min(firstIdx, this.order.length);
    // ne pas couper un autre groupe en deux
    at = this.groupBoundary(at);
    this.order.splice(at, 0, ...ids);
    for (const t of ids) this.tabs.get(t).groupId = groupId;
    for (const sp of this.splits) this.packSplitOrder(sp); // panneaux dans l'ordre
    this.pruneGroups();
    if (!silent) this.emitState();
  }

  // Sort ces onglets de leur groupe (placés juste après le groupe)
  removeFromGroup(tabIds) {
    tabIds = this.withSplitPartners(tabIds);
    for (const id of this.order.filter((t) => tabIds.includes(t))) {
      const tab = this.tabs.get(id);
      if (!tab?.groupId) continue;
      const gid = tab.groupId;
      tab.groupId = null;
      this.order.splice(this.order.indexOf(id), 1);
      const members = this.order.filter((t) => this.tabs.get(t).groupId === gid);
      const at = members.length ? this.order.indexOf(members[members.length - 1]) + 1 : this.order.length;
      this.order.splice(at, 0, id);
    }
    for (const sp of this.splits) this.packSplitOrder(sp); // panneaux dans l'ordre
    this.pruneGroups();
    this.emitState();
  }

  // Décale un point d'insertion pour qu'il ne tombe pas au milieu d'un groupe
  groupBoundary(at) {
    const before = this.tabs.get(this.order[at - 1])?.groupId;
    const after = this.tabs.get(this.order[at])?.groupId;
    if (!before || before !== after) return at;
    while (at < this.order.length && this.tabs.get(this.order[at]).groupId === before) at++;
    return at;
  }

  updateGroup(groupId, patch) {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (typeof patch.title === 'string') group.title = patch.title.trim().slice(0, 80);
    if (isGroupColor(patch.color)) group.color = patch.color;
    if (typeof patch.collapsed === 'boolean') this.setGroupCollapsed(groupId, patch.collapsed, { silent: true });
    this.emitState();
  }

  setGroupCollapsed(groupId, collapsed, { silent = false } = {}) {
    const group = this.groups.get(groupId);
    if (!group) return;
    group.collapsed = collapsed;
    // l'onglet actif est replié : on passe à un onglet visible (ou un nouveau)
    if (collapsed && this.active()?.groupId === groupId) {
      const idx = this.order.indexOf(this.activeId);
      const visible = this.order.filter((t) => this.isVisible(t));
      const next = visible.find((t) => this.order.indexOf(t) > idx) ?? visible[visible.length - 1];
      if (next !== undefined) this.activate(next);
      else this.create();
      return; // activate / create envoient l'état
    }
    if (!silent) this.emitState();
  }

  toggleGroupCollapsed(groupId) {
    const group = this.groups.get(groupId);
    if (group) this.setGroupCollapsed(groupId, !group.collapsed);
  }

  // Dissout le groupe : les onglets restent ouverts
  ungroup(groupId) {
    for (const tab of this.tabs.values()) if (tab.groupId === groupId) tab.groupId = null;
    this.groups.delete(groupId);
    this.emitState();
  }

  groupTabIds(groupId) {
    return this.order.filter((t) => this.tabs.get(t).groupId === groupId);
  }

  closeGroup(groupId) {
    this.closeMany(this.groupTabIds(groupId));
  }

  // Supprime les groupes devenus vides
  pruneGroups() {
    const used = new Set([...this.tabs.values()].map((t) => t.groupId));
    for (const id of this.groups.keys()) if (!used.has(id)) this.groups.delete(id);
  }

  tabFor(webContents) {
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents === webContents || tab.devtools?.webContents === webContents) return tab;
    }
    return null;
  }

  // Ouvre un onglet existant sur cette URL s'il y en a un, sinon un nouveau
  focusOrCreate(url) {
    const tab = [...this.tabs.values()].find((t) => t.url === url);
    if (tab) this.activate(tab.id);
    else this.create(url);
  }

  // Ouvre une cible dans l'onglet courant (ou dans `tab`)
  navigate(target, tab = this.active()) {
    if (!tab) return;
    const t = toTarget(target);
    if (t.query) tab.query = t.query;
    this.load(tab, t);
    tab.view.webContents.focus();
  }

  goBack() {
    const h = this.active()?.view.webContents.navigationHistory;
    if (h && h.canGoBack()) h.goBack();
  }

  goForward() {
    const h = this.active()?.view.webContents.navigationHistory;
    if (h && h.canGoForward()) h.goForward();
  }

  reload() {
    this.active()?.view.webContents.reload();
  }

  stop() {
    this.active()?.view.webContents.stop();
  }

  setTopOffset(px) {
    this.topOffset = px;
    this.layout();
    this.emit('layout');
  }

  setLeftInset(px) {
    if (px === this.leftInset) return;
    this.leftInset = px;
    this.layout();
  }

  layout() {
    const tab = this.active();
    if (!tab || this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const y = this.topOffset;
    const h = Math.max(0, height - y);
    const x = Math.min(this.leftInset, width); // barre des messageries à gauche
    let w = width - x;
    if (tab.devtools) {
      // outils de développement ancrés à droite de la page (ou des panneaux), comme dans Chrome
      const dw = Math.max(0, Math.min(Math.max(380, Math.round(w * 0.4)), w - 200));
      tab.devtools.setBounds({ x: x + w - dw, y, width: dw, height: h });
      w -= dw;
    }
    const ids = this.visibleIds();
    if (ids.length < 2) {
      tab.view.setBounds({ x, y, width: w, height: h });
      this.setSplitLayout(null);
      return;
    }
    // Écran partagé : panneaux côte à côte, séparés par une bande que l'interface
    // (sous les pages) dessine et qui sert de poignée de redimensionnement.
    const g = this.splitOf(this.activeId);
    const M = SPLIT_MARGIN;
    const inner = Math.max(0, w - 2 * M - SPLIT_GAP * (ids.length - 1));
    const ph = Math.max(0, h - 2 * M);
    const panes = [];
    const dividers = [];
    let px = x + M;
    ids.forEach((id, i) => {
      const last = i === ids.length - 1;
      const pw = last ? x + w - M - px : Math.round(inner * g.sizes[i]);
      const bounds = { x: px, y: y + M, width: Math.max(0, pw), height: ph };
      this.tabs.get(id).view.setBounds(bounds);
      panes.push({ ...bounds, id, active: id === this.activeId });
      px += pw;
      if (!last) {
        dividers.push({ x: px, y: y + M, width: SPLIT_GAP, height: ph, index: i });
        px += SPLIT_GAP;
      }
    });
    this.setSplitLayout({ panes, dividers, margin: M });
  }

  // Positions des panneaux et séparateurs, envoyées à l'interface qui les dessine
  setSplitLayout(layout) {
    const key = JSON.stringify(layout);
    if (key === this.splitLayoutKey) return;
    this.splitLayoutKey = key;
    this.splitLayout = layout;
    this.emit('split-layout', layout);
  }

  // --- Outils de développement (Chrome DevTools) de l'onglet ---
  openDevTools(tab = this.active()) {
    if (!tab) return null;
    const wc = tab.view.webContents;
    if (!tab.devtools) {
      const view = new WebContentsView();
      tab.devtools = view;
      // raccourcis (F12, Ctrl+W…) aussi quand le focus est dans les outils
      if (this.onWebContentsCreated) this.onWebContentsCreated(view.webContents, { devtools: true });
      wc.setDevToolsWebContents(view.webContents);
      wc.openDevTools({ mode: 'detach', activate: true });
      wc.once('devtools-closed', () => this.closeDevTools(tab));
      if (tab.id === this.activeId) this.syncViews();
      this.layout();
    }
    return tab;
  }

  closeDevTools(tab = this.active()) {
    if (!tab?.devtools) return;
    const view = tab.devtools;
    tab.devtools = null;
    this.detach(view);
    const wc = tab.view.webContents;
    if (!wc.isDestroyed() && wc.isDevToolsOpened()) wc.closeDevTools();
    if (!view.webContents.isDestroyed()) view.webContents.close();
    this.layout();
  }

  toggleDevTools(tab = this.active()) {
    if (tab?.devtools) this.closeDevTools(tab);
    else this.openDevTools(tab);
  }

  inspectElement(webContents, x, y) {
    const tab = this.tabFor(webContents);
    if (!tab) return;
    this.openDevTools(tab);
    webContents.inspectElement(x, y);
  }

  getState() {
    const active = this.active();
    const h = active?.view.webContents.navigationHistory;
    return {
      activeId: this.activeId,
      canGoBack: !!h && h.canGoBack(),
      canGoForward: !!h && h.canGoForward(),
      split: this.visibleIds().length > 1,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        const g = this.splitOf(id);
        // position dans l'écran partagé : pour dessiner les onglets regroupés
        const splitPos = !g ? null : g.ids.length === 1 ? 'only' : g.ids[0] === id ? 'first' : g.ids[g.ids.length - 1] === id ? 'last' : 'middle';
        return {
          id: t.id, title: t.title, url: t.url, favicon: t.favicon, loading: t.loading, query: t.query, blocked: t.blocked,
          groupId: t.groupId, splitPos, shown: this.visibleIds().includes(id),
        };
      }),
      groups: [...this.groups.values()].map((g) => ({ ...g })),
    };
  }

  // Onglets (et groupes) à rouvrir au prochain lancement
  snapshot() {
    const groups = [...this.groups.values()];
    return {
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        const g = groups.findIndex((gr) => gr.id === t.groupId);
        return { url: t.url, query: t.query || null, ...(g >= 0 ? { group: g } : {}) };
      }),
      groups: groups.map(({ title, color, collapsed }) => ({ title, color, collapsed })),
      active: Math.max(0, this.order.indexOf(this.activeId)),
      splits: this.splits.map((g) => ({ tabs: g.ids.map((id) => this.order.indexOf(id)), sizes: g.sizes })),
    };
  }

  // Envoie un message à toutes les pages internes ouvertes
  broadcastInternal(channel, payload) {
    for (const tab of this.tabs.values()) {
      const wc = tab.view.webContents;
      if (!wc.isDestroyed() && isInternalUrl(wc.getURL())) wc.send(channel, payload);
    }
  }

  // Une requête de cet onglet vient d'être bloquée (état envoyé au plus 4 fois/s)
  countBlocked(webContents) {
    const tab = this.tabFor(webContents);
    if (!tab) return;
    tab.blocked += 1;
    if (!this.blockedTimer) {
      this.blockedTimer = setTimeout(() => {
        this.blockedTimer = null;
        this.emitState();
      }, 250);
    }
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

module.exports = { TabManager, PARTITION, GROUP_COLORS };
