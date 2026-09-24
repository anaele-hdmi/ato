// Tiny mesh-building helpers: flat-shaded triangles with an extra per-vertex tag.
import * as THREE from 'three';

export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  tag: number[] = [];

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, t: number): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const v of [a, b, c]) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      this.tag.push(t);
    }
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number): void {
    this.tri(a, b, c, t);
    this.tri(a, c, d, t);
  }

  /** Axis-aligned box from min to max, optionally skipping the bottom face. */
  box(min: THREE.Vector3, max: THREE.Vector3, t: number, bottom = false): void {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const [x0, y0, z0, x1, y1, z1] = [min.x, min.y, min.z, max.x, max.y, max.z];
    this.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), t); // +z
    this.quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), t); // -z
    this.quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), t); // +x
    this.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), t); // -x
    this.quad(v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0), t); // top
    if (bottom) this.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), t);
  }

  build(tagName = 'aTag'): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute(tagName, new THREE.Float32BufferAttribute(this.tag, 1));
    return g;
  }
}
