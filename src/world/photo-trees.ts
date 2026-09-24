// Trees drawn from photographs laid onto a tree-shaped hull: the side photo is cast
// onto it from the eye's side, the photo from above onto its upward faces. The hull
// gives true volume (no cut-out lying flat), the photos give outline and leaves.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';
import { CROWN_ATTR, CROWN_COLOR } from './tree-glsl';

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
${CROWN_ATTR}
${CROWN_COLOR}
attribute float aPart;   // 0 crown hull, 1 trunk
attribute float aDir;    // hedge line angle (radians); 0 for non-hedge instances
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vRoot;
varying vec2 vWH;
varying vec3 vMeta;
varying float vDir;
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
  float H = aPos.z * treeGrow() * (hedge ? 0.55 : 1.05);
  float W = H * (conifer ? 0.5 : hedge ? 1.3 : 0.95);
  vec3 p = position;
  vec3 n = normal;
  // hedges are aligned along their planted line, not spun by seed, so
  // neighbouring bushes form one continuous ridge rather than random blobs
  float a = hedge ? aDir : seed * 6.2831;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  if (aPart < 0.5) {
    // the hull a little larger than the photographed tree, so the photo's own
    // outline, not the hull, is what the eye sees; hedges get an elongated
    // hull (long axis along the line) that overlaps its neighbours so the
    // row reads as one hedge with no gaps between bushes
    vec3 r = conifer ? vec3(W * 0.55, H * 0.46, W * 0.55) : hedge ? vec3(W * 0.7, H * 0.55, W * 0.32) : vec3(W * 0.56, H * 0.4, W * 0.56);
    float cy = conifer ? H * 0.54 : hedge ? H * 0.46 : H * 0.6;
    p = p * r + vec3(0.0, cy, 0.0);
    n = normalize(n / r);
  } else {
    if (hedge) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    p = vec3(p.x * W * 0.07, (p.y + 0.5) * H * 0.55 - 0.2, p.z * W * 0.07);
  }
  p.xz = rot * p.xz;
  n.xz = rot * n.xz;
  vec3 w = root + p;
  vWorld = w;
  vN = n;
  vRoot = root;
  vWH = vec2(W, H);
  vMeta = aMeta;
  vDir = aDir;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
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
uniform sampler2D uHedgeTop;
uniform vec4 uRectSD[4];
uniform vec4 uRectSC[4];
uniform vec4 uRectTD[4];
uniform vec4 uRectTC[4];
uniform vec4 uRectHS;
uniform vec4 uRectHT;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vRoot;
varying vec2 vWH;
varying vec3 vMeta;
varying float vDir;
vec4 cellRect(vec4 rs[4], int i) { return i == 0 ? rs[0] : i == 1 ? rs[1] : i == 2 ? rs[2] : rs[3]; }
void main() {
  float kind = vMeta.x, seed = vMeta.y;
  bool conifer = kind > 0.5 && kind < 1.5;
  bool hedge = kind > 2.5;
  int cell = int(floor(fract(seed * 7.77) * 3.999));
  vec3 n = normalize(vN);
  vec3 d = vWorld - vRoot;
  // side photo projected from the eye's side, top photo projected from above;
  // the surface's own facing decides which one this point shows
  vec3 camR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + 1e-5);
  float a = seed * 6.2831;
  vec2 su;
  vec2 tq;
  float along = 0.0, across = 0.0;
  if (hedge) {
    // world-space position along the hedge's own line, not the bush's own
    // root, so the texture continues seamlessly from bush to bush
    vec2 dirVec = vec2(cos(vDir), sin(vDir));
    vec2 perpVec = vec2(-dirVec.y, dirVec.x);
    along = dot(vWorld.xz, dirVec);
    across = dot(d.xz, perpVec);
    su = vec2(fract(along / 2.0), d.y / vWH.y);
    tq = vec2(fract(along / 2.2), clamp(across / (vWH.x * 0.64) + 0.5, 0.0, 1.0));
  } else {
    su = vec2(dot(d, camR) / vWH.x + 0.5, d.y / vWH.y);
    tq = mat2(cos(a), -sin(a), sin(a), cos(a)) * d.xz / (vWH.x * 1.05) + 0.5;
  }
  float wTop = hedge ? smoothstep(0.3, 0.7, n.y) : smoothstep(0.25, 0.75, n.y);
  bool useTop = hash12(gl_FragCoord.xy + seed * 37.0) < wTop;
  vec4 r;
  vec2 uv;
  vec4 t;
  if (useTop) {
    uv = tq;
    r = hedge ? uRectHT : conifer ? cellRect(uRectTC, cell) : cellRect(uRectTD, cell);
    vec2 u2 = mix(r.xy, r.zw, clamp(uv, 0.0, 1.0));
    t = hedge ? texture2D(uHedgeTop, u2) : conifer ? texture2D(uTopC, u2) : texture2D(uTopD, u2);
  } else {
    uv = su;
    r = hedge ? uRectHS : conifer ? cellRect(uRectSC, cell) : cellRect(uRectSD, cell);
    vec2 u2 = mix(r.xy, r.zw, clamp(uv, 0.0, 1.0));
    t = hedge ? texture2D(uHedge, u2) : conifer ? texture2D(uSideC, u2) : texture2D(uSideD, u2);
  }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || t.a < 0.5) discard;
  float bare = bareness(kind);
  if (bare > 0.01 && vnoise(uv * 60.0 + seed * 13.0) < bare * 0.7) discard;
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 lin = pow(t.rgb, vec3(2.2));
  vec3 spring = conifer ? vec3(0.11, 0.16, 0.11) : vec3(0.3, 0.38, 0.17);
  vec3 tint = crownColor(kind, seed) / (spring * (0.85 + 0.3 * seed));
  vec3 col = lin * mix(vec3(1.0), tint, 0.85);
  col = mix(col, vec3(0.2, 0.17, 0.14) * (0.6 + dot(lin, vec3(1.0))), bare * 0.7);
  col = mix(col, vec3(0.85, 0.87, 0.9), snowCover() * smoothstep(0.3, 0.8, n.y) * 0.6);
  if (!gl_FrontFacing) n = -n;
  float sh = sampleShadow(vWorld, n);
  // the photo holds its own modelling; the hull adds the day's direction of light
  vec3 lightC = uSkyAmb * (0.75 + 0.35 * n.y) + uSunColor * sh * (0.15 + 0.55 * max(dot(n, uSunDir), 0.0));
  gl_FragColor = finalOut(applyFog(col * lightC * 1.6, vWorld));
}
`;

export interface SpriteRects {
  canopy_deciduous_sheet: number[][];
  canopy_conifer_sheet: number[][];
  tree_side_deciduous_sheet: number[][];
  tree_side_conifer_sheet: number[][];
  hedge_side: number[][];
  hedge_topdown: number[][];
}

export class PhotoTrees {
  readonly mesh: THREE.Mesh;
  readonly depth: THREE.ShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(attrs: { aPos: THREE.InstancedBufferAttribute; aLife: THREE.InstancedBufferAttribute; aMeta: THREE.InstancedBufferAttribute; aDir: THREE.InstancedBufferAttribute }, treeUniforms: Record<string, THREE.IUniform>) {
    const hull = new THREE.SphereGeometry(1, 9, 7);
    const trunk = new THREE.CylinderGeometry(1, 1.3, 1, 5, 1, true);
    const g = new THREE.InstancedBufferGeometry();
    const pos: number[] = [], nor: number[] = [], part: number[] = [], idx: number[] = [];
    for (const [geo, tag] of [[hull, 0], [trunk, 1]] as const) {
      const off = pos.length / 3;
      const pa = geo.getAttribute('position'), na = geo.getAttribute('normal');
      for (let i = 0; i < pa.count; i++) {
        pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
        nor.push(na.getX(i), na.getY(i), na.getZ(i));
        part.push(tag);
      }
      const ia = geo.getIndex()!;
      for (let i = 0; i < ia.count; i++) idx.push(ia.getX(i) + off);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
    g.setIndex(idx);
    g.setAttribute('aPos', attrs.aPos);
    g.setAttribute('aLife', attrs.aLife);
    g.setAttribute('aMeta', attrs.aMeta);
    g.setAttribute('aDir', attrs.aDir);
    const v4 = () => Array.from({ length: 4 }, () => new THREE.Vector4());
    this.uniforms = {
      ...shared,
      ...treeUniforms,
      uRectSD: { value: v4() }, uRectSC: { value: v4() }, uRectTD: { value: v4() }, uRectTC: { value: v4() },
      uRectHS: { value: new THREE.Vector4(0, 0.3, 1, 0.7) },
      uRectHT: { value: new THREE.Vector4(0, 0.35, 1, 0.6) },
      uSideD: { value: null }, uSideC: { value: null }, uTopD: { value: null }, uTopC: { value: null }, uHedge: { value: null }, uHedgeTop: { value: null },
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
    (this.uniforms.uRectHT.value as THREE.Vector4).fromArray(r.hedge_topdown[0]);
    const loader = new THREE.TextureLoader();
    const tex = async (f: string) => {
      const t = await loader.loadAsync(`${base}${f}.webp`);
      t.anisotropy = 4;
      return t;
    };
    const [sd, sc, td, tc, hs, ht] = await Promise.all([
      tex('tree_side_deciduous_sheet'), tex('tree_side_conifer_sheet'), tex('canopy_deciduous_sheet'), tex('canopy_conifer_sheet'), tex('hedge_side'), tex('hedge_topdown'),
    ]);
    this.uniforms.uSideD.value = sd;
    this.uniforms.uSideC.value = sc;
    this.uniforms.uTopD.value = td;
    this.uniforms.uTopC.value = tc;
    this.uniforms.uHedge.value = hs;
    this.uniforms.uHedgeTop.value = ht;
    this.mesh.visible = true;
  }
}
