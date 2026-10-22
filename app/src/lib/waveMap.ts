// #1699: map-side pieces of the sea-state overlay — layer ids, band colours,
// GeoJSON and the arrow raster. A plain module (no React), so DataLayers can
// import the stack anchor without importing a component.
import type { WaveGrid } from '../types';
import type { NavMask } from './mask';
import type { MsgKey } from '../i18n/dict.de';
import type { Lang } from './format';
import { INK_COLOR, HALO_COLOR } from './mapColors';
import { seaStateBand, wavePointsAt, type SeaStateBand } from './waves';

export const WAVE_CELL_SOURCE = 'sc-waves-cells';
export const WAVE_ARROW_SOURCE = 'sc-waves-arrows';
export const WAVE_FILL_LAYER = 'sc-waves-fill';
export const WAVE_ARROW_LAYER = 'sc-waves-arrows';
export const WAVE_EDGE_LAYER = 'sc-waves-edge';
// The fill is added first with the arrows on the same anchor, so it is the bottom.
export const WAVE_STACK_BOTTOM_LAYER = WAVE_FILL_LAYER;
export const WAVE_ARROW_IMAGE = 'sc-wave-arrow';

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

export const SEA_STATE_BAND_KEY: Record<ShadedBand, MsgKey> = {
  calm: 'seaState.band.calm',
  smooth: 'seaState.band.smooth',
  slight: 'seaState.band.slight',
  moderate: 'seaState.band.moderate',
  rough: 'seaState.band.rough',
};

export const WAVE_FILL_OPACITY = 0.45;
// Every data cell gets an edge whatever its band: the light bands are close to
// the basemap's water, so the missing cell grid is what shows a wider unshaded
// area as no data (or land); a single no-data cell is still framed by its
// neighbours' edges.
export const WAVE_EDGE_OPACITY = 0.2;

export interface WaveCellProps {
  band: ShadedBand;
  heightM: number;
  periodS?: number;
  travelDeg?: number;
}

type CellFC = GeoJSON.FeatureCollection<GeoJSON.Polygon, WaveCellProps>;
type ArrowFC = GeoJSON.FeatureCollection<GeoJSON.Point, { rotateDeg: number }>;

export const EMPTY_WAVE_CELLS: CellFC = { type: 'FeatureCollection', features: [] };
export const EMPTY_WAVE_ARROWS: ArrowFC = { type: 'FeatureCollection', features: [] };

// Waves are reported as coming FROM; the arrow shows where they travel.
export function travelDeg(dirFromDeg: number): number {
  return (((dirFromDeg + 180) % 360) + 360) % 360;
}

function halfStep(axis: readonly number[]): number {
  if (axis.length < 2) return 0.05;
  return (axis[axis.length - 1]! - axis[0]!) / (axis.length - 1) / 2;
}

// One cell polygon per water point with a finite Hs, one arrow per such point
// with a finite direction. A no-data or culled point gets no feature at all
// (fill, edge and arrow alike, since the edge layer reads the cell source): an
// empty cell must never read as calm. Non-finite values are left out of the
// properties because GeoJSON has no NaN.
export function waveFeaturesAt(
  grid: WaveGrid,
  tMs: number,
  mask: NavMask,
): { cells: CellFC; arrows: ArrowFC } {
  const points = wavePointsAt(grid, tMs);
  if (points === null) return { cells: EMPTY_WAVE_CELLS, arrows: EMPTY_WAVE_ARROWS };
  const dLat = halfStep(grid.lats);
  const dLon = halfStep(grid.lons);
  const cells: CellFC['features'] = [];
  const arrows: ArrowFC['features'] = [];
  for (const p of points) {
    // The marine API can answer a land point with a nearby sea cell's value
    // (cell_selection=sea), so cull by the mask at the point itself.
    // Outside the mask there is no land/water answer, so no data (as for barbs).
    if (!mask.inBounds(p)) continue;
    // Land/unknown only (byte 0); shallow water still renders.
    if (mask.depthM(p) <= 0) continue;
    const band = seaStateBand(p.heightM);
    if (band === 'no-data') continue;
    const props: WaveCellProps = { band, heightM: p.heightM };
    if (Number.isFinite(p.periodS)) props.periodS = p.periodS;
    if (Number.isFinite(p.dirFromDeg)) props.travelDeg = travelDeg(p.dirFromDeg);
    const w = p.lon - dLon;
    const e = p.lon + dLon;
    const s = p.lat - dLat;
    const n = p.lat + dLat;
    cells.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
      properties: props,
    });
    if (props.travelDeg !== undefined) {
      arrows.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { rotateDeg: props.travelDeg },
      });
    }
  }
  return {
    cells: { type: 'FeatureCollection', features: cells },
    arrows: { type: 'FeatureCollection', features: arrows },
  };
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

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Raw RGBA pixels for map.addImage: ink arrow on a white halo. Drawn without a
// canvas so it registers wherever the map does, test fakes included.
export function waveArrowImage(): { width: number; height: number; data: Uint8Array } {
  const size = WAVE_ARROW_IMAGE_PX;
  const data = new Uint8Array(size * size * 4);
  const ink = hexRgb(INK_COLOR);
  const halo = hexRgb(HALO_COLOR);
  const haloPx = 2;
  const at = (x: number, y: number) => insideArrow((x + 0.5) / size, (y + 0.5) / size);
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

const LOCALES: Record<Lang, string> = { de: 'de-DE', en: 'en-GB' };

// Sea-state metres, one to two decimals. Truncated, never rounded: the band is
// classified from the raw value, so a rounded figure could read as the next band.
export function formatSeaStateM(value: number, lang: Lang): string {
  return new Intl.NumberFormat(LOCALES[lang], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
    roundingMode: 'trunc',
  }).format(value);
}
