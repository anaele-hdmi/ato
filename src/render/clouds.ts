// Cloud shells: two concentric spheres above the surface (a cheap stand-in
// for volume -- different radii give real parallax against each other and
// against the terrain), textured procedurally (no image textures) with a
// domain-warped fbm noise sampled directly in the Earth's object space, so
// the clouds rotate with the planet. A slow extra drift is layered on top
// via uTime. Soft, painterly coverage falloff (wide smoothstep, not a hard
// edge), wispy streaks, soft self-shadow, bright lit tops / blue-grey
// undersides, quantized against the same sun-angle steps as the ground.
//
// CLOUD_GLSL is exported so earth.ts can splice the *same* noise + coverage
// function into its own vertex shader (micro-relief) and fragment shader
// (cloud shadows on the ground) -- single source of truth for "where the
// clouds/noise are".
import * as THREE from 'three';
import { CLOUDS, RELIEF } from './palette';
import { EARTH_RADIUS_KM } from '../types';

// Both shells sit well above the tallest *exaggerated* peak (EXAGGERATION x
// MAX_ELEV_KM + procedural ridge noise in earth.ts, worst case well under
// 100 km) so the faceted mountains never poke through and hide them --
// they're stylized/exaggerated, so the cloud altitude is too, rather than a
// realistic ~10 km.
const SHELL_HEIGHTS_KM = [20, 46];

/** Shared noise + cloud-field GLSL. `cloudField(n, t)` returns a signed value;
 * 0 is the coverage edge, positive = inside a cloud, in object space `n`
 * (unit vector) and slow-drift time `t` (seconds). Kept to ~4 fbm octaves
 * total (mobile-sane). */
export const CLOUD_GLSL = /* glsl */ `
float cloudHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float cloudNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = cloudHash(i + vec3(0.0, 0.0, 0.0));
  float n100 = cloudHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = cloudHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = cloudHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = cloudHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = cloudHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = cloudHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = cloudHash(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

float cloudFbm4(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 4; i++) {
    sum += cloudNoise(p * freq) * amp;
    freq *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

float cloudFbm2(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 2; i++) {
    sum += cloudNoise(p * freq) * amp;
    freq *= 2.1;
    amp *= 0.5;
  }
  return sum;
}

// Signed cloud field: >0 inside a cloud, <0 in clear sky, 0 at the edge.
float cloudField(vec3 n, float t) {
  vec3 p = n * 2.4;

  // slow large-scale domain warp -> swirl-like / cumulus-cell structures
  // instead of uniform noise
  vec3 wp = p * 0.55 + vec3(t * 0.006, 0.0, t * 0.004);
  vec3 warp = vec3(
    cloudFbm2(wp),
    cloudFbm2(wp + vec3(11.3, 4.7, 8.1)),
    cloudFbm2(wp + vec3(23.1, 17.9, 2.4))
  ) - 0.5;

  vec3 sp = p + warp * 2.0 + vec3(t * 0.012, 0.0, -t * 0.008);
  float base = cloudFbm4(sp);

  // realistic-ish climatology envelope: ITCZ band, subtropical clear belts,
  // mid-latitude storm tracks, thin polar cover. Coverage is a hero element
  // here (40-60% in the cloudy belts), not a light sprinkle.
  float latDeg = degrees(asin(clamp(n.y, -1.0, 1.0)));
  float itcz = exp(-pow((latDeg - 6.0) / 10.0, 2.0));
  float subtropicalLow = exp(-pow((abs(latDeg) - 24.0) / 10.0, 2.0));
  float stormTrack = exp(-pow((abs(latDeg) - 52.0) / 16.0, 2.0));
  float polar = smoothstep(70.0, 88.0, abs(latDeg));

  float envelope = clamp(0.3 + itcz * 0.5 + stormTrack * 0.42 - subtropicalLow * 0.36 + polar * 0.1, 0.03, 0.88);

  return base - (1.0 - envelope);
}
`;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormalObj;
varying vec3 vWorldPosition;

void main() {
  vNormalObj = normalize(normal);
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDirObj;
uniform vec3 uSunDirWorld;
uniform float uTime;
uniform vec3 uShellOffset;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTwilight;
uniform vec3 uHazeCool;
uniform vec3 uHazeWarm;

varying vec3 vNormalObj;
varying vec3 vWorldPosition;

${CLOUD_GLSL}

void main() {
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vNormalObj);
  vec3 ns = n + uShellOffset; // slight per-shell offset so the two shells don't look identical
  float f = cloudField(ns, uTime);

  // Cumulus-scale puffs on top of the ~300 km macro field: this is what makes
  // clouds read as fluffy fields (ref images) instead of a soft veil. Detail
  // fades out where it would alias (far / grazing).
  vec3 drift = vec3(uTime * 0.03, 0.0, -uTime * 0.02);
  vec3 pp = ns * 140.0 + drift;
  float detailFade = 1.0 - smoothstep(0.35, 0.9, length(fwidth(pp)));
  // two cell sizes so fields aren't uniform blobs
  float puffs = cloudNoise(ns * 55.0 + drift * 0.5) * 0.45 + cloudFbm2(pp) * 0.4 + cloudNoise(ns * 380.0 + drift * 2.0) * 0.15;
  float density = (f - 0.07) * 1.5 + (puffs - 0.5) * 0.7 * detailFade;
  float coverage = smoothstep(0.0, 0.16, density);
  if (coverage < 0.01) discard;

  float l = dot(n, normalize(uSunDirObj));

  // Puffy shading: compare the puff field a little toward the sun. Sides
  // facing the sun brighten, far sides fall into soft blue-grey.
  vec3 sunT = normalize(uSunDirObj) - n * dot(normalize(uSunDirObj), n);
  vec3 pp2 = (ns + sunT * 0.0045) * 140.0 + drift;
  vec3 ns2 = ns + sunT * 0.0045;
  float puffs2 = cloudNoise(ns2 * 55.0 + drift * 0.5) * 0.45 + cloudFbm2(pp2) * 0.4 + cloudNoise(ns2 * 380.0 + drift * 2.0) * 0.15;
  float puffLight = clamp(0.5 + (puffs - puffs2) * 6.0 * detailFade, 0.0, 1.0);
  // thin edges are brighter / more translucent, cores slightly darker
  float core = smoothstep(0.1, 0.5, density);

  vec3 tone = mix(uShade, uLit, smoothstep(0.0, 0.45, l) * mix(0.55, 1.0, puffLight));
  tone = mix(tone, tone * 0.88, core * 0.4);
  tone = mix(uTwilight, tone, smoothstep(-0.1, 0.14, l));

  // aerial perspective: pale blue-white haze toward the limb / grazing angle
  float distKm = length(cameraPosition - vWorldPosition);
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float grazing = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 5.5);
  float distFactor = smoothstep(1600.0, 4800.0, distKm);
  float haze = clamp(grazing * 0.22 + distFactor * 0.22, 0.0, 1.0);
  vec3 hazeColor = mix(uHazeCool, uHazeWarm, smoothstep(0.05, 0.7, l) * 0.5);
  tone = mix(tone, hazeColor, haze * 0.28);

  // night side: clouds fade to near-invisible rather than staying bright
  float nightFade = smoothstep(-0.25, -0.03, l);
  vec3 color = tone * mix(0.03, 1.0, nightFade);
  float alpha = coverage * mix(0.85, 0.97, core) * mix(0.04, 1.0, nightFade);

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

export interface CloudObjects {
  mesh: THREE.Group;
  setSunDirObject(v: THREE.Vector3): void;
  setSunDirWorld(v: THREE.Vector3): void;
  setTime(seconds: number): void;
  dispose(): void;
}

function createShell(radiusKm: number, offset: THREE.Vector3): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const geometry = new THREE.SphereGeometry(radiusKm, 112, 84);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
      uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
      uShellOffset: { value: offset },
      uLit: { value: CLOUDS.lit },
      uShade: { value: CLOUDS.shade },
      uTwilight: { value: CLOUDS.twilight },
      uHazeCool: { value: RELIEF.hazeCool },
      uHazeWarm: { value: RELIEF.hazeWarm },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  return { mesh, material };
}

export function createClouds(): CloudObjects {
  const shells = SHELL_HEIGHTS_KM.map((h, i) =>
    createShell(EARTH_RADIUS_KM + h, new THREE.Vector3(i * 0.37, i * -0.21, i * 0.29)),
  );

  const group = new THREE.Group();
  for (const s of shells) group.add(s.mesh);

  return {
    mesh: group,
    setSunDirObject(v: THREE.Vector3) {
      for (const s of shells) (s.material.uniforms.uSunDirObj.value as THREE.Vector3).copy(v);
    },
    setSunDirWorld(v: THREE.Vector3) {
      for (const s of shells) (s.material.uniforms.uSunDirWorld.value as THREE.Vector3).copy(v);
    },
    setTime(seconds: number) {
      for (const s of shells) s.material.uniforms.uTime.value = seconds;
    },
    dispose() {
      for (const s of shells) {
        s.mesh.geometry.dispose();
        s.material.dispose();
      }
    },
  };
}
