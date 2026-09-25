// Small Web Audio building blocks: noise buffers, one-shot envelopes, a room.
export interface Kit {
  ctx: AudioContext;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  reverb: AudioNode;
}

export function noiseBuffer(ctx: AudioContext, seconds: number, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    }
    // crossfade the ends so the loop point has no click
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t;
    }
  }
  return buf;
}

export function roomImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

/** A looping noise source started at a random offset, so two stems never align. */
export function loopNoise(kit: Kit, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const s = kit.ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(kit.ctx.currentTime, Math.random() * buf.duration);
  return s;
}

export function filter(ctx: AudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export function gain(ctx: AudioContext, v = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/** Plays a noise burst through a band-pass; used for steps, clicks, thuds. */
export function burst(
  kit: Kit, out: AudioNode, when: number,
  o: { freq: number; q?: number; dur: number; amp: number; pan?: number; kind?: 'white' | 'pink' | 'brown'; attack?: number; type?: BiquadFilterType },
): void {
  const { ctx } = kit;
  const src = ctx.createBufferSource();
  src.buffer = o.kind === 'brown' ? kit.brown : o.kind === 'pink' ? kit.pink : kit.white;
  const f = filter(ctx, o.type ?? 'bandpass', o.freq, o.q ?? 1.2);
  const g = gain(ctx, 0);
  const a = o.attack ?? 0.004;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(o.amp, when + a);
  g.gain.exponentialRampToValueAtTime(0.0001, when + a + o.dur);
  let node: AudioNode = g;
  if (o.pan !== undefined && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    g.connect(p);
    node = p;
  }
  src.connect(f).connect(g);
  node.connect(out);
  src.start(when, Math.random() * (src.buffer.duration - 1));
  src.stop(when + a + o.dur + 0.05);
}

/** A sine (or other) tone with a pitch path and exponential decay. */
export function tone(
  kit: Kit, out: AudioNode, when: number,
  o: { f0: number; f1?: number; dur: number; amp: number; type?: OscillatorType; pan?: number; attack?: number },
): void {
  const { ctx } = kit;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0, when);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, when + o.dur);
  const g = gain(ctx, 0);
  const a = o.attack ?? 0.01;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(o.amp, when + a);
  g.gain.exponentialRampToValueAtTime(0.0001, when + a + o.dur);
  let node: AudioNode = g;
  if (o.pan !== undefined && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    g.connect(p);
    node = p;
  }
  osc.connect(g);
  node.connect(out);
  osc.start(when);
  osc.stop(when + a + o.dur + 0.05);
}

export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
