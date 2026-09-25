// A crowd for the city era: small faceless walkers filling the sidewalks. The pool
// travels with the view over the analytic street grid (like the grass), and each
// block seeds its own walkers, so they stay where they are as the window slides.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shared } from '../render/shared';
import { COMMON, ROADS_FN, TERRAIN_FN } from '../render/glsl';
import type { SunShadow } from '../render/shadow';
import { BLOCK_U, BLOCK_V, toGrid } from './layout';
import { GRID_DEFINES, GRID_FN } from './terrain';

const SPAN = 2; // blocks each side of the centre block
const PER_BLOCK = 90;
const LOD_NEAR = 170;
const LOD_FAR = 230;

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${ROADS_FN}
${GRID_FN}
uniform float uAmount;
uniform vec2 uCenterBlock;
attribute vec3 aPivot;   // where this vertex's part hangs from (hip/shoulder)
attribute float aSwing;  // signed swing per part (0 for head/torso)
attribute float aTone;   // 0 = clothed body, 1 = head
attribute vec3 aSlot;    // block offset from the centre block, slot index in that block
varying vec3 vWorld;
varying vec3 vNormal;
varying float vTone;
varying vec3 vCloth;
vec2 fromGridG(vec2 g) {
  float c = cos(GRID_ANGLE), s = sin(GRID_ANGLE);
  vec2 a = g - vec2(GRID_OFF_U, GRID_OFF_V);
  return vec2(a.x * c - a.y * s, a.x * s + a.y * c);
}
void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
void main() {
  vec2 blk = uCenterBlock + aSlot.xy;
  float id = hash12(blk * 7.13 + aSlot.z * 0.731);
  float h2 = hash12(blk * 3.71 + aSlot.z * 1.37 + 5.1);
  float h3 = hash12(blk * 1.33 + aSlot.z * 2.11 + 9.7);
  // thin with the hour of the city, and each walker leaves for good some time in the bad years
  if (id > uAmount || uYear > 2298.0 + 32.0 * fract(id * 3.97)) { hide(); return; }
  bool alongU = h2 < ${(BLOCK_U / (BLOCK_U + BLOCK_V)).toFixed(3)};
  float len = alongU ? BLOCK_U : BLOCK_V;
  float speed = h3 < 0.25 ? 0.0 : 0.6 + 0.8 * fract(h3 * 7.3);
  float dir = fract(id * 13.1) < 0.5 ? 1.0 : -1.0;
  float side = fract(id * 29.7) < 0.5 ? 1.0 : -1.0;
  float s = fract(fract(id * 51.3) + dir * uTime * speed / len);
  float lateral = side * (mix(3.5, 5.5, uAvenue) + 1.0 + 1.6 * fract(id * 5.3));
  vec2 g = alongU ? vec2((blk.x + s) * BLOCK_U, blk.y * BLOCK_V + lateral) : vec2(blk.x * BLOCK_U + lateral, (blk.y + s) * BLOCK_V);
  vec2 xz = fromGridG(g);
  vec2 tg = alongU ? vec2(cos(GRID_ANGLE), sin(GRID_ANGLE)) : vec2(-sin(GRID_ANGLE), cos(GRID_ANGLE));
  // only where the city already stands, and never in the square
  if (uYear < yearN(roadRaw(xz).a) + 6.0 || voidMask(xz) > 0.5) { hide(); return; }
  float y0 = terrainHeight(xz);
  float dCam = length(vec3(xz.x, y0, xz.y) - cameraPosition);
  float fade = 1.0 - smoothstep(${LOD_NEAR.toFixed(1)}, ${LOD_FAR.toFixed(1)}, dCam);
  if (fade <= 0.001) { hide(); return; }

  float moving = step(0.02, speed);
  float phase = uTime * (2.1 + speed * 2.6) + id * 23.0;
  float ang = sin(phase) * aSwing * moving;
  float ca = cos(ang), sa = sin(ang);
  vec3 lp = position - aPivot;
  lp = vec3(lp.x, lp.y * ca - lp.z * sa, lp.y * sa + lp.z * ca) + aPivot;
  vec3 nrmL = normalize(vec3(normal.x, normal.y * ca - normal.z * sa, normal.y * sa + normal.z * ca));
  lp *= (0.86 + 0.22 * fract(id * 11.7)) * fade;

  float bob = abs(sin(phase)) * 0.03 * moving;
  float sway = sin(uTime * 0.7 + id * 30.0) * 0.05 * (1.0 - moving);
  float yaw = atan(tg.x * dir, tg.y * dir) + sway + (1.0 - moving) * (fract(id * 71.0) - 0.5) * 3.0;
  float cy = cos(yaw), sy = sin(yaw);
  vec3 wp = vec3(lp.x * cy + lp.z * sy, lp.y + bob, -lp.x * sy + lp.z * cy);
  vec3 nrmW = vec3(nrmL.x * cy + nrmL.z * sy, nrmL.y, -nrmL.x * sy + nrmL.z * cy);

  // dark, muted clothes
  float pick = fract(id * 97.1);
  vCloth = pick < 0.2 ? vec3(0.16, 0.15, 0.13) : pick < 0.4 ? vec3(0.13, 0.15, 0.18) : pick < 0.6 ? vec3(0.2, 0.16, 0.12)
         : pick < 0.8 ? vec3(0.17, 0.17, 0.16) : vec3(0.23, 0.19, 0.16);
  vCloth *= 0.85 + 0.3 * fract(id * 19.3);
  vec3 world = vec3(xz.x + wp.x, y0 + wp.y, xz.y + wp.z);
  vWorld = world;
  vNormal = normalize(nrmW);
  vTone = aTone;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const frag = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
varying float vTone;
varying vec3 vCloth;
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 n = normalize(vNormal);
  vec3 albedo = mix(vCloth, vec3(0.47, 0.43, 0.38), vTone);
  vec3 c = shade(albedo, n, vWorld, 0.3, sampleShadow(vWorld, n));
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

interface PartSpec {
  geo: THREE.BufferGeometry;
  pivot: THREE.Vector3;
  swing: number;
  tone: number;
}

function withPartAttrs(p: PartSpec): THREE.BufferGeometry {
  const n = p.geo.attributes.position.count;
  const pivot = new Float32Array(n * 3);
  const swing = new Float32Array(n);
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pivot[i * 3] = p.pivot.x; pivot[i * 3 + 1] = p.pivot.y; pivot[i * 3 + 2] = p.pivot.z;
    swing[i] = p.swing;
    tone[i] = p.tone;
  }
  p.geo.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 3));
  p.geo.setAttribute('aSwing', new THREE.BufferAttribute(swing, 1));
  p.geo.setAttribute('aTone', new THREE.BufferAttribute(tone, 1));
  // Keep the built-in index: shared vertices are what keep 2000 figures affordable.
  p.geo.deleteAttribute('uv');
  return p.geo;
}

/** One figure's body, head to feet, as a single mesh with a per-vertex limb pivot. */
function buildFigureGeometry(): THREE.BufferGeometry {
  const parts: PartSpec[] = [
    { geo: new THREE.SphereGeometry(0.115, 7, 5).translate(0, 1.53, 0).scale(1, 1.08, 1), pivot: new THREE.Vector3(), swing: 0, tone: 1 },
    { geo: new THREE.CapsuleGeometry(0.17, 0.36, 2, 6).scale(1, 1, 0.68).translate(0, 1.13, 0), pivot: new THREE.Vector3(), swing: 0, tone: 0 },
  ];
  for (const sgn of [1, -1]) {
    parts.push({
      geo: new THREE.CapsuleGeometry(0.068, 0.72, 1, 5).translate(sgn * 0.085, 0.46, 0),
      pivot: new THREE.Vector3(sgn * 0.085, 0.86, 0), swing: 0.42 * sgn, tone: 0,
    });
    parts.push({
      geo: new THREE.CapsuleGeometry(0.05, 0.52, 1, 5).translate(sgn * 0.215, 1.06, 0),
      pivot: new THREE.Vector3(sgn * 0.215, 1.36, 0), swing: -0.32 * sgn, tone: 0,
    });
  }
  const geos = parts.map(withPartAttrs);
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('crowd geometry merge failed');
  return merged;
}


export class Crowd {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private mat: THREE.ShaderMaterial;

  constructor(shadow: SunShadow) {
    const geo = buildFigureGeometry();
    const slots: number[] = [];
    for (let dv = -SPAN; dv <= SPAN; dv++) for (let du = -SPAN; du <= SPAN; du++) for (let k = 0; k < PER_BLOCK; k++) slots.push(du, dv, k);
    const n = slots.length / 3;
    geo.setAttribute('aSlot', new THREE.InstancedBufferAttribute(new Float32Array(slots), 3));
    const uniforms = { ...shared, uAmount: { value: 0 }, uCenterBlock: { value: new THREE.Vector2() } };
    const base = { uniforms, vertexShader: vert, fragmentShader: frag };
    this.mat = new THREE.ShaderMaterial({ ...base, defines: { ...GRID_DEFINES } });
    const depthMat = new THREE.ShaderMaterial({ ...base, defines: { ...GRID_DEFINES, DEPTH_PASS: 1 } });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, n);
    this.mesh.frustumCulled = false;
    shadow.add(this.mesh, depthMat);
    this.group.add(this.mesh);
  }

  /** `amount` 0..1: how full the streets are. `lookAt`: the point being looked at. */
  update(amount: number, lookAt: THREE.Vector3): void {
    this.mat.uniforms.uAmount.value = amount;
    const [u, v] = toGrid(lookAt.x, lookAt.z);
    (this.mat.uniforms.uCenterBlock.value as THREE.Vector2).set(Math.floor(u / BLOCK_U), Math.floor(v / BLOCK_V));
    this.group.visible = amount > 0.01;
  }
}
