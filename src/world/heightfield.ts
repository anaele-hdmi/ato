// Procedural heightmap, baked once on the CPU. The GPU samples the same texels,
// so CPU placement and vertex-shader displacement agree.
import * as THREE from 'three';
import { fbm, smoothstep } from '../util/rand';
import { ORIGIN_GROUND } from '../time/time-model';
import { LANES, MAIN_ROAD, urbanYear, type V2 } from './layout';

export const NEAR_EXT = 640;
export const FAR_EXT = 12000;
export const ROAD_EXT = 1200;
const NEAR_RES = 512;
const FAR_RES = 512;
const ROAD_RES = 1024;

function rawHeight(x: number, z: number): number {
  let h = 17 - 0.0032 * z;
  const north = smoothstep(-800, -7000, z);
  const cityFlat = Math.exp(-((x + 900) ** 2 + (z + 640) ** 2) / (700 * 700));
  h += (fbm(x / 2200, z / 2200, 5, 11) * 0.5 + 0.5) * (18 + 120 * north);
  h += fbm(x / 420, z / 420, 4, 23) * 7 * (1 - 0.65 * cityFlat);
  h += 9 * Math.exp(-(x * x / (230 * 230) + z * z / (200 * 200)));
  h += fbm(x / 55, z / 55, 3, 5) * 0.7;
  h -= smoothstep(3500, 7000, z) * 26;
  return h;
}

const ORIGIN_OFFSET = ORIGIN_GROUND - rawHeight(0, 0);

export function baseHeight(x: number, z: number): number {
  const h = rawHeight(x, z) + ORIGIN_OFFSET;
  const r = Math.hypot(x, z);
  // A level pad for the house footprint.
  return ORIGIN_GROUND + (h - ORIGIN_GROUND) * smoothstep(7, 18, r);
}

function deepField(x: number, z: number): number {
  const n = fbm(x / 900, z / 900, 4, 91);
  return (1 - Math.abs(n) * 2) * 0.8 + fbm(x / 3000, z / 3000, 2, 93) * 0.6;
}

export interface HeightGrid {
  res: number;
  ext: number;
  h: Float32Array;
  d: Float32Array;
}

function bake(res: number, ext: number): { grid: HeightGrid; tex: THREE.DataTexture } {
  const h = new Float32Array(res * res);
  const d = new Float32Array(res * res);
  const cell = (2 * ext) / res;
  for (let j = 0; j < res; j++) {
    const z = (j + 0.5) * cell - ext;
    for (let i = 0; i < res; i++) {
      const x = (i + 0.5) * cell - ext;
      h[j * res + i] = baseHeight(x, z);
      d[j * res + i] = deepField(x, z);
    }
  }
  const data = new Uint16Array(res * res * 4);
  const toH = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const hl = h[j * res + Math.max(0, i - 1)];
      const hr = h[j * res + Math.min(res - 1, i + 1)];
      const hd = h[Math.max(0, j - 1) * res + i];
      const hu = h[Math.min(res - 1, j + 1) * res + i];
      const gx = (hr - hl) / (2 * cell);
      const gz = (hu - hd) / (2 * cell);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      data[k * 4] = toH(h[k]);
      data[k * 4 + 1] = toH(-gx * inv);
      data[k * 4 + 2] = toH(-gz * inv);
      data[k * 4 + 3] = toH(d[k]);
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { grid: { res, ext, h, d }, tex };
}

function bilinear(g: HeightGrid, arr: Float32Array, x: number, z: number): number {
  const fx = ((x + g.ext) / (2 * g.ext)) * g.res - 0.5;
  const fz = ((z + g.ext) / (2 * g.ext)) * g.res - 0.5;
  const i0 = Math.max(0, Math.min(g.res - 1, Math.floor(fx)));
  const j0 = Math.max(0, Math.min(g.res - 1, Math.floor(fz)));
  const i1 = Math.min(g.res - 1, i0 + 1);
  const j1 = Math.min(g.res - 1, j0 + 1);
  const tx = Math.max(0, Math.min(1, fx - i0));
  const tz = Math.max(0, Math.min(1, fz - j0));
  const a = arr[j0 * g.res + i0], b = arr[j0 * g.res + i1];
  const c = arr[j1 * g.res + i0], e = arr[j1 * g.res + i1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
}

export class Heightfield {
  readonly near: HeightGrid;
  readonly far: HeightGrid;
  readonly nearTex: THREE.DataTexture;
  readonly farTex: THREE.DataTexture;
  readonly roadTex: THREE.DataTexture;

  constructor() {
    const n = bake(NEAR_RES, NEAR_EXT);
    const f = bake(FAR_RES, FAR_EXT);
    this.near = n.grid;
    this.far = f.grid;
    this.nearTex = n.tex;
    this.farTex = f.tex;
    this.roadTex = bakeRoads();
  }

  /** Mirrors terrainHeight() in GLSL. */
  height(x: number, z: number, disp = 0): number {
    const m = Math.max(Math.abs(x), Math.abs(z));
    let h: number, dd: number;
    const hf = bilinear(this.far, this.far.h, x, z);
    const df = bilinear(this.far, this.far.d, x, z);
    if (m > NEAR_EXT) {
      h = hf; dd = df;
    } else {
      const w = smoothstep(NEAR_EXT * 0.85, NEAR_EXT * 0.98, m);
      h = bilinear(this.near, this.near.h, x, z) * (1 - w) + hf * w;
      dd = bilinear(this.near, this.near.d, x, z) * (1 - w) + df * w;
    }
    return h + disp * (dd * 28 - (h - 18) * 0.35);
  }
}

function bakeRoads(): THREE.DataTexture {
  const res = ROAD_RES, ext = ROAD_EXT, cell = (2 * ext) / res;
  const CLAMP = 120;
  const main = new Float32Array(res * res).fill(CLAMP);
  const lane = new Float32Array(res * res).fill(CLAMP);
  const laneBirth = new Float32Array(res * res).fill(2300);

  const raster = (pts: V2[], target: Float32Array, birth: number | null) => {
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s];
      const [bx, bz] = pts[s + 1];
      const minI = Math.max(0, Math.floor((Math.min(ax, bx) - CLAMP + ext) / cell));
      const maxI = Math.min(res - 1, Math.ceil((Math.max(ax, bx) + CLAMP + ext) / cell));
      const minJ = Math.max(0, Math.floor((Math.min(az, bz) - CLAMP + ext) / cell));
      const maxJ = Math.min(res - 1, Math.ceil((Math.max(az, bz) + CLAMP + ext) / cell));
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      for (let j = minJ; j <= maxJ; j++) {
        const z = (j + 0.5) * cell - ext;
        for (let i = minI; i <= maxI; i++) {
          const x = (i + 0.5) * cell - ext;
          let t = ((x - ax) * dx + (z - az) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
          const k = j * res + i;
          if (d < target[k]) {
            target[k] = d;
            if (birth !== null) laneBirth[k] = birth;
          }
        }
      }
    }
  };
  raster(MAIN_ROAD, main, null);
  for (const l of LANES) raster(l.pts, lane, l.birth);

  const data = new Uint16Array(res * res * 4);
  const toH = THREE.DataUtils.toHalfFloat;
  // Urban year is smooth; evaluate on a coarser lattice and interpolate.
  const step = 8;
  const cr = res / step + 1;
  const coarse = new Float32Array(cr * cr);
  for (let j = 0; j < cr; j++) {
    for (let i = 0; i < cr; i++) {
      coarse[j * cr + i] = urbanYear((i * step + 0.5) * cell - ext, (j * step + 0.5) * cell - ext);
    }
  }
  for (let j = 0; j < res; j++) {
    const cj = Math.min(cr - 2, Math.floor(j / step));
    const tj = j / step - cj;
    for (let i = 0; i < res; i++) {
      const ci = Math.min(cr - 2, Math.floor(i / step));
      const ti = i / step - ci;
      const a = coarse[cj * cr + ci], b = coarse[cj * cr + ci + 1];
      const c = coarse[(cj + 1) * cr + ci], d = coarse[(cj + 1) * cr + ci + 1];
      const uy = (a + (b - a) * ti) * (1 - tj) + (c + (d - c) * ti) * tj;
      const k = j * res + i;
      data[k * 4] = toH(main[k]);
      data[k * 4 + 1] = toH(lane[k]);
      data[k * 4 + 2] = toH((laneBirth[k] - 1900) / 400);
      data[k * 4 + 3] = toH((uy - 1900) / 400);
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
