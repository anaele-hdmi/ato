// A compact, symmetrical low-poly station (client concept art): an octagonal
// hub with chamfered ends, a faceted zenith dome with a small antenna on top,
// an Earth-facing cupola pod below, two chunky segmented arms and two square
// 2x2 solar arrays that turn about the arm axis to face the Sun.
// Matte flat-shaded Lambert with vertex colours; no textures.
// LVLH-oriented: local -Z = velocity (forward), local +Y = away from Earth,
// local X = the arm axis.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STATION } from './palette';
import { circleLoop, fillPolygon, sweepFrame, type LoopPt, type Mapper, type ProfileStep } from './windowFrame';

// ---- dimensions (km); 1 m = 0.001 ------------------------------------------
const M = 0.001;
const HUB_APOTHEM = 5.5 * M; // hub width (flat to flat) = 11 m
const HUB_SIDE_HALF = 3.2 * M; // vertical side faces: y in [-3.2, 3.2] m
const HUB_END_Y = 5.5 * M; // chamfered ends reach y = +-5.5 m (height 11 m)
const HUB_END_APOTHEM = 3.5 * M;

const COLLAR_APOTHEM = 2.35 * M;
const COLLAR_TOP = 6.3 * M;
const DOME_R = 1.95 * M; // 35 % of the hub width, as a diameter
const DOME_BASE = COLLAR_TOP + 0.15 * M;
const DOME_TOP = DOME_BASE + DOME_R * 0.93;
const MAST_TOP = DOME_TOP + 1.5 * M;

const NECK_APOTHEM = 2.2 * M; // 40 % of the hub width
const NECK_BOTTOM = -7.0 * M;
const POD_APOTHEM = 3.1 * M;
const POD_MID = -8.9 * M; // light upper half / dark lower half
const POD_BOTTOM = -10.7 * M;
// Earth-facing cupola under the pod: a hexagonal frustum with six trapezoid
// windows on its slopes and one round window in its floor (as on the ISS).
const CUP_TOP_Y = POD_MID - 0.55 * M;
const CUP_R_TOP = 3.0 * M; // hexagon circumradius (= side length)
const CUP_R_BOTTOM = 1.5 * M;
const CUP_BODY_PULL = 0.16 * M; // body sits this much (circumradius) inside the frame plane
const CUP_MARGIN = 0.4 * M; // window inset from the face edge
const CUP_GLASS_H = -0.04 * M;

const ARM_ROOT = HUB_APOTHEM;
const ARRAY_INNER = 11.4 * M; // x of the array's inner frame edge (pivot)
const ARRAY_SIDE = 15 * M;
const FRAME_BAR = 0.5 * M;
const FRAME_THICK = 0.42 * M;
const PANEL_THICK = 0.14 * M;
const PANEL_RAISE = 0.7 * M; // centre of each panel face, for the faceted X
const CORNER_BLOCK = 1.05 * M;

/** Eyes sit this far off the nearest hull surface (cabin sphere is 3 m). */
const EYE_CLEAR = 3.3 * M;

const OCT_R = 1 / Math.cos(Math.PI / 8); // octagon apothem -> vertex radius

export interface StationObjects {
  group: THREE.Group;
  /** Orients the group LVLH: local -Z = forward (velocity), local +Y = up (away from Earth).
   *  `sunDir` (world-space, optional) rotates each solar array about the arm axis to face the sun. */
  orient(stationPosDir: THREE.Vector3, stationVelDir: THREE.Vector3, sunDir?: THREE.Vector3): void;
  /** Eye points (station-local) for the interior views: the window each view looks through. */
  eyes: { cupola: THREE.Vector3; aft: THREE.Vector3; limb: THREE.Vector3; zenith: THREE.Vector3 };
  dispose(): void;
}

// ---- geometry helpers ------------------------------------------------------

/** Octagon ring (flats facing +-X and +-Z) at height y, given its apothem. */
function octRing(y: number, apothem: number, out: THREE.Vector3[]): THREE.Vector3[] {
  const r = apothem * OCT_R;
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    out.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return out;
}

/** Convex octagonal stack along +Y from [y, apothem] pairs. */
function octStack(rings: readonly (readonly [number, number])[]): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (const [y, a] of rings) octRing(y, a, pts);
  return new ConvexGeometry(pts);
}

/** Box with chamfered edges (half extents, bevel size). */
function bevelBox(hx: number, hy: number, hz: number, b: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * hx, sy * (hy - b), sz * (hz - b)));
        pts.push(new THREE.Vector3(sx * (hx - b), sy * hy, sz * (hz - b)));
        pts.push(new THREE.Vector3(sx * (hx - b), sy * (hy - b), sz * hz));
      }
  return new ConvexGeometry(pts);
}

/** Low-poly geodesic cap: icosphere (detail 1) upper half on an octagonal base. */
function domeCap(r: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(r, 1);
  const p = ico.attributes.position;
  const pts: THREE.Vector3[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    if (v.y < r * 0.2) continue;
    const key = `${v.x.toFixed(7)},${v.y.toFixed(7)},${v.z.toFixed(7)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push(v);
  }
  ico.dispose();
  octRing(0, r * Math.cos(Math.PI / 8), pts);
  return new ConvexGeometry(pts);
}

/** Thin slab (in XZ, facing +-Y) whose both faces rise to a centre point:
 *  four triangles per face, so flat shading draws a shallow X. */
function facetedPanel(hx: number, hz: number, t: number, raise: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  for (const s of [1, -1]) {
    const y = (s * t) / 2;
    const c = [0, y + s * raise, 0];
    const corners = [
      [-hx, y, -hz],
      [hx, y, -hz],
      [hx, y, hz],
      [-hx, y, hz],
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      // wind counter-clockwise seen from the face's outside (+Y for s = 1)
      if (s > 0) tri(c, b, a);
      else tri(c, a, b);
    }
  }
  // rim
  const e = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = e[i];
    const [x1, z1] = e[(i + 1) % 4];
    const lo0 = [x0, -t / 2, z0];
    const lo1 = [x1, -t / 2, z1];
    const hi0 = [x0, t / 2, z0];
    const hi1 = [x1, t / 2, z1];
    tri(lo0, lo1, hi1);
    tri(lo0, hi1, hi0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// deterministic small per-plane brightness jitter ("panel shading")
function planeJitter(nx: number, ny: number, nz: number, d: number): number {
  const h = Math.sin(nx * 12.9898 + ny * 78.233 + nz * 37.719 + d * 4513.1) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();

/** Non-indexed geometry -> per-vertex colour; each flat plane gets a slightly
 *  different shade (amount = relative jitter, 0 = uniform). */
function paint(geo: THREE.BufferGeometry, color: THREE.Color, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const p = g.attributes.position;
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 3) {
    _v0.fromBufferAttribute(p, i);
    _v1.fromBufferAttribute(p, i + 1);
    _v2.fromBufferAttribute(p, i + 2);
    _n.subVectors(_v2, _v1).cross(_v0.clone().sub(_v1)).normalize();
    const k = jitter ? 1 + jitter * planeJitter(_n.x, _n.y, _n.z, _n.dot(_v0) / M) : 1;
    _c.copy(color).multiplyScalar(k);
    for (let j = 0; j < 3; j++) {
      colors[(i + j) * 3] = _c.r;
      colors[(i + j) * 3 + 1] = _c.g;
      colors[(i + j) * 3 + 2] = _c.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // ConvexGeometry carries no uvs; keep attribute sets identical for merging
  g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** DOF mask: the station writes alpha 0 into the (otherwise unused) alpha
 *  channel of the MSAA target; every other opaque surface leaves it at 1.
 *  post.ts reads it in the chase view only. RGB output is unchanged.
 *  Apply to every material that draws part of the station. */
export function markStationMaterial(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      '#include <opaque_fragment>\n  gl_FragColor.a = 0.0;',
    );
  };
}

// exterior window frame cross-section (metres -> km): glass seat, seal, step, chamfer, lip, bevel to the body
const CUP_PROFILE: ProfileStep[] = (
  [
    [0, -0.04, 0.5, 0],
    [0.05, -0.04, 0.55, 0],
    [0.05, 0.03, 0.75, 0.4],
    [0.13, 0.07, 0.92, 1],
    [0.19, 0.07, 1, 1],
    [0.26, -0.1, 0.85, 1],
  ] as const
).map(([off, h, ao, tone]) => ({ off: off * M, h: h * M, ao, tone }));

export function createStation(): StationObjects {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  const body = STATION.body;
  const shade = STATION.bodyShade;
  const dark = STATION.dark;
  const podDark = dark.clone().lerp(shade, 0.28);

  // Matte, faceted: flat-shaded Lambert, colour per vertex.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true });
  markStationMaterial(material);

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();

  function put(
    list: THREE.BufferGeometry[],
    geo: THREE.BufferGeometry,
    color: THREE.Color,
    pos: readonly [number, number, number] = [0, 0, 0],
    rot: readonly [number, number, number] = [0, 0, 0],
    jitter = 0.035,
    scale: readonly [number, number, number] = [1, 1, 1],
  ): void {
    _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(scale[0], scale[1], scale[2]));
    geo.applyMatrix4(_m);
    list.push(paint(geo, color, jitter));
  }

  const hull: THREE.BufferGeometry[] = [];

  /** sweep output -> hull geometry: per-vertex colour from (ao, tone) */
  function colorFrame(g: THREE.BufferGeometry): THREE.BufferGeometry {
    const ng = g.toNonIndexed();
    g.dispose();
    const m = ng.attributes.aMat;
    const col = new Float32Array(m.count * 3);
    for (let i = 0; i < m.count; i++) {
      _c.copy(dark).lerp(STATION.bodyShade, m.getY(i)).multiplyScalar(0.55 + 0.45 * m.getX(i));
      col.set([_c.r, _c.g, _c.b], i * 3);
    }
    ng.deleteAttribute('aMat');
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return ng;
  }

  /** Cupola: hex frustum body, six trapezoid windows + a round floor window,
   *  each with a chamfered frame, dark glass, and opened shutters on the slopes.
   *  Frames/shutters go into `hull`; returns the glass panes. */
  function buildCupola(hullList: THREE.BufferGeometry[], bodyCol: THREE.Color): THREE.BufferGeometry[] {
    const glass: THREE.BufferGeometry[] = [];
    const ring = (k: number, r: number, y: number) => new THREE.Vector3(Math.cos((k * Math.PI) / 3) * r, y, Math.sin((k * Math.PI) / 3) * r);
    const bottomY = POD_BOTTOM;
    // body: slightly inside the frame planes so the glass sits proud of it
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 6; k++) {
      pts.push(ring(k, CUP_R_TOP - CUP_BODY_PULL, CUP_TOP_Y + 0.05 * M), ring(k, CUP_R_BOTTOM - CUP_BODY_PULL, bottomY + 0.1 * M));
    }
    hullList.push(paint(new ConvexGeometry(pts), bodyCol, 0.05));

    for (let k = 0; k < 6; k++) {
      const T0 = ring(k, CUP_R_TOP, CUP_TOP_Y);
      const T1 = ring(k + 1, CUP_R_TOP, CUP_TOP_Y);
      const B0 = ring(k, CUP_R_BOTTOM, bottomY);
      const B1 = ring(k + 1, CUP_R_BOTTOM, bottomY);
      const Tm = T0.clone().add(T1).multiplyScalar(0.5);
      const Bm = B0.clone().add(B1).multiplyScalar(0.5);
      const u = T1.clone().sub(T0).normalize();
      const v = Bm.clone().sub(Tm);
      const s = v.length();
      v.normalize();
      const n = new THREE.Vector3().crossVectors(u, v).normalize();
      if (n.x * Tm.x + n.z * Tm.z < 0) n.negate();
      const map: Mapper = (x, y, h) => Tm.clone().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, h);
      const halfAt = (y: number) => CUP_R_TOP / 2 - ((CUP_R_TOP - CUP_R_BOTTOM) / 2) * (y / s);
      const slope = (CUP_R_TOP - CUP_R_BOTTOM) / 2 / s;
      const edge = CUP_MARGIN * Math.sqrt(1 + slope * slope);
      const y0 = CUP_MARGIN;
      const y1 = s - CUP_MARGIN;
      const w0 = halfAt(y0) - edge;
      const w1 = halfAt(y1) - edge;
      const loop: LoopPt[] = [
        { x: -w0, y: y0, corner: true },
        { x: w0, y: y0, corner: true },
        { x: w1, y: y1, corner: true },
        { x: -w1, y: y1, corner: true },
      ];
      const viewer = Tm.clone().addScaledVector(n, 50);
      hullList.push(colorFrame(sweepFrame(loop, CUP_PROFILE, map, viewer)));
      glass.push(fillPolygon(loop, map, CUP_GLASS_H, n));

      // shutter: a slab hinged above the window, swung open away from the glass
      const pad = 0.1 * M;
      const hingeY = y0 - 0.16 * M;
      const shape = new THREE.Shape();
      shape.moveTo(-(w0 + pad), 0);
      shape.lineTo(w0 + pad, 0);
      shape.lineTo(w1 + pad, y1 + pad - hingeY);
      shape.lineTo(-(w1 + pad), y1 + pad - hingeY);
      shape.closePath();
      const slab = new THREE.ExtrudeGeometry(shape, { depth: 0.05 * M, bevelEnabled: false });
      const open = (80 * Math.PI) / 180;
      const d = v.clone().multiplyScalar(Math.cos(open)).addScaledVector(n, Math.sin(open));
      const basis = new THREE.Matrix4().makeBasis(u, d, new THREE.Vector3().crossVectors(u, d));
      basis.setPosition(Tm.clone().addScaledVector(v, hingeY).addScaledVector(n, 0.16 * M));
      slab.applyMatrix4(basis);
      hullList.push(paint(slab, STATION.shutter, 0.05));
    }

    // round window in the floor
    const floor: Mapper = (x, z, h) => new THREE.Vector3(x, bottomY - h, z);
    const round = circleLoop(0.8 * M, 24);
    hullList.push(colorFrame(sweepFrame(round, CUP_PROFILE, floor, new THREE.Vector3(0, bottomY - 50, 0))));
    glass.push(fillPolygon(round, floor, CUP_GLASS_H, new THREE.Vector3(0, -1, 0)));
    return glass;
  }

  // ---- central hub: octagonal prism with strongly chamfered ends -----------
  put(
    hull,
    octStack([
      [-HUB_END_Y, HUB_END_APOTHEM],
      [-HUB_SIDE_HALF, HUB_APOTHEM],
      [HUB_SIDE_HALF, HUB_APOTHEM],
      [HUB_END_Y, HUB_END_APOTHEM],
    ]),
    body,
  );
  // thin seam bands where the chamfers start (subtle panel break)
  for (const y of [-HUB_SIDE_HALF, HUB_SIDE_HALF]) {
    put(
      hull,
      octStack([
        [y - 0.09 * M, HUB_APOTHEM + 0.05 * M],
        [y + 0.09 * M, HUB_APOTHEM + 0.05 * M],
      ]),
      shade,
      [0, 0, 0],
      [0, 0, 0],
      0.02,
    );
  }

  // windows: dark inset-look quads just proud of the side faces
  const window = (faceAngle: number, u: number, y: number, w: number, h: number) => {
    const g = new THREE.BoxGeometry(w, h, 0.12 * M);
    // face normal direction in XZ; faceAngle 0 = -Z (forward)
    const nx = -Math.sin(faceAngle);
    const nz = -Math.cos(faceAngle);
    const d = HUB_APOTHEM + 0.02 * M;
    const tx = Math.cos(faceAngle); // tangent along the face (right-handed)
    const tz = -Math.sin(faceAngle);
    put(hull, g, dark, [nx * d + tx * u, y, nz * d + tz * u], [0, faceAngle, 0], 0);
    // light sill under each window
    const s = new THREE.BoxGeometry(w + 0.3 * M, 0.18 * M, 0.2 * M);
    put(hull, s, shade, [nx * (d + 0.02 * M) + tx * u, y - h / 2 - 0.2 * M, nz * (d + 0.02 * M) + tz * u], [0, faceAngle, 0], 0);
  };
  const Q = Math.PI / 4;
  window(0, -0.9 * M, 0.9 * M, 2.3 * M, 1.4 * M); // forward face: the larger one
  window(0, 1.45 * M, 1.1 * M, 0.6 * M, 0.6 * M);
  window(0, 1.45 * M, 0.1 * M, 0.6 * M, 0.6 * M);
  window(Math.PI, 0.6 * M, 1.0 * M, 1.6 * M, 1.0 * M); // aft face
  window(Math.PI, -1.5 * M, 1.0 * M, 0.6 * M, 0.6 * M);
  window(Q, 0, 1.2 * M, 0.7 * M, 0.7 * M); // diagonal faces: tiny ones
  window(-Q, 0, 1.2 * M, 0.7 * M, 0.7 * M);
  window(Math.PI - Q, 0.6 * M, -0.8 * M, 0.7 * M, 0.7 * M);
  window(Math.PI + Q, -0.6 * M, -0.8 * M, 0.7 * M, 0.7 * M);

  // ---- top: collar, geodesic zenith dome, antenna -------------------------
  put(
    hull,
    octStack([
      [HUB_END_Y - 0.05 * M, COLLAR_APOTHEM],
      [COLLAR_TOP - 0.25 * M, COLLAR_APOTHEM],
      [COLLAR_TOP, COLLAR_APOTHEM - 0.25 * M],
    ]),
    shade,
  );
  put(hull, domeCap(DOME_R), body, [0, DOME_BASE - 0.2 * M, 0], [0, Math.PI / 8, 0], 0.05);
  put(hull, new THREE.CylinderGeometry(0.07 * M, 0.09 * M, MAST_TOP - DOME_TOP + 0.3 * M, 5), dark, [0, (MAST_TOP + DOME_TOP - 0.3 * M) / 2, 0], [0, 0, 0], 0);
  put(hull, new THREE.BoxGeometry(1.3 * M, 0.08 * M, 0.08 * M), dark, [0, MAST_TOP - 0.45 * M, 0], [0, 0, 0], 0);
  put(hull, new THREE.OctahedronGeometry(0.13 * M), dark, [0, MAST_TOP, 0], [0, 0, 0], 0);

  // ---- bottom: neck, Earth-facing cupola pod -------------------------------
  put(
    hull,
    octStack([
      [-HUB_END_Y + 0.05 * M, NECK_APOTHEM],
      [NECK_BOTTOM + 0.1 * M, NECK_APOTHEM],
    ]),
    shade,
  );
  put(
    hull,
    octStack([
      [NECK_BOTTOM + 0.15 * M, POD_APOTHEM - 0.55 * M],
      [NECK_BOTTOM - 0.35 * M, POD_APOTHEM],
      [POD_MID, POD_APOTHEM],
    ]),
    body,
  );
  put(
    hull,
    octStack([
      [POD_MID + 0.01 * M, POD_APOTHEM + 0.04 * M],
      [CUP_TOP_Y, POD_APOTHEM + 0.04 * M],
    ]),
    podDark,
    [0, 0, 0],
    [0, 0, 0],
    0.06,
  );
  const glassParts = buildCupola(hull, podDark);

  // ---- arms: chunky segmented blocks with joint collars, to a mount block --
  for (const side of [-1, 1]) {
    const sx = (x: number) => side * x;
    const collar = (x0: number, len: number, a: number) => {
      put(
        hull,
        octStack([
          [0, a],
          [len, a],
        ]),
        shade,
        [sx(x0 + (side < 0 ? len : 0)), 0, 0],
        [0, 0, -Math.PI / 2],
      );
    };
    // octStack runs along +Y; rotating by -90deg about Z maps +Y -> +X
    collar(ARM_ROOT - 0.1 * M, 0.55 * M, 1.5 * M);
    put(hull, bevelBox(1.05 * M, 1.55 * M, 1.55 * M, 0.35 * M), body, [sx(ARM_ROOT + 1.5 * M), 0, 0]);
    collar(ARM_ROOT + 2.5 * M, 0.4 * M, 1.05 * M);
    put(hull, bevelBox(0.8 * M, 1.3 * M, 1.3 * M, 0.3 * M), body, [sx(ARM_ROOT + 3.65 * M), 0, 0]);
    collar(ARM_ROOT + 4.4 * M, 0.35 * M, 0.85 * M);
    // square mount block at the arm end (static; the array turns beside it)
    put(hull, bevelBox(0.4 * M, 0.95 * M, 0.95 * M, 0.18 * M), shade, [sx(ARRAY_INNER - 0.8 * M), 0, 0]);
  }

  const hullGeo = mergeGeometries(hull, false)!;
  for (const g of hull) g.dispose();
  geometries.push(hullGeo);
  const hullMesh = new THREE.Mesh(hullGeo, material);
  group.add(hullMesh);
  // dark glass that catches the Sun (one merged mesh, one extra draw call)
  const glassGeo = mergeGeometries(glassParts, false)!;
  for (const g of glassParts) g.dispose();
  geometries.push(glassGeo);
  const glassMaterial = new THREE.MeshPhongMaterial({
    color: STATION.glass,
    specular: STATION.glassSpecular,
    shininess: 80,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  markStationMaterial(glassMaterial);
  group.add(new THREE.Mesh(glassGeo, glassMaterial));

  // ---- solar arrays: frame + 2x2 faceted panels, one mesh per array --------
  const arrays: THREE.Object3D[] = [];
  const S = ARRAY_SIDE;
  const half = S / 2;
  const cellSpan = (S - 3 * FRAME_BAR) / 2;
  for (const side of [-1, 1]) {
    const parts: THREE.BufferGeometry[] = [];
    const cx = half; // array centre along the pivot's local +X (mirrored below)
    // shaft from the mount into the frame
    put(parts, bevelBox(0.3 * M, 0.45 * M, 0.45 * M, 0.1 * M), dark, [-0.2 * M, 0, 0], [0, 0, 0], 0);
    // frame bars: perimeter + centre cross (in XZ plane)
    const bar = (x: number, z: number, lx: number, lz: number) =>
      put(parts, bevelBox(lx / 2, FRAME_THICK / 2, lz / 2, 0.08 * M), STATION.frame, [x, 0, z], [0, 0, 0], 0.02);
    bar(cx, -half + FRAME_BAR / 2, S, FRAME_BAR);
    bar(cx, half - FRAME_BAR / 2, S, FRAME_BAR);
    bar(cx, 0, S, FRAME_BAR);
    bar(FRAME_BAR / 2, 0, FRAME_BAR, S - 2 * FRAME_BAR);
    bar(S - FRAME_BAR / 2, 0, FRAME_BAR, S - 2 * FRAME_BAR);
    bar(cx, 0, FRAME_BAR, S - 2 * FRAME_BAR);
    // corner blocks + outer-edge middle block + inner-edge middle (mount) block
    const block = (x: number, z: number, s = CORNER_BLOCK) =>
      put(parts, bevelBox(s / 2, s / 2, s / 2, 0.12 * M), STATION.frame, [x, 0, z], [0, 0, 0], 0.04);
    const e = FRAME_BAR / 2;
    block(e, -half + e);
    block(e, half - e);
    block(S - e, -half + e);
    block(S - e, half - e);
    block(S - e, 0);
    block(e, 0, CORNER_BLOCK * 1.1);
    // four faceted navy panels
    for (const px of [-1, 1])
      for (const pz of [-1, 1]) {
        const x = cx + px * (FRAME_BAR / 2 + cellSpan / 2);
        const z = pz * (FRAME_BAR / 2 + cellSpan / 2);
        put(parts, facetedPanel(cellSpan / 2, cellSpan / 2, PANEL_THICK, PANEL_RAISE), STATION.panel, [x, 0, z], [0, 0, 0], 0.12);
      }
    const geo = mergeGeometries(parts, false)!;
    for (const g of parts) g.dispose();
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    const pivot = new THREE.Object3D();
    pivot.position.set(side * ARRAY_INNER, 0, 0);
    // the -X array is the same geometry turned half-way round (not mirrored,
    // which would flip the winding)
    if (side < 0) mesh.rotation.y = Math.PI;
    pivot.add(mesh);
    group.add(pivot);
    arrays.push(pivot);
  }

  // ---- orientation -----------------------------------------------------
  const upDir = new THREE.Vector3(0, 1, 0);
  const forwardTarget = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const mT = new THREE.Matrix4();
  const localSun = new THREE.Vector3();

  // Interior eyes: just outside the hull, with the 3 m cabin sphere clear of
  // all geometry and nothing in front of each view's default direction.
  const eyes = {
    // below the cupola pod's flat bottom, looking down at Earth
    cupola: new THREE.Vector3(0, POD_BOTTOM - EYE_CLEAR, 0),
    // off the hub's aft face, a little above mid-height, arrays at the sides
    aft: new THREE.Vector3(0, 0.6 * M, HUB_APOTHEM + EYE_CLEAR),
    // off the hub's forward face, slightly below mid-height
    limb: new THREE.Vector3(0, -0.8 * M, -(HUB_APOTHEM + EYE_CLEAR)),
    // above the dome, clear of the antenna tip
    zenith: new THREE.Vector3(0, MAST_TOP + 3.4 * M, 0),
  };

  return {
    group,
    eyes,
    orient(stationPosDir: THREE.Vector3, stationVelDir: THREE.Vector3, sunDir?: THREE.Vector3) {
      forwardTarget.copy(stationVelDir).normalize();
      upDir.copy(stationPosDir).normalize();
      m.lookAt(origin, forwardTarget, upDir);
      group.quaternion.setFromRotationMatrix(m);

      if (sunDir) {
        mT.copy(m).transpose();
        localSun.copy(sunDir).normalize().transformDirection(mT);
        // panel normal at rotation.x = t is (0, cos t, sin t): aim it at the sun
        if (Math.hypot(localSun.y, localSun.z) > 1e-6) {
          const t = Math.atan2(localSun.z, localSun.y);
          for (const a of arrays) a.rotation.x = t;
        }
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      material.dispose();
      glassMaterial.dispose();
    },
  };
}
