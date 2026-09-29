// Tileable 3D "billow" noise (cloud masses / detail / tower grouping) for the cloud layers, generated once on the CPU.
//
// Cumulus are round domes, so the puff field is inverted Worley (distance to
// the nearest random feature point, squared → paraboloid domes) rather than
// value noise, whose thresholded blobs come out square and grid-aligned. One
// trilinear texture fetch also replaces a value-noise evaluation (8 hashes)
// per ray-march step, which is what lets the low-cloud march afford enough
// steps at grazing angles.
//
//   R  puff domes: 4 cells/tile, with a 8 cells/tile octave (sub-puffs)
//   G  fine cauliflower texture: 16 cells/tile
//   B  tower cells: 2 cells/tile
//   A  merged cloud masses (summed smooth domes, metaballs): 8 cells/tile
import * as THREE from 'three';

const SIZE = 64;
/** wrap table: WRAP[i + SIZE] = i mod SIZE for i in [-SIZE, 2·SIZE) */
const WRAP = new Int32Array(SIZE * 3).map((_, i) => i % SIZE);

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverted squared-F1 Worley, tileable: 1 at a feature point, 0 beyond
 *  ~0.87 cell. Built by splatting each feature point into the voxels within
 *  that radius (≈2.7 cell³ each) instead of searching 27 cells per voxel. */
function worley(cells: number, seed: number, vary = 0, blend = false): Float32Array {
  const rng = makeRng(seed);
  const out = new Float32Array(SIZE * SIZE * SIZE);
  const vox = SIZE / cells;
  const R2 = blend ? 1.1 : 0.75; // cell² at which the dome reaches 0
  const rv = Math.ceil(Math.sqrt(R2) * vox);
  const inv = 1 / (vox * vox * R2);
  for (let c = 0; c < cells * cells * cells; c++) {
    const cx = c % cells;
    const cy = Math.floor(c / cells) % cells;
    const cz = Math.floor(c / (cells * cells));
    // feature point in voxel units (voxel centres at i + 0.5)
    const fx = (cx + rng()) * vox - 0.5;
    const fy = (cy + rng()) * vox - 0.5;
    const fz = (cz + rng()) * vox - 0.5;
    // vary > 0: random dome height / radius and some empty cells, so the
    // puffs come in mixed sizes instead of an even bubble packing
    const amp = vary > 0 ? (rng() < 0.18 * vary ? 0 : 1 - vary * 0.6 * rng()) : 1;
    const rs = vary > 0 ? 1 - vary * 0.35 * rng() : 1;
    if (amp === 0) continue;
    const invP = inv / (rs * rs);
    const x0 = Math.ceil(fx - rv);
    const y0 = Math.ceil(fy - rv);
    const z0 = Math.ceil(fz - rv);
    for (let z = z0; z <= fz + rv; z++) {
      const dz = z - fz;
      const wz = WRAP[z + SIZE];
      for (let y = y0; y <= fy + rv; y++) {
        const dy = y - fy;
        const dyz = dy * dy + dz * dz;
        if (dyz * invP >= 1) continue;
        const row = (wz * SIZE + WRAP[y + SIZE]) * SIZE;
        for (let x = x0; x <= fx + rv; x++) {
          const dx = x - fx;
          const v = 1 - (dx * dx + dyz) * invP;
          if (v <= 0) continue;
          const i = row + WRAP[x + SIZE];
          if (blend) out[i] += v * v * amp; // smooth kernel, summed: metaballs
          else if (v * amp > out[i]) out[i] = v * amp;
        }
      }
    }
  }
  if (blend) for (let i = 0; i < out.length; i++) out[i] = 1 - Math.exp(-1.8 * out[i]);
  return out;
}

export function buildCloudNoiseTexture(): THREE.Data3DTexture {
  const w4 = worley(4, 11, 1);
  const w8 = worley(8, 23, 1);
  const m8 = worley(8, 71, 1, true);
  const w16 = worley(16, 37);
  const w2 = worley(2, 51, 0.7);
  const n = SIZE * SIZE * SIZE;
  const data = new Uint8Array(n * 4);
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < n; i++) {
    data[i * 4] = q(Math.max(w4[i], w8[i] * 0.8) * 0.8 + w8[i] * 0.2);
    data[i * 4 + 1] = q(w16[i]);
    data[i * 4 + 2] = q(w2[i]);
    data[i * 4 + 3] = q(m8[i]);
  }
  const tex = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
