// Frame conversion between ECI (Earth-Centred Inertial, equatorial, X->vernal
// equinox, Z->north pole, right-handed) and the three.js scene frame (Y-up),
// per the mapping documented in src/types.ts:
//
//   scene.x =  ECI.x
//   scene.y =  ECI.z
//   scene.z = -ECI.y

import type { Vec3 } from '../types';

/** Convert a vector from ECI coordinates to the scene (three.js, Y-up) frame. */
export function eciToScene(v: Vec3): Vec3 {
  return { x: v.x, y: v.z, z: -v.y };
}

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function vDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vLength(a: Vec3): number {
  return Math.sqrt(vDot(a, a));
}

export function vNormalize(a: Vec3): Vec3 {
  const len = vLength(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return vScale(a, 1 / len);
}
