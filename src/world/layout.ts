// Fixed geography shared by terrain, roads, settlement and figures.
import { fbm } from '../util/rand';

export type V2 = [number, number];

export interface Road {
  pts: V2[];
  birth: number;
}

// The house sits just north of the bend of an old east–west track.
export const MAIN_ROAD: V2[] = [
  [-2600, -1500], [-1700, -1050], [-900, -640], [-420, -260], [-160, -40],
  [-52, 13], [40, 16], [160, 40], [420, 150], [900, 330], [1700, 620], [2800, 1000],
];

export const LANES: Road[] = [
  { pts: [[0, 3], [-3, 9], [-4, 14]], birth: 1880 },
  { pts: [[40, 16], [62, -80], [92, -260], [160, -600], [205, -1100]], birth: 1923 },
  { pts: [[160, 40], [142, 220], [182, 480], [262, 900]], birth: 1931 },
  { pts: [[-420, -260], [-520, -40], [-600, 260], [-700, 700]], birth: 1944 },
  { pts: [[-160, -40], [-205, 160], [-262, 420], [-300, 700]], birth: 1956 },
];

export const CITY_CENTER: V2 = [-900, -640];

// City grid: rotated so it never quite agrees with the old track.
export const GRID_ANGLE = 0.13;
export const BLOCK_U = 84;
export const BLOCK_V = 64;
export const GRID_OFFSET: V2 = [BLOCK_U * 0.5, BLOCK_V * 0.5 + 6];
/** Half size of the square around the origin where the city never builds. */
export const VOID_HALF = 13;

export function toGrid(x: number, z: number): V2 {
  const c = Math.cos(GRID_ANGLE), s = Math.sin(GRID_ANGLE);
  return [x * c + z * s + GRID_OFFSET[0], -x * s + z * c + GRID_OFFSET[1]];
}
export function fromGrid(u: number, v: number): V2 {
  const c = Math.cos(GRID_ANGLE), s = Math.sin(GRID_ANGLE);
  const a = u - GRID_OFFSET[0], b = v - GRID_OFFSET[1];
  return [a * c - b * s, a * s + b * c];
}

export function distToPolyline(x: number, z: number, pts: V2[]): { d: number; t: number; seg: number } {
  let best = Infinity, bt = 0, bs = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - x, pz = az + dz * t - z;
    const d = px * px + pz * pz;
    if (d < best) { best = d; bt = t; bs = i; }
  }
  return { d: Math.sqrt(best), t: bt, seg: bs };
}

/** Year a location is absorbed by the city. */
export function urbanYear(x: number, z: number): number {
  const dx = x - CITY_CENTER[0], dz = z - CITY_CENTER[1];
  const d = Math.sqrt(dx * dx + dz * dz);
  const main = distToPolyline(x, z, MAIN_ROAD).d;
  return 1936 + d / 19.5 + fbm(x / 380, z / 380, 3, 77) * 14 - 11 * Math.exp(-main / 70);
}

export function inVoid(x: number, z: number, pad = 0): boolean {
  return Math.abs(x) < VOID_HALF + pad && Math.abs(z) < VOID_HALF + pad;
}

/** Point and tangent at arc length s along a polyline. */
export function alongPolyline(pts: V2[], s: number): { p: V2; dir: V2 } {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (s <= l || i === pts.length - 2) {
      const t = Math.min(1, Math.max(0, s / l));
      return { p: [ax + (bx - ax) * t, az + (bz - az) * t], dir: [(bx - ax) / l, (bz - az) / l] };
    }
    s -= l;
  }
  return { p: pts[0], dir: [1, 0] };
}

export function polylineLength(pts: V2[]): number {
  let l = 0;
  for (let i = 0; i < pts.length - 1; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
}
