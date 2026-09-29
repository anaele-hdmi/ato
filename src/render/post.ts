// Post-processing pipeline: finishes the raw CG render into something that
// reads as a remembered photograph rather than an engine screenshot (see
// docs/art-direction.md — quiet, filmic, art of rally / Slow Roads calm).
//
// Stack: RenderPass -> UnrealBloomPass (mobile-cheap, half-res, high
// threshold so only the Sun / sunlit limb / ocean glint bloom) -> one custom
// ShaderPass (grade + vignette + fine animated grain) -> OutputPass (sRGB +
// tone mapping handling, so colour management matches the non-post render).
//
// `?post=0` in the page URL, or opts.enabled === false, drops bloom + grade
// but keeps the MSAA render target and OutputPass (fair A/B).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface PostPipeline {
  render(): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

function urlWantsPostDisabled(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('post') === '0';
  } catch {
    return false;
  }
}

// Grade + vignette + grain, combined into a single pass to keep the mobile
// fragment-shader budget to one extra full-res sample of the scene.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    // Lift shadows slightly toward deep blue; near-black space stays black
    // because the lift is weighted by luminance (see uShadowLift in the shader).
    uShadowTint: { value: new THREE.Color(0x1b2a44) },
    uShadowLift: { value: 0.05 },
    // Gentle warm roll-off on highlights instead of hard clipping.
    uHighlightTint: { value: new THREE.Color(0xffe9cf) },
    uHighlightAmount: { value: 0.06 },
    uVignetteStrength: { value: 0.28 },
    uVignetteRadius: { value: 0.72 },
    uVignetteSoftness: { value: 0.62 },
    uGrainAmount: { value: 0.004 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform vec3 uShadowTint;
    uniform float uShadowLift;
    uniform vec3 uHighlightTint;
    uniform float uHighlightAmount;
    uniform float uVignetteStrength;
    uniform float uVignetteRadius;
    uniform float uVignetteSoftness;
    uniform float uGrainAmount;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    // Cheap hash, animated per-frame so grain reads as film rather than a
    // static dither pattern.
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float l = luma(color);

      // Shadow lift: only nudges midtones/near-blacks that still have some
      // signal, so true space stays essentially unlit. Weighted down near 0
      // luminance with a smoothstep floor so the void does not wash out.
      float liftMask = smoothstep(0.0, 0.22, l) * (1.0 - smoothstep(0.35, 0.7, l));
      color = mix(color, mix(color, uShadowTint, 0.5), uShadowLift * liftMask);

      // Highlight roll-off: soft warm compression above ~0.75 luma, keeps the
      // Sun/limb from reading as a flat clipped disc.
      float hiMask = smoothstep(0.72, 1.15, l);
      color = mix(color, mix(color, uHighlightTint, 0.5), uHighlightAmount * hiMask);

      // Vignette, soft and centred; never fully darkens (keeps space's true
      // black from turning into a grey ring).
      vec2 centered = vUv - 0.5;
      centered.x *= uResolution.x / uResolution.y;
      float dist = length(centered);
      float vig = 1.0 - uVignetteStrength * smoothstep(uVignetteRadius - uVignetteSoftness, uVignetteRadius, dist);
      color *= vig;

      // Fine animated grain, luminance-weighted so black space stays quiet
      // and only lit surfaces (Earth, station, Sun) pick up texture.
      float n = hash(vUv * uResolution.xy + uTime * 97.0) - 0.5;
      float grainMask = smoothstep(0.0, 0.12, l);
      color += n * uGrainAmount * grainMask;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts?: { enabled?: boolean },
): PostPipeline {
  // ?post=0 skips bloom + grade but still renders through the SAME MSAA
  // target and OutputPass, so A/B comparisons differ only by the effects.
  const fx = (opts?.enabled ?? true) && !urlWantsPostDisabled();

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const pixelRatio = renderer.getPixelRatio();

  // MSAA: the composer renders the scene into its own target, so the
  // canvas's `antialias: true` no longer applies — without this, facet edges
  // and the station's thin trusses alias badly. 4x on WebGL2 (tile-based
  // mobile GPUs resolve it cheaply).
  const msaaTarget = new THREE.WebGLRenderTarget(Math.max(1, size.x * pixelRatio), Math.max(1, size.y * pixelRatio), {
    // 8-bit sRGB storage (hardware encode/decode, so darks keep precision):
    // half the bandwidth of HalfFloat. Values > 1 (Sun sprite, glint) clip
    // to 1, which still exceeds the 0.95 bloom threshold.
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, msaaTarget);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Quarter-resolution bloom keeps this mobile-affordable (see setSize override below).
  const BLOOM_SCALE = 0.25; // quarter-resolution bloom (5 mips below that)
  const bloomResolution = new THREE.Vector2(
    Math.max(1, Math.round(size.x * pixelRatio * BLOOM_SCALE)),
    Math.max(1, Math.round(size.y * pixelRatio * BLOOM_SCALE)),
  );
  const bloomPass = new UnrealBloomPass(bloomResolution, 0.35, 0.4, 0.95);
  // UnrealBloomPass halves whatever size it is given; halve once more so the
  // whole blur chain runs at 1/4 of the frame resolution.
  const bloomSetSize = bloomPass.setSize.bind(bloomPass);
  bloomPass.setSize = (w: number, h: number) => bloomSetSize(w * 0.5, h * 0.5);
  // strength 0.35: subtle — a soft glow on the Sun/limb, not a glaze over the
  //   whole frame.
  // radius 0.4: small, keeps the halo tight instead of a diffuse wash.
  // threshold 0.95: high — only the Sun sprite, the sunlit limb highlight and
  //   ocean glint (all near-1.0 luma) trigger it; the flat-shaded/toon Earth
  //   and station stay untouched so the "posterized" look from
  //   docs/art-direction.md survives.
  const gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uResolution.value.set(size.x * pixelRatio, size.y * pixelRatio);
  if (fx) {
    composer.addPass(bloomPass);
    composer.addPass(gradePass);
  }

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const clock = new THREE.Clock();

  function render(): void {
    gradePass.uniforms.uTime.value = clock.getElapsedTime();
    composer.render();
  }

  function resize(width: number, height: number, pr: number): void {
    composer.setPixelRatio(pr);
    composer.setSize(width, height);
    bloomPass.resolution.set(Math.max(1, Math.round(width * pr * BLOOM_SCALE)), Math.max(1, Math.round(height * pr * BLOOM_SCALE)));
    gradePass.uniforms.uResolution.value.set(width * pr, height * pr);
  }

  function dispose(): void {
    composer.dispose();
  }

  return { render, resize, dispose };
}
