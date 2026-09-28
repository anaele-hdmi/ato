// C6 external chase camera: hand-rolled orbit control around the station
// (kept out of three's OrbitControls so touch/pinch handling stays ours).
// Drag = yaw/pitch with short inertia + an angular-velocity cap (motion
// sickness guard). Pinch or wheel = distance, clamped to 0.15-2 km.
import * as THREE from 'three';

const MIN_DISTANCE_KM = 0.15;
const MAX_DISTANCE_KM = 2;
const DEFAULT_DISTANCE_KM = 0.42;
const DEFAULT_PITCH = THREE.MathUtils.degToRad(18); // above horizontal
const MAX_PITCH = THREE.MathUtils.degToRad(85);
const MIN_PITCH = THREE.MathUtils.degToRad(-85);
const DRAG_SENSITIVITY = 0.0045; // rad per px
const MAX_ANGULAR_SPEED = THREE.MathUtils.degToRad(110); // rad/s cap, motion-sickness guard
const INERTIA_DAMPING_PER_SEC = 5.5; // higher = shorter inertia
const WHEEL_ZOOM_SPEED = 0.0011;
const PINCH_ZOOM_SENSITIVITY = 1.0;

interface PointerInfo {
  x: number;
  y: number;
}

export class ChaseCameraController {
  private yaw = 0;
  private pitch = DEFAULT_PITCH;
  private distance = DEFAULT_DISTANCE_KM;

  private yawVel = 0;
  private pitchVel = 0;

  private pointers = new Map<number, PointerInfo>();
  private lastSingleDrag: PointerInfo | null = null;
  private lastDragTime = 0;
  private pinchStartPxDist = 0;
  private pinchStartDistanceKm = DEFAULT_DISTANCE_KM;

  private readonly onPointerDown = (ev: PointerEvent) => {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 1) {
      this.lastSingleDrag = { x: ev.clientX, y: ev.clientY };
      this.lastDragTime = performance.now();
      this.yawVel = 0;
      this.pitchVel = 0;
    } else if (this.pointers.size === 2) {
      this.pinchStartPxDist = this.currentPinchDistance();
      this.pinchStartDistanceKm = this.distance;
    }
  };

  private readonly onPointerMove = (ev: PointerEvent) => {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (this.pointers.size === 1 && this.lastSingleDrag) {
      const dx = ev.clientX - this.lastSingleDrag.x;
      const dy = ev.clientY - this.lastSingleDrag.y;
      const now = performance.now();
      const dt = Math.max(1, now - this.lastDragTime) / 1000;

      const dyaw = -dx * DRAG_SENSITIVITY;
      const dpitch = -dy * DRAG_SENSITIVITY;
      this.yaw += dyaw;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dpitch, MIN_PITCH, MAX_PITCH);

      this.yawVel = THREE.MathUtils.clamp(dyaw / dt, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);
      this.pitchVel = THREE.MathUtils.clamp(dpitch / dt, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);

      this.lastSingleDrag = { x: ev.clientX, y: ev.clientY };
      this.lastDragTime = now;
    } else if (this.pointers.size === 2) {
      const pxDist = this.currentPinchDistance();
      if (this.pinchStartPxDist > 1) {
        const ratio = this.pinchStartPxDist / Math.max(1, pxDist);
        const target = this.pinchStartDistanceKm * Math.pow(ratio, PINCH_ZOOM_SENSITIVITY);
        this.distance = THREE.MathUtils.clamp(target, MIN_DISTANCE_KM, MAX_DISTANCE_KM);
      }
    }
  };

  private readonly onPointerUp = (ev: PointerEvent) => {
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size === 0) {
      this.lastSingleDrag = null;
    } else if (this.pointers.size === 1) {
      // fell back from pinch to single drag: reset drag origin from whichever pointer remains
      const remaining = this.pointers.values().next().value as PointerInfo | undefined;
      this.lastSingleDrag = remaining ? { x: remaining.x, y: remaining.y } : null;
      this.lastDragTime = performance.now();
    }
  };

  private readonly onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const factor = Math.exp(ev.deltaY * WHEEL_ZOOM_SPEED);
    this.distance = THREE.MathUtils.clamp(this.distance * factor, MIN_DISTANCE_KM, MAX_DISTANCE_KM);
  };

  private readonly onGestureStart = (ev: Event) => {
    ev.preventDefault();
  };

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // Safari-only non-standard gesture events for pinch; prevent default page zoom.
    canvas.addEventListener('gesturestart', this.onGestureStart as EventListener);
    canvas.addEventListener('gesturechange', this.onGestureStart as EventListener);
  }

  private currentPinchDistance(): number {
    const pts = Array.from(this.pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /** Advances inertia and writes the resulting camera pose. */
  update(dtSec: number, camera: THREE.PerspectiveCamera, upDir: THREE.Vector3, forwardDirRaw: THREE.Vector3): void {
    const dragging = this.pointers.size >= 1;
    if (!dragging) {
      this.yaw += this.yawVel * dtSec;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.pitchVel * dtSec, MIN_PITCH, MAX_PITCH);
      const decay = Math.exp(-INERTIA_DAMPING_PER_SEC * dtSec);
      this.yawVel *= decay;
      this.pitchVel *= decay;
      if (Math.abs(this.yawVel) < 1e-5) this.yawVel = 0;
      if (Math.abs(this.pitchVel) < 1e-5) this.pitchVel = 0;
    }

    const up = upDir.clone().normalize();
    let forward = forwardDirRaw.clone();
    forward.sub(up.clone().multiplyScalar(forward.dot(up)));
    if (forward.lengthSq() < 1e-10) {
      forward = new THREE.Vector3(1, 0, 0).sub(up.clone().multiplyScalar(up.x));
    }
    forward.normalize();

    const base = forward.clone().multiplyScalar(-1); // behind, at yaw=0/pitch=0
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, this.yaw);
    base.applyQuaternion(qYaw);

    const tiltAxis = new THREE.Vector3().crossVectors(base, up);
    if (tiltAxis.lengthSq() < 1e-10) tiltAxis.set(1, 0, 0);
    tiltAxis.normalize();
    const qPitch = new THREE.Quaternion().setFromAxisAngle(tiltAxis, this.pitch);
    base.applyQuaternion(qPitch);

    camera.position.copy(base.multiplyScalar(this.distance));
    camera.up.copy(up);
    camera.lookAt(0, 0, 0);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('gesturestart', this.onGestureStart as EventListener);
    this.canvas.removeEventListener('gesturechange', this.onGestureStart as EventListener);
  }
}
