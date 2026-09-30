import { describe, expect, it } from 'vitest';
import { moonState, moonIlluminance, nlcSeason, sunDirectionECI, dailyKp, geomagneticLatDeg, meteorRateFactor } from './astro';

const RAD2DEG = 180 / Math.PI;

function raDecDeg(v: { x: number; y: number; z: number }): { ra: number; dec: number } {
  const r = Math.hypot(v.x, v.y, v.z);
  let ra = Math.atan2(v.y, v.x) * RAD2DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(v.z / r) * RAD2DEG };
}

function angSepDeg(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const d = (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z));
  return Math.acos(Math.min(1, Math.max(-1, d))) * RAD2DEG;
}

describe('moonState position', () => {
  // Meeus, Astronomical Algorithms ex. 47.a: 1992-04-12 0h TD
  // RA 134.688 deg, Dec +13.768 deg, distance 368409.7 km
  it('matches Meeus example 47.a within 0.5 deg', () => {
    const t = Date.UTC(1992, 3, 12, 0, 0, 0) - 59 * 1000; // TD -> UT (dT ~ 59 s)
    const m = moonState(t);
    const { ra, dec } = raDecDeg(m.posEci);
    expect(Math.abs(ra - 134.688)).toBeLessThan(0.5);
    expect(Math.abs(dec - 13.768)).toBeLessThan(0.5);
    expect(Math.abs(m.distKm - 368409.7)).toBeLessThan(1500);
  });

  it('stays within the real perigee/apogee range', () => {
    for (let d = 0; d < 60; d += 0.5) {
      const m = moonState(Date.UTC(2026, 0, 1) + d * 86400000);
      expect(m.distKm).toBeGreaterThan(354000);
      expect(m.distKm).toBeLessThan(408000);
    }
  });

  it('places the Moon on top of the Sun during the 2024-04-08 total eclipse', () => {
    const t = Date.UTC(2024, 3, 8, 18, 17, 0);
    const sep = angSepDeg(moonState(t).posEci, sunDirectionECI(t));
    expect(sep).toBeLessThan(0.8);
  });
});

describe('moonState phase', () => {
  it('is new at the new moon of 2000-01-06 18:14 UTC', () => {
    const m = moonState(Date.UTC(2000, 0, 6, 18, 14));
    expect(m.illumFraction).toBeLessThan(0.01);
    expect(m.phaseAngleDeg).toBeGreaterThan(170);
  });

  it('is full at the full moon of 2000-01-21 04:40 UTC', () => {
    const m = moonState(Date.UTC(2000, 0, 21, 4, 40));
    expect(m.illumFraction).toBeGreaterThan(0.99);
  });

  it('is about half at first quarter 2000-01-14 13:34 UTC and waxing', () => {
    const m = moonState(Date.UTC(2000, 0, 14, 13, 34));
    expect(Math.abs(m.illumFraction - 0.5)).toBeLessThan(0.03);
    expect(m.elongationDeg).toBeGreaterThan(80);
    expect(m.elongationDeg).toBeLessThan(100);
  });

  it('is full at the super moon of 2025-11-05 13:19 UTC (near perigee)', () => {
    const m = moonState(Date.UTC(2025, 10, 5, 13, 19));
    expect(m.illumFraction).toBeGreaterThan(0.99);
    expect(m.distKm).toBeLessThan(361000);
  });
});

describe('moonIlluminance', () => {
  it('full moon at mean distance is ~1, quarter moon ~9 %, new ~0', () => {
    expect(moonIlluminance(0, 384400)).toBeCloseTo(1, 5);
    expect(moonIlluminance(90, 384400)).toBeGreaterThan(0.07);
    expect(moonIlluminance(90, 384400)).toBeLessThan(0.12);
    expect(moonIlluminance(180, 384400)).toBeLessThan(0.01);
  });
});

describe('geomagnetic dipole', () => {
  it('has geomagnetic latitude 90 at the north geomagnetic pole', () => {
    expect(geomagneticLatDeg(80.7, -72.7)).toBeCloseTo(90, 3);
    expect(geomagneticLatDeg(-80.7, 107.3)).toBeCloseTo(-90, 3);
  });
  it('puts Canada at a higher magnetic latitude than Siberia at similar geographic latitude', () => {
    expect(geomagneticLatDeg(62.5, -114.4)).toBeGreaterThan(66); // Yellowknife
    expect(geomagneticLatDeg(69.3, 88.2)).toBeLessThan(62); // Norilsk
  });
  it('is antisymmetric under antipode', () => {
    expect(geomagneticLatDeg(40, 30)).toBeCloseTo(-geomagneticLatDeg(-40, -150), 6);
  });
});

describe('dailyKp', () => {
  it('is within 0..9 and continuous across midnight', () => {
    for (let d = 0; d < 400; d++) {
      const t = Date.UTC(2026, 0, 1) + d * 86400000;
      const kp = dailyKp(t + 3600e3 * 5);
      expect(kp).toBeGreaterThanOrEqual(0);
      expect(kp).toBeLessThanOrEqual(9);
      expect(Math.abs(dailyKp(t - 1000) - dailyKp(t + 1000))).toBeLessThan(0.01);
    }
  });
  it('is mostly quiet', () => {
    let quiet = 0;
    for (let d = 0; d < 365; d++) if (dailyKp(Date.UTC(2026, 0, 1) + d * 86400000 + 12 * 3600e3) < 3) quiet++;
    expect(quiet / 365).toBeGreaterThan(0.6);
  });
});

describe('meteorRateFactor', () => {
  it('peaks at the Perseids and Geminids, near 1 in a quiet week', () => {
    expect(meteorRateFactor(Date.UTC(2026, 7, 12, 12))).toBeGreaterThan(4);
    expect(meteorRateFactor(Date.UTC(2026, 11, 14, 12))).toBeGreaterThan(4);
    expect(meteorRateFactor(Date.UTC(2026, 2, 10, 12))).toBeLessThan(1.1);
  });
});

describe('nlcSeason', () => {
  it('is on in NH midsummer, off in NH winter', () => {
    expect(nlcSeason(Date.UTC(2026, 5, 25)).north).toBeGreaterThan(0.99);
    expect(nlcSeason(Date.UTC(2026, 5, 25)).south).toBe(0);
    expect(nlcSeason(Date.UTC(2026, 11, 1)).north).toBe(0);
  });
  it('covers late May to early Aug in the north', () => {
    expect(nlcSeason(Date.UTC(2026, 4, 28)).north).toBeGreaterThan(0.3);
    expect(nlcSeason(Date.UTC(2026, 7, 5)).north).toBeGreaterThan(0.3);
    expect(nlcSeason(Date.UTC(2026, 8, 20)).north).toBe(0);
  });
  it('is on around New Year in the south (wrapping the year)', () => {
    expect(nlcSeason(Date.UTC(2026, 11, 28)).south).toBeGreaterThan(0.9);
    expect(nlcSeason(Date.UTC(2026, 0, 15)).south).toBeGreaterThan(0.9);
    expect(nlcSeason(Date.UTC(2026, 5, 25)).south).toBe(0);
  });
});
