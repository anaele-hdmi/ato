// Interior window frames. Everything is centred on the eye, in the station's
// LVLH frame (x right, y forward, z up), and drawn in three calls:
//   wall  - a dark sphere (3 m) that closes every gap behind the frames, with
//           holes cut analytically where the windows are;
//   frame - real geometry (chamfered lips, a recessed glass seat, window
//           posts, bolts, handrails) built with windowFrame.ts;
//   glass - the panes: nearly clear, faint Fresnel reflection.
// Light is analytic (no shadow maps): ambient + earthshine + the Sun, which
// only reaches a surface if the ray toward it leaves through a window. AO is
// baked per vertex (profile steps).
import * as THREE from 'three';
import { CABIN, DOF, SUN } from './palette';
import { circleLoop, fillPolygon, offsetSamples, sweepFrame, type LoopPt, type Mapper, type ProfileStep } from './windowFrame';
import { urlWantsDof } from './post';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type CabinMode = 'cupola' | 'aft' | 'limb' | 'zenith';
const MODE_INDEX: Record<CabinMode, number> = { cupola: 0, aft: 1, limb: 2, zenith: 3 };

const DEG = Math.PI / 180;
const M = 0.001; // km per metre
/** radii (km) of the layers, all around the eye */
const R_WALL = 3.0 * M;
const R_GLASS = 2.75 * M;
const R_STEP = 2.3 * M;
const R_LIP = 2.16 * M;
const R_OUTER = 2.55 * M;
/** wall holes are opened this much wider than the glass so the frame covers the seam */
const WALL_HOLE_MARGIN = 1.5 * DEG;
/** ISS altitude: the Sun's centre touches the horizon this far below level */
const HORIZON_DIP_DEG = (Math.acos(6371 / (6371 + 420)) * 180) / Math.PI;

const step = (offDeg: number, h: number, ao: number, tone: number): ProfileStep => ({ off: offDeg * DEG, h, ao, tone });
/** cupola: posts are shared, the lips of neighbours overlap at the post's centre line */
const PROFILE_POST: ProfileStep[] = [
  step(0, R_GLASS, 0.5, 0),
  step(1.2, R_GLASS, 0.6, 0),
  step(1.2, R_STEP, 0.7, 0.5),
  step(2.3, R_LIP, 0.85, 0.9),
  step(2.9, R_LIP, 1, 1.6), // catch-light on the rounded edge
  step(3.6, R_LIP, 1, 1),
  step(4.4, R_LIP, 1, 1),
];
/** single windows: a wider raised plate with a shallow bolt groove, bevelled back to the wall */
const R_GROOVE = 2.32 * M;
const PROFILE_PLATE: ProfileStep[] = [
  ...PROFILE_POST.slice(0, 5),
  step(3.7, R_LIP, 1, 1),
  step(4.5, R_GROOVE, 0.7, 0.9),
  step(6.1, R_GROOVE, 0.8, 0.9),
  step(6.9, R_LIP, 1, 1.3),
  step(8.2, R_LIP, 1, 1),
  step(9.4, R_OUTER, 0.8, 1),
];

// ---- outlines ---------------------------------------------------------------

/** rounded rectangle in (x, y) tangent-angle space, counter-clockwise */
function roundedRect(hw: number, hh: number, corner: number, seg: number): LoopPt[] {
  const out: LoopPt[] = [];
  const centres: [number, number, number][] = [
    [hw - corner, hh - corner, 0],
    [-(hw - corner), hh - corner, 90],
    [-(hw - corner), -(hh - corner), 180],
    [hw - corner, -(hh - corner), 270],
  ];
  for (const [cx, cy, a0] of centres)
    for (let i = 0; i <= seg; i++) {
      const a = (a0 + (i / seg) * 90) * DEG;
      out.push({ x: cx + Math.cos(a) * corner, y: cy + Math.sin(a) * corner });
    }
  return out;
}

/** cupola trapezoid: ring between nadir angles r0..r1, between the two posts around azimuth phi */
function trapezoid(phi: number, r0: number, r1: number, halfPost: number): LoopPt[] {
  // posts are straight lines in the azimuthal-equidistant plane; widen a little
  // so their true angular width matches halfPost at mid radius
  const rm = (r0 + r1) / 2;
  const w = (halfPost * rm) / Math.sin(rm);
  const corner = (side: number, r: number) => {
    const phiE = phi + side * 30 * DEG;
    const t = Math.sqrt(r * r - w * w);
    const ex = Math.cos(phiE);
    const ey = Math.sin(phiE);
    // inward = toward phi
    const nx = side > 0 ? ey : -ey;
    const ny = side > 0 ? -ex : ex;
    const x = ex * t + nx * w;
    const y = ey * t + ny * w;
    return { x, y, a: Math.atan2(y, x) };
  };
  const o0 = corner(-1, r1);
  const o1 = corner(1, r1);
  const i1 = corner(1, r0);
  const i0 = corner(-1, r0);
  const arc = (r: number, a0: number, a1: number, n: number): LoopPt[] => {
    const pts: LoopPt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, corner: i === 0 || i === n });
    }
    return pts;
  };
  // unwrap angles so a0 < a1 around phi
  const un = (a: number) => phi + Math.atan2(Math.sin(a - phi), Math.cos(a - phi));
  return [...arc(r1, un(o0.a), un(o1.a), 6), ...arc(r0, un(i1.a), un(i0.a), 6)];
}

// ---- mappers ----------------------------------------------------------------

/** azimuthal-equidistant plane about +-Z (nadir for sign = -1, zenith for +1) */
function equidistant(sign: number): Mapper {
  return (x, y, h) => {
    const rho = Math.hypot(x, y);
    const s = rho > 1e-9 ? Math.sin(rho) / rho : 1;
    return new THREE.Vector3(x * s, y * s, sign * Math.cos(rho)).multiplyScalar(h);
  };
}

/** tangent-angle plane facing n: x, y are atan of the offsets along u and v */
function tangentPlane(n: THREE.Vector3): Mapper {
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return (x, y, h) => u.clone().multiplyScalar(Math.tan(x)).addScaledVector(v, Math.tan(y)).add(n).normalize().multiplyScalar(h);
}

// ---- geometry per view --------------------------------------------------------

interface WindowSpec {
  loop: LoopPt[];
  map: Mapper;
  profile: ProfileStep[];
  /** eye-facing axis of the pane (for the Fresnel term) */
  axis: THREE.Vector3;
  /** bolt row: offset and spacing along the outline */
  boltOff: number;
  boltSpacing: number;
}

const ORIGIN = new THREE.Vector3();

function windowsFor(mode: CabinMode): WindowSpec[] {
  const list: WindowSpec[] = [];
  if (mode === 'cupola') {
    const map = equidistant(-1);
    list.push({ loop: circleLoop(34 * DEG, 56), map, profile: PROFILE_POST, axis: new THREE.Vector3(0, 0, 1), boltOff: 2.5 * DEG, boltSpacing: 11 * DEG });
    for (let k = 0; k < 6; k++) {
      const phi = k * 60 * DEG;
      const rc = 54 * DEG;
      const axis = new THREE.Vector3(-Math.sin(rc) * Math.cos(phi), -Math.sin(rc) * Math.sin(phi), Math.cos(rc));
      list.push({ loop: trapezoid(phi, 40 * DEG, 68 * DEG, 3 * DEG), map, profile: PROFILE_POST, axis, boltOff: 2.5 * DEG, boltSpacing: 13 * DEG });
    }
  } else if (mode === 'zenith') {
    list.push({ loop: circleLoop(32 * DEG, 56), map: equidistant(1), profile: PROFILE_PLATE, axis: new THREE.Vector3(0, 0, -1), boltOff: 5.3 * DEG, boltSpacing: 11 * DEG });
  } else {
    const t = (mode === 'aft' ? 76 : 70) * DEG;
    const n = new THREE.Vector3(0, mode === 'aft' ? -Math.sin(t) : Math.sin(t), -Math.cos(t));
    list.push({ loop: roundedRect(42 * DEG, 24 * DEG, 8 * DEG, 5), map: tangentPlane(n), profile: PROFILE_PLATE, axis: n.clone().negate(), boltOff: 5.3 * DEG, boltSpacing: 12 * DEG });
  }
  return list;
}

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

function withMat(g: THREE.BufferGeometry, ao: number, tone: number): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = ao;
    a[i * 3 + 1] = tone;
    a[i * 3 + 2] = 9; // far from any opening: no defocus fade
  }
  g.setAttribute('aMat', new THREE.BufferAttribute(a, 3));
  return g;
}

/** small pyramid bolt head on the lip, apex toward the eye */
function bolt(at: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.03 * M, 0.018 * M, 5, 1, true);
  _q.setFromUnitVectors(_up, at.clone().normalize().negate());
  g.applyMatrix4(new THREE.Matrix4().compose(at, _q, new THREE.Vector3(1, 1, 1)));
  return withMat(g, 1, 1.5);
}

/** straight rod between two points */
function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(radius, radius, len, 6, 1, false);
  _q.setFromUnitVectors(_up, b.clone().sub(a).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1)));
  return withMat(g, 1, 0.7);
}

interface ModeGeometry {
  frame: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
}

function buildMode(mode: CabinMode): ModeGeometry {
  const frame: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  for (const w of windowsFor(mode)) {
    frame.push(sweepFrame(w.loop, w.profile, w.map, ORIGIN));
    glass.push(fillPolygon(w.loop, w.map, R_GLASS, w.axis));
    for (const p of offsetSamples(w.loop, w.boltOff, w.boltSpacing)) frame.push(bolt(w.map(p.x, p.y, (mode === 'cupola' ? R_LIP : R_GROOVE) + 0.004 * M)));
  }
  if (mode === 'aft' || mode === 'limb') {
    // two handrails on the wall above and below the window, on standoffs
    const t = (mode === 'aft' ? 76 : 70) * DEG;
    const n = new THREE.Vector3(0, mode === 'aft' ? -Math.sin(t) : Math.sin(t), -Math.cos(t));
    const u = new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    const at = (x: number, y: number) => n.clone().addScaledVector(u, x).addScaledVector(v, y).multiplyScalar(2.2 * M);
    for (const y of [-0.72, 0.72]) {
      const a = at(-0.62, y);
      const b = at(0.62, y);
      frame.push(rod(a, b, 0.028 * M));
      for (const p of [a, b]) frame.push(rod(p, p.clone().multiplyScalar(1.13), 0.02 * M));
    }
  }
  const f = mergeGeometries(frame, false)!;
  const g = mergeGeometries(glass, false)!;
  for (const x of frame) x.dispose();
  for (const x of glass) x.dispose();
  return { frame: f, glass: g };
}

// ---- shaders ------------------------------------------------------------------

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aMat; // ao, tone (0 seal .. 1 metal), distance from the opening (rad)
varying vec3 vP; // LVLH, relative to the eye
varying vec3 vN;
varying vec3 vMat;
void main() {
  vP = position;
  vN = normal;
  vMat = aMat;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform int uMode;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uSunLit;
uniform vec3 uAmb;
uniform vec3 uEarth;
uniform vec3 uFrame;
uniform vec3 uSeal;
uniform vec3 uWall;
uniform float uBlur; // radians: defocus fade on the glass edge (frame is near, focus at infinity)
varying vec3 vP;
varying vec3 vN;
varying vec3 vMat;

const float R_GLASS = ${R_GLASS.toFixed(5)};

// signed angular distance (radians) into a rounded rectangle window facing n
float rectWindow(vec3 d, vec3 n, float halfW, float halfH, float corner) {
  vec3 u = vec3(1.0, 0.0, 0.0);
  vec3 v = normalize(cross(n, u));
  float fz = dot(d, n);
  if (fz <= 0.0) return -1.0;
  vec2 a = vec2(atan(dot(d, u), fz), atan(dot(d, v), fz));
  vec2 q = abs(a) - vec2(halfW, halfH) + corner;
  float outside = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  return -outside;
}

// > 0 inside a window opening (radians of margin); same layout as the frames
float windowOpen(vec3 d) {
  if (uMode == 0) {
    float nadir = acos(clamp(-d.z, -1.0, 1.0));
    float centre = radians(34.0) - nadir;
    float az = atan(d.y, d.x);
    float seg = radians(60.0);
    float rel = mod(az - radians(30.0), seg);
    float post = min(rel, seg - rel) * sin(nadir) - radians(3.0);
    float ring = min(nadir - radians(40.0), radians(68.0) - nadir);
    return max(centre, min(ring, post));
  } else if (uMode == 1) {
    float t = radians(76.0);
    return rectWindow(d, vec3(0.0, -sin(t), -cos(t)), radians(42.0), radians(24.0), radians(8.0));
  } else if (uMode == 2) {
    float t = radians(70.0);
    return rectWindow(d, vec3(0.0, sin(t), -cos(t)), radians(42.0), radians(24.0), radians(8.0));
  }
  return radians(32.0) - acos(clamp(d.z, -1.0, 1.0));
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 P = vP;
  #ifdef WALL
  vec3 dirP = normalize(P);
  if (windowOpen(dirP) + ${WALL_HOLE_MARGIN.toFixed(5)} > 0.0) discard;
  vec3 N = -dirP;
  vec3 alb = uWall;
  float ao = 1.0;
  float alpha = 1.0;
  #else
  vec3 N = normalize(vN);
  vec3 alb = mix(uSeal, uFrame, vMat.y);
  float ao = vMat.x;
  float alpha = uBlur > 0.0 ? smoothstep(0.0, uBlur * 1.8, vMat.z) : 1.0;
  #endif

  // the Sun reaches this point only if the ray toward it leaves through a window
  float sunV = 0.0;
  float nl = dot(N, uSunDir);
  if (uSunLit > 0.0 && nl > 0.0) {
    float b = dot(P, uSunDir);
    float disc = b * b - (dot(P, P) - R_GLASS * R_GLASS);
    if (disc > 0.0) {
      vec3 q = P + uSunDir * (-b + sqrt(disc));
      sunV = smoothstep(-0.012, 0.012, windowOpen(normalize(q)));
    }
  }
  float earthWrap = 0.3 + 0.7 * (0.5 - 0.5 * N.z) + 1.1 * smoothstep(0.15, 0.85, -N.z);
  vec3 light = uAmb * ao * (0.8 + 0.2 * N.z) + uEarth * earthWrap * ao + uSunCol * (uSunLit * sunV * nl * mix(1.0, ao, 0.5));
  gl_FragColor = vec4(alb * light, alpha);
  #include <colorspace_fragment>
}
`;

const GLASS_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCol;
uniform float uBase;
uniform float uFres;
varying vec3 vP;
varying vec3 vN;
void main() {
  #include <logdepthbuf_fragment>
  float f = 1.0 - clamp(dot(normalize(-vP), normalize(vN)), 0.0, 1.0);
  gl_FragColor = vec4(uCol, uBase + uFres * f * f);
  #include <colorspace_fragment>
}
`;

// ---- public -------------------------------------------------------------------

export interface Cabin {
  group: THREE.Group;
  setMode(mode: CabinMode | null): void;
  /** Sun direction in the station LVLH frame (x right, y forward, z up), unit length. */
  update(sunLocal: THREE.Vector3): void;
  /** triangle count of the frame + glass for a view (for reporting) */
  triangles(mode: CabinMode): number;
  dispose(): void;
}

export function createCabin(): Cabin {
  const group = new THREE.Group();
  const modes: CabinMode[] = ['cupola', 'aft', 'limb', 'zenith'];
  const geos = new Map<CabinMode, ModeGeometry>();
  for (const m of modes) geos.set(m, buildMode(m));

  const shared = {
    uMode: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color() },
    uSunLit: { value: 0 },
    uAmb: { value: CABIN.ambient.clone().multiplyScalar(CABIN.ambientIntensity) },
    uEarth: { value: new THREE.Color() },
    uFrame: { value: CABIN.frame },
    uSeal: { value: CABIN.seal },
    uWall: { value: CABIN.wall },
    uBlur: { value: urlWantsDof() ? DOF.cabinBlurDeg * DEG : 0 },
  };
  const wallMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: shared,
    defines: { WALL: '' },
    side: THREE.BackSide,
  });
  const frameMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: shared,
    transparent: true, // defocus fade on the opening edge
    side: THREE.DoubleSide,
  });
  const glassUniforms = {
    uCol: { value: new THREE.Color() },
    uBase: { value: CABIN.glassBase },
    uFres: { value: CABIN.glassFresnel },
  };
  const glassMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: GLASS_FRAGMENT,
    uniforms: glassUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const wall = new THREE.Mesh(new THREE.SphereGeometry(R_WALL, 48, 32), wallMat);
  wall.frustumCulled = false;
  wall.renderOrder = 9;
  const frame = new THREE.Mesh(geos.get('cupola')!.frame, frameMat);
  frame.frustumCulled = false;
  frame.renderOrder = 10;
  const glass = new THREE.Mesh(geos.get('cupola')!.glass, glassMat);
  glass.frustumCulled = false;
  glass.renderOrder = 11;
  group.add(wall, frame, glass);
  group.visible = false;

  const sunWarmCol = new THREE.Color();
  const glassCol = new THREE.Color();

  return {
    group,
    setMode(mode) {
      group.visible = mode !== null;
      if (mode === null) return;
      const g = geos.get(mode)!;
      frame.geometry = g.frame;
      glass.geometry = g.glass;
      shared.uMode.value = MODE_INDEX[mode];
    },
    update(sunLocal) {
      const e = Math.asin(THREE.MathUtils.clamp(sunLocal.z, -1, 1)) / DEG;
      const dip = HORIZON_DIP_DEG;
      // the Sun is up unless the Earth hides it (sun below -dip); a hair of
      // atmosphere softens the switch
      const lit = THREE.MathUtils.smoothstep(e, -dip - 0.6, -dip + 0.3);
      // grazing the atmosphere: red-orange, dimmer
      const warm = 1 - THREE.MathUtils.smoothstep(e, -dip, -dip + 9);
      shared.uSunDir.value.copy(sunLocal);
      shared.uSunLit.value = lit;
      sunWarmCol.copy(SUN.color).lerp(CABIN.sunWarm, warm * 0.85).multiplyScalar((SUN.intensity / Math.PI) * (1 - 0.5 * warm));
      shared.uSunCol.value.copy(sunWarmCol);
      // earthshine follows how brightly the Earth below is lit
      const day = THREE.MathUtils.smoothstep(sunLocal.z, -0.25, 0.75);
      shared.uEarth.value.copy(CABIN.earthshine).multiplyScalar(CABIN.earthNight + (CABIN.earthDay - CABIN.earthNight) * day);
      // glass reflects the dim interior (lit a little by the same sources)
      glassCol.copy(CABIN.ambient).multiplyScalar(CABIN.ambientIntensity * 1.5);
      glassCol.add(shared.uEarth.value.clone().multiplyScalar(0.5));
      glassCol.add(sunWarmCol.clone().multiplyScalar(0.04 * lit));
      glassUniforms.uCol.value.copy(glassCol);
    },
    triangles(mode) {
      const g = geos.get(mode)!;
      return (g.frame.index!.count + g.glass.index!.count) / 3;
    },
    dispose() {
      wall.geometry.dispose();
      for (const g of geos.values()) {
        g.frame.dispose();
        g.glass.dispose();
      }
      wallMat.dispose();
      frameMat.dispose();
      glassMat.dispose();
    },
  };
}
