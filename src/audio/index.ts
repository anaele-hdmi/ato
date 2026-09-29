import { buildGraph, type Graph, type SoundScene } from './graph';

export type { SoundScene };

export interface AudioEngine {
  /** Must be called from a user gesture (creates/resumes the AudioContext). */
  start(): Promise<void>;
  setMusicEnabled(on: boolean): void;   // BGM drone on/off (ambience stays)
  setMuted(muted: boolean): void;       // everything
  setVolume(v: number): void;           // master 0..1
  setScene(scene: SoundScene): void;    // crossfade ~1.5 s
  onSunrise(): void;                    // one soft chord bloom
  /** Play an audio URL as BGM instead of the drone; null = back to the drone. */
  setTrack(url: string | null): void;
  dispose(): void;
}

const LOOKAHEAD = 12; // seconds of events scheduled ahead

export { buildGraph };

export function createAudio(): AudioEngine {
  let ctx: AudioContext | null = null;
  let graph: Graph | null = null;
  let timer: number | undefined;
  let disposed = false;
  // State remembered before/after start so setters work at any time.
  let music = true, muted = false, volume = 0.8, scene: SoundScene = 'interior', track: string | null = null;

  const resume = () => {
    if (!ctx || disposed || document.visibilityState === 'hidden') return;
    // 'interrupted' is Safari-only (phone call, Siri, etc.)
    const st = ctx.state as string;
    if (st === 'suspended' || st === 'interrupted') ctx.resume().catch(() => { /* needs gesture; retried */ });
  };
  // Leaving the app (home screen, app switcher, lock) must silence it: a
  // home-screen web app on iOS otherwise keeps playing in the background.
  const onVisibility = () => {
    if (!ctx || disposed) return;
    if (document.visibilityState === 'visible') resume();
    else ctx.suspend().catch(() => { /* ignore */ });
  };
  const onPageHide = () => { ctx?.suspend().catch(() => { /* ignore */ }); };
  const onGesture = () => { if (ctx && ctx.state !== 'running') resume(); };

  const start = async () => {
    if (disposed) return;
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        // iOS: make Web Audio ignore the silent switch where supported (iOS 17+).
        const nav = navigator as Navigator & { audioSession?: { type: string } };
        if (nav.audioSession) nav.audioSession.type = 'playback';
      } catch { /* ignore */ }
      ctx = new Ctor({ latencyHint: 'playback' });
      graph = buildGraph(ctx, { scene });
      graph.setVolume(volume); graph.setMuted(muted); graph.setMusicEnabled(music);
      if (track) graph.setTrack(track);
      // Unlock trick for older iOS: play a 1-sample silent buffer inside the gesture.
      try {
        const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination); s.start(0);
      } catch { /* ignore */ }
      ctx.addEventListener('statechange', resume);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pageshow', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      // Any later gesture retries a resume if iOS left us suspended.
      for (const ev of ['pointerdown', 'touchend', 'click']) document.addEventListener(ev, onGesture, { passive: true });
      timer = window.setInterval(() => { if (ctx && graph && ctx.state === 'running') graph.pump(ctx.currentTime + LOOKAHEAD); }, 1000);
    }
    try { await ctx.resume(); } catch { /* ignore */ }
    graph?.pump(ctx.currentTime + LOOKAHEAD);
  };

  return {
    start,
    setMusicEnabled(on) { music = on; graph?.setMusicEnabled(on); },
    setMuted(m) { muted = m; graph?.setMuted(m); },
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); graph?.setVolume(volume); },
    setScene(s) { scene = s; graph?.setScene(s); },
    onSunrise() { if (ctx?.state === 'running') graph?.sunrise(); },
    setTrack(url) { track = url; graph?.setTrack(url); },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      for (const ev of ['pointerdown', 'touchend', 'click']) document.removeEventListener(ev, onGesture);
      graph?.dispose();
      ctx?.close().catch(() => { /* ignore */ });
      ctx = null; graph = null;
    },
  };
}
