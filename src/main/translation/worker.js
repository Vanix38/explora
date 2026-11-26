// Processus de traduction (utilityProcess d'Electron) : fait tourner le moteur
// Bergamot (celui de Firefox Translations, compilé en WebAssembly) entièrement
// sur le PC. Aucun texte ne quitte la machine.
//
// Protocole : { id, name, args } -> { id, result } ou { id, error }.
//   load({ key, files: { model, lex, vocabs[] }, precision })
//   translate({ keys: [key] | [key1, key2] (pivot), texts: [string], html })
//   free(key)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WASM_DIR = path.dirname(require.resolve('@browsermt/bergamot-translator/worker/bergamot-translator-worker.js'));

// Port de communication : utilityProcess (Electron) ou worker_threads (tests)
const port = process.parentPort || require('worker_threads').parentPort;
const onMessage = (cb) => port.on('message', (e) => cb(process.parentPort ? e.data : e));

// Correspondance attendue par bergamot entre ses fonctions int8 et celles
// incluses dans le binaire (pas de version native hors de Firefox)
const GEMM_FALLBACK = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
};

function loadModule() {
  return new Promise((resolve, reject) => {
    const wasm = fs.readFileSync(path.join(WASM_DIR, 'bergamot-translator-worker.wasm'));
    const Module = {
      print: () => {},
      printErr: () => {},
      instantiateWasm(info, accept) {
        const gemm = Object.fromEntries(Object.entries(GEMM_FALLBACK)
          .map(([k, name]) => [k, (...a) => Module.asm[name](...a)]));
        WebAssembly.instantiate(wasm, { ...info, wasm_gemm: gemm })
          .then(({ instance }) => accept(instance))
          .catch(reject);
        return {};
      },
      onRuntimeInitialized: () => resolve(Module),
    };
    globalThis.Module = Module;
    const code = fs.readFileSync(path.join(WASM_DIR, 'bergamot-translator-worker.js'), 'utf8');
    vm.runInThisContext(code, { filename: 'bergamot-translator-worker.js' });
  });
}

let modulePromise = null;
let service = null;
const models = new Map(); // key -> TranslationModel

async function ready() {
  if (!modulePromise) modulePromise = loadModule();
  const Module = await modulePromise;
  if (!service) service = new Module.BlockingService({ cacheSize: 1 << 13 });
  return Module;
}

function aligned(Module, file, alignment) {
  const bytes = fs.readFileSync(file);
  const mem = new Module.AlignedMemory(bytes.byteLength, alignment);
  mem.getByteArrayView().set(bytes);
  return mem;
}

// Configuration Marian (même valeurs que le moteur de Firefox)
function modelConfig(precision) {
  return [
    'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'cpu-threads: 0',
    `gemm-precision: ${precision || 'int8shiftAlphaAll'}`, 'skip-cost: true',
    'alignment: soft', 'quiet: true', 'quiet-translation: true',
    'max-length-break: 128', 'mini-batch-words: 1024', 'workspace: 128', 'max-length-factor: 2.0',
  ].join('\n') + '\n';
}

const api = {
  async load({ key, files, precision }) {
    const Module = await ready();
    if (models.has(key)) return true;
    const vocabs = new Module.AlignedMemoryList();
    for (const v of [...new Set(files.vocabs)]) vocabs.push_back(aligned(Module, v, 64));
    const model = new Module.TranslationModel(
      modelConfig(precision),
      aligned(Module, files.model, 256),
      aligned(Module, files.lex, 64),
      vocabs,
      null,
    );
    models.set(key, model);
    return true;
  },

  free(key) {
    const m = models.get(key);
    if (m) {
      models.delete(key);
      m.delete();
    }
    return true;
  },

  loaded() {
    return [...models.keys()];
  },

  async translate({ keys, texts, html }) {
    const Module = await ready();
    const chain = keys.map((k) => {
      const m = models.get(k);
      if (!m) throw new Error(`Modèle non chargé : ${k}`);
      return m;
    });
    const input = new Module.VectorString();
    const options = new Module.VectorResponseOptions();
    for (const t of texts) {
      input.push_back(String(t));
      options.push_back({ qualityScores: false, alignment: false, html: !!html });
    }
    const responses = chain.length > 1
      ? service.translateViaPivoting(chain[0], chain[1], input, options)
      : service.translate(chain[0], input, options);
    const out = texts.map((_, i) => responses.get(i).getTranslatedText());
    input.delete();
    options.delete();
    responses.delete();
    return out;
  },
};

onMessage(async ({ id, name, args = [] }) => {
  try {
    if (typeof api[name] !== 'function') throw new Error(`Action inconnue : ${name}`);
    const result = await api[name](...args);
    port.postMessage({ id, result });
  } catch (err) {
    port.postMessage({ id, error: String(err?.message || err) });
  }
});
