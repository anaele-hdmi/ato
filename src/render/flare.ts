// Sun glare and lens flare, as ONE extra draw call of screen-space sprites
// (additive, no full-screen pass): a wide veil with faint fine streaks, a
// close glow, thin 8-point diffraction spikes, and five ghosts (soft hexagonal
// aperture shapes / rings) strung along the Sun -> screen-centre axis.
//
// Occlusion (glare and flare fade out, smoothly, when the Sun is hidden):
//  - Earth: analytic. Tangent height of the Sun ray above the surface
//    (sunAtmosphere), smoothstep over -3..+2 km, so at sunrise the glare rises
//    as the limb clears the disc. Also gives the atmospheric reddening.
//  - Station / window frame / cabin wall: GPU occlusion queries. Five
//    depth-tested, colour-less mini quads sit on the Sun's disc (centre + 4
//    around it); each frame they are wrapped in ANY_SAMPLES_PASSED queries and
//    read back asynchronously one or two frames later (never stalls the
//    pipeline). Fraction of visible points x Earth factor, eased over ~0.3 s.
//    Points outside the viewport count as visible (unknown), so the flare
//    survives with the Sun just beyond the screen edge. Chosen over a CPU
//    raycast (needs the low-poly station + cabin geometry in the right frame,
//    fragile with the cabin's shader-side holes) and over readPixels of depth
//    (GPU sync stall on mobile): 5 tiny draws, no readback stall.
//
// `?flare=0` turns the whole thing (and the exposure dip) off.
import * as THREE from 'three';
import { FLARE, SUN } from './palette';
import { SUN_DISTANCE_KM, SUN_RENDER_ORDER, sunAtmosphere, type SunAtmosphere } from './sun';

export function urlWantsFlare(): boolean {
  if (typeof window === 'undefined' || !window.location) return true;
  try {
    return new URLSearchParams(window.location.search).get('flare') !== '0';
  } catch {
    return true;
  }
}

const VERTEX = /* glsl */ `
attribute vec4 aP;   // t, size, kind, gain
attribute vec3 aCol;
uniform vec2 uSun;
uniform float uAspect;
varying vec2 vUv;
varying vec4 vP;
varying vec3 vCol;
void main() {
  vUv = position.xy;
  vP = aP;
  vCol = aCol;
  vec2 c = uSun * aP.x;
  gl_Position = vec4(c + position.xy * vec2(aP.y / uAspect, aP.y), 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uTint;
uniform float uStr;     // glare strength (spikes, veil, core)
uniform float uGhost;   // ghost strength
varying vec2 vUv;
varying vec4 vP;
varying vec3 vCol;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float a = atan(vUv.y, vUv.x);
  float kind = vP.z;
  vec3 col = vec3(0.0);
  if (kind < 0.5) {
    // veil + faint natural streaks (many fine radial rays of uneven strength)
    float veil = pow(1.0 - r, 3.0) * 1.1 / (1.0 + r * 5.0);
    float sector = floor((a + 3.14159) * 90.0 / 6.28318);
    float rays = pow(hash(sector), 6.0) * pow(1.0 - r, 2.0) * 0.07;
    col = uTint * vP.w * (veil + rays) * uStr;
  } else if (kind < 1.5) {
    // 8 thin diffraction spikes: constant width (distance to the nearest axis)
    float k = 0.785398;
    float da = mod(a + 0.2 + k * 0.5, k) - k * 0.5;
    float idx = floor((a + 0.2 + k * 0.5) / k);
    float len = 0.65 + 0.35 * hash(idx + 3.0);
    float d = abs(sin(da)) * r;
    float line = exp(-d * d / 0.000045);
    float fall = pow(1.0 - r, 2.0) / (1.0 + r * 16.0) * (1.0 - smoothstep(len * 0.6, len, r));
    col = uTint * vP.w * line * fall * 6.0 * uStr;
  } else if (kind < 2.5) {
    col = uTint * vP.w * exp(-r * r * 14.0) * uStr;
  } else {
    // ghost: hexagonal aperture, filled (soft, brighter toward the rim) or ring
    float seg = 1.0471976;
    float ga = a + 0.3;
    float d = cos(floor(0.5 + ga / seg) * seg - ga) * r * 1.155;
    float fillv = (1.0 - smoothstep(0.55, 1.0, d)) * (0.5 + 0.5 * smoothstep(0.0, 0.8, d));
    float ring = smoothstep(0.45, 0.85, d) * (1.0 - smoothstep(0.85, 1.0, d));
    float shape = mix(fillv, ring, step(3.5, vP.z));
    col = vCol * mix(vec3(1.0), uTint, 0.5) * vP.w * shape * uGhost;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

interface QueryPoint {
  mesh: THREE.Mesh;
  q: WebGLQuery | null;
  pending: boolean;
  active: boolean;
  vis: number;
}

// disc-radius offsets of the sample points (in screen right/up)
const SAMPLE_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [0.6, 0],
  [-0.6, 0],
  [0, 0.6],
  [0, -0.6],
];

export interface Flare {
  /** 0..1: how much the Sun dazzles (visible, in or near the view, not hidden); feeds the auto exposure. */
  readonly glare: number;
  /** Call every frame after the camera has moved, before rendering. eye = camera world position. */
  update(camera: THREE.PerspectiveCamera, eye: THREE.Vector3, sunDir: THREE.Vector3, earthRel: THREE.Vector3, dtSec: number): void;
  dispose(): void;
}

export function createFlare(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Flare {
  // ---- screen-space sprite batch -----------------------------------------
  type Q = { t: number; size: number; kind: number; gain: number; color: THREE.Color };
  const quads: Q[] = [
    { t: 1, size: 1.25, kind: 0, gain: FLARE.halo, color: SUN.disc },
    { t: 1, size: 0.55, kind: 2, gain: FLARE.core, color: SUN.disc },
    { t: 1, size: 0.85, kind: 1, gain: FLARE.spike, color: SUN.disc },
    ...FLARE.ghosts.map((g) => ({ t: g.t, size: g.size, kind: 3 + g.ring, gain: g.gain * FLARE.ghost, color: g.color })),
  ];
  const n = quads.length;
  const pos = new Float32Array(n * 4 * 3);
  const aP = new Float32Array(n * 4 * 4);
  const aCol = new Float32Array(n * 4 * 3);
  const idx: number[] = [];
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  quads.forEach((q, i) => {
    for (let c = 0; c < 4; c++) {
      const vi = i * 4 + c;
      pos[vi * 3] = corners[c * 2];
      pos[vi * 3 + 1] = corners[c * 2 + 1];
      aP.set([q.t, q.size, q.kind, q.gain], vi * 4);
      aCol.set([q.color.r, q.color.g, q.color.b], vi * 3);
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aP', new THREE.BufferAttribute(aP, 4));
  geo.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3));
  geo.setIndex(idx);
  const uniforms = {
    uSun: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uStr: { value: 0 },
    uGhost: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    // keep the destination alpha (chase-view DOF mask lives there)
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = SUN_RENDER_ORDER + 10;
  mesh.visible = false;
  scene.add(mesh);

  // ---- occlusion query points --------------------------------------------
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const canQuery = typeof gl.createQuery === 'function';
  const qGeo = new THREE.PlaneGeometry(1, 1);
  const qMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true });
  const discSize = 2 * SUN_DISTANCE_KM * Math.tan(THREE.MathUtils.degToRad(SUN.discRadiusDeg));
  const points: QueryPoint[] = [];
  if (canQuery) {
    for (let i = 0; i < SAMPLE_OFFSETS.length; i++) {
      const m = new THREE.Mesh(qGeo, qMat);
      m.scale.set(discSize * 0.25, discSize * 0.25, 1);
      m.frustumCulled = false;
      m.renderOrder = SUN_RENDER_ORDER + 1;
      m.visible = false;
      const p: QueryPoint = { mesh: m, q: null, pending: false, active: false, vis: 1 };
      m.onBeforeRender = () => {
        if (p.pending) return;
        p.q ??= gl.createQuery();
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, p.q);
        p.active = true;
      };
      m.onAfterRender = () => {
        if (!p.active) return;
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
        p.active = false;
        p.pending = true;
      };
      scene.add(m);
      points.push(p);
    }
  }

  const atm: SunAtmosphere = { h: Infinity, earthVis: 1, trans: new THREE.Color(1, 1, 1) };
  const v = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let vis = 0;
  let glare = 0;

  function ndcOf(camera: THREE.PerspectiveCamera, dir: THREE.Vector3, out: THREE.Vector2): boolean {
    v.copy(dir).transformDirection(camera.matrixWorldInverse);
    if (v.z > -0.02) return false;
    out.set((v.x * camera.projectionMatrix.elements[0]) / -v.z, (v.y * camera.projectionMatrix.elements[5]) / -v.z);
    return true;
  }
  const sunNdc = new THREE.Vector2();
  const ptNdc = new THREE.Vector2();

  return {
    get glare() {
      return glare;
    },
    update(camera, eye, sunDir, earthRel, dtSec) {
      camera.updateMatrixWorld();
      sunAtmosphere(sunDir, earthRel, atm);
      const front = ndcOf(camera, sunDir, sunNdc);

      // collect finished queries, place this frame's sample points
      camRight.setFromMatrixColumn(camera.matrixWorld, 0);
      camUp.setFromMatrixColumn(camera.matrixWorld, 1);
      const discR = Math.tan(THREE.MathUtils.degToRad(SUN.discRadiusDeg));
      let seen = 0;
      points.forEach((p, i) => {
        if (p.pending && p.q && gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
          p.vis = gl.getQueryParameter(p.q, gl.QUERY_RESULT) ? 1 : 0;
          p.pending = false;
        }
        const [ox, oy] = SAMPLE_OFFSETS[i];
        tmp.copy(sunDir).addScaledVector(camRight, ox * discR).addScaledVector(camUp, oy * discR).normalize();
        p.mesh.position.copy(eye).addScaledVector(tmp, SUN_DISTANCE_KM);
        p.mesh.quaternion.copy(camera.quaternion);
        p.mesh.visible = front;
        // points outside the viewport cannot be tested: count them as visible
        const inside = front && ndcOf(camera, tmp, ptNdc) && Math.abs(ptNdc.x) < 1 && Math.abs(ptNdc.y) < 1;
        seen += inside ? p.vis : 1;
      });
      const qVis = points.length ? seen / points.length : 1;

      const target = front ? qVis * atm.earthVis : 0;
      const tau = target > vis ? 0.3 : 0.12;
      vis += (target - vis) * (1 - Math.exp(-Math.min(dtSec, 0.25) / tau));
      if (Math.abs(target - vis) < 0.002) vis = target;

      const edge = Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y));
      const fadeOff = front ? 1 - THREE.MathUtils.smoothstep(edge, 1.0, 1.8) : 0;
      const t = atm.trans;
      const bright = 0.15 + 0.85 * Math.sqrt(t.g);
      uniforms.uSun.value.copy(sunNdc);
      uniforms.uAspect.value = camera.aspect;
      uniforms.uStr.value = vis * fadeOff * bright;
      uniforms.uGhost.value = vis * fadeOff * bright;
      const k = Math.min(1 / Math.pow(Math.max(t.r, 1e-3), 0.7), 3);
      uniforms.uTint.value.copy(SUN.disc).multiply(t).multiplyScalar(k);
      mesh.visible = uniforms.uStr.value > 0.003;
      glare = vis * (front ? 1 - THREE.MathUtils.smoothstep(edge, 0.7, 1.5) : 0) * bright;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      qGeo.dispose();
      qMat.dispose();
      for (const p of points) if (p.q) gl.deleteQuery(p.q);
      scene.remove(mesh, ...points.map((p) => p.mesh));
    },
  };
}
