// Window-frame builder shared by the interior cabin (cabin.ts) and the
// exterior cupola (station.ts). A window is a closed 2D outline (in whatever
// plane the caller maps to 3D); the frame is that outline swept along a
// cross-section profile: (offset outward from the opening, height along the
// window normal, baked AO, tone 0 = seal ... 1 = metal). Each profile band
// gets its own vertices, so bands are hard-edged while smooth outlines
// (arcs) are shaded smoothly; `corner` points are split for crisp corners.
import * as THREE from 'three';

export interface LoopPt {
  x: number;
  y: number;
  /** sharp corner: shading is split here */
  corner?: boolean;
}

export interface ProfileStep {
  /** distance outward from the opening edge (outline units) */
  off: number;
  /** height in the mapper's third axis */
  h: number;
  /** baked ambient occlusion, 0..1 */
  ao: number;
  /** 0 = seal (dark), 1 = frame metal */
  tone: number;
}

/** outline (x, y) + height -> 3D position */
export type Mapper = (x: number, y: number, h: number) => THREE.Vector3;

/** Makes the outline counter-clockwise (outward = right of travel). */
export function prepareLoop(pts: readonly LoopPt[]): LoopPt[] {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  const out = pts.map((p) => ({ ...p }));
  return area < 0 ? out.reverse() : out;
}

/** Per-point miter vectors: point + miter * off = outline offset by `off`. */
function miters(loop: readonly LoopPt[]): { mx: number[]; my: number[] } {
  const n = loop.length;
  const mx: number[] = [];
  const my: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = loop[i];
    const a = loop[(i + n - 1) % n];
    const b = loop[(i + 1) % n];
    let e1x = p.x - a.x;
    let e1y = p.y - a.y;
    let l = Math.hypot(e1x, e1y) || 1;
    e1x /= l;
    e1y /= l;
    let e2x = b.x - p.x;
    let e2y = b.y - p.y;
    l = Math.hypot(e2x, e2y) || 1;
    e2x /= l;
    e2y /= l;
    // outward normal of a CCW loop: (ey, -ex)
    const n1x = e1y;
    const n1y = -e1x;
    const n2x = e2y;
    const n2y = -e2x;
    const k = 1 / Math.max(1 + n1x * n2x + n1y * n2y, 0.35);
    mx.push((n1x + n2x) * k);
    my.push((n1y + n2y) * k);
  }
  return { mx, my };
}

/** The outline offset outward by `off`, resampled every `spacing` (bolt rows). */
export function offsetSamples(loopIn: readonly LoopPt[], off: number, spacing: number): { x: number; y: number }[] {
  const loop = prepareLoop(loopIn);
  const { mx, my } = miters(loop);
  const n = loop.length;
  const pts = loop.map((p, i) => ({ x: p.x + mx[i] * off, y: p.y + my[i] * off }));
  const out: { x: number; y: number }[] = [];
  let carry = spacing * 0.5;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = carry;
    while (d < len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += spacing;
    }
    carry = d - len;
  }
  return out;
}

/** Sweeps the profile around the outline. Attributes: position, normal, aMat (ao, tone, off). */
export function sweepFrame(loopIn: readonly LoopPt[], profile: readonly ProfileStep[], map: Mapper, viewer: THREE.Vector3): THREE.BufferGeometry {
  const loop = prepareLoop(loopIn);
  const { mx, my } = miters(loop);
  const entries: number[] = [];
  loop.forEach((p, i) => {
    entries.push(i);
    if (p.corner) entries.push(i);
  });
  const E = entries.length;
  const pos: number[] = [];
  const mat: number[] = [];
  const idx: number[] = [];
  let orientBand = 0;
  let best = -1;
  for (let b = 0; b + 1 < profile.length; b++) {
    const d = Math.abs(profile[b + 1].off - profile[b].off);
    if (d > best) {
      best = d;
      orientBand = b;
    }
    const base = pos.length / 3;
    for (let r = 0; r < 2; r++) {
      const st = profile[b + r];
      for (const i of entries) {
        const v = map(loop[i].x + mx[i] * st.off, loop[i].y + my[i] * st.off, st.h);
        pos.push(v.x, v.y, v.z);
        mat.push(st.ao, st.tone, st.off);
      }
    }
    for (let k = 0; k < E; k++) {
      const k1 = (k + 1) % E;
      const a = base + k;
      const bb = base + k1;
      const c = base + E + k1;
      const dd = base + E + k;
      idx.push(a, bb, c, a, c, dd);
    }
  }
  // face the viewer: test one non-degenerate triangle of the widest band
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const bandStart = orientBand * E * 6;
  for (let t = bandStart; t < bandStart + E * 6; t += 3) {
    va.fromArray(pos, idx[t] * 3);
    vb.fromArray(pos, idx[t + 1] * 3);
    vc.fromArray(pos, idx[t + 2] * 3);
    const nrm = vb.clone().sub(va).cross(vc.clone().sub(va));
    if (nrm.lengthSq() < 1e-14) continue;
    if (nrm.dot(viewer.clone().sub(va)) < 0) {
      for (let s = 0; s < idx.length; s += 3) {
        const tmp = idx[s + 1];
        idx[s + 1] = idx[s + 2];
        idx[s + 2] = tmp;
      }
    }
    break;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(mat, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Triangulated outline at height h (window glass). Normal attribute = `normal`. */
export function fillPolygon(loopIn: readonly LoopPt[], map: Mapper, h: number, normal: THREE.Vector3): THREE.BufferGeometry {
  const loop = prepareLoop(loopIn);
  const tris = THREE.ShapeUtils.triangulateShape(
    loop.map((p) => new THREE.Vector2(p.x, p.y)),
    [],
  );
  const pos: number[] = [];
  const nor: number[] = [];
  for (const p of loop) {
    const v = map(p.x, p.y, h);
    pos.push(v.x, v.y, v.z);
    nor.push(normal.x, normal.y, normal.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(tris.flat());
  return g;
}

/** Regular polygon outline (smooth). */
export function circleLoop(radius: number, segments: number): LoopPt[] {
  const out: LoopPt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return out;
}
