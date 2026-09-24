// Orbit / pinch / two-finger pan around a ground point. The point is spring-held
// near the house site so the viewer can wander but not get lost.
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/rand';

export const MIN_DIST = 1.2;
export const MAX_DIST = 9000;
const LOG_MIN = Math.log(MIN_DIST);
const LOG_MAX = Math.log(MAX_DIST);

type GroundFn = (x: number, z: number) => number;
/** Returns the usable fraction of the target->eye segment. */
export type ClipFn = (from: THREE.Vector3, to: THREE.Vector3) => number;

interface Ptr { x: number; y: number }

export class TouchCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3(0.4, 23, 3.6);
  /** The house site; never forgotten even when nothing marks it. */
  readonly anchor = new THREE.Vector3(0, 0, 0);
  azimuth = 0.55;
  elevation = 0.12;
  logDist = Math.log(44);
  private vAz = 0;
  private vEl = 0;
  private logTarget = this.logDist;
  private ptrs = new Map<number, Ptr>();
  private mode: 'none' | 'orbit' | 'undecided' | 'pinch' | 'pan' = 'none';
  private accSpan = 0;
  private accMove = 0;
  private lastSpan = 0;
  private lastMid = { x: 0, y: 0 };
  private cooldownUntil = 0;
  private lastMoveT = 0;
  private mouseButton = -1;
  private clipFn: ClipFn | null = null;
  private clipDist = Infinity;
  /** Seconds since the last camera gesture. */
  idle = 0;

  constructor(private el: HTMLElement, private ground: GroundFn) {
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('lostpointercapture', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get dist(): number {
    return Math.exp(this.logDist);
  }

  /** Actual eye-to-target distance after collisions. */
  get eyeDist(): number {
    return this.camera.position.distanceTo(this.target);
  }

  /** 0 at grass level, 1 at the highest view. */
  get altitude(): number {
    return (this.logDist - LOG_MIN) / (LOG_MAX - LOG_MIN);
  }

  setClip(fn: ClipFn): void {
    this.clipFn = fn;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 50 : 34;
    this.camera.updateProjectionMatrix();
  }

  private touched(): void {
    this.idle = 0;
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    this.el.setPointerCapture?.(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.touched();
    if (e.pointerType === 'mouse') this.mouseButton = e.button === 2 || e.shiftKey ? 2 : 0;
    if (this.ptrs.size === 1) {
      this.mode = this.mouseButton === 2 && e.pointerType === 'mouse' ? 'pan' : 'orbit';
      this.vAz = this.vEl = 0;
    } else if (this.ptrs.size === 2) {
      this.mode = 'undecided';
      this.accSpan = this.accMove = 0;
      const [a, b] = [...this.ptrs.values()];
      this.lastSpan = Math.hypot(a.x - b.x, a.y - b.y);
      this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.vAz = this.vEl = 0;
    } else {
      this.mode = 'none';
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    this.touched();
    const now = performance.now();
    const h = this.el.clientHeight || 1;
    if (this.ptrs.size === 1) {
      if (now < this.cooldownUntil) return;
      if (this.mode === 'pan') {
        this.pan(dx, dy);
        return;
      }
      const k = (Math.PI * 1.1) / h;
      const dAz = -dx * k, dEl = dy * k;
      this.azimuth += dAz;
      this.elevation += dEl;
      const dt = Math.max(1, now - this.lastMoveT) / 1000;
      this.vAz = lerp(this.vAz, dAz / dt, 0.5);
      this.vEl = lerp(this.vEl, dEl / dt, 0.5);
      this.lastMoveT = now;
      return;
    }
    if (this.ptrs.size !== 2) return;
    const [a, b] = [...this.ptrs.values()];
    const span = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dSpan = span - this.lastSpan;
    const dMx = mid.x - this.lastMid.x, dMy = mid.y - this.lastMid.y;
    if (this.mode === 'undecided') {
      this.accSpan += Math.abs(dSpan);
      this.accMove += Math.hypot(dMx, dMy);
      // Lock the gesture once it has declared itself; no mixing afterwards.
      if (this.accSpan + this.accMove > 10) this.mode = this.accSpan > this.accMove * 0.8 ? 'pinch' : 'pan';
    }
    if (this.mode === 'pinch' && span > 1 && this.lastSpan > 1) {
      this.logTarget = clamp(this.logTarget - Math.log(span / this.lastSpan) * 1.15, LOG_MIN, LOG_MAX);
    } else if (this.mode === 'pan') {
      this.pan(dMx, dMy);
    }
    this.lastSpan = span;
    this.lastMid = mid;
  };

  private onUp = (e: PointerEvent) => {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size === 1) {
      // Lifting one finger of a pinch must not turn into an orbit jump.
      this.cooldownUntil = performance.now() + 180;
      this.mode = 'orbit';
      this.vAz = this.vEl = 0;
    } else if (this.ptrs.size === 0) {
      if (performance.now() - this.lastMoveT > 80) this.vAz = this.vEl = 0;
      this.mode = 'none';
      this.mouseButton = -1;
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.touched();
    const scale = e.deltaMode === 1 ? 0.05 : 0.0022;
    const k = e.ctrlKey ? 4 : 1;
    this.logTarget = clamp(this.logTarget + e.deltaY * scale * k, LOG_MIN, LOG_MAX);
  };

  private pan(dx: number, dy: number): void {
    const h = this.el.clientHeight || 1;
    const worldPerPx = (2 * this.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    const s = Math.sin(this.azimuth), c = Math.cos(this.azimuth);
    // screen right = (c, -s), screen up along ground = (-s, -c)
    const k = worldPerPx * lerp(1, 1.6, smoothstep(0.1, 1.2, 1.4 - this.elevation));
    this.target.x += (-dx * c + -dy * s) * k;
    this.target.z += (dx * s + -dy * c) * k;
  }

  update(dt: number): void {
    this.idle += dt;
    if (this.ptrs.size === 0) {
      this.azimuth += this.vAz * dt;
      this.elevation += this.vEl * dt;
      const decay = Math.exp(-dt * 3.5);
      this.vAz *= decay;
      this.vEl *= decay;
    }
    this.logDist += (this.logTarget - this.logDist) * (1 - Math.exp(-dt * 10));
    const d = this.dist;

    const minEl = lerp(0.02, 0.5, smoothstep(Math.log(40), LOG_MAX, this.logDist));
    this.elevation = clamp(this.elevation, minEl, 1.45);

    // Spring the look point back toward the site once it strays.
    const radius = Math.min(1400, 22 + d * 0.55);
    const off = Math.hypot(this.target.x - this.anchor.x, this.target.z - this.anchor.z);
    if (off > radius) {
      const pull = (1 - Math.exp(-dt * 2.5)) * (off - radius) / off;
      this.target.x -= (this.target.x - this.anchor.x) * pull;
      this.target.z -= (this.target.z - this.anchor.z) * pull;
    }
    const lift = lerp(0.95, 0, smoothstep(8, 120, d));
    const gy = this.ground(this.target.x, this.target.z) + lift;
    this.target.y += (gy - this.target.y) * (1 - Math.exp(-dt * 8));

    const ce = Math.cos(this.elevation);
    const pos = new THREE.Vector3(
      this.target.x + d * ce * Math.sin(this.azimuth),
      this.target.y + d * Math.sin(this.elevation),
      this.target.z + d * ce * Math.cos(this.azimuth),
    );
    if (this.clipFn) {
      // Pull in at once when blocked, ease back out when the way clears.
      const f = this.clipFn(this.target, pos);
      const want = Math.max(MIN_DIST, f * d - 1.2);
      this.clipDist = want < this.clipDist ? want : this.clipDist + (want - this.clipDist) * (1 - Math.exp(-dt * 3));
      if (this.clipDist < d) pos.sub(this.target).multiplyScalar(this.clipDist / d).add(this.target);
    }
    const floor = this.ground(pos.x, pos.z) + 0.3;
    if (pos.y < floor) {
      pos.y = floor;
      this.elevation = Math.asin(clamp((floor - this.target.y) / d, -1, 1));
    }
    const cam = this.camera;
    cam.position.copy(pos);
    cam.lookAt(this.target);
    const e = pos.distanceTo(this.target);
    cam.near = clamp(e * 0.012, 0.03, 30);
    cam.far = Math.max(4000, e * 7 + 6000);
    cam.updateProjectionMatrix();
  }
}
