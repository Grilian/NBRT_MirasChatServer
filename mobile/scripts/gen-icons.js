const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const FOREGROUND_SVG = path.join(__dirname, '..', 'assets', 'icon-foreground.svg');
const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const LEGACY_SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

const FOREGROUND_SIZES = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432
};

async function main() {
  const fgSvg = fs.readFileSync(FOREGROUND_SVG);

  // Генерация прозрачного foreground
  for (const [dir, canvasSize] of Object.entries(FOREGROUND_SIZES)) {
    const outDir = path.join(RES_DIR, dir);
    fs.mkdirSync(outDir, { recursive: true });

    const glyphSize = Math.round(canvasSize * 0.7);

    const glyph = await sharp(fgSvg, { density: 384 })
      .resize(glyphSize, glyphSize)
      .png()
      .toBuffer();

    const canvas = await sharp({
      create: {
        width: canvasSize,
        height: canvasSize,
        channels: 4,
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0
        }
      }
    })
      .composite([
        {
          input: glyph,
          gravity: 'center'
        }
      ])
      .png()
      .toBuffer();

    fs.writeFileSync(
      path.join(outDir, 'ic_launcher_foreground.png'),
      canvas
    );
  }

  // Прозрачный фон adaptive icon
  const bgPath = path.join(
    RES_DIR,
    'values',
    'ic_launcher_background.xml'
  );

  fs.writeFileSync(
    bgPath,
`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#00000000</color>
</resources>`
  );

  console.log('Icons generated with transparent background');
}

main().catch(console.error);