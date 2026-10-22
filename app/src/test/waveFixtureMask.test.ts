import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NavMask } from '../lib/mask';
import type { MaskMeta } from '../types';
import { buildWaveFixture, E2E_NULL_POINT, N_LONS } from '../../scripts/wave-fixture.mjs';

// #1699: e2e/waves.spec.ts proves a null point is no data, never calm, at
// E2E_NULL_POINT. The overlay culls land and out-of-mask points, so that
// proof holds only if the point and its four neighbours are water in the
// committed mask; a mask rebuild must re-pick the point, not quietly pass.
const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const meta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const mask = new NavMask(meta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));

// openMeteo.ts's lattice: 54.3N/9.4E, 0.1° steps.
const at = (latIdx: number, lonIdx: number) => ({
  lat: Number((54.3 + latIdx * 0.1).toFixed(1)),
  lon: Number((9.4 + lonIdx * 0.1).toFixed(1)),
});

describe('wave fixture e2e null point vs the committed mask (#1699)', () => {
  const [la, lo] = E2E_NULL_POINT;
  const cases = {
    centre: [la, lo],
    north: [la + 1, lo],
    south: [la - 1, lo],
    east: [la, lo + 1],
    west: [la, lo - 1],
  } as const;

  it.each(Object.entries(cases))('%s is water', (_, [i, j]) => {
    const p = at(i, j);
    expect(mask.inBounds(p)).toBe(true);
    expect(mask.depthM(p)).toBeGreaterThan(0);
  });

  it('the south neighbour is calm in the fixture', () => {
    const fixture = buildWaveFixture(1_800_000_000);
    expect(fixture[(la - 1) * N_LONS + lo]!.hourly.wave_height[0]).toBeLessThan(0.1);
  });

  // Positive control: the probe can see land (54.9N 10.6E, the old point's
  // east neighbour).
  it('reads a known land point as land', () => {
    expect(mask.depthM({ lat: 54.9, lon: 10.6 })).toBe(0);
  });
});
