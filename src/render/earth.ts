// The Earth: a two-layer LOD faceted-relief icosphere (client reference
// direction, superseding the flat posterized-band rule in docs/art-direction.md).
//
// Layer 1 (always resident): one merged, coarse (level 5) undisplaced sphere,
// inset 0.5 km below the true radius so it never z-fights layer 2.
// Layer 2 (streamed): level-3 icosahedron "seed" chunks (1280 of them, stable
// indices) built up to a fine sub-grid on demand, in two rings around the
// sub-station point: level 9 (4096 tri/chunk, ~14 km facet edges) within
// ~800 km, level 8 (1024 tri/chunk, ~28 km edges) out to beyond the horizon.
// ?detail=8 uses level 8 everywhere (weaker phones), ?detail=9 level 9
// everywhere. Chunks are built in a Web Worker (terrainWorker.ts) and
// streamed in a few per frame (see updateLOD). Level-9 chunks snap their odd
// border vertices onto their level-8 neighbours' edges, so the rings meet
// without cracks.
//
// Positions arrive displaced (DEM + ridged/rolling micro-relief, terrain.ts).
// Each vertex also carries 8 baked horizon elevation angles (aHorizonA/B) for
// cast shadows. The fragment shader derives a flat per-triangle normal from
// screen-space derivatives of the displaced world position and shades it
// relative to flat ground at that point (review-2 §5-1): facets tilted toward
// the sun go warm gold, facets tilted away cool teal, at any sun elevation,
// and anything below its horizon toward the sun is in cast shadow. Lon/lat
// sampling always comes from the *undisplaced* object-space direction
// (normalize(position)) so the land mask / biome / cloud-shadow lookups stay
// correct regardless of LOD or displacement.
import * as THREE from 'three';
import { EARTH_COLORS, BIOMES, GLINT, RELIEF } from './palette';
import { buildLandMask, buildBiomeTexture } from './landmask';
import {
  extractChannel,
  loadRaster,
  buildTerrainChunk,
  HORIZON_MIN_DEG,
  HORIZON_MAX_DEG,
  type Raster,
} from './terrain';
import { CLOUD_MAP_GLSL, type CloudMapUniforms } from './cloudMap';
import { buildSeedChunks, buildMergedCoarseSphere, type SeedChunk } from './icosphere';
import type { TerrainWorkerRequest, TerrainWorkerResult } from './terrainWorker';
import { EARTH_RADIUS_KM } from '../types';
import { CLOUD_GLSL } from './clouds';
import topoUrl from '../assets/earth-topology.png';


// --- LOD tuning ---------------------------------------------------------
const SEED_LEVEL = 3; // 20 * 4^3 = 1280 seed chunks (~880 km across), stable indices
const COARSE_EXTRA_LEVELS = 2; // seed(3) + 2 = level 5 full sphere (20k tris), always resident, behind the horizon
const COARSE_INSET_KM = 0.5; // below true radius, so layer 2 is never z-fought
// From 420 km orbit, horizon distance is ~2300 km; add margin for tall
// exaggerated peaks poking over it. Hysteresis avoids flicker at the boundary.
const DETAIL_ENTER_KM = 3300;
const DETAIL_EXIT_KM = 3700;
// Inner (finer) ring, measured from the seed chunk's centre.
const NEAR_ENTER_KM = 800;
const NEAR_EXIT_KM = 1000;
const BUILD_BUDGET_PER_FRAME = 6; // requests posted to the worker per frame
const MAX_IN_FLIGHT = 12; // keeps the worker queue short (and re-prioritised)

// Terrain lighting (review-2 §5-1). Local constants rather than palette
// entries so this module can be tuned independently.
const SHADE_BASE_SHARE = 0.6; // shadow facet = mix(coolShadow, base, this)
const LIT_BASE_SHARE = 0.8; // sunlit facet = mix(warmLit, base, this)
const FACET_SOFTNESS = 0.14; // rad of tilt (rel. to flat ground) for the lit/shade transition, low sun
const FACET_SOFTNESS_HIGH = 0.24; // ... with the sun high (softer, less busy at midday)
const FACET_BIAS = 0.03; // flat ground reads slightly more lit than shaded
// Above ~17 deg sun elevation, slopes tilted away by less than about
// (elevation - 17 deg) * 0.4 stay lit: midday relief is gentler (physically
// they are still well lit), low-sun relief keeps the full gold/teal split.
const FACET_BIAS_HIGH_SUN = 0.4;
const SHADE_GAIN = 0.78; // value of the shade colour (lower = deeper shadows)
const HORIZON_SOFT_DEG = 1.5; // cast-shadow edge softness

function readDetailLevels(): { near: number; far: number } {
  try {
    const v = new URLSearchParams(location.search).get('detail');
    if (v === '9') return { near: 9, far: 9 };
    if (v === '8') return { near: 8, far: 8 };
    if (v === '7') return { near: 8, far: 7 };
  } catch {
    /* location unavailable (non-browser); default */
  }
  // Level 9 (~14 km facet edges) near the sub-station point, level 8
  // (~28 km) out to the horizon: ~+30 % triangles over all-8.
  return { near: 9, far: 8 };
}
const LEVELS = readDetailLevels();

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormalObj;
varying vec3 vNormalWorld; // geocentric up in WORLD space (orients the facet normal)
varying vec3 vWorldPosition;
varying float vGroundKm; // cloud shadows: ground altitude (displaced)
attribute vec4 aHorizonA; // horizon angles, azimuths 0-3 (N, NE, E, SE), 0..1 encoded
attribute vec4 aHorizonB; // azimuths 4-7 (S, SW, W, NW)
uniform vec3 uSunDirObj;
// Cast-shadow term, constant per triangle (flat = the provoking vertex's
// value): shadows follow the facets, in keeping with the low-poly look,
// instead of cutting jagged iso-lines through them.
flat varying float vCastLit;

// Cast shadow from the baked per-vertex horizon angles (terrain.ts
// computeHorizons), evaluated per vertex: 1 = sun above the local horizon toward it, 0 = shadowed.
// Tangent frame must match the bake: east = cross(+Y, n), north = cross(n, east),
// azimuth k*45 deg clockwise from north.
float horizonLit(vec3 n, vec3 sunObj, vec4 hA, vec4 hB) {
  vec3 e = vec3(n.z, 0.0, -n.x);
  float el = length(e);
  e = el > 1e-5 ? e / el : vec3(1.0, 0.0, 0.0);
  vec3 no = cross(n, e);
  float sunElDeg = degrees(asin(clamp(dot(n, sunObj), -1.0, 1.0)));
  float az = atan(dot(sunObj, e), dot(sunObj, no)) * (4.0 / PI); // -4..4, in 45-degree units
  vec4 dA = abs(mod(az - vec4(0.0, 1.0, 2.0, 3.0) + 4.0, 8.0) - 4.0);
  vec4 dB = abs(mod(az - vec4(4.0, 5.0, 6.0, 7.0) + 4.0, 8.0) - 4.0);
  float hN = dot(clamp(1.0 - dA, 0.0, 1.0), hA) + dot(clamp(1.0 - dB, 0.0, 1.0), hB);
  float hDeg = mix(${HORIZON_MIN_DEG.toFixed(1)}, ${HORIZON_MAX_DEG.toFixed(1)}, hN);
  return smoothstep(hDeg - ${HORIZON_SOFT_DEG.toFixed(2)}, hDeg + ${HORIZON_SOFT_DEG.toFixed(2)}, sunElDeg);
}


// Positions arrive already displaced (terrain.ts, computed once per chunk).
void main() {
  vNormalObj = normalize(position);
  vNormalWorld = normalize(mat3(modelMatrix) * position);
  vCastLit = horizonLit(vNormalObj, normalize(uSunDirObj), aHorizonA, aHorizonB);
  vGroundKm = length(position) - ${EARTH_RADIUS_KM.toFixed(1)};
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uLandTex;
uniform sampler2D uBiomeTex;
uniform vec3 uSunDirObj;
uniform vec3 uSunDirWorld;
uniform float uTime;

uniform vec3 uDeepOcean;
uniform vec3 uShallowOcean;
uniform vec3 uIce;
uniform vec3 uNightLand;
uniform vec3 uNightOcean;

uniform vec3 uTropicalForest;
uniform vec3 uSavanna;
uniform vec3 uDesert;
uniform vec3 uTemperateForest;
uniform vec3 uTundra;

uniform vec3 uGlintColor;
uniform vec3 uWarmLit;
uniform vec3 uCoolShadow;
uniform vec3 uSkyAmbient;
uniform vec3 uHazeCool;
uniform vec3 uHazeWarm;

varying vec3 vNormalObj;
varying vec3 vNormalWorld;
varying vec3 vWorldPosition;
varying float vGroundKm;
flat varying float vCastLit;

${CLOUD_GLSL}
${CLOUD_MAP_GLSL}

// Anti-aliased step: hard edge, but smoothed over ~1 pixel.
float aaStep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}

// Land colour: hand-placed arid / rainforest regions (biome texture) +
// latitude bands for temperate, boreal/tundra and ice. One noise lookup
// only, to break band edges.
vec3 biomeColor(float absLat, vec2 uv, vec3 n) {
  vec2 bio = texture2D(uBiomeTex, uv).rg;
  float jitter = (cloudNoise(n * 9.0 + 5.0) - 0.5) * 8.0;
  float L = absLat + jitter;

  vec3 c = mix(uSavanna, uTropicalForest, smoothstep(0.35, 0.8, bio.g));
  float temperate = smoothstep(28.0, 38.0, L) * (1.0 - smoothstep(58.0, 64.0, L));
  c = mix(c, uTemperateForest, temperate * (1.0 - bio.g));
  float tundra = smoothstep(60.0, 66.0, L);
  c = mix(c, uTundra, tundra);
  c = mix(c, uDesert, smoothstep(0.3, 0.75, bio.r) * (1.0 - tundra));
  return c;
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vNormalObj);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec3 mask = texture2D(uLandTex, uv).rgb;

  float land = aaStep(0.5, mask.r);
  float coast = aaStep(0.35, mask.g);
  float absLat = abs(lat) * 57.2958;

  vec3 ocean = mix(uDeepOcean, uShallowOcean, coast);
  vec3 ground = biomeColor(absLat, uv, n);
  ground = mix(ground, uIce, aaStep(70.0, absLat));
  ocean = mix(ocean, uIce, aaStep(74.0, absLat));
  vec3 base = mix(ocean, ground, land);

  // Faceted relief: flat per-triangle normal from screen-space derivatives
  // of the displaced world position -- this is what makes each triangle its
  // own flat-shaded facet.
  vec3 fdx = dFdx(vWorldPosition);
  vec3 fdy = dFdy(vWorldPosition);
  vec3 rawFlatN = cross(fdx, fdy);
  float rawLen = length(rawFlatN);
  // Guard against degenerate derivatives: a triangle viewed near edge-on (a
  // common case at grazing/near-horizon angles, worse for the coarse layer's
  // larger triangles) can foreshorten to sub-pixel width, and dFdx/dFdy then
  // sample across unrelated neighbouring triangles, producing a near-zero or
  // NaN cross product. Falling back to the smooth per-vertex normal there
  // (instead of propagating NaN into ndotl/nightMix) is what fixes the
  // jagged pale-grey patches that used to appear on the night side.
  // Orient outward against the WORLD-space geocentric up: flatN is a world
  // vector, and testing it against the object-space n flipped facets inward
  // (dark) wherever the Earth's spin (gmst) had rotated the two frames apart.
  vec3 upW = normalize(vNormalWorld);
  vec3 flatN = rawLen > 1e-6 ? rawFlatN / rawLen : upW;
  if (dot(flatN, upW) < 0.0) flatN = -flatN;

  vec3 sunW = normalize(uSunDirWorld);
  float ndotl = dot(flatN, sunW);
  // Smooth (per-vertex-normal) day/night term, numerically stable everywhere.
  // NB: must dot against the OBJECT-space sun direction (n is object-space,
  // undoes the Earth's own spin) -- dotting it with the world-space sunW
  // above is a frame mismatch (they drift apart as the planet rotates) and
  // was the actual cause of the jagged pale patch on the night side, not a
  // facet/derivative precision issue as first suspected.
  float ndotlSmooth = dot(n, normalize(uSunDirObj));

  // Split-tone lighting relative to FLAT GROUND at this point (review-2
  // §5-1). A wrapped Lambert term collapsed every facet to the same mid-tone
  // at low sun (13 deg: flat 0.42, +-10 deg slopes +-0.13). Instead measure
  // how far the facet is tilted toward/away from the sun compared to the
  // local horizontal (ndotl - n0, divided by d(sin el)/d(el) = cos el so it
  // is ~ the tilt in radians at any sun elevation) and switch between a warm
  // gold "lit" and a cool teal "shade" colour: east slopes go gold and west
  // slopes teal whether the sun is at 10 deg or 60 deg. Cast shadows (horizon
  // angles) and the terminator force the shade colour; the night blend below
  // is unchanged. MIX (not multiply) toward the tints, so shadows stay blue
  // even on orange/tan ground instead of muddy brown.
  vec3 sunObj = normalize(uSunDirObj);
  float n0 = ndotlSmooth;
  float rel = (ndotl - n0) / max(sqrt(max(1.0 - n0 * n0, 0.0)), 0.35);
  float sunElRad = asin(clamp(n0, -1.0, 1.0));
  float soft = mix(${FACET_SOFTNESS.toFixed(3)}, ${FACET_SOFTNESS_HIGH.toFixed(3)}, smoothstep(0.3, 1.0, sunElRad));
  float bias = ${FACET_BIAS.toFixed(3)} + ${FACET_BIAS_HIGH_SUN.toFixed(2)} * max(sunElRad - 0.3, 0.0);
  float facing = smoothstep(-soft, soft, rel + bias);
  float dayLit = smoothstep(-0.01, 0.07, n0);
  float litAmt = facing * vCastLit * dayLit;
  vec3 shadeColor = mix(uCoolShadow, base, ${SHADE_BASE_SHARE.toFixed(2)}) * ${SHADE_GAIN.toFixed(2)};
  vec3 litColor = mix(uWarmLit, base, ${LIT_BASE_SHARE.toFixed(2)}) * 1.05;
  vec3 lit = mix(shadeColor, litColor, litAmt);
  vec3 ambient = uSkyAmbient * (1.0 - litAmt) * 0.08;
  vec3 landColor = lit + ambient;
  // Water is flat: the gold/teal split toning (meant for facets) turned it
  // mauve. Plain diffuse with a little sky fill keeps it blue.
  vec3 waterColor = base * (0.45 + 0.6 * clamp(ndotl, 0.0, 1.0)) + uSkyAmbient * 0.05;
  vec3 color = mix(waterColor, landColor, land);

  vec3 nightColor = mix(uNightOcean, uNightLand, land);
  // NB: edges must stay ascending here -- smoothstep with edge0 > edge1 is
  // undefined by the GLSL spec, and SwiftShader visibly mishandles it
  // (a jagged pale-grey blob on the night side instead of near-black).
  float nightMix = 1.0 - smoothstep(-0.28, -0.02, ndotlSmooth);
  color = mix(color, nightColor, nightMix);

  // cloud shadow: every cloud layer, offset toward the sun by its true
  // (rendered) height above this ground point (cloudMap.ts cloudShadow).
  float shadowAmt = cloudShadow(n, vGroundKm, normalize(uSunDirObj)) * (1.0 - nightMix);
  color *= mix(1.0, 0.62, shadowAmt);

  // stylized ocean sun glint: bright core + soft halo, water only, daylight only.
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 halfDir = normalize(viewDir + sunW);
  float spec = max(dot(flatN, halfDir), 0.0);
  // Sun glint from a wave-slope distribution (Cox-Munk style): the sea is a
  // field of tilted facets, so the glint is a broad soft patch centred on
  // the specular point (tens to hundreds of km from orbit), not a pinpoint.
  // sigma^2 ~ mean-square wave slope (moderate wind).
  float water = (1.0 - land) * clamp(ndotl * 4.0, 0.0, 1.0) * (1.0 - nightMix) * (1.0 - shadowAmt * 0.8);
  float c2 = max(spec * spec, 1e-4);
  float tan2 = (1.0 - c2) / c2;
  const float SIGMA2 = 0.035;
  float slopePdf = exp(-tan2 / SIGMA2) / (SIGMA2 * c2 * c2);
  float nv = max(dot(flatN, viewDir), 0.05);
  // radiance ~ F * pdf / (4 cos(view)); F ~ 0.02..0.1, folded into the gain
  float glint = (slopePdf / (4.0 * nv) * 0.012 + pow(spec, 4000.0) * 1.2) * water;
  // grazing-angle sky reflection (Fresnel) gives the sea a sheen toward the horizon
  float fres = pow(1.0 - clamp(dot(flatN, viewDir), 0.0, 1.0), 5.0);
  color += uSkyAmbient * fres * 0.35 * water;
  color += uGlintColor * glint;

  // aerial perspective: pale blue-white haze toward the horizon (grazing
  // view angle) and with distance from the camera -- stronger than a
  // realistic haze, per the reference images, and gated off on the night side.
  float distKm = length(cameraPosition - vWorldPosition);
  float grazing = pow(1.0 - clamp(dot(flatN, viewDir), 0.0, 1.0), 6.0);
  float distFactor = smoothstep(1400.0, 5200.0, distKm);
  float haze = clamp(grazing * 0.24 + distFactor * 0.22, 0.0, 1.0) * (1.0 - nightMix);
  vec3 hazeColor = mix(uHazeCool, uHazeWarm, smoothstep(0.05, 0.7, ndotl) * 0.5);
  color = mix(color, hazeColor, haze * 0.15);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export interface EarthStats {
  coarseTriangles: number;
  detailChunks: number;
  /** Resident detail chunks per subdivision level, e.g. { 8: 80, 9: 7 }. */
  detailChunksByLevel: Record<number, number>;
  detailTriangles: number;
  /** Kept for existing callers: same as detailTriangles. */
  detailTrianglesApprox: number;
  /** Worker build time per chunk (ms) since start, per level. */
  buildMs: Record<number, { count: number; avg: number; max: number }>;
  pendingBuilds: number;
  /** false if chunks are built on the main thread (worker unavailable). */
  worker: boolean;
}

export interface EarthObjects {
  /** Non-rotating pivot; caller positions this at -stationPos each frame. */
  pivot: THREE.Group;
  /** Rotates about +Y by gmstRad each frame. */
  rotGroup: THREE.Group;
  material: THREE.ShaderMaterial;
  /** Sets the sun direction in Earth OBJECT space (already de-rotated by -gmstRad). */
  setSunDirObject(v: THREE.Vector3): void;
  /** Sets the sun direction in WORLD (scene) space, for lighting + the ocean glint. */
  setSunDirWorld(v: THREE.Vector3): void;
  /** Simulation clock, seconds — kept in sync with the cloud shell's drift. */
  setTime(seconds: number): void;
  /** Streams high-detail chunks in/out around the sub-station point (OBJECT
   *  space unit direction, already de-rotated by -gmstRad like the sun dir).
   *  Call once per frame; requests at most a few chunk builds per call (built
   *  asynchronously in a worker, swapped in when ready). */
  updateLOD(subStationDirObject: THREE.Vector3): void;
  getStats(): EarthStats;
  dispose(): void;
}

interface DetailEntry {
  level: number;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
}

export function createEarth(cloudMap: CloudMapUniforms): EarthObjects {
  const landMask = buildLandMask();
  const landTexture = landMask.texture;
  // Only the land/sea channel is needed for displacement; a compact copy is
  // what goes to the worker.
  const landRaster: Raster = extractChannel(
    { data: landMask.data, width: landMask.width, height: landMask.height, stride: 4 },
    0,
  );
  const biomeTexture = buildBiomeTexture();

  // --- Chunk builder: a module worker, or the main thread as a fallback ---
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  let workerReady = false; // rasters posted
  let heightRaster: Raster | null = null; // main-thread fallback only
  let nextRequestId = 1;
  // seed index -> the request currently outstanding for it
  const pending = new Map<number, { id: number; level: number }>();
  const buildStats = new Map<number, { count: number; sum: number; max: number }>();

  const useMainThread = (reason: unknown) => {
    if (!worker) return;
    console.warn('[terrain] worker unavailable, building chunks on the main thread', reason);
    worker.terminate();
    worker = null;
    pending.clear();
  };

  // Heightmap: decoded on the main thread (needs a canvas), then its single
  // channel is transferred to the worker once.
  // Retry: a flaky connection can fail the first decode, which would leave
  // the planet without relief for the whole session.
  const loadHeight = (attempt: number) => {
    loadRaster(topoUrl)
      .then((r) => {
        const h = extractChannel(r, 0);
        if (worker) {
          const land = { ...landRaster, data: landRaster.data.slice() };
          const msg: TerrainWorkerRequest = { type: 'init', height: h, land };
          worker.postMessage(msg, [h.data.buffer, land.data.buffer]);
          workerReady = true;
          // keep a main-thread copy only if we may need to fall back later
          heightRaster = null;
          fallbackHeightSource = r;
        } else {
          heightRaster = h;
        }
      })
      .catch(() => {
        if (attempt < 4) setTimeout(() => loadHeight(attempt + 1), 1000 * (attempt + 1));
      });
  };
  // RGBA raster kept by reference (no copy) in case the worker dies later.
  let fallbackHeightSource: Raster | null = null;
  loadHeight(0);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    // FrontSide: every chunk is wound CCW from outside (icosphere.ts), and with
    // a logarithmic depth buffer (no early-Z) back faces cost a full extra
    // terrain-shader pass (review-2 §3.2).
    side: THREE.FrontSide,
    uniforms: {
      uLandTex: { value: landTexture },
      uBiomeTex: { value: biomeTexture },
      ...cloudMap,
      uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
      uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
      uDeepOcean: { value: EARTH_COLORS.deepOcean },
      uShallowOcean: { value: EARTH_COLORS.shallowOcean },
      uIce: { value: EARTH_COLORS.ice },
      uNightLand: { value: EARTH_COLORS.nightLand },
      uNightOcean: { value: EARTH_COLORS.nightOcean },
      uTropicalForest: { value: BIOMES.tropicalForest },
      uSavanna: { value: BIOMES.savanna },
      uDesert: { value: BIOMES.desert },
      uTemperateForest: { value: BIOMES.temperateForest },
      uTundra: { value: BIOMES.tundra },
      uGlintColor: { value: GLINT.color },
      uWarmLit: { value: RELIEF.warmLit },
      uCoolShadow: { value: RELIEF.coolShadow },
      uSkyAmbient: { value: RELIEF.skyAmbient },
      uHazeCool: { value: RELIEF.hazeCool },
      uHazeWarm: { value: RELIEF.hazeWarm },
    },
  });

  const rotGroup = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.add(rotGroup);

  // --- Layer 1: coarse, always-resident, undisplaced full sphere ---------
  const seeds: SeedChunk[] = buildSeedChunks(SEED_LEVEL);
  const coarseBuilt = buildMergedCoarseSphere(seeds, COARSE_EXTRA_LEVELS, EARTH_RADIUS_KM - COARSE_INSET_KM);
  const coarseGeometry = new THREE.BufferGeometry();
  coarseGeometry.setAttribute('position', new THREE.BufferAttribute(coarseBuilt.positions, 3));
  // No relief, so no cast shadows: horizon = minimum everywhere.
  const coarseVerts = coarseBuilt.positions.length / 3;
  coarseGeometry.setAttribute('aHorizonA', new THREE.BufferAttribute(new Uint8Array(coarseVerts * 4), 4, true));
  coarseGeometry.setAttribute('aHorizonB', new THREE.BufferAttribute(new Uint8Array(coarseVerts * 4), 4, true));
  coarseGeometry.setIndex(new THREE.BufferAttribute(coarseBuilt.indices, 1));
  coarseGeometry.computeBoundingSphere();
  const coarseMesh = new THREE.Mesh(coarseGeometry, material);
  rotGroup.add(coarseMesh);
  const coarseTriangles = coarseBuilt.indices.length / 3;

  // --- Layer 2: streamed high-detail chunks -------------------------------
  const detailGroup = new THREE.Group();
  rotGroup.add(detailGroup);
  const detailCache = new Map<number, DetailEntry>();
  // Target level per seed (0 = no detail), with hysteresis; updated every
  // updateLOD, consulted when a build result arrives.
  const desired = new Map<number, number>();

  function recordBuild(level: number, ms: number): void {
    const b = buildStats.get(level) ?? { count: 0, sum: 0, max: 0 };
    b.count++;
    b.sum += ms;
    b.max = Math.max(b.max, ms);
    buildStats.set(level, b);
  }

  function install(seedIndex: number, level: number, c: {
    positions: Float32Array;
    indices: Uint16Array;
    horizonA: Uint8Array;
    horizonB: Uint8Array;
  }): void {
    if ((desired.get(seedIndex) ?? 0) !== level) return; // stale: the station moved on
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    geometry.setAttribute('aHorizonA', new THREE.BufferAttribute(c.horizonA, 4, true));
    geometry.setAttribute('aHorizonB', new THREE.BufferAttribute(c.horizonB, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(c.indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    const old = detailCache.get(seedIndex);
    if (old) {
      detailGroup.remove(old.mesh);
      old.geometry.dispose();
    }
    detailGroup.add(mesh);
    detailCache.set(seedIndex, { level, mesh, geometry });
  }

  if (worker) {
    worker.onmessage = (e: MessageEvent<TerrainWorkerResult>) => {
      const r = e.data;
      const p = pending.get(r.seedIndex);
      if (p && p.id === r.id) pending.delete(r.seedIndex);
      recordBuild(r.level, r.ms);
      install(r.seedIndex, r.level, r);
    };
    worker.onerror = (e) => useMainThread(e.message);
  }

  function requestBuild(seed: SeedChunk, level: number): void {
    const snapBorder = level > LEVELS.far;
    if (worker) {
      const id = nextRequestId++;
      pending.set(seed.index, { id, level });
      const msg: TerrainWorkerRequest = {
        type: 'build',
        id,
        seedIndex: seed.index,
        corners: seed.corners,
        seedLevel: SEED_LEVEL,
        level,
        radiusKm: EARTH_RADIUS_KM,
        snapBorder,
      };
      worker.postMessage(msg);
      return;
    }
    const t0 = performance.now();
    const c = buildTerrainChunk(seed.corners, SEED_LEVEL, level, EARTH_RADIUS_KM, heightRaster!, landRaster, snapBorder);
    recordBuild(level, performance.now() - t0);
    install(seed.index, level, c);
  }

  function updateLOD(subDirObj: THREE.Vector3): void {
    if (!worker && !heightRaster && fallbackHeightSource) heightRaster = extractChannel(fallbackHeightSource, 0);
    if (worker ? !workerReady : !heightRaster) return; // coarse sphere only until the heightmap has loaded

    const toBuild: { seed: SeedChunk; d: number; level: number }[] = [];
    for (const seed of seeds) {
      const [cx, cy, cz] = seed.center;
      const dot = cx * subDirObj.x + cy * subDirObj.y + cz * subDirObj.z;
      const d = Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) * EARTH_RADIUS_KM;
      const prev = desired.get(seed.index) ?? 0;
      let level: number;
      if (d > (prev ? DETAIL_EXIT_KM : DETAIL_ENTER_KM)) level = 0;
      else if (d < (prev === LEVELS.near ? NEAR_EXIT_KM : NEAR_ENTER_KM)) level = LEVELS.near;
      else level = LEVELS.far;
      if (level) desired.set(seed.index, level);
      else desired.delete(seed.index);

      const entry = detailCache.get(seed.index);
      if (!level) {
        if (entry) {
          detailGroup.remove(entry.mesh);
          entry.geometry.dispose();
          detailCache.delete(seed.index);
        }
        pending.delete(seed.index); // any late result is dropped by install()
        continue;
      }
      if (entry?.level === level) continue;
      const p = pending.get(seed.index);
      if (p && p.level === level) continue;
      // Unbuilt chunks (holes over the coarse sphere) first, then level
      // changes of already-covered chunks; nearest first within each.
      toBuild.push({ seed, d: d + (entry ? 1e5 : 0), level });
    }

    toBuild.sort((a, b) => a.d - b.d);
    const cap = worker ? Math.min(BUILD_BUDGET_PER_FRAME, MAX_IN_FLIGHT - pending.size) : 1;
    for (let i = 0; i < Math.min(cap, toBuild.length); i++) requestBuild(toBuild[i].seed, toBuild[i].level);
  }

  return {
    pivot,
    rotGroup,
    material,
    setSunDirObject(v: THREE.Vector3) {
      (material.uniforms.uSunDirObj.value as THREE.Vector3).copy(v);
    },
    setSunDirWorld(v: THREE.Vector3) {
      (material.uniforms.uSunDirWorld.value as THREE.Vector3).copy(v);
    },
    setTime(seconds: number) {
      material.uniforms.uTime.value = seconds;
    },
    updateLOD,
    getStats(): EarthStats {
      const byLevel: Record<number, number> = {};
      let tris = 0;
      for (const e of detailCache.values()) {
        byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
        tris += (e.geometry.index?.count ?? 0) / 3;
      }
      const buildMs: EarthStats['buildMs'] = {};
      for (const [lvl, b] of buildStats) buildMs[lvl] = { count: b.count, avg: b.sum / b.count, max: b.max };
      return {
        coarseTriangles,
        detailChunks: detailCache.size,
        detailChunksByLevel: byLevel,
        detailTriangles: tris,
        detailTrianglesApprox: tris,
        buildMs,
        pendingBuilds: pending.size,
        worker: worker !== null,
      };
    },
    dispose() {
      worker?.terminate();
      worker = null;
      coarseGeometry.dispose();
      for (const entry of detailCache.values()) entry.geometry.dispose();
      material.dispose();
      landTexture.dispose();
      biomeTexture.dispose();
    },
  };
}
