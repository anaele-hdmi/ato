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
  /** saturated disc colour (white; the 8-bit target clips it) */
  disc: new THREE.Color(0xfffcf4),
  /** angular radius of the disc, degrees (0.53 deg diameter) */
  discRadiusDeg: 0.2665,
  /** limb extinction: T = exp(-tauScale * exp(-h/scaleHeightKm) * beta) per channel, h = tangent height of the ray */
  extinctionBeta: new THREE.Vector3(0.35, 0.8, 1.8),
  extinctionTau: 1.6,
  extinctionScaleKm: 6,
  /** refraction flattening of the disc at h = 0 (vertical axis squashed by this fraction) */
  flattenMax: 0.5,
  flattenScaleKm: 9,
};

/** Lens flare / glare: screen-space sprites around the Sun (flare.ts). All gains are additive radiance. */
export const FLARE = {
  /** thin 8-point diffraction spikes */
  spike: 0.85,
  /** wide soft veil and faint fine streaks */
  halo: 0.30,
  /** close glow around the disc */
  core: 0.9,
  /** ghost gain (multiplies each ghost's own gain) */
  ghost: 0.6,
  /** how much the auto exposure closes when the Sun fills the view (0..1) */
  exposureDip: 0.5,
  /** ghosts: t = position along the Sun->screen-centre axis (1 = Sun, 0 = centre, -1 = opposite), size = screen-height fraction */
  ghosts: [
    { t: 0.62, size: 0.10, ring: 0.0, gain: 0.05, color: new THREE.Color(0xf2d6b0) },
    { t: 0.30, size: 0.17, ring: 1.0, gain: 0.035, color: new THREE.Color(0xa8c8ee) },
    { t: -0.30, size: 0.09, ring: 0.0, gain: 0.05, color: new THREE.Color(0xc0e8cc) },
    { t: -0.62, size: 0.26, ring: 1.0, gain: 0.03, color: new THREE.Color(0xe8b8d0) },
    { t: -1.05, size: 0.14, ring: 0.0, gain: 0.04, color: new THREE.Color(0xb0b8ee) },
  ],
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
  /** exterior cupola window glass: near black, reflects the sun */
  glass: new THREE.Color(0x070b13),
  glassSpecular: new THREE.Color(0xa9bbd8),
  /** opened window shutters */
  shutter: new THREE.Color(0x9c9a94),
};

/** Interior window frames (cabin.ts). Lighting is analytic: a little ambient,
 *  earthshine from below, and the Sun only where it can reach through a window.
 *  Intensities are linear radiance multipliers (the Sun uses SUN.*). */
export const CABIN = {
  wall: new THREE.Color(0x15181f),
  /** window seal / rubber gasket between glass and metal */
  seal: new THREE.Color(0x12151a),
  /** anodised aluminium frame */
  frame: new THREE.Color(0xa09e98),
  ambient: new THREE.Color(0x8fa2c8),
  ambientIntensity: 0.05,
  /** blue-white light bounced up from the Earth: strong over the day side */
  earthshine: new THREE.Color(0xa6bfe8),
  earthDay: 0.3,
  earthNight: 0.03,
  /** Sun colour while it grazes the atmosphere (sunrise / sunset moment) */
  sunWarm: new THREE.Color(0xff8a45),
  /** glass reflection: base (normal incidence) and extra at grazing angles */
  glassBase: 0.035,
  glassFresnel: 0.5,
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

/** Variable depth of field (post.ts / cameraRig.ts). Orbital photos are
 *  focused at infinity, so the Earth is never blurred from inside. */
export const DOF = {
  /** interior views: half-width (degrees of view angle) of the soft penumbra on
   *  the window aperture edge, i.e. how out-of-focus the frame/mullions are */
  cabinBlurDeg: 0.6,
  /** chase view: background (Earth) blur radius at closest zoom, as a fraction of frame height (~2.4 px at 1080p) */
  chaseBlurFrac: 0.0022,
  /** chase distance (km): full effect at/below near, none at/above far */
  chaseNearKm: 0.03,
  chaseFarKm: 0.2,
  /** easing time constant (s) for the chase blur amount */
  easeSec: 0.3,
};

/** Lightning inside night-side convective cells (clouds.ts, cloudLightning). */
export const LIGHTNING = {
  /** cold blue-white glow of a flash inside the cloud (linear) */
  color: new THREE.Color(0.5, 0.66, 1.0),
  /** peak emissive strength of a return stroke on thick cloud */
  intensity: 3.4,
  /** flash probability per cell per 6 s slot at full convective strength in
   *  the local evening (kept low: the dark side is quiet, a flash now and then) */
  rate: 0.25,
  /** debug only: 1 = every active cell glows continuously (for stills) */
  hold: 0,
};

/** Near-view cloud form (clouds.ts, low layer): pseudo-normal lighting and
 *  self-shadowing of the 2D cumulus field. */
export const CLOUD_FORM = {
  /** max darkening of a puff on the side facing away from the sun (0..1) */
  selfShadow: 0.5,
  /** darkening in the gaps between puffs (cavity / ambient occlusion) */
  cavity: 0.34,
  /** thin sun-side edges glow with light passing through (translucency) */
  rim: 0.32,
};

/** Moon (moon.ts): a lunar surface lit by the Sun, dim bluish earthshine on
 *  the dark part. Colours are linear-converted hex; brightness is a scale on
 *  the whole disc before the sky-exposure gain. */
export const MOON = {
  highland: new THREE.Color(0xd8d3c8),
  mare: new THREE.Color(0x7c8088),
  earthshine: new THREE.Color(0x5f7fb8),
  /** earthshine radiance relative to the lit disc at full Earth phase */
  earthshineStrength: 0.045,
  /** peak brightness of the lit surface (linear, before exposure) */
  brightness: 0.95,
  /** faint halo around the disc, relative to the disc, scaled by phase */
  halo: 0.05,
  /** eclipsed moon: dim coppery red */
  eclipse: new THREE.Color(0xa13a1c),
};

/** Aurora (aurora.ts): 557.7 nm oxygen green low, faint 630 nm red above. */
export const AURORA = {
  green: new THREE.Color(0x35e0a0),
  red: new THREE.Color(0xc02a55),
  /** N2+ blue-violet fringe on the lower edge */
  fringe: new THREE.Color(0x6a5ad8),
  /** overall radiance scale (linear, additive) */
  intensity: 0.55,
};

/** Noctilucent clouds (atmosphere.ts): thin silvery-blue layer at ~83 km. */
export const NLC = {
  color: new THREE.Color(0x9fc4ff),
  intensity: 0.6,
};

/** Meteors (meteors.ts): short warm-white streaks with a faint green tail. */
export const METEOR = {
  head: new THREE.Color(0xfff2dc),
  tail: new THREE.Color(0x9fe8c8),
  intensity: 2.4,
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

/** Night-side city lights (earth.ts, from assets/city-lights.webp = NASA Black
 *  Marble). Linear colours; the texture value picks orange (suburbs) -> white (cores). */
export const CITY_LIGHTS = {
  /** sodium-lamp orange of the outskirts */
  suburb: new THREE.Color(1.0, 0.5, 0.16),
  /** the white-hot core of a big city */
  core: new THREE.Color(1.0, 0.86, 0.66),
  /** texture value (0..1) is raised to this power: suppresses the faint scatter of hamlets */
  gamma: 1.8,
  /** overall brightness. Sized so that only the biggest cores pass the 0.95 bloom threshold. */
  gain: 0.6,
  /** sun elevation (deg) where the lights are fully on / fully off (twilight fade-in) */
  fullDeg: -10,
  offDeg: -4,
  /** per-extra-airmass extinction (r, g, b): distant lights near the horizon dim and redden */
  extinction: new THREE.Vector3(0.05, 0.11, 0.24),
  /** how much a full cloud cover dims the lights beneath it (the rest glows through, blurred) */
  cloudBlock: 0.8,
};

/** Moonlight on the night side (earth.ts surface + glint, clouds.ts). `illum` is
 *  FrameState.moon.illuminance (full moon at mean distance = 1); it is
 *  compressed with moonlightLevel() so a quarter moon is still faintly visible. */
export const MOONLIGHT = {
  /** cool blue-white tint of moonlit ground (multiplies the daytime albedo) */
  surface: new THREE.Color(0.42, 0.55, 0.85),
  surfaceGain: 0.11,
  /** moonlit cloud tops */
  cloud: new THREE.Color(0.5, 0.62, 0.9),
  cloudGain: 0.13,
  /** silver reflection on the sea (same slope distribution as the sun glint) */
  glint: new THREE.Color(0.7, 0.82, 1.0),
  glintGain: 2.4,
};

/** Perceptual compression of the moonlight illuminance: new moon = 0, quarter ~0.24, full = 1. */
export function moonlightLevel(illum: number): number {
  return Math.pow(Math.min(Math.max(illum, 0), 1.3), 0.6);
}
