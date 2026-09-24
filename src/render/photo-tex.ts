// Photographic detail from CC0 texture scans (public/tex, see credits.json). The scene
// keeps choosing base colours; a photo only lends the grain of the real material.
import * as THREE from 'three';
import { shared } from './shared';

export const PHOTO_FN = /* glsl */ `
uniform float uPhoto;
uniform sampler2D uTexMeadow;
uniform sampler2D uTexMeadow2;
uniform sampler2D uTexMacro;
uniform sampler2D uTexTrack;
uniform sampler2D uTexSoil;
uniform sampler2D uTexRoof;
uniform sampler2D uTexLeaves;
uniform vec3 uMeanMeadow;
uniform vec3 uMeanMeadow2;
uniform vec3 uMeanMacro;
uniform vec3 uMeanTrack;
uniform vec3 uMeanSoil;
uniform vec3 uMeanRoof;
uniform vec3 uMeanLeaves;
// photo colour relative to its own average, partly desaturated so hue stays ours
vec3 photoDetail(sampler2D t, vec3 mean, vec2 uv, float keepHue) {
  vec3 c = pow(texture2D(t, uv).rgb, vec3(2.2)) / max(mean, vec3(0.03));
  float l = dot(c, vec3(0.3, 0.55, 0.15));
  return clamp(mix(vec3(l), c, keepHue), 0.0, 3.0);
}
`;

const FILES = {
  uTexMeadow: 'meadow', uTexMeadow2: 'meadow2', uTexMacro: 'macro', uTexTrack: 'track',
  uTexSoil: 'soil', uTexRoof: 'roof', uTexLeaves: 'leaves',
} as const;

export const photoUniforms = {
  uPhoto: { value: 0 },
  ...Object.fromEntries(Object.keys(FILES).map((k) => [k, { value: null as THREE.Texture | null }])),
  uMeanMeadow: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uMeanMeadow2: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uMeanMacro: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uMeanTrack: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uMeanSoil: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uMeanRoof: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  uMeanLeaves: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
} as Record<string, THREE.IUniform>;
Object.assign(shared, photoUniforms);

export async function loadPhotoTextures(renderer: THREE.WebGLRenderer): Promise<void> {
  const base = './tex/';
  const credits = await (await fetch(`${base}credits.json`)).json() as { meanLinear: Record<string, number[]> };
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  await Promise.all(Object.entries(FILES).map(async ([uni, file]) => {
    const t = await loader.loadAsync(`${base}${file}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    photoUniforms[uni].value = t;
    const m = credits.meanLinear[file];
    const key = 'uMean' + uni.slice(4);
    if (m && photoUniforms[key]) (photoUniforms[key].value as THREE.Vector3).set(m[0], m[1], m[2]);
  }));
  photoUniforms.uPhoto.value = 1;
}
