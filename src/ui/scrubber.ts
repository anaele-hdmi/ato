// The only persistent controls: time scrub, playback speed, mute. No numbers, no words.
import { DEEP_BASE_YEAR, yearToU } from '../time/time-model';
import { clamp } from '../util/rand';

const SPEED_GLYPHS = [
  '<rect x="8" y="8" width="8" height="8" rx="1"/>',
  '<path d="M9 7l7 5-7 5z"/>',
  '<path d="M5 7l6 5-6 5zM12 7l6 5-6 5z"/>',
  '<path d="M3 7l5.5 5L3 17zM9.2 7l5.5 5-5.5 5zM15.4 7l5.5 5-5.5 5z"/>',
];
const SOUND_ON = '<path d="M5 9h3l4-3.5v13L8 15H5z"/><path d="M15 9.2c1.1 1.6 1.1 4 0 5.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const SOUND_OFF = '<path d="M5 9h3l4-3.5v13L8 15H5z"/><path d="M15.5 9.5l4 4m0-4l-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';

export interface ScrubberHooks {
  getU(): number;
  setU(u: number): void;
  setScrubbing(b: boolean): void;
  cycleSpeed(): number;
  getSpeed(): number;
  toggleMute(): boolean;
  isMuted(): boolean;
}

export class Scrubber {
  readonly root: HTMLDivElement;
  private track: HTMLDivElement;
  private ticks: HTMLCanvasElement;
  private knob: HTMLDivElement;
  private speedBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private drag: { id: number; x: number; y0: number; u: number } | null = null;
  private opacity = 1;

  constructor(parent: HTMLElement, private h: ScrubberHooks) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="scrub"><div class="track"><canvas class="ticks"></canvas><div class="knob"></div></div></div>
      <button class="btn speed" aria-label="speed"><svg viewBox="0 0 24 24" fill="currentColor"></svg></button>
      <button class="btn mute" aria-label="sound"><svg viewBox="0 0 24 24" fill="currentColor"></svg></button>`;
    parent.appendChild(this.root);
    const scrub = this.root.querySelector('.scrub') as HTMLDivElement;
    this.track = this.root.querySelector('.track') as HTMLDivElement;
    this.ticks = this.root.querySelector('.ticks') as HTMLCanvasElement;
    this.knob = this.root.querySelector('.knob') as HTMLDivElement;
    this.speedBtn = this.root.querySelector('.speed') as HTMLButtonElement;
    this.muteBtn = this.root.querySelector('.mute') as HTMLButtonElement;

    scrub.addEventListener('pointerdown', this.onDown);
    scrub.addEventListener('pointermove', this.onMove);
    scrub.addEventListener('pointerup', this.onUp);
    scrub.addEventListener('pointercancel', this.onUp);
    this.speedBtn.addEventListener('click', () => { this.h.cycleSpeed(); this.renderButtons(); });
    this.muteBtn.addEventListener('click', () => { this.h.toggleMute(); this.renderButtons(); });
    for (const el of [this.root]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const step = (e.shiftKey ? 0.02 : 0.002) * (e.key === 'ArrowRight' ? 1 : -1);
        this.h.setU(clamp(this.h.getU() + step, 0, 1));
      } else if (e.key === ' ') {
        this.h.cycleSpeed();
        this.renderButtons();
      }
    });
    this.renderButtons();
    this.layout();
  }

  renderButtons(): void {
    (this.speedBtn.firstElementChild as SVGElement).innerHTML = SPEED_GLYPHS[this.h.getSpeed()];
    (this.muteBtn.firstElementChild as SVGElement).innerHTML = this.h.isMuted() ? SOUND_OFF : SOUND_ON;
  }

  layout(): void {
    const w = this.track.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.ticks;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.floor(12 * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    const mark = (u: number, hgt: number) => g.fillRect(Math.round(u * (c.width - 1)), (c.height - hgt * dpr) / 2, Math.max(1, dpr * 0.75), hgt * dpr);
    // Only density: decades while people count years, powers of ten afterwards.
    for (let y = 1910; y < DEEP_BASE_YEAR; y += 10) mark(yearToU(y), y % 50 === 0 ? 7 : 4);
    for (let k = 1; k <= 8; k++) for (const m of [1, 3]) mark(yearToU(DEEP_BASE_YEAR + m * Math.pow(10, k)), m === 1 ? 7 : 4);
  }

  private uAt(clientX: number): number {
    const r = this.track.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1);
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const r = this.track.getBoundingClientRect();
    const knobX = r.left + this.h.getU() * r.width;
    if (Math.abs(e.clientX - knobX) > 26) this.h.setU(this.uAt(e.clientX));
    this.drag = { id: e.pointerId, x: e.clientX, y0: e.clientY, u: this.h.getU() };
    this.h.setScrubbing(true);
    this.root.classList.add('active');
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    e.preventDefault();
    const r = this.track.getBoundingClientRect();
    // Sliding the finger up and away from the bar gives finer control.
    const lift = Math.max(0, this.drag.y0 - e.clientY - 24);
    const sens = 1 / (1 + lift / 50);
    const du = ((e.clientX - this.drag.x) / r.width) * sens;
    this.drag.x = e.clientX;
    this.drag.u = clamp(this.drag.u + du, 0, 1);
    this.h.setU(this.drag.u);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.h.setScrubbing(false);
    this.root.classList.remove('active');
  };

  update(season: number, seasonality: number, fade: number): void {
    const u = this.h.getU();
    this.knob.style.left = `${(u * 100).toFixed(3)}%`;
    // The knob carries the only hint of the season.
    const hues = [[190, 12, 78], [95, 32, 72], [120, 30, 58], [35, 40, 66]];
    const s4 = season * 4;
    const i = Math.floor(s4) % 4, j = (i + 1) % 4, t = s4 - Math.floor(s4);
    const hh = hues[i][0] + (((hues[j][0] - hues[i][0] + 540) % 360) - 180) * t;
    const ss = (hues[i][1] + (hues[j][1] - hues[i][1]) * t) * seasonality;
    const ll = hues[i][2] + (hues[j][2] - hues[i][2]) * t;
    this.knob.style.background = `hsl(${hh.toFixed(0)} ${ss.toFixed(0)}% ${ll.toFixed(0)}%)`;
    const target = this.drag ? 1 : fade;
    this.opacity += (target - this.opacity) * 0.05;
    this.root.style.opacity = this.opacity.toFixed(3);
    this.root.style.pointerEvents = this.opacity < 0.05 ? 'none' : '';
  }
}
