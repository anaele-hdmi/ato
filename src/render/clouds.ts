// Layered clouds: three shells at meteorologically distinct heights (see
// cloudLayers.ts), rotating with the planet, drawn inner → outer.
//
//  1. LOW + CONVECTIVE (renderOrder 1): one sphere at the Cb-top radius. Each
//     fragment ray-marches the slab below it as a height field — cloud top
//     height H(x) from the baked low-cloud (R) and convective (A) fields plus
//     one octave of puff noise — so cumulus / stratocumulus have real domes,
//     sides and self-occlusion, and cumulonimbus rise as towers far above the
//     deck. 5 steps (8 where convection exists) + a linear refine; the macro
//     field is fetched only at the top entry and in the low slab and
//     interpolated along the ray. The hit writes its own depth, so exaggerated
//     mountains poke through the low deck. Lit with the sun-side slope of the
//     height field, darkened toward the base, shadowed by mid/high cloud and
//     neighbouring towers (two map lookups toward the sun).
//  2. MID (1.1): altostratus sheets / altocumulus cells, one flat shell.
//  3. HIGH (1.2): cirrus streaks (noise stretched east–west, along the
//     westerlies), cirrostratus shields and thick anvils; translucent.
//
// Every layer uses its own altitude in the day/night test (clHorizonDip), so
// cloud tops stay lit — gold then pink — after the ground below has gone
// dark, and high cloud is lit longest.
//
// Cost vs. the old single shell (2 map fetches + 5 value-noise lookups on
// cloudy pixels): clear sky 8 fetches over three shells (all early-out);
// low cloud 4–8 fetches + 6 noise (8–10 in convection); mid/high +2 fetches
// +2 noise each where present. High-frequency terms fade by pixel footprint.
import * as THREE from 'three';
import { CLOUD_LAYERS, RELIEF } from './palette';
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
`;

// ---------------------------------------------------------------------------
const LOW_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uLowLit;
uniform vec3 uLowShade;
uniform vec3 uLowDeep;

uniform highp sampler3D uPuffTex;

const float F_PUFF = 330.0;   // cumulus / Sc cell scale (~19 km cells)
const float F_TOWER = 190.0;  // Cb tower spacing (~34 km cells)
const float F_FINE = 1700.0;  // cauliflower texture on the hit (~4 km cells)

// puff domes (billow texture R: 4 cells per tile)
float puffAt(vec3 q, float deck) {
  // two fetches: a smaller-scale billow at an incommensurate scale and
  // permuted axes (breaks up the tile repeat) that also domain-warps the main
  // domes (not in decks: there the plain packed domes read as closed Sc cells)
  vec3 c = q * (F_PUFF * 0.25) + cloudDrift();
  float b = texture(uPuffTex, c.zxy * 1.37 + 0.31).r;
  float a = texture(uPuffTex, c + (b - 0.35) * 0.5 * (1.0 - deck)).r;
  return a * 0.85 + b * 0.3 * (1.0 - 0.6 * deck);
}
// tower cells (B: 2 cells per tile)
float towerAt(vec3 q) { return texture(uPuffTex, q * (F_TOWER * 0.5) + cloudDrift() * 0.5 + 0.37).b; }

// Height of the cloud top above CL_LOW_BASE at unit direction q for the macro
// fields m; d = signed density (> 0 inside cloud). fade (0..1) flattens the
// puff relief where it would alias (pixel footprint or march step too big).
float towerFade = 1.0;
float cloudTop(vec3 q, vec4 m, float fade, bool upper, out float d) {
  float deck = smoothstep(0.3, 0.75, m.r);
  // above the low slab only towers can be hit: skip the puff fetches there
  float p = upper ? 0.45 : puffAt(q, deck);
  // open cells (cold air behind fronts): rings of cumulus walls around clear
  // centres ~40 km across (inverted large-scale billows)
  float open = clamp(-m.a, 0.0, 1.0);
  if (open > 0.02) {
    float ring = 1.0 - texture(uPuffTex, q * (F_PUFF * 0.25 * 0.3) + 0.71).r;
    p = mix(p, smoothstep(0.25, 0.85, ring) * (0.55 + 0.6 * p), open * 0.9);
  }
  p = mix(0.45, p, fade);
  d = m.r + (p - 0.45) * 0.7;
  // stratocumulus decks: flat tops under the inversion; cumulus: taller,
  // separate domes whose tops keep the puff shape
  float topMax = mix(CL_LOW_TOP, CL_DECK_TOP + 1.0, deck) - CL_LOW_BASE;
  float dome = sqrt(clamp(d * 3.0, 0.0, 1.0));
  float lowH = topMax * dome * mix(0.25 + 0.75 * p, 0.7 + 0.3 * p, deck);
  float s = max(m.a, 0.0);
  if (s > 0.02) {
    // congestus / cumulonimbus towers, strongest in the cluster cores
    // (paraboloid cells → rounded, peaked towers; the lumpy cauliflower
    // comes from the puff term on top)
    float tc = towerAt(q);
    float ss = sqrt(s);
    // weak convection: only the strongest cells grow (congestus); cores: Cb
    float thr = 0.4 + 0.3 * (1.0 - ss);
    d = max(d, ss * smoothstep(thr, thr + 0.22, tc) * 1.5 * towerFade);
    float tower = ss * smoothstep(thr, 0.97, tc) * towerFade;
    lowH = max(lowH, tower * (CL_CB_TOP - CL_LOW_BASE) * (0.9 + 0.1 * p));
  }
  return d > 0.0 ? lowH : 0.0;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 P = vPosObj;
  vec3 dir = normalize(P - uCamObj);
  float rP = length(P);
  float b = dot(P, dir);
  float rBase = CL_R0 + CL_LOW_BASE;
  float rLow = CL_R0 + CL_LOW_TOP;
  // well-conditioned sphere intersections from the entry point P (t = 0)
  float discLow = b * b - (rP - rLow) * (rP + rLow);
  float discBase = b * b - (rP - rBase) * (rP + rBase);
  float tEnd = discBase > 0.0 ? -b - sqrt(discBase) : max(-2.0 * b, 0.0);
  bool hasLow = discLow > 0.0;
  float tLow0 = hasLow ? max(-b - sqrt(discLow), 0.0) : tEnd;
  float tLow1 = hasLow ? (discBase > 0.0 ? tEnd : -b + sqrt(discLow)) : tEnd;
  float tLowMid = 0.5 * (tLow0 + tLow1);

  vec4 M0 = cloudFields(normalize(P));
  vec4 M1 = cloudFields(normalize(P + dir * tLowMid));
  float conv = max(M0.a, M1.a);
  bool convective = conv > 0.03;
  // early outs: nothing can reach above the base along this ray
  if (!convective && (!hasLow || M1.r < -0.33)) discard;

  float fw = length(fwidth(P)) / CL_R0; // angular pixel footprint
  float fade = 1.0 - smoothstep(0.25, 0.7, fw * F_PUFF);
  float fadeFine = 1.0 - smoothstep(0.2, 0.6, fw * F_FINE);

  // steps: ~1 per puff cell crossed in the low slab (5..12); where towers
  // are possible, 5 more through the tower levels above it
  float lowCells = (tLow1 - tLow0) * F_PUFF / CL_R0;
  int nLow = int(clamp(lowCells * 1.1, 4.0, convective ? 7.0 : 10.0));
  int nUp = convective ? 5 : 0;
  float t0 = convective ? 0.0 : tLow0;
  float dtUp = (tLow0 - t0) / 5.0;
  // towers need a step no longer than ~2 tower cells; beyond that (the far
  // limb) they flatten instead of breaking into slivers
  towerFade = 1.0 - smoothstep(2.0, 4.0, dtUp * F_TOWER / CL_R0);
  float dtLow = (tLow1 - tLow0) / float(nLow);
  // grazing rays still take long steps: flatten the puff relief there
  // instead of letting the linear search draw contour bands
  fade *= 1.0 - smoothstep(0.6, 1.5, lowCells / float(nLow));
  float tPrev = t0;
  float diffPrev = -1.0;
  float dPrev = 0.0;
  float tHit = -1.0;
  float tIn = 0.0;
  float diffHit = 0.0;
  float dHit = 0.0;
  float hTopHit = 0.0;
  float hPrev = 0.0;
  for (int i = 1; i <= 14; i++) {
    if (i > nUp + nLow) break;
    float t = i <= nUp ? t0 + dtUp * float(i) : tLow0 + dtLow * float(i - nUp);
    vec3 p = P + dir * t;
    float rp = length(p);
    vec3 q = p / rp;
    vec4 m = mix(M0, M1, clamp(t / max(tLowMid, 1e-3), 0.0, 1.0));
    float d;
    float H = cloudTop(q, m, fade, i <= nUp, d);
    float diff = rBase + H - rp;
    if (d > 0.0 && diff > 0.0) {
      tHit = t;
      tIn = tPrev;
      diffHit = diff;
      dHit = d;
      hTopHit = H;
      break;
    }
    tPrev = t;
    diffPrev = diff;
    dPrev = max(d, 0.0);
    hPrev = H;
  }
  if (tHit < 0.0) discard;
  // a bisection step then a linear refine: removes the stair-step
  // banding of the coarse search (only on hit pixels)
  for (int j = 0; j < 1; j++) {
    float tm = 0.5 * (tIn + tHit);
    vec3 pm = P + dir * tm;
    float rm = length(pm);
    vec4 mm = mix(M0, M1, clamp(tm / max(tLowMid, 1e-3), 0.0, 1.0));
    float dm;
    float Hm = cloudTop(pm / rm, mm, fade, false, dm);
    float diffm = rBase + Hm - rm;
    if (dm > 0.0 && diffm > 0.0) { tHit = tm; dHit = dm; hTopHit = Hm; diffHit = diffm; }
    else { tIn = tm; diffPrev = diffm; dPrev = max(dm, 0.0); hPrev = Hm; }
  }
  {
    float fr = clamp(diffPrev / (diffPrev - diffHit), 0.0, 1.0);
    tHit = mix(tIn, tHit, fr);
    dHit = mix(dPrev, dHit, fr);
    hTopHit = mix(hPrev, hTopHit, fr);
  }

  vec3 ph = P + dir * tHit;
  float rh = length(ph);
  vec3 q = ph / rh;
  float hKm = rh - CL_R0;
  vec4 m = mix(M0, M1, clamp(tHit / max(tLowMid, 1e-3), 0.0, 1.0));
  vec3 L = normalize(uSunDirObj);
  float mu = dot(q, L);
  vec4 sun = sunAt(mu, hKm);

  // fine texture + soft, footprint-widened edge
  float fine = texture(uPuffTex, q * (F_FINE / 16.0) + cloudDrift() * 2.0).g;
  float dens = dHit + (fine - 0.5) * 0.08 * fadeFine;
  // soft painterly edge, wider where detail is faded (derivatives are
  // unreliable after the march's break, so it comes from the footprint)
  float edgeW = mix(0.16, 0.3, 1.0 - fade);
  float cov = smoothstep(0.0, edgeW, dens);
  if (cov < 0.01) discard;

  // sun-side slope of the height field -> lambert on the implied surface
  vec3 tang = L - q * mu;
  float horiz = length(tang);
  float eps = 0.3 / F_PUFF;
  float d2;
  float H2 = cloudTop(normalize(q + tang / max(horiz, 1e-4) * eps), m, fade, false, d2);
  float slope = (H2 - hTopHit) / (eps * CL_R0);
  float ndl = (mu - slope * horiz) / sqrt(1.0 + slope * slope);
  float heightFrac = clamp((hKm - CL_LOW_BASE) / max(hTopHit, 0.5), 0.0, 1.0);

  // shadows from above: mid deck / anvils / cirrus and neighbouring towers,
  // looked up where the sun ray crosses the mid and high shells
  float shade = 1.0;
  if (sun.w > 0.01) {
    float k = 1.0 / (max(mu + clHorizonDip(hKm), 0.05) * CL_R0);
    vec3 tn = tang;
    // one lookup where the sun ray crosses the mid shell (mid deck, towers;
    // anvils/cirrus above are close enough laterally at all but grazing sun)
    vec4 fm = cloudFields(normalize(q + tn * max(CL_MID - hKm, 0.0) * k));
    vec4 fh = fm;
    float occ = smoothstep(-0.05, 0.4, fm.g) * 0.45 * step(hKm, CL_MID);
    occ = max(occ, smoothstep(0.0, 0.4, fh.b) * mix(0.2, 0.6, smoothstep(0.35, 0.7, fh.b)) * step(hKm, CL_HIGH));
    if (fm.a > 0.05 && hKm < CL_MID) {
      // an individual tower up-sun, taller than the mid shell
      vec3 qm = normalize(q + tn * (CL_MID - hKm) * k);
      float tower = sqrt(fm.a) * smoothstep(0.4, 0.95, towerAt(qm));
      occ = max(occ, smoothstep(CL_MID - CL_LOW_BASE, CL_MID + 6.0 - CL_LOW_BASE, tower * (CL_CB_TOP - CL_LOW_BASE)) * 0.7);
    }
    shade = 1.0 - occ;
  }

  float diffuse = clamp((ndl + 0.2) / 1.1, 0.0, 1.0) * sun.w * shade;
  vec3 tone = mix(uLowShade, uLowLit * sun.rgb, smoothstep(0.0, 0.85, diffuse));
  // darker toward the base of domes and towers (ambient occlusion, painterly lavender)
  tone = mix(uLowDeep * mix(0.35, 1.0, sun.w), tone, mix(0.45, 1.0, smoothstep(0.0, 0.75, heightFrac)));
  tone *= mix(0.88, 1.05, fine * fadeFine + 0.5 * (1.0 - fadeFine));

  vec3 viewDir = -dir;
  tone = cloudHaze(tone, q, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(hKm));
  vec3 color = tone * mix(0.03, 1.0, night);
  float deckness = smoothstep(0.25, 0.65, m.r);
  float alpha = cov * mix(0.9, 0.97, deckness) * mix(0.05, 1.0, night);

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>

  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    // depth of the hit (same ray from the camera, so view depth scales with distance)
    float distP = length(P - uCamObj);
    float wHit = (vFragDepth - 1.0) * (distP + tHit) / distP;
    gl_FragDepth = log2(1.0 + wHit) * logDepthBufFC * 0.5;
  #endif
}
`;

// ---------------------------------------------------------------------------
const MID_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
uniform highp sampler3D uPuffTex;
uniform vec3 uMidLit;
uniform vec3 uMidShade;

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vPosObj);
  vec4 m = cloudFields(n);
  if (m.g < -0.3) discard;
  vec3 drift = cloudDrift();
  float fw = length(fwidth(n));
  float big = texture(uPuffTex, n * (140.0 / 4.0) + drift + 0.19).r;
  float ac = texture(uPuffTex, n * (620.0 / 8.0) + drift * 2.0).a;
  float fadeAc = 1.0 - smoothstep(0.25, 0.7, fw * 620.0);
  // thin mid cloud reads as altocumulus cells, thick as an altostratus sheet
  float acness = 1.0 - smoothstep(0.15, 0.6, m.g);
  float dens = m.g + (big - 0.4) * 0.3 + (ac - 0.55) * 0.7 * acness * fadeAc;
  dens -= smoothstep(0.25, 0.65, m.a) * 0.5; // towers occupy the mid levels there
  // soft, veil-like edges for altostratus, crisper for altocumulus cells
  float edgeW = max(mix(0.25, 0.1, acness), fwidth(dens) * 1.5);
  float cov = smoothstep(0.0, edgeW, dens);
  if (cov < 0.01) discard;

  vec3 L = normalize(uSunDirObj);
  float mu = dot(n, L);
  vec4 sun = sunAt(mu, CL_MID);
  float cell = mix(0.5, ac, acness * fadeAc);
  float diffuse = clamp(0.72 + mu * 0.28 + (cell - 0.5) * 0.6, 0.0, 1.0) * sun.w;
  vec3 tone = mix(uMidShade, uMidLit * sun.rgb, diffuse);
  vec3 viewDir = normalize(uCamObj - vPosObj);
  tone = cloudHaze(tone, n, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(CL_MID));
  float alpha = cov * mix(0.55, 0.9, smoothstep(0.1, 0.6, dens)) * mix(0.05, 1.0, night);
  gl_FragColor = vec4(tone * mix(0.03, 1.0, night), alpha);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
const HIGH_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
uniform highp sampler3D uPuffTex;
uniform vec3 uHighLit;
uniform vec3 uHighShade;

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vPosObj);
  vec4 m = cloudFields(n);
  if (m.b < -0.28) discard;
  vec3 drift = cloudDrift();
  float fw = length(fwidth(n));
  // streaks stretched east–west (along the westerlies / jet): compressing the
  // noise's y axis makes features long in longitude, narrow in latitude
  vec3 a = vec3(n.x, n.y * 5.0, n.z);
  float s1 = texture(uPuffTex, a * (70.0 / 4.0) + drift * 0.5 + 0.61).r;
  float s2 = texture(uPuffTex, a.zxy * (240.0 / 8.0) + drift).a;
  float fade2 = 1.0 - smoothstep(0.2, 0.6, fw * 240.0 * 5.0);
  float anvil = smoothstep(0.3, 0.65, m.b);
  float dens = m.b + ((s1 - 0.4) * 0.6 + (s2 - 0.5) * 0.35 * fade2) * (1.0 - anvil * 0.65);
  float edgeW = max(0.08, fwidth(dens) * 1.5);
  float cov = smoothstep(0.0, edgeW, dens);
  if (cov < 0.01) discard;

  vec3 L = normalize(uSunDirObj);
  float mu = dot(n, L);
  vec4 sun = sunAt(mu, CL_HIGH);
  float diffuse = clamp(0.6 + mu * 0.4 + (s1 - 0.5) * 0.3 * anvil, 0.0, 1.0) * sun.w;
  vec3 tone = mix(uHighShade, uHighLit * sun.rgb, diffuse);
  vec3 viewDir = normalize(uCamObj - vPosObj);
  tone = cloudHaze(tone, n, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(CL_HIGH));
  // thin cirrus is translucent; anvils/shields nearly opaque, but thinner over
  // the strongest convective cores so the overshooting towers show through
  float alpha = cov * mix(0.4, 0.9, anvil) * (1.0 - 0.45 * smoothstep(0.45, 0.9, m.a));
  alpha *= mix(0.04, 1.0, night);
  gl_FragColor = vec4(tone * mix(0.03, 1.0, night), alpha);
  #include <colorspace_fragment>
}
`;

export interface CloudObjects {
  mesh: THREE.Object3D;
  setSunDirObject(v: THREE.Vector3): void;
  setSunDirWorld(v: THREE.Vector3): void;
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
    uHazeCool: { value: RELIEF.hazeCool },
    uHazeWarm: { value: RELIEF.hazeWarm },
    uSunsetGold: { value: CLOUD_LAYERS.sunsetGold },
    uSunsetPink: { value: CLOUD_LAYERS.sunsetPink },
  };

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.ShaderMaterial[] = [];

  function shell(altKm: number, fragmentShader: string, extra: Record<string, THREE.IUniform>, order: number): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM + altKm, 192, 128);
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
    };
    geometries.push(geometry);
    materials.push(material);
    group.add(mesh);
    return mesh;
  }

  shell(
    CLOUD_ALT.cbTop,
    LOW_FRAGMENT,
    { uLowLit: { value: CLOUD_LAYERS.lowLit }, uLowShade: { value: CLOUD_LAYERS.lowShade }, uLowDeep: { value: CLOUD_LAYERS.lowDeep } },
    1,
  );
  shell(CLOUD_ALT.mid, MID_FRAGMENT, { uMidLit: { value: CLOUD_LAYERS.midLit }, uMidShade: { value: CLOUD_LAYERS.midShade } }, 1.1);
  shell(CLOUD_ALT.high, HIGH_FRAGMENT, { uHighLit: { value: CLOUD_LAYERS.highLit }, uHighShade: { value: CLOUD_LAYERS.highShade } }, 1.2);

  // dev-only perf hook: __cloudsVisible(false) hides the shells (A/B timing)
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    (window as unknown as { __cloudsVisible?: (v: boolean | number) => void }).__cloudsVisible = (v) => {
      // true/false, or a bitmask of shells (1 low, 2 mid, 4 high)
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
