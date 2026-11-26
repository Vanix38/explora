// Gestionnaire de favoris (explora://bookmarks/). Chaque modification est
// envoyée tout de suite au processus principal, qui valide et enregistre.
const api = window.customNav.bookmarks;
const $ = (id) => document.getElementById(id);

let state = { tree: { id: 'bar', children: [] }, showBar: true };
const collapsed = new Set(); // dossiers repliés

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function setStatus(id, text, kind = '') {
  const s = $(id);
  s.textContent = text || '';
  s.className = 'status' + (kind ? ' ' + kind : '');
}

// Applique une modification et affiche l'éventuelle erreur
async function apply(statusId, promise, okText) {
  try {
    const r = await promise;
    if (r?.error) setStatus(statusId, r.error, 'error');
    else setStatus(statusId, okText || '', okText ? 'ok' : '');
    return r || {};
  } catch (e) {
    setStatus(statusId, String(e.message || e), 'error');
    return { error: true };
  }
}

function faviconFor(url) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
  } catch {
    return '';
  }
}

// Liste des dossiers (pour les menus « Déplacer vers » / « Dossier »)
function folders(node = state.tree, depth = 0, out = [{ id: state.tree.id, label: 'Barre de favoris', node: state.tree }]) {
  for (const c of node.children) {
    if (c.type !== 'folder') continue;
    out.push({ id: c.id, label: `${'  '.repeat(depth + 1)}📁 ${c.title}`, node: c });
    folders(c, depth + 1, out);
  }
  return out;
}

function contains(folder, id) {
  return folder.children.some((c) => c.id === id || (c.type === 'folder' && contains(c, id)));
}

function matches(node, q) {
  if (!q) return true;
  if (node.type === 'folder') return node.title.toLowerCase().includes(q) || node.children.some((c) => matches(c, q));
  return node.title.toLowerCase().includes(q) || node.url.toLowerCase().includes(q);
}

function moveSelect(node, parent) {
  const sel = el('select', { title: 'Déplacer vers' });
  sel.append(el('option', { value: '', textContent: 'Déplacer…' }));
  for (const f of folders()) {
    // un dossier ne peut pas aller dans lui-même ni dans ses sous-dossiers
    if (node.type === 'folder' && (f.id === node.id || contains(node, f.id))) continue;
    if (f.id === parent.id) continue;
    sel.append(el('option', { value: f.id, textContent: f.label }));
  }
  sel.addEventListener('change', () => {
    if (sel.value) apply('tree-status', api.move(node.id, sel.value));
  });
  return sel;
}

function row(node, parent, index, depth) {
  const r = el('div', { className: 'node ' + node.type });
  r.style.setProperty('--depth', depth);
  r.setAttribute('role', 'treeitem');

  let ico;
  if (node.type === 'folder') {
    ico = el('span', { className: 'ico', textContent: collapsed.has(node.id) ? '📁' : '📂', title: 'Replier / déplier' });
    ico.addEventListener('click', () => {
      if (collapsed.has(node.id)) collapsed.delete(node.id);
      else collapsed.add(node.id);
      render();
    });
  } else {
    ico = el('img', { className: 'ico', alt: '', src: faviconFor(node.url) });
    ico.onerror = () => ico.replaceWith(el('span', { className: 'ico', textContent: '☆' }));
  }

  const title = el('input', { type: 'text', className: 'title', value: node.title, placeholder: 'Nom' });
  title.setAttribute('aria-label', 'Nom');
  title.addEventListener('change', () => apply('tree-status', api.update(node.id, { title: title.value }), 'Enregistré.'));
  const cells = [ico, title];

  if (node.type === 'link') {
    const url = el('input', { type: 'url', className: 'url', value: node.url, placeholder: 'https://…' });
    url.setAttribute('aria-label', 'Adresse');
    url.addEventListener('change', async () => {
      const res = await apply('tree-status', api.update(node.id, { url: url.value }), 'Enregistré.');
      if (res.error) url.value = node.url;
    });
    cells.push(url);
  }

  const up = el('button', { type: 'button', textContent: '▲', title: 'Monter', disabled: index === 0 });
  const down = el('button', { type: 'button', textContent: '▼', title: 'Descendre', disabled: index === parent.children.length - 1 });
  up.addEventListener('click', () => apply('tree-status', api.move(node.id, parent.id, index - 1)));
  down.addEventListener('click', () => apply('tree-status', api.move(node.id, parent.id, index + 2)));
  const del = el('button', { type: 'button', textContent: '✕', className: 'danger', title: node.type === 'folder' ? 'Supprimer le dossier et son contenu' : 'Supprimer' });
  del.addEventListener('click', async () => {
    const n = node.type === 'folder' ? countLinks(node) : 0;
    if (n > 0 && del.dataset.confirm !== '1') {
      del.dataset.confirm = '1';
      del.textContent = '?';
      setStatus('tree-status', `Ce dossier contient ${n} favori(s) : clique à nouveau sur ? pour le supprimer.`, 'error');
      return;
    }
    apply('tree-status', api.remove(node.id), 'Supprimé.');
  });
  cells.push(el('div', { className: 'tools' }, moveSelect(node, parent), up, down, del));

  r.append(...cells);
  return r;
}

function countLinks(folder) {
  return folder.children.reduce((n, c) => n + (c.type === 'link' ? 1 : countLinks(c)), 0);
}

function renderTree() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = [];
  const walk = (parent, depth) => {
    parent.children.forEach((node, i) => {
      if (!matches(node, q)) return;
      rows.push(row(node, parent, i, depth));
      if (node.type === 'folder' && (q || !collapsed.has(node.id))) walk(node, depth + 1);
    });
  };
  walk(state.tree, 0);
  if (rows.length === 0) {
    rows.push(el('p', { className: 'empty', textContent: q ? 'Aucun favori ne correspond.' : 'Aucun favori pour le moment.' }));
  }
  $('tree').replaceChildren(...rows);
}

function renderFolderSelects() {
  for (const id of ['new-parent', 'folder-parent']) {
    const sel = $(id);
    const prev = sel.value;
    sel.replaceChildren(...folders().map((f) => el('option', { value: f.id, textContent: f.label })));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
}

function render() {
  $('show-bar').checked = state.showBar;
  renderTree();
  renderFolderSelects();
}

$('filter').addEventListener('input', renderTree);
$('show-bar').addEventListener('change', (e) => api.setShowBar(e.target.checked));

$('add-link').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await apply('add-status', api.addLink({ title: $('new-title').value, url: $('new-url').value.trim(), parentId: $('new-parent').value }), 'Favori ajouté.');
  if (!r.error) {
    $('new-title').value = '';
    $('new-url').value = '';
  }
});

$('add-folder').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await apply('add-status', api.addFolder({ title: $('folder-title').value, parentId: $('folder-parent').value }), 'Dossier créé.');
  if (!r.error) $('folder-title').value = '';
});

async function renderImport() {
  const sources = await window.customNav.bookmarks.importSources();
  const box = $('import-buttons');
  if (!sources.length) {
    box.replaceChildren(el('span', { className: 'help', textContent: 'Aucun Chrome, Edge ou Brave trouvé sur ce PC.' }));
    return;
  }
  box.replaceChildren(...sources.map((s) => {
    const b = el('button', { type: 'button', textContent: `Importer depuis ${s.name}` });
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await apply('import-status', api.importFrom(s.id));
      if (!r.error) setStatus('import-status', `${r.count} favori(s) importé(s) depuis ${s.name}.`, 'ok');
      b.disabled = false;
    });
    return b;
  }));
}

api.onChange((s) => { state = s; render(); });
api.get().then((s) => { state = s; render(); });
renderImport();
