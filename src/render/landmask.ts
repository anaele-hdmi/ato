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

/** Builds the equirectangular land-mask canvas (land = opaque white, ocean = transparent black in R). */
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

  ctx.fillStyle = '#ffffff';
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
  ctx.fill('evenodd');

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
