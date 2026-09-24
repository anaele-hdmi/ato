// Procedural stems. Every stem is a placeholder for a recorded one: where a file in
// public/audio/ would replace it, the class says so. Event stems generate each
// phrase fresh, so no figure is ever heard the same way twice.
import type { StemName } from '../time/time-model';
import { type Kit, burst, filter, gain, loopNoise, rand, tone } from './kit';

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

// replace with: public/audio/wind-*.ogg (long, non-looping takes crossfaded)
export class WindStem extends Stem {
  private lp: BiquadFilterNode;
  private body: GainNode;
  private howlF: BiquadFilterNode;
  private howl: GainNode;
  private pan: StereoPannerNode | null = null;
  constructor(kit: Kit, dest: AudioNode) {
    super('wind', kit, dest);
    const { ctx } = kit;
    this.farBoost = 0.3;
    this.level = 1.0;
    this.lp = filter(ctx, 'lowpass', 500, 0.5);
    this.body = gain(ctx, 0.3);
    loopNoise(kit, kit.brown, 1).connect(this.lp);
    loopNoise(kit, kit.brown, 0.83).connect(this.lp);
    let node: AudioNode = this.body;
    if (ctx.createStereoPanner) {
      this.pan = ctx.createStereoPanner();
      this.body.connect(this.pan);
      node = this.pan;
    }
    this.lp.connect(this.body);
    node.connect(this.out);
    this.howlF = filter(ctx, 'bandpass', 520, 14);
    this.howl = gain(ctx, 0);
    loopNoise(kit, kit.pink, 1).connect(this.howlF).connect(this.howl).connect(this.out);
  }
  protected tick(c: StemCtx): void {
    const w = c.wind;
    this.lp.frequency.setTargetAtTime(180 + 1100 * w * w, c.now, 0.4);
    this.body.gain.setTargetAtTime(0.04 + 0.9 * Math.pow(w, 1.4), c.now, 0.5);
    this.howlF.frequency.setTargetAtTime(380 + 420 * w + 60 * Math.sin(c.now * 0.13), c.now, 1.5);
    this.howl.gain.setTargetAtTime(0.25 * w * w * w, c.now, 0.8);
    this.pan?.pan.setTargetAtTime(0.4 * Math.sin(c.now * 0.05), c.now, 2);
  }
}

export class GrassStem extends Stem {
  private g: GainNode;
  constructor(kit: Kit, dest: AudioNode) {
    super('grass', kit, dest);
    const { ctx } = kit;
    this.nearness = 1;
    this.level = 0.5;
    this.g = gain(ctx, 0);
    loopNoise(kit, kit.white, 1).connect(filter(ctx, 'highpass', 2600, 0.6)).connect(filter(ctx, 'bandpass', 5200, 0.5)).connect(this.g).connect(this.out);
  }
  protected tick(c: StemCtx): void {
    const flutter = 0.55 + 0.45 * Math.random();
    this.g.gain.setTargetAtTime(Math.pow(c.wind, 1.7) * flutter * 0.5, c.now, 0.12);
  }
}

// replace with: public/audio/birds-*.ogg as sparse one-shots
export class BirdsStem extends Stem {
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('birds', kit, dest);
    this.nearness = 0.7;
    this.level = 0.8;
  }
  protected tick(c: StemCtx): void {
    const density = (0.25 + 1.4 * c.morning) * (1 - 0.92 * c.night) * (0.6 + 0.6 * c.summer);
    if (density < 0.02) return;
    this.schedule(c, () => rand(1.5, 9) / density, (t) => {
      const base = rand(2100, 4800);
      const notes = 1 + Math.floor(Math.random() * 6);
      const pan = rand(-0.8, 0.8);
      const far = Math.random();
      const amp = 0.04 * (1 - far * 0.8);
      let tt = t;
      for (let i = 0; i < notes; i++) {
        const f0 = base * rand(0.85, 1.2);
        const d = rand(0.03, 0.16);
        tone(this.kit, far > 0.5 ? this.send : this.out, tt, { f0, f1: f0 * rand(0.7, 1.4), dur: d, amp, pan, attack: 0.006 });
        tt += d + rand(0.03, 0.14);
      }
    });
  }
}

export class MorningStem extends Stem {
  constructor(kit: Kit, dest: AudioNode) {
    super('morning', kit, dest);
    const { ctx } = kit;
    this.level = 0.1;
    this.nearness = 0.4;
    loopNoise(kit, kit.pink, 0.7).connect(filter(ctx, 'bandpass', 6800, 3)).connect(this.out);
  }
  apply(c: StemCtx): void {
    super.apply({ ...c, weight: c.weight * (0.2 + c.morning) * (1 - c.night) });
  }
  protected tick(): void {}
}

// replace with: public/audio/gravel-steps-*.ogg
export class GravelStem extends Stem {
  constructor(kit: Kit, dest: AudioNode) {
    super('gravel', kit, dest);
    this.nearness = 0.9;
    this.level = 0.9;
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(7, 22), (t) => {
      const n = 6 + Math.floor(Math.random() * 12);
      const gap = rand(0.5, 0.64);
      const p0 = rand(-0.9, 0.9), p1 = rand(-0.9, 0.9);
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const env = Math.sin(k * Math.PI);
        burst(this.kit, this.out, t + i * gap + rand(-0.03, 0.03), {
          freq: rand(1400, 2600), q: 0.9, dur: rand(0.05, 0.09), amp: 0.05 * env * rand(0.6, 1), pan: p0 + (p1 - p0) * k,
        });
      }
    });
  }
}

// replace with: public/audio/distant-work-*.ogg, public/audio/cattle-*.ogg
export class WorkStem extends Stem {
  private cowAt = 0;
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('work', kit, dest);
    this.level = 0.9;
    this.nearness = 0.3;
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(9, 30), (t) => {
      const hits = 2 + Math.floor(Math.random() * 5);
      const gap = rand(0.8, 1.7);
      const pan = rand(-0.7, 0.7);
      for (let i = 0; i < hits; i++) {
        const tt = t + i * gap * rand(0.9, 1.1);
        tone(this.kit, this.send, tt, { f0: rand(90, 130), f1: 50, dur: 0.18, amp: 0.1, pan });
        burst(this.kit, this.send, tt, { freq: 900, dur: 0.05, amp: 0.05, pan, type: 'lowpass' });
      }
    });
    if (c.now > this.cowAt) {
      if (this.cowAt > 0) {
        const f = rand(92, 118);
        const { ctx } = this.kit;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const t = c.now + 0.1;
        const d = rand(1.3, 2.3);
        osc.frequency.setValueAtTime(f, t);
        osc.frequency.linearRampToValueAtTime(f * rand(0.8, 0.92), t + d);
        const g = gain(ctx, 0);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.03, t + 0.3);
        g.gain.linearRampToValueAtTime(0, t + d);
        const f1 = filter(ctx, 'bandpass', rand(420, 560), 4);
        osc.connect(f1).connect(g).connect(filter(ctx, 'lowpass', 1100)).connect(this.send);
        osc.start(t);
        osc.stop(t + d + 0.1);
      }
      this.cowAt = c.now + rand(40, 110);
    }
  }
}

// replace with: public/audio/wire-hum.ogg
export class HumStem extends Stem {
  private g: GainNode;
  constructor(kit: Kit, dest: AudioNode) {
    super('hum', kit, dest);
    const { ctx } = kit;
    this.level = 0.35;
    this.g = gain(ctx, 0.5);
    const lp = filter(ctx, 'lowpass', 340, 0.7);
    for (const [f, type, a] of [[50, 'sawtooth', 0.4], [100, 'sine', 0.3], [150, 'sine', 0.12]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = rand(-4, 4);
      const og = gain(ctx, a);
      o.connect(og).connect(lp);
      o.start();
    }
    lp.connect(this.g).connect(this.out);
  }
  protected tick(c: StemCtx): void {
    this.g.gain.setTargetAtTime((0.25 + 0.75 * c.poleNear) * (0.8 + 0.2 * Math.sin(c.now * 0.7)), c.now, 0.5);
  }
}

// replace with: public/audio/traffic-far-*.ogg
export class TrafficStem extends Stem {
  private bed: GainNode;
  constructor(kit: Kit, dest: AudioNode) {
    super('traffic', kit, dest);
    const { ctx } = kit;
    this.level = 0.22;
    this.farBoost = 0.2;
    this.bed = gain(ctx, 0.3);
    loopNoise(kit, kit.brown, 1).connect(filter(ctx, 'lowpass', 420, 0.5)).connect(this.bed).connect(this.out);
  }
  protected tick(c: StemCtx): void {
    this.bed.gain.setTargetAtTime(0.35 + 0.25 * Math.sin(c.now * 0.09) + 0.1 * Math.sin(c.now * 0.31), c.now, 1);
    this.schedule(c, () => rand(2.5, 9), (t) => {
      const { ctx } = this.kit;
      const src = ctx.createBufferSource();
      src.buffer = this.kit.pink;
      const f = filter(ctx, 'bandpass', 300, 1.2);
      const d = rand(3, 6);
      f.frequency.setValueAtTime(260, t);
      f.frequency.linearRampToValueAtTime(rand(700, 1000), t + d * 0.5);
      f.frequency.linearRampToValueAtTime(240, t + d);
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(rand(0.05, 0.12), t + d * 0.5);
      g.gain.linearRampToValueAtTime(0, t + d);
      let node: AudioNode = g;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        const s = Math.random() < 0.5 ? -1 : 1;
        p.pan.setValueAtTime(-0.8 * s, t);
        p.pan.linearRampToValueAtTime(0.8 * s, t + d);
        g.connect(p);
        node = p;
      }
      src.connect(f).connect(g);
      node.connect(this.out);
      src.start(t, Math.random() * 5);
      src.stop(t + d + 0.1);
    });
  }
}

// replace with: public/audio/city-steps-*.ogg, public/audio/doors-*.ogg
export class StepsStem extends Stem {
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('steps', kit, dest);
    this.nearness = 0.9;
    this.level = 0.8;
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(2, 8), (t) => {
      if (Math.random() < 0.2) {
        burst(this.kit, this.send, t, { freq: 180, dur: 0.12, amp: 0.12, type: 'lowpass', kind: 'brown', pan: rand(-0.6, 0.6) });
        return;
      }
      const n = 3 + Math.floor(Math.random() * 7);
      const gap = rand(0.42, 0.55);
      const pan = rand(-0.8, 0.8);
      for (let i = 0; i < n; i++) {
        burst(this.kit, this.out, t + i * gap, { freq: rand(2800, 4200), q: 2, dur: 0.03, amp: 0.035 * Math.sin(((i + 0.5) / n) * Math.PI), pan });
      }
    });
  }
}

// replace with: public/audio/city-drone.ogg
export class DroneStem extends Stem {
  private oscs: OscillatorNode[] = [];
  constructor(kit: Kit, dest: AudioNode) {
    super('drone', kit, dest);
    const { ctx } = kit;
    this.level = 0.16;
    this.farBoost = 0.4;
    const lp = filter(ctx, 'lowpass', 240, 0.6);
    for (const f of [41.2, 55.1, 82.6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(gain(ctx, 0.3)).connect(lp);
      o.start();
      this.oscs.push(o);
    }
    loopNoise(kit, kit.brown, 0.6).connect(filter(ctx, 'lowpass', 130, 0.5)).connect(gain(ctx, 0.8)).connect(lp);
    lp.connect(this.out);
  }
  protected tick(c: StemCtx): void {
    this.oscs.forEach((o, i) => o.detune.setTargetAtTime(9 * Math.sin(c.now * (0.021 + i * 0.013) + i), c.now, 2));
  }
}

export class ElectricStem extends Stem {
  private g: GainNode;
  constructor(kit: Kit, dest: AudioNode) {
    super('electric', kit, dest);
    const { ctx } = kit;
    this.level = 0.05;
    this.g = gain(ctx, 1);
    for (const f of [9100, 11300, 12700]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * rand(0.99, 1.01);
      o.connect(gain(ctx, 0.3)).connect(this.g);
      o.start();
    }
    this.g.connect(this.out);
  }
  protected tick(c: StemCtx): void {
    this.g.gain.setTargetAtTime(Math.random() < 0.08 ? 0.2 : 1, c.now, 0.05);
  }
}

// replace with: public/audio/metal-far-*.ogg
export class MetalStem extends Stem {
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('metal', kit, dest);
    this.level = 1;
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(8, 26), (t) => {
      const f0 = rand(170, 430);
      const pan = rand(-0.9, 0.9);
      const d = rand(2, 6);
      [1, 2.76, 5.4, 8.93].forEach((r, i) => tone(this.kit, this.send, t, { f0: f0 * r, dur: d / (1 + i * 0.6), amp: 0.02 / (1 + i), pan, attack: 0.003 }));
    });
  }
}

// replace with: public/audio/creak-*.ogg
export class CreakStem extends Stem {
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('creak', kit, dest);
    this.nearness = 0.5;
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(6, 20) / (0.4 + c.wind), (t) => {
      const { ctx } = this.kit;
      const o = ctx.createOscillator();
      o.type = 'square';
      const d = rand(0.5, 1.8);
      o.frequency.setValueAtTime(rand(14, 30), t);
      o.frequency.linearRampToValueAtTime(rand(25, 55), t + d);
      const bp = filter(ctx, 'bandpass', rand(550, 1300), 9);
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.1);
      g.gain.linearRampToValueAtTime(0, t + d);
      o.connect(bp).connect(g).connect(this.send);
      o.start(t);
      o.stop(t + d + 0.1);
    });
  }
}

// replace with: public/audio/insects-night-*.ogg
export class InsectsStem extends Stem {
  private voices: { g: GainNode; rate: number; ph: number }[] = [];
  constructor(kit: Kit, dest: AudioNode) {
    super('insects', kit, dest);
    const { ctx } = kit;
    this.nearness = 0.9;
    this.level = 0.2;
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.frequency.value = rand(4100, 4900);
      const trem = ctx.createOscillator();
      trem.type = 'square';
      trem.frequency.value = rand(26, 34);
      const tg = gain(ctx, 0);
      trem.connect(tg.gain);
      const g = gain(ctx, 0);
      let node: AudioNode = g;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = rand(-0.9, 0.9);
        g.connect(p);
        node = p;
      }
      o.connect(tg).connect(g);
      node.connect(this.out);
      o.start();
      trem.start();
      this.voices.push({ g, rate: rand(0.7, 1.6), ph: Math.random() * 10 });
    }
  }
  apply(c: StemCtx): void {
    super.apply({ ...c, weight: c.weight * c.summer * (0.25 + 0.75 * c.night) });
  }
  protected tick(c: StemCtx): void {
    // chirp gating plus slow drifting presence, so the pattern never settles
    for (const v of this.voices) {
      const phase = (c.now * v.rate + v.ph) % 1;
      const on = phase < 0.35 ? 1 : 0;
      const pres = 0.5 + 0.5 * Math.sin(c.now * 0.05 * v.rate + v.ph);
      v.g.gain.setTargetAtTime(on * pres * 0.5, c.now, 0.02);
    }
  }
}

// replace with: public/audio/rain-*.ogg
export class RainStem extends Stem {
  private bed: GainNode;
  private episode = 0;
  private episodeUntil = 0;
  constructor(kit: Kit, dest: AudioNode) {
    super('rain', kit, dest);
    const { ctx } = kit;
    this.level = 0.7;
    this.bed = gain(ctx, 0);
    loopNoise(kit, kit.white, 1).connect(filter(ctx, 'highpass', 900, 0.5)).connect(filter(ctx, 'lowpass', 6500, 0.5)).connect(this.bed).connect(this.out);
  }
  protected tick(c: StemCtx): void {
    if (c.now > this.episodeUntil) {
      this.episode = Math.random() < 0.55 ? rand(0.3, 1) : 0;
      this.episodeUntil = c.now + rand(25, 90);
    }
    this.bed.gain.setTargetAtTime(0.35 * this.episode, c.now, 4);
    if (this.episode > 0.1) {
      this.schedule(c, () => rand(0.05, 0.4) / this.episode, (t) => {
        tone(this.kit, this.out, t, { f0: rand(1700, 3400), f1: rand(900, 1500), dur: 0.02, amp: 0.02, pan: rand(-1, 1), attack: 0.001 });
      });
    }
  }
}

export class AnimalsStem extends Stem {
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('animals', kit, dest);
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(20, 60), (t) => {
      const n = 1 + Math.floor(Math.random() * 3);
      const pan = rand(-0.9, 0.9);
      for (let i = 0; i < n; i++) {
        burst(this.kit, this.send, t + i * rand(0.6, 1.3), { freq: rand(700, 1100), q: 3, dur: 0.16, amp: 0.12, pan, kind: 'pink' });
      }
    });
  }
}

// replace with: public/audio/ice-*.ogg
export class IceStem extends Stem {
  constructor(kit: Kit, dest: AudioNode, private send: AudioNode) {
    super('ice', kit, dest);
    this.farBoost = 0.3;
  }
  protected tick(c: StemCtx): void {
    this.schedule(c, () => rand(5, 18), (t) => {
      if (Math.random() < 0.5) {
        tone(this.kit, this.send, t, { f0: rand(38, 62), f1: rand(28, 45), dur: rand(2.5, 6), amp: 0.14, attack: 0.8, type: 'triangle' });
      } else {
        burst(this.kit, this.send, t, { freq: rand(1500, 3500), q: 0.8, dur: rand(0.08, 0.3), amp: 0.12, pan: rand(-0.8, 0.8), type: 'highpass' });
      }
    });
  }
}

// replace with: public/audio/shore-*.ogg
export class WaterStem extends Stem {
  private lp: BiquadFilterNode;
  private g: GainNode;
  private waveEnd = 0;
  constructor(kit: Kit, dest: AudioNode) {
    super('water', kit, dest);
    const { ctx } = kit;
    this.farBoost = 0.1;
    this.level = 0.7;
    this.lp = filter(ctx, 'lowpass', 500, 0.5);
    this.g = gain(ctx, 0);
    loopNoise(kit, kit.pink, 1).connect(this.lp).connect(this.g).connect(this.out);
  }
  protected tick(c: StemCtx): void {
    if (c.now > this.waveEnd) {
      const d = rand(5.5, 11);
      const t = c.now;
      this.lp.frequency.cancelScheduledValues(t);
      this.g.gain.cancelScheduledValues(t);
      this.lp.frequency.setValueAtTime(this.lp.frequency.value, t);
      this.lp.frequency.linearRampToValueAtTime(rand(900, 1700), t + d * 0.45);
      this.lp.frequency.linearRampToValueAtTime(350, t + d);
      this.g.gain.setValueAtTime(this.g.gain.value, t);
      this.g.gain.linearRampToValueAtTime(rand(0.35, 0.7), t + d * 0.45);
      this.g.gain.linearRampToValueAtTime(0.08, t + d);
      this.waveEnd = t + d;
    }
  }
}
