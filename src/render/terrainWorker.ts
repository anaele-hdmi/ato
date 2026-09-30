// Terrain chunk builder, off the main thread (review-2 §4/§5-2): displaces a
// detail chunk's vertices by the DEM + micro-relief and bakes its per-vertex
// horizon angles (cast shadows). The DEM and land-mask rasters arrive once
// (transferred, single channel); every build result is transferred back.
import { buildTerrainChunk, createHiDem, installHiTile, type Raster } from './terrain';
import type { SeedChunk } from './icosphere';

export type TerrainWorkerRequest =
  | { type: 'init'; height: Raster; land: Raster }
  /** One hi-res DEM tile (single channel codes, see terrain.ts HiDem). */
  | { type: 'tile'; col: number; row: number; data: Uint8Array }
  | {
      type: 'build';
      id: number;
      seedIndex: number;
      corners: SeedChunk['corners'];
      seedLevel: number;
      level: number;
      radiusKm: number;
      snapBorder: boolean;
    };

export interface TerrainWorkerResult {
  type: 'built';
  id: number;
  seedIndex: number;
  level: number;
  positions: Float32Array;
  indices: Uint16Array;
  horizonA: Uint8Array;
  horizonB: Uint8Array;
  /** Wall time spent building this chunk in the worker, ms. */
  ms: number;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<TerrainWorkerRequest>) => void) | null;
  postMessage(message: TerrainWorkerResult, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let height: Raster | null = null;
let land: Raster | null = null;
const hi = createHiDem();

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    height = msg.height;
    land = msg.land;
    return;
  }
  if (msg.type === 'tile') {
    installHiTile(hi, msg.col, msg.row, msg.data);
    return;
  }
  if (!height || !land) return; // earth.ts only sends builds after init
  const t0 = performance.now();
  const c = buildTerrainChunk(msg.corners, msg.seedLevel, msg.level, msg.radiusKm, height, land, msg.snapBorder, hi);
  const ms = performance.now() - t0;
  scope.postMessage(
    { type: 'built', id: msg.id, seedIndex: msg.seedIndex, level: msg.level, ms, ...c },
    [c.positions.buffer, c.indices.buffer, c.horizonA.buffer, c.horizonB.buffer],
  );
};
