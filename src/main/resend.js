// « Modifier et renvoyer » une requête réseau depuis les outils de développement.
//
// Chrome DevTools n'a pas cette fonction (Firefox l'a). On l'ajoute avec une
// petite extension DevTools intégrée (src/devtools-ext) qui crée l'onglet
// « Renvoyer » : elle liste les requêtes de l'onglet inspecté
// (chrome.devtools.network), permet de les modifier, puis demande au processus
// principal de les envoyer via explora-devtools://resend/.
//
// Deux façons d'envoyer :
//   - « navigateur » (par défaut, comme Firefox) : le processus principal envoie
//     la requête avec la session de l'onglet. Tous les en-têtes sont modifiables
//     (Cookie, Origin, Referer…), les cookies de la session sont ajoutés si on
//     n'a pas mis d'en-tête Cookie, et il n'y a pas de restriction CORS.
//   - « page » : fetch() exécuté dans la page inspectée. La requête apparaît
//     dans l'onglet Réseau, mais le navigateur applique CORS et ignore les
//     en-têtes interdits aux pages (Cookie, Host, Origin…).
//
// L'extension doit être chargée dans deux sessions :
//   - celle de l'onglet inspecté (persist:main ou fenêtre privée) : c'est elle
//     qui dit à DevTools quelles extensions afficher ;
//   - la session par défaut, où vit la vue des outils de développement (voir
//     TabManager.openDevTools) : sans ça, DevTools refuse la page de
//     l'extension (origine « null »). Cette session ne contient que
//     l'interface et les outils de développement, jamais de site web.
// Le point d'entrée explora-devtools:// n'existe que dans la session par
// défaut, et ne répond qu'à l'extension (voir attachDevTools).
const path = require('path');
const crypto = require('crypto');
const { session, webContents: allWebContents, webFrameMain } = require('electron');

const SCHEME = 'explora-devtools';
const EXT_DIR = path.join(__dirname, '..', 'devtools-ext').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MAX_BODY = 5 * 1024 * 1024; // corps de réponse affiché au plus (texte)
const TIMEOUT = 60 * 1000;

// En-têtes qu'une page ne peut pas fixer elle-même (fetch les ignore)
const FORBIDDEN_FOR_PAGE = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);
const isForbiddenForPage = (name) => FORBIDDEN_FOR_PAGE.has(name) || name.startsWith('proxy-') || name.startsWith('sec-');
// Gérés par la pile réseau elle-même, même en mode navigateur (la requête
// échoue si on les fixe : Origin, Sec-Fetch-*…)
const MANAGED_BY_NETWORK = new Set(['content-length', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'accept-encoding', 'origin']);
const isManagedByNetwork = (name) => MANAGED_BY_NETWORK.has(name) || name.startsWith('sec-fetch-');

const TOKEN = crypto.randomBytes(32).toString('hex');
let extensionOrigin = null;
const sessions = new WeakSet();

// Privilèges du schéma, à ajouter à protocol.registerSchemesAsPrivileged
const schemePrivileges = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

// Sépare les en-têtes à envoyer de ceux qui seront ignorés
function splitHeaders(list, mode) {
  const send = [];
  const ignored = [];
  const invalid = [];
  for (const h of Array.isArray(list) ? list : []) {
    const name = String(h?.name || '').trim();
    const value = String(h?.value ?? '');
    if (!name) continue;
    const lower = name.toLowerCase();
    // pseudo-en-têtes HTTP/2 (:authority, :path…) copiés depuis l'onglet Réseau
    if (lower.startsWith(':')) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n\0]/.test(value)) {
      invalid.push(name);
    } else if (mode === 'page' ? isForbiddenForPage(lower) : isManagedByNetwork(lower)) {
      if (!ignored.some((n) => n.toLowerCase() === lower)) ignored.push(name);
    } else {
      send.push([name, value]);
    }
  }
  return { send, ignored, invalid };
}

const TEXT_TYPE = /^(text\/|application\/(json|[\w.+-]+\+json|javascript|ecmascript|xml|[\w.+-]+\+xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

async function readResponse(res, started) {
  const headers = [...res.headers.entries()].map(([name, value]) => ({ name, value }));
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const isText = !type || TEXT_TYPE.test(type);
  return {
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    redirected: res.redirected,
    headers,
    size: buf.length,
    time: Math.round(performance.now() - started),
    body: isText ? buf.subarray(0, MAX_BODY).toString('utf8') : null,
    truncated: isText && buf.length > MAX_BODY,
  };
}

// Mode « navigateur » : envoyée par le processus principal avec la session de l'onglet
async function sendFromBrowser(wc, req) {
  const { send, ignored, invalid } = splitHeaders(req.headers, 'browser');
  const hasCookie = send.some(([n]) => n.toLowerCase() === 'cookie');
  const init = {
    method: req.method,
    headers: send,
    // un en-tête Cookie saisi remplace les cookies de la session
    credentials: hasCookie ? 'omit' : 'include',
    redirect: req.followRedirects === false ? 'manual' : 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
    bypassCustomProtocolHandlers: true,
  };
  if (req.body != null && req.body !== '' && !['GET', 'HEAD'].includes(req.method)) init.body = req.body;
  const started = performance.now();
  let res;
  try {
    res = await wc.session.fetch(req.url, init);
  } catch (e) {
    if (/ERR_BLOCKED_BY_CLIENT/.test(e?.message)) {
      throw new Error('Requête bloquée par le bloqueur de pubs d’Explora (autorisez le site depuis son bouton, puis réessayez).');
    }
    throw e;
  }
  return { ...(await readResponse(res, started)), ignored, invalid };
}

// Mode « page » : fetch() exécuté dans la page inspectée (cadre principal)
async function sendFromPage(wc, req) {
  const { send, ignored, invalid } = splitHeaders(req.headers, 'page');
  const init = { method: req.method, headers: send, credentials: 'include', redirect: req.followRedirects === false ? 'manual' : 'follow' };
  if (req.body != null && req.body !== '' && !['GET', 'HEAD'].includes(req.method)) init.body = req.body;
  const code = `(async () => {
    const MAX = ${MAX_BODY};
    const t0 = performance.now();
    try {
      const res = await fetch(${JSON.stringify(req.url)}, Object.assign(${JSON.stringify(init)}, { signal: AbortSignal.timeout(${TIMEOUT}) }));
      const buf = new Uint8Array(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      const isText = !type || ${TEXT_TYPE}.test(type);
      return {
        status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected,
        headers: [...res.headers.entries()].map(([name, value]) => ({ name, value })),
        size: buf.length, time: Math.round(performance.now() - t0),
        body: isText ? new TextDecoder().decode(buf.subarray(0, MAX)) : null,
        truncated: isText && buf.length > MAX,
      };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  })()`;
  const out = await wc.executeJavaScript(code, true);
  if (out?.error) {
    throw new Error(`${out.error} (la page a refusé la requête : CORS, CSP ou réseau. Essayez le mode « navigateur ».)`);
  }
  return { ...out, ignored, invalid };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
});

async function loadInto(ses) {
  if (sessions.has(ses)) return true;
  sessions.add(ses);
  try {
    const ext = await ses.extensions.loadExtension(EXT_DIR);
    extensionOrigin = `chrome-extension://${ext.id}`; // même dossier : même id partout
    return true;
  } catch (e) {
    console.error('Onglet « Renvoyer » des outils de développement indisponible :', e);
    return false;
  }
}

// Session des onglets d'une fenêtre (normale ou privée), avant d'ouvrir DevTools
const addSession = (ses) => loadInto(ses);

const isResendExtension = (ext) => !!ext?.path && path.resolve(ext.path) === path.resolve(EXT_DIR);

// Les requêtes vers explora-devtools:// n'ont pas d'en-tête Origin : on
// authentifie l'onglet « Renvoyer » avec un jeton secret, que le processus
// principal dépose lui-même dans la page de l'extension (et uniquement là,
// d'après l'origine réelle du cadre) à chaque ouverture des outils.
function attachDevTools(devtoolsWebContents) {
  devtoolsWebContents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame || !extensionOrigin) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!frame || frame.origin !== extensionOrigin || new URL(frame.url).pathname !== '/panel.html') return;
    frame.executeJavaScript(`window.customNavResendToken = ${JSON.stringify(TOKEN)};`).catch(() => {});
  });
}

// `isTab(webContents)` : ce webContents est-il bien un onglet de navigation ?
async function init({ isTab }) {
  const ses = session.defaultSession;
  if (!(await loadInto(ses))) return;

  ses.protocol.handle(SCHEME, async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.hostname !== 'resend' || request.method !== 'POST') return json({ error: 'Introuvable' }, 404);

    let req;
    try {
      req = JSON.parse(await request.text());
    } catch {
      return json({ error: 'Requête invalide' }, 400);
    }
    // seule l'extension intégrée peut demander un envoi
    if (typeof req?.token !== 'string' || req.token !== TOKEN) {
      return json({ error: 'Rechargez les outils de développement (F12 deux fois) puis réessayez.' }, 403);
    }
    const wc = allWebContents.fromId(Number(req.tabId));
    if (!wc || wc.isDestroyed() || !isTab(wc)) return json({ error: "L'onglet inspecté n'existe plus." }, 404);

    req.method = String(req.method || 'GET').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(req.method)) return json({ error: 'Méthode HTTP invalide.' }, 400);
    let target;
    try {
      target = new URL(String(req.url || '').trim());
    } catch {
      return json({ error: 'URL invalide.' }, 400);
    }
    if (!['http:', 'https:'].includes(target.protocol)) return json({ error: 'Seules les URL http(s) peuvent être renvoyées.' }, 400);
    req.url = target.href;
    if (req.body != null) req.body = String(req.body);

    try {
      return json(req.mode === 'page' ? await sendFromPage(wc, req) : await sendFromBrowser(wc, req));
    } catch (e) {
      const msg = e?.name === 'TimeoutError' ? 'Pas de réponse après 60 s.' : (e?.message || String(e));
      return json({ error: msg });
    }
  });
}

module.exports = { init, addSession, attachDevTools, isResendExtension, schemePrivileges, splitHeaders };
