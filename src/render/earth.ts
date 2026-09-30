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
// Elevation comes from a high-resolution DEM (NOAA ETOPO 2022, 0.05 deg =
// 5.6 km, 18 lazily loaded 60-degree tiles: assets/dem/elev_*.webp) with the
// old 2048x1024 heightmap as fallback (?hires=0, or a tile that failed to
// load). A chunk is only built once every tile around it has arrived, so
// terrain never changes shape after it has appeared. Colours also come from
// the data: bathymetry (bath.webp) tints shelves and turns shallow banks
// turquoise, Natural Earth lakes get a lake colour, snow sits above a
// latitude-dependent snow line, and sea ice follows a seasonal edge model.
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
import { EARTH_COLORS, BIOMES, GLINT, RELIEF, SURFACE, CITY_LIGHTS, MOONLIGHT, moonlightLevel } from './palette';
import { buildLandMask, buildBiomeTexture, buildSeaIceTexture, buildDummyBathTexture, loadBathTexture, loadR8Texture } from './landmask';
import {
  extractChannel,
  loadRaster,
  buildTerrainChunk,
  createHiDem,
  installHiTile,
  EXAGGERATION,
  HI_TILE_COLS,
  HI_TILE_ROWS,
  HORIZON_MIN_DEG,
  HORIZON_MAX_DEG,
  type HiDem,
  type Raster,
} from './terrain';
import { CLOUD_MAP_GLSL, type CloudMapUniforms } from './cloudMap';
import { buildSeedChunks, buildMergedCoarseSphere, type SeedChunk } from './icosphere';
import type { TerrainWorkerRequest, TerrainWorkerResult } from './terrainWorker';
import { EARTH_RADIUS_KM } from '../types';
import { CLOUD_GLSL } from './clouds';
import topoUrl from '../assets/earth-topology.png';
import bathUrl from '../assets/dem/bath.webp';
import cityUrl from '../assets/city-lights.webp';

// Hi-res DEM tiles (scripts/build-dem.mjs): elev_<col>_<row>.webp, URLs
// resolved by the bundler.
const TILE_URLS: string[] = new Array(HI_TILE_COLS * HI_TILE_ROWS).fill('');
{
  const found = import.meta.glob('../assets/dem/elev_*.webp', { query: '?url', import: 'default', eager: true }) as Record<
    string,
    string
  >;
  for (const [key, url] of Object.entries(found)) {
    const m = /elev_(\d+)_(\d+)\.webp$/.exec(key);
    if (m) TILE_URLS[Number(m[2]) * HI_TILE_COLS + Number(m[1])] = url;
  }
}
const MAX_TILE_LOADS = 3; // concurrent tile fetch+decodes
// A chunk needs DEM coverage this far beyond its own footprint (chunk radius
// ~450 km + the 300 km horizon march), in degrees of arc.
const TILE_PAD_DEG = 9;


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

// Surface colour rules driven by the DEM / bathymetry (all colours: palette.ts SURFACE).
const BATH_CAP_M = 400; // bath.webp depth code: 255 * sqrt(depth / cap), must match scripts/build-dem.mjs
const BATH_FADE_MS = 1600; // shallow-water / lake colours fade in when bath.webp arrives

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

/** ?hires=0 keeps the coarse 2048x1024 DEM only (weak devices, A/B checks). */
function readHiRes(): boolean {
  try {
    return new URLSearchParams(location.search).get('hires') !== '0';
  } catch {
    return true;
  }
}
const HI_RES = readHiRes();

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

uniform sampler2D uBathTex; // RG8: R = shallow-sea depth code, G = lake mask
uniform sampler2D uSeaIceTex; // 360x1 RGBA8: sea-ice edge latitudes, (deg - 40) / 60: N max, N min, S max, S min
uniform float uBathReady;
uniform float uSeason; // fraction of the year, 0 = Jan 1
uniform float uSnowOn; // 0 with the coarse DEM (its altitudes are not in metres)
uniform vec3 uTurquoise;
uniform vec3 uLake;
uniform vec3 uSnow;
uniform vec3 uSeaIce;

uniform vec3 uGlintColor;
uniform vec3 uWarmLit;
uniform vec3 uCoolShadow;
uniform vec3 uSkyAmbient;
uniform vec3 uHazeCool;
uniform vec3 uHazeWarm;
uniform sampler2D uCityTex; // R8 mipmapped night lights (NASA Black Marble)
uniform vec4 uCity;         // x,y: sin(sun elevation) fully on / off; z: gamma; w: gain
uniform vec3 uCitySub;
uniform vec3 uCityCore;
uniform vec3 uCityExt;      // extinction per extra airmass (r,g,b)
uniform vec4 uMoonWorld;    // xyz: moon direction (world), w: moonlight level (0 = new moon)
uniform vec3 uMoonObj;      // moon direction (object space)
uniform vec3 uMoonSurface;  // moonlit ground tint * gain
uniform vec3 uMoonGlint;    // moon glint colour * gain

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

// Snow line altitude (km, true elevation) by absolute latitude: ~5.3 km in the
// subtropics (Himalaya, Andes), 3 km in the Alps, ~1.4 km at 60 deg, sea level
// toward the poles.
float snowLineKm(float a) {
  float s = mix(5.2, 5.5, smoothstep(0.0, 22.0, a));
  s = mix(s, 5.0, smoothstep(22.0, 36.0, a));
  s = mix(s, 3.0, smoothstep(36.0, 46.0, a));
  s = mix(s, 1.4, smoothstep(46.0, 60.0, a));
  s = mix(s, 0.2, smoothstep(60.0, 74.0, a));
  return s;
}

// Sea-ice extent through the year: 0 = seasonal minimum, 1 = maximum. Slow
// growth from the minimum (fMin) to the maximum (fMax), faster retreat.
float seasonT(float f, float fMin, float fMax) {
  float x = fract(f - fMin);
  float span = fract(fMax - fMin);
  return x < span ? smoothstep(0.0, 1.0, x / span) : 1.0 - smoothstep(0.0, 1.0, (x - span) / (1.0 - span));
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vNormalObj);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec3 mask = texture2D(uLandTex, uv).rgb;
  // uv gradients for the mip-mapped city-light lookup: the longitude seam of
  // atan() would pick the lowest mip in one column, so take the smaller of the
  // gradients of uv and of the half-turn-shifted uv (derivatives outside branches)
  vec2 cgx = dFdx(uv);
  vec2 cgy = dFdy(uv);
  float fpKm = length(fwidth(vWorldPosition));
  vec2 uvS = vec2(fract(uv.x + 0.5), uv.y);
  vec2 sgx = dFdx(uvS);
  vec2 sgy = dFdy(uvS);
  if (dot(sgx, sgx) + dot(sgy, sgy) < dot(cgx, cgx) + dot(cgy, cgy)) {
    cgx = sgx;
    cgy = sgy;
  }

  float land = aaStep(0.5, mask.r);
  float absLat = abs(lat) * 57.2958;

  // Bathymetry (ETOPO 2022): the continental shelf tints the sea a little
  // lighter, and shallow banks/reefs (Bahamas, Red Sea, Great Barrier Reef...)
  // go turquoise by depth. G = major lakes (Natural Earth).
  vec2 bath = texture2D(uBathTex, uv).rg;
  float depthM = ${BATH_CAP_M.toFixed(1)} * bath.r * bath.r;
  float shelf = (1.0 - smoothstep(70.0, 260.0, depthM)) * uBathReady;
  float turq = (1.0 - smoothstep(10.0, 42.0, depthM)) * uBathReady;
  float lake = smoothstep(0.3, 0.7, bath.g) * uBathReady;
  vec3 ocean = mix(uDeepOcean, uShallowOcean, shelf);
  ocean = mix(ocean, uTurquoise, turq * 0.85);
  ocean = mix(ocean, uLake, lake); // lakes that the land polygons leave as holes (Caspian, Great Lakes)

  // Seasonal sea ice: per-longitude edge latitudes (max / min extent) blended
  // by the time of year; Arctic peaks in March, Antarctic in September.
  float iceEdge = 99.0;
  float iceJit = 0.0;
  if (absLat > 42.0) {
    vec4 ie = textureLod(uSeaIceTex, vec2(uv.x, 0.5), 0.0) * 60.0 + 40.0;
    iceEdge = lat > 0.0
      ? mix(ie.g, ie.r, seasonT(uSeason, 0.71, 0.18))
      : mix(ie.a, ie.b, seasonT(uSeason, 0.13, 0.72));
    iceJit = (cloudNoise(n * 6.0 + 11.0) - 0.5) * 5.0; // ragged edge
  }
  float seaIce = aaStep(iceEdge, absLat + iceJit);
  ocean = mix(ocean, uSeaIce, seaIce);

  vec3 ground = biomeColor(absLat, uv, n);
  // Snow above the (latitude-dependent) snow line; vGroundKm carries the
  // exaggerated relief, so undo it to compare with true altitudes.
  float elevKm = max(vGroundKm, 0.0) / ${EXAGGERATION.toFixed(1)};
  if (elevKm > 0.15 && uSnowOn > 0.5) {
    float snowLine = snowLineKm(absLat) + (cloudNoise(n * 40.0) - 0.5) * 0.5;
    ground = mix(ground, uSnow, smoothstep(-0.1, 0.3, elevKm - snowLine));
  }
  ground = mix(ground, uIce, aaStep(70.0, absLat));
  ground = mix(ground, uLake, lake);
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
  vec3 color = mix(waterColor, landColor, land * (1.0 - lake)); // lakes are flat water, not facets

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
  float water = (1.0 - land) * (1.0 - seaIce) * clamp(ndotl * 4.0, 0.0, 1.0) * (1.0 - nightMix) * (1.0 - shadowAmt * 0.8);
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

  // ---- night side: moonlight, the moon's glint on the sea, city lights ----
  if (nightMix > 0.002) {
    // cloud cover above this point (one lookup): blocks the lights and the
    // moon glint; the clouds themselves are lit in clouds.ts
    vec4 cf = cloudFieldsFast(n);
    float cover = 1.0 - (1.0 - smoothstep(-0.12, 0.3, cf.r) * 0.85) * (1.0 - smoothstep(0.08, 0.45, cf.a) * 0.9)
      * (1.0 - smoothstep(-0.05, 0.4, cf.g) * 0.6) * (1.0 - smoothstep(-0.1, 0.45, cf.b) * 0.15);

    vec3 moonW = normalize(uMoonWorld.xyz);
    float moonI = uMoonWorld.w * nightMix * smoothstep(-0.02, 0.14, dot(n, uMoonObj));
    if (moonI > 0.001) {
      float mdl = max(dot(flatN, moonW), 0.0);
      // moonlit ground is nearly colourless: pull the daytime albedo toward grey
      vec3 moonAlbedo = mix(vec3(dot(base, vec3(0.3, 0.55, 0.15))), base, 0.4);
      color += moonAlbedo * uMoonSurface * moonI * mix(0.3, 1.0, mdl) * (1.0 - 0.7 * cover);
      float specM = max(dot(flatN, normalize(viewDir + moonW)), 0.0);
      float c2m = max(specM * specM, 1e-4);
      float pdfM = exp(-(1.0 - c2m) / c2m / SIGMA2) / (SIGMA2 * c2m * c2m);
      float waterM = (1.0 - land) * (1.0 - seaIce) * clamp(mdl * 4.0, 0.0, 1.0) * moonI * uMoonWorld.w * (1.0 - 0.85 * cover); // ~ level^2: a thin crescent gives no glint
      color += uMoonGlint * (pdfM / (4.0 * nv) * 0.012 + pow(specM, 4000.0) * 1.2) * waterM;
    }

    float cityOn = 1.0 - smoothstep(uCity.x, uCity.y, ndotlSmooth);
    if (cityOn > 0.002) {
      // under cloud the lights are read from a coarser mip: a soft glow
      float blur = 1.0 + cover * 5.0;
      float v = textureGrad(uCityTex, uv, cgx * blur, cgy * blur).r;
      float cityI = pow(v, uCity.z) * uCity.w;
      // the 19 km texels are too coarse for a lit area: break them into
      // patchy street-scale detail near the ground (fades with the pixel footprint)
      float nz = 0.6 * cloudNoise(n * 700.0) + 0.4 * cloudNoise(n * 2100.0 + 5.0);
      float fine = 1.0 - smoothstep(2.0, 8.0, fpKm);
      cityI *= mix(1.0, mix(0.3, 1.6, nz), fine * (1.0 - smoothstep(0.55, 1.0, v) * 0.7));
      vec3 cityC = mix(uCitySub, uCityCore, smoothstep(0.45, 0.95, v));
      // long slant paths through the air: dimmer and redder toward the horizon
      float airmass = 1.0 / nv;
      cityC *= exp(-(airmass - 1.0) * uCityExt);
      color += cityC * cityI * cityOn * (1.0 - ${CITY_LIGHTS.cloudBlock.toFixed(2)} * cover);
    }
  }

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
  /** Hi-res DEM tiles installed / total (tiles are fetched lazily near the station). */
  hiTiles: { loaded: number; total: number };
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
  /** Moon direction in world and object space, and its illuminance (see FrameState.moon). */
  setMoon(dirWorld: THREE.Vector3, dirObject: THREE.Vector3, illum: number): void;
  /** Simulation clock, seconds — kept in sync with the cloud shell's drift. */
  setTime(seconds: number): void;
  /** Simulation date (epoch ms): drives the sea-ice season. */
  setDate(epochMs: number): void;
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
  const seaIceTexture = buildSeaIceTexture();
  // Until bath.webp has decoded, a 1x1 stand-in (uBathReady = 0 keeps the
  // shallow-water / lake colours off); then the real texture, faded in.
  let bathTexture: THREE.Texture = buildDummyBathTexture();
  let bathFadeStart = -1; // performance.now() when bath.webp arrived
  let disposed = false;

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

  // --- Hi-res DEM tiles (lazy) ------------------------------------------
  // 0 = not requested, 1 = loading, 2 = installed, 3 = gave up (coarse DEM used).
  const tileState = new Uint8Array(HI_TILE_COLS * HI_TILE_ROWS);
  const tileTries = new Uint8Array(HI_TILE_COLS * HI_TILE_ROWS);
  let tilesLoading = 0;
  let hiMain: HiDem | null = null; // main-thread fallback only
  const useMainThreadHi = () => (hiMain ??= createHiDem());

  function loadTile(idx: number): void {
    const url = TILE_URLS[idx];
    if (!url || !HI_RES) {
      tileState[idx] = 3;
      return;
    }
    tileState[idx] = 1;
    tilesLoading++;
    loadRaster(url)
      .then((r) => {
        const data = extractChannel(r, 0).data as Uint8Array;
        const col = idx % HI_TILE_COLS;
        const row = Math.floor(idx / HI_TILE_COLS);
        if (disposed) return;
        if (worker) {
          const msg: TerrainWorkerRequest = { type: 'tile', col, row, data };
          worker.postMessage(msg, [data.buffer]);
        } else {
          installHiTile(useMainThreadHi(), col, row, data);
        }
        tileState[idx] = 2;
      })
      .catch(() => {
        tileTries[idx]++;
        if (tileTries[idx] < 3) {
          setTimeout(() => {
            if (!disposed && tileState[idx] === 1) tileState[idx] = 0;
          }, 1500 * tileTries[idx]);
        } else tileState[idx] = 3;
      })
      .finally(() => {
        tilesLoading--;
      });
  }

  // Tiles that must be resolved (installed or given up) before a seed chunk
  // is built; computed once per seed from its centre.
  const seedTiles = new Map<number, number[]>();
  function tilesForSeed(seed: SeedChunk): number[] {
    let t = seedTiles.get(seed.index);
    if (t) return t;
    const [cx, cy, cz] = seed.center;
    const lat = (Math.asin(THREE.MathUtils.clamp(cy, -1, 1)) * 180) / Math.PI;
    const lon = (Math.atan2(-cz, cx) * 180) / Math.PI;
    const latLo = Math.max(-90, lat - TILE_PAD_DEG);
    const latHi = Math.min(90, lat + TILE_PAD_DEG);
    const cosLat = Math.cos((Math.min(89, Math.max(Math.abs(latLo), Math.abs(latHi))) * Math.PI) / 180);
    const lonPad = TILE_PAD_DEG / Math.max(cosLat, 0.02);
    const rowOf = (la: number) => Math.min(HI_TILE_ROWS - 1, Math.max(0, Math.floor(((90 - la) / 180) * HI_TILE_ROWS)));
    t = [];
    const r0 = rowOf(latHi);
    const r1 = rowOf(latLo);
    const cols: number[] = [];
    if (lonPad >= 180) for (let c = 0; c < HI_TILE_COLS; c++) cols.push(c);
    else {
      const c0 = Math.floor(((lon - lonPad + 180) / 360) * HI_TILE_COLS);
      const c1 = Math.floor(((lon + lonPad + 180) / 360) * HI_TILE_COLS);
      for (let c = c0; c <= c1; c++) cols.push(((c % HI_TILE_COLS) + HI_TILE_COLS) % HI_TILE_COLS);
    }
    for (let r = r0; r <= r1; r++) for (const c of cols) if (!t.includes(r * HI_TILE_COLS + c)) t.push(r * HI_TILE_COLS + c);
    seedTiles.set(seed.index, t);
    return t;
  }

  // Bathymetry / lake texture: small, loaded once at start.
  loadBathTexture(bathUrl)
    .then((tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      bathTexture.dispose();
      bathTexture = tex;
      material.uniforms.uBathTex.value = tex;
      bathFadeStart = performance.now();
    })
    .catch(() => {
      /* no shallow-water / lake colours; everything else works */
    });

  // City lights (NASA Black Marble): a 1x1 black texture until the image arrives.
  let cityTexture: THREE.Texture = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  cityTexture.needsUpdate = true;
  loadR8Texture(cityUrl)
    .then((tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      cityTexture.dispose();
      cityTexture = tex;
      material.uniforms.uCityTex.value = tex;
    })
    .catch(() => {
      /* no city lights; everything else works */
    });

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
      uBathTex: { value: bathTexture as THREE.Texture },
      uSeaIceTex: { value: seaIceTexture },
      uBathReady: { value: 0 },
      uSeason: { value: 0 },
      uSnowOn: { value: HI_RES ? 1 : 0 },
      uTurquoise: { value: SURFACE.turquoise },
      uLake: { value: SURFACE.lake },
      uSnow: { value: SURFACE.snow },
      uSeaIce: { value: SURFACE.seaIce },
      uGlintColor: { value: GLINT.color },
      uWarmLit: { value: RELIEF.warmLit },
      uCoolShadow: { value: RELIEF.coolShadow },
      uSkyAmbient: { value: RELIEF.skyAmbient },
      uHazeCool: { value: RELIEF.hazeCool },
      uHazeWarm: { value: RELIEF.hazeWarm },
      uCityTex: { value: cityTexture as THREE.Texture },
      uCity: {
        value: new THREE.Vector4(
          Math.sin((CITY_LIGHTS.fullDeg * Math.PI) / 180),
          Math.sin((CITY_LIGHTS.offDeg * Math.PI) / 180),
          CITY_LIGHTS.gamma,
          CITY_LIGHTS.gain,
        ),
      },
      uCitySub: { value: CITY_LIGHTS.suburb },
      uCityCore: { value: CITY_LIGHTS.core },
      uCityExt: { value: CITY_LIGHTS.extinction },
      uMoonWorld: { value: new THREE.Vector4(1, 0, 0, 0) },
      uMoonObj: { value: new THREE.Vector3(1, 0, 0) },
      uMoonSurface: { value: MOONLIGHT.surface.clone().multiplyScalar(MOONLIGHT.surfaceGain) },
      uMoonGlint: { value: MOONLIGHT.glint.clone().multiplyScalar(MOONLIGHT.glintGain) },
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
    const c = buildTerrainChunk(seed.corners, SEED_LEVEL, level, EARTH_RADIUS_KM, heightRaster!, landRaster, snapBorder, hiMain ?? undefined);
    recordBuild(level, performance.now() - t0);
    install(seed.index, level, c);
  }

  // The first time the station's position is known, start fetching every tile
  // the initial view needs, without waiting for the coarse DEM (which gates
  // chunk builds): the tiles then usually arrive before the first chunk is due.
  let prefetched = false;
  function prefetchTiles(subDirObj: THREE.Vector3): void {
    prefetched = true;
    for (const seed of seeds) {
      const [cx, cy, cz] = seed.center;
      const d = Math.acos(THREE.MathUtils.clamp(cx * subDirObj.x + cy * subDirObj.y + cz * subDirObj.z, -1, 1)) * EARTH_RADIUS_KM;
      if (d > DETAIL_ENTER_KM) continue;
      for (const ti of tilesForSeed(seed)) if (tileState[ti] === 0) loadTile(ti);
    }
  }

  function updateLOD(subDirObj: THREE.Vector3): void {
    if (!prefetched) prefetchTiles(subDirObj);
    if (bathFadeStart >= 0) {
      const t = Math.min(1, (performance.now() - bathFadeStart) / BATH_FADE_MS);
      material.uniforms.uBathReady.value = t * t * (3 - 2 * t);
      if (t >= 1) bathFadeStart = -2; // done
    }
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
    let posted = 0;
    for (let i = 0; i < toBuild.length && posted < cap; i++) {
      // Build only once the hi-res DEM covering the chunk has arrived (or
      // been given up on): tiles are fetched nearest-chunk-first.
      let ready = true;
      for (const ti of tilesForSeed(toBuild[i].seed)) {
        if (tileState[ti] === 0 && tilesLoading < MAX_TILE_LOADS) loadTile(ti);
        if (tileState[ti] < 2) ready = false;
      }
      if (!ready) continue;
      requestBuild(toBuild[i].seed, toBuild[i].level);
      posted++;
    }
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
    setMoon(dirWorld: THREE.Vector3, dirObject: THREE.Vector3, illum: number) {
      (material.uniforms.uMoonWorld.value as THREE.Vector4).set(dirWorld.x, dirWorld.y, dirWorld.z, moonlightLevel(illum));
      (material.uniforms.uMoonObj.value as THREE.Vector3).copy(dirObject);
    },
    setTime(seconds: number) {
      material.uniforms.uTime.value = seconds;
    },
    setDate(epochMs: number) {
      const y = new Date(epochMs).getUTCFullYear();
      const t0 = Date.UTC(y, 0, 1);
      material.uniforms.uSeason.value = (epochMs - t0) / (Date.UTC(y + 1, 0, 1) - t0);
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
        hiTiles: { loaded: tileState.filter((v) => v === 2).length, total: tileState.length },
        worker: worker !== null,
      };
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      coarseGeometry.dispose();
      for (const entry of detailCache.values()) entry.geometry.dispose();
      material.dispose();
      landTexture.dispose();
      biomeTexture.dispose();
      seaIceTexture.dispose();
      bathTexture.dispose();
      cityTexture.dispose();
    },
  };
}
