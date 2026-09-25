// Ambient occlusion from the depth buffer alone. The world is displaced in vertex
// shaders (terrain, instanced trees, crowds), so a normal pre-pass with an override
// material would be wrong; depth is the one buffer every material writes truthfully.
// Under an overcast sky this is most of the shading there is: the dark where a wall
// meets the grass, under a hedge, between two houses.
import * as THREE from 'three';

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const aoFrag = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uProjScale;
uniform float uIntensity;
varying vec2 vUv;
const int N = 12;
vec3 viewPos(vec2 uv) {
  float z = texture2D(tDepth, uv).r;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
void main() {
  float z0 = texture2D(tDepth, vUv).r;
  if (z0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 p = viewPos(vUv);
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  // interleaved gradient noise turns the spiral per pixel; the blur pass removes it
  float rot = 6.2831 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float rPx = clamp(uRadius * uProjScale / -p.z, 1.5, 48.0);
  float occ = 0.0;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) / float(N);
    float a = t * 23.0 + rot;
    vec2 off = vec2(cos(a), sin(a)) * rPx * t;
    vec3 s = viewPos(vUv + off * uTexel);
    vec3 v = s - p;
    float vv = dot(v, v);
    float vn = dot(v, n);
    float fall = max(0.0, 1.0 - vv / (uRadius * uRadius));
    occ += max(0.0, vn - 0.005 * -p.z) / (vv + 0.01 * uRadius * uRadius) * fall;
  }
  occ = occ * uRadius * 2.0 / float(N);
  float ao = clamp(1.0 - uIntensity * occ, 0.0, 1.0);
  gl_FragColor = vec4(ao, 0.0, 0.0, 1.0);
}
`;

// Depth-aware blur: smooths the noise without bleeding the dark across a silhouette.
const blurFrag = /* glsl */ `
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uTexel;
varying vec2 vUv;
float viewZ(vec2 uv) {
  float z = texture2D(tDepth, uv).r;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return p.z / p.w;
}
void main() {
  float z0 = viewZ(vUv);
  float sum = 0.0, wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
      float dz = abs(viewZ(uv) - z0) / max(-z0, 0.1);
      float w = exp(-dz * 40.0);
      sum += texture2D(tAO, uv).r * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}
`;

export class DepthAO {
  private raw: THREE.WebGLRenderTarget;
  readonly target: THREE.WebGLRenderTarget;
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(depth: THREE.DepthTexture) {
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.raw = new THREE.WebGLRenderTarget(1, 1, opts);
    this.target = new THREE.WebGLRenderTarget(1, 1, opts);
    const common = { tDepth: { value: depth }, uInvProj: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() } };
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: { ...common, uRadius: { value: 1 }, uProjScale: { value: 500 }, uIntensity: { value: 1 } },
      vertexShader: vert, fragmentShader: aoFrag, depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { ...common, tAO: { value: this.raw.texture } },
      vertexShader: vert, fragmentShader: blurFrag, depthTest: false, depthWrite: false,
    });
    // both passes share the same matrix and texel objects
    this.blurMat.uniforms.uInvProj = this.aoMat.uniforms.uInvProj;
    this.blurMat.uniforms.uTexel = this.aoMat.uniforms.uTexel;
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri, this.aoMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(w: number, h: number): void {
    // half resolution: the occlusion is soft by nature and the blur hides the step
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    this.raw.setSize(hw, hh);
    this.target.setSize(hw, hh);
    (this.aoMat.uniforms.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, radius: number, intensity: number): void {
    const u = this.aoMat.uniforms;
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    // pixels per metre at unit distance, in the half-res target
    u.uProjScale.value = (this.raw.height * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    u.uRadius.value = radius;
    u.uIntensity.value = intensity;
    this.quad.material = this.aoMat;
    renderer.setRenderTarget(this.raw);
    renderer.render(this.scene, this.cam);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.cam);
  }
}
