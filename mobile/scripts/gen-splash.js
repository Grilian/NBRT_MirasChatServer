const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const ICON_SVG = path.join(__dirname, '..', '..', 'desktop', 'assets', 'icon.svg');
const BG_COLOR = { r: 0x10, g: 0x1d, b: 0x17, alpha: 1 }; // var(--paper) в тёмной теме

async function main() {
  const iconSvg = fs.readFileSync(ICON_SVG);
  const dirs = fs.readdirSync(RES_DIR).filter((d) => d.startsWith('drawable') && fs.existsSync(path.join(RES_DIR, d, 'splash.png')));

  for (const dir of dirs) {
    const filePath = path.join(RES_DIR, dir, 'splash.png');
    const meta = await sharp(filePath).metadata();
    const { width, height } = meta;
    const iconSize = Math.round(Math.min(width, height) * 0.32);

    const icon = await sharp(iconSvg, { density: 384 }).resize(iconSize, iconSize).png().toBuffer();

    const canvas = await sharp({
      create: { width, height, channels: 4, background: BG_COLOR }
    })
      .composite([{ input: icon, gravity: 'center' }])
      .png()
      .toBuffer();

    fs.writeFileSync(filePath, canvas);
    console.log('wrote', dir + '/splash.png', width + 'x' + height);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
