// Base types shared by every stem.
import type { StemName } from '../time/time-model';
import { type Kit, gain } from './kit';

export interface StemCtx {
  now: number;
  weight: number;
  /** 0 = camera at grass level, 1 = highest. */
  altitude: number;
  wind: number;
  night: number;
  morning: number;
  summer: number;
  poleNear: number;
}

export abstract class Stem {
  readonly out: GainNode;
  /** How much the stem belongs to the near field (fades as the camera rises). */
  nearness = 0;
  /** Extra presence when high up (wind, low drones). */
  farBoost = 0;
  level = 1;
  protected nextAt = 0;

  constructor(readonly name: StemName, protected kit: Kit, dest: AudioNode) {
    this.out = gain(kit.ctx, 0);
    this.out.connect(dest);
  }

  apply(c: StemCtx): void {
    const alt = c.altitude;
    const w = c.weight * this.level * (1 - this.nearness * Math.pow(alt, 0.8)) * (1 + this.farBoost * alt);
    this.out.gain.setTargetAtTime(Math.max(0, w), c.now, 0.5);
    if (c.weight > 0.015) this.tick(c);
    else this.nextAt = Math.max(this.nextAt, c.now);
  }

  protected abstract tick(c: StemCtx): void;

  /** Run `fire` for each event falling inside the look-ahead window. */
  protected schedule(c: StemCtx, interval: () => number, fire: (t: number) => void): void {
    if (this.nextAt < c.now) this.nextAt = c.now + interval() * Math.random();
    while (this.nextAt < c.now + 0.25) {
      fire(this.nextAt);
      this.nextAt += interval();
    }
  }
}
