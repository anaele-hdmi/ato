/**
 * Pure Web Audio graph for "低軌道旅行". Builds on any BaseAudioContext
 * (AudioContext at runtime, OfflineAudioContext for tests). No assets: everything
 * is synthesised. Time-based events (chord changes, radio bursts, high partials)
 * are scheduled ahead of time by `pump(untilTime)` so there is no per-frame work.
 */

export type SoundScene = 'interior' | 'exterior';

export interface GraphOptions {
  rng?: () => number;
  scene?: SoundScene;
  /** Delay before the first radio burst (s, context time). Default random 12..35. */
  firstRadioAt?: number;
  /** Fixed chord-change interval for tests. Default random 40..90. */
  chordInterval?: () => number;
}

export interface Graph {
  master: GainNode;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  setMusicEnabled(on: boolean): void;
  setScene(scene: SoundScene, immediate?: boolean): void;
  sunrise(at?: number): void;
  setTrack(url: string | null): void;
  /** Schedule all events up to context time `until`. Cheap; call ~1x/s. */
  pump(until: number): void;
  dispose(): void;
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// Small modal chord vocabulary (semitones above root). Open voicings, low-mid register.
const CHORDS: number[][] = [
  [0, 7, 14, 19, 24], // 5ths + 9th
  [0, 7, 12, 16, 23], // maj7
  [0, 5, 12, 17, 24], // sus4
  [0, 7, 12, 15, 22], // m7
  [0, 2, 7, 14, 19],  // add9 / sus2
  [0, 7, 12, 18, 23], // lydian maj7#11
  [0, 7, 10, 15, 22], // dorian-ish stack
];
const ROOTS = [38, 41, 43, 45, 46, 36]; // D2 F2 G2 A2 Bb2 C2

export function buildGraph(ctx: BaseAudioContext, opts: GraphOptions = {}): Graph {
  const rnd = opts.rng ?? Math.random;
  const range = (a: number, b: number) => a + (b - a) * rnd();
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const sr = ctx.sampleRate;
  const t0 = ctx.currentTime;
  const nodes: AudioScheduledSourceNode[] = [];
  const start = <T extends AudioScheduledSourceNode>(n: T, at = 0): T => { n.start(at); nodes.push(n); return n; };

  // ---------- master chain ----------
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 24; comp.ratio.value = 3;
  comp.attack.value = 0.02; comp.release.value = 0.5;
  const trim = ctx.createGain(); trim.gain.value = 0.4; // overall headroom: calm level
  master.connect(comp); comp.connect(trim); trim.connect(ctx.destination);
  let volume = 0.8, muted = false;
  const applyMaster = () => master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.08);

  // ---------- noise buffers ----------
  const noiseBuf = (secs: number, kind: 'white' | 'pink' | 'brown') => {
    const len = Math.floor(sr * secs);
    const b = ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return b;
  };
  const white = noiseBuf(2, 'white');
  const pink = noiseBuf(6, 'pink');
  const brown = noiseBuf(6, 'brown');
  const loopNoise = (buf: AudioBuffer) => {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
    start(s, 0); // offset via loopStart trick is unnecessary; sources differ in filters
    return s;
  };
  const lfo = (freq: number, depth: number, target: AudioParam, phaseDelay = 0) => {
    const o = ctx.createOscillator(); o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = depth;
    o.connect(g); g.connect(target); start(o, t0 + phaseDelay);
    return o;
  };

  // ---------- reverb (generated impulse response) ----------
  const reverb = ctx.createConvolver();
  {
    const len = Math.floor(sr * 4.2), pre = Math.floor(sr * 0.03);
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let y = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const a = 0.55 * Math.exp(-t / 1.1) + 0.06; // darker tail over time
        y += a * ((rnd() * 2 - 1) - y);
        d[i] = y * Math.exp(-6.9 * t / 4.0) * (1 - Math.exp(-t * 40));
      }
    }
    reverb.buffer = ir;
  }
  const reverbIn = ctx.createGain(); reverbIn.gain.value = 1;
  const reverbOut = ctx.createGain(); reverbOut.gain.value = 0.9;
  reverbIn.connect(reverb); reverb.connect(reverbOut);

  // ---------- music bus ----------
  // droneBus + trackBus -> musicGain(enable) -> sceneLP -> sceneGain -> master
  const sceneGain = ctx.createGain();
  const sceneLP = ctx.createBiquadFilter(); sceneLP.type = 'lowpass'; sceneLP.Q.value = 0.4; sceneLP.frequency.value = 14000;
  const musicGain = ctx.createGain(); musicGain.gain.value = 1;
  musicGain.connect(sceneLP); sceneLP.connect(sceneGain); sceneGain.connect(master);
  reverbOut.connect(musicGain); // reverb tail shares the music path (goes distant in exterior too)

  const droneBus = ctx.createGain(); droneBus.gain.value = 1;
  const droneDry = ctx.createGain(); droneDry.gain.value = 0.45;
  const droneSend = ctx.createGain(); droneSend.gain.value = 0.9;
  const swell = ctx.createGain(); swell.gain.value = 1;
  lfo(1 / 53, 0.12, swell.gain);
  const padLP = ctx.createBiquadFilter(); padLP.type = 'lowpass'; padLP.Q.value = 0.6; padLP.frequency.value = 650;
  lfo(1 / 173, 260, padLP.frequency);     // cutoff drifts over minutes
  lfo(1 / 97, 140, padLP.frequency, 11);
  padLP.connect(swell); swell.connect(droneBus);
  droneBus.connect(droneDry); droneDry.connect(musicGain);
  droneBus.connect(droneSend); droneSend.connect(reverbIn);

  const NV = 5;
  const voices: { f: OscillatorNode[]; g: GainNode }[] = [];
  for (let v = 0; v < NV; v++) {
    const g = ctx.createGain(); g.gain.value = v === 0 ? 0.11 : 0.045;
    const oscs: OscillatorNode[] = [];
    const types: OscillatorType[] = v === 0 ? ['sine', 'triangle'] : ['sawtooth', v % 2 ? 'triangle' : 'sawtooth'];
    types.forEach((ty, k) => {
      const o = ctx.createOscillator(); o.type = ty;
      o.detune.value = (k === 0 ? -1 : 1) * range(3, 8);
      lfo(range(0.03, 0.11), range(3, 7), o.detune, range(0, 5)); // slow detune wander
      o.connect(g); start(o, t0); oscs.push(o);
    });
    g.connect(padLP);
    voices.push({ f: oscs, g });
  }
  let rootMidi = 38, chordIdx = 0;
  const setChord = (at: number, glide: number) => {
    let r = pick(ROOTS); if (r === rootMidi) r = pick(ROOTS);
    let c = Math.floor(rnd() * CHORDS.length); if (c === chordIdx) c = (c + 1) % CHORDS.length;
    rootMidi = r; chordIdx = c;
    CHORDS[c].forEach((semi, v) => {
      const f = mtof(r + semi);
      voices[v].f.forEach(o => {
        if (glide <= 0) o.frequency.setValueAtTime(f, at);
        else o.frequency.setTargetAtTime(f, at, glide);
      });
    });
    // let upper voices breathe a little differently every change
    voices.forEach((vo, v) => { if (v > 0) vo.g.gain.setTargetAtTime(range(0.025, 0.055), at, 6); });
  };
  setChord(t0, 0);

  // ---------- sparse high partials ----------
  const partial = (at: number) => {
    const semi = pick(CHORDS[chordIdx].slice(1));
    const f = mtof(rootMidi + semi + 24 + (rnd() < 0.5 ? 0 : 12));
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain(); const peak = range(0.006, 0.012);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + range(1.2, 2.2));
    g.gain.setTargetAtTime(0, at + 2.5, range(1.2, 2));
    const pan = ctx.createStereoPanner?.(); 
    o.connect(g);
    if (pan) { pan.pan.value = range(-0.7, 0.7); g.connect(pan); pan.connect(reverbIn); pan.connect(droneBus); }
    else { g.connect(reverbIn); g.connect(droneBus); }
    o.start(at); o.stop(at + 12);
    o.onended = () => { try { o.disconnect(); g.disconnect(); pan?.disconnect(); } catch { /* */ } };
  };

  // ---------- external track (user BGM) ----------
  const trackBus = ctx.createGain(); trackBus.gain.value = 0;
  trackBus.connect(musicGain);
  let trackEl: HTMLAudioElement | null = null;
  let trackSrc: MediaElementAudioSourceNode | null = null;
  let musicOn = true;
  const applyTrackPlayback = () => {
    if (!trackEl) return;
    if (musicOn) trackEl.play().catch(() => { /* needs gesture; retried by engine resume */ });
    else trackEl.pause();
  };
  const setTrack = (url: string | null) => {
    const now = ctx.currentTime;
    if (trackEl) { trackEl.pause(); trackEl.removeAttribute('src'); trackEl.load(); }
    if (url === null || typeof Audio === 'undefined' || !('createMediaElementSource' in ctx)) {
      trackBus.gain.setTargetAtTime(0, now, 0.6);
      droneBus.gain.setTargetAtTime(1, now, 1.2);
      if (trackEl) { trackEl.pause(); }
      return;
    }
    if (!trackEl) {
      trackEl = new Audio();
      trackEl.loop = true; trackEl.preload = 'auto'; trackEl.crossOrigin = 'anonymous';
      (trackEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      trackEl.addEventListener('error', () => setTrack(null)); // bad URL -> back to drone
      trackSrc = (ctx as AudioContext).createMediaElementSource(trackEl);
      trackSrc.connect(trackBus);
    }
    trackEl.src = url;
    applyTrackPlayback();
    trackBus.gain.setTargetAtTime(0.9, now, 0.8);
    droneBus.gain.setTargetAtTime(0, now, 0.8);
  };

  // ---------- fan hum (interior) ----------
  const ambience = ctx.createGain(); ambience.gain.value = 1;
  const fanBus = ctx.createGain(); fanBus.gain.value = 0.5;
  fanBus.connect(ambience); ambience.connect(master);
  {
    const b = loopNoise(brown); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    const g = ctx.createGain(); g.gain.value = 0.5;
    b.connect(lp); lp.connect(g); g.connect(fanBus);
    lfo(0.07, 0.08, g.gain);

    const p = loopNoise(pink);
    const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.frequency.value = 850; bp1.Q.value = 0.9;
    const g1 = ctx.createGain(); g1.gain.value = 0.13;
    p.connect(bp1); bp1.connect(g1); g1.connect(fanBus);
    lfo(0.11, 120, bp1.frequency); lfo(0.05, 0.03, g1.gain);

    const p2 = loopNoise(white);
    const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 2600; bp2.Q.value = 1.6;
    const g2 = ctx.createGain(); g2.gain.value = 0.014;
    p2.connect(bp2); bp2.connect(g2); g2.connect(fanBus);
    lfo(0.09, 0.006, g2.gain, 3);

    // faint motor tone(s)
    [[96, 0.028], [192, 0.008], [71, 0.02]].forEach(([f, a], i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = a;
      lfo(0.13 + i * 0.03, a * 0.35, g.gain, i);
      lfo(0.2, 0.4, o.frequency);
      o.connect(g); g.connect(fanBus); start(o, t0);
    });
  }

  // ---------- radio chatter (interior) ----------
  const radioBus = ctx.createGain(); radioBus.gain.value = 1;
  radioBus.connect(ambience);
  const radioOut = ctx.createGain(); radioOut.gain.value = 0.32;
  radioOut.connect(radioBus);
  // distant, slightly small-speaker colour
  const radioHP = ctx.createBiquadFilter(); radioHP.type = 'highpass'; radioHP.frequency.value = 320;
  const radioLP = ctx.createBiquadFilter(); radioLP.type = 'lowpass'; radioLP.frequency.value = 3200;
  radioHP.connect(radioLP); radioLP.connect(radioOut);
  const shaper = ctx.createWaveShaper();
  { const n = 256, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); } shaper.curve = c; }
  shaper.connect(radioHP);

  const noiseSrc = (at: number, dur: number) => {
    const s = ctx.createBufferSource(); s.buffer = white; s.loop = true;
    s.start(at, rnd() * 1.5); s.stop(at + dur);
    return s;
  };
  const click = (at: number, dur: number, level: number) => {
    const s = noiseSrc(at, dur + 0.02);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = range(1800, 2800); bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(level, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, at + dur);
    s.connect(bp); bp.connect(g); g.connect(shaper);
    s.onended = () => { try { s.disconnect(); bp.disconnect(); g.disconnect(); } catch { /* */ } };
  };
  const radioBurst = (at: number) => {
    const dur = range(1.5, 4);
    const end = at + 0.09 + dur;
    click(at, 0.03, 0.9);                     // squelch open
    // carrier hiss bed
    const hiss = noiseSrc(at + 0.03, dur + 0.15);
    const hbp = ctx.createBiquadFilter(); hbp.type = 'bandpass'; hbp.frequency.value = 1700; hbp.Q.value = 0.5;
    const hg = ctx.createGain(); hg.gain.setValueAtTime(0, at); hg.gain.linearRampToValueAtTime(0.07, at + 0.05);
    hg.gain.setValueAtTime(0.07, end); hg.gain.linearRampToValueAtTime(0, end + 0.06);
    hiss.connect(hbp); hbp.connect(hg); hg.connect(shaper);
    // voice-like buzz: glottal saw -> 3 formant bandpasses, syllable-gated, wobbling pitch
    const saw = ctx.createOscillator(); saw.type = 'sawtooth';
    const f0 = range(105, 150);
    saw.frequency.setValueAtTime(f0, at);
    const vib = ctx.createOscillator(); vib.frequency.value = range(4.5, 6.5);
    const vibG = ctx.createGain(); vibG.gain.value = f0 * 0.025; vib.connect(vibG); vibG.connect(saw.frequency);
    const vg = ctx.createGain(); vg.gain.value = 0;
    const F = [ctx.createBiquadFilter(), ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    const fq = [6, 8, 10], fgain = [1, 0.7, 0.4];
    F.forEach((f, i) => {
      f.type = 'bandpass'; f.Q.value = fq[i];
      const gg = ctx.createGain(); gg.gain.value = fgain[i];
      saw.connect(f); f.connect(gg); gg.connect(vg);
    });
    vg.connect(shaper);
    let t = at + 0.14, pitch = f0;
    const gated = () => t < end - 0.1;
    while (gated()) {
      const syl = range(0.07, 0.24);
      const lvl = range(0.10, 0.22);
      // vowel-ish formant targets, but without any linguistic content
      const f1 = range(350, 800), f2 = range(900, 2200), f3 = range(2300, 3000);
      pitch = Math.max(85, Math.min(190, pitch * range(0.85, 1.18)));
      [f1, f2, f3].forEach((ff, i) => F[i].frequency.setTargetAtTime(ff, t, 0.025));
      saw.frequency.setTargetAtTime(pitch, t, 0.04);
      vg.gain.setTargetAtTime(lvl, t, 0.012);
      vg.gain.setTargetAtTime(lvl * 0.15, t + syl * 0.75, 0.02);
      t += syl;
      if (rnd() < 0.28) { vg.gain.setTargetAtTime(0, t, 0.02); t += range(0.12, 0.45); } // phrase gap
    }
    vg.gain.setTargetAtTime(0, end - 0.1, 0.02);
    saw.start(at); saw.stop(end + 0.2); vib.start(at); vib.stop(end + 0.2);
    click(end + 0.02, 0.02, 0.55);            // squelch tail click
    const tail = noiseSrc(end + 0.02, 0.09);
    const tg = ctx.createGain(); tg.gain.setValueAtTime(0.06, end + 0.02); tg.gain.exponentialRampToValueAtTime(0.0005, end + 0.1);
    tail.connect(tg); tg.connect(shaper);
    saw.onended = () => { try { saw.disconnect(); vg.disconnect(); F.forEach(f => f.disconnect()); } catch { /* */ } };
  };

  // ---------- sunrise chord bloom ----------
  const bloomBus = ctx.createGain(); bloomBus.gain.value = 1;
  bloomBus.connect(master);
  const bloomSend = ctx.createGain(); bloomSend.gain.value = 0.9;
  bloomBus.connect(bloomSend); bloomSend.connect(reverbIn);
  const sunrise = (at = ctx.currentTime + 0.05) => {
    const base = rootMidi + 24; // an octave-or-two above the drone root
    [0, 7, 14, 16, 23].forEach((semi, i) => {
      const f = mtof(base + semi);
      [-2, 2].forEach(det => {
        const o = ctx.createOscillator(); o.type = i % 2 ? 'sine' : 'triangle';
        o.frequency.value = f; o.detune.value = det;
        const g = ctx.createGain();
        const a = at + i * 0.35; const peak = 0.028 / (1 + i * 0.25);
        g.gain.setValueAtTime(0, a);
        g.gain.linearRampToValueAtTime(peak, a + 2.6);
        g.gain.setTargetAtTime(0, a + 3.2, 1.6);
        o.connect(g); g.connect(bloomBus);
        o.start(a); o.stop(a + 14);
        o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* */ } };
      });
    });
  };

  // ---------- scene ----------
  const setScene = (scene: SoundScene, immediate = false) => {
    const now = ctx.currentTime, tc = immediate ? 0.001 : 0.5; // ~1.5 s to settle
    const ext = scene === 'exterior';
    ambience.gain.setTargetAtTime(ext ? 0 : 1, now, tc);
    sceneGain.gain.setTargetAtTime(ext ? 0.55 : 1, now, tc);
    sceneLP.frequency.setTargetAtTime(ext ? 700 : 14000, now, tc);
  };
  setScene(opts.scene ?? 'interior', true);

  // ---------- scheduler ----------
  let nextChord = t0 + (opts.chordInterval ? opts.chordInterval() : range(40, 90));
  let nextRadio = t0 + (opts.firstRadioAt ?? range(12, 35));
  let nextPartial = t0 + range(8, 25);
  const pump = (until: number) => {
    const now = ctx.currentTime;
    if (nextChord < now) nextChord = now + 1;   // throttled timers: don't burst catch up
    if (nextRadio < now) nextRadio = now + range(2, 20);
    if (nextPartial < now) nextPartial = now + range(2, 15);
    while (nextChord < until) { setChord(nextChord, 4.5); nextChord += opts.chordInterval ? opts.chordInterval() : range(40, 90); }
    while (nextRadio < until) { radioBurst(nextRadio); nextRadio += range(40, 120); }
    while (nextPartial < until) { partial(nextPartial); nextPartial += range(14, 45); }
  };

  return {
    master,
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); applyMaster(); },
    setMuted(m) { muted = m; applyMaster(); },
    setMusicEnabled(on) {
      musicOn = on;
      musicGain.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.6);
      applyTrackPlayback();
    },
    setScene,
    sunrise,
    setTrack,
    pump,
    dispose() {
      if (trackEl) { trackEl.pause(); trackEl.removeAttribute('src'); trackEl.load(); trackEl = null; }
      trackSrc?.disconnect();
      nodes.forEach(n => { try { n.stop(); } catch { /* */ } });
      try { master.disconnect(); comp.disconnect(); trim.disconnect(); } catch { /* */ }
    },
  };
}
