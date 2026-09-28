// Single source of truth for all render colours. Flat, quantized palette —
// "art of rally" / "Slow Roads": few tones, gradients used sparingly and only
// where they carry meaning (terminator, atmosphere limb).
import * as THREE from 'three';

/** Land / ocean quantized palette (used to build the land-mask texture's implied colours
 *  and by the Earth fragment shader for final shading). */
export const EARTH_COLORS = {
  deepOcean: new THREE.Color(0x0b2f4f),
  ocean: new THREE.Color(0x14507e),
  land: new THREE.Color(0x3c6b45),
  iceLand: new THREE.Color(0xdfe9e6),
  // night-side (unlit) tints — near black with a faint cool cast
  nightLand: new THREE.Color(0x05070b),
  nightOcean: new THREE.Color(0x03050a),
};

/** Terminator ramp: warm band that straddles the day/night boundary. */
export const TERMINATOR = {
  // sun-elevation (radians) half-width of the warm band either side of the horizon
  widthRad: THREE.MathUtils.degToRad(5),
  warm: new THREE.Color(0xff7a3c),
};

/** Atmosphere limb ramp colours, sampled in a 2D LUT-like shader function of
 *  (sun elevation at the shell point, view-to-sun angle). Kept subtle. */
export const ATMOSPHERE = {
  dayBlue: new THREE.Color(0x4da6ff),
  duskOrange: new THREE.Color(0xff8a4a),
  duskRed: new THREE.Color(0xb23a3a),
  nightAirglow: new THREE.Color(0x1d5c4a),
  // overall intensity multipliers
  dayIntensity: 0.55,
  duskIntensity: 0.65,
  nightIntensity: 0.12,
};

export const SPACE = {
  black: new THREE.Color(0x000000),
  starDim: new THREE.Color(0xaeb8c8),
};

export const SUN = {
  color: new THREE.Color(0xfff3e0),
  intensity: 1.4,
};

export const STATION = {
  hull: new THREE.Color(0xb9bec4),
  hullDark: new THREE.Color(0x7d8288),
  truss: new THREE.Color(0xc8ccce),
  panel: new THREE.Color(0x1a2a4a),
  panelLit: new THREE.Color(0x3a5ea8),
  module: new THREE.Color(0xd8d2c0),
};
