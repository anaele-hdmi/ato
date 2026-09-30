// Layered clouds, EVE-style (the KSP cloud-layer mods): from orbital
// distance the look comes from soft textured 2D layers — a macro coverage map
// (the baked meteorological RGBA field, cloudMap.ts) plus tiled detail
// textures, soft alpha edges, sun-side brightening from an offset sample,
// altitude-offset shadows — with a real (tiny) ray-march only for towers.
//
//  1. LOW (renderOrder 1): one sphere at the Cb-top radius. Every pixel takes
//     the ray's analytic crossing of the low layer sphere (~7 km rendered) and
//     shades a soft 2D layer there: coverage from R, merged cloud masses +
//     cumulus detail from the billow texture (cloudNoiseTex.ts), sun-side
//     brightening / blue-grey shade from a detail sample offset toward the
//     sun, a silver lining on back-lit thin edges, shadow from the layers
//     above. Only where convection is strong (A) does a 4-step march look for
//     grouped cumulonimbus towers above it. The hit writes its own depth, so
//     exaggerated mountains poke through the deck.
//  2. UPPER (1.1): the high layer (cirrus streaks stretched east–west along
//     the westerlies, cirrostratus, anvils) on the shell itself and the mid
//     layer (altostratus veil / altocumulus) where the same ray crosses the
//     mid sphere — true parallax between them in one pass.
//
// Every layer uses its own altitude in the day/night test (clHorizonDip), so
// cloud tops stay lit — gold then pink — after the ground below has gone
// dark. Detail fades by pixel footprint (no shimmer); the far field merges
// into a soft band.
//
// Cost (clear sky): low 1 map lookup (2 fetches, cross-faded keyframes),
// upper 2–4; cloudy low pixels ~6 fetches (+4–5 where towers are possible);
// no per-pixel hash noise.
import * as THREE from 'three';
import { CLOUD_LAYERS, CLOUD_FORM, LIGHTNING, RELIEF, MOONLIGHT, moonlightLevel } from './palette';
import { NOISE_GLSL } from './noiseGlsl';
import { CLOUD_MAP_GLSL, type CloudMapUniforms } from './cloudMap';
import { CLOUD_ALT } from './cloudLayers';
import { buildCloudNoiseTexture } from './cloudNoiseTex';
import { EARTH_RADIUS_KM } from '../types';

/** Kept for earth.ts, which splices the same noise into its shaders. */
export const CLOUD_GLSL = NOISE_GLSL;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosObj;
void main() {
  vPosObj = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const COMMON_GLSL = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDirObj;
uniform vec3 uCamObj;
uniform float uTime;
uniform vec3 uHazeCool;
uniform vec3 uHazeWarm;
uniform vec3 uSunsetGold;
uniform vec3 uSunsetPink;
varying vec3 vPosObj;

${NOISE_GLSL}
${CLOUD_MAP_GLSL}

// slow morphing of the fine structure (noise-space units)
vec3 cloudDrift() { return vec3(uTime * 1.0e-4, uTime * 0.4e-4, -uTime * 0.7e-4); }

// Sunlight reaching a cloud at altitude hKm: x = visibility (sun above that
// altitude's horizon), rgb tint: white by day, gold then pink at low sun.
vec4 sunAt(float mu, float hKm) {
  float e = mu + clHorizonDip(hKm);
  float vis = smoothstep(-0.012, 0.035, e);
  vec3 low = mix(uSunsetPink, uSunsetGold, smoothstep(0.0, 0.07, e));
  vec3 tint = mix(low, vec3(1.0), smoothstep(0.04, 0.3, e));
  return vec4(tint, vis);
}

// aerial perspective toward the limb (as the ground does)
vec3 cloudHaze(vec3 col, vec3 n, vec3 viewDir, float mu) {
  float grazing = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 5.5);
  vec3 hazeColor = mix(uHazeCool, uHazeWarm, smoothstep(0.05, 0.7, mu) * 0.5);
  return mix(col, hazeColor, grazing * 0.25 * smoothstep(-0.1, 0.1, mu));
}

uniform vec3 uLightningColor; // flash colour * peak intensity (palette LIGHTNING)
uniform vec4 uMoon;           // xyz: moon direction (object space), w: moonlight level
uniform vec3 uMoonCloud;      // moonlit cloud colour * gain (palette MOONLIGHT)
uniform vec2 uLightning;      // x: flash rate per cell per slot, y: debug hold
uniform float uFlashTime;     // wall-clock seconds (independent of the sim speed)

// ---------------------------------------------------------------------------
// Night-side light on clouds. cloudNightLight() is the one hook for light that
// still reaches a cloud after the sun has set for it: today the lightning
// inside convective cells (lit towers and anvils) and moonlight (palette MOONLIGHT).
// rgb: emissive (added after the day tone, not dimmed by night);
// a: how much it makes an otherwise dark cloud show up (alpha floor).

float ltHash(vec3 p) {
  vec3 p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// 0.25..1: how likely storms fire at this local solar time (peak ~21h,
// quietest ~9h) from the point's hour angle relative to the sun (object space:
// +Y is the pole, map longitude = atan(-z, x))
float ltEvening(vec3 q, vec3 L) {
  vec2 q2 = vec2(q.x, -q.z);
  vec2 l2 = vec2(L.x, -L.z);
  l2 /= max(length(l2), 1e-4);
  float ha = atan(l2.x * q2.y - l2.y * q2.x, dot(l2, q2)); // point lon - sun lon
  float h = 12.0 + ha * (12.0 / PI);
  return mix(0.25, 1.0, 0.5 + 0.5 * cos((h - 21.0) * (PI / 12.0)));
}

// Deterministic flashes from the cell hash + wall-clock time (no CPU state).
// Cells ~160 km wide, each on its own 6 s slot clock; in a slot a cell fires
// with probability rate * strength * evening, as 1-3 strokes 90-150 ms apart
// (~15 ms up, ~70 ms decay). The glow is a soft blob around a jittered point
// in the cell (moving a little per stroke).
float lightningFlash(vec3 q, float act, float evening) {
  vec3 c = q * 40.0;
  vec3 ci = floor(c);
  vec3 f = c - ci;
  float hc = ltHash(ci);
  vec3 ctr = vec3(ltHash(ci + 4.1), ltHash(ci + 8.7), ltHash(ci + 15.3)) * 0.28 + 0.36;
  if (uLightning.y > 0.5) {
    return (1.0 - smoothstep(0.06, 0.34, length(f - ctr))) * step(0.3, hc) * act;
  }
  if (hc < 0.3) return 0.0; // some cells are just not thundery
  float T = uFlashTime + hc * 41.0;
  float slot = floor(T / 6.0);
  float t = T - slot * 6.0;
  vec3 hh = vec3(ltHash(ci * 1.31 + slot * 7.1 + 3.7), ltHash(ci * 0.77 + slot * 3.3 + 9.1), ltHash(ci * 2.17 + slot * 5.9 + 1.3));
  if (hh.x > uLightning.x * act * evening) return 0.0;
  float start = 0.3 + hh.y * 4.6;
  float n = 1.0 + floor(hh.z * 2.999);
  float gap = 0.09 + 0.06 * hh.y;
  float e = 0.0;
  for (int i = 0; i < 3; i++) {
    float x = t - (start + float(i) * gap);
    if (float(i) < n && x > 0.0) {
      float fi = float(i);
      vec3 cc = ctr + (vec3(ltHash(ci + fi * 3.3), ltHash(ci + fi * 5.1), ltHash(ci + fi * 7.7)) - 0.5) * 0.1 * fi;
      float amp = fi < 0.5 ? 1.0 : 0.75 - 0.15 * fi;
      e += amp * exp(-x * 14.0) * (1.0 - exp(-x * 70.0)) * (1.0 - smoothstep(0.06, 0.34, length(f - cc)));
    }
  }
  return min(e * 1.4, 1.0);
}

vec4 cloudNightLight(vec3 q, vec3 L, float mu, float hKm, float mA, float thick, float puff) {
  float dark = 1.0 - smoothstep(-0.02, 0.06, mu + clHorizonDip(hKm));
  if (dark < 0.01) return vec4(0.0);
  // moonlight: the moon above this cloud's own horizon, on the thick tops and puffs
  float moonUp = smoothstep(-0.02, 0.14, dot(q, uMoon.xyz) + clHorizonDip(hKm));
  float mI = uMoon.w * moonUp * dark;
  float mShape = mix(0.45, 1.0, thick) * (0.6 + 0.8 * puff);
  vec4 res = vec4(uMoonCloud * (mI * mShape), clamp(mI * mShape * 2.2, 0.0, 0.85));
  float act = smoothstep(0.45, 0.9, mA);
  if (act < 0.01) return res;
  float e = lightningFlash(q, act, ltEvening(q, L)) * dark;
  if (e < 0.004) return res;
  // lit from inside: strongest where the cloud is thick, on the puffs
  float body = e * mix(0.5, 1.0, thick) * (0.55 + 0.9 * puff);
  return vec4(res.rgb + uLightningColor * body, max(res.a, clamp(body * 1.3, 0.0, 1.0)));
}
`;

// ---------------------------------------------------------------------------
const LOW_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uLowLit;
uniform vec3 uLowShade;
uniform vec3 uLowDeep;

uniform highp sampler3D uPuffTex;
uniform vec3 uForm;           // palette CLOUD_FORM: self shadow, cavity, rim

const float F_MASS = 120.0;   // cloud-mass cell scale (~53 km cells)
const float F_DETAIL = 400.0; // cumulus texture inside the masses (~16 km)
const float F_ERODE1 = 450.0; // erosion: ~14 km round puffs along the edge / ~3.5 km valleys inside
const float F_ERODE2 = 1800.0;
const float F_BIG = 45.0;     // large cloud-mass groups / gaps (~140 km cells)
// the 2D low layer sits in the middle of the boundary-layer cloud slab
const float LOW_LAYER = 0.5 * (CL_LOW_BASE + CL_DECK_TOP) + 1.0;

// billow texture: a = merged masses (8 cells/tile), r = coarser grouping
vec4 billowAt(vec3 q, float f) { return texture(uPuffTex, q * (f / 8.0) + cloudDrift()); }

// 2D low-layer density: the macro field sets coverage; masses and a detail
// texture shape soft cloud fields inside it (EVE-style main + detail maps)
float lowDensity(vec3 q, vec4 m, float fade, float fadeDetail, float fw_big, float fw, out float massO, out float detO, out float carveO) {
  float deck = smoothstep(0.3, 0.75, m.r);
  float mass = billowAt(q, F_MASS).a;
  float det = billowAt(q, F_DETAIL).a;
  massO = mass;
  detO = det;
  // open cells behind cold fronts: cloud walls around clear centres
  float open = clamp(-m.a, 0.0, 1.0);
  mass = mix(mass, smoothstep(0.1, 0.8, 1.0 - mass), open * 0.8);
  // big/small rhythm: a coarse scale groups the masses into clusters and gaps
  // and modulates how strongly the fine texture shows
  float big = billowAt(q, F_BIG).a;
  float bigFade = 1.0 - smoothstep(0.3, 0.8, fw_big);
  float d = m.r + (big - 0.42) * 0.4 * bigFade * (1.0 - 0.5 * deck) + (mass - 0.4) * 0.5 * fade
    + (det - 0.42) * mix(0.28, 0.18, deck) * fadeDetail * mix(0.65, 1.3, big);
  // Erosion (Nubis-style): carve the low-frequency shape with two octaves of
  // inverted-Worley domes (fine texture, G channel) so silhouettes turn into
  // cauliflower scallops instead of smooth round balls. Cores stay full (less
  // carved where d is high), edges break up. Each octave fades out with its own
  // pixel footprint, so the far field is untouched. Near nadir: +2 fetches.
  carveO = 0.0;
  float k1 = 1.0 - smoothstep(0.22, 0.6, fw * F_ERODE1);
  if (k1 > 0.02) {
    float edge = 1.0 - 0.4 * smoothstep(0.05, 0.75, d);
    float g1 = texture(uPuffTex, q.zxy * (F_ERODE1 / 16.0) + cloudDrift() * 3.0 + 0.37).g;
    // strength varies with the big scale: some fields are knobbly, some smoother
    float amp1 = 0.34 * mix(0.75, 1.3, big) * k1;
    // bumps that would raise d in clear air are damped: no speckle islands
    float b1 = 0.36 - (1.0 - g1) * edge;
    d += amp1 * (b1 > 0.0 ? b1 * smoothstep(-0.1, 0.1, d) : b1);
    carveO = smoothstep(0.6, 1.0, 1.0 - g1) * k1;
    float k2 = 1.0 - smoothstep(0.22, 0.6, fw * F_ERODE2);
    if (k2 > 0.02) {
      float g2 = texture(uPuffTex, q.yzx * (F_ERODE2 / 16.0) + cloudDrift() * 5.0 + 0.71).g;
      // second octave shades the valleys only (no change to the outline)
      carveO = max(carveO, k2 * smoothstep(0.55, 1.0, 1.0 - g2));
    }
  }
  return d;
}

// convective towers: height above CL_LOW_BASE (strong convection only,
// grouped into clusters)
float towerTop(vec3 q, float s) {
  vec4 bt = billowAt(q, F_MASS * 1.6);
  return s * smoothstep(0.35, 0.75, bt.r) * smoothstep(0.3, 0.95, bt.a) * (CL_CB_TOP - CL_LOW_BASE);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 P = vPosObj;
  vec3 dir = normalize(P - uCamObj);
  float rP = length(P);
  float b = dot(P, dir);
  // the ray's crossing of the 2D low layer (well-conditioned from P)
  float rL = CL_R0 + LOW_LAYER;
  float discL = b * b - (rP - rL) * (rP + rL);
  // (grazing rays that miss the layer sphere take its tangent point)
  float tL = discL > 0.0 ? -b - sqrt(discL) : -b;
  vec3 qL = normalize(P + dir * tL);
  vec4 m = cloudFields(qL);
  float s = smoothstep(0.3, 0.8, m.a);
  if (m.r < -0.3 && s < 0.01) discard; // clear sky: one map lookup

  vec3 L = normalize(uSunDirObj);
  float fw = length(fwidth(P)) / CL_R0; // angular pixel footprint
  float fade = 1.0 - smoothstep(0.3, 0.8, fw * F_MASS);
  float fadeDetail = 1.0 - smoothstep(0.25, 0.7, fw * F_DETAIL);

  float tHit = tL;
  vec3 q = qL;
  bool tower = false;
  float hTop = 0.0;
  // --- short ray-march only for strong convection: 4 steps from the shell
  // top down to the layer, towers only; far towers sink into the band
  float towerFade = 1.0 - smoothstep(1.5, 3.0, tL * 0.25 * F_MASS * 1.6 / CL_R0);
  if (s * towerFade > 0.01) {
    float tPrev = 0.0;
    float diffPrev = -1.0;
    for (int i = 1; i <= 4; i++) {
      float t = tL * float(i) / 4.0;
      vec3 p = P + dir * t;
      float rp = length(p);
      float H = towerTop(p / rp, s * towerFade);
      float diff = CL_R0 + CL_LOW_BASE + H - rp;
      if (diff > 0.0) {
        tHit = mix(tPrev, t, clamp(diffPrev / (diffPrev - diff), 0.0, 1.0));
        q = normalize(P + dir * tHit);
        hTop = H;
        tower = rp - CL_R0 > LOW_LAYER + 1.0;
        break;
      }
      tPrev = t;
      diffPrev = diff;
    }
  }
  float hKm = length(P + dir * tHit) - CL_R0;
  float mu = dot(q, L);
  vec4 sun = sunAt(mu, hKm);
  vec3 tang = L - q * mu;
  float horiz = length(tang);
  vec3 sunT = tang / max(horiz, 1e-4);

  float cov;
  float light;
  float thick;
  float puff = 0.5;
  float rim = 0.0;
  if (tower) {
    // tower: offset-sample normal of its height field; darker toward the base
    float eps = 0.3 / (F_MASS * 1.6);
    float H2 = towerTop(normalize(q + sunT * eps), s * towerFade);
    float slope = clamp((H2 - hTop) / (eps * CL_R0), -4.0, 4.0);
    float ndl = (mu - slope * horiz) / sqrt(1.0 + slope * slope);
    float hf = clamp((hKm - CL_LOW_BASE) / max(hTop, 1.0), 0.0, 1.0);
    light = clamp((ndl + 0.5) / 1.5, 0.0, 1.0) * mix(0.7, 1.0, hf);
    cov = 1.0;
    thick = 1.0;
    puff = mix(0.4, 0.8, hf);
  } else {
    // 2D layer: soft coverage, sun-side brightening from an offset sample
    // toward the sun (density falling toward the sun = lit edge)
    float mass0;
    float dt0;
    float carve;
    float d = lowDensity(q, m, fade, fadeDetail, fw * F_BIG, fw, mass0, dt0, carve);
    // Edge: a soft 0.3-0.45 ramp far away (no shimmer), but near the camera the
    // ramp shrinks to ~1.5 pixels of the density field (fwidth) so silhouettes
    // are crisp; no halo (it read as dirt).
    float wOld = mix(0.3, 0.45, 1.0 - fade);
    float wAA = clamp(fwidth(d) * 1.8, 0.05, 0.3);
    float wCov = mix(wOld, wAA, fadeDetail);
    cov = smoothstep(0.0, wCov, d);
    if (cov < 0.01) discard;
    thick = smoothstep(0.0, 0.8, d);
    // a crisp silhouette is not a thin cloud: no dark lavender outline
    thick = max(thick, 0.85 * fadeDetail * cov);
    puff = dt0;
    // offset sample of the detail texture only (the masses barely change
    // over that distance): one fetch
    float dt1 = billowAt(normalize(q + sunT * (0.5 / F_DETAIL)), F_DETAIL).a;
    float grad = clamp((dt0 - dt1) * 0.3 * fadeDetail * 4.0, -1.0, 1.0) * horiz;
    light = clamp(0.66 + 0.25 * mu + 0.6 * grad - 0.12 * thick, 0.0, 1.0);
    // --- near view (fadeDetail -> 0 with distance, so the horizon is untouched)
    // Form: treat the cloud field as a height field. (1) self shadow: the
    // sun-side neighbour, one puff-shadow length away (a ~6 km puff over a low
    // sun casts ~20 km), is higher -> this pixel sits in its shadow (masses +
    // detail, 2 fetches). (2) cavity: the gaps between puffs inside thick
    // cloud are darker. (3) rim: thin sun-facing edges let light through.
    // Everything is bounded and blue-grey (uLowShade), never black.
    if (fadeDetail > 0.04 && sun.w > 0.01) {
      float slen = clamp(3.0 * horiz / max(mu + 0.05, 0.15), 0.0, 6.0) * 4.0; // km
      vec3 qs = normalize(q + sunT * (slen / CL_R0));
      float ms = billowAt(qs, F_MASS).a;
      float ds = billowAt(qs, F_DETAIL).a;
      float h0 = (mass0 - 0.4) * 0.5 + (dt0 - 0.42) * 0.23;
      float hs = (ms - 0.4) * 0.5 + (ds - 0.42) * 0.23;
      float sh = clamp((hs - h0) * 14.0, 0.0, 1.0) * smoothstep(0.1, 0.5, horiz) * thick;
      float cav = (1.0 - smoothstep(0.2, 0.6, dt0)) * smoothstep(0.35, 0.85, d);
      light *= 1.0 - fadeDetail * (uForm.x * sh + uForm.y * cav) - 0.3 * carve * thick;
      rim = uForm.z * fadeDetail * (1.0 - thick) * (0.35 + 0.65 * max(grad, 0.0));
    }
  }

  // shade from mid deck / anvils / cirrus / tower clusters up-sun (one lookup)
  float shade = 1.0;
  if (sun.w > 0.01) {
    // each layer's shadow is offset toward the sun by ITS OWN height above
    // this cloud top; edges are widened by the pixel footprint so they never
    // alias into hard streaks
    float k = 1.0 / (max(mu + clHorizonDip(hKm), 0.05) * CL_R0);
    float soft = clamp(fw * F_MASS * 0.5, 0.0, 1.0);
    vec4 fm = cloudFieldsFast(normalize(q + tang * max(CL_MID - hKm, 0.0) * k));
    float occ = smoothstep(-0.05, 0.4, fm.g) * 0.45 * step(hKm, CL_MID);
    occ = max(occ, smoothstep(0.45, 0.85, fm.a) * 0.5 * step(hKm, CL_MID));
    if (hKm < CL_HIGH) {
      // cirrus is thin: a faint, very soft veil of shade, never a dark streak
      vec4 fh = cloudFieldsFast(normalize(q + tang * max(CL_HIGH - hKm, 0.0) * k));
      occ = max(occ, smoothstep(-0.1, 0.55 + 0.3 * soft, fh.b) * mix(0.05, 0.15, smoothstep(0.35, 0.7, fh.b)));
    }
    shade = 1.0 - occ;
  }

  float diffuse = light * sun.w * shade;
  vec3 tone = mix(uLowShade, uLowLit * sun.rgb, diffuse);
  // thin cloud edges pick up a little lavender from below
  tone = mix(uLowDeep * mix(0.35, 1.0, sun.w), tone, mix(0.75, 1.0, thick));
  // silver lining: back-lit thin edges glow when looking toward the sun
  vec3 viewDir = -dir;
  float back = pow(max(dot(dir, L), 0.0), 6.0) * (1.0 - thick) * sun.w;
  tone += uSunsetGold * sun.rgb * back * 0.35;
  // translucent sun-facing edges (form, near view)
  tone += uLowLit * sun.rgb * (rim * sun.w);

  tone = cloudHaze(tone, q, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(hKm));
  vec3 color = tone * mix(0.03, 1.0, night);
  float alpha = cov * mix(0.85, 0.96, thick) * mix(0.05, 1.0, night);
  // night side: lightning (and later moonlight) lights the cloud from within
  vec4 nl = cloudNightLight(q, L, mu, hKm, m.a, thick, puff);
  color += nl.rgb;
  alpha = max(alpha, cov * nl.a);

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>

  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    // depth of the layer / tower hit (same ray from the camera, so view
    // depth scales with distance): mountains above the deck poke through
    float distP = length(P - uCamObj);
    float wHit = (vFragDepth - 1.0) * (distP + tHit) / distP;
    gl_FragDepth = log2(1.0 + wHit) * logDepthBufFC * 0.5;
  #endif
}
`;

// ---------------------------------------------------------------------------
// UPPER shell: the high layer (Ci / Cs / anvils) on the shell itself and the
// mid layer (As / Ac) where the same view ray crosses the mid sphere — real
// parallax between them in one pass. rgb + alpha (straight) per layer.
const UPPER_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
uniform highp sampler3D uPuffTex;
uniform vec3 uMidLit;
uniform vec3 uMidShade;
uniform vec3 uHighLit;
uniform vec3 uHighShade;

vec4 midLayer(vec3 n, vec4 m, float fw, vec3 L, vec3 viewDir) {
  if (m.g <= 0.0) return vec4(0.0);
  vec3 drift = cloudDrift();
  float big = texture(uPuffTex, n * (140.0 / 4.0) + drift + 0.19).r;
  float ac = texture(uPuffTex, n * (380.0 / 8.0) + drift * 2.0).a;
  float fadeAc = 1.0 - smoothstep(0.25, 0.7, fw * 380.0);
  // thin mid cloud reads as altocumulus cells, thick as an altostratus sheet
  float acness = 1.0 - smoothstep(0.05, 0.35, m.g);
  // texture scales with G so the field is still continuous at the G = 0 cut
  float dens = m.g * (1.0 + (big - 0.4) * 1.2) + (ac - 0.45) * 0.3 * acness * fadeAc * smoothstep(0.0, 0.2, m.g);
  dens -= smoothstep(0.25, 0.65, m.a) * 0.5; // towers occupy the mid levels there
  // soft, veil-like edges for altostratus, crisper for altocumulus cells
  float cov = smoothstep(0.0, mix(0.3, 0.16, acness * fadeAc), dens);
  float mu = dot(n, L);
  vec4 sun = sunAt(mu, CL_MID);
  float cell = mix(0.5, ac, acness * fadeAc);
  float diffuse = clamp(0.72 + mu * 0.28 + (cell - 0.45) * 0.3, 0.0, 1.0) * sun.w;
  vec3 tone = cloudHaze(mix(uMidShade, uMidLit * sun.rgb, diffuse), n, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(CL_MID));
  return vec4(tone * mix(0.03, 1.0, night), cov * mix(0.55, 0.9, smoothstep(0.1, 0.6, dens)) * mix(0.05, 1.0, night));
}

vec4 highLayer(vec3 n, vec4 m, float fw, vec3 L, vec3 viewDir) {
  if (m.b <= 0.0) return vec4(0.0);
  vec3 drift = cloudDrift();
  // streaks stretched east–west (along the westerlies / jet): compressing the
  // noise's y axis makes features long in longitude, narrow in latitude
  vec3 a = vec3(n.x, n.y * 5.0, n.z);
  float s1 = texture(uPuffTex, a * (70.0 / 4.0) + drift * 0.5 + 0.61).r;
  float s2 = texture(uPuffTex, a.zxy * (240.0 / 8.0) + drift).a;
  float fade2 = 1.0 - smoothstep(0.2, 0.6, fw * 240.0 * 5.0);
  float anvil = smoothstep(0.3, 0.65, m.b);
  // texture scales with B so the field stays continuous at the B = 0 cut
  float dens = m.b * (1.0 + ((s1 - 0.4) * 1.5 + (s2 - 0.5) * 0.7 * fade2) * (1.0 - anvil * 0.65));
  // wide soft edge: thin cirrus fades out, it does not cut hard streak-shaped holes
  float cov = smoothstep(0.0, 0.22 + 0.12 * (1.0 - fade2), dens);
  float mu = dot(n, L);
  vec4 sun = sunAt(mu, CL_HIGH);
  float diffuse = clamp(0.6 + mu * 0.4 + (s1 - 0.5) * 0.3 * anvil, 0.0, 1.0) * sun.w;
  vec3 tone = cloudHaze(mix(uHighShade, uHighLit * sun.rgb, diffuse), n, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(CL_HIGH));
  // thin cirrus is translucent; anvils/shields nearly opaque, but thinner over
  // the strongest convective cores so the towers show through
  float alpha = cov * mix(0.4, 0.9, anvil) * (1.0 - 0.45 * smoothstep(0.45, 0.9, m.a)) * mix(0.04, 1.0, night);
  // night side: a flash in the cell below lights the anvil from within too
  vec4 nl = cloudNightLight(n, L, mu, CL_HIGH, m.a, anvil, s1);
  alpha = max(alpha, cov * nl.a * 0.8);
  return vec4(tone * mix(0.03, 1.0, night) + nl.rgb * 0.7, alpha);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 P = vPosObj;
  vec3 dir = normalize(P - uCamObj);
  vec3 n = normalize(P);
  float rP = length(P);
  float b = dot(P, dir);
  float rM = CL_R0 + CL_MID;
  float discM = b * b - (rP - rM) * (rP + rM);
  float tM = discM > 0.0 ? -b - sqrt(discM) : -b;
  vec3 nM = normalize(P + dir * tM);
  vec4 mh = cloudFields(n);
  // clear sky: when the mid crossing is near (not grazing), the lookup
  // above it already rules both layers out (G is broad and smooth)
  if (mh.b <= 0.0 && mh.g < -0.25 && tM < 60.0) discard;
  vec4 mm = cloudFields(nM);
  if (mh.b <= 0.0 && mm.g <= 0.0) discard;
  float fw = length(fwidth(n));
  vec3 L = normalize(uSunDirObj);
  vec3 viewDir = -dir;
  vec4 hi = highLayer(n, mh, fw, L, viewDir);
  vec4 mid = midLayer(nM, mm, fw, L, viewDir);
  float alpha = hi.a + mid.a * (1.0 - hi.a);
  if (alpha < 0.01) discard;
  vec3 color = (hi.rgb * hi.a + mid.rgb * mid.a * (1.0 - hi.a)) / alpha;
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>

  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    // no cirrus here: take the mid layer's depth so peaks between the two
    // layers (Tibet, Andes) still poke through the mid deck
    if (hi.a < 0.02) {
      float distP = length(P - uCamObj);
      float w = (vFragDepth - 1.0) * (distP + tM) / distP;
      gl_FragDepth = log2(1.0 + w) * logDepthBufFC * 0.5;
    }
  #endif
}
`;

export interface CloudObjects {
  mesh: THREE.Object3D;
  setSunDirObject(v: THREE.Vector3): void;
  setSunDirWorld(v: THREE.Vector3): void;
  /** Moon direction in Earth object space and its illuminance (see FrameState.moon). */
  setMoon(dirObject: THREE.Vector3, illum: number): void;
  setTime(seconds: number): void;
  dispose(): void;
}

export function createClouds(cloudMap: CloudMapUniforms): CloudObjects {
  const group = new THREE.Group();
  const puffTex = buildCloudNoiseTexture();
  const shared = {
    uPuffTex: { value: puffTex },
    uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
    uCamObj: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    // wall-clock seconds for lightning strokes (they must not scale with the sim speed)
    uFlashTime: { value: 0 },
    uLightningColor: { value: new THREE.Vector3(LIGHTNING.color.r, LIGHTNING.color.g, LIGHTNING.color.b).multiplyScalar(LIGHTNING.intensity) },
    uLightning: { value: new THREE.Vector2(LIGHTNING.rate, LIGHTNING.hold) },
    uMoon: { value: new THREE.Vector4(1, 0, 0, 0) },
    uMoonCloud: { value: MOONLIGHT.cloud.clone().multiplyScalar(MOONLIGHT.cloudGain) },
    uHazeCool: { value: RELIEF.hazeCool },
    uHazeWarm: { value: RELIEF.hazeWarm },
    uSunsetGold: { value: CLOUD_LAYERS.sunsetGold },
    uSunsetPink: { value: CLOUD_LAYERS.sunsetPink },
  };

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.ShaderMaterial[] = [];

  function shell(altKm: number, fragmentShader: string, extra: Record<string, THREE.IUniform>, order: number): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM + altKm, 128, 96);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader,
      uniforms: { ...shared, ...cloudMap, ...extra },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = order;
    // camera position in the planet's object space, for the per-fragment rays
    mesh.onBeforeRender = (_r, _s, camera) => {
      const c = shared.uCamObj.value;
      c.setFromMatrixPosition(camera.matrixWorld);
      mesh.worldToLocal(c);
      shared.uFlashTime.value = (performance.now() / 1000) % 3600;
    };
    geometries.push(geometry);
    materials.push(material);
    group.add(mesh);
    return mesh;
  }

  shell(
    CLOUD_ALT.cbTop,
    LOW_FRAGMENT,
    {
      uLowLit: { value: CLOUD_LAYERS.lowLit },
      uLowShade: { value: CLOUD_LAYERS.lowShade },
      uLowDeep: { value: CLOUD_LAYERS.lowDeep },
      uForm: { value: new THREE.Vector3(CLOUD_FORM.selfShadow, CLOUD_FORM.cavity, CLOUD_FORM.rim) },
    },
    1,
  );
  shell(
    CLOUD_ALT.high,
    UPPER_FRAGMENT,
    {
      uMidLit: { value: CLOUD_LAYERS.midLit },
      uMidShade: { value: CLOUD_LAYERS.midShade },
      uHighLit: { value: CLOUD_LAYERS.highLit },
      uHighShade: { value: CLOUD_LAYERS.highShade },
    },
    1.1,
  );

  // dev-only perf hook: __cloudsVisible(false) hides the shells (A/B timing)
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    (window as unknown as { __cloudsVisible?: (v: boolean | number) => void }).__cloudsVisible = (v) => {
      // true/false, or a bitmask of shells (1 low, 2 upper = mid + high)
      const mask = v === true ? 7 : v === false ? 0 : v;
      group.children.forEach((c, i) => (c.visible = ((mask >> i) & 1) === 1));
    };
  }

  return {
    mesh: group,
    setSunDirObject(v) {
      shared.uSunDirObj.value.copy(v);
    },
    setSunDirWorld() {
      /* lighting is done in object space; kept for API compatibility */
    },
    setMoon(dirObject, illum) {
      shared.uMoon.value.set(dirObject.x, dirObject.y, dirObject.z, moonlightLevel(illum));
    },
    setTime(seconds) {
      shared.uTime.value = seconds;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      puffTex.dispose();
    },
  };
}
