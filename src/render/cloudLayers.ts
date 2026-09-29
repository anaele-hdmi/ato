// Cloud layer altitudes (meteorological genera → rendered shells).
//
// Real altitudes are multiplied by CLOUD_EXAGGERATION so the layers read as
// separate from 420 km and sit in the same stretched world as the terrain
// (terrain.ts EXAGGERATION = 5: the Alps reach ~24 km, Tibet ~23 km, Everest
// ~44 km). 4× (a little less than the terrain) keeps the low deck below the
// big ranges (they poke through, as in the reference) while cirrus sits above
// almost every peak.
//
//   genus                               real km        rendered km
//   low: Sc / trade Cu / fair-weather Cu  base 1.0      4
//        Sc deck tops                     ~1.9          ~7.5
//        Cu tops                          ~3            12
//   deep convection: Cb towers            up to ~12.5   up to 50 (overshooting tops)
//   mid: As / Ac                          5.5           22
//   high: Ci / Cs / Cb anvils             11.5          46
import { EARTH_RADIUS_KM } from '../types';

export const CLOUD_EXAGGERATION = 4;

const km = (realKm: number) => realKm * CLOUD_EXAGGERATION;

export const CLOUD_ALT = {
  /** base of the low (boundary-layer) cloud slab */
  lowBase: km(1.0),
  /** stratocumulus deck top (flat, under the trade inversion) */
  deckTop: km(1.9),
  /** trade / fair-weather cumulus tops: top of the low slab */
  lowTop: km(3.0),
  /** cumulonimbus towers (overshooting tops); radius of the low/convective shell */
  cbTop: km(12.5),
  /** altostratus / altocumulus shell */
  mid: km(5.5),
  /** cirrus / cirrostratus / anvil shell */
  high: km(11.5),
} as const;

/** GLSL constants shared by the cloud shells, the bake and the ground shadow. */
export const CLOUD_ALT_GLSL = /* glsl */ `
const float CL_R0 = ${EARTH_RADIUS_KM.toFixed(1)};
const float CL_LOW_BASE = ${CLOUD_ALT.lowBase.toFixed(2)};
const float CL_DECK_TOP = ${CLOUD_ALT.deckTop.toFixed(2)};
const float CL_LOW_TOP = ${CLOUD_ALT.lowTop.toFixed(2)};
const float CL_CB_TOP = ${CLOUD_ALT.cbTop.toFixed(2)};
const float CL_MID = ${CLOUD_ALT.mid.toFixed(2)};
const float CL_HIGH = ${CLOUD_ALT.high.toFixed(2)};

// cos(sun zenith) at which the sun sets for a point at altitude hKm (rendered
// geometry): the horizon dips by acos(R / (R + h)), so a cloud top stays lit
// after the ground below it has gone dark.
float clHorizonDip(float hKm) {
  return sqrt(2.0 * max(hKm, 0.0) / CL_R0);
}
`;
