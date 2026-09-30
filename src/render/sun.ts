// The Sun: a saturated, depth-tested disc (0.53 deg) with a tight inner glow,
// one camera-facing quad far out along sunDir. Depth-tested, so the Earth, the
// station and the window frame hide it where the geometry says. The big
// dazzle (spikes, veil, ghosts) lives in flare.ts as screen-space sprites.
//
// Seen through the atmosphere (ray tangent height h above the surface, from
// the station's point of view) the disc reddens and dims (Rayleigh-like
// extinction, exp(-h/H)) and is squashed vertically by refraction.
//
// Cost: 2 triangles, fragment work only on the small quad.
import * as THREE from 'three';
import { SUN } from './palette';
import { EARTH_RADIUS_KM } from '../types';

export const SUN_DISTANCE_KM = 90000;
/** Quad half-size in disc radii (the inner glow fades out before this). */
const QUAD_RADII = 14;
/** Drawn after the cabin frame / glass (orders 9..11) so the depth they wrote hides the Sun. */
export const SUN_RENDER_ORDER = 20;

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uTint;
uniform float uFlat;
uniform float uGlow;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = vUv * ${QUAD_RADII.toFixed(1)};
  q.y /= uFlat;
  float r = length(q);
  float disc = 1.0 - smoothstep(0.93, 1.0, r);
  float fade = 1.0 - smoothstep(8.0, ${QUAD_RADII.toFixed(1)}, r);
  float glow = fade * pow(1.0 / (1.0 + r * r * 0.9), 1.1);
  vec3 col = uTint * (disc * 1.6 + glow * uGlow);
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface SunAtmosphere {
  /** tangent height of the Sun ray above the surface, km (Infinity when the ray never dips toward the Earth) */
  h: number;
  /** 0..1: Earth's limb hides the Sun (0 = hidden, smooth over ~5 km of tangent height) */
  earthVis: number;
  /** per-channel transmittance through the atmosphere */
  trans: THREE.Color;
}

export interface SunObjects {
  mesh: THREE.Mesh;
  /** Orient/tint the disc. earthRel = Earth centre relative to the eye (scene frame). */
  update(eye: THREE.Vector3, dir: THREE.Vector3, earthRel: THREE.Vector3, glowScale: number): SunAtmosphere;
  setDirection(dir: THREE.Vector3): void;
  dispose(): void;
}

/** Shared by the disc and the flare: extinction along the ray that grazes the atmosphere. */
export function sunAtmosphere(dir: THREE.Vector3, earthRel: THREE.Vector3, out: SunAtmosphere, perp?: THREE.Vector3): SunAtmosphere {
  const s = earthRel.dot(dir);
  if (s <= 0) {
    out.h = Infinity;
    out.earthVis = 1;
    out.trans.setRGB(1, 1, 1);
    return out;
  }
  // distance from the Earth's centre to the ray
  const px = earthRel.x - dir.x * s;
  const py = earthRel.y - dir.y * s;
  const pz = earthRel.z - dir.z * s;
  const dist = Math.hypot(px, py, pz);
  if (perp) perp.set(px, py, pz).multiplyScalar(dist > 1e-6 ? 1 / dist : 0);
  const h = dist - EARTH_RADIUS_KM;
  out.h = h;
  out.earthVis = THREE.MathUtils.smoothstep(h, -3, 2);
  const tau = SUN.extinctionTau * Math.exp(-Math.max(h, 0) / SUN.extinctionScaleKm);
  const b = SUN.extinctionBeta;
  out.trans.setRGB(Math.exp(-tau * b.x), Math.exp(-tau * b.y), Math.exp(-tau * b.z));
  return out;
}

export function createSun(): SunObjects {
  const uniforms = {
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFlat: { value: 1 },
    uGlow: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    // keep the destination alpha (chase-view DOF mask lives there)
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  const scale = 2 * SUN_DISTANCE_KM * Math.tan(THREE.MathUtils.degToRad(SUN.discRadiusDeg) * QUAD_RADII);
  mesh.scale.set(scale, scale, 1);
  mesh.renderOrder = SUN_RENDER_ORDER;
  mesh.frustumCulled = false;

  const atm: SunAtmosphere = { h: Infinity, earthVis: 1, trans: new THREE.Color(1, 1, 1) };
  const perp = new THREE.Vector3();
  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const dirV = new THREE.Vector3();

  return {
    mesh,
    setDirection(dir) {
      dirV.copy(dir);
      mesh.position.copy(dir).multiplyScalar(SUN_DISTANCE_KM);
    },
    update(eye, dir, earthRel, glowScale) {
      dirV.copy(dir);
      mesh.position.copy(eye).addScaledVector(dir, SUN_DISTANCE_KM);
      sunAtmosphere(dir, earthRel, atm, perp);
      // quad basis: z toward the viewer, y along the local vertical at the grazing point
      zAxis.copy(dir).negate();
      if (perp.lengthSq() < 0.5) perp.set(0, 1, 0);
      yAxis.copy(perp).addScaledVector(zAxis, -perp.dot(zAxis)).normalize();
      xAxis.crossVectors(yAxis, zAxis);
      basis.makeBasis(xAxis, yAxis, zAxis);
      mesh.quaternion.setFromRotationMatrix(basis);
      const h = Number.isFinite(atm.h) ? Math.max(atm.h, 0) : 1e6;
      uniforms.uFlat.value = 1 - SUN.flattenMax * Math.exp(-h / SUN.flattenScaleKm);
      // hue from the transmittance, normalised to the red channel so the disc stays a bright orange, not brown
      const t = atm.trans;
      const k = 1 / Math.pow(Math.max(t.r, 1e-3), 0.7);
      uniforms.uTint.value.copy(SUN.disc).multiply(t).multiplyScalar(Math.min(k, 3));
      uniforms.uGlow.value = glowScale;
      return atm;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
