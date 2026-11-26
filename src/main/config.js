// Configuration utilisateur : valeurs par défaut, lecture et validation.
// Tout est enregistré dans settings.json (dossier app.getPath('userData')).
const settings = require('./settings');
const search = require('./search');

const HOME_PAGE = 'explora://home/';
const SETTINGS_PAGE = 'explora://settings/';
const HISTORY_PAGE = 'explora://history/';
const BOOKMARKS_PAGE = 'explora://bookmarks/';
const EXTENSIONS_PAGE = 'explora://extensions/';

const DEFAULT_FAVORITES = [
  { name: 'YouTube', url: 'https://www.youtube.com/' },
  { name: 'GitHub', url: 'https://github.com/' },
  { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Wikipédia', url: 'https://fr.wikipedia.org/' },
];

const THEMES = ['system', 'light', 'dark'];

function load() {
  search.setEngines(settings.get('engines', null));
}

function getConfig() {
  const homepage = settings.get('homepage', { mode: 'internal', url: '' });
  return {
    activeEngine: search.getEngine(settings.get('activeEngine', search.DEFAULT_ENGINE_ID)).id,
    engines: search.getEngines(),
    homepage: { mode: homepage.mode === 'url' ? 'url' : 'internal', url: homepage.url || '' },
    theme: THEMES.includes(settings.get('theme')) ? settings.get('theme') : 'system',
    restoreTabs: settings.get('restoreTabs', true) !== false,
    favorites: settings.get('favorites', DEFAULT_FAVORITES),
    showBookmarksBar: settings.get('showBookmarksBar', true) !== false,
    // suggestions du moteur pendant la frappe dans la barre d'adresse
    searchSuggestions: settings.get('searchSuggestions', true) !== false,
  };
}

// URL ouverte dans un nouvel onglet
function homeUrl() {
  const { homepage } = getConfig();
  return homepage.mode === 'url' && search.isHttpUrl(homepage.url) ? homepage.url : HOME_PAGE;
}

// --- modifications (chacune renvoie { error } en cas de refus) ---

function setEngines(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'Il faut au moins un moteur.' };
  const out = [];
  const ids = new Set();
  for (const raw of list) {
    const { engine, error } = search.validateEngine(raw);
    if (error) return { error };
    if (ids.has(engine.id)) engine.id += '-' + out.length;
    ids.add(engine.id);
    out.push(engine);
  }
  settings.set('engines', out);
  search.setEngines(out);
  // si le moteur actif a été supprimé, getEngine retombe sur le premier
  settings.set('activeEngine', search.getEngine(settings.get('activeEngine')).id);
  return {};
}

function resetEngines() {
  settings.set('engines', null);
  search.setEngines(null);
  settings.set('activeEngine', search.getEngine(settings.get('activeEngine')).id);
  return {};
}

function setActiveEngine(id) {
  settings.set('activeEngine', search.getEngine(id).id);
  return {};
}

function setHomepage({ mode, url } = {}) {
  url = String(url || '').trim();
  if (mode === 'url' && !search.isHttpUrl(url)) {
    return { error: "L'adresse d'accueil doit commencer par http:// ou https://." };
  }
  settings.set('homepage', { mode: mode === 'url' ? 'url' : 'internal', url });
  return {};
}

function setTheme(theme) {
  if (!THEMES.includes(theme)) return { error: 'Thème inconnu.' };
  settings.set('theme', theme);
  return {};
}

function setRestoreTabs(on) {
  settings.set('restoreTabs', !!on);
  return {};
}

function setShowBookmarksBar(on) {
  settings.set('showBookmarksBar', !!on);
  return {};
}

function setSearchSuggestions(on) {
  settings.set('searchSuggestions', !!on);
  return {};
}

function setFavorites(list) {
  if (!Array.isArray(list)) return { error: 'Liste invalide.' };
  const out = [];
  for (const f of list) {
    const name = String(f?.name || '').trim();
    const url = String(f?.url || '').trim();
    if (!name && !url) continue;
    if (!search.isHttpUrl(url)) return { error: `« ${name || url} » : l'adresse doit commencer par http:// ou https://.` };
    out.push({ name: (name || new URL(url).hostname).slice(0, 40), url });
  }
  settings.set('favorites', out);
  return {};
}

// --- session (onglets du dernier lancement) ---
function getLastSession() {
  const s = settings.get('lastSession', null);
  return s && Array.isArray(s.tabs) ? s : null;
}

function saveSession(session) {
  settings.set('lastSession', session);
}

module.exports = {
  HOME_PAGE, SETTINGS_PAGE, HISTORY_PAGE, BOOKMARKS_PAGE, EXTENSIONS_PAGE, load, getConfig, homeUrl,
  setEngines, resetEngines, setActiveEngine, setHomepage, setTheme, setRestoreTabs, setFavorites, setShowBookmarksBar,
  setSearchSuggestions,
  getLastSession, saveSession,
};
