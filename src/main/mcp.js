// Serveur MCP (Model Context Protocol) : permet à une IA comme Claude (Claude
// Code, Claude Desktop…) de piloter Explora — lister / ouvrir / fermer des
// onglets, naviguer, lire une page, chercher avec les moteurs configurés,
// cliquer, écrire, faire une capture.
//
// Sécurité :
//   - désactivé par défaut, activable dans les réglages ;
//   - écoute uniquement sur 127.0.0.1, protégé par un jeton (en-tête
//     Authorization: Bearer …) et par une vérification de l'en-tête Host
//     (contre le « DNS rebinding » depuis une page web) ;
//   - n'a accès qu'à la fenêtre normale : jamais aux fenêtres privées.
const http = require('http');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const settings = require('./settings');

const DEFAULT_PORT = 47823;
const MAX_TEXT = 100000;

let server = null; // serveur HTTP
let api = null; // fourni par main.js
let lastError = null;

// --- réglages : { enabled, port, token } ---
function getSettings() {
  const s = settings.get('mcp', {});
  let token = typeof s.token === 'string' && s.token.length >= 32 ? s.token : null;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    settings.set('mcp', { ...s, token });
  }
  const port = Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535 ? s.port : DEFAULT_PORT;
  return { enabled: s.enabled === true, port, token };
}

function saveSettings(patch) {
  settings.set('mcp', { ...getSettings(), ...patch });
}

// --- utilitaires sur les onglets ---
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

function tabOrFail(tabId) {
  const ctx = api.getCtx();
  const tab = tabId === undefined ? ctx.tabs.active() : ctx.tabs.tabs.get(tabId);
  if (!tab) throw new Error(tabId === undefined ? 'Aucun onglet actif.' : `Onglet ${tabId} introuvable (voir list_tabs).`);
  return { ctx, tab };
}

const tabInfo = (ctx, t) => ({ id: t.id, title: t.title, url: t.url, active: t.id === ctx.tabs.activeId, loading: t.loading });

// Attend la fin du chargement (au plus `timeout` ms)
function waitForLoad(wc, timeout = 15000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) {
      // laisse le temps à une navigation qui vient d'être demandée de démarrer
      setTimeout(() => (wc.isLoading() ? waitForLoad(wc, timeout).then(resolve) : resolve()), 300);
      return;
    }
    const timer = setTimeout(done, timeout);
    function done() {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    }
    wc.once('did-stop-loading', done);
  });
}

// Lecture du texte de la page (et des liens), exécutée dans la page
const READ_PAGE = (maxChars, withLinks) => `(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const links = ${withLinks} ? [...document.querySelectorAll('a[href]')]
    .map((a) => ({ text: (a.innerText || a.title || '').trim().slice(0, 120), href: a.href }))
    .filter((l) => /^https?:/.test(l.href)).slice(0, 200) : undefined;
  return { title: document.title, url: location.href, text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars}, links };
})()`;

function buildServer() {
  const mcp = new McpServer({ name: 'explora', version: '1.0.0' });
  const tabIdArg = z.number().int().optional().describe("Identifiant de l'onglet (list_tabs). Par défaut : l'onglet actif.");

  mcp.registerTool('list_tabs', {
    title: 'Lister les onglets',
    description: 'Liste les onglets de la fenêtre normale de Explora (id, titre, URL, onglet actif). Les fenêtres privées ne sont pas accessibles.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const ctx = api.getCtx();
    return text(ctx.tabs.order.map((id) => tabInfo(ctx, ctx.tabs.tabs.get(id))));
  });

  mcp.registerTool('list_engines', {
    title: 'Lister les moteurs et IA',
    description: 'Liste les moteurs de recherche et IA configurés dans Explora (utilisables avec search).',
    annotations: { readOnlyHint: true },
  }, async () => text(api.listEngines()));

  mcp.registerTool('open_tab', {
    title: 'Ouvrir un onglet',
    description: "Ouvre un nouvel onglet sur une URL, ou sur la page d'accueil si aucune URL n'est donnée. Attend la fin du chargement.",
    inputSchema: {
      url: z.string().optional().describe('Adresse (https://…, ou un domaine comme github.com). Un texte qui n\'est pas une adresse est recherché avec le moteur actif.'),
      background: z.boolean().optional().describe("true : ne pas afficher l'onglet (par défaut il devient l'onglet actif)."),
    },
  }, async ({ url, background }) => {
    const ctx = api.getCtx();
    const id = ctx.tabs.create(url ? api.resolveInput(url) : undefined, { activate: !background });
    const tab = ctx.tabs.tabs.get(id);
    await waitForLoad(tab.view.webContents);
    return text(tabInfo(ctx, tab));
  });

  mcp.registerTool('navigate', {
    title: 'Naviguer',
    description: "Ouvre une adresse (ou lance une recherche avec le moteur actif si ce n'est pas une adresse) dans un onglet existant, puis attend la fin du chargement. Accepte aussi « back », « forward » et « reload ».",
    inputSchema: { tab_id: tabIdArg, url: z.string().describe('Adresse, texte à rechercher, ou back / forward / reload.') },
  }, async ({ tab_id: tabId, url }) => {
    const { ctx, tab } = tabOrFail(tabId);
    const wc = tab.view.webContents;
    const h = wc.navigationHistory;
    if (url === 'back') { if (h.canGoBack()) h.goBack(); }
    else if (url === 'forward') { if (h.canGoForward()) h.goForward(); }
    else if (url === 'reload') wc.reload();
    else ctx.tabs.navigate(api.resolveInput(url), tab);
    await waitForLoad(wc);
    return text(tabInfo(ctx, tab));
  });

  mcp.registerTool('search', {
    title: 'Rechercher',
    description: "Pose une question ou lance une recherche avec un moteur ou une IA configuré (voir list_engines ; par défaut le moteur actif), dans un nouvel onglet. Utilise ensuite read_page pour lire les résultats.",
    inputSchema: {
      query: z.string().min(1).describe('Texte à rechercher ou question à poser.'),
      engine: z.string().optional().describe('Identifiant du moteur (list_engines), par ex. google, duckduckgo, claude, perplexity.'),
    },
  }, async ({ query, engine }) => {
    const ctx = api.getCtx();
    const target = api.searchTarget(query, engine);
    if (target.error) return fail(target.error);
    const id = ctx.tabs.create(target);
    const tab = ctx.tabs.tabs.get(id);
    await waitForLoad(tab.view.webContents);
    return text(tabInfo(ctx, tab));
  });

  mcp.registerTool('read_page', {
    title: 'Lire une page',
    description: "Renvoie le titre, l'URL et le texte visible d'un onglet (et, en option, la liste de ses liens).",
    inputSchema: {
      tab_id: tabIdArg,
      max_chars: z.number().int().min(100).max(MAX_TEXT).optional().describe('Longueur maximale du texte (20 000 par défaut).'),
      include_links: z.boolean().optional().describe('Ajouter les liens de la page (200 au plus).'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ tab_id: tabId, max_chars: maxChars = 20000, include_links: withLinks = false }) => {
    const { tab } = tabOrFail(tabId);
    const wc = tab.view.webContents;
    if (wc.isLoading()) await waitForLoad(wc);
    if (!/^https?:/.test(wc.getURL())) return fail('Seules les pages web (http / https) peuvent être lues.');
    return text(await wc.executeJavaScript(READ_PAGE(maxChars, withLinks), true));
  });

  mcp.registerTool('screenshot', {
    title: "Capture d'écran",
    description: "Capture la partie visible d'un onglet (PNG). L'onglet est affiché s'il ne l'est pas.",
    inputSchema: { tab_id: tabIdArg },
    annotations: { readOnlyHint: true },
  }, async ({ tab_id: tabId }) => {
    const { ctx, tab } = tabOrFail(tabId);
    if (ctx.tabs.activeId !== tab.id) {
      ctx.tabs.activate(tab.id);
      await new Promise((r) => setTimeout(r, 400)); // laisse la page se peindre
    }
    let img = await tab.view.webContents.capturePage();
    if (img.getSize().width > 1280) img = img.resize({ width: 1280 });
    return { content: [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }] };
  });

  mcp.registerTool('click', {
    title: 'Cliquer',
    description: 'Clique sur le premier élément correspondant à un sélecteur CSS, ou sur le lien / bouton dont le texte contient `text`.',
    inputSchema: {
      tab_id: tabIdArg,
      selector: z.string().optional().describe('Sélecteur CSS, par ex. "button[type=submit]".'),
      text: z.string().optional().describe('Texte du lien ou du bouton (si pas de sélecteur).'),
    },
  }, async ({ tab_id: tabId, selector, text: label }) => {
    if (!selector && !label) return fail('Donner `selector` ou `text`.');
    const { ctx, tab } = tabOrFail(tabId);
    const wc = tab.view.webContents;
    const found = await wc.executeJavaScript(`(() => {
      const sel = ${JSON.stringify(selector || null)};
      const label = ${JSON.stringify((label || '').toLowerCase())};
      const el = sel ? document.querySelector(sel)
        : [...document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], summary, label')]
            .find((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(label));
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return (el.innerText || el.value || el.tagName).trim().slice(0, 80);
    })()`, true);
    if (!found) return fail('Élément introuvable.');
    await waitForLoad(wc, 8000);
    return text({ clicked: found, tab: tabInfo(ctx, tab) });
  });

  mcp.registerTool('type_text', {
    title: 'Écrire dans un champ',
    description: 'Écrit du texte dans un champ (input, textarea ou zone éditable) désigné par un sélecteur CSS (par défaut : le champ qui a le focus, sinon le premier champ de texte visible). Option : valider avec Entrée.',
    inputSchema: {
      tab_id: tabIdArg,
      selector: z.string().optional().describe('Sélecteur CSS du champ.'),
      text: z.string().describe('Texte à écrire (remplace le contenu actuel).'),
      submit: z.boolean().optional().describe('Appuyer sur Entrée après (envoie le formulaire).'),
    },
  }, async ({ tab_id: tabId, selector, text: value, submit }) => {
    const { ctx, tab } = tabOrFail(tabId);
    const wc = tab.view.webContents;
    const ok = await wc.executeJavaScript(`(() => {
      const sel = ${JSON.stringify(selector || null)};
      const visible = (e) => e.offsetParent !== null;
      const el = sel ? document.querySelector(sel)
        : (document.activeElement && document.activeElement.matches('input, textarea, [contenteditable=""], [contenteditable=true]') ? document.activeElement
          : [...document.querySelectorAll('input[type=text], input[type=search], input:not([type]), textarea, [contenteditable=""], [contenteditable=true]')].find(visible));
      if (!el) return false;
      el.focus();
      if ('value' in el && !el.isContentEditable) {
        // passe par le « setter » natif pour que React & co voient la modification
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, ${JSON.stringify(value)});
      }
      if (${submit ? 'true' : 'false'}) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        // les touches synthétiques n'envoient pas les formulaires : on le fait nous-mêmes
        if (notHandled && el.form) el.form.requestSubmit();
      }
      return true;
    })()`, true);
    if (!ok) return fail('Champ introuvable.');
    if (submit) await waitForLoad(wc, 8000);
    return text({ typed: true, tab: tabInfo(ctx, tab) });
  });

  mcp.registerTool('activate_tab', {
    title: 'Afficher un onglet',
    description: "Affiche l'onglet donné.",
    inputSchema: { tab_id: z.number().int() },
  }, async ({ tab_id: tabId }) => {
    const { ctx, tab } = tabOrFail(tabId);
    ctx.tabs.activate(tab.id);
    return text(tabInfo(ctx, tab));
  });

  mcp.registerTool('close_tab', {
    title: 'Fermer un onglet',
    description: "Ferme l'onglet donné.",
    inputSchema: { tab_id: z.number().int() },
    annotations: { destructiveHint: true },
  }, async ({ tab_id: tabId }) => {
    const { ctx, tab } = tabOrFail(tabId);
    ctx.tabs.close(tab.id);
    return text(`Onglet ${tab.id} fermé.`);
  });

  return mcp;
}

// --- serveur HTTP (transport « Streamable HTTP », sans état) ---
function checkRequest(req, { port, token }) {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'Host refusé';
  const auth = String(req.headers.authorization || '');
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 'Jeton invalide';
  return null;
}

async function handle(req, res, cfg) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const refused = checkRequest(req, cfg);
  if (refused) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: refused }));
    return;
  }
  if (req.method !== 'POST') {
    // pas de flux serveur → client en mode sans état
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) {
      res.writeHead(413).end();
      return;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const mcp = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

function stop() {
  if (server) server.close();
  server = null;
}

function start() {
  stop();
  const cfg = getSettings();
  if (!cfg.enabled || !api) return;
  lastError = null;
  server = http.createServer((req, res) => {
    handle(req, res, getSettings()).catch((e) => {
      console.error('MCP :', e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.on('error', (e) => {
    lastError = e.code === 'EADDRINUSE' ? `Le port ${cfg.port} est déjà utilisé.` : e.message;
    server = null;
    api.onStatusChange?.();
  });
  server.listen(cfg.port, '127.0.0.1', () => api.onStatusChange?.());
}

function init(appApi) {
  api = appApi;
  start();
}

function status() {
  const { enabled, port, token } = getSettings();
  return { enabled, port, token, url: `http://127.0.0.1:${port}/mcp`, running: !!server && server.listening, error: lastError };
}

function setEnabled(on) {
  saveSettings({ enabled: !!on });
  start();
  return {};
}

function regenerateToken() {
  saveSettings({ token: crypto.randomBytes(24).toString('hex') });
  return {};
}

module.exports = { init, status, setEnabled, regenerateToken, stop };
