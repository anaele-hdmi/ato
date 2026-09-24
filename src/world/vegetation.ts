// Trees as foam-like impostor crowns (like model-railway foliage) with prism trunks.
// Far away a tree is a single point. The apple tree is just one of them.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';
import { PHOTO_FN } from '../render/photo-tex';
import type { SunShadow } from '../render/shadow';
import { fbm, mulberry32 } from '../util/rand';
import { DEEP_BASE_YEAR, START_YEAR } from '../time/time-model';
import { LANES, MAIN_ROAD, alongPolyline, distToPolyline, polylineLength, urbanYear } from './layout';

export const KIND = { decid: 0, conifer: 1, apple: 2, hedge: 3 } as const;
const FOREVER = 1e10;

interface TreeRec {
  x: number; z: number; size: number;
  birth: number; death: number;
  kind: number; deep: boolean; seed: number;
}

export const APPLE_TREE = { x: -6.2, z: 4.4 };

function placeTrees(): TreeRec[] {
  const rng = mulberry32(777);
  const out: TreeRec[] = [];
  const roadDist = (x: number, z: number) => {
    let d = distToPolyline(x, z, MAIN_ROAD).d;
    for (const l of LANES) d = Math.min(d, distToPolyline(x, z, l.pts).d);
    return d;
  };
  out.push({ ...APPLE_TREE, size: 4.4, birth: 1893, death: 2166, kind: KIND.apple, deep: false, seed: 0.37 });

  // a few old trees on the hill, not arranged around the house
  for (const [x, z, sz] of [[-31, -24, 13], [-38, -9, 11], [33, -33, 14], [48, -21, 10], [-63, 27, 12], [19, -52, 15], [74, 12, 9], [-18, 46, 8]]) {
    out.push({ x, z, size: sz, birth: 1800 + rng() * 60, death: urbanYear(x, z) + 4 + rng() * 10, kind: KIND.decid, deep: false, seed: rng() });
  }
  // hedgerows along the old field edges near the house
  for (const [ax, az, bx, bz] of [[-70, -34, 60, -40], [60, -40, 90, 40], [-70, -34, -95, 45]]) {
    const len = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t < len; t += 1.3 + rng() * 0.8) {
      const x = ax + ((bx - ax) * t) / len + (rng() - 0.5) * 1.5, z = az + ((bz - az) * t) / len + (rng() - 0.5) * 1.5;
      out.push({ x, z, size: 2.4 + rng() * 1.6, birth: 1884 + rng() * 10, death: urbanYear(x, z) - rng() * 5, kind: KIND.hedge, deep: false, seed: rng() });
    }
  }
  // countryside: woodlots, hedgerows and lone trees, felled as the city arrives
  const C = 26;
  for (let z = -1000; z < 1000; z += C) {
    for (let x = -1000; x < 1000; x += C) {
      const px = x + rng() * C, pz = z + rng() * C;
      if (Math.hypot(px, pz) < 16) continue;
      const rd = roadDist(px, pz);
      if (rd < 5) continue;
      const wood = fbm(px / 260, pz / 260, 3, 55);
      const p = wood > 0.16 ? 0.85 : rd < 11 ? 0.3 : 0.035;
      if (rng() > p) continue;
      const uy = urbanYear(px, pz);
      const planted = rng() < 0.12;
      out.push({
        x: px, z: pz, size: 7 + rng() * 8,
        birth: planted ? 1905 + rng() * 70 : 1780 + rng() * 100,
        death: Math.min(uy - 3 + rng() * 14, 2320),
        kind: rng() < (wood > 0.3 ? 0.35 : 0.1) ? KIND.conifer : KIND.decid,
        deep: false, seed: rng(),
      });
    }
  }
  // avenue trees along the widened road
  const len = polylineLength(MAIN_ROAD);
  for (let s = 0; s < len; s += 12) {
    const { p, dir } = alongPolyline(MAIN_ROAD, s);
    if (Math.hypot(p[0], p[1]) > 700) continue;
    for (const side of [1, -1]) {
      const x = p[0] - dir[1] * 9.6 * side, z = p[1] + dir[0] * 9.6 * side;
      if (Math.abs(x) < 16 && Math.abs(z) < 16) continue;
      out.push({ x, z, size: 6 + rng() * 2, birth: 1996 + rng() * 6, death: 2322 + rng() * 60, kind: KIND.decid, deep: false, seed: rng() });
    }
  }
  // what comes back: seeded into rubble and roads after people leave
  const W = 24;
  for (let z = -1150; z < 1150; z += W) {
    for (let x = -1150; x < 1150; x += W) {
      const px = x + rng() * W, pz = z + rng() * W;
      if (Math.hypot(px, pz) > 1150) continue;
      out.push({
        x: px, z: pz, size: 8 + rng() * 11,
        birth: 2345 + rng() * 240 + Math.max(0, 2050 - urbanYear(px, pz)) * 0.2,
        death: FOREVER,
        kind: rng() < 0.3 ? KIND.conifer : KIND.decid,
        deep: true, seed: rng(),
      });
    }
  }
  // the wildwood that grows in after the ice and is cleared, tree by tree, for pasture
  const P = 23;
  for (let z = -1100; z < 1100; z += P) {
    for (let x = -1100; x < 1100; x += P) {
      const px = x + rng() * P, pz = z + rng() * P;
      const r = Math.hypot(px, pz);
      if (r > 1100) continue;
      const grove = fbm(px / 260, pz / 260, 3, 55) > 0.16;
      const cleared = r < 20 ? 1780 + rng() * 60 : 1640 + Math.min(r, 900) * 0.15 + rng() * 120;
      out.push({
        x: px, z: pz, size: 11 + rng() * 13,
        birth: START_YEAR + 700 + rng() * 2600 + r * 0.3,
        death: grove && r > 60 ? Math.min(urbanYear(px, pz) - 2, 2300) : cleared,
        kind: rng() < 0.4 ? KIND.conifer : KIND.decid,
        deep: false, seed: rng(),
      });
    }
  }
  return out.sort((a, b) => a.birth - b.birth);
}

const CROWN_ATTR = /* glsl */ `
attribute vec3 aPos;
attribute vec2 aLife;
attribute vec3 aMeta;
uniform float uCover;
uniform float uLodDist;
float treeHidden(float gy) {
  if (uYear < aLife.x || uYear >= aLife.y) return 1.0;
  if (aMeta.z > 0.5 && hash11(aMeta.y * 713.1) > uCover) return 1.0;
  if (gy < uSeaLevel + 0.4) return 1.0;
  return 0.0;
}
float treeGrow() { return 0.3 + 0.7 * smoothstep(aLife.x, aLife.x + 30.0, uYear); }
vec4 blobOf(float kind, float i, float seed) {
  vec3 j = vec3(hash11(seed * 31.0 + i) - 0.5, hash11(seed * 57.0 + i) - 0.5, hash11(seed * 91.0 + i) - 0.5) * 0.12;
  if (kind > 0.5 && kind < 1.5) {
    if (i < 0.5) return vec4(vec3(0.0, 0.36, 0.0) + j * 0.3, 0.25);
    if (i < 1.5) return vec4(vec3(0.0, 0.58, 0.0) + j * 0.3, 0.19);
    return vec4(vec3(0.0, 0.8, 0.0) + j * 0.3, 0.12);
  }
  if (kind > 2.5) {
    if (i < 0.5) return vec4(vec3(-0.25, 0.32, 0.0) + j, 0.4);
    if (i < 1.5) return vec4(vec3(0.25, 0.36, 0.05) + j, 0.42);
    return vec4(vec3(0.0, 0.5, -0.05) + j, 0.34);
  }
  if (kind > 1.5) {
    if (i < 0.5) return vec4(vec3(0.0, 0.58, 0.0) + j, 0.36);
    if (i < 1.5) return vec4(vec3(0.24, 0.64, 0.06) + j, 0.25);
    return vec4(vec3(-0.22, 0.66, -0.07) + j, 0.26);
  }
  if (i < 0.5) return vec4(vec3(0.0, 0.62, 0.0) + j, 0.31);
  if (i < 1.5) return vec4(vec3(0.17, 0.74, 0.1) + j, 0.24);
  return vec4(vec3(-0.15, 0.8, -0.08) + j, 0.23);
}
`;

const CROWN_COLOR = /* glsl */ `
vec3 crownColor(float kind, float seed) {
  float s = uSeason;
  if (kind > 0.5 && kind < 1.5) return vec3(0.11, 0.16, 0.11) * (0.85 + 0.3 * seed);
  vec3 spring = vec3(0.3, 0.38, 0.17);
  vec3 summer = vec3(0.15, 0.22, 0.1);
  vec3 autumn = mix(vec3(0.46, 0.3, 0.15), vec3(0.5, 0.42, 0.2), seed);
  vec3 winter = vec3(0.27, 0.23, 0.19);
  vec3 c = winter;
  c = mix(c, spring, smoothstep(0.2, 0.32, s));
  c = mix(c, summer, smoothstep(0.42, 0.56, s));
  c = mix(c, autumn, smoothstep(0.68, 0.8, s));
  c = mix(c, winter, smoothstep(0.86, 0.95, s));
  c = mix(vec3(0.21, 0.28, 0.13), c, uSeasonality);
  c = mix(c, vec3(0.32, 0.28, 0.17), uArid * 0.6);
  return c * (0.85 + 0.3 * seed);
}
float bareness(float kind) {
  if (kind > 0.5 && kind < 1.5) return 0.0;
  float w = smoothstep(0.86, 0.95, uSeason) + 1.0 - smoothstep(0.14, 0.26, uSeason);
  return clamp(w, 0.0, 1.0) * uSeasonality;
}
`;

const crownVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${CROWN_ATTR}
${CROWN_COLOR}
attribute vec2 aCorner;
attribute float aBlob;
varying vec2 vCorner;
varying vec3 vCenter;
varying float vR;
varying vec3 vMeta;
void main() {
  vec2 xz = aPos.xy;
  float gy = terrainHeight(xz);
  vec3 root = vec3(xz.x, gy, xz.y);
#ifndef DEPTH_PASS
  if (distance(root, cameraPosition) > uLodDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  if (treeHidden(gy) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float size = aPos.z * treeGrow();
  vec4 b = blobOf(aMeta.x, aBlob, aMeta.y);
  vec3 center = root + b.xyz * size;
  float r = b.w * size;
  vec4 mv = viewMatrix * vec4(center, 1.0);
  mv.xy += aCorner * r;
  vCorner = aCorner;
  vCenter = center;
  vR = r;
  vMeta = aMeta;
  gl_Position = projectionMatrix * mv;
}
`;

const crownFrag = /* glsl */ `
${COMMON}
${PHOTO_FN}
${CROWN_COLOR}
varying vec2 vCorner;
varying vec3 vCenter;
varying float vR;
varying vec3 vMeta;
// Nearest leaf cluster: distance, offset to its centre, and an id.
vec4 clusters(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float best = 9.0;
  vec2 bo = vec2(0.0);
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 17.3)) * 0.8 + 0.1;
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < best) { best = d; bo = r; id = hash12(i + g + 3.7); }
    }
  }
  return vec4(sqrt(best), bo, id);
}
void main() {
  float kind = vMeta.x, seed = vMeta.y;
  float r2 = dot(vCorner, vCorner);
  float lump = vnoise(vCorner * 3.2 + seed * 40.0);
  vec4 cl = clusters(vCorner * 4.2 + seed * 13.0);
  // a scalloped, leafy outline instead of a smooth ball
  if (r2 + 0.45 * cl.x * smoothstep(0.35, 1.0, r2) > 1.0 - 0.18 * lump) discard;
  float bare = bareness(kind);
  float holes = vnoise(vCorner * 11.0 + seed * 17.0);
  if (holes < bare * 0.72 + 0.04) discard;
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 nv = vec3(vCorner, sqrt(max(1.0 - r2, 0.0)));
  // each cluster bulges on its own, so light breaks up across the crown
  nv.xy -= cl.yz * 0.9;
  nv.xy += (vec2(vnoise(vCorner * 19.0 + seed), vnoise(vCorner * 19.0 + seed + 5.0)) - 0.5) * 0.35;
  nv = normalize(nv);
  vec3 n = normalize((vec4(nv, 0.0) * viewMatrix).xyz);
  vec3 wp = vCenter + n * vR * 0.8;
  vec3 col = crownColor(kind, seed) * (0.85 + 0.3 * cl.w);
  // a photograph of real leaves lends the crown its grain
  if (uPhoto > 0.5) col *= photoDetail(uTexLeaves, uMeanLeaves, vCorner * 0.45 * vR / 3.0 + seed * 7.0, 0.15);
  col = mix(col, vec3(0.24, 0.19, 0.15), bare);
  if (kind > 1.5) {
    float dots = step(0.8, vnoise(vCorner * 16.0 + 3.0));
    float blossom = win(uSeason, 0.25, 0.28, 0.34, 0.38) * uSeasonality;
    float fruit = win(uSeason, 0.63, 0.67, 0.76, 0.8) * uSeasonality;
    col = mix(col, vec3(0.86, 0.8, 0.8), dots * blossom);
    col = mix(col, vec3(0.5, 0.12, 0.08), dots * fruit);
  }
  col = mix(col, vec3(0.85, 0.87, 0.9), snowCover() * smoothstep(0.2, 0.8, n.y) * 0.8);
  // deep gaps between clusters
  col *= mix(0.45, 1.0, 1.0 - smoothstep(0.3, 0.8, cl.x));
  float ao = 0.55 + 0.45 * smoothstep(-1.0, 0.9, vCorner.y + nv.z * 0.4);
  float sh = sampleShadow(wp, n);
  vec3 c = shade(col * ao, n, wp, 0.45, sh);
  gl_FragColor = finalOut(applyFog(c, wp));
}
`;

const trunkVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${CROWN_ATTR}
${CROWN_COLOR}
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec2 xz = aPos.xy;
  float gy = terrainHeight(xz);
  vec3 root = vec3(xz.x, gy, xz.y);
  if (treeHidden(gy) > 0.5 || aMeta.x > 2.5 || distance(root, cameraPosition) > uLodDist * 0.6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float size = aPos.z * treeGrow();
  float h = aMeta.x > 0.5 && aMeta.x < 1.5 ? 0.5 : 0.62;
  vec3 p = position;
  p.xz *= size * 0.028 * (1.0 - 0.5 * p.y);
  p.y *= size * h;
  vWorld = root + p;
  vNormal = normalize(vec3(normal.x, 0.2, normal.z));
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const trunkFrag = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 col = vec3(0.2, 0.17, 0.14) * (0.8 + 0.4 * vnoise(vWorld.xy * 6.0));
  vec3 c = shade(col, normalize(vNormal), vWorld, 0.3, sampleShadow(vWorld, vNormal));
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

const pointVert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${CROWN_ATTR}
${CROWN_COLOR}
uniform float uProjScale;
varying vec3 vCol;
varying vec3 vWorld;
void main() {
  vec2 xz = aPos.xy;
  float gy = terrainHeight(xz);
  vec3 root = vec3(xz.x, gy, xz.y);
  float d = distance(root, cameraPosition);
  if (d <= uLodDist || treeHidden(gy) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float size = aPos.z * treeGrow();
  vec3 c = root + vec3(0.0, size * 0.65, 0.0);
  vWorld = c;
  vec3 col = mix(crownColor(aMeta.x, aMeta.y), vec3(0.26, 0.22, 0.18), bareness(aMeta.x) * 0.7);
  col = mix(col, vec3(0.85, 0.87, 0.9), snowCover() * 0.6);
  vCol = col * (0.6 + 0.5 * max(uSunDir.y, 0.0));
  vec4 mv = viewMatrix * vec4(c, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(size * 0.75 * uProjScale / -mv.z, 1.0, 28.0);
}
`;

const pointFrag = /* glsl */ `
${COMMON}
varying vec3 vCol;
varying vec3 vWorld;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  vec3 c = vCol * (0.75 + 0.35 * (1.0 - q.y) * 0.5) * (uSkyAmb + uSunColor * 0.4);
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

function crownGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const corner: number[] = [], blob: number[] = [], idx: number[] = [];
  for (let b = 0; b < 3; b++) {
    const o = b * 4;
    corner.push(-1, -1, 1, -1, 1, 1, -1, 1);
    blob.push(b, b, b, b);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12 * 3).fill(0), 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute('aBlob', new THREE.Float32BufferAttribute(blob, 1));
  g.setIndex(idx);
  return g;
}

function trunkGeometry(): THREE.InstancedBufferGeometry {
  const src = new THREE.CylinderGeometry(1, 1, 1, 3, 1, true).translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', src.getAttribute('position'));
  g.setAttribute('normal', src.getAttribute('normal'));
  g.setIndex(src.getIndex());
  return g;
}

export class Vegetation {
  readonly group = new THREE.Group();
  private trees: TreeRec[];
  private births: number[];
  private geos: THREE.InstancedBufferGeometry[] = [];
  private points: THREE.Points;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(shadow: SunShadow) {
    this.trees = placeTrees();
    this.births = this.trees.map((t) => t.birth);
    const n = this.trees.length;
    const pos = new Float32Array(n * 3), life = new Float32Array(n * 2), meta = new Float32Array(n * 3);
    this.trees.forEach((t, i) => {
      pos.set([t.x, t.z, t.size], i * 3);
      life.set([t.birth, t.death], i * 2);
      meta.set([t.kind, t.seed, t.deep ? 1 : 0], i * 3);
    });
    const aPos = new THREE.InstancedBufferAttribute(pos, 3);
    const aLife = new THREE.InstancedBufferAttribute(life, 2);
    const aMeta = new THREE.InstancedBufferAttribute(meta, 3);
    this.uniforms = { ...shared, uCover: { value: 1 }, uLodDist: { value: 700 }, uProjScale: { value: 800 } };

    const mk = (vs: string, fs: string, depth = false, extra: Partial<THREE.ShaderMaterialParameters> = {}) =>
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: vs, fragmentShader: fs, defines: depth ? { DEPTH_PASS: 1 } : {}, ...extra });

    const crownGeo = crownGeometry();
    const trunkGeo = trunkGeometry();
    for (const g of [crownGeo, trunkGeo]) {
      g.setAttribute('aPos', aPos);
      g.setAttribute('aLife', aLife);
      g.setAttribute('aMeta', aMeta);
      this.geos.push(g);
    }
    const crowns = new THREE.Mesh(crownGeo, mk(crownVert, crownFrag));
    const trunks = new THREE.Mesh(trunkGeo, mk(trunkVert, trunkFrag));
    for (const m of [crowns, trunks]) m.frustumCulled = false;
    shadow.add(crowns, mk(crownVert, crownFrag, true));
    shadow.add(trunks, mk(trunkVert, trunkFrag, true));

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    pg.setAttribute('aPos', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('aLife', new THREE.BufferAttribute(life, 2));
    pg.setAttribute('aMeta', new THREE.BufferAttribute(meta, 3));
    this.points = new THREE.Points(pg, mk(pointVert, pointFrag));
    this.points.frustumCulled = false;
    this.group.add(trunks, crowns, this.points);
  }

  update(year: number, cover: number, projScale: number): void {
    // Only instances already born are drawn; the list is sorted by birth.
    let lo = 0, hi = this.births.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.births[mid] <= year) lo = mid + 1;
      else hi = mid;
    }
    for (const g of this.geos) g.instanceCount = lo;
    this.points.geometry.setDrawRange(0, lo);
    this.uniforms.uCover.value = cover;
    this.uniforms.uProjScale.value = projScale;
  }

  static deepCover(year: number, forest: number, glacial: number): number {
    return year < DEEP_BASE_YEAR + 3000 ? 1 : forest * (1 - glacial);
  }
}
