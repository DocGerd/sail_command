import { describe, expect, it } from 'vitest';
import {
  formatSeaStateM,
  travelDeg,
  WAVE_ARROW_IMAGE_PX,
  waveArrowImage,
  waveFeaturesAt,
} from './waveMap';
import { makeWaveGrid } from '../test/waveFixtures';
import { seaStateBand } from './waves';

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

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
    const ring = waveFeaturesAt(grid, T0).cells.features[0]!.geometry.coordinates[0]!;
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
    const { cells, arrows } = waveFeaturesAt(grid, T0);
    expect(cells.features.map((f) => f.properties.band)).toEqual(['calm', 'calm']);
    expect(arrows.features).toHaveLength(2);
  });

  it('leaves non-finite period and direction out of the properties', () => {
    const grid = makeWaveGrid(() => ({ heightM: 1, periodS: NaN, dirFromDeg: NaN }));
    const { cells, arrows } = waveFeaturesAt(grid, T0);
    expect(cells.features[0]!.properties).toEqual({ band: 'slight', heightM: 1 });
    expect(arrows.features).toHaveLength(0);
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
});
