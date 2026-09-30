// CPU-side terrain elevation. Displacement (and the per-vertex horizon angles
// used for cast shadows) is computed once per chunk when the chunk is built --
// in terrainWorker.ts, off the main thread -- since it's static in the
// Earth's object space.
//
// Relief rules (reference images): mountains get sharp ridged facets; plains
// stay nearly flat so they don't read as crumpled paper.

import { buildChunkMesh, borderSnapTriples, type SeedChunk } from './icosphere';
import demMeta from '../assets/dem/meta.json';

const MAX_ELEV_KM = 8.8;
export const EXAGGERATION = 5.0;

function fract(x: number): number {
  return x - Math.floor(x);
}

// Same hash / value noise as NOISE_GLSL (noiseGlsl.ts), in float64.
function hash(x: number, y: number, z: number): number {
  let px = fract(x * 0.3183099 + 0.71) * 17;
  let py = fract(y * 0.3183099 + 0.113) * 17;
  let pz = fract(z * 0.3183099 + 0.419) * 17;
  return fract(px * py * pz * (px + py + pz));
}

function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const n000 = hash(ix, iy, iz);
  const n100 = hash(ix + 1, iy, iz);
  const n010 = hash(ix, iy + 1, iz);
  const n110 = hash(ix + 1, iy + 1, iz);
  const n001 = hash(ix, iy, iz + 1);
  const n101 = hash(ix + 1, iy, iz + 1);
  const n011 = hash(ix, iy + 1, iz + 1);
  const n111 = hash(ix + 1, iy + 1, iz + 1);
  const x00 = n000 + (n100 - n000) * ux;
  const x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux;
  const x11 = n011 + (n111 - n011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

function ridgedFbm(x: number, y: number, z: number): number {
  let sum = 0;
  let amp = 0.55;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    const n = noise(x * f, y * f, z * f);
    const r = 1 - Math.abs(n * 2 - 1);
    sum += r * r * amp;
    f *= 2.08;
    amp *= 0.5;
  }
  return sum;
}

function fbm3(x: number, y: number, z: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 3; i++) {
    sum += noise(x * f, y * f, z * f) * amp;
    f *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface Raster {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** bytes per pixel (4 for RGBA, 1 for a single extracted channel) */
  stride: number;
}

/** Copies one channel of a raster into a compact single-channel raster
 *  (what the terrain worker receives: 2 MB per 2048x1024 map instead of 8). */
export function extractChannel(r: Raster, channel: number): Raster {
  const n = r.width * r.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r.data[i * r.stride + channel];
  return { data: out, width: r.width, height: r.height, stride: 1 };
}

// --- High-resolution DEM (ETOPO 2022, 0.05 deg) ---------------------------
// A global 8-bit raster assembled from lazily loaded tiles (scripts/build-dem.mjs
// writes them; code = 255 * sqrt(metres / capM)). Until a tile has arrived its
// area falls back to the coarse DEM, and earth.ts does not build chunks over
// missing tiles, so the two are never mixed inside a chunk.
export const HI_TILE_COLS: number = demMeta.tileCols;
export const HI_TILE_ROWS: number = demMeta.tileRows;
export const HI_TILE_SIZE: number = demMeta.tileSize;
const HI_W = HI_TILE_COLS * HI_TILE_SIZE;
const HI_H = HI_TILE_ROWS * HI_TILE_SIZE;
const HI_CAP_KM = demMeta.elevCapM / 1000;
const HI_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) HI_LUT[i] = HI_CAP_KM * (i / 255) * (i / 255);

export interface HiDem {
  /** HI_W x HI_H codes, zero until the tile covering them is installed. */
  data: Uint8Array;
  /** 1 per tile once installed (index = row * HI_TILE_COLS + col). */
  loaded: Uint8Array;
}

export function createHiDem(): HiDem {
  return { data: new Uint8Array(HI_W * HI_H), loaded: new Uint8Array(HI_TILE_COLS * HI_TILE_ROWS) };
}

export function installHiTile(hi: HiDem, col: number, row: number, tile: Uint8Array): void {
  const ts = HI_TILE_SIZE;
  for (let y = 0; y < ts; y++) {
    hi.data.set(tile.subarray(y * ts, (y + 1) * ts), (row * ts + y) * HI_W + col * ts);
  }
  hi.loaded[row * HI_TILE_COLS + col] = 1;
}

// Bilinear elevation in km from the hi-res DEM, or -1 if the tile is missing.
function sampleHiKm(hi: HiDem, uN: number, vN: number): number {
  const u = uN * HI_W - 0.5;
  const v = vN * HI_H - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.max(0, Math.min(HI_H - 1, Math.floor(v)));
  const y1 = Math.min(HI_H - 1, y0 + 1);
  const fx = u - x0;
  const fy = Math.max(0, Math.min(1, v - y0));
  const xa = ((x0 % HI_W) + HI_W) % HI_W;
  const xb = xa + 1 === HI_W ? 0 : xa + 1;
  if (!hi.loaded[Math.floor(y0 / HI_TILE_SIZE) * HI_TILE_COLS + Math.floor(xa / HI_TILE_SIZE)]) return -1;
  const d = hi.data;
  const r0 = y0 * HI_W;
  const r1 = y1 * HI_W;
  const a00 = HI_LUT[d[r0 + xa]];
  const a10 = HI_LUT[d[r0 + xb]];
  const a01 = HI_LUT[d[r1 + xa]];
  const a11 = HI_LUT[d[r1 + xb]];
  const top = a00 + (a10 - a00) * fx;
  const bot = a01 + (a11 - a01) * fx;
  return top + (bot - top) * fy;
}

// Bilinear sample of channel 0 at precomputed equirect pixel coords (u, v).
// Both rasters are sampled at the same lat/lon, so the (costly) asin/atan2 is
// done once per elevation evaluation in elevationKm.
function sampleUV(r: Raster, uN: number, vN: number): number {
  const u = uN * r.width - 0.5;
  const v = vN * r.height - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.max(0, Math.min(r.height - 1, Math.floor(v)));
  const y1 = Math.min(r.height - 1, y0 + 1);
  const fx = u - x0;
  const fy = Math.max(0, Math.min(1, v - y0));
  const w = r.width;
  const xa = ((x0 % w) + w) % w;
  const xb = xa + 1 === w ? 0 : xa + 1;
  const d = r.data;
  const s = r.stride;
  const a00 = d[(y0 * w + xa) * s];
  const a10 = d[(y0 * w + xb) * s];
  const a01 = d[(y1 * w + xa) * s];
  const a11 = d[(y1 * w + xb) * s];
  const top = a00 + (a10 - a00) * fx;
  const bot = a01 + (a11 - a01) * fx;
  return (top + (bot - top) * fy) / 255;
}

// Micro-relief (review-2 §5-3): the ridged noise used to be ±6-14 km at a
// ~150 km wavelength (freq 260) -- as large as the real DEM relief and
// under-sampled by 30 km facets, which read as a lattice of diamonds rather
// than mountain ranges. Now a third of the amplitude at twice the wavelength,
// so the DEM's ranges dominate and the noise only breaks up their faces.
const RIDGE_FREQ = 130;
const RIDGE_GAIN = 4.0 / 3.0;
const ROLL_FREQ = 140;
/** Micro-relief amplitude factor where the hi-res DEM is present. */
const MICRO_SCALE_HI = 0.3;

/** Elevation above sea level in km (already exaggerated) at a unit direction.
 *  `height` and `land` are single-channel or RGBA rasters (channel 0 used).
 *  `detail = false` skips the micro-relief noise (DEM only): used by the
 *  horizon march for far samples, where it changes the angle by < ~1 deg. */
export function elevationKm(
  height: Raster,
  land: Raster,
  nx: number,
  ny: number,
  nz: number,
  detail = true,
  hi?: HiDem,
): number {
  const lat = Math.asin(ny > 1 ? 1 : ny < -1 ? -1 : ny);
  const lon = Math.atan2(-nz, nx);
  const uN = lon / (2 * Math.PI) + 0.5;
  const vN = 0.5 - lat / Math.PI;
  const landAmt = smoothstep(0.42, 0.58, sampleUV(land, uN, vN));
  if (landAmt <= 0) return 0;
  let h = -1;
  if (hi) {
    h = sampleHiKm(hi, uN, vN);
    if (h >= 0) h /= MAX_ELEV_KM;
  }
  // The hi-res DEM carries the real ranges and valleys, so the invented
  // micro-relief only has to break up flat facets a little.
  const microScale = h >= 0 ? MICRO_SCALE_HI : 1;
  if (h < 0) h = sampleUV(height, uN, vN);
  if (!detail) return h * MAX_ELEV_KM * EXAGGERATION * landAmt;
  const mountain = smoothstep(0.035, 0.22, h);
  // plains: a very gentle roll (a few hundred metres), more on uplands
  const upland = smoothstep(0.01, 0.06, h);
  const rolling = (fbm3(nx * ROLL_FREQ, ny * ROLL_FREQ, nz * ROLL_FREQ) - 0.44) * (0.15 + 0.45 * upland);
  const micro =
    mountain > 0
      ? rolling + ((ridgedFbm(nx * RIDGE_FREQ, ny * RIDGE_FREQ, nz * RIDGE_FREQ) - 0.3) * RIDGE_GAIN - rolling) * mountain
      : rolling;
  return (h * MAX_ELEV_KM + micro * microScale) * EXAGGERATION * landAmt;
}

// --- Horizon angles (cast shadows, review-2 §5-2) --------------------------
//
// For every vertex we march the elevation function outward along 8 azimuths
// in the local tangent frame and keep the highest elevation angle of the
// terrain seen from that vertex. The fragment shader interpolates the two
// azimuths bracketing the sun's azimuth and puts the fragment in shadow when
// the sun is below that horizon. Frame (must match earth.ts):
//   east  = normalize(cross(+Y, n))   (+Y = north pole in Earth object space)
//   north = cross(n, east)
//   azimuth k (k = 0..7) = k * 45 deg clockwise from north: dir = cos*north + sin*east
export const HORIZON_AZIMUTHS = 8;
/** Encoded angle range: byte 0 = HORIZON_MIN_DEG, 255 = HORIZON_MAX_DEG. */
export const HORIZON_MIN_DEG = -16;
export const HORIZON_MAX_DEG = 64;
const HORIZON_SAMPLES = 10;
const HORIZON_MAX_KM = 300;
/** Samples at or beyond this distance use the DEM only (no micro-relief). */
const HORIZON_DETAIL_KM = 90;

const AZ_COS: number[] = [];
const AZ_SIN: number[] = [];
for (let k = 0; k < HORIZON_AZIMUTHS; k++) {
  AZ_COS.push(Math.cos((k * 2 * Math.PI) / HORIZON_AZIMUTHS));
  AZ_SIN.push(Math.sin((k * 2 * Math.PI) / HORIZON_AZIMUTHS));
}

/**
 * Bakes 8 horizon elevation angles per vertex into two RGBA8 attributes
 * (azimuths 0-3 and 4-7). `positions` are the displaced vertex positions (km,
 * object space); `elev` their elevations (km) as returned by elevationKm.
 * `firstStepKm` is the first march distance (about half a facet edge, so the
 * vertex's own facet slope -- already handled by N.L -- isn't double counted).
 */
export function computeHorizons(
  positions: Float32Array,
  elev: Float32Array,
  height: Raster,
  land: Raster,
  radiusKm: number,
  firstStepKm: number,
  count: number,
  hi?: HiDem,
): { horizonA: Uint8Array; horizonB: Uint8Array } {
  const horizonA = new Uint8Array(count * 4);
  const horizonB = new Uint8Array(count * 4);
  const ratio = Math.pow(HORIZON_MAX_KM / firstStepKm, 1 / (HORIZON_SAMPLES - 1));
  const dists: number[] = [];
  for (let s = 0, d = firstStepKm; s < HORIZON_SAMPLES; s++, d *= ratio) dists.push(d);
  const toByte = (deg: number) =>
    Math.round(Math.max(0, Math.min(1, (deg - HORIZON_MIN_DEG) / (HORIZON_MAX_DEG - HORIZON_MIN_DEG))) * 255);
  const RAD = 180 / Math.PI;

  const detailSamples = dists.filter((d) => d < HORIZON_DETAIL_KM).length;

  for (let v = 0; v < count; v++) {
    // Sea-level vertices (ocean) keep "no horizon": water shading ignores it.
    if (elev[v] === 0) continue;
    const px = positions[v * 3];
    const py = positions[v * 3 + 1];
    const pz = positions[v * 3 + 2];
    const r = Math.hypot(px, py, pz);
    const nx = px / r;
    const ny = py / r;
    const nz = pz / r;
    // east = cross(Y, n) = (nz, 0, -nx)
    let ex = nz;
    let ez = -nx;
    const el = Math.hypot(ex, ez);
    if (el < 1e-6) {
      ex = 1;
      ez = 0;
    } else {
      ex /= el;
      ez /= el;
    }
    // north = cross(n, east)
    const Nx = ny * ez;
    const Ny = nz * ex - nx * ez;
    const Nz = -ny * ex;
    const r0 = radiusKm + elev[v];

    for (let k = 0; k < HORIZON_AZIMUTHS; k++) {
      const tx = AZ_COS[k] * Nx + AZ_SIN[k] * ex;
      const ty = AZ_COS[k] * Ny;
      const tz = AZ_COS[k] * Nz + AZ_SIN[k] * ez;
      let best = -Math.PI / 2;
      for (let s = 0; s < HORIZON_SAMPLES; s++) {
        const th = dists[s] / radiusKm; // great-circle angle
        const c = Math.cos(th);
        const sn = Math.sin(th);
        const qx = nx * c + tx * sn;
        const qy = ny * c + ty * sn;
        const qz = nz * c + tz * sn;
        const r1 = radiusKm + elevationKm(height, land, qx, qy, qz, s < detailSamples, hi);
        // vector from vertex to sample, its component along the local up n
        const dx = qx * r1 - nx * r0;
        const dy = qy * r1 - ny * r0;
        const dz = qz * r1 - nz * r0;
        const up = dx * nx + dy * ny + dz * nz;
        const ang = Math.asin(up / Math.hypot(dx, dy, dz));
        if (ang > best) best = ang;
      }
      const b = toByte(best * RAD);
      if (k < 4) horizonA[v * 4 + k] = b;
      else horizonB[v * 4 + k - 4] = b;
    }
  }
  return { horizonA, horizonB };
}

export interface TerrainChunk {
  positions: Float32Array;
  indices: Uint16Array;
  horizonA: Uint8Array;
  horizonB: Uint8Array;
}

/** Icosphere edge length (km) at a given subdivision level. */
export function facetEdgeKm(level: number, radiusKm: number): number {
  return (1.1071487 / 2 ** level) * radiusKm; // base icosahedron edge = 63.43 deg
}

/**
 * Builds one displaced detail chunk with baked horizon angles. `snapBorder`
 * must be set on chunks that may border a chunk one level coarser (earth.ts:
 * the level-9 ring) -- see borderSnapTriples.
 */
export function buildTerrainChunk(
  corners: SeedChunk['corners'],
  seedLevel: number,
  level: number,
  radiusKm: number,
  height: Raster,
  land: Raster,
  snapBorder: boolean,
  hi?: HiDem,
): TerrainChunk {
  const extra = level - seedLevel;
  const mesh = buildChunkMesh({ index: 0, corners, center: corners[0] }, extra, radiusKm, 0);
  const positions = mesh.positions;
  const count = positions.length / 3;
  const elev = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const r = Math.hypot(x, y, z);
    const nx = x / r;
    const ny = y / r;
    const nz = z / r;
    const e = elevationKm(height, land, nx, ny, nz, true, hi);
    elev[v] = e;
    positions[v * 3] = nx * (radiusKm + e);
    positions[v * 3 + 1] = ny * (radiusKm + e);
    positions[v * 3 + 2] = nz * (radiusKm + e);
  }
  const { horizonA, horizonB } = computeHorizons(
    positions,
    elev,
    height,
    land,
    radiusKm,
    0.5 * facetEdgeKm(level, radiusKm),
    count,
    hi,
  );
  if (snapBorder) {
    for (const [o, a, b] of borderSnapTriples(extra)) {
      for (let c = 0; c < 3; c++) positions[o * 3 + c] = 0.5 * (positions[a * 3 + c] + positions[b * 3 + c]);
      for (let c = 0; c < 4; c++) {
        horizonA[o * 4 + c] = (horizonA[a * 4 + c] + horizonA[b * 4 + c]) >> 1;
        horizonB[o * 4 + c] = (horizonB[a * 4 + c] + horizonB[b * 4 + c]) >> 1;
      }
    }
  }
  return { positions, indices: mesh.indices as Uint16Array, horizonA, horizonB };
}

/** Loads an 8-bit grayscale/RGB image into a CPU raster. */
export async function loadRaster(url: string): Promise<Raster> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { data, width: canvas.width, height: canvas.height, stride: 4 };
}
