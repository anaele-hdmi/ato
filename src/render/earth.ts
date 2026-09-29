// The Earth: a two-layer LOD faceted-relief icosphere (client reference
// direction, superseding the flat posterized-band rule in docs/art-direction.md).
//
// Layer 1 (always resident): one merged, coarse (level ~6) undisplaced sphere,
// inset 0.5 km below the true radius so it never z-fights layer 2.
// Layer 2 (streamed): level-3 icosahedron "seed" chunks (1280 of them, stable
// indices) built up to a fine sub-grid (default level 9, ~4096 tri each,
// ?detail=8 for ~1024 tri each on weaker phones) on demand for whatever is
// within ~horizon distance of the sub-station point, cached and streamed in a
// few chunks/frame (see updateLOD). Detail chunks carry a skirt (border ring
// dropped a few km, undisplaced) to hide seams against the coarse layer.
//
// The vertex shader displaces land vertices radially using a heightmap
// (base DEM value) plus a procedural ridged/rolling micro-relief noise, so
// every triangle facet catches light a little differently even off the named
// ranges. The fragment shader derives a flat per-triangle normal from
// screen-space derivatives of the displaced world position
// (normalize(cross(dFdx(p), dFdy(p)))) -- that's what produces the faceted,
// sunlit-gold / shadow-teal mountain look. Lon/lat sampling always comes from
// the *undisplaced* object-space direction (normalize(position)) so the land
// mask / biome / cloud-shadow lookups stay correct regardless of LOD or
// displacement.
import * as THREE from 'three';
import { EARTH_COLORS, BIOMES, GLINT, RELIEF } from './palette';
import { buildLandMask, buildBiomeTexture } from './landmask';
import { elevationKm, loadRaster, type Raster } from './terrain';
import { CLOUD_MAP_GLSL, type CloudMapUniforms } from './cloudMap';
import { buildSeedChunks, buildChunkMesh, buildMergedCoarseSphere, type SeedChunk } from './icosphere';
import { EARTH_RADIUS_KM } from '../types';
import { CLOUD_GLSL } from './clouds';
import topoUrl from '../assets/earth-topology.png';


// --- LOD tuning ---------------------------------------------------------
const SEED_LEVEL = 3; // 20 * 4^3 = 1280 seed chunks, stable indices
const COARSE_EXTRA_LEVELS = 2; // seed(3) + 2 = level 5 full sphere (20k tris), always resident, behind the horizon
const COARSE_INSET_KM = 0.5; // below true radius, so layer 2 is never z-fought
// Detail chunks share identical edge vertices (same subdivision, same CPU
// displacement), so no skirts are needed between them; the coarse layer only
// shows beyond the horizon.
const SKIRT_DROP_KM = 0;
// From 420 km orbit, horizon distance is ~2300 km; add margin for tall
// exaggerated peaks poking over it. Hysteresis avoids flicker at the boundary.
const DETAIL_ENTER_KM = 3300;
const DETAIL_EXIT_KM = 3700;
const BUILD_BUDGET_PER_FRAME = 6;

function readDetailLevel(): number {
  try {
    const v = new URLSearchParams(location.search).get('detail');
    if (v === '9') return 9;
    if (v === '7') return 7;
  } catch {
    /* location unavailable (non-browser); default */
  }
  // Level 8 (~9 km facets, ~1k triangles per chunk) is the default for
  // mobile; ?detail=9 quadruples the triangle count for strong GPUs.
  return 8;
}
const DETAIL_LEVEL = readDetailLevel();
const DETAIL_EXTRA_LEVELS = DETAIL_LEVEL - SEED_LEVEL;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormalObj;
varying vec3 vWorldPosition;

// Positions arrive already displaced (terrain.ts, computed once per chunk).
void main() {
  vNormalObj = normalize(position);
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
varying vec3 vWorldPosition;

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
  vec3 flatN = rawLen > 1e-6 ? rawFlatN / rawLen : n;
  if (dot(flatN, n) < 0.0) flatN = -flatN;

  // per-facet value jitter (stable hash of the flat normal, constant across
  // one triangle) so neighbouring facets read as distinct even on gentle
  // slopes, not just at hard mountain edges.
  float grain = mix(0.82, 1.12, cloudHash(flatN * 97.0 + 3.0));

  vec3 sunW = normalize(uSunDirWorld);
  float ndotl = dot(flatN, sunW);
  // Smooth (per-vertex-normal) day/night term, numerically stable everywhere.
  // NB: must dot against the OBJECT-space sun direction (n is object-space,
  // undoes the Earth's own spin) -- dotting it with the world-space sunW
  // above is a frame mismatch (they drift apart as the planet rotates) and
  // was the actual cause of the jagged pale patch on the night side, not a
  // facet/derivative precision issue as first suspected.
  float ndotlSmooth = dot(n, normalize(uSunDirObj));

  // Split-tone lighting: MIX (not multiply) the base colour toward a cool
  // teal/blue on shadow facets and a warm gold on lit facets, so shadows
  // read as clearly blue even on orange/tan ground instead of muddy brown.
  float wrap = clamp((ndotl + 0.35) / 1.35, 0.0, 1.0);
  vec3 shadeColor = mix(uCoolShadow, base, 0.32) * 0.85;
  vec3 litColor = mix(uWarmLit, base, 0.62) * 1.05;
  vec3 lit = mix(shadeColor, litColor, wrap) * grain;
  vec3 ambient = uSkyAmbient * (1.0 - clamp(ndotl, 0.0, 1.0)) * 0.14;
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

  // cloud shadow: sample the same field the cloud shell uses, offset toward
  // the sun (cheap parallax stand-in for its altitude), darken the ground.
  vec3 shadowN = normalize(n + normalize(uSunDirObj) * 0.004);
  float shadowAmt = smoothstep(0.0, 0.12, cloudMacro(shadowN)) * (1.0 - nightMix);
  color *= mix(1.0, 0.8, shadowAmt);

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
  color = mix(color, hazeColor, haze * 0.3);

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export interface EarthStats {
  coarseTriangles: number;
  detailChunks: number;
  detailTrianglesApprox: number;
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
   *  Call once per frame; builds at most a few chunks per call. */
  updateLOD(subStationDirObject: THREE.Vector3): void;
  getStats(): EarthStats;
  dispose(): void;
}

export function createEarth(cloudMap: CloudMapUniforms): EarthObjects {
  const landMask = buildLandMask();
  const landTexture = landMask.texture;
  const landRaster: Raster = { data: landMask.data, width: landMask.width, height: landMask.height, stride: 4 };
  const biomeTexture = buildBiomeTexture();

  // Heightmap is only needed on the CPU (displacement is baked per chunk).
  let heightRaster: Raster | null = null;
  // Retry: a flaky connection can fail the first decode, which would leave
  // the planet without relief for the whole session.
  const loadHeight = (attempt: number) => {
    loadRaster(topoUrl)
      .then((r) => {
        heightRaster = r;
      })
      .catch(() => {
        if (attempt < 4) setTimeout(() => loadHeight(attempt + 1), 1000 * (attempt + 1));
      });
  };
  loadHeight(0);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.DoubleSide,
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
  coarseGeometry.setIndex(new THREE.BufferAttribute(coarseBuilt.indices, 1));
  coarseGeometry.computeBoundingSphere();
  const coarseMesh = new THREE.Mesh(coarseGeometry, material);
  rotGroup.add(coarseMesh);
  const coarseTriangles = coarseBuilt.indices.length / 3;

  // --- Layer 2: streamed high-detail chunks -------------------------------
  const detailGroup = new THREE.Group();
  rotGroup.add(detailGroup);
  const detailCache = new Map<number, { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }>();
  const trisPerDetailChunk = (2 ** DETAIL_EXTRA_LEVELS) ** 2; // border skirt tris are a small, ignored bonus

  function displace(positions: Float32Array, height: Raster): void {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      const r = Math.hypot(x, y, z);
      const nx = x / r;
      const ny = y / r;
      const nz = z / r;
      const rr = r + elevationKm(height, landRaster, nx, ny, nz);
      positions[i] = nx * rr;
      positions[i + 1] = ny * rr;
      positions[i + 2] = nz * rr;
    }
  }

  function updateLOD(subDirObj: THREE.Vector3): void {
    const height = heightRaster;
    if (!height) return; // coarse sphere only until the heightmap has loaded
    const toBuild: { seed: SeedChunk; d: number }[] = [];
    const toRemove: number[] = [];

    for (const seed of seeds) {
      const [cx, cy, cz] = seed.center;
      const dot = cx * subDirObj.x + cy * subDirObj.y + cz * subDirObj.z;
      const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      const d = angle * EARTH_RADIUS_KM;
      const built = detailCache.has(seed.index);
      if (built) {
        if (d > DETAIL_EXIT_KM) toRemove.push(seed.index);
      } else if (d < DETAIL_ENTER_KM) {
        toBuild.push({ seed, d });
      }
    }

    for (const idx of toRemove) {
      const entry = detailCache.get(idx);
      if (!entry) continue;
      detailGroup.remove(entry.mesh);
      entry.geometry.dispose();
      detailCache.delete(idx);
    }

    toBuild.sort((a, b) => a.d - b.d);
    const budget = Math.min(BUILD_BUDGET_PER_FRAME, toBuild.length);
    for (let i = 0; i < budget; i++) {
      const seed = toBuild[i].seed;
      const built = buildChunkMesh(seed, DETAIL_EXTRA_LEVELS, EARTH_RADIUS_KM, SKIRT_DROP_KM);
      displace(built.positions, height);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(built.indices as Uint16Array, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      detailGroup.add(mesh);
      detailCache.set(seed.index, { mesh, geometry });
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
    setTime(seconds: number) {
      material.uniforms.uTime.value = seconds;
    },
    updateLOD,
    getStats(): EarthStats {
      return {
        coarseTriangles,
        detailChunks: detailCache.size,
        detailTrianglesApprox: detailCache.size * trisPerDetailChunk,
      };
    },
    dispose() {
      coarseGeometry.dispose();
      for (const entry of detailCache.values()) entry.geometry.dispose();
      material.dispose();
      landTexture.dispose();
      biomeTexture.dispose();
    },
  };
}
