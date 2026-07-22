const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const DESKTOP_ICON_SVG = path.join(__dirname, '..', '..', 'desktop', 'assets', 'icon.svg');
const FOREGROUND_SVG = path.join(__dirname, '..', 'assets', 'icon-foreground.svg');
const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// legacy launcher icon (pre-API26 fallback) — размеры по плотности экрана
const LEGACY_SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

// adaptive icon foreground — холст 108dp, safe zone ~66dp в центре
const FOREGROUND_SIZES = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432
};

async function main() {
  const legacySvg = fs.readFileSync(DESKTOP_ICON_SVG);
  const fgSvg = fs.readFileSync(FOREGROUND_SVG);

  for (const [dir, size] of Object.entries(LEGACY_SIZES)) {
    const outDir = path.join(RES_DIR, dir);
    fs.mkdirSync(outDir, { recursive: true });
    const buf = await sharp(legacySvg, { density: 384 }).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), buf);
    fs.writeFileSync(path.join(outDir, 'ic_launcher_round.png'), buf);
    console.log('wrote', dir, 'ic_launcher(.round).png', size);
  }

  for (const [dir, canvasSize] of Object.entries(FOREGROUND_SIZES)) {
    const outDir = path.join(RES_DIR, dir);
    fs.mkdirSync(outDir, { recursive: true });
    // "М" рисуем на прозрачном холсте размером с canvasSize, сама буква — ~60% от холста,
    // чтобы уместиться в safe zone адаптивной иконки и не обрезаться маской ОС.
    const glyphSize = Math.round(canvasSize * 0.6);
    const glyph = await sharp(fgSvg, { density: 384 }).resize(glyphSize, glyphSize).png().toBuffer();
    const canvas = await sharp({
      create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([{ input: glyph, gravity: 'center' }])
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(outDir, 'ic_launcher_foreground.png'), canvas);
    console.log('wrote', dir, 'ic_launcher_foreground.png', canvasSize);
  }

  // Цвет фона адаптивной иконки — фирменный зелёный вместо дефолтного белого
  const bgColorPath = path.join(RES_DIR, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(
    bgColorPath,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1A472A</color>\n</resources>\n`
  );
  console.log('wrote', bgColorPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
