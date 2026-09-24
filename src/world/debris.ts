// Rubble left behind once a building's shell finally crumbles (see COLLAPSE_GLSL in
// blocks.ts, which this shares so the mound appears exactly when the building flattens).
// One low, irregular mound per collapsing building, instanced; it pops up quickly as the
// building falls, settles a little over the centuries, and greens over with uWild.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON } from '../render/glsl';
import { bornBy, COLLAPSE_GLSL } from './blocks';
import type { BoxRec } from './settlement';

const vert = /* glsl */ `
${COMMON}
${COLLAPSE_GLSL}
attribute vec3 aInfo; // collapse (onset) year, seed, death year
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSeed;
void main() {
  float collapseAt = aInfo.x, seed = aInfo.y, death = aInfo.z;
  if (uYear < collapseAt || uYear >= death) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float c2 = collapse2Of(collapseAt, seed, uYear);
  if (c2 < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float fy = fallYear(collapseAt, seed);
  float age = max(0.0, uYear - fy);
  // pops up over the same short span the building takes to finally come down
  float grow = smoothstep(0.0, max(0.6, failDur(seed) * 0.6), age);
  // settles very slowly into the ground over centuries; never fully vanishes
  float settle = 1.0 - 0.2 * smoothstep(0.0, 700.0, age);
  vec3 p = position;
  // lumpy, not a smooth dome: per-vertex bump breaks up the mound's silhouette
  float bump = 0.6 + 0.5 * hash12(p.xz * 2.6 + seed * 33.0);
  vec3 op = vec3(p.x * bump, max(p.y, 0.0) * 0.5, p.z * bump);
  vec3 local = op * vec3(1.0, settle, 1.0) * (0.3 + 0.9 * grow);
  vec4 w = modelMatrix * instanceMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normalize(op + 1e-4));
  vSeed = seed;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSeed;
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 n = normalize(vNormal);
  vec3 dust = mix(vec3(0.4, 0.37, 0.32), vec3(0.5, 0.46, 0.4), hash12(vWorld.xz * 0.08 + vSeed * 9.0));
  float moss = clamp(uWild * 1.3 - 0.2 + vnoise(vWorld.xz * 0.15 + vSeed * 5.0) * 0.6, 0.0, 1.0);
  vec3 col = mix(dust, grassColor(0.4) * 0.85, moss * 0.8);
  float sh = sampleShadow(vWorld, n);
  vec3 c = shade(col, n, vWorld, 0.4, sh);
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

/** Instanced rubble mounds, one per building that can collapse (kind aside, any box
 * with a finite collapse year); benign for buildings that never fail (shops), since
 * their collapse year is 9e9 and collapse2Of() then never leaves 0. */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  readonly depth: THREE.ShaderMaterial;
  private collapses: number[];

  constructor(boxes: BoxRec[]) {
    const sorted = boxes.filter((b) => b.collapse < 1e8).sort((a, b) => a.collapse - b.collapse);
    const n = Math.max(1, sorted.length);
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const info = new Float32Array(n * 3);
    const uniforms = { ...shared };
    const main = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag });
    this.depth = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, defines: { DEPTH_PASS: 1 } });
    this.mesh = new THREE.InstancedMesh(geo, main, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    sorted.forEach((b, i) => {
      q.setFromAxisAngle(up, b.rot);
      // spread a little beyond the footprint; taller buildings leave a bigger mound
      const radius = Math.max(b.sx, b.sz) * (0.5 + 0.25 * b.seed);
      const height = Math.min(6, Math.max(1.2, b.h1 * 0.05));
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(radius, height, radius));
      this.mesh.setMatrixAt(i, m);
      info.set([b.collapse, b.seed, b.death], i * 3);
    });
    geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 3));
    this.mesh.count = sorted.length;
    this.mesh.frustumCulled = false;
    this.collapses = sorted.map((b) => b.collapse);
  }

  /** Only instance the mounds for buildings whose failure has begun (collapses is
   * sorted ascending, so bornBy() gives how many are relevant at this year). */
  update(year: number): void {
    this.mesh.count = bornBy(this.collapses, year);
    this.mesh.visible = this.mesh.count > 0;
  }
}
