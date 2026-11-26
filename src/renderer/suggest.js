// Affichage de la liste de suggestions. La sélection au clavier est gérée par
// la barre d'adresse (renderer.js) ; ici on dessine et on signale les clics.
//   élément : { kind: 'search' | 'url', text, url?, title?, hint?, icon? }

if (new URLSearchParams(location.search).get('private') === '1') {
  document.documentElement.classList.add('private');
}

const list = document.getElementById('list');

const SEARCH_ICON = 'M10 2a8 8 0 0 1 6.32 12.9l5.4 5.39-1.42 1.42-5.39-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z';
const GLOBE_ICON = 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm6.9 6a8 8 0 0 0-3.6-3.3c.6 1 1 2.1 1.3 3.3h2.3zM12 4c-.8 1.1-1.4 2.5-1.8 4h3.6c-.4-1.5-1-2.9-1.8-4zM4.3 14h2.6a16 16 0 0 1 0-4H4.3a8 8 0 0 0 0 4zm.8 2a8 8 0 0 0 3.6 3.3c-.6-1-1-2.1-1.3-3.3H5.1zm2.3-8c.3-1.2.7-2.3 1.3-3.3A8 8 0 0 0 5.1 8h2.3zM12 20c.8-1.1 1.4-2.5 1.8-4h-3.6c.4 1.5 1 2.9 1.8 4zm2.3-6a14 14 0 0 0 0-4H9.7a14 14 0 0 0 0 4h4.6zm.9 5.3a8 8 0 0 0 3.6-3.3h-2.3c-.3 1.2-.7 2.3-1.3 3.3zm1.9-5.3h2.6a8 8 0 0 0 0-4h-2.6a16 16 0 0 1 0 4z';

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

function faviconFor(url) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
  } catch {
    return '';
  }
}

function iconEl(item) {
  const src = item.icon || (item.kind === 'url' ? faviconFor(item.url) : '');
  const fallback = item.kind === 'url' ? GLOBE_ICON : SEARCH_ICON;
  if (!src) return svgIcon(fallback);
  const img = document.createElement('img');
  img.className = 'icon';
  img.alt = '';
  img.src = src;
  img.onerror = () => img.replaceWith(svgIcon(fallback));
  return img;
}

// Comme Chrome : la partie déjà tapée en normal, le reste en gras
function emphasize(text, typed) {
  const span = document.createElement('span');
  const t = typed.trim().toLowerCase();
  if (t && text.toLowerCase().startsWith(t) && text.length > t.length) {
    const b = document.createElement('b');
    b.textContent = text.slice(t.length);
    span.append(text.slice(0, t.length), b);
  } else {
    span.textContent = text;
  }
  return span;
}

const bare = (url) => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');

function row(item, i, typed) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');
  li.className = `row ${item.kind}`;
  const main = document.createElement('span');
  main.className = 'main';
  const hint = document.createElement('span');
  hint.className = 'hint';
  if (item.kind === 'url') {
    if (item.title) {
      main.textContent = item.title;
      hint.textContent = bare(item.url);
    } else {
      main.append(emphasize(bare(item.url), typed));
    }
    li.title = item.url;
  } else {
    main.append(emphasize(item.text, typed));
  }
  if (item.hint) hint.textContent = (hint.textContent ? hint.textContent + ' · ' : '') + item.hint;
  li.append(iconEl(item), main);
  if (hint.textContent) li.append(' ', hint);
  // mousedown (et pas click) : la barre d'adresse perd le focus juste après
  // et ferme la liste
  li.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (e.button === 0) window.suggest.pick(i, e.ctrlKey || e.metaKey);
    else if (e.button === 1) window.suggest.pick(i, true);
  });
  return li;
}

window.suggest.onRender(({ items, selected, typed }) => {
  list.replaceChildren(...items.map((item, i) => {
    const li = row(item, i, typed);
    if (i === selected) {
      li.classList.add('selected');
      li.setAttribute('aria-selected', 'true');
    }
    return li;
  }));
});
