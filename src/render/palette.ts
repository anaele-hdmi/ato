// Single source of truth for all render colours (docs/art-direction.md §4).
// Rule: every colour on screen comes from here. Surfaces are flat, lighting is
// quantized into a few steps; only the atmosphere/twilight keeps smooth
// gradients, and even those only blend between colours defined here.
import * as THREE from 'three';

/** Earth surfaces (day, fully lit). Five faces: deep/shallow ocean, land, high-latitude land, ice. */
export const EARTH_COLORS = {
  deepOcean: new THREE.Color(0x1f4f7c),
  shallowOcean: new THREE.Color(0x3a86a6),
  land: new THREE.Color(0x7a8c5c),
  highLand: new THREE.Color(0x9a9c84),
  ice: new THREE.Color(0xe9edec),
  // night side — near black with a faint cool cast
  nightLand: new THREE.Color(0x0b0e15),
  nightOcean: new THREE.Color(0x05070c),
};

/** Quantized lighting: sun-cosine thresholds and the brightness of each step. */
export const LIGHT_STEPS = {
  /** cos(sun zenith) above which a surface is fully lit */
  full: 0.32,
  /** above this (and below full) → mid step; below → low (twilight) step */
  low: 0.08,
  midLevel: 0.74,
  lowLevel: 0.5,
  /** twilight step tint */
  warm: new THREE.Color(0xe08a5a),
  warmAmount: 0.35,
};

/** Atmosphere ramp colours (smooth, B-side of A+B). */
export const ATMOSPHERE = {
  dayBlue: new THREE.Color(0x6fb4ff),
  duskOrange: new THREE.Color(0xffa066),
  duskRed: new THREE.Color(0xc0504a),
  nightAirglow: new THREE.Color(0x3f9a72),
  dayIntensity: 0.6,
  duskIntensity: 0.75,
  nightIntensity: 0.1,
  /** haze over the Earth disc relative to the limb (keeps surfaces clean) */
  discHaze: 0.28,
};

export const SPACE = {
  black: new THREE.Color(0x000000),
  star: new THREE.Color(0xc9d2e0),
};

export const SUN = {
  color: new THREE.Color(0xfff3e0),
  intensity: 2.2,
};

/** Station: three colours only. */
export const STATION = {
  hull: new THREE.Color(0xe7e3d8),
  truss: new THREE.Color(0xa9aaa4),
  panel: new THREE.Color(0x4a6a9c),
  /** ambient fill so the unlit side reads as a darker step, not black */
  ambient: new THREE.Color(0x2a3448),
  ambientIntensity: 0.9,
};
