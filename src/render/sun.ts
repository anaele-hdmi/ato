// The Sun as a single additive sprite far along sunDir. Depth-tested, so the
// Earth hides it naturally and sunrise happens where the geometry says it does.
import * as THREE from 'three';
import { SUN } from './palette';

const DISTANCE_KM = 90000;
/** Apparent glare diameter, degrees (the disc itself is ~0.5°; this is the halo). */
const GLARE_DEG = 7;

function makeGlareTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.06, 'rgba(255,250,235,1)');
  grad.addColorStop(0.12, 'rgba(255,230,190,0.35)');
  grad.addColorStop(0.4, 'rgba(255,200,150,0.06)');
  grad.addColorStop(1.0, 'rgba(255,200,150,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface SunObjects {
  sprite: THREE.Sprite;
  setDirection(dir: THREE.Vector3): void;
  dispose(): void;
}

export function createSun(): SunObjects {
  const texture = makeGlareTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: SUN.color,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  const scale = 2 * DISTANCE_KM * Math.tan(THREE.MathUtils.degToRad(GLARE_DEG / 2));
  sprite.scale.set(scale, scale, 1);
  sprite.renderOrder = -1;

  return {
    sprite,
    setDirection(dir) {
      sprite.position.copy(dir).multiplyScalar(DISTANCE_KM);
    },
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}
