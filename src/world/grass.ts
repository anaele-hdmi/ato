// Near-field grass: a grid of blade clumps that travels with the view. Clumps are
// seeded from their world cell so they never swim as the grid moves.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, ROADS_FN, TERRAIN_FN } from '../render/glsl';
import { mulberry32 } from '../util/rand';
import { GRID_DEFINES, GRID_FN } from './terrain';

const N = 64;
const CELL = 0.42;

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${ROADS_FN}
${GRID_FN}
uniform vec2 uCenter;
attribute vec2 aCell;
attribute float aH;
varying vec3 vWorld;
varying float vH;
varying float vVar;
varying vec3 vNormal;
void main() {
  vec2 base = floor(uCenter / ${CELL.toFixed(3)}) + aCell;
  float r1 = hash12(base);
  float r2 = hash12(base + 17.3);
  vec2 xz = (base + vec2(r1, r2)) * ${CELL.toFixed(3)};
  vec4 rd = roadRaw(xz);
  float urbY = yearN(rd.a);
  float urban = smoothstep(urbY + 1.0, urbY + 5.0, uYear);
  float regrow = smoothstep(0.2, 0.9, uRoadDecay + 0.5 * (hash12(base * 0.13) - 0.5));
  float mainW = mix(mix(mix(2.2, 4.2, uGravel), 7.0, uPaved), 12.5, uAvenue) * 0.5 + 0.5;
  float laneOn = step(yearN(rd.b), uYear);
  float onRoad = max(step(rd.r, mainW), step(rd.g, 2.4 + 2.0 * urban) * laneOn);
  onRoad = max(onRoad, urban * step(gridStreetDist(xz), 6.0));
  float bare = max(onRoad * (1.0 - regrow), urban * (1.0 - voidMask(xz)) * (1.0 - regrow));
  // around the house the ground is trodden
  float trod = 1.0 - smoothstep(3.5, 6.5, length(xz - vec2(0.0, 0.5)));
  float h0 = terrainHeight(xz);
  float wet = step(h0, uSeaLevel + 0.3);
  float dCam = length(vec3(xz.x, h0, xz.y) - cameraPosition);
  float fade = 1.0 - smoothstep(11.0, 16.0, dCam);
  float s = fade * (1.0 - bare) * (1.0 - wet) * (1.0 - uGlacial) * (1.0 - trod * 0.75) * (0.55 + 0.9 * hash12(base + 3.1));
  s *= 1.0 - smoothstep(0.9, 0.99, snowCover());
  if (s < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ang = hash12(base + 5.7) * 6.2831;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec3 p = position;
  p.xz = rot * p.xz;
  p.y *= s * (0.8 + 0.5 * (1.0 - uSeasonality * step(0.85, uSeason)));
  float gust = uWind * (0.35 + 0.65 * vnoise(xz * 0.15 + uWindDir * uTime * 0.9));
  float bend = aH * aH * (0.12 + 0.35 * gust);
  p.xz += uWindDir * bend + vec2(sin(uTime * 2.3 + xz.x), cos(uTime * 1.9 + xz.y)) * 0.02 * aH;
  vec3 w = vec3(xz.x + p.x, h0 + p.y, xz.y + p.z);
  vWorld = w;
  vH = aH;
  vVar = hash12(base + 9.1);
  vNormal = normalize(vec3(uWindDir.x * 0.3, 1.0, uWindDir.y * 0.3));
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const frag = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying float vH;
varying float vVar;
varying vec3 vNormal;
void main() {
  vec3 base = grassColor(vVar);
  vec3 col = mix(base * 0.5, base * 1.2 + vec3(0.02, 0.025, 0.0), vH);
  // a few spring flowers, not a carpet
  float fl = step(0.985, vVar) * step(0.9, vH) * win(uSeason, 0.2, 0.26, 0.4, 0.48) * uSeasonality;
  col = mix(col, mix(vec3(0.85, 0.8, 0.3), vec3(0.85, 0.85, 0.8), step(0.993, vVar)), fl);
  // dry tips in autumn
  col = mix(col, vec3(0.55, 0.47, 0.28), vH * smoothstep(0.62, 0.8, uSeason) * uSeasonality * 0.6);
  float sh = sampleShadow(vWorld, vec3(0.0, 1.0, 0.0));
  vec3 c = shade(col, vNormal, vWorld, 0.6, sh);
  // light passing through the blade toward a low sun
  vec3 v = normalize(cameraPosition - vWorld);
  c += uSunColor * base * 0.35 * pow(max(dot(-v, uSunDir), 0.0), 4.0) * vH * sh;
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

function clumpGeometry(): THREE.InstancedBufferGeometry {
  const rng = mulberry32(99);
  const pos: number[] = [];
  const hs: number[] = [];
  const BLADES = 6;
  for (let b = 0; b < BLADES; b++) {
    const ox = (rng() - 0.5) * 0.36, oz = (rng() - 0.5) * 0.36;
    const a = rng() * Math.PI;
    const dx = Math.cos(a), dz = Math.sin(a);
    const h = 0.18 + rng() * 0.32;
    const w = 0.022 + rng() * 0.018;
    const lean = (rng() - 0.5) * 0.12;
    const px = -dz, pz = dx;
    const at = (t: number, side: number): [number, number, number] => [
      ox + dx * side * w * (1 - t) + px * lean * t * t,
      h * t,
      oz + dz * side * w * (1 - t) + pz * lean * t * t,
    ];
    const v0 = at(0, -1), v1 = at(0, 1), v2 = at(0.5, -1), v3 = at(0.5, 1), v4 = at(1, 0);
    const tris: [number[], number][] = [[v0, 0], [v1, 0], [v3, 0.5], [v0, 0], [v3, 0.5], [v2, 0.5], [v2, 0.5], [v3, 0.5], [v4, 1]];
    for (const [v, t] of tris) { pos.push(...v); hs.push(t); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hs, 1));
  const cells = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    cells[(j * N + i) * 2] = i - N / 2;
    cells[(j * N + i) * 2 + 1] = j - N / 2;
  }
  g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
  g.instanceCount = N * N;
  return g;
}

export class Grass {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uCenter: { value: new THREE.Vector2() } },
      vertexShader: vert,
      fragmentShader: frag,
      defines: GRID_DEFINES,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(clumpGeometry(), this.mat);
    this.mesh.frustumCulled = false;
  }

  update(camPos: THREE.Vector3, target: THREE.Vector3, dist: number): void {
    // Sit just ahead of the eye: fade distance is measured from the camera.
    const k = Math.min(dist, 9) / Math.max(dist, 1e-3);
    const cx = camPos.x + (target.x - camPos.x) * k;
    const cz = camPos.z + (target.z - camPos.z) * k;
    (this.mat.uniforms.uCenter.value as THREE.Vector2).set(cx, cz);
    this.mesh.visible = dist < 40;
  }
}
