// Low-precision solar position and sidereal time, from UTC milliseconds.
// Sources:
//  - Sun direction: The Astronomical Almanac's "low precision" formulas for
//    the Sun (apparent ecliptic longitude via mean longitude + equation of
//    center, then projected onto the mean equator of date). Accuracy is
//    within about 0.01 deg for dates within a couple of decades of J2000,
//    which is far more than this simulation needs.
//  - GMST: IAU 1982 GMST polynomial (Explanatory Supplement to the
//    Astronomical Almanac / Vallado), evaluated with UT1 approximated by
//    UTC (their difference, |UT1-UTC| < 0.9 s, is negligible here).

import type { Vec3 } from '../types';

const DEG2RAD = Math.PI / 180;
const MS_PER_DAY = 86400000;
const JD_UNIX_EPOCH = 2440587.5; // Julian date of 1970-01-01T00:00:00Z

/** Julian date (UT) for a UTC epoch given in milliseconds. */
function julianDate(timeMs: number): number {
  return timeMs / MS_PER_DAY + JD_UNIX_EPOCH;
}

function normalizeDeg(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * Unit vector from Earth's centre towards the Sun, in ECI (equatorial,
 * mean-of-date) coordinates.
 */
export function sunDirectionECI(timeMs: number): Vec3 {
  const jd = julianDate(timeMs);
  const n = jd - 2451545.0; // days since J2000.0

  const L = normalizeDeg(280.46 + 0.9856474 * n); // mean longitude
  const g = normalizeDeg(357.528 + 0.9856003 * n); // mean anomaly
  const gRad = g * DEG2RAD;

  // Ecliptic longitude (equation of center applied to mean longitude).
  const lambda = L + 1.915 * Math.sin(gRad) + 0.02 * Math.sin(2 * gRad);
  const lambdaRad = lambda * DEG2RAD;

  // Obliquity of the ecliptic, slowly decreasing.
  const epsilon = 23.439 - 0.0000004 * n;
  const epsilonRad = epsilon * DEG2RAD;

  const x = Math.cos(lambdaRad);
  const y = Math.cos(epsilonRad) * Math.sin(lambdaRad);
  const z = Math.sin(epsilonRad) * Math.sin(lambdaRad);

  return { x, y, z };
}

/**
 * Greenwich Mean Sidereal Time, in radians, for a UTC epoch given in
 * milliseconds (IAU 1982 approximation, UT1 ~= UTC).
 */
export function gmstRad(timeMs: number): number {
  const jd = julianDate(timeMs);
  const T = (jd - 2451545.0) / 36525.0;

  // GMST in seconds of time (IAU 1982).
  const gmstSec =
    67310.54841 +
    (876600.0 * 3600.0 + 8640184.812866) * T +
    0.093104 * T * T -
    6.2e-6 * T * T * T;

  // 240 seconds of time == 1 degree of rotation (86400 s == 360 deg).
  const gmstDeg = normalizeDeg(gmstSec / 240.0);
  return gmstDeg * DEG2RAD;
}

// ---------------------------------------------------------------------------
// Moon. Truncated Meeus (Astronomical Algorithms, ch. 47) series: the largest
// periodic terms of ecliptic longitude / latitude / distance. Error is about
// 0.3 deg in longitude and 0.15 deg in latitude (checked against Meeus's
// worked example 47.a and known new/full moons in astro.test.ts), and a few
// hundred km in distance -- ample for a 0.5 deg disc.

export interface MoonState {
  /** Geocentric position, ECI (mean equator of date), km. */
  posEci: Vec3;
  /** Geocentric distance, km. */
  distKm: number;
  /** Illuminated fraction of the disc as seen from Earth, 0 (new) .. 1 (full). */
  illumFraction: number;
  /** Phase angle (Sun-Moon-Earth), degrees: 0 = full, 180 = new. */
  phaseAngleDeg: number;
  /** Moon age as elongation east of the Sun, degrees 0..360 (0 new, 180 full). */
  elongationDeg: number;
}

export const MOON_RADIUS_KM = 1737.4;

export function moonState(timeMs: number): MoonState {
  const d = julianDate(timeMs) - 2451545.0;
  const Lp = 218.316 + 13.176396 * d; // mean longitude
  const Mp = (134.963 + 13.064993 * d) * DEG2RAD; // mean anomaly (Moon)
  const M = (357.529 + 0.98560028 * d) * DEG2RAD; // mean anomaly (Sun)
  const D = (297.85 + 12.190749 * d) * DEG2RAD; // mean elongation
  const F = (93.272 + 13.22935 * d) * DEG2RAD; // argument of latitude

  const lon =
    Lp +
    6.289 * Math.sin(Mp) +
    1.274 * Math.sin(2 * D - Mp) +
    0.658 * Math.sin(2 * D) +
    0.214 * Math.sin(2 * Mp) -
    0.186 * Math.sin(M) -
    0.114 * Math.sin(2 * F) +
    0.059 * Math.sin(2 * D - 2 * Mp) +
    0.057 * Math.sin(2 * D - M - Mp) +
    0.053 * Math.sin(2 * D + Mp) +
    0.046 * Math.sin(2 * D - M) +
    0.041 * Math.sin(Mp - M) -
    0.035 * Math.sin(D) -
    0.03 * Math.sin(Mp + M);
  const lat =
    5.128 * Math.sin(F) +
    0.281 * Math.sin(Mp + F) +
    0.278 * Math.sin(Mp - F) +
    0.173 * Math.sin(2 * D - F) +
    0.055 * Math.sin(2 * D - Mp + F) +
    0.046 * Math.sin(2 * D - Mp - F) +
    0.033 * Math.sin(2 * D + F) +
    0.017 * Math.sin(2 * Mp + F);
  const dist =
    385000.56 -
    20905 * Math.cos(Mp) -
    3699 * Math.cos(2 * D - Mp) -
    2956 * Math.cos(2 * D) -
    570 * Math.cos(2 * Mp) +
    246 * Math.cos(2 * Mp - 2 * D) -
    205 * Math.cos(M - 2 * D) -
    171 * Math.cos(Mp + 2 * D) -
    152 * Math.cos(Mp + M - 2 * D);

  const lonR = lon * DEG2RAD;
  const latR = lat * DEG2RAD;
  const eps = (23.439 - 0.0000004 * d) * DEG2RAD;
  // ecliptic -> equatorial
  const xe = Math.cos(latR) * Math.cos(lonR);
  const ye = Math.cos(latR) * Math.sin(lonR);
  const ze = Math.sin(latR);
  const dir: Vec3 = {
    x: xe,
    y: ye * Math.cos(eps) - ze * Math.sin(eps),
    z: ye * Math.sin(eps) + ze * Math.cos(eps),
  };

  const sun = sunDirectionECI(timeMs);
  const cosElong = Math.min(1, Math.max(-1, dir.x * sun.x + dir.y * sun.y + dir.z * sun.z));
  const elong = Math.acos(cosElong); // geocentric elongation 0..pi
  // Phase angle (Meeus 48.2): tan i = R sin(psi) / (Delta - R cos(psi)).
  const sunDist = 149597870.7;
  const i = Math.atan2(sunDist * Math.sin(elong), dist - sunDist * cosElong);
  const illum = (1 + Math.cos(i)) / 2;

  // Elongation east of the Sun (0..360): sign from ecliptic longitude difference.
  const sunLon = normalizeDeg(280.46 + 0.9856474 * d + 1.915 * Math.sin((357.528 + 0.9856003 * d) * DEG2RAD));
  const elongDeg = normalizeDeg(lon - sunLon);

  return {
    posEci: { x: dir.x * dist, y: dir.y * dist, z: dir.z * dist },
    distKm: dist,
    illumFraction: illum,
    phaseAngleDeg: i / DEG2RAD,
    elongationDeg: elongDeg,
  };
}

/**
 * Relative moonlight illuminance (full moon at mean distance = 1): the
 * standard visual-magnitude phase law m = -12.74 + 0.026|a| + 4e-9 a^4
 * (a = phase angle, deg) times the inverse-square distance factor. A quarter
 * moon is therefore only ~9 % as bright as a full one, not 50 %.
 */
export function moonIlluminance(phaseAngleDeg: number, distKm: number): number {
  const a = Math.abs(phaseAngleDeg);
  const dm = 0.026 * a + 4e-9 * a * a * a * a;
  return Math.pow(10, -0.4 * dm) * Math.pow(384400 / distKm, 2);
}

// ---------------------------------------------------------------------------
// Noctilucent-cloud season: 1 around the mid-summer peak of each hemisphere,
// fading to 0 about +-45 days away (NH: 5 Jul, i.e. late May .. mid Aug; SH:
// 5 Jan, i.e. late Nov .. mid Feb).

export function nlcSeason(timeMs: number): { north: number; south: number } {
  const dt = new Date(timeMs);
  const y = dt.getUTCFullYear();
  const dayOfYear = (timeMs - Date.UTC(y, 0, 1)) / MS_PER_DAY; // 0-based
  const peakN = 185; // ~4 July
  const peakS = 4; // ~5 Jan (wraps)
  const f = (peak: number): number => {
    let x = Math.abs(dayOfYear - peak);
    x = Math.min(x, 365.25 - x);
    const t = Math.min(1, Math.max(0, (x - 30) / 20)); // flat top to +-30 d, zero by +-50 d
    return 1 - t * t * (3 - 2 * t);
  };
  return { north: f(peakN), south: f(peakS) };
}

// ---------------------------------------------------------------------------
// Geomagnetic dipole (centred-dipole approximation, IGRF-13 epoch ~2020):
// north geomagnetic pole 80.7 N, 72.7 W; the south pole is its antipode.

export const GEOMAG_POLE_LAT_DEG = 80.7;
export const GEOMAG_POLE_LON_DEG = -72.7;

/** Geomagnetic latitude (deg) of a geographic point under the dipole model. */
export function geomagneticLatDeg(latDeg: number, lonDeg: number): number {
  const p = GEOMAG_POLE_LAT_DEG * DEG2RAD;
  const la = latDeg * DEG2RAD;
  const dLon = (lonDeg - GEOMAG_POLE_LON_DEG) * DEG2RAD;
  const s = Math.sin(la) * Math.sin(p) + Math.cos(la) * Math.cos(p) * Math.cos(dLon);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG2RAD;
}

function hash01(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Pseudo geomagnetic activity (Kp-like, 0..9) seeded by the UTC date: mostly
 * quiet (median ~1), a few active days. Not real space weather. The value
 * eases between consecutive days over the last two hours of each day so the
 * aurora never jumps at 00:00 UTC.
 */
export function dailyKp(timeMs: number): number {
  const dayF = timeMs / MS_PER_DAY;
  const day = Math.floor(dayF);
  const frac = dayF - day;
  const kp = (d: number): number => 9 * Math.pow(hash01(d * 7919 + 13), 3.2);
  const t = Math.min(1, Math.max(0, (frac - 22 / 24) / (2 / 24)));
  const s = t * t * (3 - 2 * t);
  return kp(day) * (1 - s) + kp(day + 1) * s;
}

// ---------------------------------------------------------------------------
// Major meteor showers (static table: name, peak month, peak day, peak ZHR,
// half-width in days of the activity profile). Values from the IMO working
// list of visual meteor showers (rounded). Used only to scale how often the
// (rare) meteor streaks appear.

export const METEOR_SHOWERS: ReadonlyArray<{ name: string; month: number; day: number; zhr: number; halfWidthDays: number }> = [
  { name: 'Quadrantids', month: 1, day: 4, zhr: 110, halfWidthDays: 1.5 },
  { name: 'Lyrids', month: 4, day: 22, zhr: 18, halfWidthDays: 2.5 },
  { name: 'Eta Aquariids', month: 5, day: 6, zhr: 50, halfWidthDays: 5 },
  { name: 'Southern Delta Aquariids', month: 7, day: 30, zhr: 25, halfWidthDays: 6 },
  { name: 'Perseids', month: 8, day: 12, zhr: 100, halfWidthDays: 4 },
  { name: 'Orionids', month: 10, day: 21, zhr: 20, halfWidthDays: 5 },
  { name: 'Taurids', month: 11, day: 5, zhr: 10, halfWidthDays: 15 },
  { name: 'Leonids', month: 11, day: 17, zhr: 15, halfWidthDays: 3 },
  { name: 'Geminids', month: 12, day: 14, zhr: 120, halfWidthDays: 3.5 },
  { name: 'Ursids', month: 12, day: 22, zhr: 10, halfWidthDays: 2 },
];

/** Meteor rate relative to the sporadic background (1 = background only). */
export function meteorRateFactor(timeMs: number): number {
  const y = new Date(timeMs).getUTCFullYear();
  let f = 1;
  for (const s of METEOR_SHOWERS) {
    for (const yy of [y - 1, y, y + 1]) {
      const dd = (timeMs - Date.UTC(yy, s.month - 1, s.day, 12)) / MS_PER_DAY;
      const x = dd / s.halfWidthDays;
      if (Math.abs(x) < 4) f += (s.zhr / 25) * Math.exp(-x * x);
    }
  }
  return f;
}
