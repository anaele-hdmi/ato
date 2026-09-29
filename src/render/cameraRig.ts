// Viewpoints (design §3). Three "from the station" views share one look
// controller parametrised as (azimuth, tilt-from-nadir, fov); the external
// chase view keeps its own controller.
//
//   cupola : inside the Earth-facing window; frame in the foreground
//   nadir  : straight down, zoomable
//   limb   : telephoto on the horizon (atmosphere layers, sunrise)
//   chase  : outside the station (the only view where the station is visible)
import * as THREE from 'three';
import { ChaseCameraController } from './cameraControl';

export type CameraMode = 'cupola' | 'nadir' | 'limb' | 'chase';
export const CAMERA_ORDER: CameraMode[] = ['cupola', 'nadir', 'limb', 'chase'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  cupola: 'キューポラ',
  nadir: '真下',
  limb: '地平線',
  chase: '外から',
};

const DEG = Math.PI / 180;
// From 420 km the horizon lies ~70° from nadir.
const HORIZON_TILT = 70 * DEG;

interface LookParams {
  tiltMin: number;
  tiltMax: number;
  tiltDefault: number;
  fovMin: number;
  fovMax: number;
  fovDefault: number;
}

const LOOK: Record<Exclude<CameraMode, 'chase'>, LookParams> = {
  cupola: { tiltMin: 0, tiltMax: 62 * DEG, tiltDefault: 42 * DEG, fovMin: 40, fovMax: 75, fovDefault: 62 },
  nadir: { tiltMin: 0, tiltMax: 25 * DEG, tiltDefault: 0, fovMin: 20, fovMax: 70, fovDefault: 55 },
  limb: { tiltMin: HORIZON_TILT - 14 * DEG, tiltMax: HORIZON_TILT + 12 * DEG, tiltDefault: HORIZON_TILT + 1 * DEG, fovMin: 4, fovMax: 30, fovDefault: 14 },
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
      this.azimuth -= (e.clientX - prev.x) * k;
      this.tilt = THREE.MathUtils.clamp(this.tilt - (e.clientY - prev.y) * k, this.params.tiltMin, this.params.tiltMax);
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

  /** Writes the pose. Camera sits at the station (scene origin). */
  apply(camera: THREE.PerspectiveCamera, up: THREE.Vector3, fwd: THREE.Vector3): void {
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const horiz = fwd.clone().multiplyScalar(Math.cos(this.azimuth)).addScaledVector(right, Math.sin(this.azimuth));
    const dir = up.clone().multiplyScalar(-Math.cos(this.tilt)).addScaledVector(horiz, Math.sin(this.tilt));
    // screen-up = away from Earth, except when looking nearly straight down,
    // where it becomes the look azimuth (travel direction at the top).
    const screenUp = up.clone().multiplyScalar(Math.sin(this.tilt)).addScaledVector(horiz, Math.cos(this.tilt));
    camera.position.set(0, 0, 0);
    camera.up.copy(screenUp);
    camera.lookAt(dir);
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

/** Cupola window frame: dark hull with a round centre window and six
 *  trapezoid windows around it, fixed to the station (so it parallaxes as
 *  you look around). Lives in the LVLH frame: x = right, y = forward, z = up. */
function buildCupolaFrame(): THREE.Mesh {
  const d = 0.002; // 2 m below the eye, in km
  const r = (deg: number) => d * Math.tan(deg * DEG);
  const outer = new THREE.Shape();
  const R = 0.06;
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    if (i === 0) outer.moveTo(Math.cos(a) * R, Math.sin(a) * R);
    else outer.lineTo(Math.cos(a) * R, Math.sin(a) * R);
  }
  const centre = new THREE.Path();
  centre.absarc(0, 0, r(34), 0, Math.PI * 2, true);
  outer.holes.push(centre);
  const r1 = r(40);
  const r2 = r(68);
  const gap = 7 * DEG;
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2 + gap / 2 + Math.PI / 6;
    const a1 = ((i + 1) / 6) * Math.PI * 2 - gap / 2 + Math.PI / 6;
    const hole = new THREE.Path();
    hole.moveTo(Math.cos(a0) * r1, Math.sin(a0) * r1);
    hole.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1);
    hole.lineTo(Math.cos(a1) * r2, Math.sin(a1) * r2);
    hole.lineTo(Math.cos(a0) * r2, Math.sin(a0) * r2);
    hole.closePath();
    outer.holes.push(hole);
  }
  const geometry = new THREE.ShapeGeometry(outer, 48);
  geometry.translate(0, 0, -d);
  const material = new THREE.MeshBasicMaterial({ color: 0x15181f, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  return mesh;
}

export class CameraRig {
  mode: CameraMode = 'cupola';
  readonly chase: ChaseCameraController;
  private readonly look: LookController;
  /** Add to the scene; oriented to LVLH each frame. */
  readonly cupolaFrame: THREE.Mesh;
  private readonly basis = new THREE.Matrix4();

  constructor(canvas: HTMLCanvasElement) {
    this.chase = new ChaseCameraController(canvas);
    this.look = new LookController(canvas);
    this.cupolaFrame = buildCupolaFrame();
    this.setMode('cupola');
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.chase.enabled = mode === 'chase';
    this.look.enabled = mode !== 'chase';
    if (mode !== 'chase') this.look.setParams(LOOK[mode]);
    this.cupolaFrame.visible = mode === 'cupola';
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

  update(dt: number, camera: THREE.PerspectiveCamera, up: THREE.Vector3, fwd: THREE.Vector3, sunDir: THREE.Vector3): void {
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    if (this.aimPending) {
      this.aimPending = false;
      this.look.azimuth = Math.atan2(sunDir.dot(right), sunDir.dot(fwd));
    }
    // cupola frame follows the station's LVLH attitude
    this.basis.makeBasis(right, fwd, up);
    this.cupolaFrame.quaternion.setFromRotationMatrix(this.basis);

    if (this.mode === 'chase') {
      if (camera.fov !== CHASE_FOV) {
        camera.fov = CHASE_FOV;
        camera.updateProjectionMatrix();
      }
      this.chase.update(dt, camera, up, fwd, sunDir);
    } else {
      this.look.apply(camera, up, fwd);
    }
  }

  dispose(): void {
    this.chase.dispose();
    this.look.dispose();
    this.cupolaFrame.geometry.dispose();
    (this.cupolaFrame.material as THREE.Material).dispose();
  }
}
