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
import { DOF } from './palette';
import { createCabin, type Cabin } from './cabin';

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

export class CameraRig {
  mode: CameraMode = 'cupola';
  readonly chase: ChaseCameraController;
  private readonly look: LookController;
  /** Add to the scene: the cabin around the active eye, in LVLH each frame. */
  readonly frames = new THREE.Group();
  private readonly cabin: Cabin;
  private readonly sunLocal = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();

  constructor(canvas: HTMLCanvasElement) {
    this.chase = new ChaseCameraController(canvas);
    this.look = new LookController(canvas);
    this.cabin = createCabin();
    this.frames.add(this.cabin.group);
    this.setMode('cupola');
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.chase.enabled = mode === 'chase';
    this.look.enabled = mode !== 'chase';
    if (mode !== 'chase') this.look.setParams(LOOK[mode]);
    this.cabin.setMode(mode === 'chase' ? null : mode);
  }

  next(): CameraMode {
    const i = CAMERA_ORDER.indexOf(this.mode);
    this.setMode(CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length]);
    return this.mode;
  }

  /** Chase-view DOF target: 1 when zoomed right up to the station, 0 when far or inside. */
  dofTarget(): number {
    if (this.mode !== 'chase') return 0;
    return 1 - THREE.MathUtils.smoothstep(this.chase.distanceKm, DOF.chaseNearKm, DOF.chaseFarKm);
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
    if (this.mode !== 'chase') {
      this.cabin.update(this.sunLocal.set(sunDir.dot(right), sunDir.dot(fwd), sunDir.dot(up)).normalize());
    }

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
    this.cabin.dispose();
  }
}
