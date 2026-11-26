// Interface du navigateur : dessine les onglets et relaie les actions au
// processus principal via window.nav (exposé par le preload).

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const address = $('address');
const backBtn = $('back');
const forwardBtn = $('forward');
const reloadBtn = $('reload');

// Fenêtre privée : main.js charge l'interface avec ?private=1
const isPrivate = new URLSearchParams(location.search).get('private') === '1';
if (isPrivate) {
  document.documentElement.classList.add('private');
  $('private-badge').hidden = false;
}

let state = { tabs: [], groups: [], activeId: null, canGoBack: false, canGoForward: false };
let addressDirty = false; // l'utilisateur est en train de taper

// Les éléments des onglets sont réutilisés d'un rendu à l'autre (clé = id) :
// les recréer à chaque mise à jour faisait disparaître le bouton × entre
// l'appui et le relâchement du clic, et la fermeture était perdue.
const tabEls = new Map(); // id -> { el, icon, title, iconKey }

function createTabEl(id) {
  const el = document.createElement('div');
  el.setAttribute('role', 'tab');
  const title = document.createElement('span');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'close';
  close.title = 'Fermer (Ctrl+W)';
  close.textContent = '×';
  // le clic sur × ne doit pas d'abord activer l'onglet
  close.addEventListener('mousedown', (e) => e.stopPropagation());
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    window.nav.closeTab(id);
  });
  const icon = document.createElement('span');
  el.append(icon, title, close);
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // pas de défilement automatique
    else if (e.button === 0 && id !== state.activeId) window.nav.activateTab(id);
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) window.nav.closeTab(id); // clic molette
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.nav.tabContextMenu(id, e.clientX, e.clientY);
  });
  return { el, icon, title, iconKey: null };
}

function updateTabEl(t, tab) {
  const group = tab.groupId ? (state.groups || []).find((g) => g.id === tab.groupId) : null;
  t.el.className = 'tab' + (tab.id === state.activeId ? ' active' : '')
    + (group ? ` grouped group-${group.color}` : '') + (group?.collapsed ? ' collapsed' : '')
    + (tab.splitPos ? ` split split-${tab.splitPos}` : '') + (tab.shown && tab.id !== state.activeId ? ' shown' : '');
  t.el.title = tab.title;
  t.title.textContent = tab.title || tab.url;
  const iconKey = tab.loading ? 'loading' : tab.favicon || '';
  if (iconKey === t.iconKey) return;
  t.iconKey = iconKey;
  let icon;
  if (tab.loading || !tab.favicon) {
    icon = document.createElement('span');
  } else {
    icon = document.createElement('img');
    icon.src = tab.favicon;
    icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('span'), { className: 'favicon' }));
  }
  icon.className = 'favicon' + (tab.loading ? ' loading' : '');
  t.icon.replaceWith(icon);
  t.icon = icon;
}

// --- Groupes d'onglets : une étiquette colorée devant les onglets du groupe ---
// Clic : replier / déplier. Clic droit : menu (renommer, couleur, fermer…).
const groupEls = new Map(); // id -> { el, label, count, editing }

function createGroupEl(id) {
  const el = document.createElement('div');
  el.setAttribute('role', 'button');
  const label = document.createElement('span');
  label.className = 'label';
  const count = document.createElement('span');
  count.className = 'count';
  el.append(label, count);
  const g = { el, label, count, editing: false };
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('click', () => {
    if (!g.editing) window.nav.toggleGroup(id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!g.editing) window.nav.groupContextMenu(id, e.clientX, e.clientY);
  });
  return g;
}

function updateGroupEl(g, group) {
  g.el.className = `tab-group group-${group.color}` + (group.collapsed ? ' collapsed' : '')
    + (group.title ? '' : ' unnamed') + (g.editing ? ' editing' : '');
  const n = state.tabs.filter((t) => t.groupId === group.id).length;
  const name = group.title || 'Groupe sans nom';
  g.el.title = `${name} – ${n} onglet${n > 1 ? 's' : ''}\nClic : ${group.collapsed ? 'déplier' : 'replier'} · Clic droit : options`;
  g.el.setAttribute('aria-expanded', String(!group.collapsed));
  if (!g.editing) g.label.textContent = group.title;
  // nombre d'onglets affiché quand le groupe est replié
  g.count.textContent = group.collapsed ? String(n) : '';
  g.count.hidden = !group.collapsed;
}

function startRenameGroup(id) {
  const g = groupEls.get(id);
  const group = (state.groups || []).find((x) => x.id === id);
  if (!g || !group || g.editing) return;
  g.editing = true;
  g.el.classList.add('editing');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-name';
  input.value = group.title;
  input.placeholder = 'Nom du groupe';
  input.maxLength = 80;
  input.spellcheck = false;
  input.size = Math.max(8, group.title.length + 1);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    g.editing = false;
    g.el.classList.remove('editing');
    input.replaceWith(g.label);
    if (save) {
      g.label.textContent = input.value.trim();
      window.nav.renameGroup(id, input.value);
    }
    render();
  };
  input.addEventListener('input', () => { input.size = Math.max(8, input.value.length + 1); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  g.label.replaceWith(input);
  input.focus();
  input.select();
}

window.nav.onRenameGroup((id) => {
  // l'étiquette du groupe vient peut-être d'être créée : on attend le rendu
  requestAnimationFrame(() => startRenameGroup(id));
});

function renderTabs() {
  const groups = new Map((state.groups || []).map((g) => [g.id, g]));
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, t] of tabEls) {
    if (!ids.has(id)) {
      t.el.remove();
      tabEls.delete(id);
    }
  }
  for (const [id, g] of groupEls) {
    if (!groups.has(id)) {
      g.el.remove();
      groupEls.delete(id);
    }
  }
  // éléments dans l'ordre voulu : étiquette du groupe, puis ses onglets
  const wanted = [];
  let prevGroup = null;
  for (const tab of state.tabs) {
    if (tab.groupId && tab.groupId !== prevGroup && groups.has(tab.groupId)) {
      let g = groupEls.get(tab.groupId);
      if (!g) {
        g = createGroupEl(tab.groupId);
        groupEls.set(tab.groupId, g);
      }
      updateGroupEl(g, groups.get(tab.groupId));
      wanted.push(g.el);
    }
    prevGroup = tab.groupId;
    let t = tabEls.get(tab.id);
    if (!t) {
      t = createTabEl(tab.id);
      tabEls.set(tab.id, t);
    }
    updateTabEl(t, tab);
    wanted.push(t.el);
  }
  wanted.forEach((el, i) => {
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
  });
}

function render() {
  renderTabs();

  const active = state.tabs.find((t) => t.id === state.activeId);
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  reloadBtn.textContent = active?.loading ? '✕' : '↻';
  reloadBtn.title = active?.loading ? 'Arrêter' : 'Recharger (F5)';

  if (!addressDirty || document.activeElement !== address) {
    // la page d'accueil interne affiche une barre d'adresse vide
    address.value = active && !active.url.startsWith('explora://home') ? active.url : '';
    addressDirty = false;
  }
  const appName = isPrivate ? 'Explora (navigation privée)' : 'Explora';
  document.title = active ? `${active.title} – ${appName}` : appName;
  splitBtn.setAttribute('aria-pressed', String(!!state.split));
  splitBtn.title = state.split ? "Fermer l'écran partagé (Ctrl+Shift+S)" : 'Écran partagé : ouvrir un onglet à côté (Ctrl+Shift+S)';
  renderStar(); // appelé après le chargement du script (événements IPC)
  renderAdblock();
  renderTranslate();
}

window.nav.onState((s) => {
  const switched = s.activeId !== state.activeId;
  state = s;
  if (switched) {
    addressDirty = false;
    hideSuggestions();
  }
  render();
});

window.nav.onFocusAddress(() => {
  address.focus();
  address.select();
});

$('new-tab').addEventListener('click', () => {
  window.nav.newTab();
});
$('app-menu').addEventListener('click', () => {
  const r = $('app-menu').getBoundingClientRect();
  window.nav.appMenu(r.right, r.bottom);
});
$('extensions').addEventListener('click', () => window.nav.openExtensions());

// --- Écran partagé ---
// Les pages couvrent l'interface ; les séparateurs sont les bandes laissées
// libres entre elles. Le glissement est suivi par le processus principal
// (la souris passe au-dessus des pages pendant le déplacement).
const splitBtn = $('split');
const splitLayer = $('split-layer');
splitBtn.addEventListener('click', () => window.nav.toggleSplit());

function renderSplit(layout) {
  splitLayer.hidden = !layout;
  if (!layout) {
    splitLayer.replaceChildren();
    return;
  }
  const px = (el, r, grow = 0) => Object.assign(el.style, {
    left: `${r.x - grow}px`, top: `${r.y - grow}px`, width: `${r.width + 2 * grow}px`, height: `${r.height + 2 * grow}px`,
  });
  const items = [];
  const active = layout.panes.find((p) => p.active);
  if (active) {
    const ring = document.createElement('div');
    ring.className = 'split-ring';
    px(ring, active, layout.margin);
    items.push(ring);
  }
  for (const d of layout.dividers) {
    const el = document.createElement('div');
    el.className = 'split-divider';
    el.title = 'Glisser pour redimensionner · double-clic : parts égales';
    px(el, d);
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.detail === 2) window.nav.splitReset();
      else window.nav.splitResizeStart(d.index);
    });
    items.push(el);
  }
  splitLayer.replaceChildren(...items);
}
window.nav.onSplitLayout(renderSplit);
window.nav.getSplitLayout().then(renderSplit);
if (isPrivate) {
  // pas d'extensions en navigation privée
  $('extension-actions').remove();
  $('extensions').hidden = true;
}
backBtn.addEventListener('click', () => window.nav.back());
forwardBtn.addEventListener('click', () => window.nav.forward());
reloadBtn.addEventListener('click', () => {
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active?.loading) window.nav.stop();
  else window.nav.reload();
});

address.addEventListener('focus', () => address.select());

// --- Autocomplétion de la barre d'adresse (comme Chrome) ---
// Pendant la frappe : la saisie elle-même, des pages de l'historique et les
// suggestions du moteur actif, dans une liste sous la barre. ↑/↓ parcourent
// la liste (la barre affiche la ligne choisie), Entrée l'ouvre, Échap revient
// à la saisie. Le début d'une adresse déjà visitée est complété directement
// dans la barre (texte ajouté sélectionné : il suffit de continuer à taper).
const MAX_SUGGESTIONS = 10;
const ac = {
  typed: '', // ce que l'utilisateur a réellement tapé
  first: '', // la saisie + la complétion en ligne (ce qu'ouvre Entrée)
  history: [],
  remote: [],
  items: [],
  selected: 0,
  open: false,
  seq: 0,
  remoteTimer: null,
  hideTimer: null,
};

// Même règle que resolveInput (src/main/search.js) : adresse ou recherche ?
function looksLikeUrl(text) {
  if (/^(https?|file|about|view-source|explora|customnav):/i.test(text)) return true;
  if (/\s/.test(text)) return false;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)) return true;
  return /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text);
}

const bareUrl = (url) => url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();

function buildSuggestions() {
  const prevFill = ac.items[ac.selected]?.fill;
  const first = ac.first.trim();
  const items = [];
  if (looksLikeUrl(first)) {
    items.push({ kind: 'url', url: first, fill: ac.first });
  } else {
    const eng = engines.engines.find((x) => x.id === engines.activeId);
    items.push({
      kind: 'search',
      text: first,
      fill: ac.first,
      icon: eng?.icon,
      hint: eng ? `${eng.type === 'ai' ? 'Demander à' : 'Rechercher sur'} ${eng.name}` : '',
    });
  }
  const seen = new Set([bareUrl(first)]);
  for (const h of ac.history) {
    const key = bareUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: 'url', url: h.url, title: h.title, fill: h.url });
  }
  const seenText = new Set([first.toLowerCase()]);
  for (const text of ac.remote) {
    if (items.length >= MAX_SUGGESTIONS) break;
    if (seenText.has(text.toLowerCase())) continue;
    seenText.add(text.toLowerCase());
    items.push({ kind: 'search', text, fill: text });
  }
  ac.items = items;
  // les suggestions du moteur arrivent après coup : la ligne choisie au
  // clavier reste choisie même si elle a changé de place
  if (ac.selected > 0) ac.selected = Math.max(0, items.findIndex((i) => i.fill === prevFill));
}

function showSuggestions() {
  if (!ac.typed || document.activeElement !== address) {
    hideSuggestions();
    return;
  }
  clearTimeout(ac.hideTimer);
  buildSuggestions();
  const r = address.getBoundingClientRect();
  ac.open = true;
  window.nav.showSuggestions({
    rect: { x: r.left, y: r.bottom + 4, width: r.width },
    // seuls les champs utiles à l'affichage
    items: ac.items.map(({ fill, ...item }) => item),
    selected: ac.selected,
    typed: ac.typed,
  });
}

function hideSuggestions() {
  clearTimeout(ac.hideTimer);
  clearTimeout(ac.remoteTimer);
  ac.seq++; // les réponses encore en route sont ignorées
  if (!ac.open) return;
  ac.open = false;
  window.nav.hideSuggestions();
}

// La saisie a changé : complétion en ligne + suggestions (historique tout de
// suite, moteur de recherche après une courte pause dans la frappe)
async function updateSuggestions(allowInline) {
  const typed = address.value;
  ac.typed = typed.trim() ? typed : '';
  ac.first = typed;
  ac.selected = 0;
  if (!ac.typed) {
    ac.history = [];
    ac.remote = [];
    hideSuggestions();
    return;
  }
  const seq = ++ac.seq;
  clearTimeout(ac.remoteTimer);
  ac.remoteTimer = setTimeout(async () => {
    const list = await window.nav.suggestRemote(typed).catch(() => []);
    if (seq !== ac.seq) return;
    ac.remote = Array.isArray(list) ? list : [];
    showSuggestions();
  }, 120);

  const local = await window.nav.suggestLocal(typed).catch(() => null);
  if (seq !== ac.seq || address.value !== typed) return;
  ac.history = local?.entries || [];
  const inline = local?.inline;
  const caretAtEnd = address.selectionStart === typed.length && address.selectionEnd === typed.length;
  if (allowInline && caretAtEnd && inline && inline.length > typed.length
      && inline.toLowerCase().startsWith(typed.toLowerCase())) {
    // dans le chemin, la casse compte (ex. github.com/Vanix38) : on reprend
    // celle de l'adresse visitée ; dans le nom de domaine, celle de la saisie
    address.value = inline.includes('/') ? inline : typed + inline.slice(typed.length);
    address.setSelectionRange(typed.length, address.value.length);
    ac.first = address.value;
  }
  // les suggestions du moteur pour la saisie précédente restent affichées
  // (si elles correspondent encore) jusqu'à l'arrivée des nouvelles
  const t = typed.trim().toLowerCase();
  ac.remote = ac.remote.filter((s) => s.toLowerCase().startsWith(t));
  showSuggestions();
}

address.addEventListener('input', (e) => {
  addressDirty = true;
  // pas de complétion en ligne quand on efface (sinon impossible d'effacer)
  const allowInline = !e.isComposing && !/^delete/.test(e.inputType || '');
  updateSuggestions(allowInline);
});

function moveSelection(delta) {
  const n = ac.items.length;
  if (!n) return;
  ac.selected = (ac.selected + delta + n) % n;
  address.value = ac.items[ac.selected].fill;
  if (ac.selected === 0 && ac.first !== ac.typed) {
    // retour à la saisie : la complétion en ligne redevient sélectionnée
    address.setSelectionRange(ac.typed.length, address.value.length);
  } else {
    address.setSelectionRange(address.value.length, address.value.length);
  }
  showSuggestions();
}

function openInput(value, inNewTab) {
  value = value.trim();
  if (!value) return;
  hideSuggestions();
  addressDirty = false;
  address.blur();
  if (inNewTab) window.nav.newTab(value);
  else window.nav.go(value);
}

address.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
    e.preventDefault();
    if (ac.open) moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    else if (addressDirty && address.value.trim()) updateSuggestions(false);
    return;
  }
  if (e.key === 'Enter' && e.altKey) {
    // Alt+Entrée : dans un nouvel onglet
    e.preventDefault();
    openInput(address.value, true);
    return;
  }
  if (e.key === 'Escape') {
    if (ac.open && ac.selected !== 0) {
      moveSelection(-ac.selected); // revient à la saisie, liste ouverte
      return;
    }
    if (ac.open) {
      hideSuggestions();
      return;
    }
    addressDirty = false;
    render();
    address.blur();
  }
});

// Un clic dans la liste fait perdre le focus à la barre juste avant que le
// clic n'arrive : on laisse un instant avant de fermer la liste
address.addEventListener('blur', () => {
  clearTimeout(ac.hideTimer);
  ac.hideTimer = setTimeout(hideSuggestions, 150);
});
window.addEventListener('resize', hideSuggestions);

window.nav.onSuggestionPick(({ index, newTab: inNewTab }) => {
  const item = ac.items[index];
  if (!item) return;
  openInput(item.kind === 'url' ? item.url : item.text, inNewTab);
});

$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  openInput(address.value, false);
});

window.nav.getState().then((s) => { if (s) { state = s; render(); } });

// --- Sélecteur moteurs de recherche / IA ---
const engineSlot = $('engine-slot');
let engines = { activeId: null, engines: [] };

// Texte tapé par l'utilisateur (et pas l'URL affichée de l'onglet)
const typedText = () => (addressDirty ? address.value.trim() : '');

function renderEngines() {
  const items = [];
  engines.engines.forEach((eng, i) => {
    if (i > 0 && eng.type !== engines.engines[i - 1].type) {
      const sep = document.createElement('span');
      sep.className = 'engine-sep';
      items.push(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'engine' + (eng.id === engines.activeId ? ' active' : '');
    btn.setAttribute('aria-pressed', String(eng.id === engines.activeId));
    const shortcut = i < 9 ? ` (Ctrl+${i + 1})` : '';
    btn.title = `${eng.name}${shortcut}\nShift+clic : renvoyer la question vers ${eng.name} dans un nouvel onglet`;

    const icon = document.createElement('img');
    icon.src = eng.icon;
    icon.alt = '';
    icon.onerror = () => {
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = eng.name[0];
      icon.replaceWith(letter);
    };
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = eng.name;
    btn.append(icon, name);

    // garder le focus (et le texte tapé) dans la barre d'adresse
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        resend(eng.id);
        return;
      }
      window.nav.setEngine(eng.id);
      const text = typedText();
      if (text) {
        // une question est en cours de saisie : on la pose au moteur choisi
        addressDirty = false;
        address.blur();
        window.nav.go(text);
      } else {
        address.focus();
      }
    });
    items.push(btn);
  });
  engineSlot.replaceChildren(...items);

  const active = engines.engines.find((e) => e.id === engines.activeId);
  address.placeholder = active
    ? `${active.type === 'ai' ? 'Demander à' : 'Rechercher sur'} ${active.name} ou saisir une adresse`
    : 'Rechercher ou saisir une adresse';
}

function resend(engineId) {
  const text = typedText();
  addressDirty = false;
  address.blur();
  window.nav.resendTo(engineId, text);
}

window.nav.onEngines((s) => {
  engines = s;
  renderEngines();
  // nouveau moteur actif : ses suggestions à lui
  if (ac.open) {
    ac.remote = [];
    updateSuggestions(false);
  }
});
window.nav.onResendShortcut((id) => resend(id));
window.nav.getEngines().then((s) => { engines = s; renderEngines(); });

// --- Favoris : étoile de la barre d'adresse + barre de favoris ---
const star = $('star');
const bmBar = $('bookmarks-bar');
const bmItems = $('bookmarks-items');
const bmMore = $('bookmarks-more');
let bm = { tree: { children: [] }, showBar: true };
let bookmarkedUrls = new Set();
let hiddenIds = []; // favoris qui ne tiennent pas dans la barre (menu »)

function collectUrls(node, out) {
  for (const c of node.children || []) {
    if (c.type === 'link') out.add(c.url);
    else collectUrls(c, out);
  }
  return out;
}

function faviconFor(url) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
  } catch {
    return '';
  }
}

function renderStar() {
  const active = state.tabs.find((t) => t.id === state.activeId);
  const url = active?.url || '';
  const can = /^https?:\/\//i.test(url);
  const on = can && bookmarkedUrls.has(url);
  star.disabled = !can;
  star.textContent = on ? '★' : '☆';
  star.setAttribute('aria-pressed', String(on));
  star.title = on ? 'Retirer des favoris (Ctrl+D)' : 'Ajouter aux favoris (Ctrl+D)';
}

function bookmarkButton(node) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bm';
  b.dataset.id = node.id;
  let ico;
  if (node.type === 'folder') {
    ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = '📁';
    b.title = node.title;
  } else {
    ico = document.createElement('img');
    ico.alt = '';
    ico.src = faviconFor(node.url);
    ico.onerror = () => {
      const s = document.createElement('span');
      s.className = 'ico';
      s.textContent = '☆';
      ico.replaceWith(s);
    };
    b.title = node.title ? `${node.title}\n${node.url}` : node.url;
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = node.title || (node.type === 'link' ? node.url : 'Dossier');
  b.append(ico, label);

  b.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  b.addEventListener('click', (e) => {
    const r = b.getBoundingClientRect();
    if (node.type === 'folder') window.nav.bookmarkFolderMenu(node.id, r.left, r.bottom);
    else window.nav.openBookmark(node.id, e.ctrlKey || e.metaKey);
  });
  b.addEventListener('auxclick', (e) => {
    if (e.button === 1 && node.type === 'link') window.nav.openBookmark(node.id, true); // clic molette
  });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.nav.bookmarkContextMenu(node.id, e.clientX, e.clientY);
  });
  return b;
}

// Les favoris qui dépassent sont masqués et proposés dans le menu »
function layoutBookmarks() {
  const buttons = [...bmItems.querySelectorAll('.bm')];
  const overflowing = () => {
    const limit = bmItems.getBoundingClientRect().right + 0.5;
    return buttons.filter((b) => b.getBoundingClientRect().right > limit);
  };
  buttons.forEach((b) => b.classList.remove('overflow'));
  bmMore.hidden = true;
  let hidden = overflowing();
  if (hidden.length) {
    bmMore.hidden = false; // le bouton » prend de la place : on remesure
    hidden = overflowing();
  }
  hidden.forEach((b) => b.classList.add('overflow'));
  hiddenIds = hidden.map((b) => b.dataset.id);
}

function renderBookmarks() {
  bookmarkedUrls = collectUrls(bm.tree, new Set());
  bmBar.hidden = !bm.showBar;
  const nodes = bm.tree.children || [];
  if (nodes.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.append('Ajoute la page courante avec ☆ ou Ctrl+D. ');
    const link = document.createElement('a');
    link.textContent = 'Importer depuis Chrome ou Edge…';
    link.addEventListener('click', () => window.nav.manageBookmarks());
    empty.append(link);
    bmItems.replaceChildren(empty);
  } else {
    bmItems.replaceChildren(...nodes.map(bookmarkButton));
  }
  layoutBookmarks();
  renderStar();
}

star.addEventListener('mousedown', (e) => e.preventDefault());
star.addEventListener('click', () => window.nav.toggleBookmark());
bmMore.addEventListener('click', () => {
  const r = bmMore.getBoundingClientRect();
  window.nav.bookmarkOverflowMenu(hiddenIds, r.left, r.bottom);
});
new ResizeObserver(layoutBookmarks).observe(bmItems);

window.nav.onBookmarks((s) => { bm = s; renderBookmarks(); });
window.nav.getBookmarks().then((s) => { if (s) { bm = s; renderBookmarks(); } });

// --- Bloqueur de pub : bouclier + nombre d'éléments bloqués sur la page ---
const adBtn = $('adblock');
const adCount = $('adblock-count');
let adblock = { enabled: true, allowlist: [], ready: false };

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

function renderAdblock() {
  const active = state.tabs.find((t) => t.id === state.activeId);
  const host = hostOf(active?.url || '');
  const allowed = !!host && adblock.allowlist.some((h) => host === h || host.endsWith('.' + h));
  const on = adblock.enabled && !allowed;
  adBtn.classList.toggle('off', !on);
  const n = on && active ? active.blocked || 0 : 0;
  adCount.hidden = n === 0;
  adCount.textContent = n > 99 ? '99+' : String(n);
  adBtn.title = !adblock.enabled ? 'Bloqueur de publicités désactivé'
    : allowed ? `Publicités autorisées sur ${host}`
    : `Bloqueur de publicités : ${n} élément(s) bloqué(s) sur cette page`;
}

adBtn.addEventListener('click', () => {
  const r = adBtn.getBoundingClientRect();
  window.nav.adblockMenu(r.left, r.bottom);
});
window.nav.onAdblock((s) => { adblock = s; renderAdblock(); });
window.nav.getAdblock().then((s) => { if (s) { adblock = s; renderAdblock(); } });

// --- Traduction de la page : bouton dans la barre d'adresse ---
// Visible quand la page est dans une autre langue que celle choisie, ou
// pendant / après une traduction. Le clic ouvre le menu (natif) de traduction.
const trBtn = $('translate');
const trProgress = $('translate-progress');
const translations = new Map(); // id d'onglet -> état envoyé par le processus principal

function renderTranslate() {
  for (const id of translations.keys()) if (!state.tabs.some((t) => t.id === id)) translations.delete(id);
  const tr = translations.get(state.activeId);
  const active = state.tabs.find((t) => t.id === state.activeId);
  const web = /^https?:/.test(active?.url || '');
  const status = tr?.status || 'idle';
  trBtn.hidden = !web || !tr || (status === 'idle' && !tr.offer);
  trBtn.className = `icon-btn ${status}`;
  trBtn.title = tr?.title || 'Traduire la page';
  const busy = status === 'downloading' || status === 'translating';
  trProgress.hidden = !busy || tr.progress == null;
  if (busy && tr.progress != null) trProgress.textContent = `${Math.round(tr.progress * 100)}`;
}

trBtn.addEventListener('mousedown', (e) => e.preventDefault());
trBtn.addEventListener('click', () => {
  const r = trBtn.getBoundingClientRect();
  window.nav.translateMenu(r.left, r.bottom);
});
window.nav.onTranslate(({ tabId, ...tr }) => {
  translations.set(tabId, tr);
  if (tabId === state.activeId) renderTranslate();
});

// La zone des pages commence sous l'interface : on transmet sa hauteur réelle
const chromeEl = $('chrome');
new ResizeObserver(() => window.nav.setChromeHeight(chromeEl.offsetHeight)).observe(chromeEl);

// Boutons Windows (réduire / agrandir / fermer) aux couleurs de la barre d'onglets
function syncTitlebarColors() {
  const cs = getComputedStyle(document.documentElement);
  window.nav.setTitlebarColors(cs.getPropertyValue('--bg').trim(), cs.getPropertyValue('--fg').trim());
}
syncTitlebarColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTitlebarColors);
