// Internal time. Years are design keys only and must never reach the screen.
import { clamp, lerp, smoothstep } from '../util/rand';

const HUMAN_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 1900],
  [0.08, 1920],
  [0.17, 1950],
  [0.27, 1990],
  [0.38, 2050],
  [0.47, 2150],
  [0.55, 2300],
  [0.575, 2330],
];
export const DEEP_U0 = 0.575;
export const DEEP_BASE_YEAR = 2330;
export const DEEP_LOG_MAX = 8.5;

export function uToYear(u: number): number {
  u = clamp(u, 0, 1);
  if (u >= DEEP_U0) {
    const k = (u - DEEP_U0) / (1 - DEEP_U0);
    return DEEP_BASE_YEAR + Math.pow(10, k * DEEP_LOG_MAX) - 1;
  }
  for (let i = 1; i < HUMAN_KNOTS.length; i++) {
    const [u1, y1] = HUMAN_KNOTS[i];
    if (u <= u1) {
      const [u0, y0] = HUMAN_KNOTS[i - 1];
      return lerp(y0, y1, (u - u0) / (u1 - u0));
    }
  }
  return DEEP_BASE_YEAR;
}

export function yearToU(y: number): number {
  if (y >= DEEP_BASE_YEAR) {
    const k = Math.log10(y - DEEP_BASE_YEAR + 1) / DEEP_LOG_MAX;
    return DEEP_U0 + clamp(k, 0, 1) * (1 - DEEP_U0);
  }
  for (let i = 1; i < HUMAN_KNOTS.length; i++) {
    const [u1, y1] = HUMAN_KNOTS[i];
    if (y <= y1) {
      const [u0, y0] = HUMAN_KNOTS[i - 1];
      return lerp(u0, u1, (y - y0) / (y1 - y0));
    }
  }
  return DEEP_U0;
}

/** log10 of years after the human era closes; 0 before it. */
export function logDeep(year: number): number {
  return Math.log10(Math.max(0, year - DEEP_BASE_YEAR) + 1);
}

export function win(v: number, a0: number, a1: number, b0: number, b1: number): number {
  return smoothstep(a0, a1, v) * (1 - smoothstep(b0, b1, v));
}

export type StemName =
  | 'wind' | 'grass' | 'birds' | 'morning' | 'gravel' | 'work' | 'hum' | 'traffic'
  | 'steps' | 'drone' | 'electric' | 'metal' | 'creak' | 'insects' | 'rain'
  | 'animals' | 'ice' | 'water';

export interface Env {
  year: number;
  u: number;
  L: number;
  /** 0..1 in the part of the year; smoothed so scrubbing does not strobe. */
  season: number;
  /** How strongly seasons read; drops while scrubbing fast and in deep time. */
  seasonality: number;
  /** 0..1, 0 = midnight. */
  day: number;
  // ground & settlement
  gravel: number;
  paved: number;
  avenue: number;
  fields: number;
  urbanNear: number;
  roadDecay: number;
  wear: number;
  // people
  people: number;
  dots: number;
  // air & light
  turbidity: number;
  lightPollution: number;
  smoke: number;
  chaos: number;
  decay: number;
  wild: number;
  forest: number;
  human: number;
  // deep time
  deep: number;
  glacial: number;
  seaLevel: number;
  terrainDisp: number;
  terminal: number;
  stems: Record<StemName, number>;
  silence: number;
}

export const ORIGIN_GROUND = 22; // metres; the hill top the house sits on.

function bump(v: number, a: number, b: number, c: number, d: number): number {
  return win(v, a, b, c, d);
}

export function evaluateEnv(year: number, season: number, seasonality: number, day: number): Env {
  const y = year;
  const L = logDeep(y);
  const u = yearToU(y);

  const chaos = bump(y, 2296, 2302, 2322, 2334);
  const decay = smoothstep(2322, 2420, y);
  const human = 1 - smoothstep(2330, 2500, y);
  const urbanNear = smoothstep(1978, 2060, y) * (1 - decay);
  const wild = smoothstep(2345, 2650, y);
  const forest = smoothstep(2.3, 3.2, L) * (1 - smoothstep(7.9, 8.3, L) * 0.6);
  const deep = smoothstep(3.6, 4.2, L);
  const glacial =
    deep * Math.min(1, bump(L, 4.45, 4.75, 5.05, 5.35) + 0.85 * bump(L, 6.05, 6.3, 6.6, 6.9) + 0.35 * bump(L, 7.75, 7.9, 8.0, 8.15));
  const transgress = bump(L, 5.35, 5.6, 5.85, 6.05) * 1.0 + bump(L, 7.0, 7.25, 7.55, 7.75) * 1.15;
  const seaLevel = -2 + transgress * (ORIGIN_GROUND + 4) - glacial * 8;
  const terrainDisp = bump(L, 3.9, 5.4, 7.3, 8.3) + 0.06 * smoothstep(3.9, 5, L);
  const terminal = smoothstep(0.962, 0.985, u);

  const lightPollution =
    (smoothstep(1950, 2050, y) * 0.45 + smoothstep(2110, 2200, y) * 0.55) * (1 - smoothstep(2322, 2370, y));
  const turbidity = clamp(
    0.12 + 0.18 * smoothstep(1950, 2000, y) + 0.3 * smoothstep(2120, 2240, y) + 0.12 * chaos
      - 0.5 * smoothstep(2330, 2500, y) + 0.25 * glacial,
    0.08, 1,
  );
  const smoke = chaos;
  const people = bump(y, 1880, 1890, 1984, 2000);
  const dots = bump(y, 1984, 2000, 2305, 2332) * (1 - 0.6 * chaos);

  const stems: Record<StemName, number> = {
    wind: lerp(1, 0.3, urbanNear) * (1 - 0.3 * chaos),
    grass: (1 - urbanNear) * (1 - glacial) * (1 - 0.7 * deep) * (1 - smoothstep(4.8, 5.4, L) * 0),
    birds: clamp((1 - 0.75 * smoothstep(1950, 1995, y)) * (1 - urbanNear) + 0.8 * wild * (1 - deep), 0, 1) * (1 - glacial),
    morning: bump(y, 1880, 1890, 1918, 1935),
    gravel: bump(y, 1917, 1924, 1952, 1960),
    work: bump(y, 1918, 1927, 1962, 1978),
    hum: bump(y, 1950, 1957, 2110, 2160) * 0.8 + 0.3 * chaos,
    traffic: bump(y, 1955, 1995, 2296, 2318),
    steps: bump(y, 1984, 1996, 2290, 2310),
    drone: bump(y, 2045, 2150, 2328, 2400) * (1 - 0.5 * chaos),
    electric: bump(y, 2120, 2200, 2300, 2318),
    metal: chaos + 0.35 * bump(y, 2330, 2345, 2450, 2600),
    creak: bump(y, 2328, 2360, 2700, 3400),
    insects: clamp((1 - urbanNear) * (1 - smoothstep(1990, 2020, y)) + 0.9 * wild * (1 - glacial), 0, 1) * (1 - 0.6 * deep),
    rain: bump(L, 2.2, 2.6, 4.1, 4.6) * (1 - glacial),
    animals: bump(L, 2.3, 2.8, 4.0, 4.5),
    ice: glacial,
    water: 0, // filled in by the app from the shoreline distance
  };

  return {
    year: y, u, L, season, seasonality, day,
    gravel: smoothstep(1917, 1926, y),
    paved: smoothstep(1950, 1958, y),
    avenue: smoothstep(1985, 2002, y),
    fields: bump(y, 1919, 1928, 1985, 2002),
    urbanNear,
    roadDecay: smoothstep(2335, 2500, y),
    wear: smoothstep(1900, 2100, y),
    people, dots,
    turbidity, lightPollution, smoke, chaos, decay, wild, forest, human,
    deep, glacial, seaLevel, terrainDisp, terminal,
    stems,
    silence: 0.6 * chaos + 0.25 * smoothstep(7.8, 8.4, L),
  };
}
