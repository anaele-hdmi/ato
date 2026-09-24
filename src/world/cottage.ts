// Small pitched-roof houses. The first house and the village share this shape so
// the original never looks singled out.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON } from '../render/glsl';
import { PHOTO_FN } from '../render/photo-tex';
import { GeoBuilder } from './geo';

export const COTTAGE = { w: 6.0, d: 5.0, wall: 2.7, ridge: 1.9, over: 0.32 };

export function cottageGeometry(): THREE.BufferGeometry {
  const { w, d, wall, ridge, over } = COTTAGE;
  const b = new GeoBuilder();
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const hw = w / 2, hd = d / 2;
  // stone footing, walls
  b.box(V(-hw - 0.08, -0.6, -hd - 0.08), V(hw + 0.08, 0.28, hd + 0.08), 3);
  b.box(V(-hw, 0.28, -hd), V(hw, wall, hd), 0);
  // gable ends (ridge runs along x)
  b.tri(V(-hw, wall, -hd), V(-hw, wall, hd), V(-hw, wall + ridge, 0), 0);
  b.tri(V(hw, wall, hd), V(hw, wall, -hd), V(hw, wall + ridge, 0), 0);
  // roof with overhang, given a little thickness
  const ox = hw + over, oz = hd + over;
  const drop = (ridge / hd) * over;
  const t = 0.12;
  for (const sgn of [1, -1]) {
    const e0 = V(-ox, wall - drop, sgn * oz), e1 = V(ox, wall - drop, sgn * oz);
    const r0 = V(-ox, wall + ridge, 0), r1 = V(ox, wall + ridge, 0);
    if (sgn > 0) b.quad(e0, e1, r1, r0, 1);
    else b.quad(e1, e0, r0, r1, 1);
    const e0b = e0.clone().setY(e0.y - t), e1b = e1.clone().setY(e1.y - t);
    const r0b = r0.clone().setY(r0.y - t), r1b = r1.clone().setY(r1.y - t);
    if (sgn > 0) b.quad(e1b, e0b, r0b, r1b, 1);
    else b.quad(e0b, e1b, r1b, r0b, 1);
    if (sgn > 0) b.quad(e0b, e1b, e1, e0, 1);
    else b.quad(e1b, e0b, e0, e1, 1);
  }
  // chimney
  b.box(V(1.3, wall + 0.6, -1.2), V(1.85, wall + ridge + 0.75, -0.65), 2);
  // doorstep
  b.box(V(-0.6, -0.2, hd), V(0.6, 0.18, hd + 0.5), 3);
  return b.build('aPart');
}

const vert = /* glsl */ `
${COMMON}
attribute float aPart;
attribute vec2 aLife;
attribute float aSeed;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying float vPart;
varying float vSeed;
varying float vAge;
#ifdef USE_INSTANCING_COLOR
varying vec3 vColor;
#endif
void main() {
#ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
#endif
  float grow = smoothstep(aLife.x, aLife.x + 1.2, uYear);
  float alive = step(aLife.x, uYear) * (1.0 - step(aLife.y, uYear));
  if (alive < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = position;
  p.y = mix(-0.6, p.y, grow);
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vLocal = position;
  vPart = aPart;
  vSeed = aSeed;
  vAge = uYear - aLife.x;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
${COMMON}
${PHOTO_FN}
uniform float uWear;
// See blocks.ts: each window lights up at its own point in the dusk (function of
// uNight, not wall time) with a soft transition, and long exposure (uShadowFade
// -> 0) averages that into one steady glow instead of flicker.
float duskGate(float thr, float width, float night) {
  float g = smoothstep(thr - width, thr + width, night);
  return mix(night, g, uShadowFade);
}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying float vPart;
varying float vSeed;
varying float vAge;
#ifdef USE_INSTANCING_COLOR
varying vec3 vColor;
#endif
float rect(vec2 p, vec2 c, vec2 hs) {
  vec2 d = abs(p - c) - hs;
  return 1.0 - step(0.0, max(d.x, d.y));
}
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 n = normalize(vNormal);
  vec3 tint = vec3(0.85);
#ifdef USE_INSTANCING_COLOR
  tint = vColor;
#endif
  float age = clamp(vAge / 160.0, 0.0, 1.0);
  vec3 wall = tint * (1.0 - 0.28 * age) + vec3(0.02, 0.015, 0.0) * age;
  // rain streaks under the eaves
  float streak = vnoise(vec2(vLocal.x * 3.0 + vLocal.z * 3.0, vLocal.y * 0.4)) * smoothstep(1.2, 2.7, vLocal.y);
  wall *= 1.0 - 0.12 * streak * (0.3 + age);
  vec3 roof = mix(vec3(0.24, 0.2, 0.19), vec3(0.36, 0.17, 0.13), step(0.55, vSeed)) * (0.85 + 0.2 * vnoise(vLocal.xz * 2.0));
  // slates run along the ridge; distance down the slope is roughly |z| + height
  if (uPhoto > 0.5) roof *= photoDetail(uTexRoof, uMeanRoof, vec2(vLocal.x, abs(vLocal.z) * 1.15 + vLocal.y * 0.5) / 2.2, 0.35);
  vec3 stone = vec3(0.42, 0.4, 0.37) * (0.8 + 0.3 * vnoise(vLocal.xy * 4.0 + vLocal.zz));
  vec3 brick = vec3(0.35, 0.22, 0.17);
  vec3 col = vPart < 0.5 ? wall : vPart < 1.5 ? roof : vPart < 2.5 ? brick : stone;
  float lit = 0.0;
  if (vPart < 0.5 && abs(n.y) < 0.5) {
    vec2 q; float along;
    if (abs(n.z) > 0.5) { q = vec2(vLocal.x, vLocal.y); along = sign(n.z); }
    else { q = vec2(vLocal.z, vLocal.y); along = 2.0 * sign(n.x); }
    float win1 = 0.0, win2 = 0.0, door = 0.0;
    float cx1 = 0.0, cx2 = 0.0;
    if (along > 0.5 && along < 1.5) {
      cx1 = -1.7; cx2 = 1.7;
      win1 = rect(q, vec2(cx1, 1.55), vec2(0.42, 0.5));
      win2 = rect(q, vec2(cx2, 1.55), vec2(0.42, 0.5));
      door = rect(q, vec2(0.0, 1.05), vec2(0.42, 0.95));
    } else if (along < -0.5 && along > -1.5) {
      cx1 = -1.2; cx2 = 1.6;
      win1 = rect(q, vec2(cx1, 1.55), vec2(0.38, 0.45));
      win2 = rect(q, vec2(cx2, 1.55), vec2(0.38, 0.45));
    } else {
      cx1 = 3.1;
      win1 = rect(q, vec2(0.0, 1.55), vec2(0.36, 0.45));
    }
    float win = win1 + win2;
    vec3 glass = mix(uSkyAmb * 0.25, vec3(0.05, 0.06, 0.07), 0.5);
    col = mix(col, glass, win);
    col = mix(col, vec3(0.2, 0.15, 0.12), door);
    // each window is fixed lit-or-not (no wall-time turnover, so nothing pops) and
    // has its own point in the dusk ramp with its own soft transition width.
    float w1ever = step(0.25, hash11(vSeed * 91.0 + along * 13.0 + cx1 * 29.0));
    float w1thr = 0.12 + 0.68 * (hash11(vSeed * 53.0 + cx1 * 17.0) + hash11(vSeed * 71.0 + cx1 * 31.0 + 5.0)) * 0.5;
    float w1gate = duskGate(w1thr, 0.05 + 0.06 * hash11(vSeed * 97.0 + cx1 * 3.0), uNight);
    float w2ever = step(0.25, hash11(vSeed * 91.0 + along * 13.0 + cx2 * 29.0 + 3.0));
    float w2thr = 0.12 + 0.68 * (hash11(vSeed * 53.0 + cx2 * 17.0) + hash11(vSeed * 71.0 + cx2 * 31.0 + 5.0)) * 0.5;
    float w2gate = duskGate(w2thr, 0.05 + 0.06 * hash11(vSeed * 97.0 + cx2 * 3.0), uNight);
    lit = win1 * w1ever * w1gate + win2 * w2ever * w2gate;
  }
  float sh = sampleShadow(vWorld, n);
  vec3 c = shade(col, n, vWorld, 0.25, sh);
  // a little ambient occlusion where walls meet the ground
  c *= mix(0.72, 1.0, smoothstep(0.0, 1.2, vLocal.y));
  c += vec3(1.0, 0.68, 0.36) * lit * 0.9;
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

export function cottageMaterials(): { main: THREE.ShaderMaterial; depth: THREE.ShaderMaterial } {
  const uniforms = { ...shared, uWear: { value: 0 } };
  const main = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag });
  const depth = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, defines: { DEPTH_PASS: 1 } });
  return { main, depth };
}

export interface CottageInstance {
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
  birth: number;
  death: number;
  color: THREE.Color;
  seed: number;
}

export function buildCottages(list: CottageInstance[], mats: { main: THREE.ShaderMaterial }): THREE.InstancedMesh {
  const sorted = [...list].sort((a, b) => a.birth - b.birth);
  const geo = cottageGeometry();
  const n = Math.max(1, sorted.length);
  const life = new Float32Array(n * 2);
  const seed = new Float32Array(n);
  const mesh = new THREE.InstancedMesh(geo, mats.main, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  sorted.forEach((c, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rot);
    m.compose(new THREE.Vector3(c.x, c.y, c.z), q, new THREE.Vector3(c.scale, c.scale, c.scale));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.color);
    life[i * 2] = c.birth;
    life[i * 2 + 1] = c.death;
    seed[i] = c.seed;
  });
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(life, 2));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  mesh.count = sorted.length;
  mesh.frustumCulled = false;
  mesh.userData.births = sorted.map((c) => c.birth);
  return mesh;
}
