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
import { createMoon, moonEclipseFactor } from './moon';
import { createAurora } from './aurora';
import { createMeteors } from './meteors';
import { dailyKp, nlcSeason } from '../sim/astro';
import { SUN, SPACE, STATION } from './palette';

export interface SceneRenderer {
  update(frame: FrameState, dtSec: number): void;
  resize(width: number, height: number, dpr: number): void;
  /** Swing the chase camera so the Sun's direction (above or below the horizon) is in frame. */
  aimAtSun(): void;
  /** Switches to the next viewpoint and returns it. */
  nextCamera(): CameraMode;
  /**
   * Moon as seen from the station, refreshed every update(): `dirWorld` is the
   * unit direction (scene/world frame), `illum` the relative moonlight
   * illuminance (phase x distance; full moon at mean distance = 1, quarter ~0.09).
   * For lighting clouds / sea with moonlight.
   */
  readonly moon: { readonly dirWorld: THREE.Vector3; illum: number };
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
// hull shadow map: 1024^2 ortho map around the station (arrays reach ~27 m)
const SHADOW_MAP = 1024;
const SHADOW_HALF_KM = 0.03;
const SHADOW_DIST_KM = 0.1;
const SHADOW_EVERY_N_FRAMES = 6;

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
  // Hull-to-hull shadows only (station meshes cast/receive). The map is never
  // auto-rendered: update() requests a refresh a few times a second, chase view only.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const initialAspect = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 16 / 9;
  const camera = new THREE.PerspectiveCamera(50, initialAspect, CAMERA_NEAR_KM, CAMERA_FAR_KM);

  const cloudMap = createCloudMap();
  const earth = createEarth(cloudMap.uniforms);
  const atmosphere = createAtmosphere();
  const clouds = createClouds(cloudMap.uniforms);
  cloudMap.setSurface(earth.material.uniforms.uLandTex.value, earth.material.uniforms.uBiomeTex.value);
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

  const moon = createMoon();
  scene.add(moon.mesh);
  const moonInfo = { dirWorld: new THREE.Vector3(1, 0, 0), illum: 0 };
  const moonPosVec = new THREE.Vector3();
  const moonObjVec = new THREE.Vector3();
  const aurora = createAurora();
  earth.rotGroup.add(aurora.group);
  const meteors = createMeteors();
  scene.add(meteors.mesh);

  const station = createStation();
  scene.add(station.group);

  // Space lighting: no ambient sky. Sun (hard), earthshine from below (day
  // side only), faint moonlight and a starlight floor. Only the station's
  // Lambert/Phong materials see these lights.
  const sunLight = new THREE.DirectionalLight(SUN.color, STATION.sunIntensity);
  sunLight.target.position.set(0, 0, 0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const sc = sunLight.shadow.camera;
  sc.left = -SHADOW_HALF_KM;
  sc.right = SHADOW_HALF_KM;
  sc.top = SHADOW_HALF_KM;
  sc.bottom = -SHADOW_HALF_KM;
  sc.near = SHADOW_DIST_KM - SHADOW_HALF_KM * 1.6;
  sc.far = SHADOW_DIST_KM + SHADOW_HALF_KM * 1.6;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.00004;
  scene.add(sunLight);
  scene.add(sunLight.target);
  const earthLight = new THREE.DirectionalLight(STATION.earthshine, 0);
  earthLight.target.position.set(0, 0, 0);
  scene.add(earthLight, earthLight.target);
  const earthWide = new THREE.HemisphereLight(0x000000, STATION.earthshine, 0);
  scene.add(earthWide);
  const moonLight = new THREE.DirectionalLight(STATION.moonlight, 0);
  moonLight.target.position.set(0, 0, 0);
  scene.add(moonLight, moonLight.target);
  const starFill = new THREE.AmbientLight(STATION.starlight, STATION.starlightIntensity);
  scene.add(starFill);
  let sunFade = 1; // eased 0..1 as the station enters / leaves Earth's shadow
  let shadowTick = 0;
  let shadowWasChase = false;
  let shadowPrimed = false;
  const hDir = new THREE.Vector3();

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
    earth.setDate(frame.timeMs);
    clouds.setSunDirObject(sunDirObjVec);
    clouds.setSunDirWorld(sunDirVec);
    clouds.setTime(simSeconds);

    sun.setDirection(sunDirVec);

    upDirVec.copy(stationPosVec).normalize();
    fwdDirVec.copy(stationVelVec).normalize();

    // --- station lights ---
    // Sun: full unless the station is in Earth's shadow (eased over ~0.7 s).
    sunFade += ((frame.inShadow ? 0 : 1) - sunFade) * Math.min(1, dtSec / 0.7);
    sunLight.position.copy(sunDirVec).multiplyScalar(SHADOW_DIST_KM);
    sunLight.intensity = STATION.sunIntensity * sunFade;
    // Earthshine: the lit Earth below. Strong when the sub-station point is in
    // daylight, gone past the terminator; near the terminator it comes from
    // the day-side horizon rather than straight below.
    const sunUp = sunDirVec.dot(upDirVec);
    const dayBelow = THREE.MathUtils.smoothstep(sunUp, -0.3, 0.5);
    hDir.copy(sunDirVec).addScaledVector(upDirVec, -sunUp);
    if (hDir.lengthSq() > 1e-6) hDir.normalize();
    earthLight.position.copy(upDirVec).multiplyScalar(-(0.6 + 0.4 * dayBelow)).addScaledVector(hDir, 0.45 * (1 - dayBelow));
    earthLight.intensity = STATION.earthshineDay * dayBelow;
    earthWide.position.copy(upDirVec);
    earthWide.intensity = STATION.earthshineDay * STATION.earthshineWide * dayBelow;
    // Moonlight: night side only, and not from behind the Earth.
    const moonAbove = THREE.MathUtils.smoothstep(moonInfo.dirWorld.dot(upDirVec), -0.36, -0.2);
    moonLight.position.copy(moonInfo.dirWorld);
    moonLight.intensity = STATION.moonlightIntensity * moonInfo.illum * moonAbove * (1 - sunFade);
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

    // Moon: true station-centric direction (parallax up to ~1 deg), in the same
    // eye adaptation as the stars.
    toVec3(frame.moon.pos, moonPosVec);
    const moonEclipse = moonEclipseFactor(moonPosVec, sunDirVec);
    const moonToStation = moonPosVec.sub(stationPosVec);
    moonInfo.dirWorld.copy(moonToStation).normalize();
    moonInfo.illum = frame.moon.illuminance;
    rotateYInverse(moonInfo.dirWorld, frame.gmstRad, moonObjVec);
    earth.setMoon(moonInfo.dirWorld, moonObjVec, moonInfo.illum);
    clouds.setMoon(moonObjVec, moonInfo.illum);
    moon.setExposure(skyExposure);
    moon.update(camera, {
      dirWorld: moonInfo.dirWorld,
      distKm: moonToStation.length(),
      sunDirWorld: sunDirVec,
      earthCenter: earth.pivot.position,
      eclipse: moonEclipse,
      illum: frame.moon.illumFraction,
    });

    aurora.update(sunDirObjVec, dailyKp(frame.timeMs), simSeconds);
    const nlc = nlcSeason(frame.timeMs);
    atmosphere.setNlcSeason(nlc.north, nlc.south);
    meteors.update(dtSec, camera, viewH * dpr, stationPosVec, sunDirVec, frame.timeMs);

    cloudMap.setClimate(frame.timeMs, sunDirObjVec);
    cloudMap.update(renderer, simSeconds);
    // hull shadows: chase view only, a few times a second (never in cabin views)
    const chaseNow = rig.mode === 'chase';
    if (!shadowPrimed) {
      // one render up front so the depth texture exists before any lit draw
      shadowPrimed = true;
      renderer.shadowMap.needsUpdate = true;
    } else if (chaseNow && sunFade > 0.02) {
      if (!shadowWasChase || ++shadowTick >= SHADOW_EVERY_N_FRAMES) {
        renderer.shadowMap.needsUpdate = true;
        shadowTick = 0;
      }
    }
    shadowWasChase = chaseNow;
    if (statsEl) renderer.info.reset();
    post.setDof(rig.dofTarget());
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
    moon.dispose();
    aurora.dispose();
    meteors.dispose();
    station.dispose();
    sunLight.dispose();
    sunLight.shadow.dispose();
    earthLight.dispose();
    moonLight.dispose();
    post.dispose();
    renderer.dispose();
  }

  return { update, resize, aimAtSun: () => rig.aimAtSun(), nextCamera: () => rig.next(), moon: moonInfo, dispose };
}
