import { describe, expect, it } from 'vitest';
import {
  formatSeaStateM,
  travelDeg,
  WAVE_ARROW_COLOR,
  WAVE_ARROW_IMAGE_PX,
  waveArrowImage,
  waveFeaturesAt,
} from './waveMap';
import { makeWaveGrid, waveTestMask } from '../test/waveFixtures';
import { seaStateBand, wavePointsAtHour } from './waves';

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);
const WATER = waveTestMask();

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

describe('waveFeaturesAt (#1699)', () => {
  it('centres a cell on its grid point, half a lattice step each way', () => {
    const grid = makeWaveGrid(() => ({ heightM: 0.3, periodS: 4, dirFromDeg: 0 }), {
      lats: [54.5, 54.6],
      lons: [10.0, 10.1, 10.2],
    });
    const ring = waveFeaturesAt(grid, T0, WATER).cells.features[0]!.geometry.coordinates[0]!;
    const r = (v: number) => Number(v.toFixed(6));
    expect(ring.map(([x, y]) => [r(x!), r(y!)])).toEqual([
      [9.95, 54.45],
      [10.05, 54.45],
      [10.05, 54.55],
      [9.95, 54.55],
      [9.95, 54.45],
    ]);
  });

  it('gives a no-data or negative Hs no cell and no arrow', () => {
    const grid = makeWaveGrid((la) => ({
      heightM: la === 0 ? NaN : la === 1 ? -1 : 0,
      periodS: 3,
      dirFromDeg: 45,
    }));
    const { cells, arrows } = waveFeaturesAt(grid, T0, WATER);
    expect(cells.features.map((f) => f.properties.band)).toEqual(['calm', 'calm']);
    expect(arrows.features).toHaveLength(2);
  });

  it('leaves non-finite period and direction out of the properties', () => {
    const grid = makeWaveGrid(() => ({ heightM: 1, periodS: NaN, dirFromDeg: NaN }));
    const { cells, arrows } = waveFeaturesAt(grid, T0, WATER);
    expect(cells.features[0]!.properties).toEqual({ band: 'slight', heightM: 1 });
    expect(arrows.features).toHaveLength(0);
  });
});

// The marine API can answer a land point with a nearby sea cell's value, so only
// the mask can say the point itself is land.
describe('waveFeaturesAt land culling (#1699)', () => {
  const grid = makeWaveGrid(() => ({ heightM: 0.8, periodS: 4, dirFromDeg: 90 }), {
    lats: [54.5],
    lons: [10.0, 10.1, 10.2],
  });
  const lons = (fc: { features: { geometry: { coordinates: unknown } }[] }) =>
    fc.features.map((f) => f.geometry.coordinates);

  it('drops a land point with a finite Hs: no cell (so no edge) and no arrow', () => {
    const mask = waveTestMask((_, lon) => (lon === 10.1 ? 0 : 50));
    const { cells, arrows } = waveFeaturesAt(grid, T0, mask);
    expect(cells.features.map((f) => f.properties.heightM)).toHaveLength(2);
    expect(lons(arrows)).toEqual([
      [10.0, 54.5],
      [10.2, 54.5],
    ]);
  });

  it('keeps water points, shallow water (0.1 m) included', () => {
    const mask = waveTestMask((_, lon) => (lon === 10.1 ? 1 : 50));
    const { cells, arrows } = waveFeaturesAt(grid, T0, mask);
    expect(cells.features).toHaveLength(3);
    expect(arrows.features).toHaveLength(3);
  });

  it('drops a point outside the mask: no land/water answer there', () => {
    const edge = makeWaveGrid(() => ({ heightM: 0.8, periodS: 4, dirFromDeg: 90 }), {
      lats: [54.5],
      lons: [10.5, 10.6],
    });
    const mask = waveTestMask();
    expect(mask.inBounds({ lat: 54.5, lon: 10.6 })).toBe(false);
    const { cells, arrows } = waveFeaturesAt(edge, T0, mask);
    expect(lons(arrows)).toEqual([[10.5, 54.5]]);
    expect(cells.features).toHaveLength(1);
  });

  it('still gives a no-data point on water no feature', () => {
    const nulls = makeWaveGrid(
      (_, lo) => ({
        heightM: lo === 1 ? NaN : 0.05,
        periodS: 4,
        dirFromDeg: 90,
      }),
      { lats: [54.5], lons: [10.0, 10.1, 10.2] },
    );
    const { cells } = waveFeaturesAt(nulls, T0, waveTestMask());
    expect(cells.features.map((f) => f.properties.band)).toEqual(['calm', 'calm']);
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
