// Shared contracts between sim / render / ui. Units: km, seconds, radians.
//
// Scene frame (three.js, Y-up) is an Earth-centred inertial frame:
//   scene.x =  ECI.x   (vernal equinox)
//   scene.y =  ECI.z   (north pole)
//   scene.z = -ECI.y
// Use eciToScene() in src/sim/frames.ts for conversion.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FrameState {
  /** UTC epoch milliseconds of the simulation clock. */
  timeMs: number;
  /** Station position, scene frame, km (origin = Earth centre). */
  stationPos: Vec3;
  /** Station velocity, scene frame, km/s. */
  stationVel: Vec3;
  /** Unit vector from Earth centre towards the Sun, scene frame. */
  sunDir: Vec3;
  /** Greenwich mean sidereal time, rad. Earth mesh rotates by this about scene +Y. */
  gmstRad: number;
  /** Sub-station point, degrees (for UI readout). */
  latDeg: number;
  lonDeg: number;
  /** True when the station is inside Earth's (cylindrical) shadow. */
  inShadow: boolean;
}

export type TimeRate = 1 | 10;
export type SkipTarget = 'sunrise' | 'sunset';

export const EARTH_RADIUS_KM = 6371;
