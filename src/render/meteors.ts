// Meteors seen from above: brief streaks 80-110 km up, i.e. ~300-350 km below
// the station, drawn over the dark night side of the Earth.
//
// A meteor is a short ribbon (one quad, camera-facing about its own axis)
// between a fading tail and a bright head that moves at ~60 km/s for well
// under a second. Positions are stored geocentrically (scene frame) and
// re-expressed relative to the station every frame, so the station's own
// motion gives correct parallax. Spawning is a Poisson process: sporadic
// background ~1 per 4 minutes (of real time) times the shower factor for the
// date (astro.ts: meteorRateFactor). A meteor is placed at a random point of
// what the camera is currently looking at (so it is on screen), only over
// ground that is in darkness, and never while time is sped up.
// Cost: nothing when no meteor is active; otherwise <= 4 quads.
import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../types';
import { meteorRateFactor } from '../sim/astro';
import { METEOR } from './palette';

const POOL = 4;
/** Sporadic background rate per real second (~1 per 4 minutes). */
const BASE_RATE_PER_S = 1 / 240;
const MAX_TRAIL_KM = 16;
const SPEED_KM_S = 62;
/** Ribbon width in device pixels. */
const WIDTH_PX = 3;

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aInfo; // x: side -1..1, y: along 0 (tail) .. 1 (head), z: brightness
varying vec3 vInfo;
void main() {
  vInfo = aInfo;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uHead;
uniform vec3 uTail;
uniform float uIntensity;
varying vec3 vInfo;
void main() {
  #include <logdepthbuf_fragment>
  float across = exp(-vInfo.x * vInfo.x * 3.0);
  float along = pow(vInfo.y, 2.2);
  vec3 col = mix(uTail, uHead, smoothstep(0.55, 1.0, vInfo.y));
  gl_FragColor = vec4(col * across * along * vInfo.z * uIntensity, 1.0);
}
`;

interface Meteor {
  active: boolean;
  age: number;
  life: number;
  start: THREE.Vector3; // geocentric, scene frame, km
  vel: THREE.Vector3; // km/s
  trail: number;
  peak: number;
}

export interface MeteorObjects {
  mesh: THREE.Mesh;
  update(
    dtSec: number,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
    stationPos: THREE.Vector3,
    sunDirWorld: THREE.Vector3,
    timeMs: number,
  ): void;
  dispose(): void;
}

export function createMeteors(): MeteorObjects {
  const positions = new Float32Array(POOL * 4 * 3);
  const info = new Float32Array(POOL * 4 * 3);
  const index: number[] = [];
  for (let i = 0; i < POOL; i++) {
    const b = i * 4;
    index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    // vertex order: tail-left, tail-right, head-left, head-right
    info.set([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], i * 12);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(index);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHead: { value: METEOR.head },
      uTail: { value: METEOR.tail },
      uIntensity: { value: METEOR.intensity },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1.6;
  mesh.visible = false;
  mesh.name = 'meteors';

  const pool: Meteor[] = Array.from({ length: POOL }, () => ({
    active: false,
    age: 0,
    life: 1,
    start: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    trail: 10,
    peak: 1,
  }));

  const camPos = new THREE.Vector3();
  const camGeo = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const up = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const head = new THREE.Vector3();
  const tail = new THREE.Vector3();
  const side = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const mid = new THREE.Vector3();
  let lastTimeMs = NaN;

  function trySpawn(camera: THREE.PerspectiveCamera, stationPos: THREE.Vector3, sunDirWorld: THREE.Vector3): void {
    const m = pool.find((p) => !p.active);
    if (!m) return;
    camera.getWorldPosition(camPos);
    camGeo.copy(camPos).add(stationPos); // geocentric
    const shell = EARTH_RADIUS_KM + 88 + Math.random() * 22;
    for (let attempt = 0; attempt < 6; attempt++) {
      // a random point of the current view
      dir
        .set(Math.random() * 1.6 - 0.8, Math.random() * 1.6 - 0.8, 0.5)
        .unproject(camera)
        .sub(camPos)
        .normalize();
      const b = camGeo.dot(dir);
      const c = camGeo.lengthSq() - shell * shell;
      const disc = b * b - c;
      if (disc <= 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t <= 0) continue;
      hit.copy(camGeo).addScaledVector(dir, t);
      up.copy(hit).normalize();
      // only over dark ground (Sun > ~9 deg below the horizon there)
      if (up.dot(sunDirWorld) > -0.16) continue;
      // horizontal direction at random, descending 15-45 deg
      tmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      tmp.addScaledVector(up, -tmp.dot(up));
      if (tmp.lengthSq() < 1e-4) continue;
      tmp.normalize();
      const pitch = THREE.MathUtils.degToRad(15 + Math.random() * 30);
      m.vel.copy(tmp).multiplyScalar(Math.cos(pitch)).addScaledVector(up, -Math.sin(pitch)).multiplyScalar(SPEED_KM_S);
      m.start.copy(hit);
      m.age = 0;
      m.life = 0.35 + Math.random() * 0.5;
      m.trail = 6 + Math.random() * (MAX_TRAIL_KM - 6);
      m.peak = 0.55 + Math.random() * 0.45;
      m.active = true;
      return;
    }
  }

  return {
    mesh,
    update(dtSec, camera, viewportHeightPx, stationPos, sunDirWorld, timeMs) {
      const dt = Math.min(Math.max(dtSec, 0), 0.25);
      // real-time spawning only while the clock runs at ~real speed
      const simRate = dt > 0 && Number.isFinite(lastTimeMs) ? Math.abs(timeMs - lastTimeMs) / 1000 / dt : 1;
      lastTimeMs = timeMs;
      if (dt > 0 && simRate < 3) {
        const rate = BASE_RATE_PER_S * meteorRateFactor(timeMs);
        if (Math.random() < 1 - Math.exp(-rate * dt)) trySpawn(camera, stationPos, sunDirWorld);
      }

      let any = false;
      camera.getWorldPosition(camPos);
      const pxKm = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeightPx);
      for (let i = 0; i < POOL; i++) {
        const m = pool[i];
        const o = i * 12;
        if (m.active) {
          m.age += dt;
          if (m.age >= m.life || simRate > 3) m.active = false;
        }
        if (!m.active) {
          positions.fill(0, o, o + 12);
          continue;
        }
        any = true;
        const travelled = m.age * SPEED_KM_S;
        head.copy(m.start).addScaledVector(m.vel, m.age);
        tail.copy(m.start).addScaledVector(m.vel, Math.max(0, travelled - m.trail) / SPEED_KM_S);
        // to station-relative (world) coordinates
        head.sub(stationPos);
        tail.sub(stationPos);
        mid.copy(head).add(tail).multiplyScalar(0.5);
        const dist = Math.max(mid.distanceTo(camPos), 1);
        const half = 0.5 * WIDTH_PX * pxKm * dist;
        axis.copy(head).sub(tail);
        // extend a little so very short streaks are still a visible dot
        const len = axis.length();
        if (len > 1e-6) axis.multiplyScalar(1 / len);
        tmp.copy(mid).sub(camPos);
        side.crossVectors(axis, tmp).normalize().multiplyScalar(half);
        head.addScaledVector(axis, half);
        tail.addScaledVector(axis, -half);
        const p = positions;
        p[o] = tail.x - side.x;
        p[o + 1] = tail.y - side.y;
        p[o + 2] = tail.z - side.z;
        p[o + 3] = tail.x + side.x;
        p[o + 4] = tail.y + side.y;
        p[o + 5] = tail.z + side.z;
        p[o + 6] = head.x - side.x;
        p[o + 7] = head.y - side.y;
        p[o + 8] = head.z - side.z;
        p[o + 9] = head.x + side.x;
        p[o + 10] = head.y + side.y;
        p[o + 11] = head.z + side.z;
        // quick rise, slower fall
        const u = m.age / m.life;
        const env = Math.sin(Math.PI * Math.pow(u, 0.6));
        const br = m.peak * Math.max(env, 0);
        info[o + 2] = br;
        info[o + 5] = br;
        info[o + 8] = br;
        info[o + 11] = br;
      }
      mesh.visible = any;
      if (any) {
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.aInfo.needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
