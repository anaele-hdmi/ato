// Single source of truth for all render colours (docs/art-direction.md §4).
// Rule: every colour on screen comes from here. Surfaces are flat, lighting is
// quantized into a few steps; only the atmosphere/twilight keeps smooth
// gradients, and even those only blend between colours defined here.
import * as THREE from 'three';

/** Earth surfaces (day, fully lit). Five faces: deep/shallow ocean, land, high-latitude land, ice. */
export const EARTH_COLORS = {
  deepOcean: new THREE.Color(0x1f4f7c),
  shallowOcean: new THREE.Color(0x285f8a),
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
  nightIntensity: 0.025,
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

/** Station: matte warm light grey body, cooler grey trim, dark slate details,
 *  navy solar panels, light array frames. Albedos are chosen so the sunlit
 *  body reads ~#bdb8ae and the shaded side a cooler ~#7d828c under the
 *  cool ambient fill (earthshine) below. */
export const STATION = {
  body: new THREE.Color(0xc2bda6),
  /** collars, joints, mount blocks, seam bands */
  bodyShade: new THREE.Color(0xa9a79f),
  /** windows, antenna, cupola underside (lifted a little toward bodyShade) */
  dark: new THREE.Color(0x30353f),
  panel: new THREE.Color(0x323c52),
  frame: new THREE.Color(0xd2cfc6),
  /** ambient fill so the unlit side reads as a cooler mid grey, not black */
  ambient: new THREE.Color(0xc2d1ff),
  ambientIntensity: 2.17,
};

/** Land biome faces (M2): flat colours picked by latitude + coast distance + a
 *  low-frequency noise jitter, replacing the old uniform land/highLand faces. */
export const BIOMES = {
  tropicalForest: new THREE.Color(0x2b5f3f),
  savanna: new THREE.Color(0x9c8f5a),
  desert: new THREE.Color(0xc9ad80),
  temperateForest: new THREE.Color(0x3f6349),
  tundra: new THREE.Color(0x899487),
};

/** Cloud shell tones: quantized like the ground (lit / shaded / twilight-warm). */
export const CLOUDS = {
  lit: new THREE.Color(0xe9ebee),
  shade: new THREE.Color(0x6f7f9c),
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
  warmLit: new THREE.Color(0xffd9a3),
  coolShadow: new THREE.Color(0x2c5068),
  skyAmbient: new THREE.Color(0x8fc0e8),
  hazeCool: new THREE.Color(0xe4f0fa),
  hazeWarm: new THREE.Color(0xfff0d8),
};


/** Physically structured single-scattering atmosphere (Rayleigh + Mie +
 *  ozone, Hillaire 2020 / Bruneton style) used by atmosphere.ts. Coefficients
 *  are real Earth values per km; `heightScale` stretches every altitude
 *  (scale heights, ozone layer, top) so the limb reads thicker from orbit, in
 *  keeping with the 8x terrain exaggeration. */
export const ATMOSPHERE_SCATTER = {
  heightScale: 1.15,
  /** top of the atmosphere before heightScale, km */
  topKm: 100,
  rayleighScattering: new THREE.Vector3(5.802e-3, 13.558e-3, 33.1e-3),
  rayleighHeightKm: 8,
  mieScattering: 3.996e-3,
  mieExtinction: 4.4e-3,
  /** real ~1.2 km; raised so the low aerosol haze glows gold toward the Sun */
  mieHeightKm: 3.2,
  mieG: 0.8,
  ozoneAbsorption: new THREE.Vector3(0.65e-3, 1.881e-3, 0.085e-3),
  /** ozone density multiplier: the stretched layer is thicker, so thin it back
   *  so the lit limb stays white rather than magenta */
  ozoneStrength: 0.6,
  ozoneCenterKm: 25,
  ozoneHalfWidthKm: 15,
  /** sunlight colour × illuminance (linear) */
  sunColor: new THREE.Color(0xfff6ec),
  /** radiance -> display: col = white * (1 - exp(-L * exposure / white)) —
   *  linear slope `exposure` in the shadows, soft shoulder at `white` so the
   *  sunlit limb glows without clipping into a bloom wash */
  exposure: 8,
  white: 1.0,
  /** cheap multiple-scattering ambient (isotropic, scaled by local scattering) */
  multiScatterColor: new THREE.Color(0x7fa8ff),
  multiScatter: 0.12,
  /** cos(sun zenith) range over which the multiple-scattering ambient fades in */
  multiScatterMuLow: -0.12,
  multiScatterMuHigh: 0.25,
  /** soft Earth-shadow edge (half-width in cos units; sun disc ~0.0047 rad) */
  shadowSoftness: 0.008,
  /** aerial perspective over the disc (rays hitting the ground), relative to limb */
  discHaze: 0.08,
  /** closest-approach depth (km below the surface) over which disc haze ramps to full at grazing */
  discGrazeKm: 15,
  /** faint tall analytic glow above the lit limb (dark navy, not black) */
  outerGlow: new THREE.Color(0x2b4a8a),
  outerGlowStrength: 0.45,
  outerGlowHeightKm: 70,
};

/** Night sky (stars.ts + milkyway.ts): catalogue stars as physically scaled
 *  PSF points, a procedural galactic-frame Milky Way and faint unresolved
 *  star grain. Linear values; the whole sky is scaled by setExposure(). */
export const SKY = {
  /** peak pixel intensity (linear) of a mag-6.5 star at full exposure */
  faintPeak: 0.022,
  /** flux exponent: 1 = true photometric ratio, <1 compresses the range */
  fluxGamma: 1.0,
  /** gaussian PSF sigma in device pixels */
  psfSigmaPx: 0.7,
  /** relative halo amplitude (only the brightest few dozen stars clear the threshold) */
  haloStrength: 0.012,
  /** halo scale radius, device pixels */
  haloRadiusPx: 2.4,
  /** 0 = true blackbody colours, 1 = white */
  starDesaturate: 0.35,
  /** Milky Way diffuse glow scale (linear) */
  milkyWayIntensity: 0.075,
  /** warm bulge / cool disc tints */
  bulgeTint: new THREE.Color(1.0, 0.82, 0.62),
  discTint: new THREE.Color(0.82, 0.88, 1.0),
  /** number of synthetic faint (mag 6.5-9.2) grain stars following the band */
  grainStars: 20000,
};

/** Layered cloud tones (clouds.ts): painterly bright tops, blue-grey / lavender
 *  shaded sides and bases, translucent warm-white cirrus, and the low-sun
 *  tints (gold → pink as the sun sets for that cloud's altitude). */
export const CLOUD_LAYERS = {
  lowLit: new THREE.Color(0xebe8e5),
  lowShade: new THREE.Color(0x8d99b3),
  lowDeep: new THREE.Color(0x5d6886),
  midLit: new THREE.Color(0xe7e9ef),
  midShade: new THREE.Color(0x8793ab),
  highLit: new THREE.Color(0xfbf8f2),
  highShade: new THREE.Color(0xa4aec4),
  sunsetGold: new THREE.Color(0xffc98c),
  sunsetPink: new THREE.Color(0xf09aa6),
};

/** DEM-driven surface colours (earth.ts): shallow banks, lakes, mountain snow
 *  and sea ice. Kept quiet and desaturated, close to the ocean / land faces
 *  they sit next to. */
export const SURFACE = {
  /** shallow banks and reefs (Bahamas, Red Sea, Great Barrier Reef): depth < ~40 m */
  turquoise: new THREE.Color(0x4a969b),
  /** major lakes */
  lake: new THREE.Color(0x467f9a),
  /** snow above the latitude-dependent snow line */
  snow: new THREE.Color(0xeceeed),
  /** seasonal sea ice: a touch bluer than the land ice */
  seaIce: new THREE.Color(0xdbe6ec),
};
