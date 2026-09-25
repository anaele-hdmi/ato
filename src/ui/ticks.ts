// Evenly spaced marks above the ruler, born at the playhead and carried left.
// Near the playhead the scale is set by how fast time is running, so at a steady
// speed the marks drift by at an even pitch. When time speeds up the scale opens
// out: the marks already there rush together toward the playhead and pile up in
// the log-compressed past on the left, while coarser marks take their place.
import { START_YEAR } from '../time/time-model';
import { clamp, smoothstep } from '../util/rand';

// days, months, years, then decades up to hundreds of millions of years
const UNITS = [1 / 365.25, 1 / 12, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
// how many seconds of passing time the even stretch next to the playhead holds
const WINDOW_SECONDS = 5;
const MIN_PX = 3;
// share of the ruler (left of the playhead) given to the even stretch
const EVEN_FRAC = 0.5;

export class TimeTicks {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private logW = Math.log(0.01);
  private dpr = 1;

  constructor(parent: HTMLElement, private knobFrac: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ticks';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
  }

  layout(dpr: number): void {
    this.dpr = dpr;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  update(dt: number, year: number, yearRate: number): void {
    const A = Math.max(1e-3, year - START_YEAR);
    // the window follows the speed in log space, so a jump in speed reads as a
    // sweep of the scale rather than a cut; held when time stops
    if (Math.abs(yearRate) > 1e-6) {
      const target = Math.log(clamp(Math.abs(yearRate) * WINDOW_SECONDS, 0.004, A));
      this.logW += (target - this.logW) * (1 - Math.exp(-dt * 1.6));
    }
    const W = Math.min(Math.exp(this.logW), A * 0.5);
    const c = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    c.clearRect(0, 0, cw, ch);
    const knobX = cw * this.knobFrac;
    const px = this.dpr;
    // right of the join: the last few seconds of passing time at an even pitch;
    // left of it: everything before, squeezed on a log scale
    const L = knobX * EVEN_FRAC;
    const D = Math.log(A / W);
    const xAt = (age: number) => (age <= W ? knobX - (L * age) / W : (knobX - L) * (1 - Math.log(age / W) / D));
    const pitch = (unit: number, age: number) => (age <= W ? (unit * L) / W : (unit * (knobX - L)) / (D * age)) / px;

    // the pile: the stretch of the past where even the coarsest marks run together
    let pileFrom = knobX - L;
    for (const unit of UNITS) {
      if (pitch(unit, 0) < MIN_PX) continue;
      let y = Math.floor(year / unit) * unit;
      let lastAge = 0;
      for (let n = 0; n < 400; n++, y -= unit) {
        const age = year - y;
        if (age > A) break;
        const s = pitch(unit, age);
        if (s < MIN_PX) break;
        lastAge = age;
        const x = xAt(age);
        const a = smoothstep(MIN_PX, 12, s);
        const h = (3 + 7 * smoothstep(MIN_PX, 40, s)) * px;
        c.fillStyle = `rgba(255,255,255,${(0.1 + 0.4 * a).toFixed(3)})`;
        c.fillRect(Math.round(x), ch - h, px, h);
      }
      pileFrom = Math.min(pileFrom, xAt(lastAge));
    }
    if (pileFrom > 1) {
      const g = c.createLinearGradient(0, 0, pileFrom, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0.04)');
      c.fillStyle = g;
      c.fillRect(0, ch - 3 * px, pileFrom, 3 * px);
    }
  }
}
