// Poles and sagging wires. Not pretty; not left out.
import * as THREE from 'three';
import { paintedMaterials } from '../render/painted';
import { shared } from '../render/shared';
import { COMMON } from '../render/glsl';
import type { SunShadow } from '../render/shadow';
import type { PoleRec } from './settlement';
import { hash2 } from '../util/rand';

const wireVert = /* glsl */ `
${COMMON}
attribute vec2 aVis;
varying vec3 vWorld;
void main() {
  if (uYear < aVis.x || uYear >= aVis.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;
const wireFrag = /* glsl */ `
${COMMON}
varying vec3 vWorld;
void main() {
  vec3 c = vec3(0.05, 0.05, 0.055) * (uSkyAmb + 0.3);
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

const ARM = 8.3;
const ARM_W = 0.85;

export class Utilities {
  readonly group = new THREE.Group();
  readonly poles: PoleRec[];

  constructor(poles: PoleRec[], shadow: SunShadow) {
    this.poles = poles;
    const geoPole = new THREE.CylinderGeometry(0.1, 0.14, 9, 6).translate(0, 4.3, 0);
    const arm = new THREE.BoxGeometry(ARM_W * 2, 0.1, 0.1).translate(0, ARM, 0);
    const can = new THREE.CylinderGeometry(0.22, 0.22, 0.7, 7).translate(0.3, 6.9, 0);
    const merged = mergeSimple([geoPole, arm, can]);
    const pm = paintedMaterials({ color: 0x5a544c, vis: true, wrap: 0.3, noise: 0.15 });
    const mesh = new THREE.InstancedMesh(merged, pm.main, Math.max(1, poles.length));
    const vis = new Float32Array(Math.max(1, poles.length) * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    poles.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot + (hash2(i, p.line, 71) - 0.5) * 0.04);
      m.compose(new THREE.Vector3(p.x, p.y - 0.3, p.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, m);
      vis.set([p.birth, p.death], i * 2);
    });
    merged.setAttribute('aVis', new THREE.InstancedBufferAttribute(vis, 2));
    mesh.count = poles.length;
    mesh.frustumCulled = false;
    shadow.add(mesh, pm.depth);

    // wires between consecutive poles of one line
    const pos: number[] = [];
    const wv: number[] = [];
    for (let i = 0; i + 1 < poles.length; i++) {
      const a = poles[i], b = poles[i + 1];
      if (a.line !== b.line) continue;
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span > 60) continue;
      const from = Math.max(a.birth, b.birth), to = Math.min(a.death, b.death);
      for (const off of [-ARM_W + 0.1, 0.05, ARM_W - 0.1]) {
        const ax = a.x + Math.cos(a.rot) * off, az = a.z - Math.sin(a.rot) * off;
        const bx = b.x + Math.cos(b.rot) * off, bz = b.z - Math.sin(b.rot) * off;
        const ay = a.y - 0.3 + ARM + 0.08, by = b.y - 0.3 + ARM + 0.08;
        const sag = 0.35 + span * 0.012;
        const SEG = 8;
        for (let k = 0; k < SEG; k++) {
          for (const t of [k / SEG, (k + 1) / SEG]) {
            pos.push(ax + (bx - ax) * t, ay + (by - ay) * t - sag * 4 * t * (1 - t), az + (bz - az) * t);
            wv.push(from, to);
          }
        }
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setAttribute('aVis', new THREE.Float32BufferAttribute(wv, 2));
    const wires = new THREE.LineSegments(wg, new THREE.ShaderMaterial({ uniforms: { ...shared }, vertexShader: wireVert, fragmentShader: wireFrag }));
    wires.frustumCulled = false;
    this.group.add(mesh, wires);
  }

  /** 0..1 how close the camera is to the nearest standing pole (drives the hum). */
  nearness(cam: THREE.Vector3, year: number): number {
    let best = Infinity;
    for (const p of this.poles) {
      if (year < p.birth || year >= p.death) continue;
      const d = Math.hypot(p.x - cam.x, p.y + 7 - cam.y, p.z - cam.z);
      if (d < best) best = d;
    }
    return Math.max(0, 1 - best / 40);
  }
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
