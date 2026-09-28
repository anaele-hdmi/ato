/**
 * Mobile shell concerns that don't belong in the 3D scene or the on-screen
 * UI itself: orientation lock + rotate nudge, screen wake lock, and
 * iOS pinch/double-tap zoom suppression.
 *
 * Call `initMobileShell(...)` once at startup (it wires the rotate overlay
 * and zoom guards immediately). Call the returned `onStarted()` from inside
 * the user gesture that begins the experience (the start-screen tap) —
 * fullscreen, orientation lock and wake lock all require a user gesture /
 * are best requested right after one.
 */

interface MobileShellOptions {
  /**
   * Called at most once if Screen Wake Lock is unsupported in this browser,
   * so the caller can surface a single quiet notice (e.g. via
   * UIController.notify("画面が自動で消灯する場合があります")).
   */
  onWakeLockUnsupported?: () => void;
}

export interface MobileShell {
  onStarted(): void;
}

function isPortrait(): boolean {
  try {
    return window.matchMedia('(orientation: portrait)').matches;
  } catch {
    return false;
  }
}

function buildRotateOverlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'lt-rotate';
  el.textContent = '端末を横にしてください';
  el.hidden = !isPortrait();
  document.body.appendChild(el);

  const mq = window.matchMedia('(orientation: portrait)');
  const update = (): void => {
    el.hidden = !mq.matches;
  };
  try {
    mq.addEventListener('change', update);
  } catch {
    // Safari <14 fallback
    window.addEventListener('resize', update);
  }
  return el;
}

function installZoomGuards(): void {
  const prevent = (e: Event): void => e.preventDefault();
  // iOS Safari gesture events (pinch). Not standard DOM types in all libs.
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('gesturechange', prevent, { passive: false });
  document.addEventListener('gestureend', prevent, { passive: false });
  document.addEventListener('dblclick', prevent, { passive: false });
}

async function requestWakeLock(
  state: { sentinel: WakeLockSentinel | null },
  onUnsupported?: () => void,
): Promise<void> {
  if (!('wakeLock' in navigator)) {
    onUnsupported?.();
    return;
  }
  try {
    state.sentinel = await navigator.wakeLock.request('screen');
  } catch {
    // Request can fail (e.g. tab not visible, low battery mode). Silent —
    // it will be retried on the next visibilitychange.
  }
}

export function initMobileShell(options: MobileShellOptions = {}): MobileShell {
  buildRotateOverlay();
  installZoomGuards();

  let wakeLockUnsupportedNotified = false;
  const wakeState: { sentinel: WakeLockSentinel | null } = { sentinel: null };

  const notifyUnsupportedOnce = (): void => {
    if (wakeLockUnsupportedNotified) return;
    wakeLockUnsupportedNotified = true;
    options.onWakeLockUnsupported?.();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void requestWakeLock(wakeState, notifyUnsupportedOnce);
    }
  });

  function onStarted(): void {
    void requestWakeLock(wakeState, notifyUnsupportedOnce);

    // Fullscreen + orientation lock: Android Chrome only in practice. iOS
    // Safari has neither requestFullscreen (reliably) nor
    // screen.orientation.lock, so these no-op there — expected, not a bug.
    void (async () => {
      try {
        const el = document.documentElement as HTMLElement & {
          requestFullscreen?: () => Promise<void>;
        };
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        }
      } catch {
        // Fullscreen can be denied/unsupported — proceed without it.
      }
      try {
        await screen.orientation?.lock?.('landscape');
      } catch {
        // Not supported (iOS Safari) or not allowed outside fullscreen —
        // the rotate overlay is the fallback in that case.
      }
    })();
  }

  return { onStarted };
}
