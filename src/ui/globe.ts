// Minimal orthographic mini-globe: land, day/night terminator, ground track,
// and scrubbing along the track. Pure 2D canvas, redrawn a few times a second.
import { feature } from 'topojson-client';
import land from 'world-atlas/land-110m.json';
import type { FrameState } from '../types';

export interface GlobeWidget {
  /** Call ~4–10×/s (not every frame) with the current sim time. */
  update(simTimeMs: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

const SIZE = 112; // css px
const PAD = 4; // css px between disc and canvas edge
const R = SIZE / 2 - PAD;
const D2R = Math.PI / 180;
const STEP_MS = 30_000;
const PAST_PERIODS = 0.5;
const FUTURE_PERIODS = 1.0;
const PICK_RADIUS = 16; // css px
const MIN_REDRAW_MS = 200;
const RECENTER_DEG = 0.5;
const IDLE_MS = 4000;
const NIGHT_RES = 72;

type Ring = Float32Array; // [lonRad, latRad, ...]

let ringsCache: Ring[] | null = null;

function loadRings(): Ring[] {
  if (ringsCache) return ringsCache;
  const out: Ring[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fc: any = feature(land as any, (land as any).objects.land);
  const geoms = fc.features ? fc.features.map((f: any) => f.geometry) : [fc.geometry];
  const maxStep = 3; // degrees; densify long edges so they curve on the sphere
  const addRing = (ring: number[][]) => {
    const pts: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      if (i > 0) {
        const [plon, plat] = ring[i - 1];
        let dlon = lon - plon;
        if (dlon > 180) dlon -= 360;
        else if (dlon < -180) dlon += 360;
        const n = Math.ceil(Math.max(Math.abs(dlon), Math.abs(lat - plat)) / maxStep);
        for (let k = 1; k < n; k++) {
          pts.push((plon + (dlon * k) / n) * D2R, (plat + ((lat - plat) * k) / n) * D2R);
        }
      }
      pts.push(lon * D2R, lat * D2R);
    }
    out.push(Float32Array.from(pts));
  };
  for (const g of geoms) {
    if (!g) continue;
    if (g.type === 'Polygon') g.coordinates.forEach(addRing);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p: number[][][]) => p.forEach(addRing));
  }
  ringsCache = out;
  return out;
}

function sunSubPoint(f: FrameState): { lat: number; lon: number } {
  const s = f.sunDir; // scene: x=ECI.x, y=ECI.z, z=-ECI.y
  const lat = Math.asin(Math.max(-1, Math.min(1, s.y)));
  const lon = Math.atan2(-s.z, s.x) - f.gmstRad;
  return { lat, lon };
}

interface P {
  x: number; // right, -1..1
  y: number; // up, -1..1
  z: number; // toward viewer
}

function makeProjector(lat0: number, lon0: number) {
  const sp = Math.sin(lat0);
  const cp = Math.cos(lat0);
  return (lat: number, lon: number, out: P): P => {
    const cl = Math.cos(lat);
    const dl = lon - lon0;
    const cd = Math.cos(dl);
    out.x = cl * Math.sin(dl);
    out.y = cp * Math.sin(lat) - sp * cl * cd;
    out.z = sp * Math.sin(lat) + cp * cl * cd;
    return out;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createGlobe(
  root: HTMLElement,
  opts: {
    computeFrame: (timeMs: number) => FrameState;
    orbitPeriodMs: number;
    onSeek: (timeMs: number) => void;
    onSeekPreview?: (timeMs: number | null) => void;
  },
): GlobeWidget {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const wrap = document.createElement('div');
  wrap.className = 'lt-globe lt-fadeable';
  const canvas = document.createElement('canvas');
  canvas.className = 'lt-globe__canvas';
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round(SIZE * dpr);
  canvas.setAttribute('aria-label', '現在位置と軌道');
  wrap.appendChild(canvas);
  root.appendChild(wrap);
  const ctx = canvas.getContext('2d')!;

  const rings = loadRings();
  const fontFamily = getComputedStyle(wrap).fontFamily || 'sans-serif';

  // Offscreen: ocean + land at the cached centre.
  const base = document.createElement('canvas');
  base.width = canvas.width;
  base.height = canvas.height;
  const bctx = base.getContext('2d')!;
  // Offscreen: night shading at low res.
  const night = document.createElement('canvas');
  night.width = night.height = NIGHT_RES;
  const nctx = night.getContext('2d')!;
  const nimg = nctx.createImageData(NIGHT_RES, NIGHT_RES);

  let baseLat = NaN;
  let baseLon = NaN;
  let proj = makeProjector(0, 0);
  let lastT = 0;
  let lastDraw = -1e9;
  let visible = true;

  // Ground-track cache (lat/lon are Earth-fixed so they never change per grid time).
  const trackCache = new Map<number, { lat: number; lon: number }>();
  const trackAt = (gridIdx: number) => {
    let v = trackCache.get(gridIdx);
    if (!v) {
      const f = opts.computeFrame(gridIdx * STEP_MS);
      v = { lat: f.latDeg * D2R, lon: f.lonDeg * D2R };
      trackCache.set(gridIdx, v);
      if (trackCache.size > 400) {
        const first = trackCache.keys().next().value as number;
        trackCache.delete(first);
      }
    }
    return v;
  };

  // Current drawn samples, for picking.
  interface Sample { t: number; sx: number; sy: number; front: boolean; }
  let samples: Sample[] = [];
  let preview: Sample | null = null;
  let previewMin = 0;
  let dragging = false;

  const scr = (p: P) => ({ x: SIZE / 2 + p.x * R, y: SIZE / 2 - p.y * R });

  function renderBase(lat0: number, lon0: number) {
    baseLat = lat0;
    baseLon = lon0;
    proj = makeProjector(lat0, lon0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, SIZE, SIZE);
    bctx.save();
    bctx.beginPath();
    bctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
    bctx.fillStyle = '#0f1a2a';
    bctx.fill();
    bctx.clip();
    bctx.fillStyle = 'rgba(70, 92, 84, 0.9)';
    const p: P = { x: 0, y: 0, z: 0 };
    bctx.beginPath();
    for (const ring of rings) {
      let any = false;
      for (let i = 0; i < ring.length; i += 2) {
        proj(ring[i + 1], ring[i], p);
        if (p.z < 0) {
          // push hidden points onto the limb so the fill closes along the rim
          const l = Math.hypot(p.x, p.y) || 1;
          p.x /= l;
          p.y /= l;
        } else any = true;
        const x = SIZE / 2 + p.x * R;
        const y = SIZE / 2 - p.y * R;
        if (i === 0) bctx.moveTo(x, y);
        else bctx.lineTo(x, y);
      }
      if (any) bctx.closePath();
      else {
        // fully hidden ring: drop it (path already has degenerate limb points)
      }
    }
    bctx.fill();
    bctx.restore();
  }

  function drawNight(f: FrameState) {
    const sun = sunSubPoint(f);
    const sp = proj(sun.lat, sun.lon, { x: 0, y: 0, z: 0 });
    const d = nimg.data;
    for (let j = 0; j < NIGHT_RES; j++) {
      for (let i = 0; i < NIGHT_RES; i++) {
        const x = ((i + 0.5) / NIGHT_RES) * 2 - 1;
        const y = 1 - ((j + 0.5) / NIGHT_RES) * 2;
        const r2 = x * x + y * y;
        const o = (j * NIGHT_RES + i) * 4;
        if (r2 >= 1.02) {
          d[o + 3] = 0;
          continue;
        }
        const z = Math.sqrt(Math.max(0, 1 - r2));
        const dot = x * sp.x + y * sp.y + z * sp.z;
        const a = (1 - smooth(-0.12, 0.1, dot)) * 0.58;
        d[o] = 2;
        d[o + 1] = 5;
        d[o + 2] = 12;
        d[o + 3] = Math.round(a * 255);
      }
    }
    nctx.putImageData(nimg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(night, SIZE / 2 - R, SIZE / 2 - R, R * 2, R * 2);
  }

  function draw(t: number) {
    const f = opts.computeFrame(t);
    const lat0 = f.latDeg * D2R;
    const lon0 = f.lonDeg * D2R;
    if (
      isNaN(baseLat) ||
      Math.abs(lat0 - baseLat) > RECENTER_DEG * D2R ||
      Math.abs(Math.atan2(Math.sin(lon0 - baseLon), Math.cos(lon0 - baseLon))) > RECENTER_DEG * D2R
    ) {
      renderBase(lat0, lon0);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(base, 0, 0, SIZE, SIZE);

    ctx.save();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawNight(f);

    // ground track
    const g0 = Math.floor((t - opts.orbitPeriodMs * PAST_PERIODS) / STEP_MS);
    const g1 = Math.ceil((t + opts.orbitPeriodMs * FUTURE_PERIODS) / STEP_MS);
    const p: P = { x: 0, y: 0, z: 0 };
    samples = [];
    for (let g = g0; g <= g1; g++) {
      const v = trackAt(g);
      proj(v.lat, v.lon, p);
      const s = scr(p);
      samples.push({ t: g * STEP_MS, sx: s.x, sy: s.y, front: p.z > 0.02 });
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.3;
    for (const pass of [0, 1]) {
      // pass 0: past (dim), pass 1: future (bright)
      ctx.strokeStyle = pass === 0 ? 'rgba(235,238,245,0.32)' : 'rgba(235,238,245,0.85)';
      ctx.beginPath();
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (!a.front || !b.front) continue;
        const isFuture = b.t > t;
        if ((pass === 1) !== isFuture) continue;
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
      }
      ctx.stroke();
    }
    ctx.restore();

    // rim
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(235,238,245,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // station + heading tick
    const me = scr(proj(f.latDeg * D2R, f.lonDeg * D2R, p));
    const nx = trackAt(Math.round((t + STEP_MS) / STEP_MS));
    const nxs = scr(proj(nx.lat, nx.lon, { x: 0, y: 0, z: 0 }));
    let hx = nxs.x - me.x;
    let hy = nxs.y - me.y;
    const hl = Math.hypot(hx, hy);
    if (hl > 0.01) {
      hx /= hl;
      hy /= hl;
      ctx.beginPath();
      ctx.moveTo(me.x + hx * 3.5, me.y + hy * 3.5);
      ctx.lineTo(me.x + hx * 7, me.y + hy * 7);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(me.x, me.y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // preview marker + label
    if (preview) {
      ctx.beginPath();
      ctx.arc(preview.sx, preview.sy, 3.2, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const txt = previewMin === 0 ? '±0分' : `${previewMin > 0 ? '+' : '−'}${Math.abs(previewMin)}分`;
      ctx.font = `300 10px ${fontFamily}`;
      const w = ctx.measureText(txt).width;
      let lx = preview.sx - w / 2;
      lx = Math.max(2, Math.min(SIZE - w - 2, lx));
      const ly = preview.sy > SIZE / 2 ? preview.sy - 8 : preview.sy + 15;
      ctx.fillStyle = 'rgba(8,12,20,0.7)';
      ctx.fillRect(lx - 3, ly - 10, w + 6, 13);
      ctx.fillStyle = 'rgba(235,238,245,0.95)';
      ctx.fillText(txt, lx, ly);
    }
  }

  // ---------- interaction ----------
  let idleTimer = 0;
  const wake = () => {
    wrap.classList.remove('lt-globe--idle');
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (!dragging) wrap.classList.add('lt-globe--idle');
    }, IDLE_MS);
  };
  wake();

  const pick = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * SIZE;
    const py = ((ev.clientY - r.top) / r.height) * SIZE;
    let best: Sample | null = null;
    let bd = PICK_RADIUS * PICK_RADIUS;
    for (const s of samples) {
      if (!s.front) continue;
      const d = (s.sx - px) ** 2 + (s.sy - py) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };
  const setPreview = (s: Sample | null) => {
    const changed = (s?.t ?? null) !== (preview?.t ?? null);
    preview = s;
    if (s) previewMin = Math.round((s.t - lastT) / 60000);
    if (changed) {
      opts.onSeekPreview?.(s ? s.t : null);
      draw(lastT);
    }
  };

  const onDown = (ev: PointerEvent) => {
    ev.stopPropagation();
    wake();
    const s = pick(ev);
    if (!s) return;
    ev.preventDefault();
    dragging = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    setPreview(s);
  };
  const onMove = (ev: PointerEvent) => {
    ev.stopPropagation();
    wake();
    if (!dragging) return;
    setPreview(pick(ev));
  };
  const onUp = (ev: PointerEvent) => {
    ev.stopPropagation();
    wake();
    if (!dragging) return;
    dragging = false;
    const s = preview;
    preview = null;
    if (s) opts.onSeek(s.t);
    else opts.onSeekPreview?.(null);
    draw(lastT);
  };
  const onCancel = (ev: PointerEvent) => {
    ev.stopPropagation();
    if (!dragging) return;
    dragging = false;
    preview = null;
    opts.onSeekPreview?.(null);
    draw(lastT);
  };
  const stop = (ev: Event) => ev.stopPropagation();

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  for (const n of ['click', 'wheel', 'touchstart', 'touchmove', 'mousedown'])
    wrap.addEventListener(n, stop, { passive: true });
  const onAnyPointer = () => wake();
  window.addEventListener('pointerdown', onAnyPointer, true);

  return {
    update(simTimeMs: number) {
      lastT = simTimeMs;
      if (!visible) return;
      const now = performance.now();
      if (now - lastDraw < MIN_REDRAW_MS && !dragging) return;
      lastDraw = now;
      if (preview) previewMin = Math.round((preview.t - simTimeMs) / 60000);
      draw(simTimeMs);
    },
    setVisible(v: boolean) {
      visible = v;
      wrap.style.display = v ? '' : 'none';
      if (v) draw(lastT);
    },
    dispose() {
      window.clearTimeout(idleTimer);
      window.removeEventListener('pointerdown', onAnyPointer, true);
      wrap.remove();
    },
  };
}
