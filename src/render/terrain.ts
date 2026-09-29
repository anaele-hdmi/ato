// CPU-side terrain elevation. Displacement is computed once per chunk when the
// chunk is built (it's static in the Earth's object space), instead of in the
// vertex shader every frame — the per-vertex noise was the single largest
// recurring GPU cost of the relief.
//
// Relief rules (reference images): mountains get sharp ridged facets; plains
// stay nearly flat so they don't read as crumpled paper.

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
  /** bytes per pixel (4 for RGBA) */
  stride: number;
}

/** Bilinear sample of one channel (0..1) at an object-space unit direction. */
function sample(r: Raster, channel: number, nx: number, ny: number, nz: number): number {
  const lat = Math.asin(Math.max(-1, Math.min(1, ny)));
  const lon = Math.atan2(-nz, nx);
  const u = (lon / (2 * Math.PI) + 0.5) * r.width - 0.5;
  const v = (0.5 - lat / Math.PI) * r.height - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.max(0, Math.min(r.height - 1, Math.floor(v)));
  const y1 = Math.min(r.height - 1, y0 + 1);
  const fx = u - x0;
  const fy = Math.max(0, Math.min(1, v - y0));
  const xa = ((x0 % r.width) + r.width) % r.width;
  const xb = (xa + 1) % r.width;
  const at = (x: number, y: number) => r.data[(y * r.width + x) * r.stride + channel] / 255;
  const top = at(xa, y0) + (at(xb, y0) - at(xa, y0)) * fx;
  const bot = at(xa, y1) + (at(xb, y1) - at(xa, y1)) * fx;
  return top + (bot - top) * fy;
}

/** Elevation above sea level in km (already exaggerated) at a unit direction. */
export function elevationKm(height: Raster, land: Raster, nx: number, ny: number, nz: number): number {
  const landAmt = smoothstep(0.42, 0.58, sample(land, 0, nx, ny, nz));
  if (landAmt <= 0) return 0;
  const h = sample(height, 0, nx, ny, nz);
  const mountain = smoothstep(0.035, 0.22, h);
  // plains: a very gentle roll (a few hundred metres), more on uplands
  const upland = smoothstep(0.01, 0.06, h);
  const rolling = (fbm3(nx * 140, ny * 140, nz * 140) - 0.44) * (0.15 + 0.45 * upland);
  const ridge = (ridgedFbm(nx * 260, ny * 260, nz * 260) - 0.3) * 4.0;
  const micro = rolling + (ridge - rolling) * mountain;
  return (h * MAX_ELEV_KM + micro) * EXAGGERATION * landAmt;
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
