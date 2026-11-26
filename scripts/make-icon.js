// Génère build/icon.ico (multi-tailles) et build/icon.png à partir du logo vectoriel
// assets/brand/logo-fond-clair.svg, centré dans un carré transparent.
// Usage : npm run icon
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const MASTER = 512;
const MARGIN = 0.03; // marge autour du logo, en fraction du côté
const dir = path.join(__dirname, '..', 'build');
const SOURCE = path.join(__dirname, '..', 'assets', 'brand', 'logo-fond-clair.svg');

// Dessine le SVG dans un canvas (taille exacte, indépendante de l'échelle d'affichage)
async function renderMaster() {
  const svg = fs.readFileSync(SOURCE, 'utf8');
  const [, , vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = ${MASTER}, inner = S * (1 - 2 * ${MARGIN});
      const k = Math.min(inner / ${vw}, inner / ${vh});
      const w = ${vw} * k, h = ${vh} * k;
      const c = document.createElement('canvas'); c.width = c.height = S;
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG illisible'));
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`);
  win.destroy();
  return nativeImage.createFromDataURL(dataUrl);
}

// ICO dont chaque image est un PNG (format accepté depuis Windows Vista)
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const master = await renderMaster();
  const pngs = SIZES.map((size) => ({ size, data: master.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(dir, 'icon.ico'), buildIco(pngs));
  fs.writeFileSync(path.join(dir, 'icon.png'), master.toPNG());
  console.log('icon.ico et icon.png générés');
  app.quit();
});
