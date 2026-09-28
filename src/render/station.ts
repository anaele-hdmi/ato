// A stylized, fictional ISS-like station: truss + 4 solar panel pairs + a few
// modules, flat-shaded boxes/cylinders. No real ISS imagery or markings.
// LVLH-oriented: local -Z = velocity (forward), local +Y = away from Earth (up).
import * as THREE from 'three';
import { STATION } from './palette';

const TRUSS_LENGTH = 0.09; // km
const TRUSS_SECTION = 0.006;
const PANEL_COUNT_PAIRS = 4;
const PANEL_LENGTH = 0.034;
const PANEL_WIDTH = 0.013;
const PANEL_THICKNESS = 0.0006;
const PANEL_GAP = 0.004;
const MODULE_RADIUS = 0.0045;
const MODULE_LENGTH = 0.026;

export interface StationObjects {
  group: THREE.Group;
  /** Orients the group LVLH: local -Z = forward (velocity), local +Y = up (away from Earth). */
  orient(stationPosDir: THREE.Vector3, stationVelDir: THREE.Vector3): void;
  dispose(): void;
}

export function createStation(): StationObjects {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const trussMat = new THREE.MeshLambertMaterial({ color: STATION.truss });
  const panelMat = new THREE.MeshLambertMaterial({ color: STATION.panel });
  const moduleMat = new THREE.MeshLambertMaterial({ color: STATION.module });
  const hullMat = new THREE.MeshLambertMaterial({ color: STATION.hull });
  materials.push(trussMat, panelMat, moduleMat, hullMat);

  // main truss, along local X
  const trussGeo = new THREE.BoxGeometry(TRUSS_LENGTH, TRUSS_SECTION, TRUSS_SECTION);
  geometries.push(trussGeo);
  const truss = new THREE.Mesh(trussGeo, trussMat);
  group.add(truss);

  // solar panel pairs, distributed along the truss, extending +/-Z
  const panelGeo = new THREE.BoxGeometry(PANEL_WIDTH, PANEL_THICKNESS, PANEL_LENGTH);
  geometries.push(panelGeo);
  for (let i = 0; i < PANEL_COUNT_PAIRS; i++) {
    const t = (i + 0.5) / PANEL_COUNT_PAIRS - 0.5;
    const x = t * (TRUSS_LENGTH - TRUSS_SECTION);
    for (const side of [1, -1]) {
      const panel = new THREE.Mesh(panelGeo, panelMat);
      panel.position.set(x, 0, side * (PANEL_LENGTH / 2 + PANEL_GAP));
      group.add(panel);

      // thin mast connecting panel to truss
      const mastGeo = new THREE.BoxGeometry(0.0015, 0.0015, PANEL_GAP);
      geometries.push(mastGeo);
      const mast = new THREE.Mesh(mastGeo, hullMat);
      mast.position.set(x, 0, side * (PANEL_GAP / 2));
      group.add(mast);
    }
  }

  // module chain (pressurized modules), hanging along local -Z from truss centre, slightly below (-Y)
  const moduleGeo = new THREE.CylinderGeometry(MODULE_RADIUS, MODULE_RADIUS, MODULE_LENGTH, 12);
  geometries.push(moduleGeo);
  const moduleCount = 3;
  for (let i = 0; i < moduleCount; i++) {
    const module = new THREE.Mesh(moduleGeo, moduleMat);
    module.rotation.x = Math.PI / 2; // cylinder axis Y -> Z
    module.position.set(0, -TRUSS_SECTION / 2 - MODULE_RADIUS, -(i + 1) * (MODULE_LENGTH * 0.92));
    group.add(module);
  }

  // small cupola-ish nub at the end, nadir-facing detail
  const cupolaGeo = new THREE.SphereGeometry(MODULE_RADIUS * 0.9, 10, 8);
  geometries.push(cupolaGeo);
  const cupola = new THREE.Mesh(cupolaGeo, hullMat);
  cupola.position.set(0, -TRUSS_SECTION / 2 - MODULE_RADIUS * 1.6, -moduleCount * (MODULE_LENGTH * 0.92) - MODULE_LENGTH * 0.3);
  group.add(cupola);

  const upDir = new THREE.Vector3(0, 1, 0);
  const forwardTarget = new THREE.Vector3();
  const m = new THREE.Matrix4();

  return {
    group,
    orient(stationPosDir: THREE.Vector3, stationVelDir: THREE.Vector3) {
      forwardTarget.copy(stationVelDir).normalize();
      upDir.copy(stationPosDir).normalize();
      m.lookAt(new THREE.Vector3(0, 0, 0), forwardTarget, upDir);
      group.quaternion.setFromRotationMatrix(m);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const mat of materials) mat.dispose();
    },
  };
}
