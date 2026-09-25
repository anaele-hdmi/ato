// The end, if left alone: the tide draws back from the cut face, and the ruler that
// has been under the thumb the whole time stands up beside it. Its bands are the
// face's bands. Then it sinks into the rock and only the rock is left.
// Any touch undoes all of it at once.
import * as THREE from 'three';
import { CLIFF_AZ, CLIFF_R, CLIFF_STRATA_DEPTH } from '../world/cliff-shape';
import { clamp, smoothstep } from '../util/rand';

const START_IDLE = 4;
const T_STAND0 = 9, T_STAND1 = 17, T_SINK0 = 19, T_SINK1 = 25, T_TITLE = 25;
const SIDE_GAP = 18;

export interface EndOut {
  /** 0..1 how strongly the camera is eased to the face. */
  steer: number;
  /** 0..1 how far the tide is held low. */
  ebb: number;
  /** 0..1 the real controls hidden in favour of the standing ruler. */
  hideHud: number;
  title: boolean;
}

const ease = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

export class EndSequence {
  private t = 0;
  private ghost: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private p = new THREE.Vector3();
  readonly out: EndOut = { steer: 0, ebb: 0, hideHud: 0, title: false };

  constructor(private stage: HTMLElement) {
    this.ghost = document.createElement('canvas');
    this.ghost.className = 'strata-ghost';
    stage.appendChild(this.ghost);
    this.gctx = this.ghost.getContext('2d') as CanvasRenderingContext2D;
  }

  get running(): boolean {
    return this.t > 0;
  }

  update(dt: number, terminal: number, idle: number, scrubbing: boolean, camera: THREE.Camera,
    originH: number, strata: HTMLCanvasElement, trackEl: HTMLElement, knobFrac: number): EndOut {
    const o = this.out;
    if (terminal < 0.98 || idle < START_IDLE || scrubbing) {
      this.t = 0;
      o.steer = o.ebb = o.hideHud = 0;
      o.title = false;
      this.ghost.style.display = 'none';
      return o;
    }
    this.t += dt;
    const t = this.t;
    o.steer = ease(t / 10);
    o.ebb = ease(t / 12);
    o.hideHud = t > T_STAND0 ? 1 : 0;
    o.title = t > T_TITLE;
    if (t < T_STAND0) {
      this.ghost.style.display = 'none';
      return o;
    }

    const track = trackEl.getBoundingClientRect();
    // the same pixels as the ruler, so there is no doubt what is standing up
    const g = this.ghost;
    if (g.width !== strata.width || g.height !== strata.height) {
      g.width = strata.width;
      g.height = strata.height;
    }
    const gc = this.gctx;
    gc.clearRect(0, 0, g.width, g.height);
    gc.drawImage(strata, 0, 0);
    const kx = g.width * knobFrac, ky = g.height / 2, kr = g.height * 0.38;
    gc.fillStyle = 'rgba(220,226,222,0.9)';
    gc.beginPath();
    gc.arc(kx, ky, kr, 0, Math.PI * 2);
    gc.fill();

    // the face's oldest and newest lines on screen
    const sb = this.project(camera, originH - CLIFF_STRATA_DEPTH);
    const st = this.project(camera, originH);
    const len = Math.hypot(st.x - sb.x, st.y - sb.y);
    const ang = Math.atan2(st.y - sb.y, st.x - sb.x);

    const k = ease((t - T_STAND0) / (T_STAND1 - T_STAND0));
    const sink = ease((t - T_SINK0) / (T_SINK1 - T_SINK0));
    const gap = SIDE_GAP * (1 - sink);
    // start: exactly where the real strip lies; end: beside the face, old end at the bottom
    const x0 = track.left, y0 = track.top + track.height / 2;
    const x1 = sb.x - gap, y1 = sb.y;
    const s0 = 1, s1 = len / Math.max(1, track.width * knobFrac);
    const px = x0 + (x1 - x0) * k, py = y0 + (y1 - y0) * k;
    const a = ang * k;
    const s = s0 + (s1 - s0) * k;
    const thick = 1 + 3 * k;
    g.style.display = 'block';
    g.style.width = `${track.width}px`;
    g.style.height = `${track.height}px`;
    g.style.transform = `translate(${px}px, ${py - track.height / 2}px) rotate(${a}rad) scale(${s}, ${thick})`;
    g.style.opacity = (1 - smoothstep(0.35, 1, sink)).toFixed(3);
    return o;
  }

  private project(camera: THREE.Camera, y: number): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    this.p.set(Math.sin(CLIFF_AZ) * CLIFF_R, y, Math.cos(CLIFF_AZ) * CLIFF_R).project(camera);
    return { x: r.left + (this.p.x * 0.5 + 0.5) * r.width, y: r.top + (1 - (this.p.y * 0.5 + 0.5)) * r.height };
  }
}
