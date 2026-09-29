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
import { createMilkyWay } from './milkyway';
import { createStation } from './station';
import { CameraRig, type CameraMode } from './cameraRig';
import { createSun } from './sun';
import { createPost } from './post';
import { createCloudMap } from './cloudMap';
import { SUN, SPACE, STATION } from './palette';

export interface SceneRenderer {
  update(frame: FrameState, dtSec: number): void;
  resize(width: number, height: number, dpr: number): void;
  /** Swing the chase camera so the Sun's direction (above or below the horizon) is in frame. */
  aimAtSun(): void;
  /** Switches to the next viewpoint and returns it. */
  nextCamera(): CameraMode;
  dispose(): void;
}

const MAX_DPR = 1.5;
const MIN_DPR = 0.75;
// Adaptive resolution: keep the frame rate up on weak phones by lowering the
// render resolution first (cheapest visual cost), then raising it back when
// there is headroom.
const SLOW_FRAME_S = 1 / 45;
const FAST_FRAME_S = 1 / 58;
const DOWNSCALE_AFTER_S = 1.5;
const UPSCALE_AFTER_S = 4;
const SHADER_TIME_EPOCH_MS = Date.UTC(2026, 0, 1);
const SHADER_TIME_WRAP_S = 4 * 86400;
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

  const cloudMap = createCloudMap();
  const earth = createEarth(cloudMap.uniforms);
  const atmosphere = createAtmosphere();
  const clouds = createClouds(cloudMap.uniforms);
  earth.rotGroup.add(clouds.mesh);
  earth.pivot.add(atmosphere.mesh);
  scene.add(earth.pivot);
  // Dev/perf-verification hook only (no gameplay effect): lets a screenshot
  // script read live LOD stats via page.evaluate(() => window.__earthStats()).
  (window as unknown as { __earthStats?: () => unknown }).__earthStats = () => earth.getStats();

  const milkyWay = createMilkyWay(renderer);
  const stars = createStars();
  scene.add(milkyWay.object, stars.object);
  // Eye adaptation for the sky: 1 = dark-adapted (night side), low when the
  // sunlit Earth or the Sun fills the view. Eased so it never pops.
  let skyExposure = 1;
  const camDir = new THREE.Vector3();

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

  // --- adaptive resolution + optional stats overlay (?stats=1) -------------
  let viewW = 1;
  let viewH = 1;
  let deviceDpr = 1;
  let dpr = 1;
  let smoothDt = 1 / 60;
  let slowFor = 0;
  let fastFor = 0;
  const applyDpr = () => {
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewW, viewH, false);
    post.resize(viewW, viewH, dpr);
  };
  const params = new URLSearchParams(location.search);
  const showStats = params.get('stats') === '1';
  // ?adaptive=0 pins the resolution (screenshots, profiling)
  const adaptive = params.get('adaptive') !== '0';
  const statsEl = showStats ? document.createElement('div') : null;
  if (statsEl) {
    statsEl.style.cssText =
      'position:fixed;top:6px;left:8px;z-index:50;font:11px/1.35 monospace;color:#9fb3c8;pointer-events:none;white-space:pre';
    document.body.appendChild(statsEl);
    renderer.info.autoReset = false;
  }
  let statsAcc = 0;

  const rig = new CameraRig(canvas);
  scene.add(rig.frames);
  const eyeWorld = new THREE.Vector3();

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

    // Shader time must stay small: float32 in GLSL can't resolve epoch seconds
    // (~1.8e9), which silently flattened all cloud noise. Seconds since
    // 2026-01-01, wrapped every 4 days (a jump at the wrap is acceptable).
    const simSeconds = ((frame.timeMs - SHADER_TIME_EPOCH_MS) / 1000) % SHADER_TIME_WRAP_S;
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

    // the station is always there; interior views look out from one of its windows
    station.group.updateMatrixWorld();
    eyeWorld.copy(station.eyes[rig.mode === 'chase' ? 'cupola' : rig.mode]).applyMatrix4(station.group.matrixWorld);
    rig.update(dtSec, camera, upDirVec, fwdDirVec, sunDirVec, eyeWorld);

    camera.getWorldDirection(camDir);
    let target = 1;
    if (!frame.inShadow) {
      // daylight: the lit Earth and the Sun dazzle; looking out to space helps a little
      const towardEarth = THREE.MathUtils.smoothstep(camDir.dot(upDirVec) * -1, -0.45, 0.25);
      const towardSun = THREE.MathUtils.smoothstep(camDir.dot(sunDirVec), 0.5, 0.95);
      target = 0.22 * (1 - 0.85 * towardEarth) * (1 - 0.9 * towardSun);
    }
    skyExposure += (target - skyExposure) * Math.min(1, dtSec / 1.8);
    milkyWay.setExposure(skyExposure);
    stars.setExposure(skyExposure);
    milkyWay.update(camera);
    stars.update(camera);

    cloudMap.update(renderer, simSeconds);
    if (statsEl) renderer.info.reset();
    post.render();

    // adaptive resolution
    if (dtSec > 0) smoothDt += (dtSec - smoothDt) * 0.1;
    slowFor = smoothDt > SLOW_FRAME_S ? slowFor + dtSec : 0;
    fastFor = smoothDt < FAST_FRAME_S ? fastFor + dtSec : 0;
    if (!adaptive) {
      /* resolution pinned */
    } else if (slowFor > DOWNSCALE_AFTER_S && dpr > MIN_DPR) {
      dpr = Math.max(MIN_DPR, dpr * 0.85);
      slowFor = 0;
      applyDpr();
    } else if (fastFor > UPSCALE_AFTER_S && dpr < Math.min(deviceDpr, MAX_DPR)) {
      dpr = Math.min(Math.min(deviceDpr, MAX_DPR), dpr / 0.85);
      fastFor = 0;
      applyDpr();
    }

    if (statsEl) {
      statsAcc += dtSec;
      if (statsAcc > 0.5) {
        statsAcc = 0;
        const st = earth.getStats();
        statsEl.textContent =
          `fps ${(1 / smoothDt).toFixed(0)}  dpr ${dpr.toFixed(2)}\n` +
          `tris ${renderer.info.render.triangles}  calls ${renderer.info.render.calls}\n` +
          `terrain chunks ${st.detailChunks}`;
      }
    }
  }

  function resize(width: number, height: number, devicePixelRatio: number): void {
    viewW = width;
    viewH = height;
    const first = deviceDpr === 1 && dpr === 1;
    deviceDpr = Math.max(1, devicePixelRatio);
    if (first || dpr > Math.min(deviceDpr, MAX_DPR)) dpr = Math.min(deviceDpr, MAX_DPR);
    applyDpr();
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  function dispose(): void {
    rig.dispose();
    earth.dispose();
    atmosphere.dispose();
    clouds.dispose();
    cloudMap.dispose();
    stars.dispose();
    milkyWay.dispose();
    sun.dispose();
    station.dispose();
    sunLight.dispose();
    post.dispose();
    renderer.dispose();
  }

  return { update, resize, aimAtSun: () => rig.aimAtSun(), nextCamera: () => rig.next(), dispose };
}
