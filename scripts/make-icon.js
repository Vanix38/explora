// Génère build/icon.ico (multi-tailles) et build/icon.png à partir du logo
// assets/brand/icon-source.png (logo-fond-clair.png recadré dans un carré transparent).
// Usage : npm run icon
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const dir = path.join(__dirname, '..', 'build');
const SOURCE = path.join(__dirname, '..', 'assets', 'brand', 'icon-source.png');

// Image maître de 512 px, réduite ensuite pour chaque taille
function renderMaster() {
  const img = nativeImage.createFromPath(SOURCE);
  if (img.isEmpty()) throw new Error(`Logo introuvable : ${SOURCE}`);
  return img.resize({ width: 512, height: 512, quality: 'best' });
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
  const master = renderMaster();
  const pngs = SIZES.map((size) => ({ size, data: master.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(dir, 'icon.ico'), buildIco(pngs));
  fs.writeFileSync(path.join(dir, 'icon.png'), master.toPNG());
  console.log('icon.ico et icon.png générés');
  app.quit();
});
