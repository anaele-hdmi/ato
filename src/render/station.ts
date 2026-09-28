// A stylized, fictional ISS-like station: integrated truss with lattice joints,
// four pairs of sun-tracking solar array wings, a pressurized module stack,
// radiators, a cupola and a docked capsule. Flat-shaded MeshToonMaterial only.
// No real ISS imagery or markings.
// LVLH-oriented: local -Z = velocity (forward), local +Y = away from Earth,
// local X = the truss (lateral) axis.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STATION } from './palette';

// ---- dimensions (km) -------------------------------------------------------
const TRUSS_LENGTH = 0.086;
const TRUSS_SECTION = 0.0055;
const LONGERON_OFFSET = 0.0045; // half-diagonal of the lattice cross-section
const LONGERON_R = 0.0007;
const JOINT_COUNT = 4; // internal segment joints along the truss
const JOINT_SIZE = 0.0095;

const WINGS_PER_END = 4; // -> 8 wings total = 4 pairs
const WING_MOUNT_INSET = 0.006;
const WING_Z_SPACING = 0.011;
const PANEL_LENGTH = 0.03; // each blanket, half of the wing's deployed length
const PANEL_WIDTH = 0.0105;
const PANEL_THICKNESS = 0.0004;
const MAST_HALF_GAP = 0.0016; // gap between the two blankets, for the mast
const MAST_WIDTH = 0.0011;
const GIMBAL_R = 0.0016;
const GIMBAL_LEN = 0.0022;
const BLANKET_UV_REPEAT = 7;

const RADIATOR_W = 0.0009;
const RADIATOR_H = 0.026;
const RADIATOR_D = 0.015;

const NODE_R = 0.0062;
const NODE_LEN = 0.0095;
const LAB_R = 0.0046;
const LAB_LEN = 0.026;
const LAB2_R = 0.004;
const LAB2_LEN = 0.02;
const SIDE_R = 0.0033;
const SIDE_LEN = 0.013;
const CUPOLA_R = 0.0032;
const CAPSULE_R = 0.0036;
const CAPSULE_LEN = 0.015;
const CAPSULE_NOSE_LEN = 0.007;
const DOCK_RING_R = 0.0042;
const DOCK_RING_LEN = 0.0016;

export interface StationObjects {
  group: THREE.Group;
  /** Orients the group LVLH: local -Z = forward (velocity), local +Y = up (away from Earth).
   *  `sunDir` (world-space, optional) rotates each solar wing about the truss axis to face the sun. */
  orient(stationPosDir: THREE.Vector3, stationVelDir: THREE.Vector3, sunDir?: THREE.Vector3): void;
  dispose(): void;
}

export function createStation(): StationObjects {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  // 3-step toon shading: shade / mid / lit.
  const gradient = new THREE.DataTexture(new Uint8Array([60, 170, 255]), 3, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  textures.push(gradient);

  // Vertex-coloured body material: every static hull/truss/frame/gold surface
  // shares this one material (and one draw call) via per-vertex colour.
  const bodyMat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: gradient });
  // Same recipe, used per-wing for the mast/gimbal (kept separate from the
  // static body only because the wing rotates).
  const frameMat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: gradient });
  const blanketTex = createBlanketTexture();
  textures.push(blanketTex);
  const blanketMat = new THREE.MeshToonMaterial({ color: 0xffffff, map: blanketTex, gradientMap: gradient });
  materials.push(bodyMat, frameMat, blanketMat);

  // ---- reusable unit templates (cloned + transformed per placement) -------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 12);
  const unitCylFine = new THREE.CylinderGeometry(1, 1, 1, 16);
  const unitCone = new THREE.ConeGeometry(1, 1, 10);
  const unitSphere = new THREE.SphereGeometry(1, 10, 8);
  const templates = [unitBox, unitCyl, unitCylFine, unitCone, unitSphere];

  const _pos = new THREE.Vector3();
  const _scale = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  const _mat4 = new THREE.Matrix4();
  const _color = new THREE.Color();

  function place(
    target: THREE.BufferGeometry[],
    template: THREE.BufferGeometry,
    hex: THREE.ColorRepresentation,
    pos: readonly [number, number, number],
    scale: readonly [number, number, number],
    euler?: readonly [number, number, number],
  ): THREE.BufferGeometry {
    const geo = template.clone();
    _euler.set(euler?.[0] ?? 0, euler?.[1] ?? 0, euler?.[2] ?? 0);
    _quat.setFromEuler(_euler);
    _pos.set(pos[0], pos[1], pos[2]);
    _scale.set(scale[0], scale[1], scale[2]);
    _mat4.compose(_pos, _quat, _scale);
    geo.applyMatrix4(_mat4);
    colorize(geo, hex);
    target.push(geo);
    return geo;
  }

  function colorize(geo: THREE.BufferGeometry, hex: THREE.ColorRepresentation): void {
    _color.set(hex);
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = _color.r;
      colors[i * 3 + 1] = _color.g;
      colors[i * 3 + 2] = _color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  function mergeAndAdd(pieces: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh {
    const merged = mergeGeometries(pieces, false) ?? new THREE.BufferGeometry();
    for (const p of pieces) p.dispose();
    geometries.push(merged);
    const mesh = new THREE.Mesh(merged, mat);
    return mesh;
  }

  // =========================================================================
  // Static body: truss (lattice), radiators, module stack, cupola, capsule,
  // gimbal housings, antennas. All merged into ONE mesh / ONE draw call.
  // =========================================================================
  const body: THREE.BufferGeometry[] = [];

  // --- integrated truss: main spine + 4 corner longerons (lattice read) ---
  place(body, unitBox, STATION.truss, [0, 0, 0], [TRUSS_LENGTH, TRUSS_SECTION, TRUSS_SECTION]);
  for (const sy of [1, -1]) {
    for (const sz of [1, -1]) {
      place(
        body,
        unitCyl,
        STATION.truss,
        [0, sy * LONGERON_OFFSET, sz * LONGERON_OFFSET],
        [LONGERON_R * 2, TRUSS_LENGTH, LONGERON_R * 2],
        [0, 0, Math.PI / 2],
      );
    }
  }
  // segment joint collars
  for (let i = 1; i <= JOINT_COUNT; i++) {
    const t = i / (JOINT_COUNT + 1) - 0.5;
    place(body, unitBox, STATION.frame, [t * TRUSS_LENGTH, 0, 0], [JOINT_SIZE * 0.4, JOINT_SIZE, JOINT_SIZE]);
  }

  // --- radiator panels, perpendicular to the truss, near centre ---
  for (const t of [-0.16, 0.16]) {
    place(
      body,
      unitBox,
      STATION.hull,
      [t * TRUSS_LENGTH, TRUSS_SECTION / 2 + RADIATOR_H / 2 - 0.0005, 0],
      [RADIATOR_W, RADIATOR_H, RADIATOR_D],
    );
    // thin frame rib down the middle of each radiator
    place(
      body,
      unitBox,
      STATION.frame,
      [t * TRUSS_LENGTH, TRUSS_SECTION / 2 + RADIATOR_H / 2 - 0.0005, 0],
      [RADIATOR_W * 1.6, RADIATOR_H, RADIATOR_D * 0.03],
    );
  }

  // --- wing gimbal housings (static drum; the wing arm itself is a child group) ---
  const wingMounts: Array<{ x: number; z: number }> = [];
  for (const endSign of [1, -1]) {
    for (let j = 0; j < WINGS_PER_END; j++) {
      const x = endSign * (TRUSS_LENGTH / 2 - WING_MOUNT_INSET);
      const z = (j - (WINGS_PER_END - 1) / 2) * WING_Z_SPACING;
      wingMounts.push({ x, z });
      place(body, unitCylFine, STATION.frame, [x, 0, z], [GIMBAL_R * 2.1, TRUSS_SECTION * 1.3, GIMBAL_R * 2.1], [0, 0, Math.PI / 2]);
    }
  }

  // --- pressurized module stack, hanging along -Z (forward), slightly -Y (nadir) ---
  const moduleY = -(TRUSS_SECTION / 2 + NODE_R + 0.0012);
  let zc = -0.004; // cursor: leading (most -Z) edge of the next piece
  function stackCyl(r: number, len: number, hex: THREE.ColorRepresentation, offsetY = moduleY): number {
    const centerZ = zc - len / 2;
    place(body, unitCylFine, hex, [0, offsetY, centerZ], [r * 2, len, r * 2], [Math.PI / 2, 0, 0]);
    zc -= len;
    return centerZ;
  }

  const node1Z = stackCyl(NODE_R, NODE_LEN, STATION.hull);
  zc -= 0.0008;
  stackCyl(LAB_R, LAB_LEN, STATION.hull);
  zc -= 0.0008;
  const node2Z = stackCyl(NODE_R, NODE_LEN, STATION.hull);
  zc -= 0.0008;
  stackCyl(LAB2_R, LAB2_LEN, STATION.hull);
  zc -= 0.0006;

  // docking ring + capsule at the forward-most port
  place(body, unitCylFine, STATION.gold, [0, moduleY, zc - DOCK_RING_LEN / 2], [DOCK_RING_R * 2, DOCK_RING_LEN, DOCK_RING_R * 2], [Math.PI / 2, 0, 0]);
  zc -= DOCK_RING_LEN;
  place(body, unitCylFine, STATION.hull, [0, moduleY, zc - CAPSULE_LEN / 2], [CAPSULE_R * 2, CAPSULE_LEN, CAPSULE_R * 2], [Math.PI / 2, 0, 0]);
  zc -= CAPSULE_LEN;
  place(body, unitCone, STATION.frame, [0, moduleY, zc - CAPSULE_NOSE_LEN / 2], [CAPSULE_R * 1.9, CAPSULE_NOSE_LEN, CAPSULE_R * 1.9], [-Math.PI / 2, 0, 0]);

  // side modules off the first node (fictional lab spurs)
  for (const s of [1, -1]) {
    place(body, unitCylFine, STATION.hull, [s * (NODE_R + SIDE_LEN / 2 - 0.001), moduleY, node1Z], [SIDE_R * 2, SIDE_LEN, SIDE_R * 2], [0, 0, Math.PI / 2]);
  }

  // cupola on the nadir (-Y) face, with a hint of dark window glass
  const cupolaZ = node2Z;
  place(body, unitSphere, STATION.hull, [0, moduleY - NODE_R - CUPOLA_R * 0.5, cupolaZ], [CUPOLA_R * 1.9, CUPOLA_R * 1.5, CUPOLA_R * 1.9]);
  place(body, unitCylFine, STATION.panel, [0, moduleY - NODE_R - CUPOLA_R * 1.2, cupolaZ], [CUPOLA_R * 1.1, CUPOLA_R * 0.5, CUPOLA_R * 1.1]);

  // sparse details: antennas + handrail-like beams
  place(body, unitCylFine, STATION.frame, [0.006, TRUSS_SECTION / 2 + 0.004, 0.004], [0.0006, 0.009, 0.0006], [0.4, 0, 0.3]);
  place(body, unitCylFine, STATION.gold, [0.006, TRUSS_SECTION / 2 + 0.0085, 0.004], [0.0004, 0.0014, 0.0004], [0.4, 0, 0.3]);
  place(body, unitCylFine, STATION.frame, [-0.006, TRUSS_SECTION / 2 + 0.0035, -0.006], [0.0005, 0.007, 0.0005], [-0.3, 0, -0.2]);
  place(body, unitBox, STATION.frame, [0, TRUSS_SECTION / 2 + 0.0002, -TRUSS_LENGTH * 0.3], [0.0004, 0.0004, 0.018]);
  place(body, unitBox, STATION.frame, [0, -(TRUSS_SECTION / 2 + 0.0002), TRUSS_LENGTH * 0.32], [0.0004, 0.0004, 0.018]);

  group.add(mergeAndAdd(body, bodyMat));

  // =========================================================================
  // Solar array wings: 8 rotary-jointed assemblies (4 pairs). Each is its own
  // pivot Group so it can rotate about the truss (local X) axis to face the
  // sun; blankets (textured) and mast/gimbal (vertex-coloured) are each
  // merged into one mesh, so every wing costs exactly 2 draw calls.
  // =========================================================================
  interface Wing {
    pivot: THREE.Group;
  }
  const wings: Wing[] = [];

  for (const mount of wingMounts) {
    const pivot = new THREE.Group();
    pivot.position.set(mount.x, 0, mount.z);

    const blanketPieces: THREE.BufferGeometry[] = [];
    for (const s of [1, -1]) {
      const cy = s * (MAST_HALF_GAP + PANEL_LENGTH / 2);
      const geo = place(blanketPieces, unitBox, 0xffffff, [0, cy, 0], [PANEL_WIDTH, PANEL_LENGTH, PANEL_THICKNESS]);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * BLANKET_UV_REPEAT);
      uv.needsUpdate = true;
    }
    const blanketMesh = mergeAndAdd(blanketPieces, blanketMat);

    const framePieces: THREE.BufferGeometry[] = [];
    place(framePieces, unitBox, STATION.frame, [0, 0, 0], [MAST_WIDTH, MAST_HALF_GAP * 2 + PANEL_LENGTH * 2, MAST_WIDTH]);
    place(framePieces, unitCylFine, STATION.frame, [0, 0, 0], [GIMBAL_R * 1.6, GIMBAL_LEN, GIMBAL_R * 1.6], [Math.PI / 2, 0, 0]);
    const frameMesh = mergeAndAdd(framePieces, frameMat);

    pivot.add(blanketMesh, frameMesh);
    group.add(pivot);
    wings.push({ pivot });
  }

  for (const t of templates) t.dispose();

  // ---- orientation -----------------------------------------------------
  const upDir = new THREE.Vector3(0, 1, 0);
  const forwardTarget = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const mT = new THREE.Matrix4();
  const localSun = new THREE.Vector3();

  return {
    group,
    orient(stationPosDir: THREE.Vector3, stationVelDir: THREE.Vector3, sunDir?: THREE.Vector3) {
      forwardTarget.copy(stationVelDir).normalize();
      upDir.copy(stationPosDir).normalize();
      m.lookAt(new THREE.Vector3(0, 0, 0), forwardTarget, upDir);
      group.quaternion.setFromRotationMatrix(m);

      let theta = 0;
      if (sunDir) {
        mT.copy(m).transpose();
        localSun.copy(sunDir).normalize().transformDirection(mT);
        const r = Math.hypot(localSun.y, localSun.z);
        if (r > 1e-6) theta = Math.atan2(-localSun.y, localSun.z);
      }
      for (const w of wings) w.pivot.rotation.x = theta;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const mat of materials) mat.dispose();
      for (const tex of textures) tex.dispose();
    },
  };
}

/** Small baked texture for the solar blankets: deep-blue cells with darker
 *  grid lines and a thin gold edge trim. Repeated along the blanket length. */
function createBlanketTexture(): THREE.CanvasTexture {
  const w = 32;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `#${STATION.panel.getHexString()}`;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = `#${STATION.frame.getHexString()}`;
  ctx.lineWidth = 1;
  const rows = 8;
  for (let i = 1; i < rows; i++) {
    const y = Math.round((i / rows) * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const midX = Math.round(w / 2) + 0.5;
  ctx.beginPath();
  ctx.moveTo(midX, 0);
  ctx.lineTo(midX, h);
  ctx.stroke();

  ctx.strokeStyle = `#${STATION.gold.getHexString()}`;
  ctx.lineWidth = 1.4;
  ctx.strokeRect(0.7, 0.7, w - 1.4, h - 1.4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
