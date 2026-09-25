// Where and when things get built. Pure data: every lot carries its own sequence
// of buildings (house -> block -> tower), each with birth, death and decay years.
import * as THREE from 'three';
import { mulberry32 } from '../util/rand';
import type { CottageInstance } from './cottage';
import {
  BLOCK_U, BLOCK_V, CITY_CENTER, GRID_ANGLE, GRID_OFFSET, LANES, MAIN_ROAD, VOID_HALF,
  alongPolyline, distToPolyline, fromGrid, polylineLength, urbanYear, urbanYearFar, type V2,
} from './layout';

export const KIND_BLOCK = 0;
export const KIND_TOWER = 1;
export const KIND_SHOP = 2;
export const KIND_FAR = 3;

export interface BoxRec {
  x: number; y: number; z: number; rot: number;
  sx: number; sz: number;
  birth: number; death: number;
  h0: number; h1: number; h2: number;
  grow1: number; g2s: number; g2e: number;
  abandon: number; collapse: number;
  kind: number; seed: number;
}

export interface PoleRec { x: number; y: number; z: number; rot: number; birth: number; death: number; line: number }

export interface Settlement {
  cottages: CottageInstance[];
  boxes: BoxRec[];
  poles: PoleRec[];
  streets: { a: V2; b: V2; birth: number; main: boolean }[];
}

type Ground = (x: number, z: number) => number;

const PALETTE = [
  [0.86, 0.82, 0.72], [0.74, 0.74, 0.72], [0.6, 0.36, 0.3], [0.76, 0.63, 0.42],
  [0.62, 0.68, 0.72], [0.88, 0.87, 0.84], [0.7, 0.66, 0.58],
];

function roadClearance(x: number, z: number): number {
  let d = distToPolyline(x, z, MAIN_ROAD).d - 9.8;
  for (const l of LANES) d = Math.min(d, distToPolyline(x, z, l.pts).d - 6.5);
  return d;
}

/** Corners and centre of a rotated rectangle, for clearance tests. */
function footprint(x: number, z: number, rot: number, hx: number, hz: number): V2[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const pts: V2[] = [[x, z]];
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const lx = a * hx, lz = b * hz;
    pts.push([x + lx * c + lz * s, z - lx * s + lz * c]);
  }
  return pts;
}

function clear(x: number, z: number, rot: number, hx: number, hz: number): boolean {
  return footprint(x, z, rot, hx, hz).every(([px, pz]) => roadClearance(px, pz) > 0);
}

function baseY(ground: Ground, x: number, z: number, rot: number, hx: number, hz: number): number {
  return Math.min(...footprint(x, z, rot, hx, hz).map(([px, pz]) => ground(px, pz)));
}

export function buildSettlement(ground: Ground): Settlement {
  const rng = mulberry32(2024);
  const cottages: CottageInstance[] = [];
  const boxes: BoxRec[] = [];
  const poles: PoleRec[] = [];
  const streets: Settlement['streets'] = [];
  const color = () => {
    const p = PALETTE[Math.floor(rng() * PALETTE.length)];
    return new THREE.Color(p[0], p[1], p[2]).multiplyScalar(0.9 + rng() * 0.15);
  };
  const decay = (tall: boolean) => {
    const abandon = 2318 + rng() * 45;
    return { abandon, collapse: abandon + (tall ? 25 + rng() * 260 : 60 + rng() * 500) };
  };
  const ruinEnd = () => 2330 + 900 + rng() * 3500;

  // --- ribbon houses along the old roads, before the grid arrives
  const placed: V2[] = [];
  const ribbon = (pts: V2[], roadBirth: number, off: [number, number], p: number) => {
    const len = polylineLength(pts);
    for (let s = 20; s < len; s += 28 + rng() * 44) {
      const { p: q, dir } = alongPolyline(pts, s);
      for (const side of [1, -1]) {
        if (rng() > p) continue;
        const o = off[0] + rng() * (off[1] - off[0]);
        const x = q[0] - dir[1] * o * side, z = q[1] + dir[0] * o * side;
        if (Math.hypot(x, z) < 42 || Math.hypot(x, z) > 1150) continue;
        if (placed.some(([a, b]) => Math.hypot(a - x, b - z) < 16)) continue;
        const rot = Math.atan2(dir[1] * side, -dir[0] * side);
        if (!clear(x, z, rot, 3.6, 3.2)) continue;
        const uy = urbanYear(x, z);
        const birth = Math.max(roadBirth + 3, 1916 + rng() * 52);
        const death = uy - 1 - rng() * 3;
        if (death < birth + 12) continue;
        placed.push([x, z]);
        cottages.push({ x, y: ground(x, z), z, rot, scale: 0.92 + rng() * 0.3, birth, death, color: color(), seed: rng() });
      }
    }
  };
  // the neighbour, first of many
  cottages.push({ x: -58, y: ground(-58, -2), z: -2, rot: 0.25, scale: 1.05, birth: 1924.5, death: urbanYear(-58, -2) - 1, color: new THREE.Color(0.8, 0.75, 0.66), seed: 0.7 });
  placed.push([-58, -2]);
  ribbon(MAIN_ROAD, 1900, [12.5, 17], 0.62);
  for (const l of LANES.slice(1)) ribbon(l.pts, l.birth, [8, 12], 0.55);

  // --- shops by the road once it is paved
  for (const s0 of [1130, 1185, 1262, 1330, 1420]) {
    const { p: q, dir } = alongPolyline(MAIN_ROAD, s0);
    const side = s0 % 2 === 0 ? 1 : -1;
    const x = q[0] - dir[1] * 16 * side, z = q[1] + dir[0] * 16 * side;
    const rot = Math.atan2(dir[1] * side, -dir[0] * side);
    if (Math.hypot(x, z) < 30 || !clear(x, z, rot, 5, 4.5)) continue;
    const h = 3.6 + Math.floor(rng() * 2) * 3.1;
    boxes.push({
      x, y: baseY(ground, x, z, rot, 5, 4.5), z, rot, sx: 10, sz: 9, birth: 1953 + rng() * 22, death: urbanYear(x, z) + 8 + rng() * 10,
      h0: h, h1: h, h2: h, grow1: 0, g2s: 9e9, g2e: 9e9, abandon: 9e9, collapse: 9e9, kind: KIND_SHOP, seed: rng(),
    });
  }

  // --- the grid city: lots within reach, one box per block further out
  const rot = -GRID_ANGLE;
  const [ou, ov] = GRID_OFFSET;
  const range = 45;
  for (let j = -range; j <= range; j++) {
    for (let i = -range; i <= range; i++) {
      const cu = (i + 0.5) * BLOCK_U, cv = (j + 0.5) * BLOCK_V;
      const [bx, bz] = fromGrid(cu, cv);
      const dO = Math.hypot(bx, bz);
      const dC = Math.hypot(bx - CITY_CENTER[0], bz - CITY_CENTER[1]);
      if (dO > 3400) continue;
      // streets bounding this block, for the moving dots
      if (dO < 700) {
        const U = urbanYear(bx, bz);
        const c = (u: number, v: number) => fromGrid(u, v);
        streets.push({ a: c(i * BLOCK_U, j * BLOCK_V), b: c((i + 1) * BLOCK_U, j * BLOCK_V), birth: U + 4, main: false });
        streets.push({ a: c(i * BLOCK_U, j * BLOCK_V), b: c(i * BLOCK_U, (j + 1) * BLOCK_V), birth: U + 4, main: false });
      }
      if (dO > 900) {
        if (rng() > 1 - Math.max(0, (dC - 1900) / 1300)) {
          const U = urbanYearFar(bx, bz) + rng() * 8;
          const tall = rng() < Math.max(0.05, 0.7 - dC / 3500);
          const sx = 52 + rng() * 14, sz = 34 + rng() * 12;
          const { abandon, collapse } = decay(tall);
          const h1 = (3 + Math.floor(rng() * 7)) * 3.2;
          boxes.push({
            x: bx, y: baseY(ground, bx, bz, rot, sx / 2, sz / 2), z: bz, rot, sx, sz,
            birth: U + 2, death: ruinEnd(), h0: 6.4, h1, h2: tall ? h1 * (2 + rng() * 5) : h1 * 1.3,
            grow1: U + 30 + rng() * 20, g2s: 2050 + rng() * 60, g2e: 2160 + rng() * 110,
            abandon, collapse, kind: KIND_FAR, seed: rng(),
          });
        }
        continue;
      }
      // four lots per block
      const inner = [BLOCK_U - 13, BLOCK_V - 13];
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        let u0 = cu + (a < 0 ? -inner[0] / 2 : 1), u1 = cu + (a < 0 ? -1 : inner[0] / 2);
        let v0 = cv + (b < 0 ? -inner[1] / 2 : 1), v1 = cv + (b < 0 ? -1 : inner[1] / 2);
        // carve the square around the house site out of the lot
        const H = VOID_HALF + 1.5;
        if (u1 > ou - H && u0 < ou + H && v1 > ov - H && v0 < ov + H) {
          const cutU = (u0 + u1) / 2 > ou ? [Math.max(u0, ou + H), u1] : [u0, Math.min(u1, ou - H)];
          const cutV = (v0 + v1) / 2 > ov ? [Math.max(v0, ov + H), v1] : [v0, Math.min(v1, ov - H)];
          if (cutU[1] - cutU[0] >= cutV[1] - cutV[0]) { u0 = cutU[0]; u1 = cutU[1]; } else { v0 = cutV[0]; v1 = cutV[1]; }
        }
        if (u1 - u0 < 7 || v1 - v0 < 7) continue;
        const [x, z] = fromGrid((u0 + u1) / 2, (v0 + v1) / 2);
        const hx = (u1 - u0) / 2, hz = (v1 - v0) / 2;
        if (!clear(x, z, rot, hx, hz)) continue;
        const U = urbanYear(x, z);
        const y = baseY(ground, x, z, rot, hx, hz);
        const nearHouse = Math.hypot(x, z) < 90;
        const central = dC < 650 || Math.hypot(x, z) < 480;
        // 1: small houses
        const d1 = U + 16 + rng() * 22;
        if (rng() < 0.75 && hx > 4 && hz > 4) {
          const sc = Math.min(1.2, Math.min(hx, hz) / 4.5);
          cottages.push({ x, y, z, rot: rot + (rng() < 0.5 ? 0 : Math.PI), scale: sc, birth: U + 1 + rng() * 8, death: d1, color: color(), seed: rng() });
        }
        // 2: blocks of flats and offices
        const b2 = d1 + 1 + rng() * 2;
        const floors2 = 3 + Math.floor(rng() * 6);
        const d2 = central ? Math.max(b2 + 30, (nearHouse ? 2046 : 2040) + rng() * (nearHouse ? 18 : 60)) : ruinEnd();
        const tall2 = !central;
        const dk2 = decay(false);
        boxes.push({
          x, y, z, rot, sx: hx * 2 - 2, sz: hz * 2 - 2, birth: b2, death: d2,
          h0: floors2 * 3.2, h1: floors2 * 3.2, h2: tall2 ? floors2 * 3.2 + Math.floor(rng() * 4) * 3.2 : floors2 * 3.2,
          grow1: b2, g2s: 2060 + rng() * 60, g2e: 2120 + rng() * 80, abandon: dk2.abandon, collapse: dk2.collapse, kind: KIND_BLOCK, seed: rng(),
        });
        // 3: towers where it is central; some keep growing past reason
        if (central) {
          const floors3 = 14 + Math.floor(rng() * 30);
          const mega = rng() < (nearHouse ? 0.6 : 0.35);
          const dk3 = decay(true);
          boxes.push({
            x, y, z, rot, sx: hx * 2 - 3, sz: hz * 2 - 3, birth: d2 + 1.5, death: ruinEnd(),
            h0: floors3 * 3.2, h1: floors3 * 3.2, h2: mega ? floors3 * 3.2 * (1.8 + rng() * 1.8) : floors3 * 3.2,
            grow1: d2 + 1.5, g2s: 2150 + rng() * 40, g2e: 2230 + rng() * 60,
            abandon: dk3.abandon, collapse: dk3.collapse, kind: KIND_TOWER, seed: rng(),
          });
        }
      }
    }
  }

  // --- poles: along the old road, then moved back when it is widened; along lanes; in the near grid
  let line = 0;
  const poleLine = (pts: V2[], off: number, spacing: number, birth: () => number, death: () => number, maxR: number) => {
    const len = polylineLength(pts);
    line++;
    for (let s = 5; s < len; s += spacing) {
      const { p: q, dir } = alongPolyline(pts, s);
      const x = q[0] - dir[1] * off, z = q[1] + dir[0] * off;
      if (Math.hypot(x, z) > maxR) continue;
      if (Math.hypot(x, z) < 10) continue;
      poles.push({ x, y: ground(x, z), z, rot: Math.atan2(dir[0], dir[1]), birth: birth(), death: death(), line });
    }
  };
  poleLine(MAIN_ROAD, 6.2, 38, () => 1951 + rng() * 4, () => 1996 + rng() * 2, 1000);
  poleLine(MAIN_ROAD, -11.6, 34, () => 1996 + rng() * 3, () => 2135 + rng() * 20, 900);
  for (const l of LANES.slice(1)) poleLine(l.pts, 4.4, 36, () => Math.max(l.birth + 18, 1956) + rng() * 5, () => 2100 + rng() * 40, 1000);
  for (let j = -6; j <= 6; j++) {
    const v = j * BLOCK_V + 5.8;
    const pts: V2[] = [fromGrid(-7 * BLOCK_U, v), fromGrid(7 * BLOCK_U, v)];
    const mid = fromGrid(0, v);
    const U = urbanYear(mid[0], mid[1]);
    poleLine(pts, 0, 29, () => U + 6 + rng() * 4, () => 2120 + rng() * 30, 520);
  }

  // main road for dots
  const mlen = polylineLength(MAIN_ROAD);
  for (let s = 0; s < mlen - 40; s += 40) {
    const a = alongPolyline(MAIN_ROAD, s).p, b = alongPolyline(MAIN_ROAD, s + 40).p;
    if (Math.hypot(a[0], a[1]) < 800) streets.push({ a, b, birth: 1985 + rng() * 5, main: true });
  }
  return { cottages, boxes, poles, streets };
}
