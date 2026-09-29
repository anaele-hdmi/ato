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

const float F_MASS = 120.0;   // cloud-mass cell scale (~53 km cells)
const float F_DETAIL = 400.0; // cumulus texture inside the masses (~16 km)
// the 2D low layer sits in the middle of the boundary-layer cloud slab
const float LOW_LAYER = 0.5 * (CL_LOW_BASE + CL_DECK_TOP) + 1.0;

// billow texture: a = merged masses (8 cells/tile), r = coarser grouping
vec4 billowAt(vec3 q, float f) { return texture(uPuffTex, q * (f / 8.0) + cloudDrift()); }

// 2D low-layer density: the macro field sets coverage; masses and a detail
// texture shape soft cloud fields inside it (EVE-style main + detail maps)
float lowDensity(vec3 q, vec4 m, float fade, float fadeDetail) {
  float deck = smoothstep(0.3, 0.75, m.r);
  float mass = billowAt(q, F_MASS).a;
  float det = billowAt(q, F_DETAIL).a;
  // open cells behind cold fronts: cloud walls around clear centres
  float open = clamp(-m.a, 0.0, 1.0);
  mass = mix(mass, smoothstep(0.1, 0.8, 1.0 - mass), open * 0.8);
  return m.r + (mass - 0.4) * 0.5 * fade + (det - 0.42) * mix(0.28, 0.18, deck) * fadeDetail;
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
  } else {
    // 2D layer: soft coverage, sun-side brightening from an offset sample
    // toward the sun (density falling toward the sun = lit edge)
    float d = lowDensity(q, m, fade, fadeDetail);
    cov = smoothstep(0.0, mix(0.3, 0.45, 1.0 - fade), d);
    if (cov < 0.01) discard;
    // offset sample of the detail texture only (the masses barely change
    // over that distance): one fetch
    float dt0 = billowAt(q, F_DETAIL).a;
    float dt1 = billowAt(normalize(q + sunT * (0.5 / F_DETAIL)), F_DETAIL).a;
    float grad = clamp((dt0 - dt1) * 0.3 * fadeDetail * 4.0, -1.0, 1.0) * horiz;
    thick = smoothstep(0.0, 0.8, d);
    light = clamp(0.62 + 0.25 * mu + 0.45 * grad - 0.12 * thick, 0.0, 1.0);
  }

  // shade from mid deck / anvils / cirrus / tower clusters up-sun (one lookup)
  float shade = 1.0;
  if (sun.w > 0.01) {
    float k = 1.0 / (max(mu + clHorizonDip(hKm), 0.05) * CL_R0);
    vec4 fm = cloudFieldsFast(normalize(q + tang * max(CL_MID - hKm, 0.0) * k));
    float occ = smoothstep(-0.05, 0.4, fm.g) * 0.45 * step(hKm, CL_MID);
    occ = max(occ, smoothstep(0.0, 0.4, fm.b) * mix(0.2, 0.55, smoothstep(0.35, 0.7, fm.b)) * step(hKm, CL_HIGH));
    occ = max(occ, smoothstep(0.45, 0.85, fm.a) * 0.5 * step(hKm, CL_MID));
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

  tone = cloudHaze(tone, q, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(hKm));
  vec3 color = tone * mix(0.03, 1.0, night);
  float alpha = cov * mix(0.85, 0.96, thick) * mix(0.05, 1.0, night);

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
  float dens = m.b * (1.0 + ((s1 - 0.4) * 2.2 + (s2 - 0.5) * 1.2 * fade2) * (1.0 - anvil * 0.65));
  float cov = smoothstep(0.0, 0.06 + 0.1 * (1.0 - fade2), dens);
  float mu = dot(n, L);
  vec4 sun = sunAt(mu, CL_HIGH);
  float diffuse = clamp(0.6 + mu * 0.4 + (s1 - 0.5) * 0.3 * anvil, 0.0, 1.0) * sun.w;
  vec3 tone = cloudHaze(mix(uHighShade, uHighLit * sun.rgb, diffuse), n, viewDir, mu);
  float night = smoothstep(-0.02, 0.06, mu + clHorizonDip(CL_HIGH));
  // thin cirrus is translucent; anvils/shields nearly opaque, but thinner over
  // the strongest convective cores so the towers show through
  float alpha = cov * mix(0.4, 0.9, anvil) * (1.0 - 0.45 * smoothstep(0.45, 0.9, m.a)) * mix(0.04, 1.0, night);
  return vec4(tone * mix(0.03, 1.0, night), alpha);
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
