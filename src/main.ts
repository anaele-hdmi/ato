import './style.css';
import type { SkipTarget, TimeRate } from './types';
import { computeFrame, findNextSunrise, findNextSunset } from './sim/orbit';
import { createSceneRenderer } from './render/index';
import { mountUI } from './ui/index';
import { initMobileShell } from './ui/mobile';

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

  let simTime = Date.now();
  const sunrise0 = findNextSunrise(simTime);
  if (Number.isFinite(sunrise0)) simTime = sunrise0 - START_LEAD_MS;

  let rate: TimeRate = 1;
  let skipping = false;

  const ui = mountUI(uiRoot, {
    onRateChange(r) {
      rate = r;
      ui.setRate(r);
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
      await ui.fadeFromBlack(900);
      skipping = false;
    },
  });
  ui.setRate(rate);

  const renderer = await createSceneRenderer(canvas);
  const resize = () =>
    renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  window.addEventListener('resize', resize);
  resize();

  // Cache event times; recompute only after they pass.
  let nextRise = findNextSunrise(simTime);
  let nextSet = findNextSunset(simTime);
  let readoutAcc = 1;

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    simTime += dt * 1000 * rate;

    const frame = computeFrame(simTime);
    renderer.update(frame, dt);

    readoutAcc += dt;
    if (readoutAcc >= 0.5) {
      readoutAcc = 0;
      if (!(nextRise > simTime)) nextRise = findNextSunrise(simTime);
      if (!(nextSet > simTime)) nextSet = findNextSunset(simTime);
      const [label, t] = frame.inShadow ? ['日の出まで', nextRise] : ['日の入りまで', nextSet];
      const eta = Number.isFinite(t) ? formatCountdown(t - simTime) : '--:--';
      ui.setReadout(`${formatLatLon(frame.latDeg, frame.lonDeg)}  ·  ${label} ${eta}`);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  await ui.waitForStart();
  shell.onStarted();
  if (wakeLockUnsupported) ui.notify('画面が自動で消灯する場合があります');
}

main();
