// The large-scale cloud field, baked on the GPU into a small equirectangular
// RGBA texture instead of being evaluated per fragment every frame (the
// climatology + synoptic structure below is ~40 noise lookups per texel; the
// cloud shells and the ground's cloud shadows only fetch it).
//
// Channels (each a signed field f in [-1, 1], stored as f * 0.5 + 0.5;
// f > 0 = cloud, magnitude = how thick / how sure):
//   R  low cloud (base ~1 km): marine stratocumulus decks off the subtropical
//      west coasts, trade-wind cumulus over the tropical oceans, daytime
//      fair-weather cumulus over land, the Southern Ocean / storm-track low
//      deck, warm-sector stratus and cold-air cumulus behind cold fronts.
//   G  mid cloud (~5.5 km): altostratus shields of mid-latitude cyclones
//      (comma head, warm-front shield, cold-frontal band), altocumulus
//      patches, stratiform decks around tropical convection.
//   B  high cloud (~11.5 km): cirrus streaks along the meandering jet
//      streams, cirrostratus ahead of warm fronts, cumulonimbus anvils
//      spreading from convective clusters, tropical-cyclone canopies.
//      |B| < ~0.35 thin/translucent cirrus, B > ~0.5 thick anvil/shield.
//   A  convective regime: A > 0 = deep convection (cumulus congestus →
//      cumulonimbus tower strength: ITCZ, warm pool / Maritime Continent,
//      Amazon, Congo, monsoons, SPCZ, tropical cyclones; diurnal over land),
//      A < 0 = open-cell cold-air cumulus behind cold fronts.
//
// Keyframes: A at tA, B at tA + PERIOD are cross-faded by the sim clock so
// the clouds morph continuously. A third target (C, tA + 2·PERIOD) is baked
// a strip per frame while A→B is on screen, so the regular keyframe step
// costs no frame hitch (only a time skip / wrap bakes two keyframes at once).
import * as THREE from 'three';
import { NOISE_GLSL } from './noiseGlsl';
import { CLOUD_ALT_GLSL } from './cloudLayers';

const WIDTH = 1024;
const HEIGHT = 512;
/** Sim seconds between keyframes. */
const PERIOD_S = 120;
/** A keyframe is baked in this many horizontal strips, one per frame. */
const STRIPS = 8;

/** GLSL for consumers: `cloudFields(n)` returns the signed RGBA genera fields
 *  for an object-space unit vector; `cloudShadow` darkens the ground. Also
 *  carries the layer altitude constants (cloudLayers.ts). */
export const CLOUD_MAP_GLSL = /* glsl */ `
uniform sampler2D uCloudMapA;
uniform sampler2D uCloudMapB;
uniform float uCloudMix;
${CLOUD_ALT_GLSL}
vec2 cloudUv(vec3 n) {
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}
vec4 cloudFields(vec3 n) {
  vec2 uv = cloudUv(n);
  return mix(texture2D(uCloudMapA, uv), texture2D(uCloudMapB, uv), uCloudMix) * 2.0 - 1.0;
}
/** One keyframe only (half the fetches): for shadows, where a jump of one
 *  keyframe step (~2 sim minutes of drift, a few km) is invisible. */
vec4 cloudFieldsFast(vec3 n) {
  return texture2D(uCloudMapA, cloudUv(n)) * 2.0 - 1.0;
}
/** Legacy single field: the thickest genus. */
float cloudMacro(vec3 n) {
  vec4 f = cloudFields(n);
  return max(f.r, max(f.g, f.b));
}
/** Ground shadow (0..1) of all layers, each offset toward the sun by its true
 *  (rendered) height above the ground at n (object-space unit vector). */
float cloudShadow(vec3 n, float groundKm, vec3 L) {
  float mu = dot(n, L);
  if (mu <= 0.0) return 0.0;
  vec3 tang = L - n * mu;
  float k = 1.0 / (max(mu, 0.06) * CL_R0);
  float g = max(groundKm, 0.0);
  // two lookups: the low deck / tower bases, and one between the mid and
  // high shells for As, anvils, cirrus and tower tops
  const float UPPER = 0.5 * (CL_MID + CL_HIGH);
  vec4 fl = cloudFieldsFast(normalize(n + tang * max(CL_DECK_TOP - g, 0.0) * k));
  vec4 fu = cloudFieldsFast(normalize(n + tang * max(UPPER - g, 0.0) * k));
  float sLow = smoothstep(-0.12, 0.3, fl.r) * 0.8 * (1.0 - smoothstep(CL_LOW_BASE, CL_LOW_TOP, g));
  float sCb = smoothstep(0.08, 0.45, max(fl.a, fu.a)) * 0.85;
  float sMid = smoothstep(-0.05, 0.4, fu.g) * 0.5 * (1.0 - smoothstep(CL_MID - 3.0, CL_MID + 1.0, g));
  float sHigh = smoothstep(-0.1, 0.45, fu.b) * mix(0.06, 0.22, smoothstep(0.35, 0.7, fu.b)); // thin cirrus: faint
  return 1.0 - (1.0 - sLow) * (1.0 - sCb) * (1.0 - sMid) * (1.0 - sHigh);
}
`;

const BAKE_VERTEX = /* glsl */ `
uniform vec2 uStrip;
varying vec2 vUv;
void main() {
  // the full-screen quad squeezed into one horizontal strip [uStrip.x, uStrip.y] of the target
  float v = mix(uStrip.x, uStrip.y, uv.y);
  vUv = vec2(uv.x, v);
  gl_Position = vec4(position.x, v * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BAKE_FRAGMENT = /* glsl */ `
#include <common>
uniform float uTime;
uniform float uDoy;
uniform vec3 uSunObj;
uniform sampler2D uLandTex;
uniform sampler2D uBiomeTex;
uniform float uHasSurface;
varying vec2 vUv;

${NOISE_GLSL}

// Horizontal drift of the weather regimes (rigid rotations, so no shear
// builds up): tropics drift west with the trades, mid-latitudes east.
const float W_TROP = 1.6e-6;  // rad/s (~10 m/s at the equator)
const float W_MID = 2.6e-6;   // rad/s (~12 m/s at 45°)

float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { s += cloudNoise(p) * a; p *= 2.03; a *= 0.5; }
  return s / 0.875;
}
float fbm5(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { s += cloudNoise(p) * a; p *= 2.03; a *= 0.5; }
  return s / 0.96875;
}

/** n moved to longitude lon + a. */
vec3 shiftLon(vec3 n, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(n.x * c + n.z * s, n.y, n.z * c - n.x * s);
}

float wrapDeg(float d) { return mod(d + 540.0, 360.0) - 180.0; }

/** Soft elliptical region (degrees). */
float ell(float lonD, float latD, float cLon, float cLat, float rLon, float rLat) {
  vec2 d = vec2(wrapDeg(lonD - cLon) / rLon, (latD - cLat) / rLat);
  return exp(-dot(d, d));
}

// --- Mid-latitude cyclones ------------------------------------------------
// A stylized Norwegian-model cyclone per 45° longitude slot and hemisphere,
// with a random lifecycle: comma head spiralling into the low (cyclonic:
// counter-clockwise in the NH, mirrored in the SH), a warm-front
// cirrostratus/altostratus shield poleward-east of the low, a long curved
// cold-frontal band trailing equatorward, warm-sector stratus, and open-cell
// cumulus in the cold air behind the front.
// Returns (low, mid, high, openCells).
vec4 cyclones(float lonM, float latD, float hs, float t, vec2 warp) {
  float y = latD * hs; // poleward-positive latitude
  float coslat = cos(radians(latD));
  float cw = 45.0;
  float ci = floor(lonM / cw);
  vec4 acc = vec4(0.0);
  for (int k = -1; k <= 1; k++) {
    float cell = ci + float(k);
    float id = mod(cell, 8.0) + (hs > 0.0 ? 0.0 : 20.0);
    float ph = t / (3.5 * 86400.0) + cloudHash(vec3(id, 1.7, 3.1));
    float life = floor(ph);
    float f = fract(ph);
    vec3 hk = vec3(id * 1.37, life * 2.11, 5.3);
    float present = step(0.15, cloudHash(hk));
    float amp = present * pow(sin(PI * f), 0.6) * mix(0.75, 1.0, cloudHash(hk + 9.1));
    float tilt = 0.26 + 0.2 * cloudHash(hk + 6.2);    // cold-front orientation
    float curl = 0.9 + 1.1 * cloudHash(hk + 8.8);     // how tightly the head wraps
    float cx = (cell + 0.5 + (cloudHash(hk + 1.3) - 0.5) * 0.5) * cw + f * 16.0;
    float cy = 45.0 + (cloudHash(hk + 2.9) - 0.5) * 12.0 + f * 7.0;
    float L = 12.0 + cloudHash(hk + 4.4) * 7.0;
    float dLon = wrapDeg(lonM - cx);
    // storm-track strength at the low centre: NH N Pacific / N Atlantic, SH all round
    float cLonGeo = cx; // (drift frame ≈ geography over one lifecycle)
    float track = hs > 0.0
      ? 0.6 + 0.4 * max(ell(cLonGeo, cy, 175.0, 47.0, 45.0, 20.0), ell(cLonGeo, cy, -35.0, 50.0, 35.0, 20.0))
      : 1.0;
    amp *= track * (1.0 - smoothstep(40.0, 56.0, abs(dLon)));

    float u = dLon * coslat / L + warp.x * 0.75;
    float v = (y - cy) / L + warp.y * 0.75;
    float r = length(vec2(u, v));
    float ang = atan(v, u);

    // comma head: log spiral wrapping N → W → S into the centre as it matures
    float arm = cos(ang + curl * (0.6 + f) * log(r + 0.08) - 0.8);
    float head = smoothstep(-0.2, 0.7, arm) * smoothstep(1.35, 0.3, r);
    head = max(head, smoothstep(0.3, 0.05, r) * 0.8);
    // cold front: from the triple point, trailing equatorward and west
    float uf = 0.3 + tilt * v + 0.07 * v * v;
    float du = u - uf;
    float along = smoothstep(-2.4, -1.5, v) * smoothstep(0.45, 0.05, v);
    float frontLo = exp(-du * du / (du < 0.0 ? 0.012 : 0.04)) * along;
    float frontHi = exp(-du * du / (du < 0.0 ? 0.015 : 0.16)) * along;
    // warm front and the shield ahead (poleward) of it
    float vw = 0.1 - 0.32 * (u - 0.3);
    float ahead = v - vw;
    float uWin = smoothstep(-0.4, 0.2, u) * smoothstep(2.4, 1.3, u);
    float shieldMid = smoothstep(-0.05, 0.3, ahead) * smoothstep(1.5, 0.6, ahead) * uWin;
    float shieldHi = smoothstep(-0.15, 0.25, ahead) * smoothstep(2.1, 0.9, ahead) * smoothstep(-0.4, 0.2, u) * smoothstep(3.0, 1.6, u);
    float warmSec = smoothstep(0.05, 0.3, du) * smoothstep(0.1, -0.25, ahead) * smoothstep(-2.2, -1.0, v) * smoothstep(2.0, 1.0, u);
    float coldAir = smoothstep(0.05, 0.45, -du) * smoothstep(-2.6, -1.3, v) * smoothstep(0.7, -0.1, v) * smoothstep(-2.4, -1.3, u);
    // fronts fade out before the subtropics
    float sub = smoothstep(20.0, 32.0, y);
    frontLo *= sub;
    frontHi *= sub;

    vec4 c = vec4(
      max(max(frontLo * 0.8, head * 0.55), max(warmSec * 0.45, coldAir * 0.6)),
      max(max(frontHi * 0.8, head * 0.95), shieldMid * 0.9),
      max(max(frontHi * 0.95, head * 0.7), shieldHi),
      coldAir
    ) * amp;
    acc = max(acc, c);
  }
  return acc;
}

// --- Tropical cyclones ----------------------------------------------------
// Probabilistic, seasonal (NH Jul–Nov, SH Jan–Mar), only in the warm-ocean
// basins; drift west and poleward over a ~5-day life. Eye, central dense
// overcast, two spiral rain bands, a wide cirrus outflow canopy.
// Returns (low, mid, high, convection).
vec4 tropicalCyclones(float lonT, float latD, float hs, float t, float seasonNH, float seasonSH) {
  if (abs(latD) > 42.0) return vec4(0.0);
  float coslat = cos(radians(latD));
  float cw = 40.0;
  float ci = floor(lonT / cw);
  vec4 acc = vec4(0.0);
  for (int k = -1; k <= 1; k++) {
    float cell = ci + float(k);
    float id = mod(cell, 9.0) + (hs > 0.0 ? 0.0 : 30.0);
    float ph = t / (5.0 * 86400.0) + cloudHash(vec3(id, 8.3, 0.7));
    float life = floor(ph);
    float f = fract(ph);
    vec3 hk = vec3(id * 0.91, life * 1.73, 2.9);
    float cx = (cell + 0.5 + (cloudHash(hk + 0.3) - 0.5) * 0.6) * cw - f * 14.0;
    float cy = hs * (13.0 + cloudHash(hk + 1.9) * 6.0 + f * 11.0);
    // basin climatology at the storm centre (lonT ≈ geographic longitude over a life)
    float basin = hs > 0.0
      ? max(max(ell(cx, cy, 140.0, 18.0, 28.0, 10.0), ell(cx, cy, -112.0, 15.0, 18.0, 6.0) * 0.8),
            max(ell(cx, cy, -58.0, 20.0, 22.0, 9.0) * 0.8, ell(cx, cy, 88.0, 15.0, 7.0, 5.0) * 0.5)) * seasonNH
      : max(ell(cx, cy, 72.0, -15.0, 24.0, 7.0), ell(cx, cy, 150.0, -16.0, 22.0, 7.0)) * seasonSH;
    float present = step(0.55, cloudHash(hk + 5.5)) * smoothstep(0.25, 0.6, basin);
    float amp = present * pow(sin(PI * f), 0.5);
    float L = 4.0 + cloudHash(hk + 7.7) * 2.5;
    float u = wrapDeg(lonT - cx) * coslat / L;
    float v = (latD - cy) * hs / L;
    float r = length(vec2(u, v));
    float ang = atan(v, u);
    float eye = smoothstep(0.035, 0.09, r);
    float cdo = smoothstep(0.5, 0.18, r) * eye;
    float bands = smoothstep(0.15, 0.8, cos(2.0 * ang + 4.5 * log(r + 0.05))) * smoothstep(1.4, 0.35, r);
    float canopy = smoothstep(1.5, 0.35, r) * smoothstep(0.02, 0.06, r);
    acc = max(acc, amp * vec4(max(bands, cdo * 0.9), max(bands * 0.7, cdo), max(canopy * 0.85, cdo), max(cdo, bands * 0.75)));
  }
  return acc;
}

vec4 regimeTex(vec3 nr, vec3 evo) {
  return vec4(
    fbm5(nr * 16.0 + evo),
    cloudNoise(nr * 60.0 + evo * 2.0),
    fbm3(nr * 10.0 + evo * 0.8 + 5.7),
    fbm3(nr * 9.0 + evo * 0.6 + 13.1)
  );
}

void main() {
  float lat = (0.5 - vUv.y) * PI;
  float lon = (vUv.x - 0.5) * 2.0 * PI;
  vec3 n = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
  float latD = degrees(lat);
  float lonD = degrees(lon);
  float alat = abs(latD);
  float hs = latD >= 0.0 ? 1.0 : -1.0;
  float t = uTime;

  // --- surface ------------------------------------------------------------
  vec3 lm = texture2D(uLandTex, vUv).rgb;
  vec2 bio = texture2D(uBiomeTex, vUv).rg;
  float land = smoothstep(0.3, 0.7, lm.r) * uHasSurface;
  float landS = lm.b * uHasSurface; // blurred land fraction (~3°)
  float ocean = 1.0 - land;
  float arid = bio.r * uHasSurface;
  float rain = bio.g * uHasSurface;

  // --- season / time of day -------------------------------------------------
  float yr = 2.0 * PI * uDoy / 365.25;
  float sumNH = sin(yr - 2.0 * PI * 80.0 / 365.25);   // +1 ≈ 20 Jun
  float itczPh = sin(yr - 2.0 * PI * 139.0 / 365.25); // +1 ≈ late Aug (ITCZ lags the sun)
  float sunLon = atan(-uSunObj.z, uSunObj.x);
  float ha = mod(lon - sunLon + PI, 2.0 * PI) - PI; // >0 afternoon
  float hour = 12.0 + ha * 12.0 / PI;
  float dayCu = smoothstep(8.5, 11.5, hour) * (1.0 - smoothstep(17.0, 19.5, hour));
  float cbDiurnal = mix(1.0, 0.3 + 1.0 * exp(-pow((hour - 16.0) / 3.5, 2.0)), landS);

  // regime frames
  vec3 nT = shiftLon(n, W_TROP * t);   // tropical patterns drift west
  vec3 nM = shiftLon(n, -W_MID * t);   // mid-latitude patterns drift east
  float lonT = degrees(atan(-nT.z, nT.x));
  float lonM = degrees(atan(-nM.z, nM.x));
  vec3 evo = vec3(t * 1.1e-5, t * 1.7e-5, -t * 0.9e-5); // slow morphing (noise-space)

  // --- deep convection ------------------------------------------------------
  float itczLat = 5.0 + 4.0 * itczPh + 11.0 * itczPh * landS;
  float itcz = exp(-pow((latD - itczLat) / mix(5.0, 9.0, landS), 2.0));
  float warmPool = max(ell(lonD, latD, 125.0, 2.0 + 4.0 * itczPh, 42.0, 12.0), ell(lonD, latD, 78.0, 2.0 + 6.0 * itczPh, 18.0, 9.0) * 0.7);
  float spczD = mod(lonD - 150.0 + 360.0, 360.0);
  float spcz = exp(-pow((latD + 6.0 + spczD * 0.34) / 5.5, 2.0)) * smoothstep(0.0, 8.0, spczD) * (1.0 - smoothstep(50.0, 72.0, spczD));
  float monsoon = max(max(ell(lonD, latD, 85.0, 20.0, 16.0, 8.0) * max(sumNH, 0.0), ell(lonD, latD, 2.0, 11.0, 20.0, 5.0) * max(sumNH, 0.0)),
                      max(ell(lonD, latD, 132.0, -14.0, 14.0, 6.0), ell(lonD, latD, -52.0, -13.0, 16.0, 9.0) * 0.9) * max(-sumNH, 0.0));
  float envelope = max(max(itcz, warmPool * 0.9), max(max(spcz * 0.75, monsoon * 0.95), rain * 0.85));
  envelope *= (1.0 - arid * 0.95);
  // mesoscale convective clusters (a few hundred km, living ~a day)
  float cl = fbm3(nT * 7.0 + evo) * 0.7 + cloudNoise(nT * 19.0 + evo * 1.6 + 3.1) * 0.3;
  float clusters = smoothstep(0.5, 0.7, cl);
  float conv = envelope * clusters * cbDiurnal;
  // anvils: the same clusters, spread wider and a little downwind (upper-level easterlies)
  vec3 nA = shiftLon(nT, 0.035);
  float clA = fbm3(nA * 7.0 + evo) * 0.7 + cloudNoise(nA * 19.0 + evo * 1.6 + 3.1) * 0.3;
  float anvil = envelope * smoothstep(0.43, 0.63, clA) * cbDiurnal;

  // --- tropical cyclones ------------------------------------------------------
  float seasonNH = smoothstep(0.1, 0.7, cos(yr - 2.0 * PI * 250.0 / 365.25));
  float seasonSH = smoothstep(0.1, 0.7, cos(yr - 2.0 * PI * 45.0 / 365.25));
  vec4 tc = tropicalCyclones(lonT, latD, hs, t, seasonNH, seasonSH) * ocean;

  // --- mid-latitude cyclones & jets -----------------------------------------------
  vec2 warp = vec2(cloudFbm2(nM * 3.0 + evo * 0.5), cloudFbm2(nM * 3.0 + vec3(7.1, 2.3, 5.9) + evo * 0.5)) / 0.75 - 0.5;
  warp += (vec2(cloudNoise(nM * 11.0 + evo), cloudNoise(nM * 11.0 + vec3(3.3, 8.1, 1.7) + evo)) - 0.5) * 0.35;
  vec4 cy = cyclones(lonM, latD, hs, t, warp);
  // storm-track band (background cloudiness between the named systems)
  float stormLat = hs > 0.0 ? 50.0 + 3.0 * sumNH : 52.0;
  float storm = exp(-pow((alat - stormLat) / 12.0, 2.0));
  // jet streams: polar-front jet meandering (Rossby waves), subtropical jet
  float lonMr = radians(lonM);
  float jetLat = (hs > 0.0 ? 44.0 - 4.0 * sumNH : 47.0) + 7.0 * sin(4.0 * lonMr + 1.7 * hs + t * 2.0e-6) + 3.5 * sin(2.0 * lonMr - 0.8 * hs);
  float jet = exp(-pow((alat - jetLat) / 7.5, 2.0));
  float stjLat = 28.0 + 3.0 * sin(3.0 * lonMr + 0.5 + hs);
  float winterHs = hs > 0.0 ? max(-sumNH, 0.0) : max(sumNH, 0.0);
  float stj = exp(-pow((alat - stjLat) / 4.0, 2.0)) * (0.35 + 0.45 * winterHs);
  // streaks: long along the jet (circle in the along-jet coordinate), narrow across it
  vec3 sp = vec3(cos(lonMr) * 3.2, sin(lonMr) * 3.2, (alat - jetLat) * 0.33 + hs * 7.0);
  float streak = fbm3(sp + evo * 0.4);
  vec3 sp2 = vec3(cos(lonMr) * 2.6, sin(lonMr) * 2.6, (alat - stjLat) * 0.45 + hs * 3.0 + 11.0);
  float streak2 = cloudFbm2(sp2 + evo * 0.4) / 0.75;
  float jetCi = max(jet * smoothstep(0.42, 0.7, streak), stj * smoothstep(0.45, 0.72, streak2));

  // --- subsidence ---------------------------------------------------------
  float subs = exp(-pow((alat - 25.0) / 8.0, 2.0));

  // --- low cloud ----------------------------------------------------------
  // marine stratocumulus decks under the subtropical inversion (cold upwelling
  // water off the west coasts), each with a cumulus "tail" downwind (the
  // Sc → Cu transition toward the trades)
  float scNH = 0.75 + 0.25 * sumNH;
  float scSH = 0.8 + 0.2 * cos(yr - 2.0 * PI * 280.0 / 365.25);
  float deck = max(max(max(ell(lonD, latD, -126.0, 29.0, 13.0, 9.0), ell(lonD, latD, -121.0, 36.0, 6.0, 5.0)) * scNH,
                       ell(lonD, latD, -23.0, 23.0, 9.0, 7.0) * scNH * 0.85),
                   max(max(max(ell(lonD, latD, -88.0, -19.0, 15.0, 11.0), ell(lonD, latD, -77.0, -12.0, 6.0, 6.0)),
                           max(ell(lonD, latD, 2.0, -17.0, 13.0, 10.0), ell(lonD, latD, 9.0, -11.0, 5.0, 5.0))) * scSH,
                       ell(lonD, latD, 102.0, -28.0, 10.0, 7.0) * 0.7));
  deck = sqrt(deck);
  float tail = max(max(ell(lonD, latD, -141.0, 21.0, 14.0, 7.0) * scNH, ell(lonD, latD, -101.0, -12.0, 15.0, 7.0) * scSH),
                   ell(lonD, latD, -10.0, -10.0, 12.0, 6.0) * scSH);
  deck *= ocean;
  tail *= ocean;
  float trade = smoothstep(34.0, 20.0, alat) * ocean;
  float landCu = land * dayCu * (1.0 - arid) * smoothstep(65.0, 50.0, alat) * mix(0.8, 1.2, rain);
  float southern = smoothstep(38.0, 52.0, -latD) * (1.0 - smoothstep(66.0, 72.0, -latD)) * ocean;
  float polar = smoothstep(58.0, 72.0, alat);

  // texture noise in the regime's own drifting frame; blended (not the
  // vectors, which would shear) across the subtropics
  float wM = smoothstep(22.0, 38.0, alat);
  vec4 texT = wM < 1.0 ? regimeTex(nT, evo) : vec4(0.0);
  vec4 texM = wM > 0.0 ? regimeTex(nM, evo) : vec4(0.0);
  vec4 tex = mix(texT, texM, wM);
  float lowTex = tex.x;  // mesoscale patches and gaps
  float deckTex = tex.y; // big rifts in the decks
  float pLow = max(max(deck * (0.85 + 0.3 * (deckTex - 0.5)), tail * 0.55), max(trade * 0.3, landCu * 0.32));
  pLow = max(pLow, max(max(cy.x, tc.x), max(southern * 0.62, polar * 0.45)));
  pLow = max(pLow, max(conv * 0.5, storm * 0.3));
  float R = pLow * 1.15 - 0.42 + (lowTex - 0.5) * mix(1.9, 0.6, deck);
  R -= arid * 0.7 * land;

  // --- mid cloud ----------------------------------------------------------
  float midTex = tex.z;
  float pMid = max(max(cy.y, tc.y), max(anvil * 0.55, storm * 0.22 + polar * 0.25));
  float G = pMid * 1.15 - 0.4 + (midTex - 0.5) * 0.9 - subs * 0.25 - arid * 0.3;

  // --- high cloud ---------------------------------------------------------
  float hiTex = tex.w;
  float pHigh = max(max(cy.z * 0.9, tc.z), max(anvil * 1.05, jetCi * 0.62));
  float B = pHigh * 1.05 - 0.33 + (hiTex - 0.5) * 0.55 - subs * 0.15 * (1.0 - anvil);

  // --- convective regime ------------------------------------------------------
  float A = max(conv, tc.w) + trade * 0.1 * (1.0 - deck) + landCu * 0.12 - cy.w * 0.85;

  gl_FragColor = clamp(vec4(R, G, B, A) * 0.5 + 0.5, 0.0, 1.0);
}
`;

export interface CloudMapUniforms {
  uCloudMapA: { value: THREE.Texture };
  uCloudMapB: { value: THREE.Texture };
  uCloudMix: { value: number };
  [key: string]: THREE.IUniform;
}

export interface CloudMap {
  /** Spread into any ShaderMaterial that uses CLOUD_MAP_GLSL (shared objects: updates propagate). */
  uniforms: CloudMapUniforms;
  /** Surface inputs for the climatology: land mask (R land, B blurred land) and biome map (R arid, G rainforest). */
  setSurface(landTex: THREE.Texture, biomeTex: THREE.Texture): void;
  /** Absolute sim time (season) and object-space sun direction (diurnal cycle), used by the next bakes. */
  setClimate(timeMs: number, sunDirObj: THREE.Vector3): void;
  /** Bakes keyframes as needed and updates the cross-fade. Call before rendering the frame. */
  update(renderer: THREE.WebGLRenderer, shaderTimeSec: number): void;
  dispose(): void;
}

function makeTarget(): THREE.WebGLRenderTarget {
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
  return target;
}

export function createCloudMap(): CloudMap {
  let targetA = makeTarget();
  let targetB = makeTarget();
  let targetC = makeTarget();

  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  blank.needsUpdate = true;

  const material = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uDoy: { value: 270 },
      uSunObj: { value: new THREE.Vector3(1, 0, 0) },
      uLandTex: { value: blank as THREE.Texture },
      uBiomeTex: { value: blank as THREE.Texture },
      uHasSurface: { value: 0 },
      uStrip: { value: new THREE.Vector2(0, 1) },
    },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms: CloudMapUniforms = {
    uCloudMapA: { value: targetA.texture },
    uCloudMapB: { value: targetB.texture },
    uCloudMix: { value: 0 },
  };

  let tA = Number.NaN;
  /** strips of targetC (keyframe tA + 2·PERIOD) baked so far */
  let cDone = 0;
  let lastRenderer: THREE.WebGLRenderer | null = null;

  function bake(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, t: number, s0 = 0, s1 = STRIPS): void {
    material.uniforms.uTime.value = t;
    (material.uniforms.uStrip.value as THREE.Vector2).set(s0 / STRIPS, s1 / STRIPS);
    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false; // strips must not wipe the rest of the target
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAutoClear;
  }

  const api: CloudMap = {
    uniforms,
    setSurface(landTex, biomeTex) {
      material.uniforms.uLandTex.value = landTex;
      material.uniforms.uBiomeTex.value = biomeTex;
      material.uniforms.uHasSurface.value = 1;
      tA = Number.NaN; // re-bake everything with the surface in
    },
    setClimate(timeMs, sunDirObj) {
      const d = new Date(timeMs);
      const start = Date.UTC(d.getUTCFullYear(), 0, 1);
      material.uniforms.uDoy.value = (timeMs - start) / 86400000;
      (material.uniforms.uSunObj.value as THREE.Vector3).copy(sunDirObj);
    },
    update(renderer, t) {
      lastRenderer = renderer;
      const keyA = Math.floor(t / PERIOD_S) * PERIOD_S;
      if (keyA !== tA) {
        if (keyA === tA + PERIOD_S) {
          // normal forward step: finish C if needed, then rotate A ← B ← C
          if (cDone < STRIPS) bake(renderer, targetC, keyA + PERIOD_S, cDone, STRIPS);
          [targetA, targetB, targetC] = [targetB, targetC, targetA];
        } else {
          // first frame, a skip or a wrap: bake both visible keyframes now
          bake(renderer, targetA, keyA);
          bake(renderer, targetB, keyA + PERIOD_S);
        }
        tA = keyA;
        cDone = 0;
        uniforms.uCloudMapA.value = targetA.texture;
        uniforms.uCloudMapB.value = targetB.texture;
      } else if (cDone < STRIPS) {
        // spread the next keyframe's bake over the following frames
        bake(renderer, targetC, tA + 2 * PERIOD_S, cDone, cDone + 1);
        cDone++;
      }
      uniforms.uCloudMix.value = (t - tA) / PERIOD_S;
    },
    dispose() {
      targetA.dispose();
      targetB.dispose();
      targetC.dispose();
      blank.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };

  // Dev-only inspection hook for screenshot scripts: the current keyframe A as
  // a PNG data URL (RGB = low/mid/high, or one channel with ?ch=).
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    (window as unknown as { __cloudMapPNG?: (ch?: number) => string | null }).__cloudMapPNG = (ch?: number) => {
      if (!lastRenderer) return null;
      const px = new Uint8Array(WIDTH * HEIGHT * 4);
      lastRenderer.readRenderTargetPixels(targetA, 0, 0, WIDTH, HEIGHT, px);
      const c = document.createElement('canvas');
      c.width = WIDTH;
      c.height = HEIGHT;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(WIDTH, HEIGHT);
      for (let i = 0; i < WIDTH * HEIGHT; i++) {
        for (let k = 0; k < 3; k++) {
          const v = ch === undefined ? px[i * 4 + k] : px[i * 4 + ch];
          // show only the cloudy half (field > 0) so clear sky reads black
          img.data[i * 4 + k] = Math.max(0, (v - 128) * 2);
        }
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
  }

  return api;
}
