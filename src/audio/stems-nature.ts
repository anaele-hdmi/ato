// Procedural nature stems. Every stem is a placeholder for a recorded one: where a file in
// public/audio/ would replace it, the class says so. Event stems generate each
// phrase fresh, so no figure is ever heard the same way twice.
import { Stem, type StemCtx } from './stem';
import { type Kit, burst, filter, gain, loopNoise, rand, tone } from './kit';

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
