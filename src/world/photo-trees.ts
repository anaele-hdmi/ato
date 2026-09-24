// Trees drawn from photographs: an upright cut-out that turns to the eye, and a
// crown seen from above lying at crown height. Which one shows depends on how
// steeply the eye looks down; the change is dithered so nothing needs sorting.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';
import { CROWN_ATTR, CROWN_COLOR } from './tree-glsl';

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${CROWN_ATTR}
${CROWN_COLOR}
uniform vec4 uRectSD[4];
uniform vec4 uRectSC[4];
uniform vec4 uRectTD[4];
uniform vec4 uRectTC[4];
uniform vec4 uRectHS;
attribute vec2 aCorner;
attribute float aQuad;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vN;
varying float vW;
varying vec3 vMeta;
varying float vSide;
void main() {
  vec2 xz = aPos.xy;
  float gy = terrainHeight(xz);
  vec3 root = vec3(xz.x, gy, xz.y);
  if (treeHidden(gy) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#ifndef DEPTH_PASS
  if (distance(root, cameraPosition) > uLodDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  float kind = aMeta.x, seed = aMeta.y;
  bool conifer = kind > 0.5 && kind < 1.5;
  bool hedge = kind > 2.5;
  int cell = int(floor(fract(seed * 7.77) * 3.999));
  float H = aPos.z * treeGrow() * (hedge ? 0.55 : 1.05);
  vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 toCam = normalize(cameraPosition - (root + vec3(0.0, H * 0.5, 0.0)));
  // 0 when seen from the side, 1 when seen from straight above
  float topness = hedge ? 0.0 : smoothstep(0.3, 0.55, toCam.y);
  vec3 p;
  vec4 r;
  if (aQuad < 0.5) {
    r = hedge ? vec4(fract(seed * 3.1) * 0.7, uRectHS.y, fract(seed * 3.1) * 0.7 + 0.3, uRectHS.w)
              : (conifer ? uRectSC[cell] : uRectSD[cell]);
    float aspect = (r.z - r.x) / max(r.w - r.y, 1e-3);
    float W = H * aspect * (hedge ? 1.4 : 1.0);
    // hedges are low and seen from above too: let them lean back toward the eye
    // stand the cut-out upright on the picture as the eye rises, so it never lies flat
    vec3 camUp = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
    vec3 upv = normalize(mix(vec3(0.0, 1.0, 0.0), camUp, smoothstep(0.05, 0.45, toCam.y)));
    p = root + camRight * (aCorner.x * 0.5 * W) + upv * ((aCorner.y * 0.5 + 0.5) * H - 0.15);
    vN = normalize(toCam * vec3(1.0, 0.0, 1.0) + vec3(0.0, 0.6, 0.0));
    vW = 1.0 - topness;
    vSide = 1.0;
  } else {
    if (hedge) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    r = conifer ? uRectTC[cell] : uRectTD[cell];
    float R = H * (conifer ? 0.28 : 0.42);
    float a = seed * 6.2831;
    vec2 c = mat2(cos(a), -sin(a), sin(a), cos(a)) * aCorner * R;
    p = root + vec3(c.x, H * (conifer ? 0.62 : 0.7), c.y);
    vN = vec3(0.0, 1.0, 0.0);
    vW = topness;
    vSide = 0.0;
  }
  vUv = mix(r.xy, r.zw, aCorner * 0.5 + 0.5);
  vWorld = p;
  vMeta = aMeta;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const frag = /* glsl */ `
${COMMON}
${CROWN_COLOR}
uniform sampler2D uSideD;
uniform sampler2D uSideC;
uniform sampler2D uTopD;
uniform sampler2D uTopC;
uniform sampler2D uHedge;
uniform vec3 uMeanD;
uniform vec3 uMeanH;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vN;
varying float vW;
varying vec3 vMeta;
varying float vSide;
void main() {
  float kind = vMeta.x, seed = vMeta.y;
  bool conifer = kind > 0.5 && kind < 1.5;
  bool hedge = kind > 2.5;
  vec4 t = hedge ? texture2D(uHedge, vUv)
         : vSide > 0.5 ? (conifer ? texture2D(uSideC, vUv) : texture2D(uSideD, vUv))
                       : (conifer ? texture2D(uTopC, vUv) : texture2D(uTopD, vUv));
  if (t.a < 0.5) discard;
  // cross-fade between the two views by screen-door so no sorting is needed
  if (hash12(gl_FragCoord.xy + seed * 91.0) > vW) discard;
  float bare = bareness(kind);
  if (bare > 0.01 && vnoise(vUv * 60.0 + seed * 13.0) < bare * 0.7) discard;
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 lin = pow(t.rgb, vec3(2.2));
  // the photo was taken in spring; the scene's season and age decide the colour
  vec3 spring = conifer ? vec3(0.11, 0.16, 0.11) : vec3(0.3, 0.38, 0.17);
  vec3 tint = crownColor(kind, seed) / (spring * (0.85 + 0.3 * seed));
  vec3 col = lin * mix(vec3(1.0), tint, 0.85);
  col = mix(col, vec3(0.2, 0.17, 0.14) * (0.6 + dot(lin, vec3(1.0))), bare * 0.7);
  col = mix(col, vec3(0.85, 0.87, 0.9), snowCover() * 0.5 * (1.0 - vSide * 0.6));
  float sh = sampleShadow(vWorld, vN);
  // the photo already holds its own shading; add only the day's light and shadow
  vec3 lightC = uSkyAmb * 1.05 + uSunColor * sh * (0.25 + 0.45 * max(dot(vN, uSunDir), 0.0));
  gl_FragColor = finalOut(applyFog(col * lightC * 1.6, vWorld));
}
`;

export interface SpriteRects {
  canopy_deciduous_sheet: number[][];
  canopy_conifer_sheet: number[][];
  tree_side_deciduous_sheet: number[][];
  tree_side_conifer_sheet: number[][];
  hedge_side: number[][];
}

export class PhotoTrees {
  readonly mesh: THREE.Mesh;
  readonly depth: THREE.ShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(attrs: { aPos: THREE.InstancedBufferAttribute; aLife: THREE.InstancedBufferAttribute; aMeta: THREE.InstancedBufferAttribute }, treeUniforms: Record<string, THREE.IUniform>) {
    const g = new THREE.InstancedBufferGeometry();
    const corner: number[] = [], quad: number[] = [], idx: number[] = [];
    for (let q = 0; q < 2; q++) {
      const o = q * 4;
      corner.push(-1, -1, 1, -1, 1, 1, -1, 1);
      quad.push(q, q, q, q);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(8 * 3).fill(0), 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
    g.setAttribute('aQuad', new THREE.Float32BufferAttribute(quad, 1));
    g.setIndex(idx);
    g.setAttribute('aPos', attrs.aPos);
    g.setAttribute('aLife', attrs.aLife);
    g.setAttribute('aMeta', attrs.aMeta);
    const v4 = () => Array.from({ length: 4 }, () => new THREE.Vector4());
    this.uniforms = {
      ...shared,
      ...treeUniforms,
      uRectSD: { value: v4() }, uRectSC: { value: v4() }, uRectTD: { value: v4() }, uRectTC: { value: v4() },
      uRectHS: { value: new THREE.Vector4(0, 0.3, 1, 0.7) },
      uSideD: { value: null }, uSideC: { value: null }, uTopD: { value: null }, uTopC: { value: null }, uHedge: { value: null },
      uMeanD: { value: new THREE.Vector3(0.1, 0.15, 0.03) }, uMeanH: { value: new THREE.Vector3(0.1, 0.1, 0.04) },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
    this.depth = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide, defines: { DEPTH_PASS: 1 } });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get geometry(): THREE.InstancedBufferGeometry {
    return this.mesh.geometry as THREE.InstancedBufferGeometry;
  }

  async load(): Promise<void> {
    const base = './tex/';
    const credits = await (await fetch(`${base}credits.json`)).json() as { spriteRects: SpriteRects };
    const r = credits.spriteRects;
    const set = (key: string, rects: number[][]) => (this.uniforms[key].value as THREE.Vector4[]).forEach((v, i) => v.fromArray(rects[i]));
    set('uRectSD', r.tree_side_deciduous_sheet);
    set('uRectSC', r.tree_side_conifer_sheet);
    set('uRectTD', r.canopy_deciduous_sheet);
    set('uRectTC', r.canopy_conifer_sheet);
    (this.uniforms.uRectHS.value as THREE.Vector4).fromArray(r.hedge_side[0]);
    const loader = new THREE.TextureLoader();
    const tex = async (f: string) => {
      const t = await loader.loadAsync(`${base}${f}.webp`);
      t.anisotropy = 4;
      return t;
    };
    const [sd, sc, td, tc, hs] = await Promise.all([
      tex('tree_side_deciduous_sheet'), tex('tree_side_conifer_sheet'), tex('canopy_deciduous_sheet'), tex('canopy_conifer_sheet'), tex('hedge_side'),
    ]);
    this.uniforms.uSideD.value = sd;
    this.uniforms.uSideC.value = sc;
    this.uniforms.uTopD.value = td;
    this.uniforms.uTopC.value = tc;
    this.uniforms.uHedge.value = hs;
    this.mesh.visible = true;
  }
}
