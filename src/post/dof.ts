// Depth of field (scatter-as-gather at half resolution), then a single composite
// that adds faint grain and chromatic aberration.
//
// Pipeline: prep (downsample + CoC) -> blur (fixed-kernel disc gather) ->
// smooth (small bilateral tent pass to kill residual gather noise) -> composite
// (CoC-aware bilateral upsample + sharp/blur mix + grain/CA/contrast/vignette).
import * as THREE from 'three';
import { DepthAO } from './ao';

export interface DofParams {
  focus: number;
  /** CoC in fractions of screen height for an object at infinity. */
  cocFrac: number;
  /** Extra screen-space blur away from the horizontal centre band. */
  tilt: number;
  maxFrac: number;
  grain: number;
  ca: number;
  contrast: number;
  /** 0..1: how far back from the furthest point reached the viewer is looking. */
  memory: number;
  /** Occlusion reach in metres and strength; see ao.ts. */
  aoRadius: number;
  aoIntensity: number;
  time: number;
}

const fsVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COC = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uCocPx;
uniform float uTiltPx;
uniform float uMaxPx;
float linearDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).r * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
uniform sampler2D tAO;
// occlusion only where the air is still thin; far off it would darken the haze itself
float aoAt(vec2 uv) {
  return mix(1.0, texture2D(tAO, uv).r, 1.0 - smoothstep(250.0, 1500.0, linearDepth(uv)));
}
// signed circle of confusion in full-resolution pixels; negative = in front
float cocAt(vec2 uv) {
  float d = linearDepth(uv);
  float c = uCocPx * (1.0 - uFocus / d);
  float tilt = uTiltPx * smoothstep(0.08, 0.5, abs(uv.y - 0.5));
  c = sign(c + 1e-5) * (abs(c) + tilt);
  return clamp(c, -uMaxPx, uMaxPx);
}
`;

const prepFrag = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uTexel;
${COC}
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv + uTexel * vec2(-0.5, -0.5)).rgb
         + texture2D(tColor, vUv + uTexel * vec2(0.5, -0.5)).rgb
         + texture2D(tColor, vUv + uTexel * vec2(-0.5, 0.5)).rgb
         + texture2D(tColor, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  float coc = cocAt(vUv);
  gl_FragColor = vec4(c * 0.25 * aoAt(vUv), 0.5 + 0.5 * coc / uMaxPx);
}
`;

// Scatter-as-gather disc blur. The sample pattern is a fixed, well-distributed
// golden-angle spiral with NO per-pixel random rotation: a random rotation is
// what turned large-radius defocus into visible sparkle/noise, since each
// pixel then integrates a different sparse random subset of the disc. A
// shared fixed kernel instead varies smoothly from pixel to pixel (only the
// underlying image content changes), and the following smooth pass mops up
// the coarser artifacts that a sparse fixed kernel leaves (faint ring
// stepping at large radii).
const blurFrag = /* glsl */ `
uniform sampler2D tHalf;
uniform vec2 uHalfTexel;
uniform float uMaxPx;
varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(tHalf, vUv);
  float cc = (c0.a * 2.0 - 1.0) * uMaxPx;
  vec3 acc = c0.rgb;
  float wsum = 1.0;
  float nearCov = 0.0;
  float maxR = uMaxPx * 0.5;
  const int N = 32;
  for (int i = 0; i < N; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(N)) * maxR;
    float a = fi * 2.39996;
    vec2 off = vec2(cos(a), sin(a)) * r;
    vec4 s = texture2D(tHalf, vUv + off * uHalfTexel);
    float sc = (s.a * 2.0 - 1.0) * uMaxPx;
    // Things behind the centre may not bleed further than the centre's own blur.
    float eff = sc > cc ? min(abs(sc), abs(cc)) : abs(sc);
    float w = smoothstep(r - 1.0, r + 0.5, eff * 0.5);
    acc += s.rgb * w;
    wsum += w;
    if (sc < 0.0) nearCov = max(nearCov, w * abs(sc));
  }
  gl_FragColor = vec4(acc / wsum, nearCov / uMaxPx);
}
`;

// Small bilateral tent pass over the gathered result: smooths out the
// residual stepping/noise from the sparse disc gather without softening
// across in-focus vs out-of-focus boundaries (weight drops where the
// half-res CoC differs a lot from the centre's).
const smoothFrag = /* glsl */ `
uniform sampler2D tBlur;
uniform sampler2D tCoc;
uniform vec2 uHalfTexel;
uniform float uMaxPx;
varying vec2 vUv;
float cocTap(vec2 uv) { return abs(texture2D(tCoc, uv).a * 2.0 - 1.0) * uMaxPx; }
void main() {
  vec4 c0 = texture2D(tBlur, vUv);
  float coc0 = cocTap(vUv);
  // Tap radius grows with local defocus so it actually reaches the noise it
  // needs to average, but stays tiny (and thus a no-op) in sharp regions.
  vec2 rad = clamp(vec2(coc0 * 0.18), 0.5, 3.0) * uHalfTexel;
  vec3 col = c0.rgb;
  float cov = c0.a;
  float wsum = 1.0;
  const int N = 8;
  vec2 offs[8];
  offs[0] = vec2(1.0, 0.0);  offs[1] = vec2(-1.0, 0.0);
  offs[2] = vec2(0.0, 1.0);  offs[3] = vec2(0.0, -1.0);
  offs[4] = vec2(0.7071, 0.7071);   offs[5] = vec2(-0.7071, 0.7071);
  offs[6] = vec2(0.7071, -0.7071);  offs[7] = vec2(-0.7071, -0.7071);
  for (int i = 0; i < N; i++) {
    vec2 uv = vUv + offs[i] * rad;
    float cocN = cocTap(uv);
    float wb = 1.0 - clamp(abs(cocN - coc0) / (max(coc0, cocN) + 2.0), 0.0, 1.0);
    float w = mix(0.25, 1.0, wb);
    vec4 s = texture2D(tBlur, uv);
    col += s.rgb * w;
    cov += s.a * w;
    wsum += w;
  }
  gl_FragColor = vec4(col / wsum, cov / wsum);
}
`;

const compFrag = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBlur;
uniform sampler2D tCocHalf;
uniform vec2 uTexel;
uniform vec2 uHalfTexel;
uniform float uGrain;
uniform float uCa;
uniform float uContrast;
uniform float uTime;
uniform float uDebug;
uniform float uStyle;
uniform float uMemory;
${COC}
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// CoC-aware bilateral upsample of the half-res blur: blends the four nearest
// half-res texels weighted by how closely their own CoC matches the
// full-resolution CoC at this pixel, so a sharp foreground edge doesn't pull
// in blurred background colour (and vice versa) the way plain bilinear does.
vec4 upsampleBlur(vec2 uv, float cocFull) {
  vec2 o[4];
  o[0] = vec2(-0.5, -0.5); o[1] = vec2(0.5, -0.5);
  o[2] = vec2(-0.5, 0.5);  o[3] = vec2(0.5, 0.5);
  vec3 col = vec3(0.0);
  float cov = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 tuv = uv + o[i] * uHalfTexel;
    vec4 b = texture2D(tBlur, tuv);
    float cocHalf = abs(texture2D(tCocHalf, tuv).a * 2.0 - 1.0) * uMaxPx;
    float wb = 1.0 - clamp(abs(cocHalf - cocFull) / (max(cocFull, cocHalf) + 2.0), 0.0, 1.0);
    float w = mix(0.2, 1.0, wb);
    col += b.rgb * w;
    cov += b.a * w;
    wsum += w;
  }
  return vec4(col / max(wsum, 1e-4), cov / max(wsum, 1e-4));
}

// Trial treatments for choosing a look (?style=1..3). 0 is the current photographic one.
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float depthEdge(vec2 uv) {
  float d0 = linearDepth(uv);
  float e = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = (i == 0 ? vec2(1.0, 0.0) : i == 1 ? vec2(-1.0, 0.0) : i == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0)) * uTexel * 1.5;
    e = max(e, abs(linearDepth(uv + o) - d0) / d0);
  }
  return smoothstep(0.02, 0.08, e);
}
vec3 styleSilhouette(vec3 c, vec2 uv) {
  // Inside: colour almost gone, depth read as layers of air, near things go dark
  float d = linearDepth(uv);
  float l = lum(c);
  float layer = smoothstep(10.0, 1200.0, d);
  vec3 air = vec3(0.72, 0.74, 0.73);
  vec3 g = vec3(pow(l, 1.6)) * vec3(0.92, 0.97, 1.0);
  g = mix(g * 0.55, air * (0.6 + 0.4 * l), pow(layer, 0.7));
  return mix(g, c * 0.4, 0.08);
}
vec3 styleEtching(vec3 c, vec2 uv) {
  // an etched plate: paper, ink lines at edges, hatching that thickens into shadow
  float l = lum(c);
  vec2 px = uv / uTexel;
  float h1 = step(0.5, fract((px.x + px.y) / 5.0));
  float h2 = step(0.5, fract((px.x - px.y) / 5.0));
  float h3 = step(0.6, fract(px.y / 3.0));
  float ink = 0.0;
  ink = max(ink, (1.0 - smoothstep(0.45, 0.6, l)) * (1.0 - h1));
  ink = max(ink, (1.0 - smoothstep(0.28, 0.4, l)) * (1.0 - h2));
  ink = max(ink, (1.0 - smoothstep(0.14, 0.24, l)) * (1.0 - h3));
  ink = max(ink, depthEdge(uv) * 0.85);
  float d = linearDepth(uv);
  ink *= 1.0 - 0.7 * smoothstep(300.0, 3000.0, d);
  vec3 paper = vec3(0.9, 0.87, 0.8) * (0.96 + 0.04 * hash(floor(px / 3.0)));
  vec3 inkC = vec3(0.16, 0.14, 0.13);
  return mix(mix(paper, inkC, ink * 0.85), c, 0.1);
}
vec3 stylePolaroid(vec3 c, vec2 uv) {
  // instant film at first light: the frame sits low and damp, shadows sink into a
  // green-teal, the bright sky turns cream, colour is held well back
  float l = lum(c);
  float lt = pow(l, 1.45);
  c *= lt / max(l, 1e-4);
  c = mix(vec3(lum(c)), c, 0.62);
  c = mix(c, c * vec3(0.86, 1.02, 0.96), 1.0 - smoothstep(0.08, 0.5, lt));
  c = mix(c, c * vec3(1.04, 1.02, 0.8) + vec3(0.03, 0.03, 0.0), smoothstep(0.4, 0.9, lt));
  c = c * 0.93 + vec3(0.03, 0.045, 0.04);
  vec2 dv = uv - 0.5;
  c *= 1.0 - 0.45 * pow(dot(dv, dv) * 2.0, 1.25);
  vec2 q = uv * vec2(2.3, 3.1);
  c *= 1.0 + 0.035 * sin(q.x * 2.1 + sin(q.y * 1.7)) * sin(q.y * 1.3 + 0.7);
  return clamp(c, 0.0, 1.0);
}
vec3 stylePlatinum(vec3 c, vec2 uv) {
  // an old platinum print: warm monochrome, long soft tones, the edges falling away
  float l = lum(c);
  l = smoothstep(0.02, 0.98, pow(l, 0.9));
  vec3 tone = mix(vec3(0.12, 0.1, 0.08), vec3(0.93, 0.89, 0.8), l);
  tone = mix(tone, vec3(0.62, 0.55, 0.45), 0.12);
  vec2 dv = uv - 0.5;
  tone *= 1.0 - 0.45 * pow(dot(dv, dv) * 2.2, 1.4);
  return tone;
}
// Looking back from far ahead, the past comes as an old print: the cyan dye has
// gone, blacks lift to a brown, detail softens and the edges burn.
vec3 remembered(vec3 c, vec3 soft, vec2 uv, float m) {
  c = mix(c, soft * vec3(1.0, 0.97, 0.9), 0.55 * m);
  float l = lum(c);
  vec3 aged = mix(vec3(0.24, 0.17, 0.12), vec3(0.95, 0.86, 0.66), smoothstep(0.0, 0.95, l));
  aged = mix(aged, c * vec3(1.12, 0.95, 0.7), 0.25);
  c = mix(c, aged, 0.8 * m);
  vec2 dv = uv - 0.5;
  float edge = smoothstep(0.12, 0.5, dot(dv * vec2(1.0, 0.8), dv * vec2(1.0, 0.8)) * 2.0);
  c = mix(c, c * vec3(0.55, 0.36, 0.22), edge * m * 0.6);
  float g = hash(floor(uv * vec2(260.0, 560.0)) + fract(uTime * 3.1)) - 0.5;
  c += g * 0.09 * m;
  // a faint water stain drifting across the print
  float st = smoothstep(0.35, 0.8, sin(uv.x * 7.0 + sin(uv.y * 5.0) * 1.3) * sin(uv.y * 4.0 + 1.1));
  c = mix(c, c * vec3(0.9, 0.82, 0.68), st * m * 0.35);
  return clamp(c, 0.0, 1.0);
}
void main() {
  float coc = abs(cocAt(vUv));
  vec4 b = upsampleBlur(vUv, coc);
  float t = smoothstep(0.7, 2.8, max(coc, b.a * uMaxPx));
  vec2 dir = vUv - 0.5;
  vec2 off = dir * dot(dir, dir) * uCa * uTexel * 8.0;
  vec3 sharp = vec3(texture2D(tColor, vUv + off).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv - off).b) * aoAt(vUv);
  vec3 blur = vec3(texture2D(tBlur, vUv + off).r, b.g, texture2D(tBlur, vUv - off).b);
  vec3 c = mix(sharp, blur, t);
  // halation: bright parts bleed softly into their surroundings, as on film
  vec3 wide = texture2D(tBlur, vUv).rgb;
  c += max(wide - 0.62, 0.0) * 0.55 * vec3(1.0, 0.93, 0.85);
  c = clamp((c - 0.45) * uContrast + 0.45, 0.0, 1.0);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float g = hash(vUv * 1731.0 + fract(uTime * 7.13)) - 0.5;
  c += g * uGrain * (1.0 - 0.6 * l);
  c *= 1.0 - 0.18 * dot(dir, dir) * 2.0;
  // -- colour grading insertion point: adjust final 'c' below, before debug/output --
  if (uDebug > 1.5) { gl_FragColor = vec4(vec3(texture2D(tAO, vUv).r), 1.0); return; }
  if (uDebug > 0.5) { float k = cocAt(vUv) / uMaxPx; c = vec3(max(-k, 0.0), max(k, 0.0), b.a); }
  if (uStyle > 0.5 && uStyle < 1.5) c = styleSilhouette(c, vUv);
  else if (uStyle > 1.5 && uStyle < 2.5) c = styleEtching(c, vUv);
  else if (uStyle > 2.5 && uStyle < 3.5) c = stylePlatinum(c, vUv);
  else if (uStyle > 3.5) c = stylePolaroid(c, vUv);
  if (uMemory > 0.001) c = remembered(c, blur, vUv, uMemory);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class DofPipeline {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private halfA: THREE.WebGLRenderTarget;
  private halfB: THREE.WebGLRenderTarget;
  private halfC: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private qScene = new THREE.Scene();
  private qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private prep: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private smooth: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  private h = 1;
  private ao: DepthAO;

  constructor() {
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { depthTexture, depthBuffer: true });
    this.ao = new DepthAO(depthTexture);
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.halfA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.halfB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.halfC = new THREE.WebGLRenderTarget(1, 1, opts);
    const cocUniforms = () => ({
      tDepth: { value: depthTexture },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFocus: { value: 10 },
      uCocPx: { value: 10 },
      uTiltPx: { value: 0 },
      uMaxPx: { value: 20 },
      tAO: { value: this.ao.target.texture },
    });
    this.prep = new THREE.ShaderMaterial({
      uniforms: { ...cocUniforms(), tColor: { value: this.sceneRT.texture }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: fsVert, fragmentShader: prepFrag, depthTest: false, depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tHalf: { value: this.halfA.texture }, uHalfTexel: { value: new THREE.Vector2() }, uMaxPx: { value: 20 } },
      vertexShader: fsVert, fragmentShader: blurFrag, depthTest: false, depthWrite: false,
    });
    this.smooth = new THREE.ShaderMaterial({
      uniforms: {
        tBlur: { value: this.halfB.texture },
        tCoc: { value: this.halfA.texture },
        uHalfTexel: { value: new THREE.Vector2() },
        uMaxPx: { value: 20 },
      },
      vertexShader: fsVert, fragmentShader: smoothFrag, depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: {
        ...cocUniforms(),
        tColor: { value: this.sceneRT.texture },
        tBlur: { value: this.halfC.texture },
        tCocHalf: { value: this.halfA.texture },
        uTexel: { value: new THREE.Vector2() },
        uHalfTexel: { value: new THREE.Vector2() },
        uGrain: { value: 0.03 },
        uCa: { value: 0.6 },
        uContrast: { value: 1 },
        uTime: { value: 0 },
        uDebug: { value: new URLSearchParams(location.search).has('aodebug') ? 2 : new URLSearchParams(location.search).has('dofdebug') ? 1 : 0 },
        uMemory: { value: 0 },
        uStyle: { value: parseFloat(new URLSearchParams(location.search).get('style') ?? '4') },
      },
      vertexShader: fsVert, fragmentShader: compFrag, depthTest: false, depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri, this.prep);
    this.quad.frustumCulled = false;
    this.qScene.add(this.quad);
  }

  setSize(w: number, h: number): void {
    this.h = h;
    this.sceneRT.setSize(w, h);
    this.ao.setSize(w, h);
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    this.halfA.setSize(hw, hh);
    this.halfB.setSize(hw, hh);
    this.halfC.setSize(hw, hh);
    (this.prep.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.comp.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.comp.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (this.blur.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (this.smooth.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, p: DofParams): void {
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);
    this.ao.render(renderer, camera, p.aoRadius, p.aoIntensity);

    const maxPx = Math.max(2, p.maxFrac * this.h);
    for (const m of [this.prep, this.comp]) {
      const u = m.uniforms;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uFocus.value = p.focus;
      u.uCocPx.value = p.cocFrac * this.h;
      u.uTiltPx.value = p.tilt * this.h;
      u.uMaxPx.value = maxPx;
    }
    this.blur.uniforms.uMaxPx.value = maxPx;
    this.smooth.uniforms.uMaxPx.value = maxPx;
    this.comp.uniforms.uGrain.value = p.grain;
    this.comp.uniforms.uCa.value = p.ca;
    this.comp.uniforms.uContrast.value = p.contrast;
    this.comp.uniforms.uMemory.value = p.memory;
    this.comp.uniforms.uTime.value = p.time;

    this.quad.material = this.prep;
    renderer.setRenderTarget(this.halfA);
    renderer.render(this.qScene, this.qCam);
    this.quad.material = this.blur;
    renderer.setRenderTarget(this.halfB);
    renderer.render(this.qScene, this.qCam);
    this.quad.material = this.smooth;
    renderer.setRenderTarget(this.halfC);
    renderer.render(this.qScene, this.qCam);
    this.quad.material = this.comp;
    renderer.setRenderTarget(null);
    renderer.render(this.qScene, this.qCam);
  }
}
