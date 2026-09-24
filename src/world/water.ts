// The sea. Far to the south for most of the time; in deep time it comes inland.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';

const vert = /* glsl */ `
${COMMON}
uniform float uSeaLevel;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  w.y = uSeaLevel;
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
${COMMON}
${TERRAIN_FN}
varying vec3 vWorld;
void main() {
  float ground = terrainHeight(vWorld.xz);
  float depth = uSeaLevel - ground;
  if (depth < 0.0) discard;
  vec3 shallow = vec3(0.3, 0.42, 0.4);
  vec3 deep = vec3(0.05, 0.1, 0.13);
  vec3 col = mix(shallow, deep, 1.0 - exp(-depth / 6.0));
  // ice lies on the water in the cold ages
  col = mix(col, vec3(0.78, 0.82, 0.86), uGlacial * smoothstep(0.4, 0.6, vnoise(vWorld.xz * 0.004)));
  // a line of foam where it meets the land
  float wave = 0.5 + 0.5 * sin(depth * 3.0 - uTime * 0.9 + vnoise(vWorld.xz * 0.05) * 6.0);
  col = mix(col, vec3(0.85, 0.87, 0.86), (1.0 - smoothstep(0.0, 0.5, depth)) * wave * 0.6 * (1.0 - uGlacial));
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vec3((vnoise(vWorld.xz * 0.3 + uTime * 0.2) - 0.5) * 0.08, 1.0, (vnoise(vWorld.zx * 0.3 - uTime * 0.17) - 0.5) * 0.08));
  float fres = pow(1.0 - max(dot(v, n), 0.0), 4.0);
  vec3 c = shade(col, n, vWorld, 0.3, sampleShadow(vWorld, n));
  c = mix(c, uFogColor * 0.9, fres * 0.7);
  c += uSunColor * pow(max(dot(reflect(-uSunDir, n), v), 0.0), 60.0) * 0.25;
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

export class Water {
  readonly mesh: THREE.Mesh;

  constructor() {
    const geo = new THREE.PlaneGeometry(60000, 60000, 1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: { ...shared }, vertexShader: vert, fragmentShader: frag }));
    this.mesh.frustumCulled = false;
  }

  update(camPos: THREE.Vector3): void {
    this.mesh.position.set(camPos.x, 0, camPos.z);
  }
}
