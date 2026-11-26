// Pilote du processus de traduction (worker.js lancé avec utilityProcess) :
// démarrage à la demande, chargement des modèles, file d'attente des
// traductions, arrêt après quelques minutes d'inactivité pour libérer la mémoire.

const path = require('path');
const { utilityProcess } = require('electron');
const models = require('./models');

const IDLE_MS = 5 * 60 * 1000;
const MAX_LOADED = 4; // modèles gardés en mémoire (≈ 40 Mo chacun)

let proc = null;
let serial = 0;
const pending = new Map();
let loaded = []; // modèles chargés, du plus ancien au plus récent
let idleTimer = null;
let queue = Promise.resolve();

function start() {
  if (proc) return proc;
  proc = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
    serviceName: 'Custom Nav – traduction',
    stdio: 'ignore',
  });
  proc.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error !== undefined) p.reject(new Error(error));
    else p.resolve(result);
  });
  proc.once('exit', () => {
    proc = null;
    loaded = [];
    for (const p of pending.values()) p.reject(new Error('Le moteur de traduction s’est arrêté.'));
    pending.clear();
  });
  return proc;
}

function stop() {
  clearTimeout(idleTimer);
  if (proc) proc.kill();
}

function call(name, ...args) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  const p = start();
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    p.postMessage({ id, name, args });
  });
}

async function ensureLoaded(pair) {
  if (loaded.includes(pair)) {
    loaded = [...loaded.filter((p) => p !== pair), pair];
    return;
  }
  await call('load', { key: pair, ...models.modelFiles(pair) });
  loaded.push(pair);
  while (loaded.length > MAX_LOADED) await call('free', loaded.shift());
}

// Une seule traduction à la fois : le moteur ne travaille que sur un fil,
// et les pages découpent leur travail en petits lots pour ne bloquer personne.
function translate(pairs, texts, html) {
  const job = queue.then(async () => {
    for (const p of pairs) await ensureLoaded(p);
    return call('translate', { keys: pairs, texts, html });
  });
  queue = job.catch(() => {});
  return job;
}

// Retire un modèle de la mémoire (avant suppression de ses fichiers)
async function unload(pair) {
  if (!loaded.includes(pair)) return;
  loaded = loaded.filter((p) => p !== pair);
  if (proc) await call('free', pair).catch(() => {});
}

module.exports = { translate, unload, stop };
