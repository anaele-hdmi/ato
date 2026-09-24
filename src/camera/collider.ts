// Keeps the eye out of buildings by shortening the target->eye ray. Mirrors the
// height rules of the building shader closely enough for a camera.
import type { BoxRec } from '../world/settlement';
import type { CottageInstance } from '../world/cottage';
import { smoothstep } from '../util/rand';

interface Solid {
  x: number; z: number; c: number; s: number; hx: number; hz: number; y: number;
  birth: number; death: number;
  h0: number; h1: number; h2: number; g1: number; g2s: number; g2e: number; collapse: number; seed: number;
}

const CELL = 60;

export class Collider {
  private grid = new Map<number, Solid[]>();

  constructor(boxes: BoxRec[], cottages: CottageInstance[]) {
    const add = (o: Solid) => {
      const r = Math.hypot(o.hx, o.hz);
      for (let i = Math.floor((o.x - r) / CELL); i <= Math.floor((o.x + r) / CELL); i++) {
        for (let j = Math.floor((o.z - r) / CELL); j <= Math.floor((o.z + r) / CELL); j++) {
          const k = i * 100003 + j;
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(o);
        }
      }
    };
    for (const b of boxes) {
      add({
        x: b.x, z: b.z, c: Math.cos(b.rot), s: Math.sin(b.rot), hx: b.sx / 2 + 0.6, hz: b.sz / 2 + 0.6, y: b.y,
        birth: b.birth, death: b.death, h0: b.h0, h1: b.h1, h2: b.h2, g1: b.grow1, g2s: b.g2s, g2e: b.g2e, collapse: b.collapse, seed: b.seed,
      });
    }
    for (const c of cottages) {
      const h = 5.5 * c.scale;
      add({
        x: c.x, z: c.z, c: Math.cos(c.rot), s: Math.sin(c.rot), hx: 3.5 * c.scale, hz: 3 * c.scale, y: c.y,
        birth: c.birth, death: c.death, h0: h, h1: h, h2: h, g1: 0, g2s: 9e9, g2e: 9e9, collapse: 9e9, seed: 0,
      });
    }
  }

  private height(o: Solid, year: number): number {
    let h = o.h0 + (o.h1 - o.h0) * smoothstep(o.birth, Math.max(o.g1, o.birth + 0.01), year) + (o.h2 - o.h1) * smoothstep(o.g2s, o.g2e, year);
    h = Math.max(3.2, Math.round(h / 3.2) * 3.2);
    const col = smoothstep(o.collapse, o.collapse + 120 + o.seed * 260, year);
    return Math.max(1.5, h * (1 - col * 0.9));
  }

  private inside(x: number, y: number, z: number, year: number): boolean {
    const l = this.grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!l) return false;
    for (const o of l) {
      if (year < o.birth || year >= o.death) continue;
      const dx = x - o.x, dz = z - o.z;
      const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
      if (Math.abs(lx) > o.hx || Math.abs(lz) > o.hz) continue;
      if (y < o.y + this.height(o, year) + 1) return true;
    }
    return false;
  }

  /**
   * Fraction of the target->eye segment at which the eye is outside any building.
   * Only the eye itself is tested; buildings in between may hide the target,
   * which keeps high views possible over a dense city.
   */
  clip(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, year: number): number {
    if (!this.inside(tx, ty, tz, year)) return 1;
    const len = Math.hypot(tx - fx, ty - fy, tz - fz);
    const steps = Math.min(240, Math.ceil(len / 1.5));
    for (let i = steps - 1; i >= 1; i--) {
      const t = i / steps;
      if (!this.inside(fx + (tx - fx) * t, fy + (ty - fy) * t, fz + (tz - fz) * t, year)) return t;
    }
    return 0;
  }
}
