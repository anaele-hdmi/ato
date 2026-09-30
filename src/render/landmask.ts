// Rasterizes world-atlas land-50m topojson into a flat equirectangular
// land-mask texture at startup. No photo textures — this is a 1-bit land/water
// mask; the Earth shader turns it into a quantized flat-colour palette.
import * as THREE from 'three';
import { feature } from 'topojson-client';
import landTopology from 'world-atlas/land-50m.json';

const WIDTH = 2048;
const HEIGHT = 1024;

function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * WIDTH;
  const y = ((90 - lat) / 180) * HEIGHT;
  return [x, y];
}

type Ring = [number, number][];
type PolygonCoords = Ring[];

function tracePolygon(ctx: CanvasRenderingContext2D, rings: PolygonCoords, lonShift: number): void {
  for (const ring of rings) {
    if (ring.length < 2) continue;
    ctx.moveTo(...project(ring[0][0] + lonShift, ring[0][1]));
    for (let i = 1; i < ring.length; i++) {
      ctx.lineTo(...project(ring[i][0] + lonShift, ring[i][1]));
    }
    ctx.closePath();
  }
}

/** Separable box blur with longitude wrap (X) and edge clamp (Y, poles). Used
 * repeatedly (3 passes) to approximate a wide gaussian cheaply at build time. */
function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);
  const norm = 1 / (radius * 2 + 1);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += src[row + (((k % width) + width) % width)];
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum * norm;
      const addX = (x + radius + 1) % width;
      const subX = ((x - radius) % width + width) % width;
      sum += src[row + addX] - src[row + subX];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = Math.min(height - 1, Math.max(0, k));
      sum += tmp[y * width + x];
    }
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = sum * norm;
      const addY = Math.min(height - 1, y + radius + 1);
      const subY = Math.max(0, y - radius);
      sum += tmp[addY * width + x] - tmp[subY * width + x];
    }
  }
  return dst;
}

/** Builds a coast-distance field: 0 = deep ocean, 0.5 = coastline, 1 = deep
 * interior. Cheap repeated box-blur of the binary land mask (art-direction
 * §4 land-biome follow-up): far from the smoothing radius the value
 * saturates toward 0 or 1, so |field*2-1| reads as "distance from coast". */
function buildCoastDistanceField(landBinary: Float32Array, width: number, height: number): Float32Array {
  let field = landBinary;
  for (let i = 0; i < 3; i++) {
    field = boxBlur(field, width, height, 18);
  }
  return field;
}

/** Builds the equirectangular land-mask canvas (R = land, G unused,
 * B = coast-distance field for land-biome selection). */
export function buildLandMaskCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for land mask rasterization');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const geo: any = feature(landTopology as any, (landTopology as any).objects.land);
  const geometries: any[] =
    geo.type === 'FeatureCollection' ? geo.features.map((f: any) => f.geometry) : [geo.geometry];

  ctx.beginPath();
  for (const g of geometries) {
    if (!g) continue;
    const polygons: PolygonCoords[] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polygons) {
      for (const shift of [-360, 0, 360]) {
        tracePolygon(ctx, poly, shift);
      }
    }
  }
  // R: land. (The shallow-water band that used to be a 3 px stroke in G is now
  // depth-based, from the bathymetry texture: see buildBathTexture below.)
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#ff0000';
  ctx.fill('evenodd');
  ctx.globalCompositeOperation = 'source-over';

  // Build the coast-distance field from a clean binary land fill (independent
  // of the stroke used above) and write it into B.
  const img = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const landBinary = new Float32Array(WIDTH * HEIGHT);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    landBinary[i] = img.data[i * 4] > 127 ? 1 : 0;
  }
  const coastField = buildCoastDistanceField(landBinary, WIDTH, HEIGHT);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(coastField[i] * 255)));
  }
  ctx.putImageData(img, 0, 0);

  return canvas;
}

/** Land mask texture plus its pixels (RGBA) for CPU-side terrain displacement. */
export function buildLandMask(): { texture: THREE.CanvasTexture; data: Uint8ClampedArray; width: number; height: number } {
  const canvas = buildLandMaskCanvas();
  const data = canvas.getContext('2d')!.getImageData(0, 0, WIDTH, HEIGHT).data;
  return { texture: textureFromCanvas(canvas), data, width: WIDTH, height: HEIGHT };
}

export function buildLandMaskTexture(): THREE.CanvasTexture {
  return textureFromCanvas(buildLandMaskCanvas());
}

function textureFromCanvas(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// --- Biome map ------------------------------------------------------------
// Latitude rules alone paint the Ganges plain or the Amazon as desert, so the
// big arid and rainforest regions are hand-placed as soft ellipses
// (lon, lat, radius-lon, radius-lat in degrees). R = aridity, G = rainforest.
const ARID: [number, number, number, number, number][] = [
  // lon, lat, rLon, rLat, strength
  [8, 23, 26, 9, 1], // Sahara
  [45, 22, 13, 8, 1], // Arabia
  [56, 30, 8, 5, 0.8], // Iran
  [71, 27, 4, 3, 0.8], // Thar
  [83, 40, 10, 4, 0.9], // Taklamakan / Tarim
  [104, 43, 12, 4, 0.8], // Gobi
  [60, 44, 8, 4, 0.6], // Kazakh / Aral steppe
  [128, -25, 13, 7, 0.95], // Australian interior
  [19, -23, 6, 6, 0.8], // Kalahari / Namib
  [-70, -23, 3, 8, 0.9], // Atacama
  [-68, -45, 4, 6, 0.5], // Patagonian steppe
  [-112, 33, 7, 5, 0.8], // SW US / Sonora
  [45, 7, 5, 4, 0.5], // Horn of Africa
];
const RAINFOREST: [number, number, number, number, number][] = [
  [-62, -4, 14, 8, 1], // Amazon
  [20, 0, 10, 5, 1], // Congo
  [105, 2, 18, 8, 0.9], // SE Asia / Indonesia
  [-8, 7, 6, 2.5, 0.6], // West Africa coast
  [145, -5, 5, 3, 0.8], // New Guinea
  [-84, 10, 4, 5, 0.6], // Central America
  [80, 24, 10, 4, 0.55], // Ganges plain / Bengal (green, not rainforest proper)
  [115, 28, 9, 6, 0.55], // South China
];

export function buildBiomeTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const paint = (list: typeof ARID, channel: 'r' | 'g') => {
    for (const [lon, lat, rl, ra, k] of list) {
      for (const shift of [-360, 0, 360]) {
        const x = ((lon + shift + 180) / 360) * w;
        const y = ((90 - lat) / 180) * h;
        const rx = (rl / 360) * w;
        const ry = (ra / 180) * h;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(rx, ry);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.6);
        const c = Math.round(255 * k);
        const col = (a: number) => (channel === 'r' ? `rgba(${c},0,0,${a})` : `rgba(0,${c},0,${a})`);
        g.addColorStop(0, col(1));
        g.addColorStop(0.55, col(0.85));
        g.addColorStop(1, col(0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  };
  paint(ARID, 'r');
  paint(RAINFOREST, 'g');
  return textureFromCanvas(canvas);
}

// --- Bathymetry / lakes (scripts/build-dem.mjs -> assets/dem/bath.webp) -------
// RG8, 3600x1800: R = shallow-sea depth code (255 * sqrt(depth / capM), land
// pixels filled from the nearest sea), G = lake coverage (Natural Earth 1:50m).
// earth.ts turns R into shelf tint / turquoise shallows and G into lake colour.

/** 2x1 stand-in (deep sea, no lake) bound until the real bathymetry texture has decoded. */
export function buildDummyBathTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 0, 255, 0]), 2, 1, THREE.RGFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export async function loadBathTexture(url: string): Promise<THREE.DataTexture> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const rg = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    rg[i * 2] = rgba[i * 4];
    rg[i * 2 + 1] = rgba[i * 4 + 1];
  }
  const tex = new THREE.DataTexture(rg, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// --- Sea ice ------------------------------------------------------------------
// Simple climatological model (NOT derived from a data file: hand-placed from
// the well-known mean ice edges, so treat it as an illustration). For each
// longitude: the latitude (degrees, absolute) of the ice edge at the seasonal
// maximum and minimum extent; ice lies poleward of it, over ocean only (land
// is drawn over it). 91 = no ice at all. The shader blends the two by time of
// year (Arctic max mid-March / min mid-September, Antarctic max late
// September / min late February).
type EdgeTable = [lon: number, max: number, min: number][];
const ARCTIC_EDGE: EdgeTable = [
  [-180, 60, 80], [-165, 62, 78], [-150, 70, 78], [-125, 70, 76], [-105, 68, 75],
  [-95, 53, 91], [-80, 53, 91], [-68, 58, 74], [-58, 48, 76], [-45, 58, 78],
  [-30, 66, 76], [-15, 70, 77], [0, 76, 81], [12, 77, 81], [25, 74, 81],
  [40, 68, 80], [60, 68, 80], [90, 70, 80], [120, 68, 80], [135, 47, 79],
  [150, 52, 79], [158, 52, 79], [164, 61, 79], [172, 60, 80],
];
const ANTARCTIC_EDGE: EdgeTable = [
  [-180, 64, 74], [-150, 65, 72], [-120, 66, 73], [-100, 66, 72], [-85, 63, 70],
  [-70, 61, 68], [-58, 58, 64], [-45, 56, 62], [-30, 56, 66], [-15, 57, 70],
  [0, 58, 70], [20, 59, 70], [45, 60, 69], [70, 60, 68], [90, 61, 66],
  [110, 62, 66], [130, 62, 67], [150, 63, 68], [165, 64, 72], [180, 64, 74],
];

function edgeAt(table: EdgeTable, lon: number): [number, number] {
  // periodic linear interpolation; the table spans -180..~172 and wraps
  const n = table.length;
  for (let i = 0; i < n; i++) {
    const a = table[i];
    const b = table[(i + 1) % n];
    const lonA = a[0];
    const lonB = i + 1 < n ? b[0] : b[0] + 360;
    if (lon >= lonA && lon <= lonB) {
      const t = (lon - lonA) / (lonB - lonA || 1);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return [table[0][1], table[0][2]];
}

/** 360x1 RGBA8 (1 degree of longitude per texel from -180): N max, N min, S max, S min edge latitude, (deg - 40) / 60. */
export function buildSeaIceTexture(): THREE.DataTexture {
  const w = 360;
  const data = new Uint8Array(w * 4);
  const enc = (deg: number) => Math.round(Math.max(0, Math.min(1, (deg - 40) / 60)) * 255);
  for (let i = 0; i < w; i++) {
    const lon = -180 + i + 0.5;
    const [nMax, nMin] = edgeAt(ARCTIC_EDGE, lon);
    const [sMax, sMin] = edgeAt(ANTARCTIC_EDGE, lon);
    data.set([enc(nMax), enc(nMin), enc(sMax), enc(sMin)], i * 4);
  }
  const t = new THREE.DataTexture(data, w, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
