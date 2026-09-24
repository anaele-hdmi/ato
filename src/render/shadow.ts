// One orthographic sun shadow map, re-fitted around the point being looked at.
// Casters live on layer 1 and swap to a depth-only material for this pass.
import * as THREE from 'three';
import { shared } from './shared';
import { clamp } from '../util/rand';

export const SHADOW_LAYER = 1;

interface Caster {
  mesh: THREE.Mesh | THREE.Points | THREE.LineSegments;
  main: THREE.Material;
  depth: THREE.Material;
}

export class SunShadow {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
  private casters: Caster[] = [];
  private bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  private size: number;

  constructor(size: number) {
    this.size = size;
    const depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      depthTexture,
      depthBuffer: true,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.cam.layers.set(SHADOW_LAYER);
    shared.uShadowMap.value = depthTexture;
    shared.uShadowTexel.value = 1 / size;
  }

  add(mesh: Caster['mesh'], depth: THREE.Material): void {
    mesh.layers.enable(SHADOW_LAYER);
    this.casters.push({ mesh, main: mesh.material as THREE.Material, depth });
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, target: THREE.Vector3, dist: number, sunDir: THREE.Vector3): void {
    if (sunDir.y < 0.02) {
      shared.uShadowOn.value = 0;
      return;
    }
    shared.uShadowOn.value = 1;
    const half = clamp(dist * 1.15, 16, 2600);
    const texel = (2 * half) / this.size;
    const c = this.cam;
    const back = half * 2 + 500;
    // Snap the centre to shadow texels so edges do not crawl while orbiting.
    const t = target.clone();
    t.x = Math.round(t.x / texel) * texel;
    t.z = Math.round(t.z / texel) * texel;
    c.position.copy(t).addScaledVector(sunDir, back);
    c.up.set(0, 1, 0);
    c.lookAt(t);
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.near = 1; c.far = back + half * 2 + 400;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();

    for (const k of this.casters) k.mesh.material = k.depth;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, c);
    renderer.setRenderTarget(prevTarget);
    for (const k of this.casters) k.mesh.material = k.main;

    shared.uShadowMatrix.value.copy(this.bias).multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
  }
}
