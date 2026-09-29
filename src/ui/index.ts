import type { SkipTarget, TimeRate } from '../types';

export interface UIHandlers {
  onRateChange(rate: TimeRate): void;
  onSkip(target: SkipTarget): void;
  onNextCamera(): void;
}

export interface UIController {
  /** Resolves on the first tap of the start screen (user gesture: use it to request wake lock / audio later). */
  waitForStart(): Promise<void>;
  setReadout(text: string): void; // e.g. "北緯 34.2°  東経 135.1°  · 日の出まで 01:52"
  setRate(rate: TimeRate): void;
  /** Shows the current viewpoint's name on the view button. */
  setCamera(label: string): void;
  setSkipEnabled(target: SkipTarget, enabled: boolean): void;
  fadeToBlack(ms: number): Promise<void>;
  fadeFromBlack(ms: number): Promise<void>;
  notify(text: string): void; // one quiet transient line, auto-hides
}

const VISITED_KEY = 'lt.visited';
const IDLE_MS_FIRST = 10_000;
const IDLE_MS_AFTER = 3_000;
const NOTIFY_MS = 4_200;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function hasVisitedBefore(): boolean {
  try {
    return window.localStorage.getItem(VISITED_KEY) === '1';
  } catch {
    return false;
  }
}

function markVisited(): void {
  try {
    window.localStorage.setItem(VISITED_KEY, '1');
  } catch {
    // storage unavailable (private mode / quota) — degrade to "always first session"
  }
}

export function mountUI(root: HTMLElement, handlers: UIHandlers): UIController {
  const reduced = prefersReducedMotion();

  // ---------- build DOM ----------

  const startScreen = document.createElement('div');
  startScreen.className = 'lt-start';
  const startTitle = document.createElement('div');
  startTitle.className = 'lt-start__title';
  startTitle.textContent = '低軌道旅行';
  const startHint = document.createElement('div');
  startHint.className = 'lt-start__hint';
  startHint.textContent = 'タップして出発';
  startScreen.append(startTitle, startHint);

  const fadeOverlay = document.createElement('div');
  fadeOverlay.className = 'lt-fade';

  const readout = document.createElement('div');
  readout.className = 'lt-readout lt-fadeable';

  const controls = document.createElement('div');
  controls.className = 'lt-controls lt-fadeable';

  const camBtn = document.createElement('button');
  camBtn.type = 'button';
  camBtn.className = 'lt-btn';
  camBtn.addEventListener('click', () => {
    handlers.onNextCamera();
    wake();
  });

  const rateBtn = document.createElement('button');
  rateBtn.type = 'button';
  rateBtn.className = 'lt-btn';
  rateBtn.setAttribute('aria-pressed', 'false');

  const sunriseBtn = document.createElement('button');
  sunriseBtn.type = 'button';
  sunriseBtn.className = 'lt-btn';
  sunriseBtn.textContent = '次の日の出へ';

  const sunsetBtn = document.createElement('button');
  sunsetBtn.type = 'button';
  sunsetBtn.className = 'lt-btn';
  sunsetBtn.textContent = '次の日の入りへ';

  controls.append(camBtn, rateBtn, sunriseBtn, sunsetBtn);

  const notifyEl = document.createElement('div');
  notifyEl.className = 'lt-notify';

  root.append(fadeOverlay, readout, controls, notifyEl, startScreen);

  // ---------- rate toggle ----------

  let currentRate: TimeRate = 1;

  function renderRate(): void {
    // shows the current speed; tapping toggles
    rateBtn.textContent = currentRate === 1 ? '速度 ×1' : '速度 ×10';
    rateBtn.setAttribute('aria-pressed', String(currentRate === 10));
  }
  renderRate();

  rateBtn.addEventListener('click', () => {
    currentRate = currentRate === 1 ? 10 : 1;
    renderRate();
    handlers.onRateChange(currentRate);
    wake();
  });

  sunriseBtn.addEventListener('click', () => {
    handlers.onSkip('sunrise');
    wake();
  });
  sunsetBtn.addEventListener('click', () => {
    handlers.onSkip('sunset');
    wake();
  });

  // ---------- idle fade ----------

  const idleMs = hasVisitedBefore() ? IDLE_MS_AFTER : IDLE_MS_FIRST;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  function showFadeables(): void {
    readout.classList.remove('lt-dim');
    controls.classList.remove('lt-dim');
  }

  function hideFadeables(): void {
    readout.classList.add('lt-dim');
    controls.classList.add('lt-dim');
  }

  function wake(): void {
    if (!started) return;
    showFadeables();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(hideFadeables, idleMs);
  }

  root.addEventListener('pointerdown', wake, { passive: true });

  // ---------- start screen ----------

  function waitForStart(): Promise<void> {
    return new Promise((resolve) => {
      const onTap = (): void => {
        startScreen.removeEventListener('pointerdown', onTap);
        startScreen.classList.add('lt-hidden');
        markVisited();
        started = true;
        wake();
        const done = (): void => resolve();
        if (reduced) {
          done();
        } else {
          startScreen.addEventListener(
            'transitionend',
            () => done(),
            { once: true },
          );
          // Safety net in case transitionend doesn't fire (e.g. display:none races).
          setTimeout(done, 1000);
        }
      };
      startScreen.addEventListener('pointerdown', onTap, { once: true });
    });
  }

  // ---------- readout / rate / skip ----------

  function setReadout(text: string): void {
    readout.textContent = text;
  }

  function setRate(rate: TimeRate): void {
    currentRate = rate;
    renderRate();
  }

  function setCamera(label: string): void {
    camBtn.textContent = `視点 ${label}`;
  }

  function setSkipEnabled(target: SkipTarget, enabled: boolean): void {
    const btn = target === 'sunrise' ? sunriseBtn : sunsetBtn;
    btn.disabled = !enabled;
  }

  // ---------- fade to / from black ----------

  function fadeToBlack(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const duration = reduced ? Math.min(ms, 200) : ms;
      fadeOverlay.style.transition = `opacity ${duration}ms ease`;
      fadeOverlay.style.pointerEvents = 'auto';
      // force reflow so the transition applies even if opacity was already mid-change
      void fadeOverlay.offsetHeight;
      fadeOverlay.style.opacity = '1';
      setTimeout(resolve, duration);
    });
  }

  function fadeFromBlack(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const duration = reduced ? Math.min(ms, 200) : ms;
      fadeOverlay.style.transition = `opacity ${duration}ms ease`;
      void fadeOverlay.offsetHeight;
      fadeOverlay.style.opacity = '0';
      setTimeout(() => {
        fadeOverlay.style.pointerEvents = 'none';
        resolve();
      }, duration);
    });
  }

  // ---------- notify ----------

  let notifyTimer: ReturnType<typeof setTimeout> | undefined;

  function notify(text: string): void {
    notifyEl.textContent = text;
    notifyEl.classList.add('lt-visible');
    if (notifyTimer !== undefined) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyEl.classList.remove('lt-visible');
    }, NOTIFY_MS);
  }

  return {
    waitForStart,
    setReadout,
    setRate,
    setCamera,
    setSkipEnabled,
    fadeToBlack,
    fadeFromBlack,
    notify,
  };
}
