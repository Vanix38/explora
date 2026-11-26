// Migration de l'ancien nom « Custom Nav » vers « Explora ».
// - userData : %APPDATA%\custom-nav est COPIÉ (pas déplacé) vers %APPDATA%\Explora
//   au premier lancement ; l'ancien dossier reste comme sauvegarde.
// - adresses : customnav://… -> explora://… (fichiers JSON de l'app et URL ouvertes).
const fs = require('fs');
const path = require('path');

const LEGACY_SCHEME = 'customnav:';

// customnav://settings/ -> explora://settings/ ; toute autre valeur est renvoyée telle quelle.
function upgradeLegacyUrl(url) {
  return typeof url === 'string' && url.slice(0, LEGACY_SCHEME.length).toLowerCase() === LEGACY_SCHEME
    ? `explora:${url.slice(LEGACY_SCHEME.length)}`
    : url;
}

// Remplace customnav:// par explora:// dans les fichiers JSON à la racine de `dir`
// (settings, historique, favoris, messageries…).
function rewriteJsonFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!/customnav:\/\//i.test(text)) continue;
      fs.writeFileSync(file, text.replace(/customnav:\/\//gi, 'explora://'));
    } catch (err) {
      console.warn(`[migration] ${name} non mis à jour :`, err.message);
    }
  }
}

// À appeler après app.setPath('userData', …) et avant app.whenReady().
function migrateUserData(legacyDir, newDir) {
  try {
    if (fs.existsSync(path.join(newDir, 'settings.json')) || !fs.existsSync(legacyDir)) return;
    console.log(`[migration] copie de ${legacyDir} vers ${newDir}`);
    copyTree(legacyDir, newDir);
    rewriteJsonFiles(newDir);
  } catch (err) {
    console.warn('[migration] échec :', err.message);
  }
}

// Copie récursive fichier par fichier : un fichier verrouillé (ancienne app
// ouverte) est ignoré sans interrompre le reste. N'écrase jamais l'existant.
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyTree(from, to);
      else fs.cpSync(from, to, { force: false, errorOnExist: false, preserveTimestamps: true });
    } catch (err) {
      console.warn(`[migration] ignoré : ${from} (${err.code || err.message})`);
    }
  }
}

module.exports = { migrateUserData, upgradeLegacyUrl };
