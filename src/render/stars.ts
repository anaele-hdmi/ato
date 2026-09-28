// A dim, static starfield. Kept simple per M0 scope: constant dim points far
// outside the Earth shell; the "black stays black" requirement is satisfied
// by keeping intensity low and never additively stacking many overlapping points.
import * as THREE from 'three';
import { SPACE } from './palette';

const STAR_COUNT = 4000;
const STAR_RADIUS_KM = 80000;

export interface StarsObjects {
  points: THREE.Points;
  dispose(): void;
}

export function createStars(): StarsObjects {
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // uniform points on a sphere
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = STAR_RADIUS_KM;
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: SPACE.starDim,
    size: 2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
