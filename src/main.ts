import './style.css';
import type { SkipTarget, TimeRate } from './types';
import { EARTH_RADIUS_KM } from './types';
import { computeFrame, findNextSunrise, findNextSunset, ORBIT_PERIOD_S } from './sim/orbit';
import { createSceneRenderer } from './render/index';
import { mountUI } from './ui/index';
import { initMobileShell } from './ui/mobile';
import { CAMERA_LABEL } from './render/cameraRig';
import { createAudio } from './audio';
import { createGlobe } from './ui/globe';

// Skips land this long before the event so the moment itself is watched, not jumped over.
const SKIP_LEAD_MS = 90_000;
// Initial session starts 2 minutes before sunrise (design §13).
const START_LEAD_MS = 120_000;

function nextEvent(target: SkipTarget, t: number): number {
  return target === 'sunrise' ? findNextSunrise(t) : findNextSunset(t);
}

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? '北緯' : '南緯';
  const ew = lon >= 0 ? '東経' : '西経';
  return `${ns} ${Math.abs(lat).toFixed(1)}°  ${ew} ${Math.abs(lon).toFixed(1)}°`;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  let wakeLockUnsupported = false;
  const shell = initMobileShell({ onWakeLockUnsupported: () => (wakeLockUnsupported = true) });

  // ?t=<ISO time> pins the start time (for debugging / screenshots).
  const pinned = Date.parse(new URLSearchParams(location.search).get('t') ?? '');
  // Resume point after a GPU context loss (see below)
  let resumeAt = Number.NaN;
  try {
    resumeAt = Number(sessionStorage.getItem('lt.resume') ?? 'NaN');
    sessionStorage.removeItem('lt.resume');
  } catch {
    /* storage unavailable */
  }
  let simTime = Number.isFinite(pinned) ? pinned : Number.isFinite(resumeAt) ? resumeAt : Date.now();
  if (!Number.isFinite(pinned) && !Number.isFinite(resumeAt)) {
    const sunrise0 = findNextSunrise(simTime);
    if (Number.isFinite(sunrise0)) simTime = sunrise0 - START_LEAD_MS;
  }

  let rate: TimeRate = 1;
  const audio = createAudio();
  let trackUrl: string | null = null;
  let skipping = false;
  let switching = false;

  const ui = mountUI(uiRoot, {
    onRateChange(r) {
      rate = r;
      ui.setRate(r);
    },
    async onNextCamera() {
      if (switching) return;
      switching = true;
      await ui.fadeToBlack(250);
      const mode = renderer.nextCamera();
      ui.setCamera(CAMERA_LABEL[mode]);
      audio.setScene(mode === 'chase' ? 'exterior' : 'interior');
      await ui.fadeFromBlack(450);
      switching = false;
    },
    // Each audio control is a user gesture: (re)start the context here too,
    // since iOS only unlocks audio inside a gesture.
    onMusicToggle(on) {
      void audio.start();
      audio.setMusicEnabled(on);
    },
    onMuteToggle(m) {
      void audio.start();
      audio.setMuted(m);
    },
    onTrackFile(file) {
      void audio.start();
      if (trackUrl) URL.revokeObjectURL(trackUrl);
      trackUrl = file ? URL.createObjectURL(file) : null;
      audio.setTrack(trackUrl);
    },
    async onSkip(target) {
      if (skipping) return;
      const t = nextEvent(target, simTime);
      if (!Number.isFinite(t)) {
        ui.notify('この軌道では、しばらく夜が来ません');
        return;
      }
      skipping = true;
      await ui.fadeToBlack(600);
      simTime = Math.max(simTime, t - SKIP_LEAD_MS);
      renderer.aimAtSun();
      await ui.fadeFromBlack(900);
      skipping = false;
    },
  });
  ui.setRate(rate);

  // mini globe: where we are, day/night, the orbit; drag along the track to travel
  const globe = createGlobe(uiRoot, {
    computeFrame,
    orbitPeriodMs: ORBIT_PERIOD_S * 1000,
    async onSeek(t) {
      if (skipping) return;
      skipping = true;
      await ui.fadeToBlack(400);
      simTime = t;
      // seeking can go backwards: refresh the cached sunrise/sunset times
      nextRise = findNextSunrise(simTime);
      nextSet = findNextSunset(simTime);
      globe.update(simTime);
      await ui.fadeFromBlack(700);
      skipping = false;
    },
  });
  ui.setCamera(CAMERA_LABEL.cupola);

  // GPU context loss (long background, memory pressure): our baked textures
  // (clouds, Milky Way, LUTs) can't be rebuilt in place, so reload and resume
  // at the same sim time instead of leaving a black screen.
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      sessionStorage.setItem('lt.resume', String(simTime));
    } catch {
      /* ignore */
    }
    location.reload();
  });

  const renderer = await createSceneRenderer(canvas);
  const resize = () =>
    renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  window.addEventListener('resize', resize);
  resize();
  // Start facing where the Sun will come up (design §13: something must happen in the first minutes).
  renderer.aimAtSun();

  // Cache event times; recompute only after they pass.
  let nextRise = findNextSunrise(simTime);
  let nextSet = findNextSunset(simTime);
  let readoutAcc = 1;

  let wasInShadow: boolean | null = null;
  // Frame cap (battery / heat): 30 fps by default, 20 fps after 5 s without
  // input, ?fps=N overrides (60 or more = uncapped). Driven by rAF timestamps;
  // sim time advances by the real elapsed time between *rendered* frames.
  const fpsParam = Number(new URLSearchParams(location.search).get('fps'));
  const fpsOverride = Number.isFinite(fpsParam) && fpsParam > 0 ? fpsParam : 0;
  const IDLE_AFTER_MS = 5000;
  let lastInput = performance.now();
  const noteInput = () => {
    lastInput = performance.now();
  };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart', 'keydown'])
    window.addEventListener(ev, noteInput, { passive: true });
  let last = performance.now();
  let nextDue = 0;
  const loop = (now: number) => {
    const fps = fpsOverride || (now - lastInput > IDLE_AFTER_MS ? 20 : 30);
    if (fps < 59) {
      const interval = 1000 / fps;
      if (now < nextDue - 2) {
        requestAnimationFrame(loop);
        return;
      }
      // keep the cadence (no drift); resync if we fell more than a frame behind
      nextDue += interval;
      if (nextDue < now) nextDue = now + interval;
    }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    simTime += dt * 1000 * rate;

    const frame = computeFrame(simTime);
    globe.update(simTime);
    // orbital sunrise: one soft chord
    if (wasInShadow && !frame.inShadow) audio.onSunrise();
    wasInShadow = frame.inShadow;
    renderer.update(frame, dt);

    readoutAcc += dt;
    if (readoutAcc >= 0.5) {
      readoutAcc = 0;
      if (!(nextRise > simTime)) nextRise = findNextSunrise(simTime);
      if (!(nextSet > simTime)) nextSet = findNextSunset(simTime);
      const [label, t] = frame.inShadow ? ['日の出まで', nextRise] : ['日の入りまで', nextSet];
      const eta = Number.isFinite(t) ? formatCountdown(t - simTime) : '--:--';
      const p = frame.stationPos;
      const v = frame.stationVel;
      const altKm = Math.hypot(p.x, p.y, p.z) - EARTH_RADIUS_KM;
      const speedKms = Math.hypot(v.x, v.y, v.z);
      const sunEl = (Math.asin((p.x * frame.sunDir.x + p.y * frame.sunDir.y + p.z * frame.sunDir.z) / Math.hypot(p.x, p.y, p.z)) * 180) / Math.PI;
      ui.setReadout(
        `高度 ${altKm.toFixed(0)} km  ·  秒速 ${speedKms.toFixed(2)} km  ·  太陽高度 ${sunEl.toFixed(0)}°\n` +
          `${formatLatLon(frame.latDeg, frame.lonDeg)}  ·  ${label} ${eta}`,
      );
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Audio, wake lock and fullscreen must start inside the tap itself (iOS).
  await ui.waitForStart(() => {
    audio.setScene('interior');
    void audio.start();
    shell.onStarted();
  });
  ui.notify('ドラッグで見回す ・ ピンチで寄る');
  if (wakeLockUnsupported) setTimeout(() => ui.notify('画面が自動で消灯する場合があります'), 5000);
}

main();
