// The only persistent controls: time scrub, playback speed, mute. No numbers, no words.
// The bar is a strata ruler: it draws the elapsed years as compressed colour bands, the
// house's span thinning among them but never vanishing.
import { DEEP_BASE_YEAR, DEEP_LOG_MAX, START_YEAR } from '../time/time-model';
import { clamp } from '../util/rand';

// The span the first house stood. After it is gone this span is drawn to scale
// against all the time since, so it thins to a hair.
const HOUSE_FROM = 1880;
const HOUSE_TO = 2104;

// The playhead sits at a fixed fraction of the track; everything to its left is the
// past, drawn to a linear scale from START_YEAR to "now". Must match .knob's `left`.
export const KNOB_FRAC = 0.82;

const DEEP_MAX_YEAR = DEEP_BASE_YEAR + Math.pow(10, DEEP_LOG_MAX) - 1;
const ICE_FROM = DEEP_BASE_YEAR + Math.pow(10, 3.95) - 1;
const ICE_TO = DEEP_BASE_YEAR + Math.pow(10, 5.25) - 1;
const ARID_TO = DEEP_BASE_YEAR + Math.pow(10, 7.8) - 1;
const SEA_FROM = DEEP_BASE_YEAR + Math.pow(10, 6.9) - 1;

// [yearFrom, yearTo, colour]. Muted, low-contrast, drawn chronologically left to right.
const STRATA: ReadonlyArray<readonly [number, number, string]> = [
  [START_YEAR, START_YEAR + 1500, 'rgba(200,208,214,0.50)'],  // ice leaving
  [START_YEAR + 1500, 1650, 'rgba(52,68,50,0.46)'],           // wildwood
  [1650, HOUSE_FROM, 'rgba(120,112,60,0.40)'],                // clearing / pasture
  [HOUSE_FROM, HOUSE_TO, 'rgba(198,150,82,0.58)'],            // the house's years (ochre)
  [HOUSE_TO, 2296, 'rgba(144,147,151,0.40)'],                 // city
  [2296, 2420, 'rgba(112,93,77,0.48)'],                       // bad years
  [2420, ICE_FROM, 'rgba(90,104,86,0.38)'],                   // ruin / forest regrowth
  [ICE_FROM, ICE_TO, 'rgba(228,230,232,0.55)'],               // ice
  [ICE_TO, ARID_TO, 'rgba(206,187,144,0.42)'],                // dry age
  [SEA_FROM, DEEP_MAX_YEAR, 'rgba(94,114,136,0.46)'],         // sea
];
const HOUSE_BAND = 3;

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
  readonly track: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private knob: HTMLDivElement;
  private speedBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private drag: { id: number; x: number; y0: number; u: number } | null = null;
  private opacity = 1;
  private dpr = 1;
  private lastDrawYear = NaN;

  constructor(parent: HTMLElement, private h: ScrubberHooks) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="scrub"><div class="track"><canvas class="strata"></canvas><i class="rush"></i><div class="knob"></div></div></div>
      <button class="btn speed" aria-label="speed"><svg viewBox="0 0 24 24" fill="currentColor"></svg></button>
      <button class="btn mute" aria-label="sound"><svg viewBox="0 0 24 24" fill="currentColor"></svg></button>`;
    parent.appendChild(this.root);
    const scrub = this.root.querySelector('.scrub') as HTMLDivElement;
    this.track = this.root.querySelector('.track') as HTMLDivElement;
    this.canvas = this.root.querySelector('.strata') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D;
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
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.track.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const height = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== height) {
      this.canvas.width = w;
      this.canvas.height = height;
    }
    this.lastDrawYear = NaN; // force a redraw at the new size
  }

  // Draws the elapsed strata from START_YEAR up to the fixed playhead. Cheap: a
  // handful of fillRect calls, skipped by update() unless the year visibly moved.
  private drawStrata(year: number): void {
    const w = this.canvas.width;
    const hgt = this.canvas.height;
    if (w < 2 || hgt < 2) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, hgt);
    const knobX = w * KNOB_FRAC;
    // a thin strip, not a slab: the control should stay quiet over the picture
    const bandH = Math.max(2, Math.round(3.5 * this.dpr));
    const y0 = Math.round((hgt - bandH) / 2);
    const span = Math.max(1, year - START_YEAR);
    const pxPerYear = knobX / span;
    let houseX0 = 0;
    let houseX1 = 0;
    for (let i = 0; i < STRATA.length; i++) {
      const [yf, yt, color] = STRATA[i];
      if (yt <= START_YEAR || yf >= year) continue;
      const x0 = clamp((Math.max(yf, START_YEAR) - START_YEAR) * pxPerYear, 0, knobX);
      const x1 = clamp((Math.min(yt, year) - START_YEAR) * pxPerYear, 0, knobX);
      if (i === HOUSE_BAND) {
        houseX0 = x0;
        houseX1 = x1;
        continue; // drawn last, on top, so its hairline is never painted over
      }
      if (x1 - x0 < 0.4) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, x1 - x0, bandH);
    }
    if (year <= STRATA[HOUSE_BAND][0]) return;
    ctx.fillStyle = STRATA[HOUSE_BAND][2];
    // the house layer stands a little proud of the others so the hair stays findable
    ctx.fillRect(houseX0, y0 - this.dpr, Math.max(this.dpr, houseX1 - houseX0), bandH + 2 * this.dpr);
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    // The playhead is fixed; any touch on the bar starts a relative drag, it never jumps.
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

  update(season: number, seasonality: number, fade: number, year: number, exposure: number): void {
    // Redraw only once the compressed past would visibly shift (roughly half a device px
    // at the playhead), so a slow crawl through deep time costs almost nothing per frame.
    const knobX = this.canvas.width * KNOB_FRAC;
    const denom = Math.max(1, year - START_YEAR);
    const eps = knobX > 0 ? (0.5 * denom) / knobX : Infinity;
    if (!Number.isFinite(this.lastDrawYear) || Math.abs(year - this.lastDrawYear) > eps) {
      this.drawStrata(year);
      this.lastDrawYear = year;
    }
    this.root.style.setProperty('--rush', exposure.toFixed(3));
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
