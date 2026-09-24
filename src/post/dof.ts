// Depth of field (scatter-as-gather at half resolution), then a single composite
// that adds faint grain and chromatic aberration.
import * as THREE from 'three';

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
  gl_FragColor = vec4(c * 0.25, 0.5 + 0.5 * coc / uMaxPx);
}
`;

const blurFrag = /* glsl */ `
uniform sampler2D tHalf;
uniform vec2 uHalfTexel;
uniform float uMaxPx;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c0 = texture2D(tHalf, vUv);
  float cc = (c0.a * 2.0 - 1.0) * uMaxPx;
  vec3 acc = c0.rgb;
  float wsum = 1.0;
  float nearCov = 0.0;
  float rot = hash(gl_FragCoord.xy) * 6.2831;
  float maxR = uMaxPx * 0.5;
  const int N = 36;
  for (int i = 0; i < N; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(N)) * maxR;
    float a = fi * 2.39996 + rot;
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

const compFrag = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBlur;
uniform vec2 uTexel;
uniform float uGrain;
uniform float uCa;
uniform float uContrast;
uniform float uTime;
uniform float uDebug;
${COC}
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float coc = abs(cocAt(vUv));
  vec4 b = texture2D(tBlur, vUv);
  float t = smoothstep(0.7, 2.8, max(coc, b.a * uMaxPx));
  vec2 dir = vUv - 0.5;
  vec2 off = dir * dot(dir, dir) * uCa * uTexel * 8.0;
  vec3 sharp = vec3(texture2D(tColor, vUv + off).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv - off).b);
  vec3 blur = vec3(texture2D(tBlur, vUv + off).r, b.g, texture2D(tBlur, vUv - off).b);
  vec3 c = mix(sharp, blur, t);
  c = clamp((c - 0.45) * uContrast + 0.45, 0.0, 1.0);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float g = hash(vUv * 1731.0 + fract(uTime * 7.13)) - 0.5;
  c += g * uGrain * (1.0 - 0.6 * l);
  c *= 1.0 - 0.18 * dot(dir, dir) * 2.0;
  if (uDebug > 0.5) { float k = cocAt(vUv) / uMaxPx; c = vec3(max(-k, 0.0), max(k, 0.0), b.a); }
  gl_FragColor = vec4(c, 1.0);
}
`;

export class DofPipeline {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private halfA: THREE.WebGLRenderTarget;
  private halfB: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private qScene = new THREE.Scene();
  private qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private prep: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  private h = 1;

  constructor() {
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { depthTexture, depthBuffer: true });
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.halfA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.halfB = new THREE.WebGLRenderTarget(1, 1, opts);
    const cocUniforms = () => ({
      tDepth: { value: depthTexture },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFocus: { value: 10 },
      uCocPx: { value: 10 },
      uTiltPx: { value: 0 },
      uMaxPx: { value: 20 },
    });
    this.prep = new THREE.ShaderMaterial({
      uniforms: { ...cocUniforms(), tColor: { value: this.sceneRT.texture }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: fsVert, fragmentShader: prepFrag, depthTest: false, depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tHalf: { value: this.halfA.texture }, uHalfTexel: { value: new THREE.Vector2() }, uMaxPx: { value: 20 } },
      vertexShader: fsVert, fragmentShader: blurFrag, depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: {
        ...cocUniforms(),
        tColor: { value: this.sceneRT.texture },
        tBlur: { value: this.halfB.texture },
        uTexel: { value: new THREE.Vector2() },
        uGrain: { value: 0.03 },
        uCa: { value: 0.6 },
        uContrast: { value: 1 },
        uTime: { value: 0 },
        uDebug: { value: new URLSearchParams(location.search).has('dofdebug') ? 1 : 0 },
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
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    this.halfA.setSize(hw, hh);
    this.halfB.setSize(hw, hh);
    (this.prep.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.comp.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (this.blur.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, p: DofParams): void {
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

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
    this.comp.uniforms.uGrain.value = p.grain;
    this.comp.uniforms.uCa.value = p.ca;
    this.comp.uniforms.uContrast.value = p.contrast;
    this.comp.uniforms.uTime.value = p.time;

    this.quad.material = this.prep;
    renderer.setRenderTarget(this.halfA);
    renderer.render(this.qScene, this.qCam);
    this.quad.material = this.blur;
    renderer.setRenderTarget(this.halfB);
    renderer.render(this.qScene, this.qCam);
    this.quad.material = this.comp;
    renderer.setRenderTarget(null);
    renderer.render(this.qScene, this.qCam);
  }
}
