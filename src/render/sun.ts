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
  // Smooth Gaussian + exponential falloff (no visible ring under bloom).
  grad.addColorStop(0.0000, 'rgba(255,250,235,1.0000)');
  grad.addColorStop(0.0312, 'rgba(255,249,233,0.9385)');
  grad.addColorStop(0.0625, 'rgba(255,248,231,0.4077)');
  grad.addColorStop(0.0938, 'rgba(255,248,229,0.1546)');
  grad.addColorStop(0.1250, 'rgba(255,247,227,0.0616)');
  grad.addColorStop(0.1562, 'rgba(255,246,225,0.0328)');
  grad.addColorStop(0.1875, 'rgba(255,246,223,0.0206)');
  grad.addColorStop(0.2188, 'rgba(255,245,221,0.0134)');
  grad.addColorStop(0.2500, 'rgba(255,245,220,0.0087)');
  grad.addColorStop(0.2812, 'rgba(255,244,218,0.0057)');
  grad.addColorStop(0.3125, 'rgba(255,243,216,0.0037)');
  grad.addColorStop(0.3438, 'rgba(255,243,214,0.0024)');
  grad.addColorStop(0.3750, 'rgba(255,242,212,0.0015)');
  grad.addColorStop(0.4062, 'rgba(255,241,210,0.0010)');
  grad.addColorStop(0.4375, 'rgba(255,241,208,0.0006)');
  grad.addColorStop(0.4688, 'rgba(255,240,206,0.0004)');
  grad.addColorStop(0.5000, 'rgba(255,240,205,0.0002)');
  grad.addColorStop(0.5312, 'rgba(255,239,203,0.0002)');
  grad.addColorStop(0.5625, 'rgba(255,238,201,0.0001)');
  grad.addColorStop(0.5938, 'rgba(255,238,199,0.0001)');
  grad.addColorStop(0.6250, 'rgba(255,237,197,0.0000)');
  grad.addColorStop(0.6562, 'rgba(255,236,195,0.0000)');
  grad.addColorStop(0.6875, 'rgba(255,236,193,0.0000)');
  grad.addColorStop(0.7188, 'rgba(255,235,191,0.0000)');
  grad.addColorStop(0.7500, 'rgba(255,235,190,0.0000)');
  grad.addColorStop(0.7812, 'rgba(255,234,188,0.0000)');
  grad.addColorStop(0.8125, 'rgba(255,233,186,0.0000)');
  grad.addColorStop(0.8438, 'rgba(255,233,184,0.0000)');
  grad.addColorStop(0.8750, 'rgba(255,232,182,0.0000)');
  grad.addColorStop(0.9062, 'rgba(255,231,180,0.0000)');
  grad.addColorStop(0.9375, 'rgba(255,231,178,0.0000)');
  grad.addColorStop(0.9688, 'rgba(255,230,176,0.0000)');
  grad.addColorStop(1.0000, 'rgba(255,230,175,0.0000)');
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
