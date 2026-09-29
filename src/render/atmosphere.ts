// Atmosphere: physically structured single scattering (Rayleigh + Mie +
// ozone absorption), in the spirit of Hillaire 2020 / Bruneton 2017,
// simplified for mobile.
//
// - A transmittance LUT (height x cos sun-zenith) is computed once on the CPU
//   (atmosphereLut.ts). Per view sample the sun transmittance is ONE texture
//   fetch; there is no inner light march.
// - The view ray is marched with 14 steps (6 for rays that end on the ground) through the shell, with a quadratic
//   warp that clusters samples around the ray's closest approach to Earth's
//   centre (the densest point for a limb ray; the ground end for a ray that
//   hits the disc), so the thin limb doesn't band.
// - Earth's shadow: a sample whose sun ray is below its geometric horizon gets
//   no direct light (soft edge ~ the sun's disc). Together with the reddened
//   grazing transmittance this produces the orange/red twilight band, the
//   blue layer above it and ozone's violet tint.
// - A cheap isotropic multiple-scattering ambient keeps the deep-blue twilight
//   from going pitch black.
// - Output is additive in-scattered radiance through a soft exponential
//   tonemap; the night-side airglow line and the faint navy outer glow above
//   the lit limb are analytic (evaluated at the ray's tangent point).
//
// The geometry is a FrontSide sphere whose radius must stay BELOW the station
// altitude (420 km): the camera has to be outside it.
import * as THREE from 'three';
import { ATMOSPHERE, ATMOSPHERE_SCATTER as S } from './palette';
import { EARTH_RADIUS_KM } from '../types';
import { createTransmittanceLut, TRANSMITTANCE_LUT_WIDTH, TRANSMITTANCE_LUT_HEIGHT } from './atmosphereLut';

/** Geometry radius above the surface; well above the analytic top so polygon
 *  faceting never clips the medium. Must stay below 420 km (camera outside). */
const SHELL_HEIGHT_KM = 330;
/** Airglow layer (night side), km — kept from the analytic model. */
const AIRGLOW_H_KM = 95;
const AIRGLOW_W_KM = 2.5;

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

uniform sampler2D uTransmittance;
uniform vec2 uLutSize;
uniform vec3 uSunDir;
uniform float uRadius;
uniform float uTop;            // radius of the top of the atmosphere
uniform float uLutH;           // sqrt(top^2 - R^2): LUT horizon distance
uniform vec3 uRayleigh;        // scattering = extinction, /km
uniform float uRayleighH;
uniform float uMieScat;
uniform float uMieExt;
uniform float uMieH;
uniform float uMieG;
uniform vec3 uOzone;           // absorption, /km
uniform float uOzoneC;
uniform float uOzoneW;
uniform vec3 uSunColor;
uniform float uExposure;
uniform float uWhite;
uniform vec3 uMsColor;
uniform float uMsStrength;
uniform vec2 uMsMu;
uniform float uShadowSoft;
uniform float uDiscHaze;
uniform float uDiscGraze;
uniform vec3 uGlowColor;
uniform float uGlowStrength;
uniform float uGlowH;
uniform vec3 uAirglowColor;
uniform float uAirglowIntensity;
uniform float uAirglowH;
uniform float uAirglowW;

varying vec3 vWorldPosition;
varying vec3 vCenter;

#define STEPS 14      // limb rays
#define STEPS_GROUND 6  // rays that end on the ground (haze is faint there)

// Transmittance LUT lookup (Bruneton parameterisation, see atmosphereLut.ts).
vec3 sunTransmittance(float r, float mu) {
  float H = uLutH;
  float rho = sqrt(max(r * r - uRadius * uRadius, 0.0));
  float disc = r * r * (mu * mu - 1.0) + uTop * uTop;
  float d = max(-r * mu + sqrt(max(disc, 0.0)), 0.0);
  float dMin = uTop - r;
  float dMax = rho + H;
  float xmu = clamp((d - dMin) / max(dMax - dMin, 1e-3), 0.0, 1.0);
  float xr = rho / H;
  vec2 uv = vec2(xmu, xr) * (1.0 - 1.0 / uLutSize) + 0.5 / uLutSize;
  return texture2D(uTransmittance, uv).rgb;
}

float miePhase(float nu) {
  // Cornette-Shanks
  float g = uMieG;
  float g2 = g * g;
  float k = 3.0 / (8.0 * PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + nu * nu) / pow(max(1.0 + g2 - 2.0 * g * nu, 1e-4), 1.5);
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 o = cameraPosition - vCenter;
  vec3 d = normalize(vWorldPosition - cameraPosition);
  vec3 sunDir = normalize(uSunDir);

  // Closest approach of the ray to Earth's centre. Computing the sphere
  // discriminant as (R - |pc|)(R + |pc|) avoids float cancellation at the limb.
  float tc = -dot(o, d);
  vec3 pc = o + d * tc;
  float rc = length(pc);
  float hc = rc - uRadius;          // tangent altitude (negative: ray hits Earth)
  bool hitsGround = hc < 0.0 && tc > 0.0;
  // pixel footprint in tangent altitude (km), for analytic anti-aliasing
  float hcW = fwidth(hc);

  // --- analytic outer glow + airglow (rays that miss the Earth) ----------
  vec3 extra = vec3(0.0);
  if (!hitsGround && tc > 0.0) {
    float muT = dot(pc / rc, sunDir);
    float lit = smoothstep(-0.2, 0.25, muT);
    extra += uGlowColor * uGlowStrength * exp(-max(hc, 0.0) / uGlowH) * lit;
    // thin layer at the tangent point; widen by the pixel footprint so it
    // never aliases, keeping its integrated brightness
    float w = max(uAirglowW, hcW * 1.5);
    float ax = (hc - uAirglowH) / w;
    float ag = exp(-ax * ax) * (uAirglowW / w);
    extra += uAirglowColor * uAirglowIntensity * ag * (1.0 - smoothstep(-0.25, 0.0, muT));
  }

  float discTop = (uTop - rc) * (uTop + rc);
  if (discTop <= 0.0 || tc + sqrt(max(discTop, 0.0)) <= 0.0) {
    gl_FragColor = vec4(extra, 1.0);
    #include <colorspace_fragment>
    return;
  }
  float sTop = sqrt(discTop);
  float t0 = max(tc - sTop, 0.0);
  float t1 = tc + sTop;
  if (hitsGround) {
    // stop at the ground; within ~1.5 px of the silhouette blend toward the
    // full limb path so the horizon edge is anti-aliased, not a hard step
    float sG = sqrt(max((uRadius - rc) * (uRadius + rc), 0.0));
    float soft = smoothstep(-max(hcW * 1.5, 0.3), 0.0, hc);
    t1 = mix(min(t1, tc - sG), t1, soft);
  }
  if (t1 <= t0) {
    gl_FragColor = vec4(extra, 1.0);
    #include <colorspace_fragment>
    return;
  }

  // Quadratic warp: s in [0,1] -> t, dense around tm (closest approach
  // clamped into the segment). f = share of samples before tm.
  float tm = clamp(tc, t0, t1);
  float A = tm - t0;
  float B = t1 - tm;
  float f = clamp(A / (A + B), 1e-4, 1.0 - 1e-4);

  float nu = dot(d, sunDir);
  float phR = 3.0 / (16.0 * PI) * (1.0 + nu * nu);
  float phM = miePhase(nu);

  vec3 L = vec3(0.0);
  vec3 od = vec3(0.0);   // view optical depth accumulated so far
  // fewer steps for rays that end on the ground (most of the screen); the
  // last ~uDiscGraze km of tangent depth keep the full count so the horizon
  // stays seamless
  int steps = (hitsGround && hc < -uDiscGraze) ? STEPS_GROUND : STEPS;
  float ds = 1.0 / float(steps);
  for (int i = 0; i < STEPS; i++) {
    if (i >= steps) break;
    float s = (float(i) + 0.5) * ds;
    float t, dt;
    if (s < f) {
      float u = (f - s) / f;
      t = tm - A * u * u;
      dt = 2.0 * A * u / f * ds;
    } else {
      float u = (s - f) / (1.0 - f);
      t = tm + B * u * u;
      dt = 2.0 * B * u / (1.0 - f) * ds;
    }
    vec3 p = o + d * t;
    float r = length(p);
    float h = max(r - uRadius, 0.0);
    float dR = exp(-h / uRayleighH);
    float dM = exp(-h / uMieH);
    float dO = max(0.0, 1.0 - abs(h - uOzoneC) / uOzoneW);

    vec3 sigT = uRayleigh * dR + vec3(uMieExt * dM) + uOzone * dO;
    vec3 stepOd = sigT * dt;
    // transmittance camera -> middle of this step
    vec3 Tv = exp(-(od + 0.5 * stepOd));
    od += stepOd;

    float muS = dot(p, sunDir) / r;
    vec3 Ts = sunTransmittance(r, muS);
    // Earth's shadow: sun below this sample's geometric horizon
    float muH = -sqrt(max(1.0 - (uRadius / r) * (uRadius / r), 0.0));
    float lit = smoothstep(muH - uShadowSoft, muH + uShadowSoft, muS);

    vec3 scatR = uRayleigh * dR;
    float scatM = uMieScat * dM;
    vec3 single = (scatR * phR + scatM * phM) * Ts * lit;
    // multiple scattering: isotropic, fed by the (softened) light that
    // reaches this altitude, so deep twilight layers go dim/warm, not blue
    vec3 ms = (scatR + scatM) * uMsColor * uMsStrength * sqrt(sqrt(Ts))
      * smoothstep(uMsMu.x, uMsMu.y, muS);
    L += Tv * (single + ms) * dt;
  }
  L *= uSunColor;

  if (hitsGround) {
    // aerial perspective over the disc: modest (the ground shader has its own
    // haze), ramping to the full limb value at grazing so the horizon is seamless
    L *= mix(uDiscHaze, 1.0, smoothstep(-uDiscGraze, 0.0, hc));
  }

  vec3 col = uWhite * (1.0 - exp(-L * (uExposure / uWhite)));
  col += extra;
  gl_FragColor = vec4(col, 1.0);
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
  const k = S.heightScale;
  const top = EARTH_RADIUS_KM + S.topKm * k;
  const lut = createTransmittanceLut({
    radius: EARTH_RADIUS_KM,
    top,
    rayleighScattering: S.rayleighScattering,
    rayleighHeight: S.rayleighHeightKm * k,
    mieExtinction: S.mieExtinction,
    mieHeight: S.mieHeightKm * k,
    ozoneAbsorption: S.ozoneAbsorption.clone().multiplyScalar(S.ozoneStrength),
    ozoneCenter: S.ozoneCenterKm * k,
    ozoneHalfWidth: S.ozoneHalfWidthKm * k,
  });

  const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM + SHELL_HEIGHT_KM, 192, 128);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTransmittance: { value: lut },
      uLutSize: { value: new THREE.Vector2(TRANSMITTANCE_LUT_WIDTH, TRANSMITTANCE_LUT_HEIGHT) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uRadius: { value: EARTH_RADIUS_KM },
      uTop: { value: top },
      uLutH: { value: Math.sqrt(top * top - EARTH_RADIUS_KM * EARTH_RADIUS_KM) },
      uRayleigh: { value: S.rayleighScattering },
      uRayleighH: { value: S.rayleighHeightKm * k },
      uMieScat: { value: S.mieScattering },
      uMieExt: { value: S.mieExtinction },
      uMieH: { value: S.mieHeightKm * k },
      uMieG: { value: S.mieG },
      uOzone: { value: S.ozoneAbsorption.clone().multiplyScalar(S.ozoneStrength) },
      uOzoneC: { value: S.ozoneCenterKm * k },
      uOzoneW: { value: S.ozoneHalfWidthKm * k },
      uSunColor: { value: S.sunColor },
      uExposure: { value: S.exposure },
      uWhite: { value: S.white },
      uMsColor: { value: S.multiScatterColor },
      uMsStrength: { value: S.multiScatter },
      uMsMu: { value: new THREE.Vector2(S.multiScatterMuLow, S.multiScatterMuHigh) },
      uShadowSoft: { value: S.shadowSoftness },
      uDiscHaze: { value: S.discHaze },
      uDiscGraze: { value: S.discGrazeKm },
      uGlowColor: { value: S.outerGlow },
      uGlowStrength: { value: S.outerGlowStrength },
      uGlowH: { value: S.outerGlowHeightKm },
      uAirglowColor: { value: ATMOSPHERE.nightAirglow },
      uAirglowIntensity: { value: ATMOSPHERE.nightIntensity },
      uAirglowH: { value: AIRGLOW_H_KM },
      uAirglowW: { value: AIRGLOW_W_KM },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    // premultiplied additive: rgb is added as-is (ONE, ONE)
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // draw after the cloud shell (renderOrder 1) so aerial perspective covers clouds too
  mesh.renderOrder = 2;

  return {
    mesh,
    material,
    setSunDir(v: THREE.Vector3) {
      (material.uniforms.uSunDir.value as THREE.Vector3).copy(v);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      lut.dispose();
    },
  };
}
