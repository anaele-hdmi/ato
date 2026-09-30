#!/usr/bin/env node
// Pre-conversion of the NASA Black Marble night-lights image into the small
// single-channel runtime texture src/assets/city-lights.webp. Run by hand (not
// part of `vite build`); the output is committed, the source image is not.
//
//   npm i --no-save sharp
//   node scripts/build-city-lights.mjs [--src <BlackMarble_2016_01deg.jpg>] [--out src/assets/city-lights.webp]
//
// Source (public domain, NASA Earth Observatory / NASA GSFC, Suomi NPP VIIRS):
//   https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg
//   (3600 x 1800, equirectangular, -180..180 / 90..-90)
// Output: 2048 x 1024, 8-bit luminance, lossy WebP. The runtime applies its own
// curve (palette.ts CITY_LIGHTS), so the source tone is kept as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const URL_SRC = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg';
const src = path.resolve(opt('--src', path.join(os.tmpdir(), 'BlackMarble_2016_01deg.jpg')));
const out = path.resolve(root, opt('--out', 'src/assets/city-lights.webp'));
const W = 2048;
const H = 1024;

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    const dir = process.env.SHARP_DIR;
    if (dir) return createRequire(path.join(dir, 'x.js'))('sharp');
    throw new Error('sharp is required: run `npm i --no-save sharp` (or set SHARP_DIR)');
  }
}
const sharp = await loadSharp();

if (!fs.existsSync(src)) {
  const res = await fetch(URL_SRC);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
}
// The source carries a faint bluish land/ice shading behind the lights; lights
// are warm (R >= B). Keep only what is redder than blue, as one channel.
const rgb = await sharp(src).removeAlpha().resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
const lum = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  const r = rgb[i * 3];
  const b = rgb[i * 3 + 2];
  lum[i] = Math.max(0, Math.min(255, Math.round(r - 1.5 * Math.max(0, b - r))));
}
const buf = await sharp(lum, { raw: { width: W, height: H, channels: 1 } })
  .webp({ quality: 82, effort: 6, smartSubsample: false })
  .toBuffer();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log(`${path.relative(root, out)}: ${buf.length} bytes`);
