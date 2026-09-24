// A few slow smoke columns in the bad years. No fire, no flash; only what rises.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';
import { mulberry32 } from '../util/rand';

const PER = 46;

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
uniform float uProjScale;
attribute vec4 aSrc;   // x, z, start year, end year
attribute float aI;
varying float vA;
varying vec3 vWorld;
void main() {
  float on = smoothstep(aSrc.z, aSrc.z + 1.5, uYear) * (1.0 - smoothstep(aSrc.w - 2.0, aSrc.w, uYear));
  if (on < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float age = fract(uTime * 0.018 + aI * 0.6180339);
  float g = terrainHeight(aSrc.xy);
  vec2 drift = uWindDir * (60.0 + 260.0 * uWind) * age * age * 2.0;
  vec3 p = vec3(aSrc.x + drift.x, g + 30.0 + age * 520.0, aSrc.y + drift.y);
  p.xz += vec2(sin(aI * 17.0 + uTime * 0.05), cos(aI * 11.0)) * (10.0 + age * 70.0);
  vWorld = p;
  vA = on * (1.0 - age) * smoothstep(0.0, 0.1, age);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((70.0 + age * 320.0) * uProjScale / -mv.z, 2.0, 400.0);
}
`;
const frag = /* glsl */ `
${COMMON}
varying float vA;
varying vec3 vWorld;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = (1.0 - smoothstep(0.1, 1.0, length(q))) * vA * 0.55;
  vec3 c = vec3(0.12, 0.115, 0.11) * (uSkyAmb + uSunColor * 0.25);
  // smoke is itself part of the air; let the haze take only half of it
  c = mix(c, applyFog(c, vWorld), 0.5);
  gl_FragColor = vec4(pow(tonemap(c), vec3(1.0 / 2.2)), a);
}
`;

export class Smoke {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor() {
    const rng = mulberry32(909);
    const src: number[] = [], ids: number[] = [];
    for (let k = 0; k < 7; k++) {
      const a = rng() * Math.PI * 2, r = 250 + rng() * 1100;
      const x = -500 + Math.cos(a) * r, z = -350 + Math.sin(a) * r;
      const start = 2298 + rng() * 16, end = start + 8 + rng() * 14;
      for (let i = 0; i < PER; i++) {
        src.push(x, z, start, end);
        ids.push(i / PER + k * 0.37);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(ids.length * 3), 3));
    g.setAttribute('aSrc', new THREE.Float32BufferAttribute(src, 4));
    g.setAttribute('aI', new THREE.Float32BufferAttribute(ids, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uProjScale: { value: 800 } },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  update(year: number, projScale: number): void {
    this.points.visible = year > 2295 && year < 2340;
    this.mat.uniforms.uProjScale.value = projScale;
  }
}
