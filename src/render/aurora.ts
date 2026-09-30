// Aurora: curtains along the auroral ovals of a centred geomagnetic dipole
// (north pole 80.7 N / 72.7 W, south = antipode; see astro.ts). Each oval is
// three thin vertical sheets (100 km -> 250 km altitude) forming a closed
// ring around the pole; the ring's magnetic latitude (~70 deg quiet, lower
// with activity, higher on the day side) is computed in the vertex shader
// from a few uniforms, so the geometry is static. The mesh lives under
// Earth's rotating group (Earth-fixed), so it wheels correctly with GMST.
//
// Look: 557.7 nm green with a sharp lower edge fading upward, a faint 630 nm
// red top and a hint of violet at the base; slow folds and rays. Additive,
// depth-tested. Only visible where the Sun is well below the horizon, and
// scaled by a date-seeded Kp-like activity.
// Cost: 2 x (3 sheets x 160 segments) quads; fragments only where sheets cover the screen.
import * as THREE from 'three';
import { AURORA } from './palette';
import { EARTH_RADIUS_KM } from '../types';
import { GEOMAG_POLE_LAT_DEG, GEOMAG_POLE_LON_DEG } from '../sim/astro';

const SEGMENTS = 160;
const SHEETS = 3;
const BOTTOM_KM = 100;
const TOP_KM = 250;

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uE1;
uniform vec3 uE2;
uniform vec3 uPole;
uniform float uBaseLat;     // rad
uniform float uSunAz;       // rad, azimuth of the noon direction about the pole
uniform float uTime;
uniform float uRadius;
uniform float uBottom;
uniform float uHeight;
varying float vAz;
varying float vH;
varying float vSheet;
varying vec3 vObjDir;
varying vec3 vWorld;
void main() {
  float az = position.x;
  float h = position.y;
  float sheet = position.z;
  float off = (sheet - 1.0) * 0.0155;                  // ~ +-1 deg between sheets
  float lat = uBaseLat + 0.07 * cos(az - uSunAz)       // day side is poleward
    + off
    + 0.006 * sin(az * 9.0 + uTime * 0.08 + sheet * 2.0)
    + 0.004 * sin(az * 23.0 - uTime * 0.11);
  vec3 dir = cos(lat) * (cos(az) * uE1 + sin(az) * uE2) + sin(lat) * uPole;
  vObjDir = dir;
  vAz = az;
  vH = h;
  vSheet = sheet;
  vec4 wp = modelMatrix * vec4(dir * (uRadius + uBottom + uHeight * h), 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunObj;
uniform float uTime;
uniform float uActivity;    // 0..1
uniform vec3 uGreen;
uniform vec3 uRed;
uniform vec3 uFringe;
uniform float uIntensity;
varying float vAz;
varying float vH;
varying float vSheet;
varying vec3 vObjDir;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  // derivatives first (uniform control flow)
  float fw = fwidth(vAz) * 300.0 / 6.2832;
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  // only where the emitting air is in the Earth's shadow (Sun well below the horizon)
  float night = 1.0 - smoothstep(-0.2, -0.03, dot(vObjDir, uSunObj));
  if (night < 0.003) discard;

  float a = vAz;
  // large-scale patchiness around the ring, drifting slowly
  float clump = 0.6 * sin(a * 3.0 + 0.5 * sin(a * 7.0 + uTime * 0.05) + vSheet * 1.3 + uTime * 0.02)
              + 0.4 * sin(a * 5.0 - uTime * 0.03 + vSheet * 2.1);
  clump = smoothstep(-0.55, 0.55, clump);
  // folds
  float fold = 0.65 + 0.35 * sin(a * 31.0 + uTime * 0.2 + vSheet * 4.0);
  // fine rays, faded out when they get sub-pixel (no shimmer at a distance)
  float rays = 1.0 - 0.45 * (1.0 - smoothstep(0.15, 0.5, fw)) * (0.5 - 0.5 * sin(a * 300.0 + 4.0 * sin(a * 13.0 + uTime * 0.3)));

  // vertical profile: sharp bright base, exponential fade, faint red on top
  float base = smoothstep(0.0, 0.04, vH);
  float green = exp(-vH * 3.2) * base * (1.0 - smoothstep(0.75, 1.0, vH));
  float red = smoothstep(0.3, 0.9, vH) * (1.0 - smoothstep(0.9, 1.0, vH)) * 0.16;
  float fringe = exp(-vH * 24.0) * 0.45;
  vec3 col = uGreen * green + uRed * red + uFringe * fringe;

  // a sheet seen edge-on is optically thicker than one seen face-on
  float edge = 1.0 - abs(dot(n, normalize(cameraPosition - vWorld)));
  float view = mix(0.3, 1.5, edge * edge);

  float sheetW = vSheet == 1.0 ? 1.0 : 0.55;
  float I = uIntensity * (0.18 + 0.82 * uActivity) * night * clump * fold * rays * view * sheetW;
  gl_FragColor = vec4(col * I, 1.0);
}
`;

function buildGeometry(): THREE.BufferGeometry {
  const pos = new Float32Array(SHEETS * (SEGMENTS + 1) * 2 * 3);
  const idx: number[] = [];
  let v = 0;
  for (let s = 0; s < SHEETS; s++) {
    const first = v;
    for (let i = 0; i <= SEGMENTS; i++) {
      const az = (i / SEGMENTS) * Math.PI * 2;
      for (let k = 0; k < 2; k++) {
        pos[v * 3] = az;
        pos[v * 3 + 1] = k; // 0 bottom, 1 top
        pos[v * 3 + 2] = s;
        v++;
      }
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = first + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** Earth-fixed (object space) unit vector for geographic lat/lon: matches earth.ts. */
function latLonToObj(latDeg: number, lonDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const la = THREE.MathUtils.degToRad(latDeg);
  const lo = THREE.MathUtils.degToRad(lonDeg);
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}

export interface AuroraObjects {
  /** Add to earth.rotGroup (Earth-fixed). */
  group: THREE.Group;
  /**
   * @param sunDirObj  Sun direction in Earth-fixed object space.
   * @param kp         Kp-like activity, 0..9.
   * @param simSeconds shader time (small).
   */
  update(sunDirObj: THREE.Vector3, kp: number, simSeconds: number): void;
  dispose(): void;
}

export function createAurora(): AuroraObjects {
  const geometry = buildGeometry();
  const group = new THREE.Group();
  group.name = 'aurora';

  const northPole = latLonToObj(GEOMAG_POLE_LAT_DEG, GEOMAG_POLE_LON_DEG, new THREE.Vector3());
  const poles = [northPole.clone(), northPole.clone().negate()];
  const y = new THREE.Vector3(0, 1, 0);

  const materials = poles.map((pole) => {
    const e1 = y.clone().addScaledVector(pole, -y.dot(pole)).normalize();
    const e2 = new THREE.Vector3().crossVectors(pole, e1).normalize();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uE1: { value: e1 },
        uE2: { value: e2 },
        uPole: { value: pole },
        uBaseLat: { value: THREE.MathUtils.degToRad(70) },
        uSunAz: { value: 0 },
        uTime: { value: 0 },
        uRadius: { value: EARTH_RADIUS_KM },
        uBottom: { value: BOTTOM_KM },
        uHeight: { value: TOP_KM - BOTTOM_KM },
        uSunObj: { value: new THREE.Vector3(1, 0, 0) },
        uActivity: { value: 0.3 },
        uGreen: { value: AURORA.green },
        uRed: { value: AURORA.red },
        uFringe: { value: AURORA.fringe },
        uIntensity: { value: AURORA.intensity },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1.5; // after the cloud shell (1), before the atmosphere (2)
    group.add(mesh);
    return material;
  });

  return {
    group,
    update(sunDirObj, kp, simSeconds) {
      const k = THREE.MathUtils.clamp(kp / 9, 0, 1);
      // the oval moves equatorward with activity: ~70 deg quiet -> ~61 deg storm
      const baseLat = THREE.MathUtils.degToRad(70 - 9 * k);
      for (const m of materials) {
        const u = m.uniforms;
        (u.uSunObj.value as THREE.Vector3).copy(sunDirObj);
        u.uTime.value = simSeconds;
        u.uActivity.value = k;
        u.uBaseLat.value = baseLat;
        const e1 = u.uE1.value as THREE.Vector3;
        const e2 = u.uE2.value as THREE.Vector3;
        u.uSunAz.value = Math.atan2(sunDirObj.dot(e2), sunDirObj.dot(e1));
      }
    },
    dispose() {
      geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
