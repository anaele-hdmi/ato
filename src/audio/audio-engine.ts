// Buses: ambience, drone, spot, ui -> altitude EQ -> holes -> master.
// Nothing here may throw into the render loop; audio failing must leave the picture running.
import type { Env } from '../time/time-model';
import { smoothstep } from '../util/rand';
import { type Kit, burst, filter, gain, noiseBuffer, rand, roomImpulse, tone } from './kit';
import type { Stem } from './stem';
import {
  AnimalsStem, BirdsStem, GrassStem, IceStem, InsectsStem, MorningStem, RainStem, WaterStem, WindStem,
} from './stems-nature';
import {
  CreakStem, DroneStem, ElectricStem, GravelStem, HumStem, MetalStem, StepsStem, TrafficStem, WorkStem,
} from './stems-human';

export interface AudioFrame {
  env: Env;
  altitude: number;
  scrubRate: number;
  night: number;
  morning: number;
  summer: number;
  wind: number;
  poleNear: number;
  listener: { x: number; y: number; z: number; fx: number; fy: number; fz: number };
  house: { x: number; y: number; z: number; hearth: number; well: number };
}

interface Graph {
  kit: Kit;
  master: GainNode;
  buses: { ambience: GainNode; drone: GainNode; spot: GainNode; ui: GainNode };
  lowShelf: BiquadFilterNode;
  highShelf: BiquadFilterNode;
  lp: BiquadFilterNode;
  hole: GainNode;
  dry: GainNode;
  wet: GainNode;
  stems: Stem[];
  spotPanner: PannerNode;
  holeUntil: number;
  nextSpot: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private muted = false;
  failed = false;

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Call from inside a user gesture. Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx || this.ctx.state === 'closed') {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) { this.failed = true; return; }
        this.ctx = new AC({ latencyHint: 'playback' });
        this.g = null;
        this.ctx.onstatechange = () => { /* resumed on the next gesture if needed */ };
      }
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
      if (!this.g) this.g = this.build(this.ctx);
    } catch {
      this.failed = true;
    }
  }

  suspend(): void {
    try { void this.ctx?.suspend(); } catch { /* ignore */ }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (!this.ctx || !this.g) return;
    try {
      this.g.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.15);
    } catch { /* ignore */ }
  }

  isMuted(): boolean {
    return this.muted;
  }

  private build(ctx: AudioContext): Graph {
    const kit: Kit = {
      ctx,
      white: noiseBuffer(ctx, 9.7, 'white'),
      pink: noiseBuffer(ctx, 11.3, 'pink'),
      brown: noiseBuffer(ctx, 13.1, 'brown'),
      reverb: ctx.createConvolver(),
    };
    (kit.reverb as ConvolverNode).buffer = roomImpulse(ctx, 3.2);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    const master = gain(ctx, 0);
    master.gain.setTargetAtTime(this.muted ? 0 : 0.9, ctx.currentTime, 1.2);
    master.connect(comp);
    const hole = gain(ctx, 1);
    hole.connect(master);
    const lp = filter(ctx, 'lowpass', 18000, 0.5);
    lp.connect(hole);
    const highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 2800;
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 160;
    lowShelf.connect(highShelf).connect(lp);

    const mix = gain(ctx, 1);
    const dry = gain(ctx, 1);
    mix.connect(dry).connect(lowShelf);
    // Scrub smear: a wobbling short delay chopped into grains.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.07;
    const fb = gain(ctx, 0.55);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.3;
    const lfoAmt = gain(ctx, 0.025);
    lfo.connect(lfoAmt).connect(delay.delayTime);
    const chop = gain(ctx, 0.5);
    const chopLfo = ctx.createOscillator();
    chopLfo.type = 'square';
    chopLfo.frequency.value = 17;
    const chopAmt = gain(ctx, 0.5);
    chopLfo.connect(chopAmt).connect(chop.gain);
    lfo.start();
    chopLfo.start();
    const wet = gain(ctx, 0);
    mix.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(chop).connect(wet).connect(lowShelf);

    const buses = { ambience: gain(ctx, 1), drone: gain(ctx, 1), spot: gain(ctx, 1), ui: gain(ctx, 1) };
    buses.ambience.connect(mix);
    buses.drone.connect(mix);
    buses.spot.connect(mix);
    buses.ui.connect(master);
    const send = gain(ctx, 0.55);
    send.connect(kit.reverb);
    kit.reverb.connect(buses.ambience);

    const A = buses.ambience, D = buses.drone;
    const stems: Stem[] = [
      new WindStem(kit, A), new GrassStem(kit, A), new BirdsStem(kit, A, send), new MorningStem(kit, A),
      new GravelStem(kit, A), new WorkStem(kit, A, send), new HumStem(kit, D), new TrafficStem(kit, A),
      new StepsStem(kit, A, send), new DroneStem(kit, D), new ElectricStem(kit, D), new MetalStem(kit, A, send),
      new CreakStem(kit, A, send), new InsectsStem(kit, A), new RainStem(kit, A), new AnimalsStem(kit, A, send),
      new IceStem(kit, A, send), new WaterStem(kit, A),
    ];

    const spotPanner = ctx.createPanner();
    spotPanner.panningModel = 'equalpower';
    spotPanner.distanceModel = 'inverse';
    spotPanner.refDistance = 4;
    spotPanner.rolloffFactor = 1.3;
    spotPanner.connect(buses.spot);

    return { kit, master, buses, lowShelf, highShelf, lp, hole, dry, wet, stems, spotPanner, holeUntil: 0, nextSpot: 0 };
  }

  update(f: AudioFrame): void {
    const ctx = this.ctx, g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      const a = f.altitude;
      g.lp.frequency.setTargetAtTime(700 + 17000 * Math.pow(1 - a, 2.4), now, 0.3);
      g.highShelf.gain.setTargetAtTime(-14 * a, now, 0.3);
      g.lowShelf.gain.setTargetAtTime(3 * a, now, 0.3);

      const smear = smoothstep(0.01, 0.12, f.scrubRate);
      g.wet.gain.setTargetAtTime(smear * 0.9, now, 0.12);
      g.dry.gain.setTargetAtTime(1 - 0.55 * smear, now, 0.12);

      // Holes: stretches of near-silence, more of them when things are breaking down.
      if (now > g.holeUntil) {
        g.hole.gain.setTargetAtTime(1, now, 0.8);
        if (Math.random() < f.env.silence * 0.02) {
          const d = rand(2, 8);
          g.hole.gain.setTargetAtTime(0.04, now, 0.3);
          g.holeUntil = now + d;
        }
      }

      for (const s of g.stems) {
        s.apply({
          now, weight: f.env.stems[s.name], altitude: a, wind: f.wind, night: f.night,
          morning: f.morning, summer: f.summer, poleNear: f.poleNear,
        });
      }

      const L = ctx.listener;
      const l = f.listener;
      if (L.positionX) {
        L.positionX.setTargetAtTime(l.x, now, 0.05);
        L.positionY.setTargetAtTime(l.y, now, 0.05);
        L.positionZ.setTargetAtTime(l.z, now, 0.05);
        L.forwardX.setTargetAtTime(l.fx, now, 0.05);
        L.forwardY.setTargetAtTime(l.fy, now, 0.05);
        L.forwardZ.setTargetAtTime(l.fz, now, 0.05);
      } else {
        L.setPosition(l.x, l.y, l.z);
        L.setOrientation(l.fx, l.fy, l.fz, 0, 1, 0);
      }
      const p = g.spotPanner;
      if (p.positionX) {
        p.positionX.value = f.house.x; p.positionY.value = f.house.y; p.positionZ.value = f.house.z;
      } else {
        p.setPosition(f.house.x, f.house.y, f.house.z);
      }
      // hearth crackle and the odd drip in the well
      if (now > g.nextSpot) {
        g.nextSpot = now + rand(0.08, 0.6);
        if (Math.random() < f.house.hearth * 0.6) {
          burst(g.kit, p, now + 0.05, { freq: rand(2000, 5000), q: 1.5, dur: rand(0.01, 0.04), amp: rand(0.05, 0.2) });
        }
        if (Math.random() < f.house.well * 0.02) {
          tone(g.kit, p, now + 0.05, { f0: rand(900, 1300), f1: rand(1500, 2000), dur: 0.06, amp: 0.08, attack: 0.002 });
        }
      }
    } catch {
      /* keep drawing */
    }
  }
}
