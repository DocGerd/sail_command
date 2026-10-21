import { describe, expect, it, vi } from 'vitest';
import { createSolverHandler, type SolverPortRequest, type SolverPortResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_BOAT_ID, polarKey } from '../data/boats';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const POLARS: Record<string, PolarTable> = {
  [polarKey(DEFAULT_BOAT_ID, 'genoa')]: TEST_POLAR,
  [polarKey(DEFAULT_BOAT_ID, 'fock')]: FOCK,
};

describe('sibling budget', () => {
  it('measures the budget from the plan start, not from its own solve start', async () => {
    const channel = new MessageChannel();
    createSolverHandler(() => {})({
      type: 'init-solver',
      maskMeta: TEST_MASK_META,
      maskBuffer: new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200).buffer,
      polars: POLARS,
      port: channel.port2,
    });
    const got = new Promise<SolverPortResponse>((resolve) => {
      channel.port1.onmessage = (e: MessageEvent<SolverPortResponse>) => resolve(e.data);
    });
    channel.port1.postMessage({
      type: 'ctx',
      ctxId: 0,
      planId: 'p',
      waypoints: [
        { lat: 54.7525, lon: 10.0025 },
        { lat: 54.7525, lon: 10.3025 },
      ],
      departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
      settings: DEFAULT_SETTINGS,
      segmentModes: undefined,
      sailIds: ['genoa', 'fock'],
      boatId: DEFAULT_BOAT_ID,
      polarKeys: Object.keys(POLARS),
      windGrid: uniformWindGrid(12, 0),
      planStartMs: Date.now() - 10_000,
      budgetMs: 5_000,
    } satisfies SolverPortRequest);
    channel.port1.postMessage({
      type: 'solve',
      stepId: 7,
      ctxId: 0,
      sailId: 'fock',
      gate: uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      comfortDepthM: undefined,
      secondPass: false,
    } satisfies SolverPortRequest);
    const m = await got;
    channel.port1.close();
    channel.port2.close();
    expect(m.type).toBe('solved');
    expect(m.type === 'solved' && m.run.rigResult).toBeNull();
    expect(m.type === 'solved' && m.run.cause).toBe('budget-exhausted');
  });
});
