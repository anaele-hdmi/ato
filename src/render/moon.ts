// The Moon: one camera-facing quad far out along the true (station-centric)
// direction, shaded as a sphere in the fragment shader. Depth-tested against
// the Earth, so moonrise / moonset happen where the geometry says. The near
// side is drawn with a small table of real maria (selenographic lon/lat) and
// two bright ray craters; lit by the Sun with a Lommel-Seeliger law (flat
// full moon, no dark limb), dim earthshine on the rest.
//
// Near the Earth's limb the light is reddened and dimmed by the tangent-ray
// optical depth (Rayleigh, H ~ 8 km), so the Moon sets red behind the thin
// atmosphere. Lunar eclipses (Moon inside Earth's umbra) turn it dim copper.
//
// Cost: 2 triangles; fragment work only on the disc (+ a faint halo).
import * as THREE from 'three';
import { MOON } from './palette';
import { skyExposure } from './stars';
import { EARTH_RADIUS_KM } from '../types';

const DISTANCE_KM = 88000;
const MOON_RADIUS_KM = 1737.4;
/** Quad half-size in Moon radii (room for the halo). */
const QUAD_SCALE = 4;

// [lon E+, lat N+, radius] in degrees: the main maria, IAU selenographic.
const MARIA: Array<[number, number, number]> = [
  [-16, 33, 18], // Imbrium
  [18, 28, 10], // Serenitatis
  [31, 8, 11], // Tranquillitatis
  [52, -4, 9], // Fecunditatis
  [59, 17, 6], // Crisium
  [-15, -21, 9], // Nubium
  [-39, -24, 6], // Humorum
  [-57, 20, 20], // Procellarum
  [34, -15, 5], // Nectaris
  [3, 13, 5], // Vaporum
  [-23, -10, 5], // Cognitum
  [0, 58, 6], // Frigoris
];
// Bright ray craters: Tycho, Copernicus.
const CRATERS: Array<[number, number, number]> = [
  [-11.4, -43.3, 3],
  [-20.1, 9.7, 2.2],
];

function lunarVec(lonDeg: number, latDeg: number, radiusDeg: number): THREE.Vector4 {
  const lo = THREE.MathUtils.degToRad(lonDeg);
  const la = THREE.MathUtils.degToRad(latDeg);
  // lunar frame: x = right (east), y = north, z = toward the Earth (sub-Earth point)
  return new THREE.Vector4(
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
    Math.cos(la) * Math.cos(lo),
    THREE.MathUtils.degToRad(radiusDeg),
  );
}

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uQuadScale;
varying vec2 vQ;
varying vec3 vWorld;
void main() {
  vQ = position.xy * uQuadScale;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFront;   // towards the viewer
uniform vec3 uMoonRight;  // lunar frame in world space
uniform vec3 uMoonUp;
uniform vec3 uMoonFront;  // sub-Earth point
uniform vec3 uSunDir;
uniform vec3 uEarthCenter;
uniform float uEarthR;
uniform vec3 uHighland;
uniform vec3 uMare;
uniform vec3 uEarthshine;
uniform vec3 uEclipseColor;
uniform float uBrightness;
uniform float uGain;
uniform float uHalo;
uniform float uEclipse;
uniform vec4 uMaria[12];
uniform vec4 uCraters[2];
varying vec2 vQ;
varying vec3 vWorld;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

void main() {
  #include <logdepthbuf_fragment>
  float r = length(vQ);
  float w = max(fwidth(r), 1e-4);
  float cov = 1.0 - smoothstep(1.0 - w, 1.0 + w, r);

  // atmospheric extinction along the (pixel) ray: tangent altitude above the limb
  vec3 o = cameraPosition - uEarthCenter;
  vec3 d = normalize(vWorld - cameraPosition);
  float tc = -dot(o, d);
  float hc = length(o + d * tc) - uEarthR;
  float tau = tc > 0.0 ? 7.0 * exp(-max(hc, 0.0) / 8.0) : 0.0;
  vec3 trans = exp(-tau * vec3(0.51, 1.0, 2.2));

  vec3 col = vec3(0.0);
  if (r < 1.0 + 2.0 * w) {
    float z = sqrt(max(1.0 - r * r, 0.0));
    vec3 N = uCamRight * vQ.x + uCamUp * vQ.y + uCamFront * z;
    vec3 nl = vec3(dot(N, uMoonRight), dot(N, uMoonUp), dot(N, uMoonFront));

    // albedo: highlands, maria, mottling, bright ray craters
    float mare = 0.0;
    for (int i = 0; i < 12; i++) {
      vec4 m = uMaria[i];
      float ang = acos(clamp(dot(nl, normalize(m.xyz)), -1.0, 1.0));
      mare = max(mare, 1.0 - smoothstep(0.55 * m.w, m.w, ang));
    }
    float n = vnoise(nl * 7.0) * 0.6 + vnoise(nl * 19.0) * 0.4;
    mare = clamp(mare * (0.75 + 0.5 * n), 0.0, 1.0);
    vec3 alb = mix(uHighland * (0.88 + 0.24 * n), uMare, mare);
    for (int i = 0; i < 2; i++) {
      vec4 c = uCraters[i];
      float ang = acos(clamp(dot(nl, normalize(c.xyz)), -1.0, 1.0));
      alb = mix(alb, uHighland * 1.15, (1.0 - smoothstep(0.0, c.w, ang)) * 0.8);
    }

    float mu0 = dot(N, uSunDir);
    float mu = max(z, 1e-3);
    float lit = max(mu0, 0.0);
    float ls = lit / (lit + mu) * 2.0;  // Lommel-Seeliger, 1 at the sub-solar centre
    vec3 litCol = alb * ls * uBrightness;
    vec3 eclipsed = uEclipseColor * ls * uBrightness * 0.08;
    litCol = mix(litCol, eclipsed, uEclipse);
    // earthshine on the unlit part (faint, follows the Earth-facing cosine)
    float es = max(dot(N, uMoonFront), 0.0);
    col = litCol + alb * uEarthshine * es * (1.0 - smoothstep(0.0, 0.25, lit));
  }
  // faint glow around the disc
  float halo = r > 1.0 ? uHalo * exp(-(r - 1.0) * 2.4) * (1.0 - smoothstep(3.0, 4.0, r)) : 0.0;
  vec3 haloCol = vec3(0.85, 0.9, 1.0) * halo * (1.0 - uEclipse);

  vec3 outc = (col * cov + haloCol) * trans * uGain;
  gl_FragColor = vec4(outc, cov * dot(trans, vec3(0.3333)) * min(uGain, 1.0));
}
`;

export interface MoonUpdate {
  /** Unit direction from the station to the Moon, world (scene) frame. */
  dirWorld: THREE.Vector3;
  /** Station-to-Moon distance, km. */
  distKm: number;
  sunDirWorld: THREE.Vector3;
  /** World position of the Earth's centre (the floating-origin pivot). */
  earthCenter: THREE.Vector3;
  /** 0..1: Moon inside Earth's umbra. */
  eclipse: number;
  /** Illuminated fraction 0..1 (scales the halo). */
  illum: number;
}

export interface MoonObjects {
  mesh: THREE.Mesh;
  /** Exposure of the sky adaptation (same 0..1 value the stars use). */
  setExposure(x: number): void;
  update(camera: THREE.Camera, u: MoonUpdate): void;
  dispose(): void;
}

/** 0 outside Earth's shadow, 1 in the umbra (geocentric, angular sizes at the Moon). */
export function moonEclipseFactor(moonPosScene: THREE.Vector3, sunDirScene: THREE.Vector3): number {
  const cosSep = -moonPosScene.dot(sunDirScene) / moonPosScene.length();
  const sepDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(cosSep, -1, 1)));
  return 1 - THREE.MathUtils.smoothstep(sepDeg, 0.43, 0.95);
}

export function createMoon(): MoonObjects {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uQuadScale: { value: QUAD_SCALE },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uCamFront: { value: new THREE.Vector3(0, 0, 1) },
      uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
      uMoonUp: { value: new THREE.Vector3(0, 1, 0) },
      uMoonFront: { value: new THREE.Vector3(0, 0, 1) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uEarthCenter: { value: new THREE.Vector3() },
      uEarthR: { value: EARTH_RADIUS_KM },
      uHighland: { value: MOON.highland },
      uMare: { value: MOON.mare },
      uEarthshine: { value: MOON.earthshine.clone().multiplyScalar(MOON.earthshineStrength) },
      uEclipseColor: { value: MOON.eclipse },
      uBrightness: { value: MOON.brightness },
      uGain: { value: 1 },
      uHalo: { value: MOON.halo },
      uEclipse: { value: 0 },
      uMaria: { value: MARIA.map(([lo, la, r]) => lunarVec(lo, la, r)) },
      uCraters: { value: CRATERS.map(([lo, la, r]) => lunarVec(lo, la, r)) },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // after the stars (-2) and the Sun glare (-1), before the Earth shells
  mesh.renderOrder = -0.5;
  mesh.name = 'moon';

  const eye = new THREE.Vector3();
  const north = new THREE.Vector3(0, 1, 0);
  const front = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const U = material.uniforms;

  return {
    mesh,
    setExposure(x) {
      // The Moon is far brighter than any star: it fades much more gently
      // than the star field when the eye is daylight-adapted.
      const { gain } = skyExposure(x);
      const g = 0.3 + 0.7 * Math.sqrt(gain);
      U.uGain.value = g;
      mesh.visible = x > 0.002;
    },
    update(camera, u) {
      camera.getWorldPosition(eye);
      const angRadius = Math.asin(Math.min(1, MOON_RADIUS_KM / u.distKm));
      const size = DISTANCE_KM * Math.tan(angRadius) * QUAD_SCALE;
      mesh.position.copy(eye).addScaledVector(u.dirWorld, DISTANCE_KM);
      mesh.scale.set(size, size, 1);
      mesh.lookAt(eye);
      mesh.updateMatrixWorld();
      // quad axes in world space (for the sphere normal)
      const e = mesh.matrixWorld.elements;
      (U.uCamRight.value as THREE.Vector3).set(e[0], e[1], e[2]).normalize();
      (U.uCamUp.value as THREE.Vector3).set(e[4], e[5], e[6]).normalize();
      (U.uCamFront.value as THREE.Vector3).set(e[8], e[9], e[10]).normalize();

      // lunar frame: z toward the Earth, y = celestial north projected, x = right
      // as seen by an observer with north up (selenographic east appears to the right)
      front.copy(u.dirWorld).negate();
      up.copy(north).addScaledVector(front, -north.dot(front));
      if (up.lengthSq() < 1e-8) up.set(0, 0, 1);
      up.normalize();
      right.crossVectors(tmp.copy(front).negate(), up).normalize();
      (U.uMoonRight.value as THREE.Vector3).copy(right);
      (U.uMoonUp.value as THREE.Vector3).copy(up);
      (U.uMoonFront.value as THREE.Vector3).copy(front);
      (U.uSunDir.value as THREE.Vector3).copy(u.sunDirWorld);
      (U.uEarthCenter.value as THREE.Vector3).copy(u.earthCenter);
      U.uEclipse.value = u.eclipse;
      U.uHalo.value = MOON.halo * u.illum * u.illum;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
