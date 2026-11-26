// Moteurs de recherche et IA, et transformation de la saisie en URL.
//
// Chaque entrée :
//   id      identifiant stable (sert aux réglages)
//   name    nom affiché
//   type    'ai' ou 'search'
//   url     gabarit de recherche, {q} (ou %s) = question encodée
//   home    page d'accueil (ouverte quand il n'y a pas de question)
//   inject  (facultatif) pour les sites qui n'acceptent pas la question dans
//           l'URL : on ouvre `url` puis on écrit la question dans le champ
//           `selector` une fois la page chargée, SANS l'envoyer.
//
// DEFAULT_ENGINES est la liste d'origine ; la liste réellement utilisée est
// éditable dans les réglages (setEngines).

const { upgradeLegacyUrl } = require('./migrate');

const DEFAULT_ENGINES = [
  { id: 'google', name: 'Google', type: 'search', url: 'https://www.google.com/search?q={q}', home: 'https://www.google.com/' },
  { id: 'duckduckgo', name: 'DuckDuckGo', type: 'search', url: 'https://duckduckgo.com/?q={q}', home: 'https://duckduckgo.com/' },
  { id: 'bing', name: 'Bing', type: 'search', url: 'https://www.bing.com/search?q={q}', home: 'https://www.bing.com/' },
  { id: 'youtube', name: 'YouTube', type: 'search', url: 'https://www.youtube.com/results?search_query={q}', home: 'https://www.youtube.com/' },
  { id: 'wikipedia', name: 'Wikipédia', type: 'search', url: 'https://fr.wikipedia.org/w/index.php?search={q}', home: 'https://fr.wikipedia.org/' },
  { id: 'claude', name: 'Claude', type: 'ai', url: 'https://claude.ai/new?q={q}', home: 'https://claude.ai/new' },
  { id: 'chatgpt', name: 'ChatGPT', type: 'ai', url: 'https://chatgpt.com/?q={q}', home: 'https://chatgpt.com/' },
  { id: 'perplexity', name: 'Perplexity', type: 'ai', url: 'https://www.perplexity.ai/search?q={q}', home: 'https://www.perplexity.ai/' },
  { id: 'mistral', name: 'Le Chat', type: 'ai', url: 'https://chat.mistral.ai/chat?q={q}', home: 'https://chat.mistral.ai/chat' },
  {
    id: 'gemini', name: 'Gemini', type: 'ai',
    url: 'https://gemini.google.com/app', home: 'https://gemini.google.com/app',
    inject: { selector: 'rich-textarea .ql-editor, .ql-editor[contenteditable="true"]' },
  },
];

const DEFAULT_ENGINE_ID = 'google';
// Sélecteur générique pour l'injection quand aucun n'est précisé
const GENERIC_INPUT_SELECTOR = 'textarea, [contenteditable="true"], input[type="search"], input[type="text"], input:not([type])';

let engines = structuredClone(DEFAULT_ENGINES);

const getEngines = () => engines;
function setEngines(list) {
  engines = list && list.length ? list : structuredClone(DEFAULT_ENGINES);
}

function getEngine(id) {
  return engines.find((e) => e.id === id) || engines.find((e) => e.id === DEFAULT_ENGINE_ID) || engines[0];
}

const hasQuerySlot = (url) => url.includes('{q}') || url.includes('%s');
const fillQuery = (url, q) => url.replace(/{q}|%s/g, encodeURIComponent(q));

function isHttpUrl(text) {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Vérifie et normalise un moteur saisi dans les réglages.
// Renvoie { engine } ou { error } (message en français).
function validateEngine(raw) {
  const name = String(raw?.name || '').trim();
  const url = String(raw?.url || '').trim();
  const type = raw?.type === 'ai' ? 'ai' : 'search';
  const injectOn = !!raw?.inject;
  if (!name) return { error: 'Le nom est obligatoire.' };
  if (!isHttpUrl(fillQuery(url, 'test'))) return { error: `« ${name} » : l'URL doit commencer par http:// ou https://.` };
  if (!injectOn && !hasQuerySlot(url)) {
    return { error: `« ${name} » : l'URL doit contenir {q} ou %s à la place de la question (ou activer l'injection).` };
  }
  let home = String(raw?.home || '').trim();
  if (home && !isHttpUrl(home)) return { error: `« ${name} » : la page d'accueil doit commencer par http:// ou https://.` };
  if (!home) home = new URL(fillQuery(url, '')).origin + '/';
  const engine = {
    id: String(raw?.id || '').trim() || `perso-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.slice(0, 40),
    type,
    url,
    home,
  };
  if (injectOn) {
    const selector = String(raw.inject.selector || '').trim();
    engine.inject = { selector: selector || GENERIC_INPUT_SELECTOR };
  }
  return { engine };
}

function iconFor(engine) {
  let host = '';
  try { host = new URL(engine.home).hostname; } catch { /* icône par défaut */ }
  return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
}

// Ce qu'il faut ouvrir pour poser `query` à `engine` : { url, inject? }
function buildEngineTarget(engine, query) {
  if (!query) return { url: engine.home };
  if (engine.inject) return { url: engine.url, inject: { selector: engine.inject.selector, text: query } };
  return { url: fillQuery(engine.url, query) };
}

// Retrouve la question dans une URL de résultats (ex. google.com/search?q=…)
function extractQuery(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const e of engines) {
    if (e.inject || !hasQuerySlot(e.url)) continue;
    let t;
    try { t = new URL(e.url.replace(/{q}|%s/g, '__Q__')); } catch { continue; }
    if (t.hostname !== u.hostname || t.pathname !== u.pathname) continue;
    for (const [key, val] of t.searchParams) {
      if (val === '__Q__' && u.searchParams.get(key)) return u.searchParams.get(key);
    }
  }
  return null;
}

function looksLikeUrl(text) {
  if (/\s/.test(text)) return false;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)) return true;
  return /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text);
}

// Saisie de la barre d'adresse -> { url, inject?, query? }
// URL ou domaine : ouvert tel quel. Sinon : question pour le moteur actif.
function resolveInput(input, engineId = DEFAULT_ENGINE_ID) {
  const text = String(input || '').trim();
  const engine = getEngine(engineId);
  if (!text) return { url: engine.home };
  if (/^(https?|file|about|view-source|explora|customnav):/i.test(text)) return { url: upgradeLegacyUrl(text) };
  if (looksLikeUrl(text)) {
    const isLocal = /^(localhost|\d{1,3}(\.\d{1,3}){3})/i.test(text);
    return { url: (isLocal ? 'http://' : 'https://') + text };
  }
  return { ...buildEngineTarget(engine, text), query: text };
}

module.exports = {
  DEFAULT_ENGINES, DEFAULT_ENGINE_ID, getEngines, setEngines, getEngine, validateEngine,
  iconFor, buildEngineTarget, extractQuery, resolveInput, isHttpUrl,
};
