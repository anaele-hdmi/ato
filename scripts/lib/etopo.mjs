// Fetches NOAA ETOPO 2022 (60 arc-second, ice-surface, EGM2008 heights) through
// the NCEI THREDDS OPeNDAP endpoint, one latitude band at a time, and reduces it
// by an integer factor with a box filter. No third-party dependencies.
//
// Grid: z[lat = 10800][lon = 21600], lat ascending from -89.99167 (south), lon
// ascending from -179.99167; float32 metres (elevation positive, bathymetry
// negative). The .dods reply is a text DDS header, "Data:\n", then two uint32
// element counts and big-endian float32 values.
import fs from 'node:fs';
import path from 'node:path';

export const ETOPO_URL =
  'https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc';
export const SRC_W = 21600;
export const SRC_H = 10800;

async function fetchBand(row0, rows) {
  const url = `${ETOPO_URL}.dods?z.z[${row0}:1:${row0 + rows - 1}][0:1:${SRC_W - 1}]`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const marker = buf.indexOf('\nData:\n');
      if (marker < 0) throw new Error('no Data: marker');
      const off = marker + 7 + 8;
      const n = rows * SRC_W;
      if (buf.length - off < n * 4) throw new Error('short reply');
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatBE(off + i * 4);
      return out;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

/**
 * Returns { width, height, elev, depth } where each output pixel is the mean of a
 * factor x factor block: `elev` = mean of max(z, 0) metres, `depth` = mean of
 * max(-z, 0) metres. Rows run north -> south (image order), columns west -> east
 * from lon -180. Cached as a raw file in `cacheDir`.
 */
export async function loadReduced(factor, cacheDir, log = console.log) {
  const W = SRC_W / factor;
  const H = SRC_H / factor;
  const cache = path.join(cacheDir, `etopo2022_60s_x${factor}.f32`);
  if (fs.existsSync(cache) && fs.statSync(cache).size === W * H * 8) {
    const b = fs.readFileSync(cache);
    const all = new Float32Array(b.buffer, b.byteOffset, W * H * 2);
    return { width: W, height: H, elev: all.slice(0, W * H), depth: all.slice(W * H) };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const elev = new Float32Array(W * H);
  const depth = new Float32Array(W * H);
  const BAND = factor * 100; // source rows per request (multiple of the factor)
  const inv = 1 / (factor * factor);
  for (let srcRowTop = 0; srcRowTop < SRC_H; srcRowTop += BAND) {
    const rows = Math.min(BAND, SRC_H - srcRowTop);
    // image row r (north -> south) is netCDF row (SRC_H - 1 - r)
    const ncRow0 = SRC_H - srcRowTop - rows;
    const band = await fetchBand(ncRow0, rows);
    for (let by = 0; by < rows / factor; by++) {
      const oy = srcRowTop / factor + by;
      for (let ox = 0; ox < W; ox++) {
        let e = 0;
        let d = 0;
        for (let dy = 0; dy < factor; dy++) {
          // netCDF rows inside this band are south -> north: flip
          const bandRow = rows - 1 - (by * factor + dy);
          const base = bandRow * SRC_W + ox * factor;
          for (let dx = 0; dx < factor; dx++) {
            const z = band[base + dx];
            if (z > 0) e += z;
            else d -= z;
          }
        }
        elev[oy * W + ox] = e * inv;
        depth[oy * W + ox] = d * inv;
      }
    }
    log(`  fetched rows ${srcRowTop}..${srcRowTop + rows} / ${SRC_H}`);
  }
  const both = new Float32Array(W * H * 2);
  both.set(elev, 0);
  both.set(depth, W * H);
  fs.writeFileSync(cache, Buffer.from(both.buffer));
  return { width: W, height: H, elev, depth };
}
