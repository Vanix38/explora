
// Pages internes (accueil, réglages) servies par le protocole customnav://
//   customnav://home/      -> src/internal/home.html
//   customnav://settings/  -> src/internal/settings.html
//   customnav://history/   -> src/internal/history.html
//   customnav://bookmarks/ -> src/internal/bookmarks.html
//   customnav://extensions/ -> src/internal/extensions.html
//   customnav://mail/       -> src/internal/mail.html (client mail)
//   customnav://<page>/x   -> src/internal/x (css, js partagés)

const path = require('path');
const { pathToFileURL } = require('url');
const { protocol, net } = require('electron');

const SCHEME = 'explora';
const ROOT = path.join(__dirname, '..', 'internal');
const PAGES = new Set(['home', 'settings', 'history', 'bookmarks', 'extensions', 'mail']);

// À appeler avant app.whenReady(), une seule fois : `extra` ajoute les autres
// schémas de l'app (registerSchemesAsPrivileged remplace la liste à chaque appel)
function registerScheme(extra = []) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ...extra,
  ]);
}

// À appeler pour chaque session qui doit afficher les pages internes
function handleProtocol(ses) {
  ses.protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (!PAGES.has(url.hostname)) return new Response('Page introuvable', { status: 404 });
    const rel = url.pathname === '/' ? `${url.hostname}.html` : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Interdit', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

const isInternalUrl = (url) => typeof url === 'string' && url.startsWith(`${SCHEME}://`);

// L'expéditeur d'un message IPC est-il bien une page interne (cadre principal) ?
function isInternalSender(event) {
  const frame = event.senderFrame;
  return !!frame && frame.parent === null && isInternalUrl(frame.url);
}

module.exports = { SCHEME, registerScheme, handleProtocol, isInternalUrl, isInternalSender };
