// Generic matte "painted block" material for small props, poles and figures.
import * as THREE from 'three';
import { shared } from './shared';
import { COMMON } from './glsl';

const vert = /* glsl */ `
${COMMON}
#ifdef HAS_VIS
attribute vec2 aVis;
#endif
attribute vec3 color;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vCol;
void main() {
#ifdef HAS_VIS
  // aVis.y may be very large (deep time); compare in the year domain directly.
  if (uYear < aVis.x || uYear >= aVis.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  vec4 w = vec4(position, 1.0);
#ifdef USE_INSTANCING
  w = instanceMatrix * w;
  vNormal = mat3(instanceMatrix) * normal;
#else
  vNormal = normal;
#endif
  w = modelMatrix * w;
  vNormal = normalize(mat3(modelMatrix) * vNormal);
  vCol = vec3(1.0);
#ifdef HAS_COLOR
  vCol = color;
#endif
#ifdef USE_INSTANCING_COLOR
  vCol *= instanceColor;
#endif
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
${COMMON}
uniform vec3 uColor;
uniform float uWrap;
uniform float uNoise;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vCol;
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
  return;
#endif
  vec3 n = normalize(vNormal);
  vec3 col = uColor * vCol * (1.0 - uNoise + uNoise * 2.0 * vnoise(vWorld.xz * 5.0 + vWorld.y * 3.0));
  float sh = sampleShadow(vWorld, n);
  vec3 c = shade(col, n, vWorld, uWrap, sh);
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

export interface PaintedOpts {
  color?: THREE.ColorRepresentation;
  wrap?: number;
  noise?: number;
  vis?: boolean;
  vertexColors?: boolean;
  side?: THREE.Side;
}

export function paintedMaterials(o: PaintedOpts = {}): { main: THREE.ShaderMaterial; depth: THREE.ShaderMaterial } {
  const uniforms = {
    ...shared,
    uColor: { value: new THREE.Color(o.color ?? 0xffffff) },
    uWrap: { value: o.wrap ?? 0.2 },
    uNoise: { value: o.noise ?? 0.1 },
  };
  const defines: Record<string, number> = {};
  if (o.vis) defines.HAS_VIS = 1;
  if (o.vertexColors) defines.HAS_COLOR = 1;
  const base = { uniforms, vertexShader: vert, fragmentShader: frag, side: o.side ?? THREE.FrontSide };
  return {
    main: new THREE.ShaderMaterial({ ...base, defines: { ...defines } }),
    depth: new THREE.ShaderMaterial({ ...base, defines: { ...defines, DEPTH_PASS: 1 } }),
  };
}
