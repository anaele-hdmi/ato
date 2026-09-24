// The first house and what stays of it: footing stones, the well, a line of wall
// stones. Each piece simply has its own span of years.
import * as THREE from 'three';
import { paintedMaterials } from '../render/painted';
import { shared } from '../render/shared';
import { COMMON } from '../render/glsl';
import type { SunShadow } from '../render/shadow';
import { mulberry32 } from '../util/rand';
import { ORIGIN_GROUND } from '../time/time-model';
import { COTTAGE, buildCottages, cottageMaterials } from './cottage';

export const HOUSE_BIRTH = 1880;
export const HOUSE_DEATH = 2104;
const DEEP_END_STONES = 8600;

class PropBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  vis: number[] = [];

  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color, from: number, to: number): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(c.r, c.g, c.b);
      this.vis.push(from, to);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aVis', new THREE.Float32BufferAttribute(this.vis, 2));
    return g;
  }
}

const smokeVert = /* glsl */ `
${COMMON}
uniform vec3 uOrigin;
uniform float uAmount;
attribute float aI;
varying float vA;
varying vec3 vWorld;
void main() {
  float age = fract(uTime * 0.07 + aI * 0.618);
  vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * (1.5 + 5.0 * uWind) * age * age * 4.0;
  vec3 p = uOrigin + vec3(0.0, age * 5.5, 0.0) + drift + vec3(sin(aI * 9.0 + uTime * 0.4), 0.0, cos(aI * 7.0)) * age * 0.6;
  vWorld = p;
  vA = uAmount * (1.0 - age) * smoothstep(0.0, 0.08, age);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (0.5 + age * 2.4) * 900.0 / max(-mv.z, 0.5) * (uAmount > 0.0 ? 1.0 : 0.0);
}
`;
const smokeFrag = /* glsl */ `
${COMMON}
varying float vA;
varying vec3 vWorld;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = (1.0 - smoothstep(0.2, 1.0, length(q))) * vA * 0.35;
  vec3 c = (uSkyAmb * 0.9 + uSunColor * 0.25) * vec3(0.8, 0.8, 0.82);
  gl_FragColor = vec4(pow(tonemap(applyFog(c, vWorld)), vec3(1.0 / 2.2)), a);
}
`;

export class House {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3(0, ORIGIN_GROUND, 0);
  private smokeMat: THREE.ShaderMaterial;

  constructor(shadow: SunShadow) {
    const cm = cottageMaterials();
    const mesh = buildCottages(
      [{ x: 0, y: ORIGIN_GROUND, z: 0, rot: 0, scale: 1, birth: HOUSE_BIRTH, death: HOUSE_DEATH, color: new THREE.Color(0.93, 0.91, 0.86), seed: 0.21 }],
      cm,
    );
    shadow.add(mesh, cm.depth);
    this.group.add(mesh);

    const b = new PropBuilder();
    const rng = mulberry32(31);
    const G = ORIGIN_GROUND;
    const stone = () => new THREE.Color(0.44, 0.42, 0.38).multiplyScalar(0.8 + rng() * 0.35);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const M = (x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(sx, sy, sz));

    // footing stones, revealed when the walls go; they leave one by one
    const hw = COTTAGE.w / 2 + 0.05, hd = COTTAGE.d / 2 + 0.05;
    const perim: [number, number, number][] = [];
    for (let x = -hw; x <= hw; x += 0.55) perim.push([x, -hd, 0], [x, hd, 0]);
    for (let z = -hd + 0.55; z < hd; z += 0.55) perim.push([-hw, z, Math.PI / 2], [hw, z, Math.PI / 2]);
    for (const [x, z, r] of perim) {
      const end = rng() < 0.55 ? 2400 + rng() * 3600 : 6000 + rng() * (DEEP_END_STONES - 6000);
      b.add(box, M(x + (rng() - 0.5) * 0.06, G + 0.4, z + (rng() - 0.5) * 0.06, 0.5, 0.34, 0.36, r + (rng() - 0.5) * 0.1), stone(), HOUSE_DEATH, end);
    }
    // the well: stone ring, wooden frame while it is used
    const wx = 7.0, wz = -3.2, wy = G - 0.05;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const end = i % 3 === 0 ? 2600 + rng() * 1500 : 5200 + rng() * 2400;
      b.add(box, M(wx + Math.cos(a) * 0.62, wy + 0.36, wz + Math.sin(a) * 0.62, 0.3, 0.74, 0.34, -a), stone(), HOUSE_BIRTH, end);
    }
    const wood = new THREE.Color(0.3, 0.23, 0.17);
    b.add(box, M(wx - 0.62, wy + 1.1, wz, 0.1, 1.5, 0.1), wood, HOUSE_BIRTH, 2080);
    b.add(box, M(wx + 0.62, wy + 1.1, wz, 0.1, 1.5, 0.1), wood, HOUSE_BIRTH, 2080);
    b.add(box, M(wx, wy + 1.78, wz, 1.4, 0.09, 0.09), wood, HOUSE_BIRTH, 2080);
    // a dry-stone garden line to the west; later a straight row in the grass
    for (let z = -6; z <= 8; z += 0.62) {
      const end = rng() < 0.3 ? 2360 + rng() * 800 : 4000 + rng() * (DEEP_END_STONES - 4000);
      b.add(box, M(-9.3 + (rng() - 0.5) * 0.12, G - 0.05 + 0.2, z, 0.52, 0.5, 0.6, (rng() - 0.5) * 0.2), stone(), HOUSE_BIRTH, end);
    }
    const pm = paintedMaterials({ vis: true, vertexColors: true, wrap: 0.2, noise: 0.18 });
    const props = new THREE.Mesh(b.build(), pm.main);
    props.frustumCulled = false;
    shadow.add(props, pm.depth);
    this.group.add(props);

    // chimney smoke on cold mornings
    const sg = new THREE.BufferGeometry();
    const ids = new Float32Array(22).map((_, i) => i / 22);
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(22 * 3), 3));
    sg.setAttribute('aI', new THREE.Float32BufferAttribute(ids, 1));
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uOrigin: { value: new THREE.Vector3(1.575, G + COTTAGE.wall + COTTAGE.ridge + 0.8, -0.925) }, uAmount: { value: 0 } },
      vertexShader: smokeVert,
      fragmentShader: smokeFrag,
      transparent: true,
      depthWrite: false,
    });
    const smoke = new THREE.Points(sg, this.smokeMat);
    smoke.frustumCulled = false;
    this.group.add(smoke);
  }

  update(year: number, season: number, seasonality: number, day: number): void {
    const cold = Math.max(0, Math.cos((season - 0.05) * Math.PI * 2)) * seasonality + (1 - seasonality) * 0.2;
    const morning = Math.exp(-(((day - 0.32) / 0.09) ** 2)) + 0.6 * Math.exp(-(((day - 0.78) / 0.08) ** 2));
    const lived = year > HOUSE_BIRTH && year < 2070 ? 1 : 0;
    this.smokeMat.uniforms.uAmount.value = Math.min(1, cold * (0.3 + morning)) * lived;
  }
}
