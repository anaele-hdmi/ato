// Atmosphere: a front-side shell whose fragment shader ray-marches the view
// ray through an exponential atmosphere (analytic ray/sphere intersections,
// Earth occlusion included). This stays correct from any distance — the thin
// bright limb and the faint haze over the disc both fall out of path length —
// unlike a fresnel rim on a BackSide sphere, which breaks down when the camera
// is only 420 km up. Colour per sample comes from the sun elevation at that
// sample (day blue / dusk orange-red / night airglow), all from palette.ts.
import * as THREE from 'three';
import { ATMOSPHERE } from './palette';
import { EARTH_RADIUS_KM } from '../types';

/** Analytic top of the atmosphere used by the shader. */
const ATMO_TOP_KM = 130;
/** Geometry sits a little higher so polygon faceting never clips the analytic edge. */
// Must stay below the station altitude (420 km): the shell is FrontSide.
const SHELL_HEIGHT_KM = 330;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vWorldPosition;
varying vec3 vCenter;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  vCenter = modelMatrix[3].xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;

  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDir;
uniform vec3 uDayColor;
uniform vec3 uDuskOrange;
uniform vec3 uDuskRed;
uniform vec3 uNightColor;
uniform float uDayIntensity;
uniform float uDuskIntensity;
uniform float uNightIntensity;
uniform float uRadius;
uniform float uTop;
uniform float uDiscHaze;
uniform vec3 uGlowColor;
uniform vec3 uForwardColor;

varying vec3 vWorldPosition;
varying vec3 vCenter;

const float SCALE_H = 13.0;     // km, stylised scale height (thicker than real ~8 km)
const float GLOW_H = 70.0;      // km, faint outer glow that turns the sky above the limb navy
const float AIRGLOW_H = 95.0;   // km, airglow layer altitude
const float AIRGLOW_W = 4.0;    // km, layer half-width
const int STEPS = 18;

// Returns (tNear, tFar) of a ray against a sphere at the origin, or (-1,-1).
vec2 hitSphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 o = cameraPosition - vCenter;
  vec3 d = normalize(vWorldPosition - cameraPosition);
  vec3 sunDir = normalize(uSunDir);

  vec2 ground0 = hitSphere(o, d, uRadius);
  // Outer glow, analytic: a tall faint layer evaluated at the ray's closest
  // approach (Chapman-style column ~ exp(-h/H) * sqrt(2*pi*R*H)). Marching it
  // over thousands of km with few steps produced visible bands.
  vec3 outer = vec3(0.0);
  if (ground0.x <= 0.0) {
    float tc = max(-dot(o, d), 0.0);
    vec3 pc = o + d * tc;
    float hc = length(pc) - uRadius;
    float lit = smoothstep(-0.2, 0.25, dot(normalize(pc), sunDir));
    outer = uGlowColor * exp(-max(hc, 0.0) / GLOW_H) * lit;
  }

  vec2 atm = hitSphere(o, d, uRadius + uTop);
  if (atm.y <= 0.0) {
    vec3 oc = outer * 0.5;
    gl_FragColor = vec4(oc, max(oc.r, max(oc.g, oc.b)));
    #include <colorspace_fragment>
    return;
  }
  float t0 = max(atm.x, 0.0);
  float t1 = atm.y;
  vec2 ground = hitSphere(o, d, uRadius);
  bool hitsGround = ground.x > 0.0;
  if (hitsGround) t1 = min(t1, ground.x);

  float dt = (t1 - t0) / float(STEPS);
  vec3 scatter = vec3(0.0);
  vec3 glow = vec3(0.0);
  float depth = 0.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = o + d * (t0 + (float(i) + 0.5) * dt);
    float r = length(p);
    float h = max(r - uRadius, 0.0);
    float rho = exp(-h / SCALE_H) * dt;
    depth += rho;

    float sunElev = dot(p / r, sunDir);
    float day = smoothstep(-0.06, 0.10, sunElev);
    float dusk = 1.0 - smoothstep(0.0, 0.22, abs(sunElev + 0.02));
    vec3 duskCol = mix(uDuskRed, uDuskOrange, smoothstep(-0.10, 0.05, sunElev));
    vec3 c = uDayColor * uDayIntensity * day;
    c = mix(c, duskCol * uDuskIntensity, dusk * 0.85);
    // light that reaches this sample is itself attenuated by what's already in front of it
    scatter += c * rho * exp(-depth * 0.012);

    float g = exp(-pow((h - AIRGLOW_H) / AIRGLOW_W, 2.0)) * (1.0 - day);
    glow += uNightColor * uNightIntensity * g * dt;
  }

  if (hitsGround) scatter *= uDiscHaze;
  // forward scattering: warm cream brightening toward the Sun
  float mu = max(dot(d, sunDir), 0.0);
  vec3 forward = uForwardColor * (pow(mu, 6.0) * 0.8 + pow(mu, 40.0) * 1.5);
  vec3 col = 1.0 - exp(-scatter * 0.06 * (vec3(1.0) + forward)) + glow * 0.02 + outer * 0.5;
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

export interface AtmosphereObjects {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  setSunDir(v: THREE.Vector3): void;
  dispose(): void;
}

export function createAtmosphere(): AtmosphereObjects {
  const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM + SHELL_HEIGHT_KM, 192, 128);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uDayColor: { value: ATMOSPHERE.dayBlue },
      uDuskOrange: { value: ATMOSPHERE.duskOrange },
      uDuskRed: { value: ATMOSPHERE.duskRed },
      uNightColor: { value: ATMOSPHERE.nightAirglow },
      uDayIntensity: { value: ATMOSPHERE.dayIntensity },
      uDuskIntensity: { value: ATMOSPHERE.duskIntensity },
      uNightIntensity: { value: ATMOSPHERE.nightIntensity },
      uRadius: { value: EARTH_RADIUS_KM },
      uTop: { value: ATMO_TOP_KM },
      uDiscHaze: { value: ATMOSPHERE.discHaze },
      uGlowColor: { value: ATMOSPHERE.outerGlow },
      uForwardColor: { value: ATMOSPHERE.forward },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);

  return {
    mesh,
    material,
    setSunDir(v: THREE.Vector3) {
      (material.uniforms.uSunDir.value as THREE.Vector3).copy(v);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
