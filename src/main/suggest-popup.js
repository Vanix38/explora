// Liste de suggestions sous la barre d'adresse.
//
// Les pages (WebContentsView) sont dessinées par-dessus l'interface : une liste
// déroulante HTML de l'interface serait cachée par la page. La liste est donc
// une petite vue à part, posée au-dessus de tout le reste pendant la frappe.
// Le clavier reste dans la barre d'adresse (l'interface gère la sélection) :
// cette vue ne fait qu'afficher la liste et signaler les clics.
const path = require('path');
const { WebContentsView } = require('electron');

// Doivent correspondre à src/renderer/suggest.css
const ROW_HEIGHT = 34;
const LIST_PADDING = 6; // en haut et en bas de la liste
const BORDER = 1;
const SIDE_MARGIN = 10; // place pour l'ombre, à gauche et à droite
const BOTTOM_MARGIN = 14; // place pour l'ombre, en bas
const MAX_ROWS = 12;

class SuggestPopup {
  constructor(win, { isPrivate = false } = {}) {
    this.win = win;
    this.visible = false;
    this.pending = null; // affichage demandé avant la fin du chargement
    this.ready = false;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'suggest-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.view.setBackgroundColor('#00000000');
    const wc = this.view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.loadFile(path.join(__dirname, '..', 'renderer', 'suggest.html'), {
      query: isPrivate ? { private: '1' } : {},
    });
    wc.once('did-finish-load', () => {
      this.ready = true;
      if (this.pending) this.show(this.pending);
    });
  }

  get webContents() {
    return this.view.webContents;
  }

  // data : { rect: { x, y, width }, items: [...], selected, typed }
  show(data) {
    if (this.win.isDestroyed()) return;
    const items = Array.isArray(data?.items) ? data.items.slice(0, MAX_ROWS) : [];
    const r = data?.rect || {};
    if (!items.length || ![r.x, r.y, r.width].every(Number.isFinite)) {
      this.hide();
      return;
    }
    if (!this.ready) {
      this.pending = data;
      return;
    }
    this.pending = null;
    const [winWidth] = this.win.getContentSize();
    const x = Math.max(0, Math.round(r.x - SIDE_MARGIN));
    const width = Math.min(Math.round(r.width + 2 * SIDE_MARGIN), winWidth - x);
    const height = items.length * ROW_HEIGHT + 2 * (LIST_PADDING + BORDER) + BOTTOM_MARGIN;
    this.view.setBounds({ x, y: Math.round(r.y), width, height });
    this.webContents.send('suggest:render', {
      items,
      selected: Number.isInteger(data.selected) ? data.selected : -1,
      typed: String(data.typed || ''),
    });
    // ajoutée (ou remise) au-dessus des pages et de la barre latérale
    this.win.contentView.addChildView(this.view);
    this.visible = true;
  }

  hide() {
    this.pending = null;
    if (!this.visible || this.win.isDestroyed()) return;
    this.win.contentView.removeChildView(this.view);
    this.visible = false;
  }

  destroy() {
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }
}

module.exports = { SuggestPopup };
