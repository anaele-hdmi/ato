// Public render API (see src/types.ts for the shared FrameState contract).
// Floating origin: the station is always at the scene origin; the Earth
// (and everything anchored to it) is translated by -stationPos each frame so
// a 0.1 km station never sits 6371 km from the render origin.
import * as THREE from 'three';
import type { FrameState, Vec3 } from '../types';
import { createEarth } from './earth';
import { createAtmosphere } from './atmosphere';
import { createClouds } from './clouds';
import { createStars } from './stars';
import { createStation } from './station';
import { ChaseCameraController } from './cameraControl';
import { createSun } from './sun';
import { createPost } from './post';
import { SUN, SPACE, STATION } from './palette';

export interface SceneRenderer {
  update(frame: FrameState, dtSec: number): void;
  resize(width: number, height: number, dpr: number): void;
  /** Swing the chase camera so the Sun's direction (above or below the horizon) is in frame. */
  aimAtSun(): void;
  dispose(): void;
}

const MAX_DPR = 1.5;
const CAMERA_NEAR_KM = 0.001;
const CAMERA_FAR_KM = 100000;

function toVec3(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}

/** Rotates a vector by -gmstRad about +Y (undoes the Earth group's spin), to
 *  bring a scene-frame direction into the Earth mesh's object space. */
function rotateYInverse(v: THREE.Vector3, gmstRad: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  const x = v.x * c - v.z * s;
  const z = v.x * s + v.z * c;
  return out.set(x, v.y, z);
}

export async function createSceneRenderer(canvas: HTMLCanvasElement): Promise<SceneRenderer> {
  const scene = new THREE.Scene();
  scene.background = SPACE.black;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.setClearColor(SPACE.black, 1);

  const initialAspect = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 16 / 9;
  const camera = new THREE.PerspectiveCamera(50, initialAspect, CAMERA_NEAR_KM, CAMERA_FAR_KM);

  const earth = createEarth();
  const atmosphere = createAtmosphere();
  const clouds = createClouds();
  earth.rotGroup.add(clouds.mesh);
  earth.pivot.add(atmosphere.mesh);
  scene.add(earth.pivot);
  // Dev/perf-verification hook only (no gameplay effect): lets a screenshot
  // script read live LOD stats via page.evaluate(() => window.__earthStats()).
  (window as unknown as { __earthStats?: () => unknown }).__earthStats = () => earth.getStats();

  const stars = createStars();
  scene.add(stars.points);

  const sun = createSun();
  scene.add(sun.sprite);

  const station = createStation();
  scene.add(station.group);

  const sunLight = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);
  const fill = new THREE.AmbientLight(STATION.ambient, STATION.ambientIntensity);
  scene.add(fill);

  const post = createPost(renderer, scene, camera);

  const cameraControl = new ChaseCameraController(canvas);

  const stationPosVec = new THREE.Vector3();
  const stationVelVec = new THREE.Vector3();
  const sunDirVec = new THREE.Vector3();
  const sunDirObjVec = new THREE.Vector3();
  const upDirVec = new THREE.Vector3();
  const upDirObjVec = new THREE.Vector3();
  const fwdDirVec = new THREE.Vector3();

  function update(frame: FrameState, dtSec: number): void {
    toVec3(frame.stationPos, stationPosVec);
    toVec3(frame.stationVel, stationVelVec);
    toVec3(frame.sunDir, sunDirVec);

    earth.pivot.position.set(-stationPosVec.x, -stationPosVec.y, -stationPosVec.z);
    earth.rotGroup.rotation.y = frame.gmstRad;

    rotateYInverse(sunDirVec, frame.gmstRad, sunDirObjVec);
    earth.setSunDirObject(sunDirObjVec);
    earth.setSunDirWorld(sunDirVec);
    atmosphere.setSunDir(sunDirVec);

    const simSeconds = frame.timeMs / 1000;
    earth.setTime(simSeconds);
    clouds.setSunDirObject(sunDirObjVec);
    clouds.setSunDirWorld(sunDirVec);
    clouds.setTime(simSeconds);

    sunLight.position.copy(sunDirVec);
    sun.setDirection(sunDirVec);

    upDirVec.copy(stationPosVec).normalize();
    fwdDirVec.copy(stationVelVec).normalize();
    station.orient(upDirVec, fwdDirVec, sunDirVec);

    rotateYInverse(upDirVec, frame.gmstRad, upDirObjVec);
    earth.updateLOD(upDirObjVec);

    cameraControl.update(dtSec, camera, upDirVec, fwdDirVec, sunDirVec);

    post.render();
  }

  function resize(width: number, height: number, dpr: number): void {
    renderer.setPixelRatio(Math.min(Math.max(dpr, 1), MAX_DPR));
    renderer.setSize(width, height, false);
    post.resize(width, height, Math.min(Math.max(dpr, 1), MAX_DPR));
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  function dispose(): void {
    cameraControl.dispose();
    earth.dispose();
    atmosphere.dispose();
    clouds.dispose();
    stars.dispose();
    sun.dispose();
    station.dispose();
    sunLight.dispose();
    post.dispose();
    renderer.dispose();
  }

  return { update, resize, aimAtSun: () => cameraControl.aimAtSun(), dispose };
}
