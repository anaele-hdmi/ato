import { describe, expect, it } from 'vitest';
import { buildSeaIceTexture } from './landmask';

// texel i covers longitude -180 + i .. -179 + i; channels: N max, N min, S max, S min, (deg - 40) / 60 * 255
function edges(tex: { image: { data: ArrayLike<number> | null } }, lon: number): number[] {
  const i = Math.floor(lon + 180);
  return Array.from(tex.image.data!).slice(i * 4, i * 4 + 4).map((v) => 40 + (v / 255) * 60);
}

describe('sea-ice edge table', () => {
  const tex = buildSeaIceTexture();

  it('has one texel per degree of longitude', () => {
    expect(tex.image.width).toBe(360);
  });

  it('Hudson Bay freezes in the Arctic maximum and is ice-free in the minimum', () => {
    const [nMax, nMin] = edges(tex, -85);
    expect(nMax).toBeLessThan(56);
    expect(nMin).toBeGreaterThan(88); // 91 = no ice (clamped to the encoded range)
  });

  it('the seasonal-maximum edge is never poleward of the minimum edge (both hemispheres)', () => {
    for (let lon = -179; lon < 180; lon += 7) {
      const [nMax, nMin, sMax, sMin] = edges(tex, lon);
      expect(nMax).toBeLessThanOrEqual(nMin + 0.5);
      expect(sMax).toBeLessThanOrEqual(sMin + 0.5);
    }
  });

  it('is continuous across the antimeridian', () => {
    const a = edges(tex, -179.5);
    const b = edges(tex, 179.5);
    for (let k = 0; k < 4; k++) expect(Math.abs(a[k] - b[k])).toBeLessThan(2);
  });
});
