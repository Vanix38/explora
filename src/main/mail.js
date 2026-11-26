// Client mail intégré (page interne <scheme>://mail/), façon Thunderbird.
//   - plusieurs comptes IMAP/SMTP, mots de passe chiffrés avec safeStorage
//     (DPAPI de Windows) dans <userData>/mail-accounts.json ;
//   - dossiers, liste des messages, lecture, recherche côté serveur ;
//   - rédaction, réponse, transfert, pièces jointes ;
//   - vérification des nouveaux messages (IDLE + toutes les 2 min) et
//     notifications Windows.
// La page n'a jamais accès aux mots de passe ni aux chemins de fichiers :
// elle ne manipule que des identifiants (compte, dossier, uid, jeton).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, ipcMain, safeStorage, dialog, Notification, shell, BrowserWindow } = require('electron');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const addressparser = require('nodemailer/lib/addressparser');
const { simpleParser } = require('mailparser');
const internal = require('./internal');
const providers = require('./mail-providers');

const PAGE = `${internal.SCHEME}://mail/`;
const PAGE_SIZE = 50;
const POLL_MS = 2 * 60 * 1000;
const CONNECT_TIMEOUT = 20000;

let opts = { openPage: () => {} };

// ---------------------------------------------------------------------------
// Comptes
// ---------------------------------------------------------------------------
const file = () => path.join(app.getPath('userData'), 'mail-accounts.json');
let accounts = []; // { id, name, email, user, imap, smtp, secret, savesSent, notify }

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
  } catch {
    accounts = [];
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(file(), JSON.stringify({ accounts }, null, 2));
  } catch (e) {
    console.error('Courrier : impossible d’enregistrer les comptes :', e.message);
  }
}

const findAccount = (id) => {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new UserError('Compte introuvable.');
  return acc;
};

// Ce que la page a le droit de voir d'un compte (jamais le mot de passe)
const publicAccount = (a) => ({
  id: a.id,
  name: a.name,
  email: a.email,
  user: a.user,
  imap: a.imap,
  smtp: a.smtp,
  notify: a.notify !== false,
  signature: a.signature || '',
  unseen: unseen.get(a.id) || 0,
});

async function encrypt(password) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new UserError("Le chiffrement du système n'est pas disponible : impossible d'enregistrer le mot de passe en sécurité.");
  }
  return (await safeStorage.encryptStringAsync(password)).toString('base64');
}

async function passwordOf(acc) {
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(acc.secret, 'base64'));
  if (shouldReEncrypt) {
    acc.secret = await encrypt(result);
    saveAccounts();
  }
  return result;
}

class UserError extends Error {}

// Message d'erreur lisible pour la page
function friendly(err) {
  if (err instanceof UserError) return err.message;
  const code = err?.code || '';
  if (err?.authenticationFailed || code === 'EAUTH' || /auth/i.test(err?.serverResponseCode || '')) {
    return 'Identifiant ou mot de passe refusé par le serveur. ' +
      "Pour Gmail, Yahoo ou iCloud, il faut un « mot de passe d'application ».";
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Serveur introuvable (${err.hostname || err.host || ''}). Vérifie l'adresse du serveur et la connexion internet.`;
  if (code === 'ECONNREFUSED') return 'Le serveur refuse la connexion : vérifie le port et le chiffrement (SSL/STARTTLS).';
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT' || code === 'CONNECT_TIMEOUT' || code === 'NoConnection') {
    return 'Le serveur ne répond pas (délai dépassé). Vérifie la connexion internet.';
  }
  if (code === 'ESOCKET' && /certificate|self.signed/i.test(err.message)) return `Certificat du serveur refusé : ${err.message}`;
  return err?.responseText || err?.response || err?.message || String(err);
}

function cleanServer(s, fallbackPort) {
  const host = String(s?.host || '').trim();
  const port = Number(s?.port) || fallbackPort;
  if (!host || /\s/.test(host)) throw new UserError('Adresse de serveur invalide.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('Port invalide.');
  return { host, port, secure: s.secure === undefined ? port === 993 || port === 465 : !!s.secure };
}

// Serveur local (ex. Proton Mail Bridge) : la connexion ne quitte pas
// l'ordinateur, STARTTLS n'y est donc pas exigé
const isLocalHost = (host) => /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host);

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

// ---------------------------------------------------------------------------
// Connexions IMAP (une par compte, ouverte à la demande, rouverte si coupée)
// ---------------------------------------------------------------------------
const clients = new Map(); // accountId -> { client, ready: Promise<ImapFlow> }

function imapOptions(acc, password) {
  return {
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure,
    auth: { user: acc.user || acc.email, pass: password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: CONNECT_TIMEOUT,
    clientInfo: { name: 'Custom Nav' },
  };
}

function getClient(acc) {
  const entry = clients.get(acc.id);
  if (entry && (!entry.settled || entry.client?.usable)) return entry.ready;
  const e = { client: null, settled: false };
  e.ready = (async () => {
    const client = new ImapFlow(imapOptions(acc, await passwordOf(acc)));
    e.client = client;
    client.on('error', (err) => console.warn(`Courrier (${acc.email}) :`, err.message));
    client.on('close', () => {
      if (clients.get(acc.id) === e) clients.delete(acc.id);
    });
    // nouveau message pendant que la boîte de réception est ouverte (IDLE)
    client.on('exists', (info) => {
      if (info.path === 'INBOX' && info.count > info.prevCount) scheduleCheck(acc.id, 1500);
    });
    await client.connect();
    return client;
  })().then(
    (client) => {
      e.settled = true;
      return client;
    },
    (err) => {
      e.settled = true;
      if (clients.get(acc.id) === e) clients.delete(acc.id);
      throw err;
    },
  );
  clients.set(acc.id, e);
  return e.ready;
}

function closeClient(id) {
  const e = clients.get(id);
  clients.delete(id);
  if (e?.client) e.client.logout().catch(() => e.client.close());
}

const isConnectionError = (err) =>
  !err?.authenticationFailed && !(err instanceof UserError) &&
  (err?.code === 'NoConnection' || err?.code === 'EPIPE' || err?.code === 'ECONNRESET' || /connection|socket|closed/i.test(err?.message || ''));

// Exécute fn(client) ; en cas de connexion coupée, se reconnecte et réessaie une fois
async function withClient(acc, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(await getClient(acc));
    } catch (err) {
      if (attempt === 0 && isConnectionError(err)) {
        closeClient(acc.id);
        continue;
      }
      throw err;
    }
  }
}

// Exécute fn(client, mailbox) avec le dossier `folder` sélectionné
function withMailbox(acc, folder, fn) {
  return withClient(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      return await fn(client, client.mailbox);
    } finally {
      lock.release();
    }
  });
}

// ---------------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------------
const folderCache = new Map(); // accountId -> liste des dossiers (pour trouver Corbeille, Envoyés…)

async function listFolders(acc) {
  const list = await withClient(acc, (c) => c.list({ statusQuery: { unseen: true, messages: true } }));
  const folders = list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    parent: f.parentPath || '',
    specialUse: f.specialUse || (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : ''),
    noselect: f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent') || false,
    unseen: f.status?.unseen || 0,
    total: f.status?.messages || 0,
  }));
  folderCache.set(acc.id, folders);
  const inbox = folders.find((f) => f.specialUse === '\\Inbox');
  if (inbox) setUnseen(acc.id, inbox.unseen);
  return folders;
}

async function specialFolder(acc, use) {
  const find = () => (folderCache.get(acc.id) || []).find((f) => f.specialUse === use)?.path;
  if (!find()) await listFolders(acc);
  return find() || null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function hasAttachments(node) {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachments);
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  return node.disposition === 'attachment' || (!!filename && !/^text\//i.test(node.type || '') && node.disposition !== 'inline');
}

const addr = (a) => ({ name: a?.name || '', address: a?.address || '' });

function summary(msg) {
  const env = msg.envelope || {};
  return {
    uid: msg.uid,
    seq: msg.seq,
    subject: env.subject || '',
    from: addr(env.from?.[0]),
    to: (env.to || []).map(addr),
    date: (env.date || msg.internalDate || new Date(0)).getTime?.() || Date.parse(env.date) || 0,
    seen: msg.flags?.has('\\Seen') || false,
    flagged: msg.flags?.has('\\Flagged') || false,
    answered: msg.flags?.has('\\Answered') || false,
    attachments: hasAttachments(msg.bodyStructure),
    size: msg.size || 0,
  };
}

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true };

// Une page de messages, du plus récent au plus ancien.
// Sans recherche : `cursor` = numéro de séquence à partir duquel continuer.
// Avec recherche : `cursor` = uid le plus ancien déjà affiché.
async function listMessages(acc, folder, { query = '', cursor = null } = {}) {
  return withMailbox(acc, folder, async (c, box) => {
    const q = String(query || '').trim();
    if (q) {
      const found = (await c.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: true })) || [];
      const uids = found.sort((a, b) => b - a).filter((u) => !cursor || u < cursor);
      const pageUids = uids.slice(0, PAGE_SIZE);
      const msgs = pageUids.length ? await c.fetchAll(pageUids.join(','), SUMMARY_QUERY, { uid: true }) : [];
      const list = msgs.map(summary).sort((a, b) => b.uid - a.uid);
      return { messages: list, cursor: uids.length > PAGE_SIZE ? pageUids[pageUids.length - 1] : null, total: found.length };
    }
    const exists = box.exists || 0;
    const end = cursor ? Math.min(cursor - 1, exists) : exists;
    if (end < 1) return { messages: [], cursor: null, total: exists };
    const start = Math.max(1, end - PAGE_SIZE + 1);
    const msgs = await c.fetchAll(`${start}:${end}`, SUMMARY_QUERY);
    const list = msgs.map(summary).sort((a, b) => b.seq - a.seq);
    return { messages: list, cursor: start > 1 ? start : null, total: exists };
  });
}

// Messages ouverts récemment : leurs pièces jointes (pour Enregistrer / Transférer)
const openedCache = new Map(); // `${acc}|${folder}|${uid}` -> { attachments, raw }
const OPENED_MAX = 8;

const flatAddresses = (field) => {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((f) => f.value || []).map(addr).filter((a) => a.address || a.name);
};

async function getMessage(acc, folder, uid) {
  const msg = await withMailbox(acc, folder, async (c) => {
    const m = await c.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
    if (!m) throw new UserError("Ce message n'existe plus (déplacé ou supprimé).");
    if (!m.flags?.has('\\Seen')) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return m;
  });
  const parsed = await simpleParser(msg.source);
  // les images intégrées (cid:) sont déjà remplacées dans le HTML par des data: URL
  const attachments = parsed.attachments.filter((a) => !(a.related && a.contentId && a.contentDisposition !== 'attachment'));
  const key = `${acc.id}|${folder}|${uid}`;
  openedCache.delete(key);
  openedCache.set(key, { attachments });
  while (openedCache.size > OPENED_MAX) openedCache.delete(openedCache.keys().next().value);
  const refs = parsed.references ? [].concat(parsed.references) : [];
  return {
    uid,
    folder,
    subject: parsed.subject || '',
    from: flatAddresses(parsed.from)[0] || { name: '', address: '' },
    to: flatAddresses(parsed.to),
    cc: flatAddresses(parsed.cc),
    replyTo: flatAddresses(parsed.replyTo),
    date: parsed.date ? parsed.date.getTime() : 0,
    messageId: parsed.messageId || '',
    references: refs,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    text: parsed.text || '',
    flagged: msg.flags?.has('\\Flagged') || false,
    attachments: attachments.map((a, index) => ({
      index,
      filename: a.filename || `piece-jointe-${index + 1}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || a.content?.length || 0,
    })),
  };
}

function cachedAttachment(accountId, folder, uid, index) {
  const att = openedCache.get(`${accountId}|${folder}|${uid}`)?.attachments?.[index];
  if (!att) throw new UserError('Pièce jointe indisponible : rouvre le message.');
  return att;
}

const uidRange = (uids) => {
  const list = [].concat(uids).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new UserError('Aucun message sélectionné.');
  return list.join(',');
};

async function setFlags(acc, folder, uids, { seen, flagged }) {
  const range = uidRange(uids);
  await withMailbox(acc, folder, async (c) => {
    if (seen === true) await c.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    if (seen === false) await c.messageFlagsRemove(range, ['\\Seen'], { uid: true });
    if (flagged === true) await c.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
    if (flagged === false) await c.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
  });
  if (seen !== undefined) scheduleCheck(acc.id, 500);
  return {};
}

async function moveMessages(acc, folder, uids, dest) {
  const range = uidRange(uids);
  if (dest === folder) return {};
  await withMailbox(acc, folder, (c) => c.messageMove(range, dest, { uid: true }));
  return {};
}

// Supprimer = mettre à la corbeille (ou supprimer définitivement depuis la corbeille)
async function deleteMessages(acc, folder, uids) {
  const range = uidRange(uids);
  const trash = await specialFolder(acc, '\\Trash');
  await withMailbox(acc, folder, async (c) => {
    if (trash && trash !== folder) await c.messageMove(range, trash, { uid: true });
    else await c.messageDelete(range, { uid: true });
  });
  scheduleCheck(acc.id, 500);
  return { trashed: !!trash && trash !== folder };
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------
// Fichiers choisis par l'utilisateur pour être joints : la page ne connaît
// que des jetons, jamais les chemins.
const uploads = new Map(); // token -> { filename, path } | { filename, content, contentType }

function addUpload(item) {
  const token = crypto.randomUUID();
  uploads.set(token, item);
  return token;
}

async function pickFiles(sender) {
  const win = BrowserWindow.fromWebContents(sender) || BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win, { title: 'Joindre des fichiers', properties: ['openFile', 'multiSelections'] });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    return { token: addUpload({ filename: path.basename(p), path: p }), filename: path.basename(p), size };
  });
}

// Pièces jointes d'un message à transférer
function forwardAttachments(accountId, folder, uid) {
  const cached = openedCache.get(`${accountId}|${folder}|${uid}`);
  if (!cached) return [];
  return cached.attachments.map((a, i) => {
    const filename = a.filename || `piece-jointe-${i + 1}`;
    return {
      token: addUpload({ filename, content: a.content, contentType: a.contentType }),
      filename,
      size: a.size || a.content?.length || 0,
    };
  });
}

function parseRecipients(value) {
  const list = addressparser(String(value || ''), { flatten: true })
    .filter((a) => a.address)
    .map((a) => ({ name: a.name || '', address: a.address.trim() }));
  for (const a of list) if (!isEmail(a.address)) throw new UserError(`Adresse invalide : ${a.address}`);
  return list;
}

function smtpTransport(acc, password) {
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: acc.smtp.port,
    secure: acc.smtp.secure,
    requireTLS: !acc.smtp.secure && !isLocalHost(acc.smtp.host),
    auth: { user: acc.user || acc.email, pass: password },
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: CONNECT_TIMEOUT,
  });
}

async function send(acc, draft) {
  const to = parseRecipients(draft.to);
  const cc = parseRecipients(draft.cc);
  const bcc = parseRecipients(draft.bcc);
  if (!to.length && !cc.length && !bcc.length) throw new UserError('Ajoute au moins un destinataire.');
  const attachments = (draft.attachments || []).map((t) => {
    const a = uploads.get(t);
    if (!a) throw new UserError('Une pièce jointe est introuvable : retire-la et ajoute-la de nouveau.');
    return a;
  });
  const mail = {
    from: { name: acc.name || '', address: acc.email },
    to,
    cc,
    bcc,
    subject: String(draft.subject || ''),
    text: String(draft.text || ''),
    attachments,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references?.length ? draft.references : undefined,
    headers: { 'X-Mailer': 'Custom Nav' },
  };
  const transport = smtpTransport(acc, await passwordOf(acc));
  try {
    await transport.sendMail(mail);
  } finally {
    transport.close();
  }
  for (const t of draft.attachments || []) uploads.delete(t);

  // copie dans « Envoyés » (Gmail et Outlook le font eux-mêmes) et marque l'original « répondu »
  const followUps = [];
  if (!acc.savesSent) {
    followUps.push((async () => {
      const sent = await specialFolder(acc, '\\Sent');
      if (!sent) return;
      const raw = await new MailComposer({ ...mail, bcc: undefined }).compile().build();
      await withClient(acc, (c) => c.append(sent, raw, ['\\Seen']));
    })());
  }
  if (draft.replyTo?.folder && draft.replyTo?.uid) {
    followUps.push(withMailbox(acc, draft.replyTo.folder, (c) => c.messageFlagsAdd(String(draft.replyTo.uid), ['\\Answered'], { uid: true })));
  }
  const results = await Promise.allSettled(followUps);
  const failed = results.find((r) => r.status === 'rejected');
  return failed ? { warning: `Message envoyé, mais la copie dans « Envoyés » a échoué : ${friendly(failed.reason)}` } : {};
}

// ---------------------------------------------------------------------------
// Pièces jointes reçues
// ---------------------------------------------------------------------------
// Types que l'on peut ouvrir directement sans risque (pas d'exécutables ni de scripts)
const SAFE_OPEN = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.csv',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.mp3', '.mp4', '.wav', '.zip']);

const safeName = (name) => String(name || 'piece-jointe').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'piece-jointe';

async function saveAttachment(sender, acc, folder, uid, index) {
  const att = cachedAttachment(acc.id, folder, uid, index);
  const win = BrowserWindow.fromWebContents(sender) || BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: 'Enregistrer la pièce jointe',
    defaultPath: path.join(app.getPath('downloads'), safeName(att.filename)),
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fs.promises.writeFile(res.filePath, att.content);
  return { path: res.filePath };
}

async function openAttachment(acc, folder, uid, index) {
  const att = cachedAttachment(acc.id, folder, uid, index);
  const name = safeName(att.filename);
  if (!SAFE_OPEN.has(path.extname(name).toLowerCase())) {
    throw new UserError("Par sécurité, ce type de fichier ne s'ouvre pas directement : enregistre-le d'abord.");
  }
  const dir = path.join(os.tmpdir(), 'custom-nav-mail', crypto.randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await fs.promises.writeFile(target, att.content);
  const err = await shell.openPath(target);
  if (err) throw new UserError(`Impossible d'ouvrir le fichier : ${err}`);
  return {};
}

// ---------------------------------------------------------------------------
// Nouveaux messages : non-lus et notifications
// ---------------------------------------------------------------------------
const unseen = new Map(); // accountId -> non-lus de la boîte de réception
const uidNext = new Map(); // accountId -> prochain uid attendu dans INBOX
const checkTimers = new Map();
let pollTimer = null;
let pendingOpen = null; // message à afficher quand la page s'ouvre (clic sur une notification)

function setUnseen(id, n) {
  if (unseen.get(id) === n) return;
  unseen.set(id, n);
  emit({ type: 'unseen', accountId: id, unseen: n, total: totalUnseen() });
}

const totalUnseen = () => accounts.reduce((s, a) => s + (unseen.get(a.id) || 0), 0);

function scheduleCheck(id, delay) {
  clearTimeout(checkTimers.get(id));
  checkTimers.set(id, setTimeout(() => {
    checkTimers.delete(id);
    const acc = accounts.find((a) => a.id === id);
    if (acc) checkAccount(acc).catch((e) => console.warn(`Courrier (${acc.email}) :`, e.message));
  }, delay));
}

async function checkAccount(acc) {
  const st = await withClient(acc, (c) => c.status('INBOX', { unseen: true, uidNext: true }));
  if (!st) return;
  const prev = uidNext.get(acc.id);
  uidNext.set(acc.id, st.uidNext);
  setUnseen(acc.id, st.unseen || 0);
  if (!prev || st.uidNext <= prev) return;
  const fresh = await withMailbox(acc, 'INBOX', (c) => c.fetchAll(`${prev}:*`, { uid: true, flags: true, envelope: true }, { uid: true }));
  const news = fresh.filter((m) => m.uid >= prev && !m.flags?.has('\\Seen')).map(summary);
  if (!news.length) return;
  emit({ type: 'new', accountId: acc.id, folder: 'INBOX', count: news.length });
  if (acc.notify !== false) notify(acc, news);
}

function notify(acc, news) {
  if (!Notification.isSupported()) return;
  const shown = news.slice(-3);
  const make = (title, body, uid) => {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => openMessage(acc.id, 'INBOX', uid));
    n.show();
  };
  if (news.length > 3) {
    make(`${news.length} nouveaux messages`, `${acc.email}`, null);
    return;
  }
  for (const m of shown) make(m.from.name || m.from.address || acc.email, m.subject || '(sans objet)', m.uid);
}

function openMessage(accountId, folder, uid) {
  pendingOpen = { accountId, folder, uid };
  opts.openPage();
  emit({ type: 'open', ...pendingOpen });
}

function pollAll() {
  for (const acc of accounts) scheduleCheck(acc.id, Math.random() * 3000);
}

// ---------------------------------------------------------------------------
// Pages abonnées aux événements
// ---------------------------------------------------------------------------
const subscribers = new Set();

function emit(event) {
  for (const wc of subscribers) {
    if (wc.isDestroyed()) subscribers.delete(wc);
    else wc.send('internal:mail', event);
  }
  opts.onUnseenChange?.(totalUnseen());
}

// ---------------------------------------------------------------------------
// Ajout / modification des comptes (avec test de connexion)
// ---------------------------------------------------------------------------
async function testAccount(acc, password) {
  const client = new ImapFlow(imapOptions(acc, password));
  client.on('error', () => {});
  await client.connect();
  await client.logout().catch(() => client.close());
  const transport = smtpTransport(acc, password);
  try {
    await transport.verify();
  } catch (err) {
    err.message = `Envoi (SMTP) : ${friendly(err)}`;
    throw new UserError(err.message);
  } finally {
    transport.close();
  }
}

async function saveAccount(data) {
  const email = String(data.email || '').trim();
  if (!isEmail(email)) throw new UserError('Adresse mail invalide.');
  const existing = data.id ? findAccount(data.id) : null;
  const password = String(data.password || '');
  if (!existing && !password) throw new UserError('Mot de passe manquant.');
  const provider = providers.findProvider(email);
  const acc = {
    id: existing?.id || crypto.randomUUID(),
    name: String(data.name || '').trim().slice(0, 100),
    email,
    user: String(data.user || '').trim() || email,
    imap: cleanServer(data.imap, 993),
    smtp: cleanServer(data.smtp, 465),
    savesSent: provider?.savesSent || false,
    notify: data.notify !== false,
    signature: String(data.signature || '').slice(0, 2000),
    secret: existing?.secret,
  };
  const serversChanged = !existing || password ||
    JSON.stringify([existing.imap, existing.smtp, existing.user]) !== JSON.stringify([acc.imap, acc.smtp, acc.user]);
  if (serversChanged) {
    if (password) acc.secret = await encrypt(password); // refusé tout de suite si le chiffrement est indisponible
    await testAccount(acc, password || (await passwordOf(existing)));
  }
  if (existing) {
    Object.assign(existing, acc);
    if (serversChanged) closeClient(acc.id);
  } else {
    accounts.push(acc);
  }
  saveAccounts();
  scheduleCheck(acc.id, 500);
  return { account: publicAccount(acc) };
}

function removeAccount(id) {
  findAccount(id);
  accounts = accounts.filter((a) => a.id !== id);
  closeClient(id);
  unseen.delete(id);
  uidNext.delete(id);
  folderCache.delete(id);
  saveAccounts();
  emit({ type: 'unseen', accountId: id, unseen: 0, total: totalUnseen() });
  return {};
}

// ---------------------------------------------------------------------------
// IPC depuis la page interne
// ---------------------------------------------------------------------------
const ACTIONS = {
  subscribe: (sender) => {
    subscribers.add(sender);
    const open = pendingOpen;
    pendingOpen = null;
    return { accounts: accounts.map(publicAccount), open, total: totalUnseen() };
  },
  accounts: () => accounts.map(publicAccount),
  guess: async (_s, email) => {
    const g = await providers.guess(email);
    return g ? { name: g.name, imap: g.imap, smtp: g.smtp, note: g.note || '', source: g.source } : { error: 'Adresse mail invalide.' };
  },
  saveAccount: (_s, data) => saveAccount(data || {}),
  removeAccount: (_s, id) => removeAccount(id),
  folders: (_s, id) => listFolders(findAccount(id)),
  messages: (_s, id, folder, o) => listMessages(findAccount(id), String(folder), o || {}),
  message: (_s, id, folder, uid) => getMessage(findAccount(id), String(folder), Number(uid)),
  setFlags: (_s, id, folder, uids, flags) => setFlags(findAccount(id), String(folder), uids, flags || {}),
  move: (_s, id, folder, uids, dest) => moveMessages(findAccount(id), String(folder), uids, String(dest)),
  delete: (_s, id, folder, uids) => deleteMessages(findAccount(id), String(folder), uids),
  pickFiles: (sender) => pickFiles(sender),
  forwardAttachments: (_s, id, folder, uid) => forwardAttachments(id, String(folder), Number(uid)),
  dropUpload: (_s, token) => {
    uploads.delete(token);
    return {};
  },
  send: (_s, id, draft) => send(findAccount(id), draft || {}),
  saveAttachment: (sender, id, folder, uid, index) => saveAttachment(sender, findAccount(id), String(folder), Number(uid), Number(index)),
  openAttachment: (_s, id, folder, uid, index) => openAttachment(findAccount(id), String(folder), Number(uid), Number(index)),
  checkNow: () => {
    pollAll();
    return {};
  },
};

function isMailSender(event) {
  if (!internal.isInternalSender(event)) return false;
  try {
    return new URL(event.senderFrame.url).hostname === 'mail';
  } catch {
    return false;
  }
}

function init(options = {}) {
  opts = { ...opts, ...options };
  loadAccounts();
  ipcMain.handle('mail', async (event, action, ...args) => {
    if (!isMailSender(event)) throw new Error('Accès refusé');
    // pas de courrier dans les fenêtres privées (session non persistante)
    if (!event.sender.session.isPersistent()) return { error: "Le courrier n'est pas disponible en navigation privée." };
    const fn = ACTIONS[action];
    if (!fn) throw new Error(`Action inconnue : ${action}`);
    try {
      return await fn(event.sender, ...args);
    } catch (err) {
      return { error: friendly(err) };
    }
  });
  // premier relevé peu après le démarrage, puis régulièrement
  setTimeout(pollAll, 8000);
  pollTimer = setInterval(pollAll, POLL_MS);
}

function shutdown() {
  clearInterval(pollTimer);
  for (const id of [...clients.keys()]) closeClient(id);
}

module.exports = { init, shutdown, PAGE, openMessage, totalUnseen };
