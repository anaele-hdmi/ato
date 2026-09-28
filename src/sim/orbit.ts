// Simplified circular Keplerian orbit + J2 secular perturbations, per
// docs/design.md §2.1 (v0.2, see also §13 for the corrected explanation of
// what J2 does and does not cause).
//
// This is NOT the real ISS's orbital phase: it is a fictional circular orbit
// with a fixed epoch and zero RAAN / argument of latitude at that epoch, only
// matched to the ISS's altitude and inclination. "Passing over the same spot
// at a different time each day" is mostly caused by the non-integer number of
// revolutions per day (~15.5), not by J2; J2's dominant visible effect here is
// the slow (~60-day) drift of the orbital plane's beta angle relative to the
// Sun, which occasionally produces a few days with no eclipse at all ("orbital
// white night" -- see findNextSunrise/findNextSunset below).

import type { FrameState, Vec3 } from '../types';
import { EARTH_RADIUS_KM } from '../types';

import { eciToScene, vDot, vLength, vSub, vScale } from './frames';
import { sunDirectionECI, gmstRad } from './astro';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// --- Orbit parameters (docs/design.md §2.1) ---------------------------------

/** Circular orbit altitude, km. */
export const ALTITUDE_KM = 420;
/** Inclination, degrees. */
export const INCLINATION_DEG = 51.64;
/** Earth's gravitational parameter, km^3/s^2. */
export const MU = 398600.4418;
/** Earth equatorial radius used specifically for the J2 perturbation model
 *  (Re in the (Re/a)^2 term below), km. */
export const J2_EARTH_RADIUS_KM = 6378.137;
/** Earth's J2 zonal harmonic coefficient (dimensionless). */
export const J2 = 1.08263e-3;

/** Semi-major axis (circular orbit), km. Uses the mean Earth radius
 *  (EARTH_RADIUS_KM, from src/types.ts) as the orbit's base radius; the
 *  distinct equatorial radius J2_EARTH_RADIUS_KM is used only inside the J2
 *  secular-rate formulas below, per docs/design.md §2.1. */
export const SEMI_MAJOR_AXIS_KM = EARTH_RADIUS_KM + ALTITUDE_KM;

const INCLINATION_RAD = INCLINATION_DEG * DEG2RAD;
const COS_I = Math.cos(INCLINATION_RAD);
const SIN_I = Math.sin(INCLINATION_RAD);

/** Unperturbed (two-body) mean motion, rad/s. */
const MEAN_MOTION_RAD_S = Math.sqrt(MU / SEMI_MAJOR_AXIS_KM ** 3);

/** Unperturbed (two-body) orbital period, seconds. */
export const ORBIT_PERIOD_S = (2 * Math.PI) / MEAN_MOTION_RAD_S;

// J2 secular rates (Vallado-style formulas, e=0 => p = a).
const RE_OVER_A = J2_EARTH_RADIUS_KM / SEMI_MAJOR_AXIS_KM;
const RE_OVER_A_SQ = RE_OVER_A * RE_OVER_A;

/** RAAN secular drift rate, rad/s (negative = regresses for prograde orbits). */
const RAAN_DOT_RAD_S = -1.5 * MEAN_MOTION_RAD_S * J2 * RE_OVER_A_SQ * COS_I;

/** Argument-of-perigee secular drift rate, rad/s. */
const ARG_PERIGEE_DOT_RAD_S =
  0.75 * MEAN_MOTION_RAD_S * J2 * RE_OVER_A_SQ * (5 * COS_I * COS_I - 1);

/** Mean-anomaly secular rate correction due to J2, rad/s. */
const MEAN_ANOMALY_DOT_CORRECTION_RAD_S =
  0.75 * MEAN_MOTION_RAD_S * J2 * RE_OVER_A_SQ * (3 * COS_I * COS_I - 1);

/**
 * Combined secular drift rate of the argument of latitude
 * u = argument of perigee + true anomaly (well-defined for a circular orbit
 * even though perigee itself is not), rad/s.
 */
const U_DOT_RAD_S =
  MEAN_MOTION_RAD_S + ARG_PERIGEE_DOT_RAD_S + MEAN_ANOMALY_DOT_CORRECTION_RAD_S;

// --- Epoch -------------------------------------------------------------------

/** Orbit epoch: 2026-01-01T00:00:00Z, with RAAN = 0 and argument of latitude = 0.
 *  This is an arbitrary phase choice, not the real ISS's phase at that time. */
export const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

// --- Orbital elements at time t ----------------------------------------------

function raanRadAt(timeMs: number): number {
  const dtSec = (timeMs - EPOCH_MS) / 1000;
  return RAAN_DOT_RAD_S * dtSec; // RAAN0 = 0
}

function argLatRadAt(timeMs: number): number {
  const dtSec = (timeMs - EPOCH_MS) / 1000;
  return U_DOT_RAD_S * dtSec; // u0 = 0
}

/** RAAN, in degrees, at a given time (exposed for testing the J2 drift rate). */
export function raanDeg(timeMs: number): number {
  return raanRadAt(timeMs) * RAD2DEG;
}

/** RAAN secular drift rate, in degrees/day (exposed for testing). */
export function raanDriftDegPerDay(): number {
  return RAAN_DOT_RAD_S * RAD2DEG * 86400;
}

/** Station position in ECI coordinates (km), from circular-orbit elements. */
function positionECI(timeMs: number): Vec3 {
  const omega = raanRadAt(timeMs); // RAAN
  const u = argLatRadAt(timeMs); // argument of latitude

  const cosO = Math.cos(omega);
  const sinO = Math.sin(omega);
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);

  const a = SEMI_MAJOR_AXIS_KM;
  return {
    x: a * (cosO * cosU - sinO * sinU * COS_I),
    y: a * (sinO * cosU + cosO * sinU * COS_I),
    z: a * (sinU * SIN_I),
  };
}

// Small step used for numerical differentiation of position -> velocity.
// The orbit is smooth on second timescales, so a sub-second central
// difference is accurate to many significant digits.
const VEL_DT_S = 0.2;

function velocityECI(timeMs: number): Vec3 {
  const dtMs = VEL_DT_S * 1000;
  const before = positionECI(timeMs - dtMs);
  const after = positionECI(timeMs + dtMs);
  return vScale(vSub(after, before), 1 / (2 * VEL_DT_S));
}

// --- Shadow model --------------------------------------------------------

/**
 * Cylindrical Earth-shadow test: true when the station is on the night side
 * of Earth (dot(r, sun) < 0) and within the Earth's radius of the sun-Earth
 * line (i.e. inside the shadow cylinder, ignoring penumbra/antumbra).
 */
function computeInShadow(rEci: Vec3, sunEci: Vec3): boolean {
  const alongSun = vDot(rEci, sunEci); // sunEci is a unit vector
  if (alongSun >= 0) return false;
  const perp = vSub(rEci, vScale(sunEci, alongSun));
  return vLength(perp) < EARTH_RADIUS_KM;
}

// --- Public API ------------------------------------------------------------

/** Compute the full simulation frame state at a given UTC time. */
export function computeFrame(timeMs: number): FrameState {
  const rEci = positionECI(timeMs);
  const vEci = velocityECI(timeMs);
  const sunEci = sunDirectionECI(timeMs);
  const gmst = gmstRad(timeMs);

  const r = vLength(rEci);
  const latDeg = Math.asin(rEci.z / r) * RAD2DEG;
  let lonDeg = (Math.atan2(rEci.y, rEci.x) - gmst) * RAD2DEG;
  lonDeg = ((lonDeg + 180) % 360 + 360) % 360 - 180;

  const inShadow = computeInShadow(rEci, sunEci);

  return {
    timeMs,
    stationPos: eciToScene(rEci),
    stationVel: eciToScene(vEci),
    sunDir: eciToScene(sunEci),
    gmstRad: gmst,
    latDeg,
    lonDeg,
    inShadow,
  };
}

/** True when the station is in Earth's shadow at the given time. */
function inShadowAt(timeMs: number): boolean {
  return computeInShadow(positionECI(timeMs), sunDirectionECI(timeMs));
}

const STEP_MS = 20_000; // coarse search step, 20 s
const BISECT_TOL_MS = 100; // bisection tolerance, 0.1 s
const SEARCH_WINDOW_MS = 2 * ORBIT_PERIOD_S * 1000; // give up after 2 periods

/**
 * Find the next strict transition of inShadow from `fromShadow` to
 * `!fromShadow`, strictly after `timeMs + 1s`. Returns NaN if none is found
 * within 2 orbital periods (this happens during a high-beta-angle "orbital
 * white night", when the station never enters shadow).
 */
function findNextTransition(timeMs: number, fromShadow: boolean): number {
  const start = timeMs + 1000; // strictly after timeMs + 1s
  let prevT = start;
  let prevShadow = inShadowAt(start);

  const deadline = timeMs + SEARCH_WINDOW_MS;
  let t = start;
  while (t <= deadline) {
    t += STEP_MS;
    const shadow = inShadowAt(t);
    if (prevShadow === fromShadow && shadow !== fromShadow) {
      // Bisect between prevT and t to refine the crossing.
      let lo = prevT;
      let hi = t;
      while (hi - lo > BISECT_TOL_MS) {
        const mid = (lo + hi) / 2;
        if (inShadowAt(mid) === fromShadow) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return hi;
    }
    prevT = t;
    prevShadow = shadow;
  }
  return NaN;
}

/** Next time (strictly after timeMs + 1s) the station exits shadow (sunrise). */
export function findNextSunrise(timeMs: number): number {
  return findNextTransition(timeMs, true);
}

/** Next time (strictly after timeMs + 1s) the station enters shadow (sunset). */
export function findNextSunset(timeMs: number): number {
  return findNextTransition(timeMs, false);
}
