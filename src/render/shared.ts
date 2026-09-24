// Uniforms shared by every world material. Spreading this object into a material's
// uniforms copies references, so a single write here reaches all shaders.
import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },
  uYear: { value: 1900 },
  uL: { value: 0 },
  uSeason: { value: 0.3 },
  uSeasonality: { value: 1 },
  uSunDir: { value: new THREE.Vector3(0.5, 0.5, 0.2).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uSkyAmb: { value: new THREE.Color(0.4, 0.5, 0.6) },
  uGroundAmb: { value: new THREE.Color(0.25, 0.22, 0.18) },
  uFogColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
  uFogDensity: { value: 0.0002 },
  uMist: { value: 0 },
  uNight: { value: 0 },
  uLightPollution: { value: 0 },
  uExposure: { value: 1 },
  uWind: { value: 0.3 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uCamTarget: { value: new THREE.Vector3() },
  uCamDist: { value: 10 },
  uShadowMap: { value: null as THREE.Texture | null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowTexel: { value: 1 / 2048 },
  uShadowOn: { value: 1 },
  /** 1 = crisp shadows; falls as the hours blur into one exposure. */
  uShadowFade: { value: 1 },
  uArid: { value: 0 },
  // terrain
  uHeightNear: { value: null as THREE.Texture | null },
  uHeightFar: { value: null as THREE.Texture | null },
  uNearExt: { value: 640 },
  uFarExt: { value: 12000 },
  uDisp: { value: 0 },
  uSeaLevel: { value: -2 },
  uRoads: { value: null as THREE.Texture | null },
  uRoadExt: { value: 1200 },
  // era scalars used by several materials
  uGravel: { value: 0 },
  uPaved: { value: 0 },
  uAvenue: { value: 0 },
  uFields: { value: 0 },
  uUrbanNear: { value: 0 },
  uRoadDecay: { value: 0 },
  uDecay: { value: 0 },
  uWild: { value: 0 },
  uForest: { value: 0 },
  uGlacial: { value: 0 },
  uChaos: { value: 0 },
  uIntro: { value: 1 },
};

export type Shared = typeof shared;
