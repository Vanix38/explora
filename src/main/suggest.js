// Suggestions de recherche en ligne pour la barre d'adresse (comme Chrome) :
// on interroge l'API de suggestions du moteur actif pendant la frappe.
//
// Les requêtes passent par une session à part, en mémoire seulement : aucun
// cookie ni connexion de l'utilisateur n'est envoyé au moteur.
const { session } = require('electron');

const TIMEOUT = 2500;
const CACHE_MS = 60 * 1000;
const MAX_RESULTS = 8;

// Toutes ces API répondent au format OpenSearch : [question, [suggestions…], …]
const google = (q) => `https://suggestqueries.google.com/complete/search?client=firefox&hl=fr&ie=utf-8&oe=utf-8&q=${q}`;
const PROVIDERS = [
  { host: /(^|\.)youtube\.com$/, url: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=fr&ie=utf-8&oe=utf-8&q=${q}` },
  { host: /(^|\.)google\.[a-z.]+$/, url: google },
  { host: /(^|\.)duckduckgo\.com$/, url: (q) => `https://duckduckgo.com/ac/?type=list&kl=fr-fr&q=${q}` },
  { host: /(^|\.)bing\.com$/, url: (q) => `https://api.bing.com/osjson.aspx?market=fr-FR&query=${q}` },
  { host: /(^|\.)wikipedia\.org$/, url: (q, host) => `https://${host}/w/api.php?action=opensearch&format=json&limit=${MAX_RESULTS}&search=${q}` },
  { host: /(^|\.)qwant\.com$/, url: (q) => `https://api.qwant.com/v3/suggest?locale=fr_FR&q=${q}`, parse: (d) => (d?.data?.items || []).map((i) => i.value) },
  { host: /(^|\.)ecosia\.org$/, url: (q) => `https://ac.ecosia.org/autocomplete?type=list&q=${q}` },
];

// Moteur -> adresse de l'API de suggestions. Les IA et les moteurs sans API
// connue utilisent les suggestions Google.
function providerFor(engine) {
  let host = '';
  try { host = new URL((engine?.url || '').replace(/{q}|%s/g, 'x')).hostname; } catch { /* repli Google */ }
  if (engine?.type === 'search') {
    const p = PROVIDERS.find((x) => x.host.test(host));
    if (p) return { url: (q) => p.url(q, host), parse: p.parse, key: host };
  }
  return { url: google, key: 'google' };
}

let ses = null;
const cache = new Map(); // clé -> { time, list }
let inflight = null;

async function fetchSuggestions(engine, query) {
  const text = String(query || '').trim();
  if (!text || text.length > 200) return [];
  const provider = providerFor(engine);
  const key = `${provider.key}\n${text.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.list;

  // une seule requête à la fois : la frappe suivante annule la précédente
  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    if (!ses) ses = session.fromPartition('explora-suggest'); // en mémoire, sans « persist: »
    const res = await ses.fetch(provider.url(encodeURIComponent(text)), {
      signal: ctrl.signal,
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    const raw = provider.parse ? provider.parse(data) : Array.isArray(data) ? data[1] : [];
    const seen = new Set();
    const list = [];
    for (const s of Array.isArray(raw) ? raw : []) {
      const v = typeof s === 'string' ? s.trim() : '';
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      list.push(v);
      if (list.length >= MAX_RESULTS) break;
    }
    cache.set(key, { time: Date.now(), list });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return list;
  } catch {
    return []; // hors ligne, délai dépassé, requête annulée…
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
}

module.exports = { fetchSuggestions };
