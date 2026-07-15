import { describe, expect, it } from 'vitest';
import { createHandler, type WorkerResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function openWaterBuffer(): ArrayBuffer {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  return data.buffer;
}

describe('worker protocol handler', () => {
  it('answers init with ready, plan with progress + result', () => {
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({
      type: 'init',
      maskMeta: TEST_MASK_META,
      maskBuffer: openWaterBuffer(),
      polarGenoa: TEST_POLAR,
      polarFock: FOCK,
    });
    expect(out).toEqual([{ type: 'ready' }]);

    handle({
      type: 'plan',
      id: 'p1',
      request: {
        // cell centers (grid step 0.005°), per 449af00: keep the spec-mandated
        // 300 m snap radius and adapt test geometry rather than loosen it.
        origin: { lat: 54.7525, lon: 10.0025 }, destination: { lat: 54.7525, lon: 10.3025 },
        originHarborId: null, destinationHarborId: null,
        departureMs: Date.UTC(2026, 6, 15, 8, 0, 0), settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(12, 0),
    });
    const result = out.find((m) => m.type === 'result');
    expect(result && result.type === 'result' && result.result.status).toBe('ok');
    expect(out.some((m) => m.type === 'progress')).toBe(true);
  });

  it('plan before init → fatal', () => {
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({ type: 'plan', id: 'p1' } as never);
    expect(out[0].type).toBe('fatal');
  });
});
