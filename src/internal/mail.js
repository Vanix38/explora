// Page Courrier : comptes et dossiers, liste, lecture, rédaction.
// Tout passe par window.customNav.mail.call(action, …) (voir src/main/mail.js).
const api = window.customNav.mail;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(e.dataset, v);
    else e[k] = v;
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

// Appel au processus principal ; les erreurs reviennent sous forme { error }
async function call(action, ...args) {
  try {
    const res = await api.call(action, ...args);
    return res ?? {};
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

let toastTimer = null;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const state = {
  accounts: [],
  folders: new Map(), // accountId -> { list, error, collapsed, loading }
  current: null, // { accountId, folder }
  messages: [],
  cursor: null,
  total: 0,
  query: '',
  selectedUid: null,
  message: null, // message affiché
  allowRemote: false,
  listRequest: 0,
  messageRequest: 0,
};

const accountById = (id) => state.accounts.find((a) => a.id === id);
const folderInfo = (accountId, path) => state.folders.get(accountId)?.list?.find((f) => f.path === path);

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fullDayFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const longFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function shortDate(t) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayFmt.format(d);
  return fullDayFmt.format(d);
}

function size(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

const displayName = (a) => (a ? a.name || a.address || '' : '');
const formatAddress = (a) => (a.name ? `${a.name.includes(',') ? `"${a.name}"` : a.name} <${a.address}>` : a.address);
const formatList = (list) => list.map(formatAddress).join(', ');

// ---------------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------------
const SPECIAL = {
  '\\Inbox': { icon: '📥', name: 'Boîte de réception', rank: 0 },
  '\\Drafts': { icon: '📝', rank: 1 },
  '\\Sent': { icon: '📤', rank: 2 },
  '\\Archive': { icon: '🗄', rank: 3 },
  '\\Flagged': { icon: '⭐', rank: 4 },
  '\\All': { icon: '📚', rank: 5 },
  '\\Junk': { icon: '⚠', rank: 6 },
  '\\Trash': { icon: '🗑', rank: 7 },
};

const folderLabel = (f) => (f.specialUse === '\\Inbox' ? SPECIAL['\\Inbox'].name : f.name);

// Range les dossiers en arbre : réception et dossiers spéciaux d'abord
function orderedFolders(list) {
  const byParent = new Map();
  for (const f of list) {
    const key = list.some((p) => p.path === f.parent) ? f.parent : '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  const rank = (f) => SPECIAL[f.specialUse]?.rank ?? 50;
  const out = [];
  const walk = (parent, depth) => {
    const children = (byParent.get(parent) || []).sort((a, b) => rank(a) - rank(b) || folderLabel(a).localeCompare(folderLabel(b), 'fr'));
    for (const f of children) {
      out.push({ ...f, depth });
      walk(f.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

function renderFolders() {
  const nav = $('folders');
  nav.textContent = '';
  if (!state.accounts.length) {
    nav.append(el('div', { className: 'welcome' },
      el('p', { textContent: 'Aucun compte de messagerie pour le moment.' }),
      el('button', { type: 'button', className: 'primary', textContent: 'Ajouter un compte', onclick: () => openAccounts(true) })));
    return;
  }
  for (const acc of state.accounts) {
    const info = state.folders.get(acc.id) || {};
    const head = el('div', { className: 'account-head' + (info.collapsed ? ' collapsed' : ''), title: acc.email },
      el('span', { className: 'caret', textContent: '▾' }),
      el('span', { className: 'email', textContent: acc.name ? `${acc.name} · ${acc.email}` : acc.email }));
    head.onclick = () => {
      info.collapsed = !info.collapsed;
      state.folders.set(acc.id, info);
      renderFolders();
    };
    nav.append(head);
    if (info.collapsed) continue;
    if (info.error) {
      nav.append(el('div', { className: 'account-error', textContent: info.error }));
      continue;
    }
    if (!info.list) {
      nav.append(el('div', { className: 'account-error', style: 'color:var(--fg-dim)', textContent: 'Connexion…' }));
      continue;
    }
    for (const f of orderedFolders(info.list)) {
      const active = state.current?.accountId === acc.id && state.current.folder === f.path;
      const btn = el('button', {
        type: 'button',
        className: 'folder' + (active ? ' active' : '') + (f.noselect ? ' noselect' : '') + (f.unseen ? ' has-unseen' : ''),
        title: f.path,
        style: `padding-left:${8 + f.depth * 14}px`,
      },
      el('span', { className: 'ficon', textContent: SPECIAL[f.specialUse]?.icon || (f.noselect ? '▸' : '📁') }),
      el('span', { className: 'fname', textContent: folderLabel(f) }),
      f.unseen ? el('span', { className: 'count', textContent: String(f.unseen) }) : null);
      if (!f.noselect) btn.onclick = () => selectFolder(acc.id, f.path);
      nav.append(btn);
    }
  }
}

async function loadFolders(accountId) {
  const info = state.folders.get(accountId) || {};
  state.folders.set(accountId, info);
  const res = await call('folders', accountId);
  if (res.error) {
    info.error = res.error;
    info.list = null;
  } else {
    info.error = null;
    info.list = res;
  }
  renderFolders();
  renderMoveTargets();
  return !res.error;
}

function updateTitle(total) {
  document.title = total ? `(${total}) Courrier` : 'Courrier';
}

// ---------------------------------------------------------------------------
// Liste des messages
// ---------------------------------------------------------------------------
async function selectFolder(accountId, folder, { keepSelection = false } = {}) {
  const changed = state.current?.accountId !== accountId || state.current?.folder !== folder;
  state.current = { accountId, folder };
  if (changed) {
    $('search').value = '';
    state.query = '';
    if (!keepSelection) showMessage(null);
  }
  renderFolders();
  renderMoveTargets();
  await loadMessages({ keepSelection });
}

async function loadMessages({ append = false, keepSelection = false } = {}) {
  if (!state.current) return;
  const { accountId, folder } = state.current;
  const req = ++state.listRequest;
  if (!append) {
    $('list-info').textContent = 'Chargement…';
    if (!keepSelection) $('messages').textContent = '';
  }
  const res = await call('messages', accountId, folder, { query: state.query, cursor: append ? state.cursor : null });
  if (req !== state.listRequest) return; // une requête plus récente a été lancée
  if (res.error) {
    $('list-info').textContent = res.error;
    return;
  }
  state.messages = append ? state.messages.concat(res.messages) : res.messages;
  state.cursor = res.cursor;
  state.total = res.total;
  renderMessages();
}

function renderMessages() {
  const box = $('messages');
  box.textContent = '';
  const f = folderInfo(state.current?.accountId, state.current?.folder);
  const where = f ? folderLabel(f) : '';
  $('list-info').textContent = state.query
    ? `${state.total} résultat${state.total > 1 ? 's' : ''} pour « ${state.query} » dans ${where}`
    : `${where} · ${state.total} message${state.total > 1 ? 's' : ''}`;
  if (!state.messages.length) {
    box.append(el('div', { className: 'empty', style: 'padding:30px', textContent: state.query ? 'Aucun résultat.' : 'Ce dossier est vide.' }));
  }
  const sentLike = ['\\Sent', '\\Drafts'].includes(f?.specialUse);
  for (const m of state.messages) {
    const who = sentLike ? `À : ${m.to.map(displayName).join(', ')}` : displayName(m.from) || '(inconnu)';
    const row = el('div', {
      className: 'msg' + (m.seen ? '' : ' unseen') + (m.uid === state.selectedUid ? ' selected current' : ''),
      role: 'option',
      dataset: { uid: m.uid },
    },
    el('span', { className: 'star' + (m.flagged ? ' on' : ''), textContent: m.flagged ? '★' : '☆', title: 'Étoile' }),
    el('span', { className: 'from', textContent: who, title: m.from.address }),
    el('span', { className: 'date', textContent: shortDate(m.date) },
      m.attachments ? el('span', { className: 'flags', textContent: '📎' }) : null,
      m.answered ? el('span', { className: 'flags', textContent: '↩' }) : null),
    el('span', { className: 'subject', textContent: m.subject || '(sans objet)', title: m.subject }));
    row.querySelector('.star').onclick = (e) => {
      e.stopPropagation();
      setFlags([m.uid], { flagged: !m.flagged });
    };
    row.onclick = () => openMessage(m.uid);
    box.append(row);
  }
  $('more').hidden = !state.cursor;
}

function markRow(uid, changes) {
  const m = state.messages.find((x) => x.uid === uid);
  if (m) Object.assign(m, changes);
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
async function openMessage(uid) {
  if (!state.current) return;
  const { accountId, folder } = state.current;
  state.selectedUid = uid;
  state.allowRemote = false;
  const row = state.messages.find((m) => m.uid === uid);
  const wasUnseen = row && !row.seen;
  if (row) row.seen = true;
  renderMessages();
  document.querySelector('.msg.selected')?.scrollIntoView({ block: 'nearest' });
  const req = ++state.messageRequest;
  const res = await call('message', accountId, folder, uid);
  if (req !== state.messageRequest) return;
  if (res.error) {
    toast(res.error, 'error');
    return;
  }
  res.accountId = accountId;
  showMessage(res);
  if (wasUnseen) bumpUnseen(accountId, folder, -1);
}

function bumpUnseen(accountId, folder, delta) {
  const f = folderInfo(accountId, folder);
  if (f) f.unseen = Math.max(0, (f.unseen || 0) + delta);
  renderFolders();
}

function addressSpan(a) {
  const chip = el('span', { className: 'addr-chip', title: `Écrire à ${a.address}` },
    a.name ? `${a.name} ` : '', el('span', { className: 'addr', textContent: a.name ? `<${a.address}>` : a.address }));
  chip.onclick = () => openCompose('new', { to: formatAddress(a) });
  return chip;
}

function fillAddresses(target, list) {
  target.textContent = '';
  list.forEach((a, i) => {
    if (i) target.append(', ');
    target.append(addressSpan(a));
  });
}

function showMessage(msg) {
  state.message = msg;
  $('reader-empty').hidden = !!msg;
  $('message').hidden = !msg;
  if (!msg) {
    state.selectedUid = null;
    $('msg-body').srcdoc = '';
    return;
  }
  $('msg-subject').textContent = msg.subject || '(sans objet)';
  fillAddresses($('msg-from'), [msg.from]);
  fillAddresses($('msg-to'), msg.to);
  fillAddresses($('msg-cc'), msg.cc);
  $('msg-to-row').hidden = !msg.to.length;
  $('msg-cc-row').hidden = !msg.cc.length;
  $('msg-date').textContent = msg.date ? longFmt.format(new Date(msg.date)) : '';
  $('msg-date-row').hidden = !msg.date;
  $('toggle-star').textContent = msg.flagged ? '★' : '☆';
  $('toggle-star').classList.toggle('on', msg.flagged);

  const atts = $('attachments');
  atts.textContent = '';
  atts.hidden = !msg.attachments.length;
  for (const a of msg.attachments) {
    const save = el('button', { type: 'button', textContent: 'Enregistrer', title: 'Enregistrer sous…' });
    const open = el('button', { type: 'button', textContent: 'Ouvrir' });
    save.onclick = async () => {
      const r = await call('saveAttachment', msg.accountId, msg.folder, msg.uid, a.index);
      if (r.error) toast(r.error, 'error');
      else if (r.path) toast(`Enregistré : ${r.path}`);
    };
    open.onclick = async () => {
      const r = await call('openAttachment', msg.accountId, msg.folder, msg.uid, a.index);
      if (r.error) toast(r.error, 'error');
    };
    atts.append(el('span', { className: 'att', title: a.filename },
      el('span', { textContent: '📎' }), el('span', { className: 'name', textContent: a.filename }),
      el('span', { className: 'size', textContent: size(a.size) }), open, save));
  }
  renderBody();
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Texte brut -> HTML (liens cliquables, citations grisées)
function textToHtml(text) {
  const lines = escapeHtml(text || '').split(/\r?\n/).map((line) => {
    const linked = line.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (u) => `<a href="${u}">${u}</a>`);
    return /^\s*&gt;/.test(line) ? `<span class="quote">${linked}</span>` : linked;
  });
  return `<div class="plain">${lines.join('\n')}</div>`;
}

const REMOTE_RE = /(?:src|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

// Document affiché dans l'iframe bac à sable : sans script, liens ouverts dans
// un nouvel onglet, images distantes bloquées tant qu'on ne les autorise pas.
function buildSrcdoc(msg, allowRemote) {
  const source = msg.html ?? textToHtml(msg.text);
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.querySelectorAll('script, base, meta, iframe, frame, object, embed, form, link:not([rel~="stylesheet"])').forEach((n) => n.remove());
  const hasRemote = REMOTE_RE.test(doc.documentElement.innerHTML);
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `default-src 'none'; img-src data: ${allowRemote ? 'https: http:' : ''}; style-src 'unsafe-inline' ${allowRemote ? 'https:' : ''}; font-src data: ${allowRemote ? 'https:' : ''}; media-src data:`;
  const base = doc.createElement('base');
  base.target = '_blank';
  const style = doc.createElement('style');
  style.textContent = `
    html { background: #fff; color: #1d1e22; }
    body { margin: 16px; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    .plain { white-space: pre-wrap; }
    .quote { color: #6b6e78; }
    blockquote { margin: 0 0 0 4px; padding-left: 10px; border-left: 3px solid #c9cbd3; color: #4b4e57; }
    a { color: #3446d4; }`;
  head.prepend(csp, base, style);
  return { html: '<!doctype html>' + doc.documentElement.outerHTML, hasRemote };
}

function renderBody() {
  const msg = state.message;
  if (!msg) return;
  const { html, hasRemote } = buildSrcdoc(msg, state.allowRemote);
  $('remote-bar').hidden = !hasRemote || state.allowRemote;
  $('msg-body').srcdoc = html;
}

// ---------------------------------------------------------------------------
// Actions sur les messages
// ---------------------------------------------------------------------------
async function setFlags(uids, flags) {
  const { accountId, folder } = state.current;
  for (const uid of uids) markRow(uid, flags);
  if (state.message && uids.includes(state.message.uid) && 'flagged' in flags) state.message.flagged = flags.flagged;
  renderMessages();
  if (state.message) {
    $('toggle-star').textContent = state.message.flagged ? '★' : '☆';
    $('toggle-star').classList.toggle('on', state.message.flagged);
  }
  if ('seen' in flags) bumpUnseen(accountId, folder, flags.seen ? -uids.length : uids.length);
  const res = await call('setFlags', accountId, folder, uids, flags);
  if (res.error) toast(res.error, 'error');
}

// Après une suppression ou un déplacement : sélectionne le message suivant
function removeFromList(uid) {
  const i = state.messages.findIndex((m) => m.uid === uid);
  if (i < 0) return null;
  state.messages.splice(i, 1);
  state.total = Math.max(0, state.total - 1);
  return state.messages[i] || state.messages[i - 1] || null;
}

async function deleteCurrent() {
  const msg = state.message;
  if (!msg) return;
  const next = removeFromList(msg.uid);
  showMessage(null);
  renderMessages();
  if (next) openMessage(next.uid);
  const res = await call('delete', msg.accountId, msg.folder, [msg.uid]);
  if (res.error) {
    toast(res.error, 'error');
    loadMessages();
  } else {
    toast(res.trashed ? 'Message mis à la corbeille.' : 'Message supprimé.');
    loadFolders(msg.accountId);
  }
}

async function moveCurrent(dest) {
  const msg = state.message;
  if (!msg || !dest) return;
  const next = removeFromList(msg.uid);
  showMessage(null);
  renderMessages();
  if (next) openMessage(next.uid);
  const res = await call('move', msg.accountId, msg.folder, [msg.uid], dest);
  if (res.error) {
    toast(res.error, 'error');
    loadMessages();
  } else {
    const f = folderInfo(msg.accountId, dest);
    toast(`Message déplacé vers « ${f ? folderLabel(f) : dest} ».`);
    loadFolders(msg.accountId);
  }
}

function renderMoveTargets() {
  const sel = $('move-to');
  sel.textContent = '';
  sel.append(el('option', { value: '', textContent: 'Déplacer vers…' }));
  const list = state.folders.get(state.current?.accountId)?.list || [];
  for (const f of orderedFolders(list)) {
    if (f.noselect || f.path === state.current?.folder) continue;
    sel.append(el('option', { value: f.path, textContent: `${'  '.repeat(f.depth)}${folderLabel(f)}` }));
  }
}

// ---------------------------------------------------------------------------
// Rédaction
// ---------------------------------------------------------------------------
const compose = { attachments: [], replyTo: null, inReplyTo: null, references: [], dirty: false };

function quoteText(msg) {
  let text = msg.text;
  if (!text && msg.html) text = new DOMParser().parseFromString(msg.html, 'text/html').body?.innerText || '';
  return (text || '').replace(/\s+$/, '').split(/\r?\n/).map((l) => `> ${l}`).join('\n');
}

const withPrefix = (prefix, subject) => (new RegExp(`^\\s*${prefix}\\s*:`, 'i').test(subject || '') ? subject : `${prefix} : ${subject || ''}`.trim());

function signatureFor(accountId) {
  const sig = accountById(accountId)?.signature;
  return sig ? `\n\n-- \n${sig}` : '';
}

function fillFromSelect(accountId) {
  const sel = $('c-from');
  sel.textContent = '';
  for (const a of state.accounts) {
    sel.append(el('option', { value: a.id, textContent: a.name ? `${a.name} <${a.email}>` : a.email, selected: a.id === accountId }));
  }
}

async function openCompose(mode, prefill = {}) {
  if (!state.accounts.length) {
    openAccounts(true);
    return;
  }
  if (!$('compose-panel').hidden && compose.dirty && !confirm('Abandonner le message en cours ?')) return;
  const msg = mode === 'new' ? null : state.message;
  const accountId = msg?.accountId || state.current?.accountId || state.accounts[0].id;
  const me = accountById(accountId)?.email?.toLowerCase();
  Object.assign(compose, { accountId, attachments: [], replyTo: null, inReplyTo: null, references: [], dirty: false });
  fillFromSelect(accountId);
  let to = prefill.to || '';
  let cc = '';
  let subject = '';
  let body = signatureFor(accountId);
  if (msg && (mode === 'reply' || mode === 'replyAll')) {
    const target = msg.replyTo.length ? msg.replyTo : [msg.from];
    to = formatList(target);
    if (mode === 'replyAll') {
      const seen = new Set([me, ...target.map((a) => a.address.toLowerCase())]);
      const rest = [...msg.to, ...msg.cc].filter((a) => {
        const k = a.address.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      cc = formatList(rest);
    }
    subject = withPrefix('Re', msg.subject);
    const when = msg.date ? longFmt.format(new Date(msg.date)) : '';
    body = `\n\n${signatureFor(accountId).trimStart()}\n\nLe ${when}, ${formatAddress(msg.from)} a écrit :\n${quoteText(msg)}\n`.replace(/^\n\n\n+/, '\n\n');
    compose.inReplyTo = msg.messageId || null;
    compose.references = [...msg.references, msg.messageId].filter(Boolean);
    compose.replyTo = { folder: msg.folder, uid: msg.uid };
  } else if (msg && mode === 'forward') {
    subject = withPrefix('Tr', msg.subject);
    const header = [
      '-------- Message transféré --------',
      `Objet : ${msg.subject}`,
      `Date : ${msg.date ? longFmt.format(new Date(msg.date)) : ''}`,
      `De : ${formatAddress(msg.from)}`,
      msg.to.length ? `À : ${formatList(msg.to)}` : '',
      msg.cc.length ? `Cc : ${formatList(msg.cc)}` : '',
    ].filter(Boolean).join('\n');
    let text = msg.text;
    if (!text && msg.html) text = new DOMParser().parseFromString(msg.html, 'text/html').body?.innerText || '';
    body = `\n\n${signatureFor(accountId).trimStart()}\n\n${header}\n\n${text || ''}`;
    if (msg.attachments.length) {
      const res = await call('forwardAttachments', msg.accountId, msg.folder, msg.uid);
      if (Array.isArray(res)) compose.attachments = res;
    }
  }
  $('compose-title').textContent = { new: 'Nouveau message', reply: 'Répondre', replyAll: 'Répondre à tous', forward: 'Transférer' }[mode];
  $('c-to').value = to;
  $('c-cc').value = cc;
  $('c-bcc').value = '';
  $('c-cc-row').hidden = !cc;
  $('c-bcc-row').hidden = true;
  $('c-subject').value = subject;
  $('c-body').value = body;
  $('c-status').textContent = '';
  $('c-status').className = 'status';
  $('c-send').disabled = false;
  renderComposeAttachments();
  $('compose-panel').hidden = false;
  if (!to) $('c-to').focus();
  else {
    $('c-body').focus();
    $('c-body').setSelectionRange(0, 0);
    $('c-body').scrollTop = 0;
  }
}

function renderComposeAttachments() {
  const box = $('c-attachments');
  box.textContent = '';
  for (const a of compose.attachments) {
    const rm = el('button', { type: 'button', textContent: '✕', title: 'Retirer' });
    rm.onclick = () => {
      compose.attachments = compose.attachments.filter((x) => x !== a);
      call('dropUpload', a.token);
      renderComposeAttachments();
    };
    box.append(el('span', { className: 'att', title: a.filename },
      el('span', { textContent: '📎' }), el('span', { className: 'name', textContent: a.filename }),
      el('span', { className: 'size', textContent: size(a.size) }), rm));
  }
}

function closeCompose(force = false) {
  if (!force && compose.dirty && !confirm('Abandonner ce message ?')) return;
  for (const a of compose.attachments) call('dropUpload', a.token);
  compose.attachments = [];
  compose.dirty = false;
  $('compose-panel').hidden = true;
}

async function sendCompose() {
  const status = $('c-status');
  status.className = 'status';
  status.textContent = 'Envoi…';
  $('c-send').disabled = true;
  const accountId = $('c-from').value;
  const res = await call('send', accountId, {
    to: $('c-to').value,
    cc: $('c-cc').value,
    bcc: $('c-bcc').value,
    subject: $('c-subject').value,
    text: $('c-body').value,
    attachments: compose.attachments.map((a) => a.token),
    inReplyTo: compose.inReplyTo,
    references: compose.references,
    replyTo: compose.replyTo,
  });
  $('c-send').disabled = false;
  if (res.error) {
    status.className = 'status error';
    status.textContent = res.error;
    return;
  }
  if (compose.replyTo && state.message?.uid === compose.replyTo.uid) markRow(compose.replyTo.uid, { answered: true });
  compose.attachments = [];
  closeCompose(true);
  renderMessages();
  toast(res.warning || 'Message envoyé.', res.warning ? 'error' : '');
}

// ---------------------------------------------------------------------------
// Comptes
// ---------------------------------------------------------------------------
let editingId = null;
let guessFor = '';

function openAccounts(showForm = false) {
  renderAccountList();
  $('accounts-panel').hidden = false;
  if (showForm || !state.accounts.length) editAccount(null);
  else $('account-form').hidden = true;
}

function renderAccountList() {
  const ul = $('account-list');
  ul.textContent = '';
  for (const a of state.accounts) {
    const edit = el('button', { type: 'button', textContent: 'Modifier' });
    const del = el('button', { type: 'button', className: 'danger', textContent: 'Supprimer' });
    edit.onclick = () => editAccount(a);
    del.onclick = async () => {
      if (!confirm(`Supprimer le compte ${a.email} de Custom Nav ?\n(Les messages restent sur le serveur.)`)) return;
      const res = await call('removeAccount', a.id);
      if (res.error) return toast(res.error, 'error');
      await refreshAccounts();
      renderAccountList();
    };
    ul.append(el('li', {},
      el('span', { className: 'who' }, a.name || a.email, el('small', { textContent: `${a.email} · ${a.imap.host}` })),
      edit, del));
  }
  $('account-list').hidden = !state.accounts.length;
}

const secValue = (s) => (s?.secure ? 'ssl' : 'starttls');

function fillServers(imap, smtp) {
  $('a-imap-host').value = imap?.host || '';
  $('a-imap-port').value = imap?.port || 993;
  $('a-imap-sec').value = secValue(imap || { secure: true });
  $('a-smtp-host').value = smtp?.host || '';
  $('a-smtp-port').value = smtp?.port || 465;
  $('a-smtp-sec').value = secValue(smtp || { secure: true });
}

function editAccount(a) {
  editingId = a?.id || null;
  guessFor = a?.email || '';
  $('account-form-title').textContent = a ? `Modifier ${a.email}` : 'Nouveau compte';
  $('a-name').value = a?.name || '';
  $('a-email').value = a?.email || '';
  $('a-email').readOnly = !!a;
  $('a-password').value = '';
  $('a-password').placeholder = a ? 'inchangé' : '';
  $('a-user').value = a?.user && a.user !== a.email ? a.user : '';
  $('a-signature').value = a?.signature || '';
  $('a-notify').checked = a ? a.notify : true;
  $('a-note').hidden = true;
  $('a-advanced').open = !!a;
  fillServers(a?.imap, a?.smtp);
  $('a-status').textContent = '';
  $('account-form').hidden = false;
  (a ? $('a-password') : $('a-email')).focus();
}

async function guessServers() {
  const email = $('a-email').value.trim();
  if (editingId || !email.includes('@') || email === guessFor) return;
  guessFor = email;
  $('a-status').className = 'status';
  $('a-status').textContent = 'Recherche des réglages du serveur…';
  const g = await call('guess', email);
  if (email !== $('a-email').value.trim()) return;
  $('a-status').textContent = '';
  if (g.error) return;
  fillServers(g.imap, g.smtp);
  $('a-note').textContent = g.note || '';
  $('a-note').className = 'help' + (/OAuth/.test(g.note) ? ' warn' : '');
  $('a-note').hidden = !g.note;
  if (g.source === 'guess') {
    $('a-advanced').open = true;
    $('a-status').textContent = 'Réglages devinés : vérifie les serveurs ci-dessous.';
  }
}

async function saveAccountForm() {
  await guessServers();
  const status = $('a-status');
  status.className = 'status';
  status.textContent = 'Connexion au serveur…';
  $('a-save').disabled = true;
  const res = await call('saveAccount', {
    id: editingId,
    name: $('a-name').value,
    email: $('a-email').value,
    password: $('a-password').value,
    user: $('a-user').value,
    imap: { host: $('a-imap-host').value, port: Number($('a-imap-port').value), secure: $('a-imap-sec').value === 'ssl' },
    smtp: { host: $('a-smtp-host').value, port: Number($('a-smtp-port').value), secure: $('a-smtp-sec').value === 'ssl' },
    signature: $('a-signature').value,
    notify: $('a-notify').checked,
  });
  $('a-save').disabled = false;
  if (res.error) {
    status.className = 'status error';
    status.textContent = res.error;
    $('a-advanced').open = true;
    return;
  }
  status.className = 'status ok';
  status.textContent = 'Compte enregistré.';
  $('account-form').hidden = true;
  const isNew = !editingId;
  await refreshAccounts();
  renderAccountList();
  if (isNew) {
    $('accounts-panel').hidden = true;
    await loadFolders(res.account.id);
    const inbox = state.folders.get(res.account.id)?.list?.find((f) => f.specialUse === '\\Inbox');
    if (inbox) selectFolder(res.account.id, inbox.path);
  } else {
    loadFolders(res.account.id);
  }
}

async function refreshAccounts() {
  const res = await call('accounts');
  if (Array.isArray(res)) state.accounts = res;
  for (const id of [...state.folders.keys()]) if (!accountById(id)) state.folders.delete(id);
  if (state.current && !accountById(state.current.accountId)) {
    state.current = null;
    state.messages = [];
    showMessage(null);
    renderMessages();
    $('list-info').textContent = '';
  }
  updateTitle(state.accounts.reduce((s, a) => s + (a.unseen || 0), 0));
  renderFolders();
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------
$('compose').onclick = () => openCompose('new');
$('reply').onclick = () => openCompose('reply');
$('reply-all').onclick = () => openCompose('replyAll');
$('forward').onclick = () => openCompose('forward');
$('delete').onclick = deleteCurrent;
$('toggle-star').onclick = () => state.message && setFlags([state.message.uid], { flagged: !state.message.flagged });
$('toggle-read').onclick = () => state.message && setFlags([state.message.uid], { seen: false });
$('move-to').onchange = (e) => {
  const dest = e.target.value;
  e.target.value = '';
  moveCurrent(dest);
};
$('show-remote').onclick = () => {
  state.allowRemote = true;
  renderBody();
};
$('more').onclick = () => loadMessages({ append: true });
$('refresh').onclick = async () => {
  call('checkNow');
  await Promise.all(state.accounts.map((a) => loadFolders(a.id)));
  if (state.current) loadMessages({ keepSelection: true });
};
$('manage-accounts').onclick = () => openAccounts(false);
$('accounts-close').onclick = () => { $('accounts-panel').hidden = true; };
$('account-add').onclick = () => editAccount(null);
$('a-cancel').onclick = () => {
  $('account-form').hidden = true;
  if (!state.accounts.length) $('accounts-panel').hidden = true;
};
$('a-email').addEventListener('blur', guessServers);
$('account-form').onsubmit = (e) => {
  e.preventDefault();
  saveAccountForm();
};

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $('search').value.trim();
    loadMessages();
  }, 400);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('search').value) {
    $('search').value = '';
    state.query = '';
    loadMessages();
  }
});

$('c-show-cc').onclick = () => {
  $('c-cc-row').hidden = false;
  $('c-bcc-row').hidden = false;
  $('c-cc').focus();
};
$('c-attach').onclick = async () => {
  const res = await call('pickFiles');
  if (Array.isArray(res) && res.length) {
    compose.attachments.push(...res);
    compose.dirty = true;
    renderComposeAttachments();
  } else if (res.error) toast(res.error, 'error');
};
$('compose-close').onclick = () => closeCompose();
$('compose-form').addEventListener('input', () => { compose.dirty = true; });
$('compose-form').onsubmit = (e) => {
  e.preventDefault();
  sendCompose();
};
$('compose-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    sendCompose();
  }
});
// changement d'expéditeur : remplace la signature de l'ancien compte par celle du nouveau
$('c-from').onchange = () => {
  const oldSig = signatureFor(compose.accountId).trim();
  const newSig = signatureFor($('c-from').value).trim();
  const body = $('c-body').value;
  if (oldSig && body.includes(oldSig)) $('c-body').value = body.replace(oldSig, newSig);
  else if (!oldSig && newSig) $('c-body').value = `\n\n${newSig}${body}`;
  compose.accountId = $('c-from').value;
  compose.dirty = true;
};

// Raccourcis clavier façon Thunderbird (hors champs de saisie)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('compose-panel').hidden) return closeCompose();
    if (!$('accounts-panel').hidden) {
      $('accounts-panel').hidden = true;
      return;
    }
  }
  const t = e.target;
  if (t.closest?.('input, textarea, select, .overlay:not([hidden])') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (!$('compose-panel').hidden || !$('accounts-panel').hidden) return;
  const i = state.messages.findIndex((m) => m.uid === state.selectedUid);
  const key = e.key.toLowerCase();
  if (key === 'arrowdown' || key === 'j') {
    const next = state.messages[i + 1] || (i < 0 ? state.messages[0] : null);
    if (next) openMessage(next.uid);
  } else if (key === 'arrowup' || key === 'k') {
    const prev = state.messages[i - 1];
    if (prev) openMessage(prev.uid);
  } else if (key === 'n') openCompose('new');
  else if (key === 'r' && !e.shiftKey && state.message) openCompose('reply');
  else if ((key === 'a' || (key === 'r' && e.shiftKey)) && state.message) openCompose('replyAll');
  else if ((key === 'f' || key === 'l') && state.message) openCompose('forward');
  else if ((key === 'delete' || key === '#') && state.message) deleteCurrent();
  else if (key === 'u' && state.message) setFlags([state.message.uid], { seen: false });
  else if (key === 's' && state.message) setFlags([state.message.uid], { flagged: !state.message.flagged });
  else if (key === '/') $('search').focus();
  else return;
  e.preventDefault();
});

api.onEvent(async (ev) => {
  if (ev.type === 'unseen') {
    const acc = accountById(ev.accountId);
    if (acc) acc.unseen = ev.unseen;
    const inbox = state.folders.get(ev.accountId)?.list?.find((f) => f.specialUse === '\\Inbox');
    if (inbox && inbox.unseen !== ev.unseen) {
      inbox.unseen = ev.unseen;
      renderFolders();
    }
    updateTitle(ev.total);
  } else if (ev.type === 'new') {
    const inbox = state.folders.get(ev.accountId)?.list?.find((f) => f.specialUse === '\\Inbox');
    if (state.current?.accountId === ev.accountId && state.current.folder === inbox?.path && !state.query) {
      loadMessages({ keepSelection: true });
    }
  } else if (ev.type === 'open') {
    await goTo(ev);
  }
});

// Ouvre un message précis (clic sur une notification)
async function goTo({ accountId, folder, uid }) {
  if (!accountById(accountId)) return;
  if (!state.folders.get(accountId)?.list) await loadFolders(accountId);
  await selectFolder(accountId, folder);
  if (uid) openMessage(uid);
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
(async function start() {
  const init = await call('subscribe');
  if (init.error) {
    $('folders').textContent = '';
    $('folders').append(el('div', { className: 'welcome', textContent: init.error }));
    $('compose').disabled = true;
    $('manage-accounts').disabled = true;
    return;
  }
  state.accounts = init.accounts || [];
  updateTitle(init.total);
  renderFolders();
  if (!state.accounts.length) {
    openAccounts(true);
    return;
  }
  // connexion à tous les comptes en parallèle ; on ouvre la réception du premier
  const loaded = state.accounts.map((a) => loadFolders(a.id));
  if (init.open) {
    await loaded[state.accounts.findIndex((a) => a.id === init.open.accountId)];
    return goTo(init.open);
  }
  const first = state.accounts[0];
  if (await loaded[0]) {
    const inbox = state.folders.get(first.id).list.find((f) => f.specialUse === '\\Inbox');
    if (inbox && !state.current) selectFolder(first.id, inbox.path);
  }
})();
