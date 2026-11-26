// Onglet « Renvoyer » : liste les requêtes de l'onglet inspecté, permet d'en
// modifier une (méthode, URL, en-têtes, corps) et de la renvoyer. L'envoi est
// fait par Explora (src/main/resend.js) via explora-devtools://resend/.
const ENDPOINT = 'explora-devtools://resend/';
const MAX_ENTRIES = 1000;

const $ = (id) => document.getElementById(id);
const list = $('list');
const empty = $('empty');
const filter = $('filter');
const form = $('form');
const methodInput = $('method');
const urlInput = $('url');
const headersInput = $('headers');
const bodyInput = $('body');
const sendBtn = $('send');

const entries = []; // { id, method, url, status, headers, body } ou { separator }
let nextId = 1;
let selectedId = null;
let lastResponse = '';

if (chrome.devtools.panels.themeName === 'dark') document.documentElement.dataset.theme = 'dark';

// --- Liste des requêtes ---
const statusClass = (s) => (!s ? 'err' : s >= 400 ? 'err' : s >= 300 ? 'warn' : 'ok');

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname + u.search;
  } catch {
    return url;
  }
}

function matches(e, q) {
  if (!q) return true;
  return `${e.method} ${e.url} ${e.status || ''}`.toLowerCase().includes(q);
}

function render() {
  const q = filter.value.trim().toLowerCase();
  list.textContent = '';
  for (const e of entries) {
    const li = document.createElement('li');
    if (e.separator) {
      if (q) continue;
      li.className = 'separator';
      li.textContent = `— ${e.separator}`;
      list.append(li);
      continue;
    }
    if (!matches(e, q)) continue;
    li.dataset.id = e.id;
    li.title = `${e.method} ${e.url}`;
    if (e.id === selectedId) li.className = 'selected';
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = e.resent ? `↻ ${e.method}` : e.method;
    if (e.resent) li.title += ' (renvoyée)';
    const s = document.createElement('span');
    s.className = `s ${statusClass(e.status)}`;
    s.textContent = e.status || '—';
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = shortUrl(e.url);
    li.append(m, s, u);
    list.append(li);
  }
  empty.hidden = entries.some((e) => !e.separator);
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    render();
    if (atBottom) list.scrollTop = list.scrollHeight;
  });
}

function addHarEntry(har) {
  const r = har.request;
  if (!r || !/^https?:/i.test(r.url)) return;
  entries.push({
    id: nextId++,
    method: r.method,
    url: r.url,
    status: har.response?.status || 0,
    // pseudo-en-têtes HTTP/2 (:authority, :path…) inutiles à l'édition
    headers: (r.headers || []).filter((h) => !h.name.startsWith(':')),
    body: r.postData?.text ?? '',
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  renderSoon();
}

chrome.devtools.network.getHAR((har) => {
  for (const e of har?.entries || []) addHarEntry(e);
  list.scrollTop = list.scrollHeight;
});
chrome.devtools.network.onRequestFinished.addListener(addHarEntry);
chrome.devtools.network.onNavigated.addListener((url) => {
  entries.push({ separator: `Navigation vers ${url}` });
  renderSoon();
});

list.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const e = entries.find((x) => x.id === Number(li.dataset.id));
  if (!e) return;
  selectedId = e.id;
  load(e);
  render();
});

filter.addEventListener('input', render);
$('clear').addEventListener('click', () => {
  entries.length = 0;
  selectedId = null;
  render();
});
$('new').addEventListener('click', () => {
  selectedId = null;
  load({ method: 'GET', url: '', headers: [], body: '' });
  render();
  urlInput.focus();
});

// --- Éditeur ---
function load(e) {
  methodInput.value = e.method;
  urlInput.value = e.url;
  headersInput.value = e.headers.map((h) => `${h.name}: ${h.value}`).join('\n');
  bodyInput.value = e.body;
}

function parseHeaders(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // « :authority: x » (HTTP/2) : on saute le premier « : »
    const i = line.indexOf(':', line.startsWith(':') ? 1 : 0);
    if (i <= 0) {
      out.push({ name: line, value: '' });
      continue;
    }
    out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

const mode = () => form.querySelector('input[name="mode"]:checked').value;

// Ctrl+Entrée envoie depuis n'importe quel champ
form.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }
  const payload = {
    token: window.customNavResendToken, // déposé par Explora
    tabId: chrome.devtools.inspectedWindow.tabId,
    mode: mode(),
    method: methodInput.value.trim().toUpperCase() || 'GET',
    url,
    headers: parseHeaders(headersInput.value),
    body: bodyInput.value,
    followRedirects: $('follow').checked,
  };
  sendBtn.disabled = true;
  sendBtn.textContent = 'Envoi…';
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      // text/plain : pas de requête préalable CORS
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    showResult(result);
    // envoyée par le navigateur, la requête n'apparaît pas dans l'onglet Réseau :
    // on l'ajoute à la liste pour pouvoir la modifier à nouveau
    if (!result.error && payload.mode === 'browser') {
      const e = { id: nextId++, resent: true, method: payload.method, url: payload.url, status: result.status, headers: payload.headers, body: payload.body };
      entries.push(e);
      selectedId = e.id;
      renderSoon();
    }
  } catch (e) {
    showResult({ error: `Explora n'a pas pu envoyer la requête (${e.message}).` });
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Envoyer';
  }
});

// --- Réponse ---
function formatSize(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function prettyBody(text, headers) {
  const type = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch { /* pas du JSON valide : tel quel */ }
  }
  return text;
}

function showResult(r) {
  $('result').hidden = false;
  const status = $('status');
  const notice = $('notice');
  const notes = [];
  if (r.error) {
    status.className = 'status err';
    status.textContent = 'Échec';
    $('meta').textContent = '';
    $('res-headers').textContent = '';
    $('res-headers-box').hidden = true;
    $('res-body').textContent = r.error;
    lastResponse = r.error;
    notice.hidden = true;
    return;
  }
  status.className = `status ${statusClass(r.status)}`;
  status.textContent = `${r.status} ${r.statusText || ''}`.trim();
  const meta = [`${r.time} ms`, formatSize(r.size)];
  if (r.redirected) meta.push(`redirigée vers ${r.url}`);
  $('meta').textContent = meta.join(' · ');
  $('res-headers-box').hidden = false;
  $('res-headers').textContent = r.headers.map((h) => `${h.name}: ${h.value}`).join('\n');
  if (r.ignored?.length) notes.push(`En-têtes non envoyés tels quels (gérés par le navigateur) : ${r.ignored.join(', ')}.`);
  if (r.invalid?.length) notes.push(`En-têtes invalides ignorés : ${r.invalid.join(', ')}.`);
  if (r.truncated) notes.push('Réponse tronquée à 5 Mo.');
  notice.textContent = notes.join(' ');
  notice.hidden = !notes.length;
  if (r.body == null) {
    lastResponse = '';
    $('res-body').textContent = `(contenu binaire, ${formatSize(r.size)})`;
  } else {
    lastResponse = r.body;
    $('res-body').textContent = prettyBody(r.body, r.headers) || '(réponse vide)';
  }
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastResponse);
  } catch {
    // presse-papiers refusé dans le cadre DevTools : on passe par une sélection
    const ta = document.createElement('textarea');
    ta.value = lastResponse;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
});

render();
