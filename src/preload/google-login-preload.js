// Pages de connexion Google : Google demande une clé d'accès en « médiation
// conditionnelle » (normalement proposée discrètement dans la liste de
// saisie automatique du champ e-mail). Electron n'a pas cette liste : sous
// Windows, la demande ouvre aussitôt la fenêtre Windows Hello, et Google la
// relance dès qu'on la ferme, en boucle.
//
// Sur ces pages uniquement, on annonce donc que la médiation conditionnelle
// n'est pas disponible, et on laisse en attente toute demande conditionnelle
// qui partirait quand même. Le bouton « Utiliser une clé d'accès » de Google
// (demande explicite) fonctionne toujours.
const { contextBridge } = require('electron');

const LOGIN_HOSTS = ['accounts.google.com', 'accounts.youtube.com'];

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

if (LOGIN_HOSTS.includes(location.hostname)) {
  try {
    contextBridge.executeInMainWorld({ func: disableConditionalPasskeys });
  } catch {
    // contextIsolation désactivé : le preload partage déjà le monde de la page
    try {
      disableConditionalPasskeys();
    } catch {}
  }
}
