// Playback, scrub and the two cyclic clocks (season from the year, day from wall time).
import { clamp, smoothstep } from '../util/rand';
import { DEEP_U0, uToYear, yearToU } from './time-model';

export const SPEEDS = 4; // 0 stop, 1 slow, 2 mid, 3 fast
const YEARS_PER_SEC = [0, 1 / 45, 0.6, 7];
// In deep time years stop meaning anything, so playback advances the scrub itself.
const DEEP_U_PER_SEC = [0, 0.0011, 0.0045, 0.016];
// One day takes this many seconds of wall time.
const DAY_SECONDS = 240;

export class Clock {
  u = yearToU(1900.28);
  year = uToYear(this.u);
  speed = 1;
  scrubbing = false;
  /** Signed years per second, smoothed. */
  yearRate = 0;
  /** |du/dt|, smoothed; drives audio smear. */
  scrubRate = 0;
  season = this.year % 1;
  seasonality = 1;
  day = 0.36;
  private lastU = this.u;

  setU(u: number): void {
    this.u = clamp(u, 0, 1);
  }

  cycleSpeed(): number {
    this.speed = (this.speed + 1) % SPEEDS;
    return this.speed;
  }

  update(dt: number, terminal: number): void {
    if (!this.scrubbing && this.speed > 0) {
      const yr = uToYear(this.u);
      const dudy = (yearToU(yr + 0.01) - this.u) / 0.01;
      const humanDu = YEARS_PER_SEC[this.speed] * dudy * dt;
      const deepness = smoothstep(DEEP_U0 - 0.02, DEEP_U0 + 0.05, this.u);
      const deepDu = DEEP_U_PER_SEC[this.speed] * deepness * dt;
      this.u = clamp(this.u + Math.max(humanDu, deepDu), 0, 1);
    }
    const prevYear = this.year;
    this.year = uToYear(this.u);
    const k = 1 - Math.exp(-dt * 6);
    const rawRate = dt > 0 ? (this.year - prevYear) / dt : 0;
    this.yearRate += (rawRate - this.yearRate) * k;
    const rawU = dt > 0 ? Math.abs(this.u - this.lastU) / dt : 0;
    this.scrubRate += (rawU - this.scrubRate) * (1 - Math.exp(-dt * 8));
    this.lastU = this.u;

    // Season follows the year along the shortest arc, rate-limited so a fast drag
    // reads as drift rather than strobing.
    const target = ((this.year % 1) + 1) % 1;
    let d = target - this.season;
    d -= Math.round(d);
    const maxStep = 0.45 * dt;
    this.season = (this.season + clamp(d, -maxStep, maxStep) + 1) % 1;
    const deep = smoothstep(DEEP_U0 - 0.01, DEEP_U0 + 0.1, this.u);
    const want = (1 - smoothstep(1.5, 14, Math.abs(this.yearRate))) * (1 - deep);
    this.seasonality += (want - this.seasonality) * (1 - Math.exp(-dt * 2));

    // Day runs on wall time; near the end it settles at dusk and holds.
    const dayRate = (1 / DAY_SECONDS) * (1 - terminal);
    this.day = (this.day + dayRate * dt) % 1;
    if (terminal > 0) {
      let dd = 0.775 - this.day;
      dd -= Math.round(dd);
      this.day = (this.day + dd * (1 - Math.exp(-dt * 0.6 * terminal)) + 1) % 1;
    }
  }
}
