// A dim, static starfield. Kept simple per M0 scope: constant dim points far
// outside the Earth shell; the "black stays black" requirement is satisfied
// by keeping intensity low and never additively stacking many overlapping points.
import * as THREE from 'three';
import { SPACE } from './palette';

const STAR_COUNT = 1000;
// Three brightness steps, weighted toward the faintest (art-direction §4).
const LEVELS = [0.35, 0.6, 1.0];
const LEVEL_WEIGHTS = [0.7, 0.23, 0.07];
const STAR_RADIUS_KM = 80000;

export interface StarsObjects {
  points: THREE.Points;
  dispose(): void;
}

export function createStars(): StarsObjects {
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
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
    const pick = Math.random();
    const level = pick < LEVEL_WEIGHTS[0] ? LEVELS[0] : pick < LEVEL_WEIGHTS[0] + LEVEL_WEIGHTS[1] ? LEVELS[1] : LEVELS[2];
    colors[i * 3 + 0] = SPACE.star.r * level;
    colors[i * 3 + 1] = SPACE.star.g * level;
    colors[i * 3 + 2] = SPACE.star.b * level;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    vertexColors: true,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.8,
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
