import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createHandler,
  createSolverHandler,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_BOAT_ID, polarKey } from '../data/boats';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, type PlanRequest, type PolarTable } from '../types';
import { SOLVER_TEST_TIMEOUT_MS, solverTimeoutMs } from '../test/timeouts';

// #1777: per-solve console lines. The client-side lines live in
// workerClient.planLog.test.ts.

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const POLARS: Record<string, PolarTable> = {
  [polarKey(DEFAULT_BOAT_ID, 'genoa')]: TEST_POLAR,
  [polarKey(DEFAULT_BOAT_ID, 'fock')]: { ...TEST_POLAR, rig: 'fock' },
};
const KEYS = Object.keys(POLARS);

function openMask(): ArrayBuffer {
  return new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200).buffer;
}

/** Rows 85..105 corridor split by a wall whose only gap is charted 2.5 m. */
function wallMask(): ArrayBuffer {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols);
  for (let r = 0; r < TEST_MASK_META.rows; r++)
    for (let c = 0; c < TEST_MASK_META.cols; c++) {
      let byte = 0;
      if (r >= 85 && r <= 105) byte = c !== 160 ? 200 : r >= 90 && r <= 99 ? 25 : 0;
      data[r * TEST_MASK_META.cols + c] = byte;
    }
  return data.buffer;
}

const OPEN_REQ: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.3025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
  boat: defaultBoatSnapshot(),
};
const WALL_REQ: PlanRequest = { ...OPEN_REQ, destination: { lat: 54.7525, lon: 10.2275 } };

const planMsg = (id: string, request: PlanRequest): WorkerRequest => ({
  type: 'plan',
  id,
  request,
  boatId: DEFAULT_BOAT_ID,
  polarKeys: KEYS,
  windGrid: uniformWindGrid(12, 0),
});

const channels: MessageChannel[] = [];
let info: MockInstance<typeof console.info>;
beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
  vi.restoreAllMocks();
});

const solveLines = (): Record<string, unknown>[] =>
  info.mock.calls
    .filter((c) => c[0] === '[SailCommand] solve finished')
    .map((c) => c[1] as Record<string, unknown>);

function sequential(mask: () => ArrayBuffer) {
  const out: WorkerResponse[] = [];
  const handle = createHandler((m) => out.push(m));
  handle({
    type: 'init',
    maskMeta: TEST_MASK_META,
    maskBuffer: mask(),
    polars: POLARS,
    knownDisconnectedHarborIds: [],
  });
  return { out, handle };
}

function pooled(mask: () => ArrayBuffer) {
  const out: WorkerResponse[] = [];
  const channel = new MessageChannel();
  channels.push(channel);
  createSolverHandler(() => {})({
    type: 'init-solver',
    maskMeta: TEST_MASK_META,
    maskBuffer: mask(),
    polars: POLARS,
    port: channel.port2,
  });
  const handle = createHandler((m) => out.push(m));
  handle({
    type: 'init',
    maskMeta: TEST_MASK_META,
    maskBuffer: mask(),
    polars: POLARS,
    knownDisconnectedHarborIds: [],
    solverPort: channel.port1,
  });
  const settled = async (id: string) =>
    vi.waitFor(() => expect(out.some((m) => m.type === 'result' && m.id === id)).toBe(true), {
      timeout: solverTimeoutMs(60_000),
    });
  return { handle, settled };
}

describe('protocol console logging (#1777)', () => {
  it('single-worker path: one line per sail from the final result, without cause or elapsed', () => {
    const { handle, out } = sequential(openMask);
    handle(planMsg('s1', OPEN_REQ));

    expect(out.some((m) => m.type === 'result')).toBe(true);
    const lines = solveLines();
    expect(lines.map((l) => [l.planId, l.sail, l.status, l.reason])).toEqual([
      ['s1', 'genoa', 'ok', null],
      ['s1', 'fock', 'ok', null],
    ]);
    for (const l of lines) {
      expect(l).not.toHaveProperty('cause');
      expect(l).not.toHaveProperty('elapsedMs');
    }
  });

  it('pool path: one line per rig solve with the cause and the solve time, from both workers', async () => {
    const pool = pooled(openMask);
    pool.handle(planMsg('p1', OPEN_REQ));
    await pool.settled('p1');

    const lines = solveLines();
    expect(lines.map((l) => l.sail).sort()).toEqual(['fock', 'genoa']);
    for (const l of lines) {
      expect(l).toMatchObject({
        planId: 'p1',
        status: 'ok',
        cause: null,
        gateM: DEFAULT_SETTINGS.safetyDepthM,
        secondPass: false,
      });
      expect(typeof l.elapsedMs).toBe('number');
      expect(l.elapsedMs as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('pool path: a rig that finds no route logs the internal cause', async () => {
    const calm: PlanRequest = {
      ...OPEN_REQ,
      settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    };
    const pool = pooled(openMask);
    pool.handle({ ...planMsg('c1', calm), windGrid: uniformWindGrid(0.5, 0) } as WorkerRequest);
    await pool.settled('c1');

    const lines = solveLines();
    const failed = lines.filter((l) => l.status === 'no-route');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((l) => l.cause === 'calm-without-motor')).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it('pool path: a relaxed tier is logged at its relaxed gate', async () => {
    const pool = pooled(wallMask);
    pool.handle(planMsg('w1', WALL_REQ));
    await pool.settled('w1');

    expect(solveLines().map((l) => [l.sail, l.gateM]).sort()).toEqual([
      ['fock', 2.5],
      ['genoa', 2.5],
    ]);
  });
});
