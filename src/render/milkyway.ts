// Procedural Milky Way, placed with the real galactic frame (J2000: north
// galactic pole RA 192.859 deg / Dec +27.128 deg, galactic centre RA 266.405 deg /
// Dec -28.936 deg). No licensed imagery.
//
// At startup a fragment shader bakes the diffuse glow once into a 2048x1024
// equirectangular texture in galactic (l, b): a thin bright core plus a wider
// faint glow, brightest toward the Sagittarius/Scorpius bulge and fading to
// the anticentre, star clouds (Cygnus, Scutum, Carina), and dust extinction
// (the Great Rift from Cygnus to Sagittarius, the Ophiuchus clouds, the
// Coalsack by Crux) that also reddens the band's edges. The texture is stored
// sqrt-encoded in RGBA8 (good precision in the darks, mipmapped) and drawn on
// an inside-out sphere whose uv already maps to (l, b), so the per-frame cost
// is a single texture fetch.
//
// Faint "unresolved" star grain is real geometry: ~90k synthetic mag 6.5-9.2
// PSF points sampled from a low-res readback of the same bake (so they
// follow the band and avoid the dust), drawn with the catalogue-star shader,
// so they anti-alias by coverage and never shimmer.
import * as THREE from 'three';
import { SKY } from './palette';
import { NOISE_GLSL } from './noiseGlsl';
import {
  SKY_RADIUS_KM,
  raDecToScene,
  createStarPointsMaterial,
  applyStarExposure,
  skyExposure,
  kelvinToLinearRgb,
  bvToKelvin,
  magToFlux,
} from './stars';

const BAKE_W = 2048;
const BAKE_H = 1024;
const DENSITY_W = 512;
const DENSITY_H = 256;
/** linear value stored as 1.0 in the bake (sqrt encoding) */
const ENCODE_MAX = 1.6;
const SPHERE_RADIUS_KM = SKY_RADIUS_KM * 0.97;

const DEG = Math.PI / 180;

/** Rotation taking the galactic-local frame used by the bake (+X galactic
 *  centre, +Y north galactic pole, +Z = X x Y i.e. toward l = 270 deg) into the scene frame. */
export function galacticToSceneMatrix(out = new THREE.Matrix4()): THREE.Matrix4 {
  const c = raDecToScene(266.405 * DEG, -28.936 * DEG);
  const n = raDecToScene(192.859 * DEG, 27.128 * DEG);
  n.addScaledVector(c, -n.dot(c)).normalize();
  const z = new THREE.Vector3().crossVectors(c, n);
  return out.makeBasis(c, n, z);
}

/** Galactic-local unit direction for an equirect uv (same convention as SphereGeometry). */
function uvToLocal(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const phi = u * Math.PI * 2;
  const th = (1 - v) * Math.PI;
  const s = Math.sin(th);
  return out.set(-Math.cos(phi) * s, Math.cos(th), Math.sin(phi) * s);
}

const BAKE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BAKE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uBulgeTint;
  uniform vec3 uDiscTint;
  uniform float uEncodeMax;
  varying vec2 vUv;
  ${NOISE_GLSL}

  float fbmN(vec3 p, int oct) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 7; i++) {
      if (i >= oct) break;
      sum += cloudNoise(p) * amp;
      norm += amp;
      p = p * 2.03 + vec3(1.7, 9.2, 5.3);
      amp *= 0.5;
    }
    return sum / norm;
  }
  float g1(float x, float w) { return exp(-0.5 * x * x / (w * w)); }
  // signed longitude difference, degrees, wrapped to (-180, 180]
  float dl(float l, float c) { return mod(l - c + 180.0, 360.0) - 180.0; }

  void main() {
    float phi = vUv.x * 6.28318531;
    float th = (1.0 - vUv.y) * 3.14159265;
    vec3 d = vec3(-cos(phi) * sin(th), cos(th), sin(phi) * sin(th));
    float l = degrees(atan(-d.z, d.x));
    float b = degrees(asin(clamp(d.y, -1.0, 1.0)));
    float ab = abs(b);
    float cen = pow(0.5 + 0.5 * cos(radians(l)), 2.5);

    // --- starlight --------------------------------------------------------
    float lp = 0.2 + 0.5 * cen
      + 0.32 * g1(dl(l, 76.0), 12.0)    // Cygnus star cloud
      + 0.34 * g1(dl(l, -73.0), 9.0)    // Carina
      + 0.20 * g1(dl(l, -50.0), 8.0)    // Norma / Centaurus
      + 0.30 * g1(dl(l, 27.0), 4.5)     // Scutum star cloud
      + 0.25 * g1(dl(l, 8.0), 5.0);     // Sagittarius (M24) cloud
    float wCore = 3.2 + 2.2 * cen;
    float core = exp(-pow(ab / wCore, 1.4));
    float wide = exp(-ab / (6.0 + 6.0 * cen));
    float glow = exp(-ab / 22.0);
    float bulge = exp(-0.5 * (pow(dl(l, 0.0) / 10.0, 2.0) + pow((b + 1.5) / 7.5, 2.0)));

    float clouds = fbmN(d * 6.0 + 3.1, 5);
    float fine = fbmN(d * 60.0 + 7.3, 4);
    // patchy star clouds with a granular fine structure
    float mottled = (0.3 + 1.4 * clouds * clouds * 2.0) * (0.7 + 0.6 * fine);
    float S = lp * (0.85 * core + 0.3 * wide) * mottled
            + 1.6 * bulge * (0.75 + 0.5 * clouds)
            + 0.03 * glow;

    // --- dust -------------------------------------------------------------
    vec3 q = d * 14.0;
    vec3 warp = vec3(fbmN(q + 1.7, 3), fbmN(q + 9.2, 3), fbmN(q + 4.4, 3)) - 0.5;
    float n1 = fbmN(q + warp * 1.5, 7);
    float ridge = 1.0 - abs(2.0 * fbmN(q * 2.2 + warp * 2.5 + 11.0, 5) - 1.0);

    // Great Rift: Cygnus (l~80) to Sagittarius/Ophiuchus (l~-25), sitting a
    // little north of the plane and splitting the band lengthwise.
    float rift = smoothstep(-34.0, -18.0, l) * (1.0 - smoothstep(58.0, 84.0, l));
    float b0 = 0.5 + 2.0 * smoothstep(15.0, 70.0, l);
    float lane = exp(-pow(abs(b - b0) / (1.3 + 2.0 * n1), 1.6));
    float tau = 2.2 * rift * lane * smoothstep(0.42, 0.62, n1 + 0.1 * ridge);
    // thin dust lane along the whole plane, stronger toward the inner Galaxy
    tau += (0.4 + 0.9 * cen) * exp(-ab / 1.4) * smoothstep(0.45, 0.65, n1);
    // filamentary wisps at intermediate latitudes
    tau += 0.8 * exp(-ab / 4.5) * pow(ridge, 10.0) * smoothstep(0.42, 0.6, n1);
    // Ophiuchus / Pipe dark clouds north of the centre
    tau += 1.8 * exp(-0.5 * (pow(dl(l, 0.0) / 5.0, 2.0) + pow((b - 6.0) / 4.5, 2.0))) * smoothstep(0.3, 0.68, n1);
    // Coalsack (l ~303, b ~-0.5), south-east of Crux
    tau += 3.2 * exp(-0.5 * (pow(dl(l, -56.8) / 2.7, 2.0) + pow((b + 0.5) / 2.2, 2.0))) * (0.7 + 0.6 * n1);

    vec3 ext = exp(-tau * vec3(0.86, 1.0, 1.18)); // extinction reddens the edges
    float bulgeFrac = clamp(1.6 * bulge / (S + 1e-4), 0.0, 1.0);
    vec3 tint = mix(uDiscTint, uBulgeTint, clamp(0.85 * bulgeFrac + 0.2 * cen, 0.0, 1.0));
    vec3 col = S * tint * ext;
    gl_FragColor = vec4(sqrt(clamp(col / uEncodeMax, 0.0, 1.0)), 1.0);
  }
`;

const SKY_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform float uScale;
  uniform float uPedestal;
  varying vec2 vUv;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 t = texture2D(uMap, vUv).rgb;
    vec3 c = max(t * t * uScale - uPedestal, 0.0);
    gl_FragColor = vec4(c, 1.0);
  }
`;

export interface MilkyWayObjects {
  /** Add to the scene. Centred on the camera by update(). */
  object: THREE.Group;
  /** 0 = hidden, 1 = fully dark-adapted (default). */
  setExposure(x: number): void;
  /** Keep the sky centred on the eye so it sits at infinity. Call after the camera moves. */
  update(camera: THREE.Camera): void;
  dispose(): void;
}

function bake(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial): void {
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  quad.geometry.dispose();
}

/** Synthetic faint stars distributed like the baked band (dust included). */
function buildGrain(
  renderer: THREE.WebGLRenderer,
  bakeMaterial: THREE.ShaderMaterial,
  count: number,
): THREE.BufferGeometry {
  const target = new THREE.WebGLRenderTarget(DENSITY_W, DENSITY_H, { depthBuffer: false });
  bake(renderer, target, bakeMaterial);
  const px = new Uint8Array(DENSITY_W * DENSITY_H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, DENSITY_W, DENSITY_H, px);
  target.dispose();

  // CDF over texels: decoded luminance x solid angle, plus an isotropic floor.
  const n = DENSITY_W * DENSITY_H;
  const cdf = new Float32Array(n);
  let acc = 0;
  for (let j = 0; j < DENSITY_H; j++) {
    const th = (1 - (j + 0.5) / DENSITY_H) * Math.PI;
    const area = Math.sin(th);
    for (let i = 0; i < DENSITY_W; i++) {
      const k = j * DENSITY_W + i;
      const r = px[k * 4] / 255;
      const g = px[k * 4 + 1] / 255;
      const b = px[k * 4 + 2] / 255;
      const lum = (0.2126 * r * r + 0.7152 * g * g + 0.0722 * b * b) * ENCODE_MAX;
      acc += (lum + 0.02) * area;
      cdf[k] = acc;
    }
  }

  // Deterministic PRNG so the sky is the same every session.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  const positions = new Float32Array(count * 3);
  const flux = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const dir = new THREE.Vector3();
  const col = new THREE.Color();
  // Cumulative counts N(<m) ~ 10^(k m): sample m in [M0, M1].
  const M0 = 6.5;
  const M1 = 9.2;
  const K = 0.42;
  const span = Math.pow(10, K * (M1 - M0)) - 1;
  for (let s = 0; s < count; s++) {
    const x = rand() * acc;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const i = lo % DENSITY_W;
    const j = (lo - i) / DENSITY_W;
    const u = (i + rand()) / DENSITY_W;
    // uniform in solid angle within the texel row
    const c0 = Math.cos((1 - j / DENSITY_H) * Math.PI);
    const c1 = Math.cos((1 - (j + 1) / DENSITY_H) * Math.PI);
    const cy = c0 + (c1 - c0) * rand();
    const v = 1 - Math.acos(THREE.MathUtils.clamp(cy, -1, 1)) / Math.PI;
    uvToLocal(u, v, dir).multiplyScalar(SKY_RADIUS_KM);
    positions[s * 3] = dir.x;
    positions[s * 3 + 1] = dir.y;
    positions[s * 3 + 2] = dir.z;
    const m = M0 + Math.log10(1 + rand() * span) / K;
    flux[s] = magToFlux(m);
    // field-star colours: mostly G/K, some A/F
    const bv = THREE.MathUtils.clamp(0.75 + (rand() + rand() + rand() - 1.5) * 0.55, -0.2, 1.8);
    kelvinToLinearRgb(bvToKelvin(bv), SKY.starDesaturate + 0.15, col);
    colors[s * 3] = col.r;
    colors[s * 3 + 1] = col.g;
    colors[s * 3 + 2] = col.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFlux', new THREE.BufferAttribute(flux, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function createMilkyWay(renderer: THREE.WebGLRenderer): MilkyWayObjects {
  const bakeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uBulgeTint: { value: SKY.bulgeTint },
      uDiscTint: { value: SKY.discTint },
      uEncodeMax: { value: ENCODE_MAX },
    },
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });

  const target = new THREE.WebGLRenderTarget(BAKE_W, BAKE_H, {
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
  });
  bake(renderer, target, bakeMaterial);

  const grainGeometry = buildGrain(renderer, bakeMaterial, SKY.grainStars);
  bakeMaterial.dispose();

  const group = new THREE.Group();
  group.name = 'milkyway';
  const inner = new THREE.Group();
  inner.quaternion.setFromRotationMatrix(galacticToSceneMatrix());
  group.add(inner);

  const sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS_KM, 96, 48);
  const sphereMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: target.texture },
      uScale: { value: ENCODE_MAX * SKY.milkyWayIntensity },
      uPedestal: { value: 0 },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
  sphere.frustumCulled = false;
  sphere.renderOrder = -3;
  inner.add(sphere);

  const grainMaterial = createStarPointsMaterial();
  const grain = new THREE.Points(grainGeometry, grainMaterial);
  grain.frustumCulled = false;
  grain.renderOrder = -2;
  inner.add(grain);

  const eye = new THREE.Vector3();
  function setExposure(x: number): void {
    const { gain, pedestal } = skyExposure(x);
    sphereMaterial.uniforms.uScale.value = ENCODE_MAX * SKY.milkyWayIntensity * gain;
    // the diffuse glow is far fainter than any star: lift its black point less
    sphereMaterial.uniforms.uPedestal.value = pedestal * 0.2;
    applyStarExposure(grainMaterial, x);
    group.visible = x > 0.002;
  }
  setExposure(1);

  return {
    object: group,
    setExposure,
    update(camera) {
      camera.getWorldPosition(eye);
      group.position.copy(eye);
    },
    dispose() {
      target.dispose();
      sphereGeometry.dispose();
      sphereMaterial.dispose();
      grainGeometry.dispose();
      grainMaterial.dispose();
    },
  };
}
