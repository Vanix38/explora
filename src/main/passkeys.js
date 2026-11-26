// Clés d'accès : évite la fenêtre Windows Hello qui s'ouvre en boucle sur les
// pages de connexion (Google, Discord…). Voir preload/passkeys-preload.js.
const path = require('path');
const { app } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'preload', 'passkeys-preload.js');

// À appeler avant la création des sessions : couvre toutes les sessions
// (fenêtre normale, fenêtres privées, intégrations).
function init() {
  app.on('session-created', (ses) => {
    ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
  });
}

module.exports = { init };
