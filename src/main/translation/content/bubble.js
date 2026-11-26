// Bulle affichée près du texte sélectionné avec sa traduction (monde isolé).
//   __cnBubble.open()                         -> place la bulle sous la sélection
//   __cnBubble.update({ title, text, status }) -> status : 'loading' | 'done' | 'error'
//   __cnBubble.close()
(() => {
  if (window.__cnBubble) return true;

  let host = null;
  let els = null;

  const CSS = `
    :host { all: initial; }
    .box {
      position: fixed; z-index: 2147483647; box-sizing: border-box;
      width: max-content; max-width: min(440px, calc(100vw - 16px)); min-width: 220px;
      padding: 10px 12px 10px; border-radius: 10px;
      font: 14px/1.45 "Segoe UI", system-ui, sans-serif;
      color: #1d1e22; background: #ffffff; border: 1px solid #d5d8de;
      box-shadow: 0 6px 24px rgba(0,0,0,.18);
    }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
      font-size: 12px; color: #5f626c; }
    .title { flex: 1; }
    button { font: inherit; font-size: 12px; cursor: pointer; border: none; border-radius: 6px;
      padding: 3px 8px; color: inherit; background: transparent; }
    button:hover { background: #eceef2; }
    .close { padding: 0 6px; font-size: 16px; line-height: 20px; }
    .text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50vh; overflow: auto; user-select: text; }
    .loading .text { color: #5f626c; font-style: italic; }
    .error .text { color: #c43c3c; }
    .foot { display: flex; justify-content: flex-end; margin-top: 6px; }
    .loading .foot, .error .foot { display: none; }
    @media (prefers-color-scheme: dark) {
      .box { color: #e6e7eb; background: #2a2c33; border-color: #4a4d57; }
      .head, .loading .text { color: #9a9ca5; }
      button:hover { background: #3a3d46; }
      .error .text { color: #ff7b7b; }
    }
  `;

  function anchorRect() {
    const a = document.activeElement;
    if (a && (a.localName === 'textarea' || a.localName === 'input')) return a.getBoundingClientRect();
    const sel = getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    return { left: innerWidth / 2 - 150, right: innerWidth / 2 + 150, top: 80, bottom: 80 };
  }

  function place(rect) {
    const box = els.box;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let left = Math.min(Math.max(8, rect.left), innerWidth - w - 8);
    let top = rect.bottom + 8;
    if (top + h > innerHeight - 8 && rect.top - h - 8 > 8) top = rect.top - h - 8;
    box.style.left = `${Math.max(8, left)}px`;
    box.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function onDown(e) {
    if (host && !e.composedPath().includes(host)) close();
  }

  function open() {
    close();
    host = document.createElement('div');
    host.id = 'cn-translate-bubble';
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    const box = document.createElement('div');
    box.className = 'box loading';
    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('span');
    title.className = 'title';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.title = 'Fermer (Échap)';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', close);
    head.append(title, closeBtn);
    const text = document.createElement('div');
    text.className = 'text';
    const foot = document.createElement('div');
    foot.className = 'foot';
    const copy = document.createElement('button');
    copy.textContent = 'Copier';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text.textContent);
        copy.textContent = 'Copié ✓';
      } catch {
        // sélectionne le texte pour Ctrl+C
        const range = document.createRange();
        range.selectNodeContents(text);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    });
    foot.append(copy);
    box.append(head, text, foot);
    shadow.append(box);
    els = { box, title, text, rect: anchorRect() };
    document.documentElement.append(host);
    place(els.rect);
    addEventListener('keydown', onKey, true);
    addEventListener('mousedown', onDown, true);
    return true;
  }

  function update({ title, text, status }) {
    if (!els) return false;
    els.box.className = `box ${status || 'done'}`;
    if (title != null) els.title.textContent = title;
    if (text != null) els.text.textContent = text;
    place(els.rect);
    return true;
  }

  function close() {
    if (host) host.remove();
    host = null;
    els = null;
    removeEventListener('keydown', onKey, true);
    removeEventListener('mousedown', onDown, true);
    return true;
  }

  window.__cnBubble = { open, update, close, isOpen: () => !!host };
  return true;
})();
