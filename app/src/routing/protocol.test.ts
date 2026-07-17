import { describe, expect, it, vi } from 'vitest';
import { createHandler, type WorkerResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: 120_000 });

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
        // cell centers (grid step 0.005°): keep the spec-mandated 300 m snap
        // radius and adapt test geometry rather than loosen it.
        origin: { lat: 54.7525, lon: 10.0025 },
        destination: { lat: 54.7525, lon: 10.3025 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
        settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(12, 0),
    });
    const result = out.find((m) => m.type === 'result');
    expect(result && result.type === 'result' && result.result.status).toBe('ok');
    expect(out.some((m) => m.type === 'progress')).toBe(true);
  });

  it('a depth-unreachable plan degrades through the worker: probe messages, then a shallow result (#53)', () => {
    // E-W corridor (rows 85..105) split by a wall at col 160 whose only
    // opening (rows 90..99) is charted 2.5 m — unreachable at the default
    // 3.0 m, connected at gates <= 2.5 m.
    const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols);
    for (let r = 0; r < TEST_MASK_META.rows; r++)
      for (let c = 0; c < TEST_MASK_META.cols; c++) {
        let byte = 0;
        if (r >= 85 && r <= 105) byte = c !== 160 ? 200 : r >= 90 && r <= 99 ? 25 : 0;
        data[r * TEST_MASK_META.cols + c] = byte;
      }
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({
      type: 'init',
      maskMeta: TEST_MASK_META,
      maskBuffer: data.buffer,
      polarGenoa: TEST_POLAR,
      polarFock: FOCK,
    });
    handle({
      type: 'plan',
      id: 'p53',
      request: {
        origin: { lat: 54.7525, lon: 10.0025 },
        destination: { lat: 54.7525, lon: 10.4025 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
        settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(12, 0),
    });
    const probes = out.filter((m) => m.type === 'probe');
    // Hand-derived binary search over candidates 2.1..2.9: 2.5 ok, 2.7 fail, 2.6 fail.
    expect(probes.map((m) => m.probeDepthM)).toEqual([2.5, 2.7, 2.6]);
    const result = out.find((m) => m.type === 'result');
    if (!result || result.type !== 'result' || result.result.status !== 'ok')
      throw new Error('expected an ok result');
    expect(result.result.shallow).toEqual({
      requestedDepthM: 3.0,
      usedDepthM: 2.5,
      minGateDepthM: 2.5,
    });
  });

  it('plan before init → fatal', () => {
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({ type: 'plan', id: 'p1' } as never);
    expect(out[0].type).toBe('fatal');
  });

  it('a real mid-plan throw (malformed windGrid, fix A4) reports fatal with the plan id, not null', () => {
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({
      type: 'init',
      maskMeta: TEST_MASK_META,
      maskBuffer: openWaterBuffer(),
      polarGenoa: TEST_POLAR,
      polarFock: FOCK,
    });
    const badWindGrid = { ...uniformWindGrid(12, 0), speedKn: new Float32Array(1) }; // mismatched length
    handle({
      type: 'plan',
      id: 'p1',
      request: {
        origin: { lat: 54.7525, lon: 10.0025 },
        destination: { lat: 54.7525, lon: 10.3025 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
        settings: DEFAULT_SETTINGS,
      },
      windGrid: badWindGrid,
    });
    const fatal = out.find((m) => m.type === 'fatal');
    expect(fatal).toMatchObject({ type: 'fatal', id: 'p1' });
  });
});
