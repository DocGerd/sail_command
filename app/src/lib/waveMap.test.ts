import { describe, expect, it } from 'vitest';
import {
  formatSeaStateM,
  markerOffset,
  nearestWaveCell,
  paintSeaState,
  SEA_STATE_COLORS,
  SEA_STATE_RASTER_STRIDE,
  seaStateMarkers,
  seaStatePixelAt,
  seaStateRasterIndex,
  seaStateRasterSize,
  shadedWaveCellAt,
  travelDeg,
  WAVE_ARROW_COLOR,
  WAVE_ARROW_IMAGE_PX,
  WAVE_LATTICE_MID_LAT,
  WAVE_LATTICE_STEP_DEG,
  waveArrowImage,
  waveDotImage,
  windMarkerOffsets,
  type SeaStateRaster,
} from './waveMap';
import { makeWindGrid } from '../test/fixtures';
import { depthCanvasRowMap } from './depthColor';
import { NavMask } from './mask';
import { makeWaveGrid } from '../test/waveFixtures';
import { seaStateBand, wavePointsAtHour } from './waves';
import { buildWaveUrl } from '../services/openMeteo';
import type { MaskMeta, WaveGrid } from '../types';

describe('travelDeg (#1699: arrows show where waves go)', () => {
  it.each([
    [0, 180],
    [90, 270],
    [270, 90],
    [359, 179],
    [180, 0],
  ])('from %i° travels toward %i°', (from, to) => {
    expect(travelDeg(from)).toBe(to);
  });
});

// 0.01° cells over the default makeWaveGrid lattice (lats 54.5–54.7, lons
// 10.0–10.1), so each ±0.05° lattice rectangle spans 10 × 10 mask cells and no
// cell centre sits on a rectangle edge.
const FINE: MaskMeta = { south: 54.45, north: 54.75, west: 9.95, east: 10.15, rows: 30, cols: 20 };

function fineMask(byteAt: (lat: number, lon: number) => number = () => 50): NavMask {
  const data = new Uint8Array(FINE.rows * FINE.cols);
  for (let r = 0; r < FINE.rows; r++)
    for (let c = 0; c < FINE.cols; c++)
      data[r * FINE.cols + c] = byteAt(
        Number((FINE.south + (r + 0.5) * 0.01).toFixed(6)),
        Number((FINE.west + (c + 0.5) * 0.01).toFixed(6)),
      );
  return new NavMask(FINE, data);
}

// Land exactly in the mask cells holding `points` (GridAxis decides the cell).
function fineMaskLandAt(points: { lat: number; lon: number }[]): NavMask {
  const probe = fineMask();
  const land = new Set(
    points.map((p) => probe.grid.lat.index(p.lat) * FINE.cols + probe.grid.lon.index(p.lon)),
  );
  const data = new Uint8Array(FINE.rows * FINE.cols).map((_, i) => (land.has(i) ? 0 : 50));
  return new NavMask(FINE, data);
}

const flat = (heightM = 0.8, dirFromDeg = 90): WaveGrid =>
  makeWaveGrid(() => ({ heightM, periodS: 4, dirFromDeg }));

// Independent of the implementation's partition: the lattice point whose
// ±half-step rectangle (the pre-#1854 cell polygon) contains `p`.
function oldRectangle(grid: WaveGrid, lat: number, lon: number): number | null {
  for (let la = 0; la < grid.lats.length; la++)
    for (let lo = 0; lo < grid.lons.length; lo++)
      if (Math.abs(grid.lats[la]! - lat) <= 0.05 && Math.abs(grid.lons[lo]! - lon) <= 0.05)
        return la * grid.lons.length + lo;
  return null;
}

// The mask cell each raster pixel samples: every stride-th column and every
// stride-th row of the depth canvas row map.
function samples(mask: NavMask, stride: number) {
  const rowMap = depthCanvasRowMap(FINE);
  const { width, height } = seaStateRasterSize(FINE, stride);
  const out: { p: number; lat: number; lon: number }[] = [];
  for (let i = 0; i < height; i++)
    for (let j = 0; j < width; j++)
      out.push({
        p: i * width + j,
        lat: mask.grid.lat.centre(rowMap[i * stride]!),
        lon: mask.grid.lon.centre(j * stride),
      });
  return out;
}

describe('nearestWaveCell (#1854)', () => {
  const grid = flat();
  it.each([
    [54.5, 10.0, 0],
    [54.54, 10.04, 0],
    [54.56, 10.04, 2],
    [54.7, 10.1, 5],
  ])('(%s, %s) is lattice point %s', (lat, lon, k) => {
    expect(nearestWaveCell(grid, { lat, lon })).toBe(k);
  });

  it('is null beyond half a step outside the lattice', () => {
    expect(nearestWaveCell(grid, { lat: 54.44, lon: 10.0 })).toBeNull();
    expect(nearestWaveCell(grid, { lat: 54.6, lon: 10.16 })).toBeNull();
  });
});

describe('seaStateRasterIndex: water-clipped cells (#1854)', () => {
  it.each([1, 2, 3])(
    'stride %i: the partition is the old rectangles minus land pixels',
    (stride) => {
      // A coastal strip inside the water points' rectangles, plus land on
      // (54.5, 10.0) itself.
      const coast = (lat: number, lon: number) =>
        lon < 9.98 || (Math.abs(lat - 54.5) < 0.011 && Math.abs(lon - 10.0) < 0.011) ? 0 : 50;
      const mask = fineMask(coast);
      const grid = flat();
      const raster = seaStateRasterIndex(mask, grid, stride);
      expect([raster.width, raster.height]).toEqual([
        Math.ceil(FINE.cols / stride),
        Math.ceil(depthCanvasRowMap(FINE).length / stride),
      ]);
      let land = 0;
      for (const s of samples(mask, stride)) {
        const k = oldRectangle(grid, s.lat, s.lon);
        const water = coast(s.lat, s.lon) > 0;
        if (!water) land++;
        const point =
          k === null ? null : { lat: grid.lats[Math.floor(k / 2)]!, lon: grid.lons[k % 2]! };
        const shaded = water && point !== null && mask.depthM(point) > 0;
        expect(raster.cells[s.p], `pixel ${s.p}`).toBe(shaded ? k! + 1 : 0);
      }
      expect(land, 'the coast reaches the raster').toBeGreaterThan(0);
      expect(raster.pixelCount[0], 'a centre-culled cell').toBe(0);
      expect(raster.pixelCount[1]).toBeGreaterThan(0);
    },
  );

  // Positive control: a water point whose rectangle covers land.
  it('leaves the land pixels of a coastal water cell unshaded', () => {
    const mask = fineMask((lat, lon) => (lat > 54.6 && lat < 54.65 && lon < 9.98 ? 0 : 50));
    const grid = flat();
    const raster = seaStateRasterIndex(mask, grid, 1);
    const k = 2; // (54.6, 10.0), itself water
    const inRect = samples(mask, 1).filter((s) => oldRectangle(grid, s.lat, s.lon) === k);
    const landPx = inRect.filter((s) => mask.depthM(s) <= 0);
    expect(landPx.length).toBeGreaterThan(0);
    expect(landPx.every((s) => raster.cells[s.p] === 0)).toBe(true);
    expect(raster.pixelCount[k]).toBe(inRect.length - landPx.length);
  });

  it('borrows nothing for a lattice point on land: its water pixels stay unshaded', () => {
    const mask = fineMaskLandAt([{ lat: 54.6, lon: 10.0 }]);
    expect(mask.depthM({ lat: 54.6, lon: 10.0 })).toBe(0);
    const raster = seaStateRasterIndex(mask, flat(), 1);
    expect(raster.pixelCount[2]).toBe(0);
    expect(Array.from(raster.cells).includes(3)).toBe(false);
    expect(raster.pixelCount[3]).toBeGreaterThan(0);
  });

  it('keeps shallow water (0.1 m) and drops a point outside the mask', () => {
    const shallow = seaStateRasterIndex(
      fineMask(() => 1),
      flat(),
      1,
    );
    expect(Array.from(shallow.pixelCount).every((n) => n > 0)).toBe(true);
    const wide = makeWaveGrid(() => ({ heightM: 1, periodS: 4, dirFromDeg: 0 }), {
      lats: [54.6],
      lons: [10.1, 10.2],
    });
    const raster = seaStateRasterIndex(fineMask(), wide, 1);
    expect(raster.pixelCount[0]).toBeGreaterThan(0);
    expect(raster.pixelCount[1]).toBe(0);
  });

  it('agrees with nearestWaveCell on every shaded pixel', () => {
    const mask = fineMask((lat, lon) => (lon > 10.08 && lat > 54.66 ? 0 : 50));
    const grid = flat();
    const raster = seaStateRasterIndex(mask, grid, 2);
    let shaded = 0;
    for (const s of samples(mask, 2)) {
      if (raster.cells[s.p] === 0) continue;
      shaded++;
      expect(raster.cells[s.p]! - 1).toBe(nearestWaveCell(grid, s));
    }
    expect(shaded).toBeGreaterThan(0);
  });

  it('is built once per mask and lattice', () => {
    const mask = fineMask();
    const a = seaStateRasterIndex(mask, flat());
    expect(seaStateRasterIndex(mask, flat())).toBe(a);
    expect(
      seaStateRasterIndex(
        mask,
        makeWaveGrid(() => ({ heightM: 1, periodS: 4, dirFromDeg: 0 }), { lats: [54.6] }),
      ),
    ).not.toBe(a);
    expect(SEA_STATE_RASTER_STRIDE).toBeGreaterThan(1);
  });
});

const rgba = (hex: string) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
  255,
];

function paint(raster: SeaStateRaster, grid: WaveGrid, hour = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(raster.width * raster.height * 4).fill(7);
  paintSeaState(raster, grid, hour, out);
  return out;
}

describe('paintSeaState (#1854)', () => {
  // Point k gets band k: calm, smooth, slight, moderate, rough, then no data.
  const heights = [0.05, 0.3, 0.8, 2, 3, NaN];
  const grid = makeWaveGrid((la, lo) => ({
    heightM: heights[la * 2 + lo]!,
    periodS: 4,
    dirFromDeg: 0,
  }));
  const coast = (_lat: number, lon: number) => (lon > 10.12 ? 0 : 50);
  const mask = fineMask(coast);
  const raster = seaStateRasterIndex(mask, grid, 1);
  const out = paint(raster, grid);
  const px = (p: number) => Array.from(out.subarray(p * 4, p * 4 + 4));

  it('paints each shaded pixel its band colour, opaque', () => {
    for (const s of samples(mask, 1)) {
      const c = raster.cells[s.p]!;
      const band = c === 0 ? 'no-data' : seaStateBand(heights[c - 1]!);
      expect(px(s.p)).toEqual(band === 'no-data' ? [0, 0, 0, 0] : rgba(SEA_STATE_COLORS[band]));
    }
  });

  it('covers every band, and leaves land and a no-data cell transparent', () => {
    const seen = new Set(samples(mask, 1).map((s) => px(s.p).join()));
    for (const hex of Object.values(SEA_STATE_COLORS)) expect(seen).toContain(rgba(hex).join());
    const land = samples(mask, 1).find((s) => coast(s.lat, s.lon) === 0)!;
    expect(px(land.p)).toEqual([0, 0, 0, 0]);
    const noData = samples(mask, 1).find((s) => raster.cells[s.p] === 6)!;
    expect(px(noData.p)).toEqual([0, 0, 0, 0]);
  });

  it('samples the requested hour', () => {
    const byHour = makeWaveGrid((_la, _lo, t) => ({
      heightM: t === 1 ? 3 : 0.3,
      periodS: 4,
      dirFromDeg: 0,
    }));
    const r = seaStateRasterIndex(fineMask(), byHour, 1);
    expect(Array.from(paint(r, byHour, 1).subarray(0, 4))).toEqual(rgba(SEA_STATE_COLORS.rough));
    expect(Array.from(paint(r, byHour, 0).subarray(0, 4))).toEqual(rgba(SEA_STATE_COLORS.smooth));
  });
});

describe('seaStatePixelAt and shadedWaveCellAt (#1854)', () => {
  const mask = fineMask((lat, lon) => (lat > 54.6 && lat < 54.65 && lon < 9.98 ? 0 : 50));
  const grid = makeWaveGrid((la, lo) =>
    la === 2 && lo === 1
      ? { heightM: NaN, periodS: 4, dirFromDeg: 0 }
      : { heightM: 0.8, periodS: 4.4, dirFromDeg: 10 },
  );
  const raster = seaStateRasterIndex(mask, grid, 1);

  // Rows are Mercator-spaced, so over the real mask's latitude span a
  // latitude-linear lookup lands rows away.
  it('finds the row of a point over a tall mask in Web Mercator', () => {
    const tall: MaskMeta = {
      south: 54.3,
      north: 55.6,
      west: 9.95,
      east: 10.15,
      rows: 130,
      cols: 20,
    };
    const m = new NavMask(tall, new Uint8Array(tall.rows * tall.cols).fill(50));
    const r = seaStateRasterIndex(m, flat(), 1);
    const rowMap = depthCanvasRowMap(tall);
    for (let i = 0; i < r.height; i++) {
      const p = seaStatePixelAt(r, { lat: m.grid.lat.centre(rowMap[i]!), lon: 10 });
      expect(rowMap[Math.floor(p! / r.width)], `row ${i}`).toBe(rowMap[i]);
    }
  });

  it('finds a pixel sampling the same mask cell as the point', () => {
    for (const s of samples(mask, 1)) {
      const p = seaStatePixelAt(raster, s);
      expect(p).not.toBeNull();
      expect(raster.cells[p!]).toBe(raster.cells[s.p]);
    }
    expect(seaStatePixelAt(raster, { lat: 54.44, lon: 10 })).toBeNull();
    expect(seaStatePixelAt(raster, { lat: 54.6, lon: 10.16 })).toBeNull();
  });

  it('returns the cell on a shaded pixel only', () => {
    expect(shadedWaveCellAt(raster, grid, 0, { lat: 54.6, lon: 10.0 })).toEqual({
      band: 'slight',
      heightM: Math.fround(0.8),
      periodS: Math.fround(4.4),
      travelDeg: 190,
    });
    expect(shadedWaveCellAt(raster, grid, 0, { lat: 54.625, lon: 9.965 })).toBeNull(); // land
    expect(shadedWaveCellAt(raster, grid, 0, { lat: 54.7, lon: 10.1 })).toBeNull(); // no data
  });
});

describe('seaStateMarkers (#1854)', () => {
  it('puts exactly one marker on each shaded cell: an arrow, or a dot without a direction', () => {
    const grid = makeWaveGrid((la, lo) => {
      if (la === 0 && lo === 0) return { heightM: NaN, periodS: 4, dirFromDeg: 0 };
      if (la === 1 && lo === 1) return { heightM: 3, periodS: 4, dirFromDeg: NaN };
      return { heightM: 0.05, periodS: 4, dirFromDeg: 270 };
    });
    // (54.7, 10.1) is on land: no pixels, so no marker.
    const raster = seaStateRasterIndex(fineMaskLandAt([{ lat: 54.7, lon: 10.1 }]), grid, 1);
    const out = paint(raster, grid);
    const shaded = new Set<number>();
    for (let p = 0; p < raster.cells.length; p++)
      if (out[p * 4 + 3] === 255) shaded.add(raster.cells[p]! - 1);
    const features = seaStateMarkers(raster, grid, 0).features;
    const cellOf = (f: (typeof features)[number]) =>
      nearestWaveCell(grid, { lon: f.geometry.coordinates[0]!, lat: f.geometry.coordinates[1]! });
    expect(features.map(cellOf)).toEqual([...shaded].sort((x, y) => x - y));
    expect(features.map(cellOf)).toEqual([1, 2, 3, 4]);
    expect(features.map((f) => f.properties)).toEqual([
      { marker: 'arrow', rotateDeg: 90, band: 'calm' },
      { marker: 'arrow', rotateDeg: 90, band: 'calm' },
      { marker: 'dot', rotateDeg: 0, band: 'rough' },
      { marker: 'arrow', rotateDeg: 90, band: 'calm' },
    ]);
  });
});

describe('markerOffset: wave markers off the barb (#1854 spike §5, AC-4)', () => {
  const LAT = 54.95;
  const STEP = 0.1;
  const qx = (STEP / 4) * Math.cos((LAT * Math.PI) / 180);

  it('moves to a quarter-cell point inside its own cell, downwind and off the wind axis', () => {
    for (let dir = 0; dir < 360; dir += 5) {
      const off = markerOffset(dir, 12, LAT, STEP, STEP);
      expect(off, `dir ${dir}`).not.toBeNull();
      expect(Math.abs(off!.dLat)).toBeCloseTo(STEP / 4, 12);
      expect(Math.abs(off!.dLon)).toBeCloseTo(STEP / 4, 12);
      const x = off!.dLon * Math.cos((LAT * Math.PI) / 180);
      const y = off!.dLat;
      const rad = (dir * Math.PI) / 180;
      const [downE, downN] = [-Math.sin(rad), -Math.cos(rad)];
      expect(x * downE + y * downN, `downwind at ${dir}`).toBeGreaterThanOrEqual(-1e-12);
      expect(Math.abs(x * downN - y * downE), `off axis at ${dir}`).toBeGreaterThan(qx * 0.999);
    }
  });

  it('pins two hand-derived cases', () => {
    // From the north: downwind is south; the two south points tie, east wins by order.
    expect(markerOffset(0, 12, LAT, STEP, STEP)).toEqual({ dLat: -0.025, dLon: 0.025 });
    // From the west: downwind is east; the north-east point.
    expect(markerOffset(270, 12, LAT, STEP, STEP)).toEqual({ dLat: 0.025, dLon: 0.025 });
  });

  it('stays centred for calm or missing wind', () => {
    expect(markerOffset(90, 2, LAT, STEP, STEP)).toBeNull();
    expect(markerOffset(NaN, 12, LAT, STEP, STEP)).toBeNull();
    expect(markerOffset(90, NaN, LAT, STEP, STEP)).toBeNull();
  });

  it('seaStateMarkers applies the offset from the wind at the hour, one marker per cell', () => {
    const grid = makeWaveGrid(() => ({ heightM: 0.5, periodS: 4, dirFromDeg: 270 }));
    const raster = seaStateRasterIndex(fineMaskLandAt([]), grid, 1);
    const wind = makeWindGrid((_lat, _lon, h) => ({ speedKn: 12, dirFromDeg: h === 0 ? 270 : 0 }), {
      t0Ms: grid.timesMs[0],
      hours: 2,
    });
    const centred = seaStateMarkers(raster, grid, 0).features;
    const moved = seaStateMarkers(
      raster,
      grid,
      0,
      windMarkerOffsets(wind, grid, grid.timesMs[0]!),
    ).features;
    expect(moved).toHaveLength(centred.length);
    moved.forEach((f, i) => {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const [lon0, lat0] = centred[i]!.geometry.coordinates as [number, number];
      expect(lon - lon0).toBeCloseTo(0.025, 9);
      expect(lat - lat0).toBeCloseTo(0.025, 9);
      expect(nearestWaveCell(grid, { lat, lon })).toBe(
        nearestWaveCell(grid, { lat: lat0, lon: lon0 }),
      );
    });
    // The next hour's wind (from the north) moves the markers south.
    const later = windMarkerOffsets(wind, grid, grid.timesMs[1]!)!;
    expect(later(0)!.dLat).toBeCloseTo(-0.025, 9);
    expect(later(0)!.dLon).toBeCloseTo(0.025, 9);
    expect(windMarkerOffsets(null, grid, grid.timesMs[0]!)).toBeNull();
  });
});

describe('wave lattice constants twin the fetch lattice (#1854)', () => {
  it('match buildWaveUrl()', () => {
    const q = new URL(buildWaveUrl()).searchParams;
    const lats = [...new Set(q.get('latitude')!.split(',').map(Number))].sort((a, b) => a - b);
    const lons = [...new Set(q.get('longitude')!.split(',').map(Number))].sort((a, b) => a - b);
    for (const axis of [lats, lons])
      for (let i = 1; i < axis.length; i++)
        expect(axis[i]! - axis[i - 1]!).toBeCloseTo(WAVE_LATTICE_STEP_DEG, 9);
    expect((lats[0]! + lats[lats.length - 1]!) / 2).toBeCloseTo(WAVE_LATTICE_MID_LAT, 9);
  });
});

describe('waveDotImage (#1854)', () => {
  const img = waveDotImage();
  const at = (x: number, y: number) =>
    Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
  it('is a navy ring with a transparent centre', () => {
    const c = img.width / 2;
    expect(at(c, c)[3]).toBe(0);
    expect(at(0, 0)[3]).toBe(0);
    const ring = Math.round(img.width * 0.17);
    const ink = at(c, c - ring);
    expect(
      `#${ink
        .slice(0, 3)
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`.toUpperCase(),
    ).toBe(WAVE_ARROW_COLOR);
  });
});

describe('waveArrowImage (#1699)', () => {
  const img = waveArrowImage();
  const alphaAt = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]!;
  const inkAt = (x: number, y: number) => img.data[(y * img.width + x) * 4]! < 128;

  it('is a square RGBA raster', () => {
    expect(img.width).toBe(WAVE_ARROW_IMAGE_PX);
    expect(img.height).toBe(WAVE_ARROW_IMAGE_PX);
    expect(img.data).toHaveLength(WAVE_ARROW_IMAGE_PX * WAVE_ARROW_IMAGE_PX * 4);
  });

  it('points up: the head row is wider than the shaft row', () => {
    const inkWidth = (y: number) =>
      Array.from({ length: img.width }, (_, x) => x).filter((x) => inkAt(x, y) && alphaAt(x, y))
        .length;
    const head = Math.round(img.height * 0.4);
    const shaft = Math.round(img.height * 0.75);
    expect(inkWidth(head)).toBeGreaterThan(inkWidth(shaft));
    expect(inkWidth(shaft)).toBeGreaterThan(0);
    // Transparent corners.
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(img.width - 1, img.height - 1)).toBe(0);
  });

  it('draws in WAVE_ARROW_COLOR, not the barbs’ black ink', () => {
    const mid = (Math.round(img.height * 0.75) * img.width + img.width / 2) * 4;
    const hex = `#${[0, 1, 2].map((c) => img.data[mid + c]!.toString(16).padStart(2, '0')).join('')}`;
    expect(hex.toUpperCase()).toBe(WAVE_ARROW_COLOR);
  });
});

describe('formatSeaStateM', () => {
  it('uses the locale decimal separator and keeps the 1.25 edge', () => {
    expect(formatSeaStateM(1.25, 'de')).toBe('1,25');
    expect(formatSeaStateM(0.5, 'en')).toBe('0.5');
  });

  // R2-4: the printed figure must name the same band as the raw value.
  it.each([
    [2.46, '2.46', 'moderate'],
    [2.5, '2.5', 'rough'],
    [2.499, '2.49', 'moderate'],
    [0.096, '0.09', 'calm'],
  ] as const)('%s m prints %s, inside its %s band', (h, text, band) => {
    expect(formatSeaStateM(h, 'en')).toBe(text);
    expect(seaStateBand(h)).toBe(band);
    expect(seaStateBand(Number(text))).toBe(band);
  });

  // R3-1: heights arrive as Float32, e.g. fround(0.7) = 0.699999988.
  it.each([
    [0.7, '0.7', '0,7'],
    [0.9, '0.9', '0,9'],
    [1.3, '1.3', '1,3'],
    [1.4, '1.4', '1,4'],
    [2.499, '2.49', '2,49'],
    [2.5, '2.5', '2,5'],
  ] as const)('fround(%s) prints %s / %s', (h, en, de) => {
    expect(formatSeaStateM(Math.fround(h), 'en')).toBe(en);
    expect(formatSeaStateM(Math.fround(h), 'de')).toBe(de);
  });

  it('prints Float32 heights from a wave grid at their own value', () => {
    const heights = [0.7, 0.9, 1.3, 1.4];
    const grid = makeWaveGrid((_, lo) => ({ heightM: heights[lo]!, periodS: 4, dirFromDeg: 0 }), {
      lats: [54.5],
      lons: [10.0, 10.1, 10.2, 10.3],
    });
    const printed = wavePointsAtHour(grid, 0).map((p) => formatSeaStateM(p.heightM, 'en'));
    expect(printed).toEqual(['0.7', '0.9', '1.3', '1.4']);
  });

  it('does not snap across a band edge', () => {
    // The largest Float32 below 0.1: calm, so it must not print as 0.1.
    const h = 0.09999999403953552;
    expect(Math.fround(h)).toBe(h);
    expect(seaStateBand(h)).toBe('calm');
    expect(formatSeaStateM(h, 'en')).toBe('0.09');
  });
});
