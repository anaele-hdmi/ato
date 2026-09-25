// Where the sea cuts the hill at the end, shared by the cliff mesh, the terrain
// carve and the end sequence that lays the ruler against the cut face.

/** Direction (radians, same convention as TouchCamera.azimuth) the cut face looks toward. */
export const CLIFF_AZ = 0.55;
/** Distance of the face from the house site, metres. */
export const CLIFF_R = 12;
/** Half-width of the face as an angle around the site. */
export const CLIFF_HALF_ARC = 1.1;
/** The ruler's whole span, oldest at the bottom, laid into this much rock under the surface. */
export const CLIFF_STRATA_DEPTH = 3.2;
/** How far below the old surface the carved sea floor sits. */
export const CLIFF_FLOOR = 6;

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0..1: how much of the ground at (x, z) the sea has taken in front of the face. Mirrors the GLSL carve. */
export function cliffCarve(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let da = Math.atan2(x, z) - CLIFF_AZ;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  return smooth(CLIFF_R - 0.6, CLIFF_R - 0.1, r) * smooth(CLIFF_HALF_ARC + 0.25, CLIFF_HALF_ARC - 0.1, Math.abs(da));
}
