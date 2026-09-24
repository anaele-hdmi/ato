// All flat-roofed buildings: shops, blocks, towers, far city. One unit box, instanced.
// Height, windows, signs, abandonment and collapse are resolved in the shader.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON } from '../render/glsl';
import type { BoxRec } from './settlement';

const vert = /* glsl */ `
${COMMON}
attribute vec2 aLife;
attribute vec4 aShape;   // h0, h1, h2, kind
attribute vec4 aTimes;   // grow1, g2 start, g2 end, seed
attribute vec2 aDecay;   // abandon, collapse
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObj;
varying vec3 vSize;
varying vec4 vInfo;      // kind, seed, rot/abandon amount, collapse amount
void main() {
  if (uYear < aLife.x || uYear >= aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float seed = aTimes.w;
  float h = aShape.x + (aShape.y - aShape.x) * smoothstep(aLife.x, max(aTimes.x, aLife.x + 0.01), uYear)
          + (aShape.z - aShape.y) * smoothstep(aTimes.y, aTimes.z, uYear);
  // floors are added one at a time
  h = max(3.2, floor(h / 3.2 + 0.5) * 3.2);
  float build = smoothstep(aLife.x, aLife.x + 1.5 + h * 0.02, uYear);
  float collapse = smoothstep(aDecay.y, aDecay.y + 120.0 + seed * 260.0, uYear);
  float abandon = smoothstep(aDecay.x, aDecay.x + 25.0, uYear);
  vec3 sx = vec3(length(instanceMatrix[0].xyz), 1.0, length(instanceMatrix[2].xyz));
  vec3 p = position;
  float top = step(0.5, p.y);
  // broken tops: each corner falls at its own pace
  float corner = hash12(vec2(sign(p.x) + seed * 13.0, sign(p.z) + seed * 7.0));
  float hc = h * build * mix(1.0, 0.05 + 0.12 * seed, collapse * mix(0.75, 1.0, corner));
  hc = max(hc, 1.5);
  float y = mix(-3.0, hc, top);
  vec4 w = modelMatrix * instanceMatrix * vec4(p.x, 0.0, p.z, 1.0);
  w.y += y;
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vObj = vec3(p.x * sx.x, y, p.z * sx.z);
  vSize = vec3(sx.x, hc, sx.z);
  vInfo = vec4(aShape.w, seed, abandon, collapse);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObj;
varying vec3 vSize;
varying vec4 vInfo;
float box(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 n = normalize(vNormal);
  float kind = vInfo.x, seed = vInfo.y, abandon = vInfo.z, collapse = vInfo.w;
  bool shop = kind > 1.5 && kind < 2.5;
  bool tower = kind > 0.5 && kind < 1.5;
  // facade palette: concrete, beige, brick, dark tower skin
  vec3 fac = vec3(0.55, 0.54, 0.5);
  if (seed < 0.3) fac = vec3(0.62, 0.58, 0.5);
  else if (seed < 0.45) fac = vec3(0.46, 0.3, 0.24);
  if (tower || kind > 2.5) fac = mix(vec3(0.34, 0.36, 0.38), vec3(0.52, 0.52, 0.5), fract(seed * 7.3));
  if (shop) fac = mix(vec3(0.78, 0.76, 0.7), vec3(0.6, 0.62, 0.64), fract(seed * 3.1));
  vec3 col = fac;
  float glow = 0.0;
  vec3 glowCol = vec3(1.0, 0.72, 0.42);
  float y = vObj.y;
  float roof = step(0.5, n.y);
  if (roof > 0.5) {
    col = fac * 0.7;
    // rooftop plant
    vec2 q = vObj.xz;
    col *= 1.0 - 0.25 * box(fract(q / 7.0 + seed), vec2(0.2), vec2(0.55));
    // aviation light on tall roofs
    float tall = step(60.0, vSize.y);
    float corner = step(vSize.x * 0.5 - 1.2, abs(q.x)) * step(vSize.z * 0.5 - 1.2, abs(q.y));
    glow += corner * tall * uNight * step(0.5, fract(uTime * 0.5 + seed)) * 3.0 * (1.0 - abandon);
    glowCol = vec3(1.0, 0.15, 0.1);
  } else {
    float a = abs(n.x) > 0.5 ? vObj.z * sign(n.x) : -vObj.x * sign(n.z);
    float face = abs(n.x) > 0.5 ? (n.x > 0.0 ? 0.0 : 1.0) : (n.z > 0.0 ? 2.0 : 3.0);
    float floorH = 3.2;
    float fl = floor(y / floorH);
    float bayW = tower ? 1.8 : 2.6;
    float bay = floor(a / bayW);
    vec2 cell = vec2(fract(a / bayW), fract(y / floorH));
    float winW = tower ? 0.42 : 0.3;
    float win = box(cell, vec2(winW, 0.28), vec2(1.0 - winW * (tower ? 0.3 : 1.0), 0.82)) * step(0.0, y - 0.4);
    // stains running down from the sills
    float streak = vnoise(vec2(a * 0.7, y * 0.05 + seed * 9.0));
    col *= 1.0 - 0.18 * streak * smoothstep(0.3, 1.0, fract(a / bayW + 0.1)) - 0.25 * abandon * vnoise(vec2(a * 0.3, y * 0.1));
    vec3 glass = mix(vec3(0.07, 0.08, 0.09), uSkyAmb * 0.35, 0.4 + 0.3 * n.y);
    // shops: big ground floor glazing and a sign band
    float sign = 0.0;
    vec3 signCol = vec3(0.0);
    if (shop) {
      win = y < 3.0 ? box(cell, vec2(0.08, 0.05), vec2(0.92, 0.75)) : win;
      sign = step(3.0, y) * step(y, 3.9) * step(face, 1.5 + step(0.5, seed));
      signCol = seed < 0.3 ? vec3(0.62, 0.12, 0.08) : seed < 0.6 ? vec3(0.8, 0.62, 0.12) : vec3(0.1, 0.42, 0.44);
    } else if (fract(seed * 13.7) > 0.72 && face < 0.5 && y > vSize.y * 0.55 && y < vSize.y * 0.78 && vSize.y > 30.0) {
      sign = step(abs(a), min(vSize.z, vSize.x) * 0.3);
      signCol = mix(vec3(0.75, 0.1, 0.2), vec3(0.1, 0.5, 0.85), fract(seed * 29.0));
    }
    // marks that look like writing and are not
    float glyph = step(0.55, hash12(floor(vec2(a * 2.6, y * 3.0)) + seed));
    col = mix(col, glass, win);
    col = mix(col, mix(signCol, signCol * 0.35, glyph * 0.8), sign);
    // lit windows: slow turnover; lopsided and failing when things break down
    float slot = floor(uTime / 41.0 + hash12(vec2(bay, fl) + seed) * 3.0);
    float r = hash12(vec2(bay * 1.7 + slot * 0.13, fl * 3.1) + seed * 17.0);
    float side = vnoise(vWorld.xz * 0.004 + floor(uTime * 0.05) * 0.37);
    float frac = mix(0.42, mix(0.05, 0.75, step(0.5, side)), uChaos) * (1.0 - abandon);
    float lit = win * step(r, frac) * uNight;
    glowCol = mix(vec3(1.0, 0.72, 0.42), vec3(0.72, 0.84, 1.0), step(0.6, hash12(vec2(bay, fl) + seed * 3.0)));
    glow += lit * (0.7 + 0.5 * r);
    glow += sign * (0.6 + 0.6 * glyph) * uNight * (1.0 - abandon) * 1.6;
    if (sign > 0.5) glowCol = mix(glowCol, signCol * 1.5 + 0.2, 0.9);
    // broken windows once abandoned
    col = mix(col, vec3(0.03), win * abandon * step(0.4, hash12(vec2(bay, fl) + seed * 5.0)));
    // green creeping up from the ground
    float creep = smoothstep(0.0, 1.0, uWild * 1.4 - y / max(vSize.y, 1.0) * 0.8 - 0.3 + vnoise(vec2(a * 0.4, y * 0.3)) * 0.5);
    col = mix(col, grassColor(0.3) * 0.8, creep * abandon);
  }
  // scaffold colour while building
  float sh = sampleShadow(vWorld, n);
  vec3 c = shade(col, n, vWorld, 0.15, sh);
  c *= mix(0.6, 1.0, smoothstep(-1.0, 5.0, y));
  c += glowCol * glow;
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

export function buildBlocks(list: BoxRec[]): { mesh: THREE.InstancedMesh; depth: THREE.ShaderMaterial; births: number[] } {
  const sorted = [...list].sort((a, b) => a.birth - b.birth);
  const n = Math.max(1, sorted.length);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // drop the bottom face; it is never seen
  const idx = geo.getIndex()!.array as ArrayLike<number>;
  const keep: number[] = [];
  for (let f = 0; f < idx.length; f += 6) if (f !== 3 * 6) for (let k = 0; k < 6; k++) keep.push(idx[f + k]);
  geo.setIndex(keep);
  const life = new Float32Array(n * 2), shape = new Float32Array(n * 4), times = new Float32Array(n * 4), dec = new Float32Array(n * 2);
  const uniforms = { ...shared };
  const main = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag });
  const depth = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, defines: { DEPTH_PASS: 1 } });
  const mesh = new THREE.InstancedMesh(geo, main, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  sorted.forEach((b, i) => {
    q.setFromAxisAngle(up, b.rot);
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.sx, 1, b.sz));
    mesh.setMatrixAt(i, m);
    life.set([b.birth, b.death], i * 2);
    shape.set([b.h0, b.h1, b.h2, b.kind], i * 4);
    times.set([b.grow1, b.g2s, b.g2e, b.seed], i * 4);
    dec.set([b.abandon, b.collapse], i * 2);
  });
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(life, 2));
  geo.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4));
  geo.setAttribute('aTimes', new THREE.InstancedBufferAttribute(times, 4));
  geo.setAttribute('aDecay', new THREE.InstancedBufferAttribute(dec, 2));
  mesh.count = sorted.length;
  mesh.frustumCulled = false;
  return { mesh, depth, births: sorted.map((b) => b.birth) };
}

/** Number of entries in a sorted list that are <= year. */
export function bornBy(births: number[], year: number): number {
  let lo = 0, hi = births.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (births[mid] <= year) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
