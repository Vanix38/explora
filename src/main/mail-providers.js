// Réglages IMAP/SMTP devinés à partir de l'adresse mail (comme Thunderbird) :
//   1) table des fournisseurs courants ;
//   2) base de données ISPDB de Thunderbird (autoconfig.thunderbird.net) ;
//   3) à défaut, imap.<domaine> / smtp.<domaine>.
const { net } = require('electron');

const imap = (host, port = 993) => ({ host, port, secure: port === 993 });
const smtp = (host, port = 465) => ({ host, port, secure: port === 465 });

// note : message affiché à l'ajout du compte (mot de passe d'application, etc.)
const PROVIDERS = [
  {
    domains: ['gmail.com', 'googlemail.com'],
    name: 'Gmail',
    imap: imap('imap.gmail.com'),
    smtp: smtp('smtp.gmail.com'),
    savesSent: true, // Gmail range tout seul les messages envoyés dans « Messages envoyés »
    note: "Gmail : active la validation en deux étapes puis crée un « mot de passe d'application » sur myaccount.google.com/apppasswords et colle-le ici.",
    help: 'https://myaccount.google.com/apppasswords',
  },
  {
    domains: ['outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com'],
    name: 'Outlook',
    imap: imap('outlook.office365.com'),
    smtp: smtp('smtp-mail.outlook.com', 587),
    savesSent: true,
    note: "Outlook / Hotmail : Microsoft n'accepte plus que la connexion OAuth pour ces comptes, pas encore prise en charge ici. Le mot de passe sera probablement refusé.",
  },
  {
    domains: ['yahoo.com', 'yahoo.fr', 'ymail.com'],
    name: 'Yahoo',
    imap: imap('imap.mail.yahoo.com'),
    smtp: smtp('smtp.mail.yahoo.com'),
    note: "Yahoo : crée un « mot de passe d'application » dans la sécurité du compte Yahoo et colle-le ici.",
  },
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    name: 'iCloud',
    imap: imap('imap.mail.me.com'),
    smtp: smtp('smtp.mail.me.com', 587),
    note: "iCloud : crée un mot de passe pour app sur account.apple.com (Connexion et sécurité) et colle-le ici.",
  },
  { domains: ['free.fr'], name: 'Free', imap: imap('imap.free.fr'), smtp: smtp('smtp.free.fr') },
  { domains: ['orange.fr', 'wanadoo.fr'], name: 'Orange', imap: imap('imap.orange.fr'), smtp: smtp('smtp.orange.fr') },
  { domains: ['sfr.fr', 'neuf.fr'], name: 'SFR', imap: imap('imap.sfr.fr'), smtp: smtp('smtp.sfr.fr') },
  { domains: ['laposte.net'], name: 'La Poste', imap: imap('imap.laposte.net'), smtp: smtp('smtp.laposte.net') },
  { domains: ['gmx.fr', 'gmx.com', 'gmx.net', 'gmx.de'], name: 'GMX', imap: imap('imap.gmx.net'), smtp: smtp('mail.gmx.net', 587) },
  { domains: ['fastmail.com', 'fastmail.fm'], name: 'Fastmail', imap: imap('imap.fastmail.com'), smtp: smtp('smtp.fastmail.com') },
  {
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
    name: 'Proton',
    imap: imap('127.0.0.1', 1143),
    smtp: smtp('127.0.0.1', 1025),
    note: 'Proton Mail : il faut installer et lancer « Proton Mail Bridge », puis utiliser le mot de passe fourni par le Bridge.',
  },
];

const domainOf = (email) => String(email || '').split('@')[1]?.trim().toLowerCase() || '';

function findProvider(email) {
  const domain = domainOf(email);
  return PROVIDERS.find((p) => p.domains.includes(domain)) || null;
}

// Lit la réponse XML de l'ISPDB (une entrée incomingServer/outgoingServer)
function parseIspdb(xml, email) {
  const pick = (tag, type) => {
    const re = new RegExp(`<${tag}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const block = xml.match(re)?.[1];
    if (!block) return null;
    const get = (name) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim();
    const socket = (get('socketType') || '').toUpperCase();
    const port = Number(get('port'));
    const host = get('hostname');
    if (!host || !port) return null;
    return { host, port, secure: socket === 'SSL' };
  };
  const inc = pick('incomingServer', 'imap');
  const out = pick('outgoingServer', 'smtp');
  if (!inc || !out) return null;
  const name = xml.match(/<displayShortName>([^<]*)</i)?.[1]?.trim();
  return { name: name || domainOf(email), imap: inc, smtp: out };
}

async function fetchText(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Renvoie { name, imap, smtp, note?, help?, savesSent?, source }
async function guess(email) {
  const known = findProvider(email);
  if (known) return { ...known, domains: undefined, source: 'known' };
  const domain = domainOf(email);
  if (!domain) return null;
  const xml = await fetchText(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`);
  const found = xml && parseIspdb(xml, email);
  if (found) return { ...found, source: 'ispdb' };
  return { name: domain, imap: imap(`imap.${domain}`), smtp: smtp(`smtp.${domain}`), source: 'guess' };
}

module.exports = { guess, findProvider, domainOf, parseIspdb };
