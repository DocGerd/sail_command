// #1699: map-side pieces of the sea-state overlay — layer ids, band colours,
// the water-clipped raster (#1854), markers and their images. A plain module
// (no React), so DataLayers can import the stack anchor without importing a
// component.
import type { LatLon, MaskMeta, WaveGrid, WindGrid } from '../types';
import { nearestHourIndex } from './routeGeoJson';
import type { NavMask } from './mask';
import type { MsgKey } from '../i18n/dict.de';
import type { Lang } from './format';
import { HALO_COLOR } from './mapColors';
import { depthCanvasRowMap } from './depthColor';
import { seaStateBand, type SeaStateBand } from './waves';

export const WAVE_RASTER_SOURCE = 'sc-waves-raster';
export const WAVE_ARROW_SOURCE = 'sc-waves-arrows';
export const WAVE_FILL_LAYER = 'sc-waves-fill';
export const WAVE_ARROW_LAYER = 'sc-waves-arrows';
// The fill is added first with the arrows on the same anchor, so it is the bottom.
export const WAVE_STACK_BOTTOM_LAYER = WAVE_FILL_LAYER;
export const WAVE_ARROW_IMAGE = 'sc-wave-arrow';
export const WAVE_DOT_IMAGE = 'sc-wave-dot';

export type ShadedBand = Exclude<SeaStateBand, 'no-data'>;
export const SHADED_BANDS: readonly ShadedBand[] = [
  'calm',
  'smooth',
  'slight',
  'moderate',
  'rough',
];

// app.css twins these as --sc-sea-* for the legend swatches.
export const SEA_STATE_COLORS: Record<ShadedBand, string> = {
  calm: '#EDF8FB',
  smooth: '#B3CDE3',
  slight: '#8C96C6',
  moderate: '#8856A7',
  rough: '#810F7C',
};

// Navy, so the arrows read apart from the black wind barbs on the same
// lattice. app.css twins it as --sc-wave-arrow for the legend glyph.
export const WAVE_ARROW_COLOR = '#1E3A8A';

export const SEA_STATE_BAND_KEY: Record<ShadedBand, MsgKey> = {
  calm: 'seaState.band.calm',
  smooth: 'seaState.band.smooth',
  slight: 'seaState.band.slight',
  moderate: 'seaState.band.moderate',
  rough: 'seaState.band.rough',
};

export const WAVE_FILL_OPACITY = 0.45;

// The fetch lattice (services/openMeteo.ts), twinned in waveMap.test.ts.
export const WAVE_LATTICE_STEP_DEG = 0.1;
export const WAVE_LATTICE_MID_LAT = 54.95;

// One raster pixel per `stride` mask cells along each axis: quarter
// resolution, chosen by #1854's gating paint measurement (recorded on its PR).
export const SEA_STATE_RASTER_STRIDE = 4;

export interface WaveCellProps {
  band: ShadedBand;
  heightM: number;
  periodS?: number;
  travelDeg?: number;
}

export interface WaveMarkerProps {
  marker: 'arrow' | 'dot';
  rotateDeg: number;
  band: ShadedBand;
}

type MarkerFC = GeoJSON.FeatureCollection<GeoJSON.Point, WaveMarkerProps>;

export const EMPTY_WAVE_MARKERS: MarkerFC = { type: 'FeatureCollection', features: [] };

// Waves are reported as coming FROM; the arrow shows where they travel.
export function travelDeg(dirFromDeg: number): number {
  return (((dirFromDeg + 180) % 360) + 360) % 360;
}

function halfStep(axis: readonly number[]): number {
  if (axis.length < 2) return 0.05;
  return Math.abs(axis[axis.length - 1]! - axis[0]!) / (axis.length - 1) / 2;
}

// Nearest axis entry within half a lattice step, else null: the cell partition
// ends half a step beyond the outermost points.
function nearestAxisIndex(axis: readonly number[], v: number, half: number): number | null {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i]! - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 && bestD <= half ? best : null;
}

// Flattened lattice index (latIdx * nLon + lonIdx) of the point whose cell
// holds `p`, or null outside the lattice.
export function nearestWaveCell(grid: Pick<WaveGrid, 'lats' | 'lons'>, p: LatLon): number | null {
  const la = nearestAxisIndex(grid.lats, p.lat, halfStep(grid.lats));
  const lo = nearestAxisIndex(grid.lons, p.lon, halfStep(grid.lons));
  return la === null || lo === null ? null : la * grid.lons.length + lo;
}

export interface SeaStateRaster {
  readonly width: number;
  readonly height: number;
  readonly nPoints: number;
  // Per pixel, row 0 north: lattice index + 1, or 0 where nothing may be shaded.
  readonly cells: Uint16Array;
  // Shadeable pixels per lattice point.
  readonly pixelCount: Uint32Array;
  readonly west: number;
  readonly east: number;
  readonly yNorth: number;
  readonly ySpan: number;
}

function mercatorY(latDeg: number): number {
  const s = Math.sin((latDeg * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function seaStateRasterSize(
  meta: MaskMeta,
  stride = SEA_STATE_RASTER_STRIDE,
): { width: number; height: number } {
  return {
    width: Math.ceil(meta.cols / stride),
    height: Math.ceil(depthCanvasRowMap(meta).length / stride),
  };
}

const rasterCache = new WeakMap<NavMask, { key: string; raster: SeaStateRaster }>();

// A pixel samples one mask cell (every `stride`-th mask column and every
// `stride`-th depthCanvasRowMap row) and belongs to that cell's nearest lattice
// point. It may be shaded only if the cell is water and the lattice point is
// itself in-mask water, so nothing is borrowed from a neighbour point.
export function seaStateRasterIndex(
  mask: NavMask,
  grid: Pick<WaveGrid, 'lats' | 'lons'>,
  stride = SEA_STATE_RASTER_STRIDE,
): SeaStateRaster {
  const key = `${stride}|${grid.lats.join()}|${grid.lons.join()}`;
  const cached = rasterCache.get(mask);
  if (cached?.key === key) return cached.raster;

  const { meta } = mask;
  const rowMap = depthCanvasRowMap(meta);
  const width = Math.ceil(meta.cols / stride);
  const height = Math.ceil(rowMap.length / stride);
  const nLon = grid.lons.length;
  const nPoints = grid.lats.length * nLon;
  const pointIsWater = new Uint8Array(nPoints);
  for (let la = 0; la < grid.lats.length; la++)
    for (let lo = 0; lo < nLon; lo++) {
      const p = { lat: grid.lats[la]!, lon: grid.lons[lo]! };
      pointIsWater[la * nLon + lo] = mask.inBounds(p) && mask.depthM(p) > 0 ? 1 : 0;
    }
  const latHalf = halfStep(grid.lats);
  const lonHalf = halfStep(grid.lons);
  const colLon = new Float64Array(width);
  const colPoint = new Int32Array(width);
  for (let j = 0; j < width; j++) {
    colLon[j] = mask.grid.lon.centre(j * stride);
    colPoint[j] = nearestAxisIndex(grid.lons, colLon[j]!, lonHalf) ?? -1;
  }
  const cells = new Uint16Array(width * height);
  const pixelCount = new Uint32Array(nPoints);
  for (let i = 0; i < height; i++) {
    const lat = mask.grid.lat.centre(rowMap[i * stride]!);
    const la = nearestAxisIndex(grid.lats, lat, latHalf);
    if (la === null) continue;
    for (let j = 0; j < width; j++) {
      const lo = colPoint[j]!;
      if (lo < 0) continue;
      const k = la * nLon + lo;
      if (!pointIsWater[k]) continue;
      if (mask.depthM({ lat, lon: colLon[j]! }) <= 0) continue;
      cells[i * width + j] = k + 1;
      pixelCount[k]! += 1;
    }
  }
  const raster: SeaStateRaster = {
    width,
    height,
    nPoints,
    cells,
    pixelCount,
    west: meta.west,
    east: meta.east,
    yNorth: mercatorY(meta.north),
    ySpan: mercatorY(meta.south) - mercatorY(meta.north),
  };
  rasterCache.set(mask, { key, raster });
  return raster;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Opaque band colours (the layer applies WAVE_FILL_OPACITY) into `out`, which
// holds width * height * 4 bytes. Unshaded and no-data pixels are transparent.
export function paintSeaState(
  raster: SeaStateRaster,
  grid: WaveGrid,
  hourIdx: number,
  out: Uint8ClampedArray,
): void {
  const table = new Uint8Array((raster.nPoints + 1) * 4);
  const base = hourIdx * raster.nPoints;
  for (let k = 0; k < raster.nPoints; k++) {
    const band = seaStateBand(grid.waveHeightM[base + k] ?? NaN);
    if (band === 'no-data') continue;
    table.set([...hexRgb(SEA_STATE_COLORS[band]), 255], (k + 1) * 4);
  }
  // Whole-pixel copies through byte-built buffers, so byte order never matters.
  const table32 = new Uint32Array(table.buffer);
  const out32 = new Uint32Array(out.buffer, out.byteOffset, raster.width * raster.height);
  const { cells } = raster;
  for (let p = 0; p < cells.length; p++) out32[p] = table32[cells[p]!]!;
}

// The raster pixel holding `p`: columns are linear in longitude and rows in Web
// Mercator y, as MapLibre stretches a canvas source between its corners.
export function seaStatePixelAt(raster: SeaStateRaster, p: LatLon): number | null {
  const x = (p.lon - raster.west) / (raster.east - raster.west);
  const y = (mercatorY(p.lat) - raster.yNorth) / raster.ySpan;
  if (!(x >= 0 && x < 1 && y >= 0 && y < 1)) return null;
  return Math.floor(y * raster.height) * raster.width + Math.floor(x * raster.width);
}

// Lattice point `k` at the hour, or null for no data. Non-finite period and
// direction are left out (GeoJSON has no NaN).
export function waveCellProps(grid: WaveGrid, hourIdx: number, k: number): WaveCellProps | null {
  const i = hourIdx * grid.lats.length * grid.lons.length + k;
  const heightM = grid.waveHeightM[i] ?? NaN;
  const band = seaStateBand(heightM);
  if (band === 'no-data') return null;
  const props: WaveCellProps = { band, heightM };
  const periodS = grid.wavePeriodS[i] ?? NaN;
  const dir = grid.waveDirFromDeg[i] ?? NaN;
  if (Number.isFinite(periodS)) props.periodS = periodS;
  if (Number.isFinite(dir)) props.travelDeg = travelDeg(dir);
  return props;
}

// The cell the raster shades at `p`, or null where it leaves `p` unshaded.
export function shadedWaveCellAt(
  raster: SeaStateRaster,
  grid: WaveGrid,
  hourIdx: number,
  p: LatLon,
): WaveCellProps | null {
  const px = seaStatePixelAt(raster, p);
  const c = px === null ? 0 : raster.cells[px]!;
  return c === 0 ? null : waveCellProps(grid, hourIdx, c - 1);
}

export interface MarkerOffset {
  dLat: number;
  dLon: number;
}

const CALM_BARB_KN = 2.5;

/**
 * Where a cell's marker sits while barbs are shown (#1854 spike §5): the
 * quarter-cell point on the downwind side, farthest from the cell's wind
 * axis, so the barb drawn on the lattice point does not cover it. Calm or
 * missing wind leaves it at the centre (null).
 */
export function markerOffset(
  dirFromDeg: number,
  speedKn: number,
  latDeg: number,
  latStepDeg: number,
  lonStepDeg: number,
): MarkerOffset | null {
  if (!Number.isFinite(dirFromDeg) || !(speedKn >= CALM_BARB_KN)) return null;
  const rad = (dirFromDeg * Math.PI) / 180;
  const downE = -Math.sin(rad);
  const downN = -Math.cos(rad);
  const kx = Math.cos((latDeg * Math.PI) / 180);
  let best: { e: number; n: number; perp: number; dot: number } | null = null;
  for (const n of [1, -1])
    for (const e of [1, -1]) {
      const x = e * lonStepDeg * kx;
      const y = n * latStepDeg;
      const dot = x * downE + y * downN;
      if (dot < -1e-12) continue;
      const perp = Math.abs(x * downN - y * downE);
      if (
        best === null ||
        perp > best.perp + 1e-12 ||
        (Math.abs(perp - best.perp) <= 1e-12 && dot > best.dot)
      ) {
        best = { e, n, perp, dot };
      }
    }
  return best && { dLat: (best.n * latStepDeg) / 4, dLon: (best.e * lonStepDeg) / 4 };
}

/** Per lattice point, the marker offset from the wind at `tMs`; null when barbs are hidden. */
export function windMarkerOffsets(
  wind: WindGrid | null | undefined,
  grid: Pick<WaveGrid, 'lats' | 'lons'>,
  tMs: number,
): ((k: number) => MarkerOffset | null) | null {
  if (!wind || wind.timesMs.length === 0) return null;
  const h = nearestHourIndex(wind.timesMs, tMs);
  const base = h * wind.lats.length * wind.lons.length;
  const latStep = 2 * halfStep(grid.lats);
  const lonStep = 2 * halfStep(grid.lons);
  const nLon = grid.lons.length;
  return (k) => {
    const p = { lat: grid.lats[Math.floor(k / nLon)]!, lon: grid.lons[k % nLon]! };
    const w = nearestWaveCell(wind, p);
    if (w === null) return null;
    return markerOffset(
      wind.dirFromDeg[base + w] ?? NaN,
      wind.speedKn[base + w] ?? NaN,
      p.lat,
      latStep,
      lonStep,
    );
  };
}

// Exactly one marker per shaded cell: the travel arrow, or a dot when the
// direction is missing. At its lattice point, or offset off the barb.
export function seaStateMarkers(
  raster: SeaStateRaster,
  grid: WaveGrid,
  hourIdx: number,
  offsetAt: ((k: number) => MarkerOffset | null) | null = null,
): MarkerFC {
  const nLon = grid.lons.length;
  const features: MarkerFC['features'] = [];
  for (let k = 0; k < raster.nPoints; k++) {
    if (raster.pixelCount[k] === 0) continue;
    const props = waveCellProps(grid, hourIdx, k);
    if (props === null) continue;
    const off = offsetAt?.(k) ?? null;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          grid.lons[k % nLon]! + (off?.dLon ?? 0),
          grid.lats[Math.floor(k / nLon)]! + (off?.dLat ?? 0),
        ],
      },
      properties:
        props.travelDeg === undefined
          ? { marker: 'dot', rotateDeg: 0, band: props.band }
          : { marker: 'arrow', rotateDeg: props.travelDeg, band: props.band },
    });
  }
  return { type: 'FeatureCollection', features };
}

export const WAVE_ARROW_IMAGE_PX = 32;
export const WAVE_ARROW_PIXEL_RATIO = 2;

// Unit-square arrow pointing up (north before icon-rotate).
function insideArrow(u: number, v: number): boolean {
  const shaft = Math.abs(u - 0.5) <= 0.07 && v >= 0.4 && v <= 0.9;
  // Head: apex (0.5, 0.1), base from (0.25, 0.45) to (0.75, 0.45).
  const head = v >= 0.1 && v <= 0.45 && Math.abs(u - 0.5) <= ((v - 0.1) / 0.35) * 0.25;
  return shaft || head;
}

// Unit-square ring, centred.
function insideDot(u: number, v: number): boolean {
  const r = Math.hypot(u - 0.5, v - 0.5);
  return r >= 0.12 && r <= 0.22;
}

// Raw RGBA pixels for map.addImage: navy glyph on a white halo. Drawn without a
// canvas so it registers wherever the map does, test fakes included.
function glyphImage(inside: (u: number, v: number) => boolean): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const size = WAVE_ARROW_IMAGE_PX;
  const data = new Uint8Array(size * size * 4);
  const ink = hexRgb(WAVE_ARROW_COLOR);
  const halo = hexRgb(HALO_COLOR);
  const haloPx = 2;
  const at = (x: number, y: number) => inside((x + 0.5) / size, (y + 0.5) / size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb: [number, number, number] | null = null;
      if (at(x, y)) rgb = ink;
      else {
        outer: for (let dy = -haloPx; dy <= haloPx; dy++) {
          for (let dx = -haloPx; dx <= haloPx; dx++) {
            if (dx * dx + dy * dy <= haloPx * haloPx && at(x + dx, y + dy)) {
              rgb = halo;
              break outer;
            }
          }
        }
      }
      if (!rgb) continue;
      const i = (y * size + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

export function waveArrowImage(): { width: number; height: number; data: Uint8Array } {
  return glyphImage(insideArrow);
}

export function waveDotImage(): { width: number; height: number; data: Uint8Array } {
  return glyphImage(insideDot);
}

const LOCALES: Record<Lang, string> = { de: 'de-DE', en: 'en-GB' };

// Sea-state metres, one to two decimals, truncated: the band is classified from
// the raw value, so a rounded figure could read as the next band.
// Heights are stored as Float32 (0.7 reads 0.699999988), so first snap to 1e-6,
// unless the snap would cross a band edge.
// Engines without Intl `roundingMode` ignore it and round instead.
export function formatSeaStateM(value: number, lang: Lang): string {
  const snapped = Math.round(value * 1e6) / 1e6;
  const v = seaStateBand(snapped) === seaStateBand(value) ? snapped : value;
  return new Intl.NumberFormat(LOCALES[lang], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
    roundingMode: 'trunc',
  }).format(v);
}
