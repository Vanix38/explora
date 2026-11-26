// Clés d'accès : beaucoup de sites (Google, Discord…) demandent une clé
// d'accès en « médiation conditionnelle », normalement proposée discrètement
// dans la liste de saisie automatique du champ identifiant. Electron n'a pas
// cette liste : sous Windows, la demande ouvre aussitôt la fenêtre Windows
// Hello, et le site la relance dès qu'on la ferme, en boucle.
//
// Sur tous les sites, on annonce donc que la médiation conditionnelle n'est
// pas disponible, et on laisse en attente toute demande conditionnelle qui
// partirait quand même. Les boutons « Se connecter avec une clé d'accès »
// (demandes explicites) fonctionnent toujours.
const { contextBridge } = require('electron');

function disableConditionalPasskeys() {
  const PKC = window.PublicKeyCredential;
  if (PKC) {
    PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
    const getCaps = PKC.getClientCapabilities;
    if (getCaps) {
      PKC.getClientCapabilities = function () {
        return getCaps.call(this).then((caps) => ({ ...caps, conditionalGet: false, conditionalCreate: false }));
      };
    }
  }
  const creds = navigator.credentials;
  if (creds && creds.get) {
    const get = creds.get.bind(creds);
    creds.get = function (options) {
      if (options && options.mediation === 'conditional' && options.publicKey) {
        return new Promise((_resolve, reject) => {
          const signal = options.signal;
          if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return get(options);
    };
  }
}

try {
  contextBridge.executeInMainWorld({ func: disableConditionalPasskeys });
} catch {
  // contextIsolation désactivé : le preload partage déjà le monde de la page
  try {
    disableConditionalPasskeys();
  } catch {}
}
