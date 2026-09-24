// A handful of faceless figures. They exist only while the place is a village;
// in the city they give way to lights and dots (see street-dots.ts).
import * as THREE from 'three';
import { paintedMaterials } from '../render/painted';
import type { SunShadow } from '../render/shadow';
import { mulberry32, smoothstep } from '../util/rand';
import type { V2 } from './layout';

interface Walker {
  path: V2[];
  pingPong: boolean;
  speed: number;
  birth: number;
  death: number;
  body: THREE.Color;
  scale: number;
  // runtime
  s: number;
  dir: number;
  walking: boolean;
  timer: number;
  phase: number;
  rng: () => number;
}

const PARTS = ['head', 'torso', 'legs', 'arms'] as const;

function pathLen(p: V2[], loop: boolean): number {
  let l = 0;
  const n = loop ? p.length : p.length - 1;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    l += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return l;
}

function pointAt(p: V2[], loop: boolean, s: number): { x: number; z: number; hx: number; hz: number } {
  const n = loop ? p.length : p.length - 1;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= l || i === n - 1) {
      const t = Math.max(0, Math.min(1, s / l));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, hx: (b[0] - a[0]) / l, hz: (b[1] - a[1]) / l };
    }
    s -= l;
  }
  return { x: p[0][0], z: p[0][1], hx: 1, hz: 0 };
}

export class Figures {
  readonly group = new THREE.Group();
  private walkers: Walker[] = [];
  private meshes: Record<(typeof PARTS)[number], THREE.InstancedMesh>;
  private m = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();

  constructor(private ground: (x: number, z: number) => number, shadow: SunShadow) {
    const rng = mulberry32(4242);
    const cloth = [0x2a2622, 0x22262e, 0x33291f, 0x2c2c2a, 0x3a3128, 0x1f2320];
    const add = (path: V2[], pingPong: boolean, speed: number, birth: number, death: number, scale = 1) => {
      this.walkers.push({
        path, pingPong, speed, birth, death, scale,
        body: new THREE.Color(cloth[this.walkers.length % cloth.length]),
        s: rng() * 20, dir: 1, walking: rng() > 0.4, timer: 2 + rng() * 6, phase: 0,
        rng: mulberry32(1000 + this.walkers.length * 17),
      });
    };
    // around the house, to the well and back
    add([[0.4, 3.9], [3.6, 4.6], [7.6, 1.2], [7.4, -2.2], [5.6, -3.4], [2.0, -4.2], [-3.8, -3.6], [-4.4, 3.4]], false, 0.6, 1880, 2082);
    // along the old track
    add([[-150, -30], [-52, 12], [40, 16], [160, 40], [260, 78]], true, 0.95, 1880, 1996);
    // in the field, slow
    add([[40, 70], [72, 78], [96, 64], [70, 52]], false, 0.45, 1880, 1990, 0.97);
    // a child near the apple tree, briefly
    add([[-5.5, 2.5], [-7.5, 6], [-2, 7.5], [-6.2, 0.5]], false, 0.55, 1903, 1915, 0.68);
    add([[62, -80], [52, -30], [40, 16], [20, 18]], true, 0.85, 1924, 1992);
    add([[-60, 30], [10, 26], [90, 34]], true, 0.9, 1950, 1998);
    add([[170, 30], [150, 140], [142, 220]], true, 0.8, 1931, 1990);

    const geos = {
      head: new THREE.SphereGeometry(0.115, 12, 9).translate(0, 1.53, 0).scale(1, 1.08, 1),
      torso: new THREE.CapsuleGeometry(0.17, 0.36, 4, 10).scale(1, 1, 0.68).translate(0, 1.13, 0),
      legs: new THREE.CapsuleGeometry(0.068, 0.72, 3, 8).translate(0, -0.4, 0),
      arms: new THREE.CapsuleGeometry(0.05, 0.52, 3, 8).translate(0, -0.3, 0),
    };
    const counts = { head: 1, torso: 1, legs: 2, arms: 2 };
    const tone = { head: 0x4a3e36, torso: 0xffffff, legs: 0xffffff, arms: 0xffffff };
    this.meshes = {} as typeof this.meshes;
    for (const p of PARTS) {
      const mats = paintedMaterials({ color: tone[p], wrap: 0.35, noise: 0.05 });
      const mesh = new THREE.InstancedMesh(geos[p], mats.main, this.walkers.length * counts[p]);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < this.walkers.length * counts[p]; i++) {
        const w = this.walkers[Math.floor(i / counts[p])];
        const c = p === 'head' ? new THREE.Color(1, 1, 1) : p === 'legs' ? w.body.clone().multiplyScalar(0.75) : w.body;
        mesh.setColorAt(i, c);
      }
      shadow.add(mesh, mats.depth);
      this.meshes[p] = mesh;
      this.group.add(mesh);
    }
  }

  update(dt: number, year: number, people: number): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.walkers.forEach((w, i) => {
      const present = year >= w.birth && year < w.death && people > 0.02;
      // Fade the crowd out by dropping individuals, not by transparency.
      const keep = present && ((i * 0.37) % 1) < people + 0.05;
      if (!keep) {
        this.setPart('head', i, 0, zero);
        this.setPart('torso', i, 0, zero);
        for (let k = 0; k < 2; k++) { this.setPart('legs', i, k, zero); this.setPart('arms', i, k, zero); }
        return;
      }
      w.timer -= dt;
      if (w.timer <= 0) {
        w.walking = !w.walking;
        w.timer = w.walking ? 5 + w.rng() * 14 : 2 + w.rng() * 7;
      }
      const L = pathLen(w.path, !w.pingPong);
      let moving = 0;
      if (w.walking) {
        w.s += w.dir * w.speed * dt;
        moving = 1;
        if (w.pingPong) {
          if (w.s > L) { w.s = L; w.dir = -1; }
          if (w.s < 0) { w.s = 0; w.dir = 1; }
        } else {
          w.s = ((w.s % L) + L) % L;
        }
        w.phase += (w.speed * dt * Math.PI * 2) / 1.25;
      }
      const pt = pointAt(w.path, !w.pingPong, w.s);
      const hx = pt.hx * w.dir, hz = pt.hz * w.dir;
      const yaw = Math.atan2(hx, hz);
      const y = this.ground(pt.x, pt.z);
      const swing = Math.sin(w.phase) * moving;
      const bob = Math.abs(Math.sin(w.phase)) * 0.025 * moving;
      const sway = Math.sin(performance.now() * 0.0007 + i) * 0.015 * (1 - moving);
      const base = new THREE.Matrix4().compose(
        new THREE.Vector3(pt.x, y + bob, pt.z),
        this.tmpQ.setFromEuler(new THREE.Euler(sway, yaw, 0, 'YXZ')),
        new THREE.Vector3(w.scale, w.scale, w.scale),
      );
      this.setPart('head', i, 0, base);
      this.setPart('torso', i, 0, base);
      for (let k = 0; k < 2; k++) {
        const sgn = k === 0 ? 1 : -1;
        const leg = new THREE.Matrix4().makeTranslation(sgn * 0.085, 0.86, 0).multiply(new THREE.Matrix4().makeRotationX(swing * 0.42 * sgn));
        this.setPart('legs', i, k, base.clone().multiply(leg));
        const arm = new THREE.Matrix4().makeTranslation(sgn * 0.215, 1.36, 0).multiply(new THREE.Matrix4().makeRotationX(-swing * 0.32 * sgn)).multiply(new THREE.Matrix4().makeRotationZ(sgn * 0.06));
        this.setPart('arms', i, k, base.clone().multiply(arm));
      }
    });
    for (const p of PARTS) this.meshes[p].instanceMatrix.needsUpdate = true;
    this.group.visible = people > 0.01 && smoothstep(0, 1, people) > 0;
  }

  private setPart(p: (typeof PARTS)[number], i: number, k: number, mat: THREE.Matrix4): void {
    const idx = p === 'legs' || p === 'arms' ? i * 2 + k : i;
    this.m.copy(mat);
    this.meshes[p].setMatrixAt(idx, this.m);
  }
}
