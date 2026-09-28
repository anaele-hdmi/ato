// The large-scale cloud field, baked on the GPU into a small equirectangular
// texture instead of being evaluated per fragment every frame (performance:
// the macro field is ~10 noise lookups; the ground's cloud shadows and the
// cloud shell both need it). It drifts slowly, so re-baking every couple of
// simulated minutes is invisible.
//
// Stored value: r = clamp(field * 0.5 + 0.5). field > 0 = cloud, < 0 = clear.
import * as THREE from 'three';
import { NOISE_GLSL as CLOUD_GLSL } from './noiseGlsl';

const WIDTH = 1024;
const HEIGHT = 512;
/** Re-bake when the sim clock has moved this far (seconds) since the last bake. */
const REBAKE_SIM_SECONDS = 90;

/** GLSL for consumers: `cloudMacro(n)` returns the signed macro field for an object-space unit vector. */
export const CLOUD_MAP_GLSL = /* glsl */ `
uniform sampler2D uCloudMap;
float cloudMacro(vec3 n) {
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  return texture2D(uCloudMap, uv).r * 2.0 - 1.0;
}
`;

const BAKE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Richer than the old per-fragment field (it only runs at bake time): weather
// systems (large clear/cloudy regions) × cell fields × a climatology envelope,
// so the result has distinct clumps and real gaps instead of an even veil.
const BAKE_FRAGMENT = /* glsl */ `
#include <common>
uniform float uTime;
varying vec2 vUv;

${CLOUD_GLSL}

float fbm6(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 6; i++) {
    s += cloudNoise(p) * a;
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  float lat = (0.5 - vUv.y) * PI;
  float lon = (vUv.x - 0.5) * 2.0 * PI;
  vec3 n = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));

  float t = uTime;
  vec3 p = n * 2.6;
  vec3 wp = p * 0.6 + vec3(t * 0.006, 0.0, t * 0.004);
  vec3 warp = vec3(cloudFbm2(wp), cloudFbm2(wp + vec3(11.3, 4.7, 8.1)), cloudFbm2(wp + vec3(23.1, 17.9, 2.4))) - 0.5;
  vec3 sp = p + warp * 2.2 + vec3(t * 0.012, 0.0, -t * 0.008);

  // roughly unit-variance terms
  float cells = (fbm6(sp * 1.8) - 0.5) / 0.11;
  float systems = (cloudFbm4(n * 1.3 + warp + vec3(t * 0.003, 0.0, 0.0)) - 0.5) / 0.1;

  float latDeg = degrees(lat);
  float itcz = exp(-pow((latDeg - 6.0) / 9.0, 2.0));
  float subtropics = exp(-pow((abs(latDeg) - 24.0) / 9.0, 2.0));
  float storm = exp(-pow((abs(latDeg) - 52.0) / 14.0, 2.0));
  float climate = itcz * 1.2 + storm * 0.9 - subtropics * 1.1 - 0.15;

  float field = 0.16 * (cells * 0.85 + systems * 0.9 + climate * 1.6);
  gl_FragColor = vec4(clamp(field * 0.5 + 0.5, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

export interface CloudMap {
  texture: THREE.Texture;
  /** Re-bakes if the sim clock moved enough. Call before rendering the frame. */
  update(renderer: THREE.WebGLRenderer, shaderTimeSec: number): void;
  dispose(): void;
}

export function createCloudMap(): CloudMap {
  const target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;

  const material = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    uniforms: { uTime: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let lastBake = Number.NaN;

  return {
    texture: target.texture,
    update(renderer, t) {
      if (Number.isFinite(lastBake) && Math.abs(t - lastBake) < REBAKE_SIM_SECONDS) return;
      lastBake = t;
      material.uniforms.uTime.value = t;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
    },
    dispose() {
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
