// In the city nobody is a figure any more: people and cars are points on the streets.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';
import { mulberry32 } from '../util/rand';
import type { Settlement } from './settlement';

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
uniform float uDots;
uniform float uProjScale;
attribute vec4 aSeg;     // a.xz, b.xz
attribute vec4 aMove;    // speed, phase, lateral offset, vehicle
attribute vec2 aLife;
varying float vKind;
varying float vDir;
varying vec3 vWorld;
varying float vShow;
void main() {
  float seed = fract(aMove.y * 7.31);
  vShow = step(aLife.x, uYear) * step(uYear, aLife.y) * step(seed, uDots);
  if (vShow < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec2 a = aSeg.xy, b = aSeg.zw;
  float len = max(length(b - a), 1.0);
  float dir = seed > 0.5 ? 1.0 : -1.0;
  float s = fract(aMove.y + dir * uTime * aMove.x / len);
  vec2 t = (b - a) / len;
  vec2 nrm = vec2(-t.y, t.x);
  vec2 xz = mix(a, b, s) + nrm * aMove.z * dir;
  float y = terrainHeight(xz) + (aMove.w > 0.5 ? 0.7 : 1.1);
  vWorld = vec3(xz.x, y, xz.y);
  vKind = aMove.w;
  // headlights toward the viewer, tail lights away
  vec3 toCam = normalize(cameraPosition - vWorld);
  vDir = dot(vec3(t.x, 0.0, t.y) * dir, toCam);
  vec4 mv = viewMatrix * vec4(vWorld, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = aMove.w > 0.5 ? 1.5 : 0.5;
  gl_PointSize = clamp(size * uProjScale / -mv.z, 1.0, 4.0);
}
`;

const frag = /* glsl */ `
${COMMON}
varying float vKind;
varying float vDir;
varying vec3 vWorld;
varying float vShow;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  if (dot(q, q) > 1.0) discard;
  vec3 day = vKind > 0.5 ? vec3(0.12, 0.12, 0.13) : vec3(0.08, 0.07, 0.07);
  vec3 lamp = vKind > 0.5 ? (vDir > 0.0 ? vec3(1.0, 0.92, 0.8) * 2.2 : vec3(1.0, 0.12, 0.08) * 1.4) : vec3(1.0, 0.85, 0.6) * 0.35;
  vec3 c = mix(day * (uSkyAmb + uSunColor * 0.3), lamp, uNight);
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

export class StreetDots {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(streets: Settlement['streets']) {
    const rng = mulberry32(55);
    const seg: number[] = [], move: number[] = [], life: number[] = [];
    for (const s of streets) {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const count = s.main ? 7 : Math.max(1, Math.round(len / 28));
      for (let k = 0; k < count; k++) {
        const vehicle = s.main ? rng() < 0.7 : rng() < 0.35;
        seg.push(s.a[0], s.a[1], s.b[0], s.b[1]);
        move.push(vehicle ? 7 + rng() * 6 : 0.9 + rng() * 0.6, rng(), vehicle ? 1.6 + rng() * 1.2 : 5 + rng() * 1.5, vehicle ? 1 : 0);
        life.push(s.birth + rng() * 6, 2305 + rng() * 25);
      }
    }
    const n = life.length / 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSeg', new THREE.Float32BufferAttribute(seg, 4));
    g.setAttribute('aMove', new THREE.Float32BufferAttribute(move, 4));
    g.setAttribute('aLife', new THREE.Float32BufferAttribute(life, 2));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uDots: { value: 0 }, uProjScale: { value: 800 } },
      vertexShader: vert,
      fragmentShader: frag,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  update(dots: number, projScale: number): void {
    this.mat.uniforms.uDots.value = dots;
    this.mat.uniforms.uProjScale.value = projScale;
    this.points.visible = dots > 0.01;
  }
}
