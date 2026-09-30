#!/usr/bin/env node
// Pre-conversion of public elevation data into the lightweight runtime assets
// in src/assets/dem/. Run by hand (not part of `vite build`); the generated
// files are committed, the source data is not.
//
//   npm i --no-save sharp          # encoder only needed for this script
//   node scripts/build-dem.mjs [--cache <dir>] [--out src/assets/dem]
//
// (behind a proxy on node >= 22.21: NODE_USE_ENV_PROXY=1)
//
// Sources (both public domain):
//   * NOAA NCEI ETOPO 2022, 60 arc-second global relief model, ice-surface
//     version (land topography + ocean bathymetry), via the NCEI THREDDS
//     OPeNDAP service. DOI 10.25921/fd45-gt74.
//   * Natural Earth 1:50m lakes (naturalearthdata.com), for the lake mask.
//
// Outputs:
//   elev_<col>_<row>.webp  land elevation, 6 x 3 tiles of 60 deg, 1200 px each
//                          (0.05 deg = 5.6 km at the equator), 8-bit, lossy
//                          WebP. code = 255 * sqrt(metres / ELEV_CAP_M): fine
//                          steps on the plains, coarse on the peaks.
//   bath.webp              3600 x 1800 (0.1 deg) lossless RGB: R = shallow-sea
//                          depth code (255 * sqrt(depth / BATH_CAP_M); land
//                          pixels filled from the nearest sea), G = lake mask.
//   meta.json              constants shared with src/render/terrain.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadReduced } from './lib/etopo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const cacheDir = path.resolve(opt('--cache', path.join(os.tmpdir(), 'teikido-dem-cache')));
const outDir = path.resolve(root, opt('--out', 'src/assets/dem'));

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    const dir = process.env.SHARP_DIR;
    if (dir) return createRequire(path.join(dir, 'x.js'))('sharp');
    throw new Error('sharp is required for encoding: run `npm i --no-save sharp` (or set SHARP_DIR)');
  }
}
const sharp = await loadSharp();

// --- constants (mirrored in meta.json) --------------------------------------
const FACTOR = 3; // 1 arc-minute source -> 3 arc-minutes = 0.05 deg
const TILE_COLS = 6;
const TILE_ROWS = 3;
const ELEV_CAP_M = 8000;
const ELEV_QUALITY = 88;
const BATH_W = 3600;
const BATH_H = 1800;
const BATH_CAP_M = 400;
const LAKES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson';

fs.mkdirSync(outDir, { recursive: true });
console.log('reading ETOPO 2022 (cached in ' + cacheDir + ')');
const { width: W, height: H, elev, depth } = await loadReduced(FACTOR, cacheDir);

async function fetchLakes() {
  const cache = path.join(cacheDir, 'ne_50m_lakes.geojson');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const res = await fetch(LAKES_URL);
  if (!res.ok) throw new Error('lakes: HTTP ' + res.status);
  const text = await res.text();
  fs.writeFileSync(cache, text);
  return JSON.parse(text);
}

/** Even-odd polygon fill with 4 sub-scanlines and exact horizontal coverage. */
function rasterizeLakes(geo, w, h) {
  const SUB = 4;
  const cov = new Float32Array(w * h);
  const rings = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) for (const ring of poly) rings.push(ring);
  }
  const px = (lon) => ((lon + 180) / 360) * w;
  const py = (lat) => ((90 - lat) / 180) * h;
  // bucket edges by sub-scanline
  const rows = h * SUB;
  const buckets = Array.from({ length: rows }, () => []);
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      let [x0, y0] = [px(ring[i][0]), py(ring[i][1]) * SUB];
      let [x1, y1] = [px(ring[i + 1][0]), py(ring[i + 1][1]) * SUB];
      if (y0 === y1) continue;
      if (y0 > y1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
      const s0 = Math.max(0, Math.ceil(y0 - 0.5));
      const s1 = Math.min(rows - 1, Math.ceil(y1 - 0.5) - 1);
      for (let s = s0; s <= s1; s++) {
        const t = (s + 0.5 - y0) / (y1 - y0);
        buckets[s].push(x0 + (x1 - x0) * t);
      }
    }
  }
  for (let s = 0; s < rows; s++) {
    const xs = buckets[s].sort((a, b) => a - b);
    const row = Math.floor(s / SUB) * w;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, xs[i]);
      const b = Math.min(w, xs[i + 1]);
      if (b <= a) continue;
      const xa = Math.floor(a);
      const xb = Math.floor(b);
      if (xa === xb) cov[row + xa] += (b - a) / SUB;
      else {
        cov[row + xa] += (xa + 1 - a) / SUB;
        for (let x = xa + 1; x < xb; x++) cov[row + x] += 1 / SUB;
        if (xb < w) cov[row + xb] += (b - xb) / SUB;
      }
    }
  }
  return cov;
}
// --- lakes: flatten the DEM under them ---------------------------------------
// ETOPO stores the bed of some lakes (Baikal, Superior...) below sea level,
// which would carve pits into the terrain. Under every Natural Earth lake the
// elevation is replaced by the lowest surrounding shore height, propagated
// inward (a flat lake surface at roughly its outlet level).
console.log('rasterizing Natural Earth 50m lakes');
const lakeHi = rasterizeLakes(await fetchLakes(), W, H);
{
  const known = new Uint8Array(W * H);
  const pending = [];
  for (let i = 0; i < W * H; i++) {
    if (lakeHi[i] > 0.5) pending.push(i);
    else known[i] = 1;
  }
  let todo = pending;
  for (let pass = 0; pass < 400 && todo.length; pass++) {
    const nextKnown = [];
    const vals = [];
    const rest = [];
    for (const i of todo) {
      const x = i % W;
      const y = (i - x) / W;
      let m = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const j = yy * W + ((x + dx + W) % W);
          if (known[j] && elev[j] < m) m = elev[j];
        }
      }
      if (m < Infinity) {
        nextKnown.push(i);
        vals.push(m);
      } else rest.push(i);
    }
    for (let k = 0; k < nextKnown.length; k++) {
      elev[nextKnown[k]] = vals[k];
      known[nextKnown[k]] = 1;
    }
    todo = rest;
  }
}

// --- elevation tiles ---------------------------------------------------------
const tw = W / TILE_COLS;
const th = H / TILE_ROWS;
const codes = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) codes[i] = Math.min(255, Math.round(255 * Math.sqrt(elev[i] / ELEV_CAP_M)));
let totalBytes = 0;
let sumSq = 0;
let maxErrM = 0;
for (let r = 0; r < TILE_ROWS; r++) {
  for (let c = 0; c < TILE_COLS; c++) {
    const tile = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) tile.set(codes.subarray((r * th + y) * W + c * tw, (r * th + y) * W + (c + 1) * tw), y * tw);
    const file = path.join(outDir, `elev_${c}_${r}.webp`);
    await sharp(tile, { raw: { width: tw, height: th, channels: 1 } })
      .webp({ quality: ELEV_QUALITY, effort: 6, smartSubsample: false })
      .toFile(file);
    totalBytes += fs.statSync(file).size;
    // round-trip error in metres
    const back = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const ch = back.info.channels;
    for (let i = 0; i < tw * th; i++) {
      const m0 = ELEV_CAP_M * (tile[i] / 255) ** 2;
      const m1 = ELEV_CAP_M * (back.data[i * ch] / 255) ** 2;
      const e = m1 - m0;
      sumSq += e * e;
      if (Math.abs(e) > maxErrM) maxErrM = Math.abs(e);
    }
  }
}
console.log(
  `elevation tiles: ${(totalBytes / 1e6).toFixed(2)} MB total, q=${ELEV_QUALITY}, ` +
    `round-trip rms ${Math.sqrt(sumSq / (W * H)).toFixed(1)} m, max ${maxErrM.toFixed(0)} m`,
);

// --- bathymetry + lakes ------------------------------------------------------
// Box-reduce 7200x3600 -> 3600x1800.
const k = W / BATH_W;
const bathDepth = new Float32Array(BATH_W * BATH_H);
const isSea = new Uint8Array(BATH_W * BATH_H);
for (let y = 0; y < BATH_H; y++) {
  for (let x = 0; x < BATH_W; x++) {
    let d = 0;
    let e = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const i = (y * k + dy) * W + x * k + dx;
      d += depth[i];
      e += elev[i];
    }
    const n = k * k;
    bathDepth[y * BATH_W + x] = d / n;
    // a pixel is "sea" when the ocean part outweighs the land part
    isSea[y * BATH_W + x] = d > e ? 1 : 0;
  }
}
// Fill land pixels from neighbouring sea pixels (so the bilinear lookup at a
// coast does not blend toward "depth 0" and paint a false shallow ring).
{
  let known = isSea.slice();
  for (let pass = 0; pass < 6; pass++) {
    const next = known.slice();
    const vals = bathDepth.slice();
    for (let y = 0; y < BATH_H; y++) {
      for (let x = 0; x < BATH_W; x++) {
        const i = y * BATH_W + x;
        if (known[i]) continue;
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= BATH_H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = (x + dx + BATH_W) % BATH_W;
            const j = yy * BATH_W + xx;
            if (known[j]) {
              s += bathDepth[j];
              n++;
            }
          }
        }
        if (n) {
          vals[i] = s / n;
          next[i] = 1;
        }
      }
    }
    bathDepth.set(vals);
    known = next;
  }
  // anything still unknown (deep continental interiors): treat as deep sea
  for (let i = 0; i < known.length; i++) if (!known[i]) bathDepth[i] = BATH_CAP_M;
}

const lakeCov = new Float32Array(BATH_W * BATH_H);
for (let y = 0; y < BATH_H; y++)
  for (let x = 0; x < BATH_W; x++) {
    let c = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) c += lakeHi[(y * k + dy) * W + x * k + dx];
    lakeCov[y * BATH_W + x] = c / (k * k);
  }

const rgb = new Uint8Array(BATH_W * BATH_H * 3);
for (let i = 0; i < BATH_W * BATH_H; i++) {
  rgb[i * 3] = Math.min(255, Math.round(255 * Math.sqrt(Math.min(bathDepth[i], BATH_CAP_M) / BATH_CAP_M)));
  rgb[i * 3 + 1] = Math.min(255, Math.round(lakeCov[i] * 255));
}
const bathFile = path.join(outDir, 'bath.webp');
await sharp(rgb, { raw: { width: BATH_W, height: BATH_H, channels: 3 } })
  .webp({ lossless: true, effort: 6 })
  .toFile(bathFile);
const bathBytes = fs.statSync(bathFile).size;
console.log(`bath.webp: ${(bathBytes / 1e6).toFixed(2)} MB`);

fs.writeFileSync(
  path.join(outDir, 'meta.json'),
  JSON.stringify(
    {
      note: 'generated by scripts/build-dem.mjs',
      tileCols: TILE_COLS,
      tileRows: TILE_ROWS,
      tileSize: tw,
      elevCapM: ELEV_CAP_M,
      bathWidth: BATH_W,
      bathHeight: BATH_H,
      bathCapM: BATH_CAP_M,
    },
    null,
    2,
  ) + '\n',
);
let gz = 0;
for (const f of fs.readdirSync(outDir)) gz += zlib.gzipSync(fs.readFileSync(path.join(outDir, f))).length;
console.log(`total ${((totalBytes + bathBytes) / 1e6).toFixed(2)} MB (gzip ${(gz / 1e6).toFixed(2)} MB)`);
