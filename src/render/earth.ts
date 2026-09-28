// The Earth sphere: land/ocean quantized shading + soft terminator, built from
// an object-space normal (not SphereGeometry UVs) so lon/lat sampling stays
// correct regardless of geometry tessellation.
import * as THREE from 'three';
import { EARTH_COLORS, TERMINATOR } from './palette';
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
uniform vec3 uOcean;
uniform vec3 uLand;
uniform vec3 uIce;
uniform vec3 uNightLand;
uniform vec3 uNightOcean;
uniform vec3 uWarm;
uniform float uTermWidth;

varying vec3 vNormalObj;

void main() {
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vNormalObj);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

  float land = texture2D(uLandTex, uv).r;

  // cheap low-frequency pseudo-noise for a "deep ocean" quantized band (stylized, not bathymetric)
  float noise = sin(lon * 2.3) * sin(lat * 3.1) + 0.5 * sin(lon * 1.1 - lat * 2.0);
  float deepMix = smoothstep(0.1, 0.5, noise);

  float iceLat = smoothstep(1.12, 1.22, abs(lat)); // ~64-70 deg

  vec3 dayOcean = mix(uOcean, uDeepOcean, deepMix);
  vec3 dayLand = mix(uLand, uIce, iceLat);
  vec3 dayColor = mix(dayOcean, dayLand, land);

  vec3 nightColor = mix(uNightOcean, uNightLand, land);

  float ndotl = dot(n, normalize(uSunDirObj));
  float dayMix = smoothstep(-uTermWidth, uTermWidth, ndotl);
  float warmFactor = 1.0 - smoothstep(0.0, uTermWidth, abs(ndotl));

  vec3 color = mix(nightColor, dayColor, dayMix);
  color = mix(color, uWarm, warmFactor * 0.3 * dayMix + warmFactor * 0.08 * (1.0 - dayMix));

  gl_FragColor = vec4(color, 1.0);
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
      uOcean: { value: EARTH_COLORS.ocean },
      uLand: { value: EARTH_COLORS.land },
      uIce: { value: EARTH_COLORS.iceLand },
      uNightLand: { value: EARTH_COLORS.nightLand },
      uNightOcean: { value: EARTH_COLORS.nightOcean },
      uWarm: { value: TERMINATOR.warm },
      uTermWidth: { value: Math.sin(TERMINATOR.widthRad) },
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
