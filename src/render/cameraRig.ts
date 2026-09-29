// Viewpoints (design §3). Three "from the station" views share one look
// controller parametrised as (azimuth, tilt-from-nadir, fov); the external
// chase view keeps its own controller.
//
//   cupola : inside the Earth-facing window; frame in the foreground
//   aft    : looking back over the truss and solar wings to the horizon
//   limb   : telephoto on the horizon (atmosphere layers, sunrise)
//   zenith : a round window on the top of the station, for the stars
//   chase  : outside the station (the only view where the station is visible)
import * as THREE from 'three';
import { ChaseCameraController } from './cameraControl';

export type CameraMode = 'cupola' | 'aft' | 'limb' | 'zenith' | 'chase';
export const CAMERA_ORDER: CameraMode[] = ['cupola', 'aft', 'limb', 'zenith', 'chase'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  cupola: 'キューポラ',
  aft: '後方',
  limb: '地平線',
  zenith: '天頂',
  chase: '外から',
};

const DEG = Math.PI / 180;
// From 420 km the horizon lies ~70° from nadir.
const HORIZON_TILT = 70 * DEG;

interface LookParams {
  /** azimuth the window faces (0 = forward, π = aft) */
  azCenter?: number;
  /** azimuth limits relative to azCenter (radians); omit = free */
  azMin?: number;
  azMax?: number;
  tiltMin: number;
  tiltMax: number;
  tiltDefault: number;
  fovMin: number;
  fovMax: number;
  fovDefault: number;
}

const LOOK: Record<Exclude<CameraMode, 'chase'>, LookParams> = {
  cupola: { tiltMin: 0, tiltMax: 80 * DEG, tiltDefault: 42 * DEG, fovMin: 40, fovMax: 75, fovDefault: 62 },
  aft: { azCenter: Math.PI, azMin: -60 * DEG, azMax: 60 * DEG, tiltMin: 55 * DEG, tiltMax: 100 * DEG, tiltDefault: 76 * DEG, fovMin: 30, fovMax: 75, fovDefault: 58 },
  limb: { azMin: -38 * DEG, azMax: 38 * DEG, tiltMin: HORIZON_TILT - 14 * DEG, tiltMax: HORIZON_TILT + 12 * DEG, tiltDefault: HORIZON_TILT + 1 * DEG, fovMin: 4, fovMax: 30, fovDefault: 14 },
  zenith: { tiltMin: 135 * DEG, tiltMax: 180 * DEG, tiltDefault: 165 * DEG, fovMin: 40, fovMax: 85, fovDefault: 70 },
};

const DRAG_RAD_PER_PX = 0.0035;
const CHASE_FOV = 50;

/** Drag = azimuth / tilt, pinch & wheel = field of view. Drag speed scales with zoom. */
class LookController {
  enabled = false;
  azimuth = 0;
  tilt = 0;
  fov = 60;
  params: LookParams = LOOK.cupola;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private pinchFov = 60;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
  }

  setParams(p: LookParams): void {
    this.params = p;
    this.tilt = p.tiltDefault;
    this.fov = p.fovDefault;
    this.azimuth = p.azCenter ?? 0;
  }

  clampAz(a: number): number {
    const { azMin, azMax } = this.params;
    if (azMin === undefined || azMax === undefined) return a;
    const c = this.params.azCenter ?? 0;
    // wrap relative to the window's facing before clamping
    const rel = Math.atan2(Math.sin(a - c), Math.cos(a - c));
    return c + THREE.MathUtils.clamp(rel, azMin, azMax);
  }

  private pinchDistance(): number {
    const pts = [...this.pointers.values()];
    return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private readonly down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.pinchStart = this.pinchDistance();
      this.pinchFov = this.fov;
    }
  };

  private readonly move = (e: PointerEvent) => {
    if (!this.enabled) return;
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      const k = DRAG_RAD_PER_PX * (this.fov / 60);
      this.azimuth = this.clampAz(this.azimuth - (e.clientX - prev.x) * k);
      this.tilt = THREE.MathUtils.clamp(this.tilt + (e.clientY - prev.y) * k, this.params.tiltMin, this.params.tiltMax);
    } else if (this.pointers.size === 2 && this.pinchStart > 0) {
      const f = this.pinchFov * (this.pinchStart / Math.max(1, this.pinchDistance()));
      this.fov = THREE.MathUtils.clamp(f, this.params.fovMin, this.params.fovMax);
    }
  };

  private readonly up = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };

  private readonly wheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.fov = THREE.MathUtils.clamp(this.fov * Math.exp(e.deltaY * 0.001), this.params.fovMin, this.params.fovMax);
  };

  /** Writes the pose. Camera sits at the given window (eye) position. */
  apply(camera: THREE.PerspectiveCamera, up: THREE.Vector3, fwd: THREE.Vector3, eye: THREE.Vector3): void {
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const horiz = fwd.clone().multiplyScalar(Math.cos(this.azimuth)).addScaledVector(right, Math.sin(this.azimuth));
    const dir = up.clone().multiplyScalar(-Math.cos(this.tilt)).addScaledVector(horiz, Math.sin(this.tilt));
    // screen-up = away from Earth, except when looking nearly straight down,
    // where it becomes the look azimuth (travel direction at the top).
    const screenUp = up.clone().multiplyScalar(Math.sin(this.tilt)).addScaledVector(horiz, Math.cos(this.tilt));
    camera.position.copy(eye);
    camera.up.copy(screenUp);
    camera.lookAt(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z);
    if (camera.fov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.down);
    this.canvas.removeEventListener('pointermove', this.move);
    this.canvas.removeEventListener('pointerup', this.up);
    this.canvas.removeEventListener('pointercancel', this.up);
    this.canvas.removeEventListener('wheel', this.wheel);
  }
}

// Cabin: a small dark sphere around the eye whose shader opens only the
// window apertures (defined as angles in the station's LVLH frame). Unlike
// flat frames, this has no edges to peek past at extreme pan angles.
const CABIN_RADIUS_KM = 0.003; // 3 m
const CABIN_MODE: Record<Exclude<CameraMode, 'chase'>, number> = { cupola: 0, aft: 1, limb: 2, zenith: 3 };

const CABIN_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = normalize(position); // LVLH: x right, y forward, z up
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const CABIN_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform int uMode;
uniform vec3 uWall;
uniform vec3 uRim;
varying vec3 vDir;

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

void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float open = -1.0; // >0 inside a window (radians of margin)
  if (uMode == 0) {
    // cupola: round centre window + six trapezoids with mullions
    float nadir = acos(clamp(-d.z, -1.0, 1.0));
    float centre = radians(34.0) - nadir;
    float az = atan(d.y, d.x);
    float seg = radians(60.0);
    float rel = mod(az - radians(30.0), seg);
    float mullion = min(rel, seg - rel) * sin(nadir) - radians(3.5);
    float ring = min(nadir - radians(40.0), radians(68.0) - nadir);
    open = max(centre, min(ring, mullion));
  } else if (uMode == 1) {
    float t = radians(76.0);
    open = rectWindow(d, vec3(0.0, -sin(t), -cos(t)), radians(42.0), radians(24.0), radians(8.0));
  } else if (uMode == 2) {
    float t = radians(70.0);
    open = rectWindow(d, vec3(0.0, sin(t), -cos(t)), radians(42.0), radians(24.0), radians(8.0));
  } else {
    float zen = acos(clamp(d.z, -1.0, 1.0));
    open = radians(32.0) - zen;
  }
  float w = max(fwidth(open), 1e-4);
  float inside = smoothstep(-w, w, open);
  if (inside > 0.999) discard;
  // a thin lighter rim just around each aperture, soft falloff into the wall
  float rim = 1.0 - smoothstep(0.0, radians(2.5), -open);
  vec3 wall = uWall * (0.85 + 0.25 * d.z);
  vec3 col = mix(wall, uRim, rim * 0.6);
  gl_FragColor = vec4(col, 1.0 - inside);
  #include <colorspace_fragment>
}
`;

function buildCabin(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(CABIN_RADIUS_KM, 64, 48);
  const material = new THREE.ShaderMaterial({
    vertexShader: CABIN_VERTEX,
    fragmentShader: CABIN_FRAGMENT,
    uniforms: {
      uMode: { value: 0 },
      uWall: { value: new THREE.Color(0x15181f) },
      uRim: { value: new THREE.Color(0x3a3f4a) },
    },
    side: THREE.BackSide,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}

export class CameraRig {
  mode: CameraMode = 'cupola';
  readonly chase: ChaseCameraController;
  private readonly look: LookController;
  /** Add to the scene: the cabin around the active eye, in LVLH each frame. */
  readonly frames = new THREE.Group();
  private readonly cabin: THREE.Mesh;
  private readonly basis = new THREE.Matrix4();

  constructor(canvas: HTMLCanvasElement) {
    this.chase = new ChaseCameraController(canvas);
    this.look = new LookController(canvas);
    this.cabin = buildCabin();
    this.frames.add(this.cabin);
    this.setMode('cupola');
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.chase.enabled = mode === 'chase';
    this.look.enabled = mode !== 'chase';
    if (mode !== 'chase') this.look.setParams(LOOK[mode]);
    this.cabin.visible = mode !== 'chase';
    if (mode !== 'chase') (this.cabin.material as THREE.ShaderMaterial).uniforms.uMode.value = CABIN_MODE[mode];
  }

  next(): CameraMode {
    const i = CAMERA_ORDER.indexOf(this.mode);
    this.setMode(CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length]);
    return this.mode;
  }

  /** Turn toward the Sun's azimuth (sunrise framing). */
  aimAtSun(): void {
    this.chase.aimAtSun();
    this.aimPending = true;
  }
  private aimPending = false;

  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    up: THREE.Vector3,
    fwd: THREE.Vector3,
    sunDir: THREE.Vector3,
    eye: THREE.Vector3,
  ): void {
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    if (this.aimPending) {
      this.aimPending = false;
      this.look.azimuth = this.look.clampAz(Math.atan2(sunDir.dot(right), sunDir.dot(fwd)));
    }
    // window frames follow the station's LVLH attitude, at the active eye
    this.basis.makeBasis(right, fwd, up);
    this.frames.quaternion.setFromRotationMatrix(this.basis);
    this.frames.position.copy(eye);

    if (this.mode === 'chase') {
      if (camera.fov !== CHASE_FOV) {
        camera.fov = CHASE_FOV;
        camera.updateProjectionMatrix();
      }
      this.chase.update(dt, camera, up, fwd, sunDir);
    } else {
      this.look.apply(camera, up, fwd, eye);
    }
  }

  dispose(): void {
    this.chase.dispose();
    this.look.dispose();
    this.frames.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
