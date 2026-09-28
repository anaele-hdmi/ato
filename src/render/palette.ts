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
  dayBlue: new THREE.Color(0x8cc4ff),
  duskOrange: new THREE.Color(0xffa066),
  duskRed: new THREE.Color(0xc0504a),
  nightAirglow: new THREE.Color(0x3f9a72),
  dayIntensity: 0.6,
  duskIntensity: 0.75,
  nightIntensity: 0.1,
  /** haze over the Earth disc relative to the limb */
  discHaze: 0.5,
  /** faint tall glow: the sky just above the limb reads dark navy, not black */
  outerGlow: new THREE.Color(0x2b4a8a),
  /** forward-scattering tint toward the Sun */
  forward: new THREE.Color(0xffe2b8),
};

export const SPACE = {
  black: new THREE.Color(0x000000),
  star: new THREE.Color(0xc9d2e0),
};

export const SUN = {
  color: new THREE.Color(0xfff3e0),
  intensity: 2.2,
};

/** Station: three main colours + two sparing accents. */
export const STATION = {
  hull: new THREE.Color(0xe7e3d8),
  truss: new THREE.Color(0xa9aaa4),
  panel: new THREE.Color(0x1c3f6e),
  /** warm gold foil accent: docking ring, blanket edge trim, antenna tips */
  gold: new THREE.Color(0xd7a94a),
  /** dark panel-frame tone: masts, gimbal housings, blanket grid lines */
  frame: new THREE.Color(0x53565e),
  /** ambient fill so the unlit side reads as a darker step, not black */
  ambient: new THREE.Color(0x2a3448),
  ambientIntensity: 0.9,
};

/** Land biome faces (M2): flat colours picked by latitude + coast distance + a
 *  low-frequency noise jitter, replacing the old uniform land/highLand faces. */
export const BIOMES = {
  tropicalForest: new THREE.Color(0x1f5b34),
  savanna: new THREE.Color(0xa78a49),
  desert: new THREE.Color(0xd9b877),
  temperateForest: new THREE.Color(0x35603a),
  tundra: new THREE.Color(0x8a9a86),
};

/** Cloud shell tones: quantized like the ground (lit / shaded / twilight-warm). */
export const CLOUDS = {
  lit: new THREE.Color(0xfbfbfa),
  shade: new THREE.Color(0xaab6c9),
  twilight: new THREE.Color(0xf0b487),
};

/** Stylized ocean sun-glint: a warm-white highlight, quantized into two rings. */
export const GLINT = {
  color: new THREE.Color(0xfff6df),
};

/** Extra twilight tint that the warm terminator colour shifts toward as the
 *  sun drops further below the horizon (warm -> violet, art-direction §4). */
export const TWILIGHT = {
  violet: new THREE.Color(0x5b4d7d),
};

/** Faceted-relief direction (client reference images, superseding the flat
 *  posterized-band rule): continuous Lambert on flat per-triangle normals,
 *  split-toned lit-gold / shadow-teal, plus a pale aerial-perspective haze
 *  that brightens toward the horizon. */
export const RELIEF = {
  warmLit: new THREE.Color(0xffd9a0),
  coolShadow: new THREE.Color(0x2b4a5e),
  skyAmbient: new THREE.Color(0x7fb0d8),
  hazeCool: new THREE.Color(0xcfe4f2),
  hazeWarm: new THREE.Color(0xffe2b8),
};

