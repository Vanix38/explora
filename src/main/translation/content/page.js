// Script injecté dans la page (monde isolé : invisible pour le site) pour la
// traduire sur place. Le processus principal appelle :
//   __cnTranslate.collect(maxChars) -> { blocks: [{ id, html }], remaining }
//   __cnTranslate.apply([{ id, html }])
//   __cnTranslate.restore()          -> remet le texte d'origine
//
// La page est découpée en « blocs » (paragraphes, titres, cellules…). Chaque
// bloc est envoyé en HTML simplifié : ses éléments en ligne (liens, gras…)
// deviennent <span id="cnN">, ses sous-blocs et le code des <span id="cnN"></span>
// vides. Après traduction, les vrais éléments sont remis à leur nouvelle place :
// les liens gardent leur adresse et leurs écouteurs d'événements.
(() => {
  if (window.__cnTranslate) return true;

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'code', 'pre', 'textarea', 'input', 'select',
    'option', 'svg', 'math', 'iframe', 'canvas', 'video', 'audio', 'object', 'embed', 'kbd', 'samp', 'var',
    'head', 'title']);
  const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i',
    'ins', 'label', 'mark', 'nobr', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u']);
  const VOID = new Set(['br', 'img', 'wbr', 'input']);
  const LETTER = /\p{L}/u;

  const entries = new Map(); // id -> { root, nodes, kids }
  const rootEntry = new WeakMap(); // bloc -> entrée (traduit ou en cours)
  let nextId = 1;
  let active = true;
  let dirty = true;
  let queue = [];

  function skipped(el) {
    return SKIP.has(el.localName) || el.translate === false || el.classList.contains('notranslate')
      || el.isContentEditable || el.id === 'cn-translate-bubble';
  }

  // Élément en ligne : balise de texte (ou élément personnalisé) affichée en ligne
  function isInline(el) {
    const tag = el.localName;
    if (!INLINE.has(tag) && !tag.includes('-')) return false;
    const d = getComputedStyle(el).display;
    return d === 'inline' || d === 'contents';
  }

  // Bloc dans lequel un texte placé directement dans `el` serait traduit,
  // ou false si ce texte ne doit pas être traduit (code, champ de saisie…)
  function blockOf(el, cache) {
    if (!el) return false;
    if (cache.has(el)) return cache.get(el);
    let r;
    if (skipped(el)) r = false;
    else if (el === document.body) r = el;
    else {
      const up = blockOf(el.parentElement, cache);
      r = up === false ? false : isInline(el) ? up : el;
    }
    cache.set(el, r);
    return r;
  }

  function scan() {
    const roots = new Set();
    const cache = new Map();
    if (!document.body) return [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!LETTER.test(t.data)) continue;
      const root = blockOf(t.parentElement, cache);
      if (root && !rootEntry.has(root)) roots.add(root);
    }
    return [...roots];
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function serialize(root) {
    const nodes = [];
    const kids = new Map();
    const ws = getComputedStyle(root).whiteSpace;
    const collapse = !ws.startsWith('pre') && ws !== 'break-spaces';
    const walk = (el) => {
      kids.set(el, [...el.childNodes]);
      let s = '';
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          s += esc(collapse ? n.data.replace(/\s+/g, ' ') : n.data);
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const i = nodes.push(n) - 1;
          if (VOID.has(n.localName)) s += n.localName === 'br' ? `<br id="cn${i}">` : `<img id="cn${i}">`;
          else if (!skipped(n) && isInline(n)) s += `<span id="cn${i}">${walk(n)}</span>`;
          else s += `<span id="cn${i}"></span>`;
        }
      }
      return s;
    };
    const html = walk(root).trim();
    // espaces autour de chaque élément dans l'original (voir spacing())
    const gaps = new Map();
    const blank = (t, re) => t?.nodeType === Node.TEXT_NODE && re.test(t.data);
    for (const n of nodes) {
      gaps.set(n, { before: blank(n.previousSibling, /\s$/), after: blank(n.nextSibling, /^\s/) });
    }
    return { root, nodes, kids, gaps, html };
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > -200 && r.top < innerHeight + 400 && r.width > 0;
  }

  // Lot suivant de blocs à traduire (ceux visibles à l'écran d'abord)
  function collect(maxChars = 3000) {
    if (!active) return { blocks: [], remaining: 0 };
    if (dirty) {
      dirty = false;
      const known = new Set(queue);
      queue.push(...scan().filter((r) => !known.has(r)));
    }
    queue = queue.filter((r) => r.isConnected && !rootEntry.has(r));
    const visible = [];
    const rest = [];
    for (const r of queue) (inViewport(r) ? visible : rest).push(r);
    queue = [...visible, ...rest];
    const blocks = [];
    let chars = 0;
    while (queue.length && (chars < maxChars || blocks.length === 0)) {
      const root = queue.shift();
      const entry = serialize(root);
      if (!LETTER.test(entry.html.replace(/<[^>]*>/g, ''))) continue;
      const id = nextId++;
      entries.set(id, entry);
      rootEntry.set(root, entry);
      blocks.push({ id, html: entry.html });
      chars += entry.html.length;
    }
    return { blocks, remaining: queue.length };
  }

  function rebuild(entry, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const used = new Set();
    const build = (parent) => {
      const out = [];
      for (const n of parent.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          out.push(document.createTextNode(n.data));
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const m = /^cn(\d+)$/.exec(n.id || '');
          const orig = m ? entry.nodes[Number(m[1])] : null;
          if (!orig) {
            out.push(...build(n));
          } else if (entry.kids.has(orig)) {
            // élément en ligne : on garde le vrai élément, avec le texte traduit dedans
            const el = used.has(orig) ? orig.cloneNode(false) : orig;
            used.add(orig);
            el.replaceChildren(...build(n));
            out.push(el);
          } else if (!used.has(orig)) {
            used.add(orig);
            out.push(orig);
          }
        }
      }
      return spacing(out);
    };
    // La traduction colle parfois un élément au mot voisin (« un <code>f()</code>fichier ») :
    // on remet les espaces qu'il y avait autour de lui dans l'original.
    const spacing = (out) => {
      out.forEach((n, i) => {
        const g = entry.gaps.get(n);
        if (!g) return;
        const prev = out[i - 1];
        const next = out[i + 1];
        if (g.before && prev?.nodeType === Node.TEXT_NODE && /\S$/.test(prev.data)) prev.data += ' ';
        if (g.after && next?.nodeType === Node.TEXT_NODE && /^\S/.test(next.data) && !/^[.,;:!?)\]»]/.test(next.data)) next.data = ' ' + next.data;
      });
      return out;
    };
    const result = build(tpl.content);
    // rien ne doit disparaître : un sous-bloc ou une image oubliés par la traduction sont remis à la fin
    for (const n of entry.nodes) {
      if (!used.has(n) && !entry.kids.has(n) && n.localName !== 'br' && n.localName !== 'wbr') result.push(n);
    }
    entry.root.replaceChildren(...result);
  }

  function apply(results) {
    for (const { id, html } of results) {
      const entry = entries.get(id);
      if (!entry || !active || !entry.root.isConnected) continue;
      if (typeof html === 'string') {
        try {
          rebuild(entry, html);
        } catch {
          // bloc laissé tel quel
        }
      }
    }
    observer.takeRecords(); // nos propres modifications ne comptent pas
    return true;
  }

  function restore() {
    active = false;
    for (const entry of entries.values()) {
      for (const [el, list] of entry.kids) el.replaceChildren(...list);
    }
    observer.takeRecords();
    observer.disconnect();
    delete window.__cnTranslate;
    return true;
  }

  // Contenu ajouté par le site après coup (défilement infini, menus…)
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && r.addedNodes.length === 0) continue;
      dirty = true;
      // un bloc déjà traduit modifié par le site sera retraduit
      for (let el = r.target.nodeType === 1 ? r.target : r.target.parentElement; el; el = el.parentElement) {
        const entry = rootEntry.get(el);
        if (entry && entry.root === el) {
          rootEntry.delete(el);
          break;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__cnTranslate = {
    collect,
    apply,
    restore,
    isDirty: () => dirty,
  };
  return true;
})();
