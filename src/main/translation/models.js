// Modèles de traduction Bergamot : liste des modèles disponibles, téléchargement
// (avec vérification SHA-256) et stockage dans %APPDATA%\custom-nav\translation.
// Les modèles sont ceux du projet Bergamot (browser.mt), le même moteur que
// Firefox Translations. Un modèle traduit une langue vers l'anglais ou depuis
// l'anglais ; entre deux autres langues, on passe par l'anglais (pivot).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, net } = require('electron');

const BASE_URL = 'https://storage.googleapis.com/bergamot-models-sandbox/0.3.3/';
const REGISTRY_URL = `${BASE_URL}registry.json`;
const REGISTRY_MAX_AGE = 7 * 24 * 3600 * 1000; // liste rafraîchie au plus une fois par semaine
const PIVOT = 'en';

const rootDir = () => path.join(app.getPath('userData'), 'translation');
const modelsDir = () => path.join(rootDir(), 'models');
const registryFile = () => path.join(rootDir(), 'registry.json');

let registry = null; // { pair: { model, lex, vocab | srcvocab+trgvocab } }
let registryAt = 0;
let registryPromise = null;
const downloads = new Map(); // pair -> { promise, done, total }
let onChange = () => {};

function setOnChange(fn) {
  onChange = fn;
}

function readCachedRegistry() {
  try {
    const { fetchedAt, data } = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    if (data && typeof data === 'object') return { fetchedAt, data };
  } catch {
    // pas encore de cache
  }
  return null;
}

// Liste des modèles : cache disque, rafraîchie depuis Internet si trop vieille
function loadRegistry({ refresh = false } = {}) {
  if (registry && !refresh && Date.now() - registryAt < REGISTRY_MAX_AGE) return Promise.resolve(registry);
  if (registryPromise) return registryPromise;
  registryPromise = (async () => {
    const cached = readCachedRegistry();
    if (cached && !refresh && Date.now() - cached.fetchedAt < REGISTRY_MAX_AGE) {
      registry = cached.data;
      registryAt = cached.fetchedAt;
      return registry;
    }
    try {
      const res = await net.fetch(REGISTRY_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      registry = data;
      registryAt = Date.now();
      fs.mkdirSync(rootDir(), { recursive: true });
      fs.writeFileSync(registryFile(), JSON.stringify({ fetchedAt: registryAt, data }));
      return registry;
    } catch (err) {
      if (cached) {
        registry = cached.data;
        registryAt = Date.now() - REGISTRY_MAX_AGE + 3600 * 1000; // on réessaiera dans une heure
        return registry;
      }
      throw new Error(`Impossible de récupérer la liste des langues (${err.message}). Vérifie la connexion Internet.`);
    } finally {
      registryPromise = null;
    }
  })();
  return registryPromise;
}

// Registre déjà chargé (ou en cache disque), sans accès réseau
function knownRegistry() {
  if (!registry) {
    const cached = readCachedRegistry();
    if (cached) {
      registry = cached.data;
      registryAt = cached.fetchedAt;
    }
  }
  return registry;
}

const pairFiles = (pair) => Object.values(registry?.[pair] || {}).filter((f) => f && f.name);
const filePath = (pair, f) => path.join(modelsDir(), pair, path.basename(f.name));

function isInstalled(pair) {
  const files = pairFiles(pair);
  if (files.length === 0) return false;
  return files.every((f) => {
    try {
      return fs.statSync(filePath(pair, f)).size === f.size;
    } catch {
      return false;
    }
  });
}

const pairSize = (pair) => pairFiles(pair).reduce((n, f) => n + (f.size || 0), 0);
const isExperimental = (pair) => pairFiles(pair).some((f) => f.modelType && f.modelType !== 'prod');

// Langues proposées : toutes celles qui ont un modèle vers ou depuis l'anglais
function languages() {
  const reg = knownRegistry();
  if (!reg) return [];
  const codes = new Set([PIVOT]);
  for (const pair of Object.keys(reg)) {
    codes.add(pair.slice(0, 2));
    codes.add(pair.slice(2, 4));
  }
  return [...codes];
}

// Modèles à enchaîner pour traduire from -> to (null si impossible)
function route(from, to) {
  const reg = knownRegistry();
  if (!reg || !from || !to || from === to) return null;
  if (reg[from + to]) return [from + to];
  if (reg[from + PIVOT] && reg[PIVOT + to]) return [from + PIVOT, PIVOT + to];
  return null;
}

// Téléchargement d'un fichier, vérifié avec son empreinte SHA-256
async function downloadFile(pair, f, progress) {
  const dest = filePath(pair, f);
  try {
    if (fs.statSync(dest).size === f.size) {
      progress(f.size);
      return;
    }
  } catch {
    // à télécharger
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = /^https:\/\//.test(f.name) ? f.name : `${BASE_URL}${pair}/${f.name}`;
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Téléchargement impossible de ${path.basename(f.name)} (HTTP ${res.status})`);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      progress(value.byteLength);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (f.expectedSha256Hash && hash.digest('hex') !== f.expectedSha256Hash) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Fichier corrompu : ${path.basename(f.name)} (empreinte incorrecte)`);
  }
  fs.renameSync(tmp, dest);
}

// Télécharge les fichiers d'un modèle (un seul téléchargement à la fois par modèle)
function ensurePair(pair) {
  if (isInstalled(pair)) return Promise.resolve();
  const running = downloads.get(pair);
  if (running) return running.promise;
  const files = pairFiles(pair);
  if (files.length === 0) return Promise.reject(new Error(`Modèle inconnu : ${pair}`));
  const state = { done: 0, total: pairSize(pair) };
  let lastEmit = 0;
  const progress = (n) => {
    state.done += n;
    if (Date.now() - lastEmit > 250) {
      lastEmit = Date.now();
      onChange();
    }
  };
  state.promise = (async () => {
    try {
      for (const f of files) await downloadFile(pair, f, progress);
    } finally {
      downloads.delete(pair);
      onChange();
    }
  })();
  downloads.set(pair, state);
  onChange();
  return state.promise;
}

// Progression des téléchargements en cours pour une liste de modèles (0..1, ou null)
function downloadProgress(pairs) {
  let done = 0;
  let total = 0;
  let any = false;
  for (const p of pairs) {
    const d = downloads.get(p);
    if (d) {
      any = true;
      done += d.done;
      total += d.total;
    } else if (!isInstalled(p)) {
      total += pairSize(p);
    }
  }
  return any && total ? Math.min(1, done / total) : null;
}

const isDownloading = (pair) => downloads.has(pair);

// Fichiers à donner au moteur pour charger un modèle
function modelFiles(pair) {
  const r = registry[pair];
  const p = (f) => filePath(pair, f);
  const vocabs = r.vocab ? [p(r.vocab)] : [p(r.srcvocab), p(r.trgvocab)];
  return {
    files: { model: p(r.model), lex: p(r.lex), vocabs },
    // les modèles « intgemm8 » (ukrainien) demandent une autre précision
    precision: r.model.name.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll',
  };
}

function removePair(pair) {
  if (downloads.has(pair)) return false;
  fs.rmSync(path.join(modelsDir(), path.basename(pair)), { recursive: true, force: true });
  return true;
}

// Les deux modèles d'une langue (vers l'anglais et depuis l'anglais)
function pairsForLanguage(lang) {
  const reg = knownRegistry() || {};
  if (lang === PIVOT) return [];
  return [lang + PIVOT, PIVOT + lang].filter((p) => reg[p]);
}

module.exports = {
  PIVOT,
  setOnChange,
  loadRegistry,
  knownRegistry,
  languages,
  route,
  ensurePair,
  isInstalled,
  isDownloading,
  isExperimental,
  pairSize,
  downloadProgress,
  modelFiles,
  removePair,
  pairsForLanguage,
};
