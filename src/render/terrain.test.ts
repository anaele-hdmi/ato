import { describe, expect, it } from 'vitest';
import { createHiDem, elevationKm, installHiTile, EXAGGERATION, HI_TILE_COLS, HI_TILE_ROWS, HI_TILE_SIZE, type Raster } from './terrain';

const LAND: Raster = { data: new Uint8Array(4).fill(255), width: 2, height: 2, stride: 1 };
const FLAT: Raster = { data: new Uint8Array(4), width: 2, height: 2, stride: 1 };

function dir(latDeg: number, lonDeg: number): [number, number, number] {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  // same convention as terrain.ts: lon = atan2(-z, x)
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}

describe('hi-res DEM sampling', () => {
  it('uses an installed tile (codes are sqrt-encoded metres, capped at 8000 m)', () => {
    const hi = createHiDem();
    const tile = new Uint8Array(HI_TILE_SIZE * HI_TILE_SIZE).fill(255);
    installHiTile(hi, 0, 0, tile); // lon -180..-120, lat 90..30
    const [x, y, z] = dir(45, -150);
    expect(elevationKm(FLAT, LAND, x, y, z, false, hi)).toBeCloseTo(8 * EXAGGERATION, 3);
    tile.fill(128);
    installHiTile(hi, 0, 0, tile);
    expect(elevationKm(FLAT, LAND, x, y, z, false, hi)).toBeCloseTo(8 * (128 / 255) ** 2 * EXAGGERATION, 3);
  });

  it('falls back to the coarse DEM where the tile is missing, and stays 0 over sea', () => {
    const hi = createHiDem();
    const [x, y, z] = dir(45, -150);
    expect(elevationKm(FLAT, LAND, x, y, z, false, hi)).toBe(0);
    const coarse: Raster = { data: new Uint8Array(4).fill(255), width: 2, height: 2, stride: 1 };
    expect(elevationKm(coarse, LAND, x, y, z, false, hi)).toBeGreaterThan(30);
    installHiTile(hi, 0, 0, new Uint8Array(HI_TILE_SIZE * HI_TILE_SIZE).fill(255));
    expect(elevationKm(coarse, FLAT, x, y, z, false, hi)).toBe(0); // land mask says sea
  });

  it('tile grid covers the globe', () => {
    expect(HI_TILE_COLS * HI_TILE_ROWS).toBeGreaterThan(0);
    expect(HI_TILE_COLS * HI_TILE_SIZE).toBe(2 * HI_TILE_ROWS * HI_TILE_SIZE);
  });
});
