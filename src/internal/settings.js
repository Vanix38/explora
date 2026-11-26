// Page de réglages. Toutes les modifications passent par window.customNav
// (exposé uniquement aux pages explora://) et sont validées côté principal.
const api = window.customNav;
const $ = (id) => document.getElementById(id);

let cfg = null;
let draft = []; // liste des moteurs en cours d'édition
let draftDefault = null; // moteur par défaut choisi dans la liste
let favDraft = [];
let dirty = false; // modifications non enregistrées de la liste

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

const faviconFor = (url) => {
  try {
    const host = new URL(url.replace(/\{q\}|%s/g, '')).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  } catch {
    return '';
  }
};

function iconEl(src, label) {
  const img = document.createElement('img');
  img.className = 'engine-icon';
  img.alt = '';
  img.src = src;
  img.onerror = () => {
    const s = document.createElement('span');
    s.className = 'engine-icon letter-icon';
    s.textContent = (label || '?')[0].toUpperCase();
    img.replaceWith(s);
  };
  return img;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

// --- Moteurs ---
function markDirty() {
  dirty = true;
  setStatus('engine-status', 'Modifications non enregistrées.');
}

function renderEngines() {
  const list = $('engine-list');
  list.replaceChildren(...draft.map((e, i) => {
    const row = el('div', { className: 'engine-row' });

    const up = el('button', { type: 'button', textContent: '▲', title: 'Monter', disabled: i === 0 });
    const down = el('button', { type: 'button', textContent: '▼', title: 'Descendre', disabled: i === draft.length - 1 });
    up.addEventListener('click', () => { [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; markDirty(); renderEngines(); });
    down.addEventListener('click', () => { [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; markDirty(); renderEngines(); });
    const move = el('div', { className: 'move' },
      el('span', { className: 'num', textContent: i < 9 ? `Ctrl+${i + 1}` : '—', title: i < 9 ? '' : 'Pas de raccourci au-delà du 9e' }),
      up, down);

    const name = el('input', { type: 'text', className: 'name', value: e.name, placeholder: 'Nom' });
    name.setAttribute('aria-label', 'Nom');
    name.addEventListener('input', () => { e.name = name.value; markDirty(); });

    const type = el('select', { className: 'type' },
      el('option', { value: 'search', textContent: 'Moteur' }),
      el('option', { value: 'ai', textContent: 'IA' }));
    type.value = e.type;
    type.setAttribute('aria-label', 'Catégorie');
    type.addEventListener('change', () => { e.type = type.value; markDirty(); });

    const defRadio = el('input', { type: 'radio', name: 'default-engine', checked: e.id === draftDefault });
    defRadio.addEventListener('change', () => { draftDefault = e.id; markDirty(); });
    const def = el('label', { className: 'def' }, defRadio, ' Par défaut');

    const del = el('button', { type: 'button', className: 'del danger icon', textContent: '✕', title: 'Supprimer', disabled: draft.length === 1 });
    del.addEventListener('click', () => {
      draft.splice(i, 1);
      if (draftDefault === e.id) draftDefault = draft[0]?.id || null;
      markDirty();
      renderEngines();
    });

    const icon = iconEl(faviconFor(e.home || e.url), e.name);

    const url = el('input', { type: 'url', className: 'url', value: e.url, placeholder: 'https://exemple.com/search?q={q}' });
    url.setAttribute('aria-label', 'URL de recherche');
    url.addEventListener('input', () => {
      // si le site change, la page d'accueil sera recalculée à l'enregistrement
      try {
        if (e.home && new URL(url.value.replace(/\{q\}|%s/g, '')).origin !== new URL(e.home).origin) e.home = '';
      } catch { e.home = ''; }
      e.url = url.value;
      markDirty();
    });
    url.addEventListener('change', () => renderEngines()); // met l'icône à jour

    const injectBox = el('input', { type: 'checkbox', checked: !!e.inject });
    const selector = el('input', {
      type: 'text', className: 'selector', value: e.inject?.selector || '',
      placeholder: 'Sélecteur CSS du champ (facultatif)', hidden: !e.inject,
    });
    selector.setAttribute('aria-label', 'Sélecteur CSS du champ de saisie');
    injectBox.addEventListener('change', () => {
      e.inject = injectBox.checked ? { selector: selector.value } : undefined;
      selector.hidden = !injectBox.checked;
      markDirty();
    });
    selector.addEventListener('input', () => { if (e.inject) e.inject.selector = selector.value; markDirty(); });
    const urlLine = el('div', { className: 'url-line' }, url,
      el('label', { title: 'Pour les sites qui ne pré-remplissent pas la question via l’URL' }, injectBox, ' Injection dans la page'),
      selector);

    row.append(move, icon, name, type, def, del, urlLine);
    return row;
  }));
}

function loadDraft() {
  draft = structuredClone(cfg.engines).map(({ icon, ...e }) => e);
  draftDefault = cfg.activeEngine;
  dirty = false;
  renderEngines();
}

$('engine-add').addEventListener('click', () => {
  draft.push({ id: '', name: '', type: 'search', url: '', home: '' });
  markDirty();
  renderEngines();
  const rows = document.querySelectorAll('.engine-row');
  rows[rows.length - 1].querySelector('.name').focus();
});

$('engine-save').addEventListener('click', async () => {
  // les nouveaux moteurs reçoivent un identifiant côté principal : on retient
  // la position du moteur par défaut pour le retrouver après enregistrement
  const defIndex = Math.max(0, draft.findIndex((e) => e.id === draftDefault));
  const r = await api.setEngines(draft);
  if (r?.error) return setStatus('engine-status', r.error, 'error');
  dirty = false; // la prochaine mise à jour rechargera la liste enregistrée
  const saved = await api.getConfig();
  await api.setActiveEngine(saved.engines[Math.min(defIndex, saved.engines.length - 1)].id);
  setStatus('engine-status', 'Liste enregistrée.', 'ok');
});

$('engine-cancel').addEventListener('click', () => {
  loadDraft();
  setStatus('engine-status', '');
});

let resetArmed = false;
$('engine-reset').addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true;
    $('engine-reset').textContent = 'Confirmer la réinitialisation';
    setStatus('engine-status', 'La liste d’origine remplacera tes moteurs personnalisés. Clique à nouveau pour confirmer.');
    setTimeout(() => {
      resetArmed = false;
      $('engine-reset').textContent = 'Réinitialiser la liste';
    }, 5000);
    return;
  }
  resetArmed = false;
  $('engine-reset').textContent = 'Réinitialiser la liste';
  await api.resetEngines();
  dirty = false;
  setStatus('engine-status', 'Liste réinitialisée.', 'ok');
});

// --- Page d'accueil ---
function renderHome() {
  document.querySelector(`input[name="home-mode"][value="${cfg.homepage.mode}"]`).checked = true;
  $('home-url').value = cfg.homepage.url;
}

async function saveHome() {
  const mode = document.querySelector('input[name="home-mode"]:checked').value;
  const r = await api.setHomepage({ mode, url: $('home-url').value });
  if (r?.error) return setStatus('home-status', r.error, 'error');
  setStatus('home-status', 'Page d’accueil enregistrée (pour les nouveaux onglets).', 'ok');
}

document.querySelectorAll('input[name="home-mode"]').forEach((r) => r.addEventListener('change', () => {
  if (r.value === 'internal') saveHome();
  else $('home-url').focus();
}));
$('home-save').addEventListener('click', () => {
  document.querySelector('input[name="home-mode"][value="url"]').checked = true;
  saveHome();
});

// --- Favoris ---
function renderFavorites() {
  $('fav-list').replaceChildren(...favDraft.map((f, i) => {
    const name = el('input', { type: 'text', value: f.name, placeholder: 'Nom' });
    const url = el('input', { type: 'url', value: f.url, placeholder: 'https://…' });
    const del = el('button', { type: 'button', className: 'danger icon', textContent: '✕', title: 'Supprimer' });
    name.addEventListener('input', () => { f.name = name.value; });
    url.addEventListener('input', () => { f.url = url.value; });
    del.addEventListener('click', () => { favDraft.splice(i, 1); renderFavorites(); });
    return el('div', { className: 'fav-row' }, name, url, del);
  }));
}

$('fav-add').addEventListener('click', () => {
  favDraft.push({ name: '', url: '' });
  renderFavorites();
  document.querySelector('.fav-row:last-child input').focus();
});

$('fav-save').addEventListener('click', async () => {
  const r = await api.setFavorites(favDraft);
  if (r?.error) return setStatus('fav-status', r.error, 'error');
  setStatus('fav-status', 'Raccourcis enregistrés.', 'ok');
});

// --- Thème ---
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => api.setTheme(r.value)));

// --- Session et données ---
$('restore-tabs').addEventListener('change', (e) => api.setRestoreTabs(e.target.checked));

$('clear-data').addEventListener('click', () => {
  $('clear-confirm').hidden = false;
  $('clear-data').disabled = true;
  setStatus('clear-status', '');
});
$('clear-no').addEventListener('click', () => {
  $('clear-confirm').hidden = true;
  $('clear-data').disabled = false;
});
$('clear-yes').addEventListener('click', async () => {
  $('clear-yes').disabled = true;
  try {
    await api.clearBrowsingData();
    setStatus('clear-status', 'Données de navigation effacées.', 'ok');
  } catch (err) {
    setStatus('clear-status', 'Échec : ' + err.message, 'error');
  }
  $('clear-yes').disabled = false;
  $('clear-confirm').hidden = true;
  $('clear-data').disabled = false;
});

// --- Chargement / mises à jour ---
function apply(c) {
  cfg = c;
  if (!dirty) loadDraft(); // ne pas écraser une édition en cours
  if (document.activeElement !== $('home-url')) renderHome();
  document.querySelector(`input[name="theme"][value="${cfg.theme}"]`).checked = true;
  $('restore-tabs').checked = cfg.restoreTabs;
}

api.onConfig(apply);
api.getConfig().then((c) => {
  apply(c);
  favDraft = structuredClone(c.favorites);
  renderFavorites();
});

// --- Barre latérale ---
const sideApi = api.sidebar;

function sideIcon(item) {
  if (item.icon) return el('img', { className: 'side-icon', alt: '', src: item.icon });
  const s = el('span', { className: 'side-icon', textContent: (item.name || '?')[0].toUpperCase() });
  if (item.color) s.style.background = item.color;
  return s;
}

async function sideCall(promise, statusId = 'sidebar-status') {
  const r = await promise;
  if (r?.error) {
    setStatus(statusId, r.error, 'error');
    return false;
  }
  setStatus(statusId, '');
  if (r?.items) renderSidebar(r);
  return true;
}

function sideRow(item, i, st) {
  const row = el('div', { className: 'side-row' + (item.enabled ? '' : ' off') });
  row.dataset.id = item.id;

  const up = el('button', { type: 'button', textContent: '▲', title: 'Monter', disabled: i === 0 });
  const down = el('button', { type: 'button', textContent: '▼', title: 'Descendre', disabled: i === st.items.length - 1 });
  up.addEventListener('click', () => sideCall(sideApi.move(item.id, -1)));
  down.addEventListener('click', () => sideCall(sideApi.move(item.id, 1)));

  const name = el('input', { type: 'text', className: 'name', value: item.name, placeholder: 'Nom' });
  name.setAttribute('aria-label', 'Nom');
  name.addEventListener('change', () => sideCall(sideApi.update(item.id, { name: name.value })));

  const url = el('input', { type: 'text', className: 'url', value: item.url, placeholder: 'https://…' });
  url.setAttribute('aria-label', 'Adresse');
  url.addEventListener('change', () => sideCall(sideApi.update(item.id, { url: url.value })));

  const width = el('select', { className: 'width', title: 'Largeur du panneau' },
    ...Object.entries(st.widths).map(([value, label]) => el('option', { value, textContent: label })));
  width.value = item.width;
  width.setAttribute('aria-label', 'Largeur du panneau');
  width.addEventListener('change', () => sideCall(sideApi.update(item.id, { width: width.value })));

  const enabledBox = el('input', { type: 'checkbox', checked: item.enabled });
  enabledBox.addEventListener('change', () => sideCall(sideApi.update(item.id, { enabled: enabledBox.checked })));
  const enabled = el('label', { className: 'enabled', title: 'Chargée en arrière-plan (messages, notifications)' }, enabledBox, ' Activée');

  const del = el('button', { type: 'button', className: 'del danger icon', textContent: '✕', title: `Retirer ${item.name}` });
  del.addEventListener('click', () => {
    if (del.dataset.confirm !== '1') {
      del.dataset.confirm = '1';
      del.textContent = 'Retirer ?';
      setStatus('sidebar-status', `Retirer ${item.name} efface aussi ses données de connexion. Clique à nouveau pour confirmer.`);
      setTimeout(() => {
        delete del.dataset.confirm;
        del.textContent = '✕';
      }, 5000);
      return;
    }
    sideCall(sideApi.remove(item.id));
  });

  const iconUrl = el('input', {
    type: 'text',
    className: 'icon-url',
    placeholder: item.customIcon
      ? 'Icône personnalisée (vider puis Entrée pour reprendre celle du site)'
      : "Icône personnalisée : adresse d'une image (facultatif)",
  });
  iconUrl.setAttribute('aria-label', "Adresse de l'icône");
  iconUrl.addEventListener('change', () => {
    if (iconUrl.value) sideCall(sideApi.update(item.id, { iconUrl: iconUrl.value }));
  });
  iconUrl.addEventListener('keydown', (e) => {
    // Entrée sur un champ vide : revient à l'icône du site
    if (e.key === 'Enter' && !iconUrl.value && item.customIcon) sideCall(sideApi.update(item.id, { iconUrl: '' }));
  });

  const badgeBox = el('input', { type: 'checkbox', checked: item.badge });
  badgeBox.addEventListener('change', () => sideCall(sideApi.update(item.id, { badge: badgeBox.checked })));
  const badge = el('label', { className: 'badge-opt', title: 'Nombre de non-lus lu dans le titre de la page' }, badgeBox, ' Badge non-lus');

  row.append(el('div', { className: 'move' }, up, down), sideIcon(item), name, url, width, enabled, del, iconUrl, badge);
  return row;
}

function renderSidebar(st) {
  $('sidebar-visible').checked = st.railVisible;
  // pas de reconstruction pendant qu'on écrit dans un champ de la liste
  if (!document.activeElement?.closest?.('#sidebar-list input[type=text]')) {
    $('sidebar-list').replaceChildren(...(st.items.length
      ? st.items.map((item, i) => sideRow(item, i, st))
      : [el('p', { className: 'help', textContent: 'Aucune intégration : ajoute-en une ci-dessous.' })]));
  }
  $('sidebar-catalog').replaceChildren(...st.catalog.map((p) => {
    const b = el('button', { type: 'button', disabled: p.added, title: p.added ? 'Déjà dans la barre' : `Ajouter ${p.name} (${p.url})` },
      sideIcon({ name: p.name, color: p.color }), p.name);
    b.addEventListener('click', () => sideCall(sideApi.add({ preset: p.id }), 'sidebar-add-status'));
    return b;
  }));
}

$('sidebar-visible').addEventListener('change', (e) => sideCall(sideApi.setVisible(e.target.checked)));
$('sidebar-custom').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  setStatus('sidebar-add-status', 'Ajout…');
  const ok = await sideCall(sideApi.add({
    name: $('custom-name').value,
    url: $('custom-url').value,
    iconUrl: $('custom-icon').value,
  }), 'sidebar-add-status');
  if (btn) btn.disabled = false;
  if (ok) {
    $('sidebar-custom').reset();
    setStatus('sidebar-add-status', 'Site ajouté à la barre latérale.', 'ok');
  }
});
sideApi.onChange(renderSidebar);
sideApi.get().then(renderSidebar);

// --- Bloqueur de publicités ---
const adApi = api.adblock;

function renderAdblock(st) {
  $('adblock-enabled').checked = st.enabled;
  $('adblock-allowlist').replaceChildren(...(st.allowlist.length ? st.allowlist.map((host) => {
    const del = el('button', { type: 'button', className: 'icon danger', textContent: '✕', title: `Bloquer à nouveau sur ${host}` });
    del.addEventListener('click', () => adApi.setAllowed(host, false));
    return el('div', { className: 'row allow-row' }, el('span', { className: 'host', textContent: host }), del);
  }) : [el('p', { className: 'help', textContent: 'Aucun : les publicités sont bloquées partout.' })]));
  const date = st.listsDate ? new Date(st.listsDate).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  $('adblock-lists').textContent = st.error ? st.error
    : date ? `Listes du ${date} (mises à jour automatiquement tous les 3 jours).`
    : 'Téléchargement des listes en cours…';
}

$('adblock-enabled').addEventListener('change', (e) => adApi.setEnabled(e.target.checked));
$('adblock-allow-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await adApi.setAllowed($('adblock-host').value, true);
  if (r?.error) setStatus('adblock-status', r.error, 'error');
  else {
    setStatus('adblock-status', '');
    $('adblock-host').value = '';
  }
});
$('adblock-update').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus('adblock-status', 'Téléchargement des listes…');
  const r = await adApi.updateLists();
  setStatus('adblock-status', r?.error || 'Listes à jour.', r?.error ? 'error' : 'ok');
  e.target.disabled = false;
});
adApi.onChange(renderAdblock);
adApi.status().then(renderAdblock);

// --- Traduction ---
const trApi = api.translation;
const trBusy = new Set(); // langues en cours de téléchargement lancé depuis cette page

const formatSize = (bytes) => `${Math.round(bytes / 1e6)} Mo`;

function renderTranslation(st) {
  const sel = $('translation-target');
  if (document.activeElement !== sel) {
    const targets = st.targets.length ? st.targets : [{ code: st.target, name: st.target }];
    sel.replaceChildren(...targets.map((t) => el('option', { value: t.code, textContent: t.name })));
    sel.value = st.target;
  }

  $('translation-always').replaceChildren(...(st.always.length ? st.always.map((a) => {
    const del = el('button', { type: 'button', className: 'icon danger', textContent: '✕', title: `Ne plus traduire automatiquement ${a.name.toLowerCase()}` });
    del.addEventListener('click', () => trApi.setAlways(a.code, false));
    return el('div', { className: 'row allow-row' }, el('span', { textContent: a.name }), del);
  }) : [el('p', { className: 'help', textContent: 'Aucune langue. Choisis « Toujours traduire… » dans le menu du bouton de traduction.' })]));

  if (st.loading) {
    $('translation-langs').replaceChildren(el('p', { className: 'help', textContent: 'Chargement de la liste des langues…' }));
  } else if (st.error) {
    $('translation-langs').replaceChildren(el('p', { className: 'status error', textContent: st.error }));
  } else {
    $('translation-langs').replaceChildren(...st.languages.map((l) => {
      const name = el('span', { className: 'lang-name', textContent: l.name });
      if (l.experimental) name.append(el('span', { className: 'badge', textContent: 'expérimental' }));
      let state;
      let action;
      if (l.downloading) {
        state = `Téléchargement… ${l.progress != null ? Math.round(l.progress * 100) + ' %' : ''}`;
        action = el('button', { type: 'button', textContent: 'Télécharger', disabled: true });
      } else if (l.installed) {
        state = `Installée · ${formatSize(l.size)}`;
        action = el('button', { type: 'button', className: 'danger', textContent: 'Supprimer' });
        action.addEventListener('click', async () => {
          const r = await trApi.remove(l.code);
          setStatus('translation-status', r?.error || '', r?.error ? 'error' : '');
        });
      } else {
        // une seule direction installée (téléchargée automatiquement par une traduction)
        const lower = l.name.toLowerCase();
        state = !l.partial ? formatSize(l.size)
          : l.toEn ? `${l.name} → anglais installé` : `Anglais → ${lower} installé`;
        action = el('button', { type: 'button', textContent: l.partial ? `Compléter (${formatSize(l.missingSize)})` : 'Télécharger' });
        action.addEventListener('click', async () => {
          trBusy.add(l.code);
          action.disabled = true;
          setStatus('translation-status', '');
          const r = await trApi.install(l.code);
          trBusy.delete(l.code);
          setStatus('translation-status', r?.error ? `${l.name} : ${r.error}` : `${l.name} installée.`, r?.error ? 'error' : 'ok');
        });
      }
      return el('div', { className: 'row lang-row' }, name,
        el('span', { className: 'lang-state', textContent: state }), action);
    }));
  }
}

$('translation-target').addEventListener('change', (e) => trApi.setTarget(e.target.value));
trApi.onChange(renderTranslation);
trApi.status().then(renderTranslation);

// --- Serveur MCP ---
const mcpApi = api.mcp;

function renderMcp(st) {
  $('mcp-enabled').checked = st.enabled;
  $('mcp-details').hidden = !st.enabled;
  $('mcp-url').textContent = st.url;
  $('mcp-cmd-code').textContent = `claude mcp add --transport http explora ${st.url} --header "Authorization: Bearer ${st.token}"`;
  $('mcp-cmd-desktop').textContent = JSON.stringify({
    'explora': {
      command: 'npx',
      args: ['-y', 'mcp-remote', st.url, '--header', 'Authorization:${AUTH_HEADER}'],
      env: { AUTH_HEADER: `Bearer ${st.token}` },
    },
  }, null, 2);
  setStatus('mcp-state', st.error ? st.error : st.running ? 'Serveur actif.' : 'Démarrage…', st.error ? 'error' : st.running ? 'ok' : '');
}

$('mcp-enabled').addEventListener('change', (e) => mcpApi.setEnabled(e.target.checked));
$('mcp-regen').addEventListener('click', (e) => {
  if (e.target.dataset.confirm !== '1') {
    e.target.dataset.confirm = '1';
    e.target.textContent = 'Confirmer : les IA déjà configurées devront être reconfigurées';
    return;
  }
  delete e.target.dataset.confirm;
  e.target.textContent = 'Changer le jeton';
  mcpApi.regenerateToken();
});
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  await navigator.clipboard.writeText($(b.dataset.copy).textContent);
  b.textContent = 'Copié ✓';
  setTimeout(() => { b.textContent = 'Copier'; }, 1500);
}));
mcpApi.onChange(renderMcp);
mcpApi.status().then(renderMcp);
