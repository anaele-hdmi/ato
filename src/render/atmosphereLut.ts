// Transmittance LUT for the atmosphere shader (Bruneton 2017 parameterisation,
// as used by Hillaire 2020). Computed once on the CPU at startup (~5–15 ms):
// each texel holds exp(-optical depth) from a point at radius r along a ray
// with cos(zenith) mu up to the top of the atmosphere, ignoring the ground.
// The shader handles Earth's shadow separately (soft horizon test), so rays
// below the horizon simply clamp to the grazing value.
//
//   u (x_mu): distance to the top boundary, remapped between d_min = top - r
//             (straight up) and d_max = rho + H (grazing the ground).
//   v (x_r) : rho / H, rho = sqrt(r^2 - R^2), H = sqrt(top^2 - R^2) — packs
//             resolution into the dense low layers.
import * as THREE from 'three';

export interface AtmosphereMedium {
  /** planet radius, km */
  radius: number;
  /** top of the atmosphere (radius, km) */
  top: number;
  rayleighScattering: THREE.Vector3;
  rayleighHeight: number;
  mieExtinction: number;
  mieHeight: number;
  ozoneAbsorption: THREE.Vector3;
  ozoneCenter: number;
  ozoneHalfWidth: number;
}

export const TRANSMITTANCE_LUT_WIDTH = 128; // x_mu
export const TRANSMITTANCE_LUT_HEIGHT = 32; // x_r
/** Per-texel optical-depth samples. Steps are warped quadratically toward the
 *  ray's lowest point (start, or the tangent point for down-going rays), so 20
 *  samples match a 400-step uniform reference to <1% in transmittance. */
const INTEGRATION_STEPS = 20;

/** Builds the transmittance LUT as an RGBA half-float texture (filterable on WebGL2). */
export function createTransmittanceLut(m: AtmosphereMedium): THREE.DataTexture {
  const W = TRANSMITTANCE_LUT_WIDTH;
  const Hh = TRANSMITTANCE_LUT_HEIGHT;
  const R = m.radius;
  const top = m.top;
  const H = Math.sqrt(top * top - R * R);
  const data = new Uint16Array(W * Hh * 4);
  const bR = m.rayleighScattering;
  const bO = m.ozoneAbsorption;
  const one = THREE.DataUtils.toHalfFloat(1);

  for (let j = 0; j < Hh; j++) {
    const xr = j / (Hh - 1);
    const rho = H * xr;
    const r = Math.sqrt(rho * rho + R * R);
    const dMin = top - r;
    const dMax = rho + H;
    for (let i = 0; i < W; i++) {
      const xmu = i / (W - 1);
      const d = dMin + xmu * (dMax - dMin);
      // invert d(r, mu) = -r mu + sqrt(r^2 (mu^2 - 1) + top^2)
      let mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
      mu = Math.max(-1, Math.min(1, mu));

      // midpoint integration in a warped parameter s: t = tm -/+ A s'^2
      // around tm, the ray's lowest point (same scheme as the view march)
      const tm = Math.min(Math.max(-r * mu, 0), d);
      const A = tm;
      const B = d - tm;
      const f = d > 0 ? Math.min(Math.max(A / d, 1e-4), 1 - 1e-4) : 0.5;
      const ds = 1 / INTEGRATION_STEPS;
      let odR = 0;
      let odM = 0;
      let odO = 0;
      for (let k = 0; k < INTEGRATION_STEPS; k++) {
        const s = (k + 0.5) * ds;
        let t: number;
        let w: number;
        if (s < f) {
          const u = (f - s) / f;
          t = tm - A * u * u;
          w = (2 * A * u) / f;
        } else {
          const u = (s - f) / (1 - f);
          t = tm + B * u * u;
          w = (2 * B * u) / (1 - f);
        }
        const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
        const h = Math.max(rr - R, 0);
        odR += Math.exp(-h / m.rayleighHeight) * w;
        odM += Math.exp(-h / m.mieHeight) * w;
        odO += Math.max(0, 1 - Math.abs(h - m.ozoneCenter) / m.ozoneHalfWidth) * w;
      }
      const dt = ds;
      odR *= dt;
      odM *= dt;
      odO *= dt;
      const o = (j * W + i) * 4;
      data[o] = THREE.DataUtils.toHalfFloat(Math.exp(-(bR.x * odR + m.mieExtinction * odM + bO.x * odO)));
      data[o + 1] = THREE.DataUtils.toHalfFloat(Math.exp(-(bR.y * odR + m.mieExtinction * odM + bO.y * odO)));
      data[o + 2] = THREE.DataUtils.toHalfFloat(Math.exp(-(bR.z * odR + m.mieExtinction * odM + bO.z * odO)));
      data[o + 3] = one;
    }
  }

  const tex = new THREE.DataTexture(data, W, Hh, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
