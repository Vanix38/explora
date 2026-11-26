// Connexion Google : Google refuse la connexion (« Ce navigateur ou cette
// application ne sont peut-être pas sécurisés ») dès qu'il soupçonne un
// navigateur intégré. Retirer « Electron/x » de l'user-agent ne suffit pas :
// les pages de connexion vérifient aussi en JavaScript des signaux propres à
// Google Chrome (marque « Google Chrome » dans navigator.userAgentData, objet
// window.chrome complet…) qu'Electron n'a pas.
//
// Comme d'autres navigateurs Electron (Ferdium, Rambox…), on se présente donc
// en Firefox, uniquement sur les pages de connexion Google : Google n'y fait
// alors pas les vérifications propres à Chrome. Le reste de la navigation
// garde l'user-agent Chrome normal.
const { app } = require('electron');

const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';

// Hôtes où se déroule la connexion à un compte Google.
const LOGIN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com']);

function isGoogleLogin(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && LOGIN_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

// En-têtes : user-agent Firefox et pas d'indices client « Sec-CH-UA »
// (Firefox n'en envoie pas, et ils trahiraient Chromium).
function patchSession(ses) {
  const urls = [...LOGIN_HOSTS].map((host) => `https://${host}/*`);
  ses.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(name)) delete headers[name];
    }
    headers['User-Agent'] = FIREFOX_UA;
    callback({ requestHeaders: headers });
  });
}

// Page : navigator.userAgent doit lui aussi annoncer Firefox, sinon Google voit
// l'incohérence entre l'en-tête et le JavaScript. On change l'user-agent de
// l'onglet au début de chaque navigation principale, et on le rétablit en
// quittant les pages de connexion.
function patchWebContents(wc) {
  if (wc.getType() === 'backgroundPage' || wc.getType() === 'remote') return;
  let normalUa = null;
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const current = wc.getUserAgent();
    if (isGoogleLogin(details.url)) {
      if (current !== FIREFOX_UA) {
        normalUa = current;
        wc.setUserAgent(FIREFOX_UA);
      }
    } else if (current === FIREFOX_UA) {
      wc.setUserAgent(normalUa || app.userAgentFallback);
    }
  });
}

// À appeler avant la création des sessions et des fenêtres.
function init() {
  app.on('session-created', patchSession);
  app.on('web-contents-created', (_event, wc) => patchWebContents(wc));
}

module.exports = { init, isGoogleLogin, FIREFOX_UA };
