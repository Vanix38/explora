// Page explora://extensions/ : liste, options, suppression, mises à jour.
const api = window.customNav.extensions;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function setStatus(text, kind = '') {
  $('status').textContent = text || '';
  $('status').className = 'status' + (kind ? ' ' + kind : '');
}

function render(list) {
  if (!list.length) {
    $('list').replaceChildren(el('p', { className: 'empty', textContent: "Aucune extension installée pour l'instant." }));
    return;
  }
  $('list').replaceChildren(...list.map((x) => {
    const icon = el('img', { alt: '', src: x.icon });
    icon.onerror = () => icon.replaceWith(el('span', { className: 'letter-icon', textContent: (x.name || '?')[0] }));

    const info = el('div', {},
      el('div', { className: 'name', textContent: x.name },
        el('span', { className: 'meta', textContent: `v${x.version}` })),
      el('div', { className: 'desc', textContent: x.description }));

    const tools = el('div', { className: 'tools' });
    if (x.optionsUrl) {
      const opt = el('button', { type: 'button', textContent: 'Options' });
      opt.addEventListener('click', () => api.openOptions(x.id));
      tools.append(opt);
    }
    const del = el('button', { type: 'button', className: 'danger', textContent: 'Supprimer' });
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = 'Confirmer ?';
        return;
      }
      del.disabled = true;
      const r = await api.remove(x.id);
      if (r?.error) setStatus(r.error, 'error');
      else setStatus(`« ${x.name} » supprimée.`, 'ok');
      refresh();
    });
    tools.append(del);
    return el('div', { className: 'ext' }, icon, info, tools);
  }));
}

async function refresh() {
  render(await api.list());
}

$('web-store').addEventListener('click', () => api.openWebStore());
$('check-updates').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus('Recherche des mises à jour…');
  const r = await api.checkUpdates();
  setStatus(r?.error || 'Extensions à jour.', r?.error ? 'error' : 'ok');
  e.target.disabled = false;
  refresh();
});

api.onChange(render);
refresh();
