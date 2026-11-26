// Traduction intégrée (moteur Bergamot de Firefox Translations), 100 % locale :
// les pages et le texte sélectionné sont traduits sur le PC, seuls les modèles
// de langue sont téléchargés (une fois) depuis Internet.
//
//  - translatePage / restorePage : traduction de la page d'un onglet
//  - translateSelection           : bulle de traduction du texte sélectionné
//  - status / install / remove    : gestion des langues (page Réglages)

const fs = require('fs');
const path = require('path');
const { webContents: allWebContents } = require('electron');
const settings = require('../settings');
const models = require('./models');
const engine = require('./engine');
const L = require('./languages');

const WORLD_ID = 1007; // monde isolé : le site ne voit pas nos scripts
const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'content', 'page.js'), 'utf8');
const BUBBLE_SCRIPT = fs.readFileSync(path.join(__dirname, 'content', 'bubble.js'), 'utf8');
const MAX_SELECTION = 5000;

let hooks = { onTabState: () => {}, onStatus: () => {} };
const states = new Map(); // webContents.id -> état de traduction de l'onglet
const watched = new WeakSet();
let registryError = null;

// --- Réglages ---
function prefs() {
  const p = settings.get('translation', {}) || {};
  return {
    target: typeof p.target === 'string' && p.target ? p.target : 'fr',
    always: Array.isArray(p.always) ? p.always.filter((x) => typeof x === 'string') : [],
  };
}

function savePrefs(patch) {
  settings.set('translation', { ...prefs(), ...patch });
}

const target = () => prefs().target;

// --- État par onglet ---
function stateFor(wc) {
  let st = states.get(wc.id);
  if (!st) {
    st = { detected: null, status: 'idle', from: null, to: null, progress: null, error: null, run: 0, pairs: null };
    states.set(wc.id, st);
  }
  return st;
}

function canTranslate(from, to) {
  return !!from && !!to && from !== to && !!models.route(from, to);
}

// Ce que l'interface affiche pour l'onglet (bouton de la barre d'adresse)
function uiState(wc) {
  const st = stateFor(wc);
  const to = target();
  let title;
  let progress = null;
  if (st.status === 'downloading') {
    progress = models.downloadProgress(st.pairs || []);
    title = `Téléchargement du modèle de langue${progress != null ? ` (${Math.round(progress * 100)} %)` : ''}…`;
  } else if (st.status === 'translating') {
    progress = st.progress;
    title = `Traduction ${L.inName(st.to)} en cours${progress != null ? ` (${Math.round(progress * 100)} %)` : ''}…`;
  } else if (st.status === 'translated') {
    title = `Page traduite ${L.fromName(st.from)} ${L.inName(st.to)} — cliquer pour les options`;
  } else if (st.status === 'error') {
    title = `Traduction impossible : ${st.error}`;
  } else if (st.detected && st.detected !== to) {
    title = `Traduire cette page (${L.name(st.detected)}) ${L.inName(to)}`;
  } else {
    title = 'Traduire la page';
  }
  return {
    status: st.status,
    offer: !!st.detected && st.detected !== to && L.NAMES[st.detected] !== undefined,
    progress,
    title,
  };
}

function emit(wc) {
  if (!wc.isDestroyed()) hooks.onTabState(wc, uiState(wc));
}

const exec = (wc, code) => wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Détection de la langue de la page ---
async function detectPage(wc, attempt = 0) {
  if (wc.isDestroyed() || !/^https?:/.test(wc.getURL())) return;
  const st = stateFor(wc);
  const run = st.run;
  let info;
  try {
    info = await exec(wc, `({ lang: document.documentElement.lang || '', text: document.body ? document.body.innerText.slice(0, 6000) : '' })`);
  } catch {
    return;
  }
  if (wc.isDestroyed() || run !== st.run) return;
  const found = L.detect(info?.text);
  const attr = L.normalizeLangAttr(info?.lang);
  let lang = null;
  if (found?.confident) lang = found.lang;
  else if (L.NAMES[attr]) lang = attr;
  else if (found) lang = found.lang;
  // page encore vide (site qui se construit en JavaScript) : on réessaie
  if (!lang && attempt < 3) {
    setTimeout(() => detectPage(wc, attempt + 1), 1500);
    return;
  }
  st.detected = lang;
  emit(wc);
  await models.loadRegistry().catch(() => {});
  if (lang && prefs().always.includes(lang) && st.status === 'idle' && canTranslate(lang, target())) {
    translatePage(wc, lang, target());
  }
}

// À appeler pour chaque onglet (webContents de page web)
function attach(wc) {
  if (watched.has(wc)) return;
  watched.add(wc);
  wc.on('did-start-navigation', (d) => {
    if (!d.isMainFrame || d.isSameDocument) return;
    const st = stateFor(wc);
    st.run++;
    Object.assign(st, { detected: null, status: 'idle', from: null, to: null, progress: null, error: null, pairs: null });
    emit(wc);
  });
  wc.on('did-finish-load', () => detectPage(wc));
  wc.once('destroyed', () => states.delete(wc.id));
}

// --- Traduction de la page ---
async function translatePage(wc, from, to = target()) {
  const st = stateFor(wc);
  from = from || st.detected;
  const run = ++st.run;
  if (st.status === 'translated' || st.status === 'translating') await exec(wc, 'window.__cnTranslate && __cnTranslate.restore()').catch(() => {});
  const fail = (error) => {
    if (run !== st.run) return;
    Object.assign(st, { status: 'error', error, progress: null });
    emit(wc);
  };
  if (!from) return fail('langue de la page inconnue, choisis-la dans le menu « Langue de la page ».');
  if (from === to) return fail(`la page est déjà ${L.inName(to)}.`);
  try {
    await models.loadRegistry();
  } catch (err) {
    return fail(err.message);
  }
  const pairs = models.route(from, to);
  if (!pairs) return fail(`aucun modèle pour traduire ${L.fromName(from)} ${L.inName(to)}.`);
  Object.assign(st, { status: 'downloading', from, to, pairs, progress: null, error: null });
  emit(wc);
  try {
    for (const p of pairs) await models.ensurePair(p);
  } catch (err) {
    return fail(err.message);
  }
  if (run !== st.run) return;
  st.status = 'translating';
  emit(wc);
  hooks.onStatus();

  try {
    await exec(wc, PAGE_SCRIPT);
  } catch {
    return fail('la page ne peut pas être modifiée.');
  }
  let done = 0;
  let lastEmit = 0;
  while (run === st.run && !wc.isDestroyed()) {
    let batch;
    try {
      batch = await exec(wc, 'window.__cnTranslate ? __cnTranslate.collect(3000) : null');
    } catch {
      break; // page fermée ou en train de changer
    }
    if (!batch || run !== st.run) break;
    if (batch.blocks.length === 0) {
      if (st.status === 'translating') {
        Object.assign(st, { status: 'translated', progress: 1 });
        emit(wc);
      }
      await sleep(1500); // contenu ajouté plus tard par le site
      continue;
    }
    let out;
    try {
      out = await engine.translate(pairs, batch.blocks.map((b) => b.html), true);
    } catch (err) {
      return fail(err.message);
    }
    if (run !== st.run) break;
    const results = batch.blocks.map((b, i) => ({ id: b.id, html: out[i] }));
    await exec(wc, `window.__cnTranslate && __cnTranslate.apply(${JSON.stringify(results)})`).catch(() => {});
    done += batch.blocks.length;
    if (st.status === 'translating' && Date.now() - lastEmit > 200) {
      lastEmit = Date.now();
      st.progress = done / (done + batch.remaining);
      emit(wc);
    }
  }
}

async function restorePage(wc) {
  const st = stateFor(wc);
  st.run++;
  await exec(wc, 'window.__cnTranslate && __cnTranslate.restore()').catch(() => {});
  Object.assign(st, { status: 'idle', from: null, to: null, progress: null, error: null, pairs: null });
  emit(wc);
}

// Bouton / menu ☰ : traduit, ou revient à l'original si la page est traduite
function togglePage(wc) {
  const st = stateFor(wc);
  if (st.status === 'idle' || st.status === 'error') translatePage(wc, st.detected, target());
  else restorePage(wc);
}

// --- Texte sélectionné ---
// Langues pour un texte : vers la langue choisie, ou vers l'anglais si le
// texte y est déjà (pour traduire facilement ce qu'on écrit soi-même).
function selectionLangs(wc, text) {
  const to0 = target();
  const found = L.detect(text);
  const from = found?.lang || stateFor(wc).detected || 'en';
  const to = from === to0 ? (to0 === 'en' ? 'fr' : 'en') : to0;
  return { from, to };
}

function selectionMenuLabel(wc, text) {
  const { to } = selectionLangs(wc, text);
  const t = text.replace(/\s+/g, ' ').trim();
  const short = t.length > 24 ? `${t.slice(0, 22)}…` : t;
  return `Traduire « ${short.replace(/&/g, '&&')} » ${L.inName(to)}`;
}

async function translateSelection(wc, rawText) {
  const text = String(rawText || '').slice(0, MAX_SELECTION);
  if (!text.trim()) return;
  const { from, to } = selectionLangs(wc, text);
  const title = `${L.capitalized(from)} → ${L.name(to)}`;
  const show = (data) => exec(wc, `window.__cnBubble && __cnBubble.update(${JSON.stringify(data)})`).catch(() => {});
  try {
    await exec(wc, BUBBLE_SCRIPT);
    await exec(wc, '__cnBubble.open()');
  } catch {
    return;
  }
  await show({ title, text: 'Traduction…', status: 'loading' });
  try {
    await models.loadRegistry();
    const pairs = models.route(from, to);
    if (!pairs) throw new Error(`Aucun modèle pour traduire ${L.fromName(from)} ${L.inName(to)}.`);
    if (!pairs.every(models.isInstalled)) {
      await show({ title, text: 'Téléchargement du modèle de langue…', status: 'loading' });
      const timer = setInterval(() => {
        const p = models.downloadProgress(pairs);
        if (p != null) show({ text: `Téléchargement du modèle de langue… ${Math.round(p * 100)} %`, status: 'loading' });
      }, 500);
      try {
        for (const p of pairs) await models.ensurePair(p);
      } finally {
        clearInterval(timer);
      }
      await show({ text: 'Traduction…', status: 'loading' });
    }
    // ligne par ligne, pour garder les retours à la ligne
    const lines = text.split('\n');
    const todo = lines.map((l, i) => [l, i]).filter(([l]) => /\p{L}/u.test(l));
    const out = todo.length ? await engine.translate(pairs, todo.map(([l]) => l.trim()), false) : [];
    todo.forEach(([, i], k) => { lines[i] = out[k]; });
    await show({ text: lines.join('\n').trim(), status: 'done' });
  } catch (err) {
    await show({ text: err.message, status: 'error' });
  }
}

// --- Menu du bouton « Traduire » ---
function menuTemplate(wc, { openSettings }) {
  const st = stateFor(wc);
  const to = target();
  const langs = models.languages().sort((a, b) => L.name(a).localeCompare(L.name(b), 'fr'));
  const items = [];
  const busy = st.status === 'downloading' || st.status === 'translating';

  if (st.status === 'translated') {
    items.push(
      { label: `Page traduite ${L.fromName(st.from)} ${L.inName(st.to)}`, enabled: false },
      { label: 'Afficher la page originale', click: () => restorePage(wc) },
    );
  } else if (busy) {
    const ui = uiState(wc);
    items.push(
      { label: ui.title, enabled: false },
      { label: 'Arrêter et afficher la page originale', click: () => restorePage(wc) },
    );
  } else {
    if (st.status === 'error') items.push({ label: `Échec : ${st.error}`.slice(0, 110), enabled: false });
    const from = st.detected;
    items.push({
      label: from ? `Traduire ${L.fromName(from)} ${L.inName(to)}` : `Traduire ${L.inName(to)}`,
      enabled: canTranslate(from, to) || !models.knownRegistry(),
      click: () => translatePage(wc, from, to),
    });
  }
  items.push({ type: 'separator' });

  const shown = st.status === 'idle' || st.status === 'error' ? st.detected : st.from;
  items.push({
    label: 'Langue de la page',
    enabled: langs.length > 0,
    submenu: langs.length ? langs.map((code) => ({
      label: L.capitalized(code),
      type: 'radio',
      checked: code === shown,
      enabled: code !== to && canTranslate(code, to),
      click: () => {
        st.detected = code;
        translatePage(wc, code, to);
      },
    })) : [{ label: '(liste en cours de chargement)', enabled: false }],
  });
  items.push({
    label: 'Traduire vers',
    enabled: langs.length > 0,
    submenu: langs.length ? langs.map((code) => ({
      label: L.capitalized(code),
      type: 'radio',
      checked: code === to,
      click: () => {
        savePrefs({ target: code });
        hooks.onStatus();
        if (st.status !== 'idle' && st.status !== 'error') translatePage(wc, st.from, code);
        else emit(wc);
      },
    })) : [{ label: '(liste en cours de chargement)', enabled: false }],
  });
  const lang = st.from || st.detected;
  if (lang && lang !== to) {
    const always = prefs().always.includes(lang);
    items.push({
      label: `Toujours traduire les pages ${L.inName(lang)}`,
      type: 'checkbox',
      checked: always,
      click: () => {
        setAlways(lang, !always);
        if (!always && (st.status === 'idle' || st.status === 'error')) translatePage(wc, lang, to);
      },
    });
  }
  items.push({ type: 'separator' }, { label: 'Gérer les langues…', click: openSettings });
  return items;
}

// --- Gestion des langues (Réglages) ---
function setAlways(lang, on) {
  const always = prefs().always.filter((l) => l !== lang);
  if (on) always.push(lang);
  savePrefs({ always });
  hooks.onStatus();
  return {};
}

function setTarget(code) {
  if (typeof code !== 'string' || !/^[a-z]{2}$/.test(code)) return { error: 'Langue invalide.' };
  savePrefs({ target: code });
  hooks.onStatus();
  for (const id of states.keys()) {
    const wc = allWebContents.fromId(id);
    if (wc) emit(wc);
  }
  return {};
}

function status() {
  const reg = models.knownRegistry();
  const p = prefs();
  const langs = models.languages();
  return {
    target: p.target,
    always: p.always.map((code) => ({ code, name: L.capitalized(code) })),
    error: reg ? null : registryError,
    loading: !reg && !registryError,
    targets: langs.map((code) => ({ code, name: L.capitalized(code) })).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    languages: langs.filter((c) => c !== models.PIVOT).map((code) => {
      const pairs = models.pairsForLanguage(code);
      const installed = pairs.filter(models.isInstalled).length;
      const has = (pair) => pairs.includes(pair) && models.isInstalled(pair);
      return {
        toEn: has(code + models.PIVOT),
        fromEn: has(models.PIVOT + code),
        missingSize: pairs.filter((pr) => !models.isInstalled(pr)).reduce((n, pr) => n + models.pairSize(pr), 0),
        code,
        name: L.capitalized(code),
        installed: pairs.length > 0 && installed === pairs.length,
        partial: installed > 0 && installed < pairs.length,
        downloading: pairs.some(models.isDownloading),
        progress: models.downloadProgress(pairs),
        size: pairs.reduce((n, pr) => n + models.pairSize(pr), 0),
        experimental: pairs.some(models.isExperimental),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  };
}

// Charge la liste des langues (au besoin) puis prévient la page Réglages
function refresh() {
  models.loadRegistry()
    .then(() => { registryError = null; })
    .catch((err) => { registryError = err.message; })
    .finally(() => hooks.onStatus());
  return status();
}

async function install(code) {
  try {
    await models.loadRegistry();
    const pairs = models.pairsForLanguage(code);
    if (!pairs.length) return { error: 'Langue inconnue.' };
    for (const p of pairs) await models.ensurePair(p);
    return {};
  } catch (err) {
    return { error: err.message };
  }
}

async function remove(code) {
  for (const p of models.pairsForLanguage(code)) {
    await engine.unload(p);
    if (!models.removePair(p)) return { error: 'Téléchargement en cours : réessaie après.' };
  }
  hooks.onStatus();
  return {};
}

function init(h) {
  hooks = { ...hooks, ...h };
  // pendant un téléchargement : bouton des onglets concernés et page Réglages à jour
  models.setOnChange(() => {
    hooks.onStatus();
    for (const [id, st] of states) {
      if (st.status !== 'downloading') continue;
      const wc = allWebContents.fromId(id);
      if (wc) emit(wc);
    }
  });
}

module.exports = {
  init,
  attach,
  uiState,
  translatePage,
  restorePage,
  togglePage,
  translateSelection,
  selectionMenuLabel,
  menuTemplate,
  status,
  refresh,
  install,
  remove,
  setTarget,
  setAlways,
  stop: engine.stop,
};
