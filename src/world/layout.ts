// Fixed geography shared by terrain, roads, settlement and figures.
import { fbm, smoothstep } from '../util/rand';

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

// LANES[0] is the house's own short dooryard track, not a settlement road - it
// must not act as a finger that pulls early urbanization onto the house site.
// Real lanes (fingers of ribbon growth) are the ones long enough to actually
// lead somewhere.
const SETTLEMENT_LANES = LANES.filter((l) => polylineLength(l.pts) > 50);

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

// Bearing from CITY_CENTER toward the house site at the origin. The angular lobe
// terms below are all zero on this bearing, so the origin's timing anchor stays
// exactly on the plain radial law regardless of how the lobes are tuned elsewhere.
const ORIGIN_BEARING = Math.atan2(-CITY_CENTER[1], -CITY_CENTER[0]);

/**
 * Angular sprawl multiplier around CITY_CENTER: >1 pushes the frontier further
 * out (a finger of growth), <1 pulls it in (a pocket that stays rural longer).
 * A handful of low-frequency sin terms in the bearing angle only — cheap, and
 * trivial to mirror in GLSL for the far/unbaked field.
 */
function urbanLobe(x: number, z: number): number {
  const a = Math.atan2(z - CITY_CENTER[1], x - CITY_CENTER[0]) - ORIGIN_BEARING;
  return 1 + 0.2 * Math.sin(3 * a) + 0.13 * Math.sin(5 * a) + 0.08 * Math.sin(8 * a);
}

/** Year a location is absorbed by the city. */
export function urbanYear(x: number, z: number): number {
  const dx = x - CITY_CENTER[0], dz = z - CITY_CENTER[1];
  const d = Math.sqrt(dx * dx + dz * dz);
  // Fades in resistance/finger effects near the old core, which was already
  // built up flat and doesn't fight the terrain the way the frontier does.
  const gate = smoothstep(80, 450, d);

  const main = distToPolyline(x, z, MAIN_ROAD).d;
  let year = 1936 + (d * urbanLobe(x, z)) / 19.5;
  // Organic roughness along the growth front (irregular blob edges, not a ring).
  year += fbm(x / 380, z / 380, 3, 77) * (0.35 + 0.65 * smoothstep(50, 500, d)) * 14;
  // The main road pulls its own ribbon of early growth toward it.
  year -= 11 * Math.exp(-main / 70);

  // Lanes reach out from the road/city as fingers of ribbon development: growth
  // near a lane is pulled toward "shortly after that lane was built", but never
  // later than the base year above and never before the lane itself existed.
  for (const lane of SETTLEMENT_LANES) {
    const ld = distToPolyline(x, z, lane.pts).d;
    const closeness = Math.exp(-ld / 60);
    if (closeness < 0.02) continue;
    const laneTarget = lane.birth + 6 + fbm(x / 150, z / 150, 2, 700 + lane.birth) * 10;
    year -= closeness * gate * Math.max(0, year - laneTarget);
  }

  // Hills resist sprawl (steep, awkward ground costs more to develop); low
  // rough terrain proxy stands in for slope since heightfield can't be
  // imported here without a circular dependency.
  const hill = Math.abs(fbm(x / 260, z / 260, 4, 151));
  year += hill * 22 * gate;
  // A few large, slow-to-fill pockets (marsh, a stubborn old holding, whatever) -
  // most of the map is unaffected, but some patches stay rural far longer.
  const pocket = fbm(x / 950, z / 950, 2, 233);
  year += Math.max(0, pocket - 0.15) * 55 * gate;

  return year;
}

/** The square left empty around the house site, aligned with the city grid. */
export function inVoid(x: number, z: number, pad = 0): boolean {
  const [u, v] = toGrid(x, z);
  return Math.abs(u - GRID_OFFSET[0]) < VOID_HALF + pad && Math.abs(v - GRID_OFFSET[1]) < VOID_HALF + pad;
}

/**
 * The smooth, lobed part of urbanYear(); used where nothing was baked (beyond
 * ROAD_EXT). Cheap and angle-only beyond the radial length, so it has an exact
 * GLSL equivalent in render/glsl.ts (roadRaw's outside-baked branch) - keep
 * the two in sync if this changes.
 */
export function urbanYearFar(x: number, z: number): number {
  const dx = x - CITY_CENTER[0], dz = z - CITY_CENTER[1];
  return 1936 + Math.hypot(dx, dz) * urbanLobe(x, z) / 19.5;
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
