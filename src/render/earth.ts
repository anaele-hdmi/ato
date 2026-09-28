// The Earth sphere: five flat surfaces + lighting quantized into steps (art-direction A), built from
// an object-space normal (not SphereGeometry UVs) so lon/lat sampling stays
// correct regardless of geometry tessellation.
import * as THREE from 'three';
import { EARTH_COLORS, LIGHT_STEPS } from './palette';
import { buildLandMaskTexture } from './landmask';
import { EARTH_RADIUS_KM } from '../types';

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormalObj;

void main() {
  vNormalObj = normalize(normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uLandTex;
uniform vec3 uSunDirObj;

uniform vec3 uDeepOcean;
uniform vec3 uShallowOcean;
uniform vec3 uLand;
uniform vec3 uHighLand;
uniform vec3 uIce;
uniform vec3 uNightLand;
uniform vec3 uNightOcean;
uniform vec3 uWarm;
uniform float uWarmAmount;
uniform float uFull;
uniform float uLow;
uniform float uMidLevel;
uniform float uLowLevel;

varying vec3 vNormalObj;

// Anti-aliased step: hard edge, but smoothed over ~1 pixel.
float aaStep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vNormalObj);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec2 mask = texture2D(uLandTex, uv).rg;

  float land = aaStep(0.5, mask.r);
  float coast = aaStep(0.35, mask.g);
  float absLat = abs(lat) * 57.2958;

  // five flat faces
  vec3 ocean = mix(uDeepOcean, uShallowOcean, coast);
  vec3 ground = mix(uLand, uHighLand, aaStep(55.0, absLat));
  ground = mix(ground, uIce, aaStep(68.0, absLat));
  ocean = mix(ocean, uIce, aaStep(74.0, absLat));   // sea ice cap
  vec3 dayColor = mix(ocean, ground, land);
  vec3 nightColor = mix(uNightOcean, uNightLand, land);

  // quantized lighting: full / mid / low (twilight) / night
  float l = dot(n, normalize(uSunDirObj));
  float lit = aaStep(0.0, l);
  float mid = 1.0 - aaStep(uFull, l);
  float low = 1.0 - aaStep(uLow, l);
  float level = mix(1.0, uMidLevel, mid);
  level = mix(level, uLowLevel, low);

  vec3 color = dayColor * level;
  color = mix(color, color * 0.6 + uWarm * 0.4, low * uWarmAmount / 0.35);
  color = mix(nightColor, color, lit);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export interface EarthObjects {
  /** Non-rotating pivot; caller positions this at -stationPos each frame. */
  pivot: THREE.Group;
  /** Rotates about +Y by gmstRad each frame. */
  rotGroup: THREE.Group;
  material: THREE.ShaderMaterial;
  /** Sets the sun direction in Earth OBJECT space (already de-rotated by -gmstRad). */
  setSunDirObject(v: THREE.Vector3): void;
  dispose(): void;
}

export function createEarth(): EarthObjects {
  const landTexture = buildLandMaskTexture();

  const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM, 128, 96);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uLandTex: { value: landTexture },
      uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
      uDeepOcean: { value: EARTH_COLORS.deepOcean },
      uShallowOcean: { value: EARTH_COLORS.shallowOcean },
      uLand: { value: EARTH_COLORS.land },
      uHighLand: { value: EARTH_COLORS.highLand },
      uIce: { value: EARTH_COLORS.ice },
      uNightLand: { value: EARTH_COLORS.nightLand },
      uNightOcean: { value: EARTH_COLORS.nightOcean },
      uWarm: { value: LIGHT_STEPS.warm },
      uWarmAmount: { value: LIGHT_STEPS.warmAmount },
      uFull: { value: LIGHT_STEPS.full },
      uLow: { value: LIGHT_STEPS.low },
      uMidLevel: { value: LIGHT_STEPS.midLevel },
      uLowLevel: { value: LIGHT_STEPS.lowLevel },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = true;

  const rotGroup = new THREE.Group();
  rotGroup.add(mesh);

  const pivot = new THREE.Group();
  pivot.add(rotGroup);

  return {
    pivot,
    rotGroup,
    material,
    setSunDirObject(v: THREE.Vector3) {
      (material.uniforms.uSunDirObj.value as THREE.Vector3).copy(v);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      landTexture.dispose();
    },
  };
}
