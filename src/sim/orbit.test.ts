import { describe, expect, it } from 'vitest';
import {
  computeFrame,
  findNextSunrise,
  findNextSunset,
  ORBIT_PERIOD_S,
  raanDeg,
  raanDriftDegPerDay,
  EPOCH_MS,
} from './orbit';
import { gmstRad, sunDirectionECI } from './astro';
import { vLength } from './frames';

describe('ORBIT_PERIOD_S', () => {
  it('is approximately 92.6 minutes', () => {
    const periodMin = ORBIT_PERIOD_S / 60;
    expect(periodMin).toBeGreaterThan(92.6 - 0.5);
    expect(periodMin).toBeLessThan(92.6 + 0.5);
  });
});

describe('computeFrame position', () => {
  it('has |stationPos| approx 6791 km', () => {
    const frame = computeFrame(EPOCH_MS + 12345 * 1000);
    const r = vLength(frame.stationPos);
    expect(r).toBeGreaterThan(6791 - 5);
    expect(r).toBeLessThan(6791 + 5);
  });

  it('|stationPos| is constant over time (circular orbit)', () => {
    for (const dtHours of [0, 1, 5, 30, 100]) {
      const frame = computeFrame(EPOCH_MS + dtHours * 3600 * 1000);
      const r = vLength(frame.stationPos);
      expect(r).toBeGreaterThan(6791 - 5);
      expect(r).toBeLessThan(6791 + 5);
    }
  });
});

describe('latitude coverage', () => {
  it('max |latDeg| over a day is approx 51.64 deg', () => {
    let maxAbsLat = 0;
    const stepS = 60; // 1-minute steps over a full day
    for (let t = 0; t < 86400; t += stepS) {
      const frame = computeFrame(EPOCH_MS + t * 1000);
      maxAbsLat = Math.max(maxAbsLat, Math.abs(frame.latDeg));
    }
    expect(maxAbsLat).toBeGreaterThan(51.64 - 0.1);
    expect(maxAbsLat).toBeLessThan(51.64 + 0.1);
  });
});

describe('RAAN drift', () => {
  it('drifts at approximately -5 deg/day', () => {
    expect(raanDriftDegPerDay()).toBeGreaterThan(-5 - 0.3);
    expect(raanDriftDegPerDay()).toBeLessThan(-5 + 0.3);
  });

  it('raanDeg matches the drift rate over 10 days', () => {
    const raan0 = raanDeg(EPOCH_MS);
    const raan10 = raanDeg(EPOCH_MS + 10 * 86400 * 1000);
    const observedRatePerDay = (raan10 - raan0) / 10;
    expect(observedRatePerDay).toBeCloseTo(raanDriftDegPerDay(), 6);
  });
});

describe('sunDirectionECI at June solstice', () => {
  it('scene.y > 0.39 at 2026-06-21T12:00Z', () => {
    const timeMs = Date.UTC(2026, 5, 21, 12, 0, 0);
    const sun = sunDirectionECI(timeMs);
    // scene.y = ECI.z per the frame mapping in src/types.ts
    expect(sun.z).toBeGreaterThan(0.39);
  });
});

describe('gmstRad sanity', () => {
  it('matches the known value at 2000-01-01T12:00Z (~280.46 deg)', () => {
    const timeMs = Date.UTC(2000, 0, 1, 12, 0, 0);
    const deg = (gmstRad(timeMs) * 180) / Math.PI;
    expect(deg).toBeGreaterThan(280.46 - 0.05);
    expect(deg).toBeLessThan(280.46 + 0.05);
  });
});

describe('sunrise/sunset counts per day', () => {
  it('yields roughly 15-16 sunrises per day when not in a white night', () => {
    // Pick an epoch-relative day; the fictional orbit's beta angle at the
    // epoch should give normal (non-white-night) eclipse seasons.
    const dayStart = EPOCH_MS;
    let t = dayStart;
    let count = 0;
    const dayEnd = dayStart + 86400 * 1000;
    while (true) {
      const next = findNextSunrise(t);
      if (Number.isNaN(next) || next > dayEnd) break;
      count++;
      t = next;
    }
    expect(count).toBeGreaterThanOrEqual(14);
    expect(count).toBeLessThanOrEqual(17);
  });
});

describe('findNextSunrise', () => {
  it('returns a time where inShadow flips from true to false', () => {
    const start = EPOCH_MS;
    const sunriseMs = findNextSunrise(start);
    expect(Number.isNaN(sunriseMs)).toBe(false);

    const before = computeFrame(sunriseMs - 200);
    const after = computeFrame(sunriseMs + 200);
    expect(before.inShadow).toBe(true);
    expect(after.inShadow).toBe(false);
  });

  it('findNextSunset returns a time where inShadow flips from false to true', () => {
    const start = EPOCH_MS;
    const sunsetMs = findNextSunset(start);
    expect(Number.isNaN(sunsetMs)).toBe(false);

    const before = computeFrame(sunsetMs - 200);
    const after = computeFrame(sunsetMs + 200);
    expect(before.inShadow).toBe(false);
    expect(after.inShadow).toBe(true);
  });
});
