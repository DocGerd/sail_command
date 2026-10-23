import { describe, expect, it } from 'vitest';
import { storedForecastRunOptions } from './storedForecast';
import { uniformWindGrid } from '../test/fixtures';
import { makeWaveGrid } from '../test/waveFixtures';

const windGrid = uniformWindGrid(12, 225);
const waveGrid = makeWaveGrid((la, lo, t) => ({
  heightM: 0.5 + la + lo / 10 + t / 100,
  periodS: 4,
  dirFromDeg: 200,
}));

describe('storedForecastRunOptions (#1699)', () => {
  it('carries a clone of the wave grid, never an alias', () => {
    const opts = storedForecastRunOptions({ windGrid, waveGrid });
    expect(opts.storedWaveGrid).toEqual(waveGrid);
    expect(opts.storedWaveGrid).not.toBe(waveGrid);
    expect(opts.storedWaveGrid?.waveHeightM.buffer).not.toBe(waveGrid.waveHeightM.buffer);
  });

  it('carries no wave key for a plan without a wave grid', () => {
    const opts = storedForecastRunOptions({ windGrid });
    expect('storedWaveGrid' in opts).toBe(false);
  });

  it('carries a clone of the wind grid either way', () => {
    for (const plan of [{ windGrid }, { windGrid, waveGrid }]) {
      const opts = storedForecastRunOptions(plan);
      expect(opts.storedWindGrid).toEqual(windGrid);
      expect(opts.storedWindGrid?.speedKn.buffer).not.toBe(windGrid.speedKn.buffer);
    }
  });
});
