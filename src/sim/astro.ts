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
