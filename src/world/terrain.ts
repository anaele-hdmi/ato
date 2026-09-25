// Terrain: a flat radial grid, displaced in the vertex shader by the baked heightmap.
// Roads, fields and paving are painted in the fragment shader from the road texture.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { CLIFF_FN, COMMON, ROADS_FN, TERRAIN_FN } from '../render/glsl';
import { PHOTO_FN } from '../render/photo-tex';
import { CLIFF_FLOOR } from './cliff-shape';
import { BLOCK_U, BLOCK_V, GRID_ANGLE, GRID_OFFSET, VOID_HALF } from './layout';

export const GRID_DEFINES = {
  GRID_ANGLE: GRID_ANGLE.toFixed(5),
  BLOCK_U: BLOCK_U.toFixed(1),
  BLOCK_V: BLOCK_V.toFixed(1),
  GRID_OFF_U: GRID_OFFSET[0].toFixed(2),
  GRID_OFF_V: GRID_OFFSET[1].toFixed(2),
  VOID_HALF: VOID_HALF.toFixed(2),
};

export const GRID_FN = /* glsl */ `
vec2 toGrid(vec2 p) {
  float c = cos(GRID_ANGLE), s = sin(GRID_ANGLE);
  return vec2(p.x * c + p.y * s + GRID_OFF_U, -p.x * s + p.y * c + GRID_OFF_V);
}
// Distance to the nearest city street centreline.
float gridStreetDist(vec2 p) {
  vec2 g = toGrid(p);
  vec2 m = abs(mod(g + vec2(BLOCK_U, BLOCK_V) * 0.5, vec2(BLOCK_U, BLOCK_V)) - vec2(BLOCK_U, BLOCK_V) * 0.5);
  return min(m.x, m.y);
}
float voidMask(vec2 p) {
  vec2 a = abs(toGrid(p) - vec2(GRID_OFF_U, GRID_OFF_V));
  return 1.0 - smoothstep(VOID_HALF - 1.0, VOID_HALF, max(a.x, a.y));
}
float plinthHeight(vec2 p) {
  vec2 a = abs(p - vec2(0.0, 0.4));
  float m = (1.0 - smoothstep(4.6, 5.6, a.x)) * (1.0 - smoothstep(3.8, 4.8, a.y));
  float on = step(2104.0, uYear) * (1.0 - smoothstep(3.4, 3.9, uL));
  return m * on * 0.32;
}
`;

function radialGeometry(rings: number, segs: number, a: number, k: number): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  for (let i = 1; i <= rings; i++) {
    const r = a * (Math.exp(k * i) - 1);
    for (let j = 0; j < segs; j++) {
      // Stagger alternate rings so triangles stay well shaped.
      const ang = ((j + (i % 2) * 0.5) / segs) * Math.PI * 2;
      pos.push(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i < rings; i++) {
    const r0 = 1 + (i - 1) * segs;
    const r1 = 1 + i * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      if (i % 2 === 1) {
        idx.push(r0 + j, r0 + j1, r1 + j);
        idx.push(r0 + j1, r1 + j1, r1 + j);
      } else {
        idx.push(r0 + j, r1 + j1, r1 + j);
        idx.push(r0 + j, r0 + j1, r1 + j1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${GRID_FN}
${CLIFF_FN}
varying vec3 vWorld;
varying vec4 vRaw;
void main() {
  vec2 xz = position.xz;
  vec4 s = terrainRaw(xz);
  float h = heightOf(s) + plinthHeight(xz);
  // the sea-cut cliff at the very end: the ground beyond the rock face drops to the
  // carved sea floor so the face stands clear of it (see world/cliff.ts)
  h -= uCliff * ${CLIFF_FLOOR.toFixed(3)} * cliffCarve(xz);
  vRaw = s;
  vWorld = vec3(xz.x, h, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const frag = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${ROADS_FN}
${GRID_FN}
${PHOTO_FN}
varying vec3 vWorld;
varying vec4 vRaw;
uniform sampler2D uTexGrass;
uniform sampler2D uTexGravel;
// a real photograph's grain, at two scales and two rotations so tiles never line up
float photoGrain(sampler2D t, vec2 p, float dist, float s1, float s2) {
  mat2 r1 = mat2(0.8, -0.6, 0.6, 0.8), r2 = mat2(0.28, 0.96, -0.96, 0.28);
  float a = texture2D(t, r1 * p * s1).r;
  float b = texture2D(t, r2 * p * s2 + 0.37).r;
  return mix(a, b, smoothstep(15.0, 160.0, dist)) / 0.45;
}

vec3 roadSurface(float along, vec2 p, float paved, float decayed) {
  float n = vnoise(p * 1.7);
  vec3 dirt = vec3(0.34, 0.28, 0.20) * (0.85 + 0.3 * n);
  vec3 gravel = mix(vec3(0.47, 0.44, 0.39), vec3(0.58, 0.55, 0.49), hash12(floor(p * 9.0)));
  vec3 asphalt = vec3(0.13, 0.13, 0.14) * (0.8 + 0.4 * vnoise(p * 0.35)) + 0.04 * step(0.82, vnoise(p * 0.9));
  vec3 c = mix(dirt, gravel, uGravel);
  c = mix(c, asphalt, paved);
  // cracks and weeds once nobody maintains it
  float crack = smoothstep(0.47, 0.5, vnoise(p * 2.3)) * smoothstep(0.53, 0.5, vnoise(p * 2.3));
  c = mix(c, vec3(0.05), crack * paved * clamp(decayed * 2.0 + uChaos * 0.5, 0.0, 1.0));
  c = mix(c, grassColor(n) * 0.9, smoothstep(0.2, 1.0, decayed) * smoothstep(0.3, 0.7, vnoise(p * 0.8) + decayed * 0.5));
  return c;
}

void main() {
  vec2 p = vWorld.xz;
  vec4 s = vRaw;
  vec3 n = terrainNormal(s);
  if (uDisp > 0.001) {
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (fn.y < 0.0) fn = -fn;
    n = normalize(mix(n, fn, clamp(uDisp * 1.5, 0.0, 0.8)));
  }
  // the carved sea floor bends away sharply near the cliff; the baked heightmap
  // normal doesn't know about that cut, so blend in the real (screen-derivative) one
  if (uCliff > 0.001) {
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (fn.y < 0.0) fn = -fn;
    n = normalize(mix(n, fn, clamp(uCliff * 1.2, 0.0, 0.9)));
  }
  float dist = length(vWorld - cameraPosition);
  // small undulations the heightmap is too coarse to hold: tussocks, old furrows, hollows
  {
    float e = 0.7;
    float m0 = fbm3(p * 0.045), mx = fbm3((p + vec2(e, 0.0)) * 0.045), mz = fbm3((p + vec2(0.0, e)) * 0.045);
    float k = 0.9 * (1.0 - smoothstep(250.0, 1200.0, dist));
    n = normalize(n + vec3(-(mx - m0), 0.0, -(mz - m0)) * k * 5.0);
  }
  vec4 rd = roadRaw(p);
  float urbY = yearN(rd.a);
  float urban = smoothstep(urbY + 1.0, urbY + 6.0, uYear);
  float voidM = voidMask(p);
  float roadGone = smoothstep(2.6, 3.4, uL);
  float decayed = uRoadDecay;

  float macro = fbm3(p * 0.004 + 11.0);
  float var = fbm3(p * 0.045);
  float fine = vnoise(p * 1.3);
  float lush = smoothstep(26.0, 8.0, vWorld.y) * 0.4;
  vec3 grass = grassColor(clamp(macro * 0.8 + var * 0.35 - lush, 0.0, 1.0));
  grass *= 0.78 + 0.3 * macro + 0.12 * (fine - 0.5) + 0.06 * (vnoise(p * 7.0) - 0.5) * (1.0 - smoothstep(20.0, 60.0, dist));
  // clumps of darker growth, patches of clover and bare
  // a meadow is a patchwork: clover, tussock, sorrel, dry grass
  grass = mix(grass, grass * vec3(0.66, 0.78, 0.7), smoothstep(0.5, 0.8, fbm3(p * 0.07 + 4.0)) * 0.6);
  grass = mix(grass, grass * vec3(1.25, 1.12, 0.82), smoothstep(0.55, 0.8, fbm3(p * 0.03 + 9.0)) * 0.5);
  if (uPhoto > 0.5) {
    mat2 r1 = mat2(0.8, -0.6, 0.6, 0.8), r2 = mat2(0.28, 0.96, -0.96, 0.28);
    vec3 d1 = photoDetail(uTexMeadow, uMeanMeadow, r1 * p / 2.4, 0.5);
    vec3 d2 = photoDetail(uTexMeadow2, uMeanMeadow2, r2 * p / 3.3 + 0.37, 0.5);
    vec3 dm = photoDetail(uTexMacro, uMeanMacro, p / 41.0, 0.25);
    float mixA = smoothstep(0.35, 0.65, vnoise(p * 0.03));
    vec3 near = mix(d1, d2, mixA);
    float far = smoothstep(30.0, 400.0, dist);
    vec3 dd = mix(near, vec3(1.0), far * 0.6) * mix(vec3(1.0), dm, 0.35 + 0.4 * far);
    grass *= mix(vec3(1.0), dd, 0.9 * (1.0 - smoothstep(1500.0, 5000.0, dist)));
  }
  // wind running over the meadow as travelling bands of light
  float gustBand = sin(dot(p, uWindDir) * 0.09 - uTime * 1.3 + vnoise(p * 0.02) * 4.0);
  grass *= 1.0 + 0.09 * uWind * gustBand * (1.0 - urban) * (1.0 - smoothstep(150.0, 600.0, dist));
  // photographic grain of real ground when close: tufts, bare specks
  float near = 1.0 - smoothstep(15.0, 90.0, dist);
  grass *= 1.0 + near * (0.14 * (vnoise(p * 3.3) - 0.5) + 0.1 * (vnoise(p * 12.0) - 0.5));
  grass = mix(grass, vec3(0.3, 0.26, 0.2), near * smoothstep(0.78, 0.9, vnoise(p * 2.1 + 9.0)) * 0.5);
  // wet spring morning ground
  grass *= 1.0 - 0.18 * uMist;
  vec3 col = grass;

  // steep slopes show soil
  float steep = smoothstep(0.82, 0.62, n.y);
  col = mix(col, vec3(0.33, 0.28, 0.22) * (0.8 + 0.4 * fine), steep);

  // fields: parcels on gentle ground, before the city arrives
  float fieldZone = smoothstep(0.56, 0.64, fbm3(p / 220.0 + 3.1)) * (1.0 - steep) * uFields
    * (1.0 - urban) * smoothstep(40.0, 70.0, length(p)) * smoothstep(3.0, 9.0, min(rd.r, rd.g));
  if (fieldZone > 0.001) {
    // parcels follow a slightly skewed local grid of their own
    float rot = (vnoise(p / 700.0) - 0.5) * 1.2;
    vec2 pr = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * p;
    vec2 psz = vec2(58.0, 31.0);
    vec2 cellId = floor(pr / psz);
    float h = hash12(cellId);
    float ang = h * 3.14159;
    vec2 dir = vec2(cos(ang), sin(ang));
    float rows = 0.75 + 0.25 * sin(dot(p, dir) * 3.3);
    float sn = uSeason;
    vec3 soil = vec3(0.24, 0.18, 0.12);
    vec3 young = vec3(0.2, 0.3, 0.09);
    vec3 ripe = mix(vec3(0.5, 0.42, 0.19), vec3(0.18, 0.28, 0.08), step(0.5, h));
    vec3 fc = mix(soil, young, smoothstep(0.25, 0.4, sn) * rows);
    fc = mix(fc, ripe, smoothstep(0.45, 0.62, sn) * (1.0 - smoothstep(0.78, 0.86, sn)));
    fc = mix(fc, soil * 1.1, smoothstep(0.8, 0.9, sn));
    fc = mix(vec3(0.22, 0.28, 0.11), fc, uSeasonality);
    vec2 cf = abs(fract(pr / psz) - 0.5) * psz;
    float edge = smoothstep(psz.x * 0.5 - 1.6, psz.x * 0.5 - 0.8, cf.x) + smoothstep(psz.y * 0.5 - 1.6, psz.y * 0.5 - 0.8, cf.y);
    edge = 1.0 - clamp(edge, 0.0, 1.0);
    if (uPhoto > 0.5) fc *= mix(vec3(1.0), photoDetail(uTexSoil, uMeanSoil, (vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)))) / 3.2, 0.4), 0.7);
    col = mix(col, fc * (0.9 + 0.2 * h), fieldZone * step(0.35, h) * edge);
  }

  // city ground: paving, stains, sidewalk
  vec3 pave = vec3(0.40, 0.39, 0.37) * (0.85 + 0.25 * var) - 0.05 * step(0.7, vnoise(p * 0.2));
  float grow = smoothstep(0.1, 0.9, decayed + 0.4 * (fine - 0.5)) + roadGone;
  pave = mix(pave, grassColor(var) * 0.85, clamp(grow, 0.0, 1.0));
  float urbanGround = urban * (1.0 - voidM) * (1.0 - roadGone);
  col = mix(col, pave, urbanGround);
  // the kitchen garden behind the house, dug each spring while someone lives there
  {
    vec2 gq = p - vec2(-2.0, -8.5);
    float plot = (1.0 - smoothstep(4.2, 4.5, abs(gq.x))) * (1.0 - smoothstep(2.6, 2.9, abs(gq.y)));
    float lived = smoothstep(1882.0, 1884.0, uYear) * (1.0 - smoothstep(2060.0, 2075.0, uYear));
    float furrow = 0.5 + 0.5 * sin(gq.x * 5.2);
    vec3 soil = vec3(0.26, 0.2, 0.14) * (0.8 + 0.35 * furrow);
    if (uPhoto > 0.5) soil = vec3(0.24, 0.18, 0.12) * photoDetail(uTexSoil, uMeanSoil, gq.yx / 3.2, 0.6);
    vec3 crop = mix(soil, grassColor(0.2) * 1.1, smoothstep(0.3, 0.45, uSeason) * (1.0 - smoothstep(0.75, 0.85, uSeason)) * furrow);
    col = mix(col, crop, plot * lived);
  }
  // the square: packed earth and weeds while everything around is paved
  vec3 bare = mix(vec3(0.36, 0.31, 0.24), grass, 0.35 + 0.4 * fine);
  float squareEra = smoothstep(2100.0, 2108.0, uYear) * (1.0 - smoothstep(2.4, 3.2, uL));
  col = mix(col, bare, voidM * squareEra * (0.6 + 0.4 * urban));

  // roads
  float lanePaved = smoothstep(1962.0, 1972.0, uYear);
  float mainW = mix(2.2, 4.2, uGravel);
  mainW = mix(mainW, 7.0, uPaved);
  mainW = mix(mainW, 12.5, uAvenue);
  // the track itself is worn in by the first settlers
  float mainRoad = (1.0 - smoothstep(mainW * 0.5 - 0.3, mainW * 0.5 + 0.3, rd.r)) * smoothstep(1840.0, 1870.0, uYear);
  float laneOn = smoothstep(yearN(rd.b), yearN(rd.b) + 3.0, uYear);
  float laneW = mix(1.8, 3.6, uGravel) + 1.6 * lanePaved + 3.0 * urban;
  float lane = (1.0 - smoothstep(laneW * 0.5 - 0.3, laneW * 0.5 + 0.3, rd.g)) * laneOn;
  float streetW = mix(7.0, 11.0, uAvenue);
  float street = (1.0 - smoothstep(streetW * 0.5 - 0.3, streetW * 0.5 + 0.3, gridStreetDist(p))) * urban * (1.0 - voidM);
  float onRoad = max(mainRoad, max(lane, street)) * (1.0 - roadGone);
  // early track: two ruts in pale grass
  float rut = (1.0 - uGravel) * (1.0 - smoothstep(0.12, 0.3, abs(rd.r - 0.75))) * mainRoad;
  vec3 track = mix(roadSurface(rd.r, p, max(uPaved, max(lanePaved * lane, street)), decayed), grass * 0.8, (1.0 - uGravel) * 0.55);
  track = mix(track, vec3(0.27, 0.22, 0.16), rut * 0.8);
  if (uPhoto > 0.5) track *= mix(vec3(1.0), photoDetail(uTexTrack, uMeanTrack, p / 2.0, 0.6), 0.85 * (1.0 - smoothstep(600.0, 3000.0, dist)));
  // sidewalks along the avenue
  float kerb = smoothstep(mainW * 0.5, mainW * 0.5 + 0.2, rd.r) * (1.0 - smoothstep(mainW * 0.5 + 2.6, mainW * 0.5 + 2.8, rd.r)) * uAvenue * (1.0 - roadGone);
  col = mix(col, vec3(0.48, 0.47, 0.44) * (0.9 + 0.2 * fine), kerb * (1.0 - grow * 0.8));
  // faint centre dashes, uneven like real paint
  float dash = step(0.5, fract(dot(p, vec2(0.7, 0.3)) / 6.0)) * (1.0 - smoothstep(0.08, 0.14, rd.r)) * uPaved * (1.0 - decayed);
  track = mix(track, vec3(0.62, 0.6, 0.5), dash * 0.5);
  col = mix(col, track, onRoad);

  // snow, ice
  // ice comes and goes in patches, lingering in hollows and on the north faces
  float icePatch = smoothstep(0.42, 0.58, fbm3(p * 0.006) + (uGlacial - 0.5) * 1.1 - n.z * 0.15);
  float snow = max(snowCover() - uGlacial, 0.0) + uGlacial * icePatch;
  snow *= smoothstep(0.35, 0.65, n.y + fine * 0.2) * (1.0 - onRoad * uPaved * 0.7);
  col = mix(col, vec3(0.86, 0.88, 0.9), snow);

  // shore sand and wet ground near the sea
  float above = vWorld.y - uSeaLevel;
  col = mix(col, vec3(0.62, 0.57, 0.46), (1.0 - smoothstep(0.5, 2.5, above)) * (1.0 - snow));
  col *= mix(0.55, 1.0, smoothstep(-0.2, 0.3, above));

  float sh = sampleShadow(vWorld, n);
  vec3 lit = shade(col, n, vWorld, 0.1, sh);

  // standing water in the ruts after rain: the pale sky caught in the mud,
  // the thing that makes a dull morning read as a photograph
  float wet = uMist * (1.0 - uGravel) * mainRoad * (1.0 - roadGone);
  float pud = wet * smoothstep(0.62, 0.72, vnoise(p * 0.5 + 17.0)) * (1.0 - smoothstep(0.1, 0.45, abs(rd.r - 0.75)));
  if (pud > 0.001) {
    vec3 v = normalize(cameraPosition - vWorld);
    float fres = 0.35 + 0.65 * pow(1.0 - max(v.y, 0.0), 3.0);
    vec3 sky = uFogColor * 1.15 + vec3(0.02);
    lit = mix(lit, mix(lit * 0.6, sky, fres * 0.6), pud);
  }

  // street light: pools along roads, never inside the square
  float lightsOn = urban * uNight * (1.0 - smoothstep(2318.0, 2340.0, uYear)) * (1.0 - voidM);
  // lamps every ~30 m along streets
  vec2 g = toGrid(p);
  float lampU = abs(fract(g.x / 28.0) - 0.5) * 28.0, lampV = abs(fract(g.y / 28.0) - 0.5) * 28.0;
  float pools = exp(-min(lampU, lampV) * min(lampU, lampV) / 40.0) * 0.8 + 0.2;
  float nearRoad = 1.0 - smoothstep(1.0, 9.0, min(min(rd.r, rd.g), gridStreetDist(p)));
  float flicker = 1.0 - uChaos * step(0.55, vnoise(p * 0.02 + floor(uTime * 0.3)));
  lit += vec3(1.0, 0.62, 0.3) * 0.16 * lightsOn * nearRoad * pools * flicker;
  lit += vec3(0.9, 0.55, 0.3) * 0.006 * lightsOn * (1.0 - voidM);

  gl_FragColor = finalOut(applyFog(lit, vWorld));
}
`;

export class Terrain {
  readonly mesh: THREE.Mesh;

  constructor() {
    const geo = radialGeometry(150, 256, 6.1, 0.057);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: vert,
      fragmentShader: frag,
      defines: GRID_DEFINES,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }
}
