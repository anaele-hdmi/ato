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

/** Builds the equirectangular land-mask canvas (R = land, G = coastal band,
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
  // G: coastal band (stroked outline) → shallow ocean; R: land.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = '#00ff00';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.stroke();
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

export function buildLandMaskTexture(): THREE.CanvasTexture {
  const canvas = buildLandMaskCanvas();
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
