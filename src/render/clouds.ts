// Cloud shell: one sphere above the surface, rotating with the planet.
//
// Performance: the large-scale field (weather systems, climatology) comes from
// the baked cloud map (cloudMap.ts) — one texture fetch. Only the
// cumulus-scale "puffs" are evaluated per fragment (3 value-noise lookups, +2
// for the sun-side shading), and they fade out where they would alias.
//
// Look (reference images): distinct clumps with real clear gaps between them,
// bright sun-facing sides, soft blue-grey shade sides, soft (not posterized)
// edges. Mountains are allowed to poke through (terrain is exaggerated).
import * as THREE from 'three';
import { CLOUDS, RELIEF } from './palette';
import { EARTH_RADIUS_KM } from '../types';
import { NOISE_GLSL } from './noiseGlsl';
import { CLOUD_MAP_GLSL } from './cloudMap';

/** Kept for earth.ts, which splices the same noise into its shaders. */
export const CLOUD_GLSL = NOISE_GLSL;

const SHELL_HEIGHT_KM = 24;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormalObj;
varying vec3 vWorldPosition;

void main() {
  vNormalObj = normalize(normal);
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDirObj;
uniform float uTime;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTwilight;
uniform vec3 uHazeCool;
uniform vec3 uHazeWarm;

varying vec3 vNormalObj;
varying vec3 vWorldPosition;

${NOISE_GLSL}
${CLOUD_MAP_GLSL}

// the two larger puff scales (the smallest adds texture only)
float puffLarge(vec3 n, vec3 drift) {
  return cloudNoise(n * 55.0 + drift * 0.5) * 0.5 + cloudNoise(n * 150.0 + drift) * 0.33;
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vNormalObj);
  float macro = cloudMacro(n);
  // early out well outside any cloud: saves the puff noise on clear sky
  if (macro < -0.3) discard;

  vec3 drift = vec3(uTime * 0.03, 0.0, -uTime * 0.02);
  // fade the puffs where one noise cell spans ~a pixel (anti-aliasing)
  float detailFade = 1.0 - smoothstep(0.3, 0.8, length(fwidth(n * 150.0)));
  float large = puffLarge(n, drift);
  float puffs = large + cloudNoise(n * 400.0 + drift * 2.0) * 0.17;
  float density = macro + (puffs - 0.5) * 0.55 * detailFade;

  // soft edge, widened by the pixel footprint so it never shimmers
  float edgeW = max(0.07, fwidth(density) * 1.5);
  float coverage = smoothstep(0.0, edgeW, density);
  if (coverage < 0.01) discard;

  vec3 sunObj = normalize(uSunDirObj);
  float l = dot(n, sunObj);

  // sun-side shading of the puffs: compare the field a little toward the sun
  vec3 sunT = sunObj - n * dot(sunObj, n);
  vec3 n2 = n + sunT * 0.004;
  float puffLight = clamp(0.5 + (large - puffLarge(n2, drift)) * 6.0 * detailFade, 0.0, 1.0);
  float core = smoothstep(0.05, 0.4, density);

  vec3 tone = mix(uShade, uLit, smoothstep(0.0, 0.45, l) * mix(0.5, 1.0, puffLight));
  tone = mix(tone, tone * 0.9, core * 0.35);
  tone = mix(uTwilight, tone, smoothstep(-0.1, 0.14, l));

  // aerial perspective toward the limb
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float grazing = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 5.5);
  vec3 hazeColor = mix(uHazeCool, uHazeWarm, smoothstep(0.05, 0.7, l) * 0.5);
  tone = mix(tone, hazeColor, grazing * 0.25);

  float nightFade = smoothstep(-0.25, -0.03, l);
  vec3 color = tone * mix(0.03, 1.0, nightFade);
  float alpha = coverage * mix(0.82, 0.96, core) * mix(0.04, 1.0, nightFade);

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

export interface CloudObjects {
  mesh: THREE.Object3D;
  setSunDirObject(v: THREE.Vector3): void;
  setSunDirWorld(v: THREE.Vector3): void;
  setTime(seconds: number): void;
  dispose(): void;
}

export function createClouds(cloudMap: THREE.Texture): CloudObjects {
  const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM + SHELL_HEIGHT_KM, 128, 96);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
      uCloudMap: { value: cloudMap },
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

  return {
    mesh,
    setSunDirObject(v) {
      (material.uniforms.uSunDirObj.value as THREE.Vector3).copy(v);
    },
    setSunDirWorld() {
      /* lighting is done in object space; kept for API compatibility */
    },
    setTime(seconds) {
      material.uniforms.uTime.value = seconds;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
