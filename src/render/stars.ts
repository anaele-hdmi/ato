// Catalogue starfield: ~15,500 real stars (Hipparcos-derived, to mag 7.0)
// drawn as physically scaled point-spread functions.
//
// Each star is a tiny gaussian core whose integrated energy follows its flux
// (10^-0.4m, lightly range-compressed); the brightest few dozen also get a
// faint Moffat-like halo. Sizes are in device pixels and the PSF is evaluated
// from the star's exact sub-pixel centre, so sub-pixel stars fade by coverage
// instead of flickering as the camera pans. Colour comes from B-V ->
// blackbody temperature (Ballesteros 2012) -> linear sRGB, gently desaturated.
// No twinkling: there is no atmosphere between the station and the stars.
//
// Scene frame is ECI/J2000: RA a, Dec d -> (cos d cos a, sin d, -cos d sin a).
// Data: src/assets/stars.bin, 6 bytes per star, brightest first:
//   u16 RA (x 360/65536 deg), i16 Dec (x 90/32767 deg), u8 (mag + 2) x 25,
//   u8 (B-V + 0.5) x 100 (255 = unknown).
// Source: d3-celestial data/stars.8.json (c) 2015 Olaf Frohn, BSD-3-Clause.
import * as THREE from 'three';
import { SKY } from './palette';
import starsUrl from '../assets/stars.bin?url';

/** Radius of the "celestial sphere" the sky is drawn on (camera far = 100,000 km). */
export const SKY_RADIUS_KM = 90000;

/** Unit scene-frame direction for J2000 right ascension / declination (radians). */
export function raDecToScene(raRad: number, decRad: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(decRad);
  return out.set(c * Math.cos(raRad), Math.sin(decRad), -c * Math.sin(raRad));
}

/** Blackbody temperature (K) from B-V colour index (Ballesteros 2012). */
export function bvToKelvin(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** Linear-sRGB colour of a blackbody at `kelvin`, normalised to luminance 1
 *  (Kim et al. CCT -> CIE xy spline, XYZ -> sRGB D65), then mixed toward
 *  white by `desaturate`. */
export function kelvinToLinearRgb(kelvin: number, desaturate: number, out = new THREE.Color()): THREE.Color {
  const T = THREE.MathUtils.clamp(kelvin, 1667, 25000);
  const t1 = 1e3 / T;
  const t2 = t1 * t1;
  const t3 = t2 * t1;
  const x =
    T <= 4000
      ? -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t1 + 0.17991
      : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    T <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  let r = Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z);
  let g = Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z);
  let b = Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r /= lum;
  g /= lum;
  b /= lum;
  return out.setRGB(r + (1 - r) * desaturate, g + (1 - g) * desaturate, b + (1 - b) * desaturate);
}

/** Relative flux of a star, 1 at magnitude 6.5 (range-compressed by SKY.fluxGamma). */
export function magToFlux(mag: number): number {
  return Math.pow(10, -0.4 * SKY.fluxGamma * (mag - 6.5));
}

// ---------------------------------------------------------------------------
// Shared PSF point material (also used by milkyway.ts for unresolved grain).

const POINT_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aFlux;
  attribute vec3 aColor;
  uniform float uPeakScale;   // peak intensity per unit flux (incl. exposure gain)
  uniform float uHaloScale;   // halo amplitude per unit flux (incl. exposure gain)
  uniform float uSigma;       // PSF sigma, device px
  uniform float uHaloR;       // halo radius, device px
  uniform float uPedestal;    // black point lifted as exposure drops
  uniform float uMaxSize;
  varying vec3 vColor;
  varying float vPeak;
  varying float vHalo;
  varying float vSize;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
    float peak = aFlux * uPeakScale;
    float halo = aFlux * uHaloScale;
    float thr = 0.0025 + uPedestal;
    float rG = peak > thr ? uSigma * sqrt(2.0 * log(peak / thr)) : 0.0;
    float rH = halo > thr ? uHaloR * sqrt(pow(halo / thr, 0.6667) - 1.0) : 0.0;
    float r = max(rG, rH);
    if (r <= 0.0) {
      // Below the visible floor at this exposure: clip the point away.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 1.0;
      return;
    }
    // Keep at least +-2 sigma of support so the core integrates to the same
    // energy wherever the centre falls inside a pixel (no pan flicker).
    vSize = min(2.0 * max(r, 2.0 * uSigma) + 2.0, uMaxSize);
    gl_PointSize = vSize;
    vPeak = peak;
    vHalo = halo;
    vColor = aColor;
  }
`;

const POINT_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uSigma;
  uniform float uHaloR;
  uniform float uPedestal;
  varying vec3 vColor;
  varying float vPeak;
  varying float vHalo;
  varying float vSize;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = (gl_PointCoord - 0.5) * vSize;
    float d2 = dot(p, p);
    float h = 1.0 + d2 / (uHaloR * uHaloR);
    float I = vPeak * exp(-d2 / (2.0 * uSigma * uSigma)) + vHalo / (h * sqrt(h));
    I = max(I - uPedestal, 0.0);
    // Soft per-channel saturation: bright cores whiten and widen gracefully
    // instead of clipping into flat discs.
    vec3 c = 0.92 * (1.0 - exp(-vColor * I));
    if (c.r + c.g + c.b < 0.0015) discard;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Additive, depth-tested (not depth-writing) PSF point material. */
export function createStarPointsMaterial(): THREE.ShaderMaterial {
  const sigma = SKY.psfSigmaPx;
  const peak = SKY.faintPeak;
  return new THREE.ShaderMaterial({
    uniforms: {
      uPeakScale: { value: peak },
      uHaloScale: { value: peak * 2 * Math.PI * sigma * sigma * SKY.haloStrength },
      uSigma: { value: sigma },
      uHaloR: { value: SKY.haloRadiusPx },
      uPedestal: { value: 0 },
      uMaxSize: { value: 48 },
    },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

/** Exposure response shared by the whole sky: squared gain plus a black point
 *  that rises as exposure falls, so faint stars vanish first and bright ones
 *  shrink rather than just dimming. */
export function skyExposure(x: number): { gain: number; pedestal: number } {
  const e = THREE.MathUtils.clamp(x, 0, 1);
  return { gain: e * e, pedestal: 0.02 * (1 - e) };
}

export function applyStarExposure(material: THREE.ShaderMaterial, x: number): void {
  const { gain, pedestal } = skyExposure(x);
  const sigma = material.uniforms.uSigma.value as number;
  material.uniforms.uPeakScale.value = SKY.faintPeak * gain;
  material.uniforms.uHaloScale.value = SKY.faintPeak * 2 * Math.PI * sigma * sigma * SKY.haloStrength * gain;
  material.uniforms.uPedestal.value = pedestal;
}

// ---------------------------------------------------------------------------

export interface StarsObjects {
  /** Add to the scene. Centred on the camera by update(). */
  object: THREE.Points;
  /** @deprecated alias of `object` (kept so the old index.ts wiring compiles). */
  points: THREE.Points;
  /** Resolves once the catalogue has been fetched and uploaded. */
  ready: Promise<void>;
  /** 0 = hidden (daylight-adapted eye/camera), 1 = fully dark-adapted (default). */
  setExposure(x: number): void;
  /** Keep the sky centred on the eye so it sits at infinity. Call after the camera moves. */
  update(camera: THREE.Camera): void;
  dispose(): void;
}

function decodeCatalogue(buf: ArrayBuffer, geometry: THREE.BufferGeometry): void {
  const view = new DataView(buf);
  const n = Math.floor(buf.byteLength / 6);
  const positions = new Float32Array(n * 3);
  const flux = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const dir = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const ra = (view.getUint16(o, true) / 65536) * Math.PI * 2;
    const dec = (view.getInt16(o + 2, true) / 32767) * (Math.PI / 2);
    const mag = view.getUint8(o + 4) / 25 - 2;
    const bvq = view.getUint8(o + 5);
    const bv = bvq === 255 ? 0.65 : bvq / 100 - 0.5;
    raDecToScene(ra, dec, dir).multiplyScalar(SKY_RADIUS_KM);
    positions[i * 3] = dir.x;
    positions[i * 3 + 1] = dir.y;
    positions[i * 3 + 2] = dir.z;
    flux[i] = magToFlux(mag);
    kelvinToLinearRgb(bvToKelvin(bv), SKY.starDesaturate, col);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFlux', new THREE.BufferAttribute(flux, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setDrawRange(0, n);
}

export function createStars(): StarsObjects {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  geometry.setDrawRange(0, 0);
  const material = createStarPointsMaterial();
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // Draw before the Sun sprite (-1) and the atmosphere (0), after the Milky Way.
  points.renderOrder = -2;
  points.name = 'stars';

  let disposed = false;
  const ready = fetch(starsUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`stars.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      if (!disposed) decodeCatalogue(buf, geometry);
    })
    .catch((err: unknown) => {
      console.warn('[stars] catalogue failed to load', err);
    });

  const eye = new THREE.Vector3();
  function setExposure(x: number): void {
    applyStarExposure(material, x);
    points.visible = x > 0.002;
  }
  setExposure(1);

  return {
    object: points,
    points,
    ready,
    setExposure,
    update(camera) {
      camera.getWorldPosition(eye);
      points.position.copy(eye);
    },
    dispose() {
      disposed = true;
      geometry.dispose();
      material.dispose();
    },
  };
}
