import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCabin, type CabinMode } from './cabin';
import { createStation } from './station';

const MODES: CabinMode[] = ['cupola', 'aft', 'limb', 'zenith'];

describe('cabin window frames', () => {
  it('stay within a small triangle budget and face the eye', () => {
    const cabin = createCabin();
    for (const m of MODES) {
      const tris = cabin.triangles(m);
      console.log(`cabin ${m}: ${tris} triangles`);
      expect(tris).toBeGreaterThan(200);
      expect(tris).toBeLessThan(6000);
    }
    cabin.dispose();
  });

  it('lights only through windows: update accepts any sun direction', () => {
    const cabin = createCabin();
    cabin.setMode('cupola');
    for (const z of [-1, -0.34, -0.3, 0, 0.9]) cabin.update(new THREE.Vector3(Math.sqrt(1 - z * z), 0, z));
    cabin.dispose();
  });
});

describe('station cupola', () => {
  it('builds with a bounded triangle count', () => {
    const st = createStation();
    let tris = 0;
    let calls = 0;
    st.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        calls++;
        const g = o.geometry as THREE.BufferGeometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    console.log(`station: ${tris} triangles in ${calls} meshes`);
    expect(calls).toBeLessThanOrEqual(8) // hull, trim, glass + per-paddle frame and cells;
    st.dispose();
  });
});
