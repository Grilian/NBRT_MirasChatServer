const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const toIco = require('to-ico');

const ASSETS = path.join(__dirname, '..', 'assets');
const SVG_PATH = path.join(ASSETS, 'icon.svg');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [512, 256, 128];

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  for (const size of PNG_SIZES) {
    const out = path.join(ASSETS, size === 512 ? 'icon.png' : `icon-${size}.png`);
    await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
    console.log('wrote', out);
  }

  const icoBuffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()
    )
  );
  const ico = await toIco(icoBuffers);
  const icoPath = path.join(ASSETS, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log('wrote', icoPath);

  // Small tray icon (Windows tray looks best around 32px, @2x for hidpi)
  await sharp(svg, { density: 384 }).resize(32, 32).png().toFile(path.join(ASSETS, 'tray.png'));
  await sharp(svg, { density: 384 }).resize(64, 64).png().toFile(path.join(ASSETS, 'tray@2x.png'));
  console.log('wrote tray icons');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
