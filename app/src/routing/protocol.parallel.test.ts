import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHandler,
  createSolverHandler,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_BOAT_ID, polarKey } from '../data/boats';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type PlanRequest,
  type PolarTable,
  type SailId,
} from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const POLARS: Record<string, PolarTable> = {
  [polarKey(DEFAULT_BOAT_ID, 'genoa')]: TEST_POLAR,
  [polarKey(DEFAULT_BOAT_ID, 'fock')]: FOCK,
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
const WALL_REQ: PlanRequest = {
  ...OPEN_REQ,
  destination: { lat: 54.7525, lon: 10.2275 },
};

function planMsg(
  id: string,
  request: PlanRequest,
  extra: { budgetMs?: number; polarKeys?: readonly string[] } = {},
): WorkerRequest {
  return {
    type: 'plan',
    id,
    request,
    boatId: DEFAULT_BOAT_ID,
    polarKeys: extra.polarKeys ?? KEYS,
    windGrid: uniformWindGrid(12, 0),
    ...(extra.budgetMs !== undefined ? { budgetMs: extra.budgetMs } : {}),
  };
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

/** The single-worker handler: messages arrive synchronously. */
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

/** Ladder handler plus sibling solver, joined by a real MessageChannel. */
function pooled(mask: () => ArrayBuffer) {
  const ladderOut: WorkerResponse[] = [];
  const solverOut: WorkerResponse[] = [];
  const channel = new MessageChannel();
  channels.push(channel);
  createSolverHandler((m) => solverOut.push(m))({
    type: 'init-solver',
    maskMeta: TEST_MASK_META,
    maskBuffer: mask(),
    polars: POLARS,
    port: channel.port2,
  });
  const handle = createHandler((m) => ladderOut.push(m));
  handle({
    type: 'init',
    maskMeta: TEST_MASK_META,
    maskBuffer: mask(),
    polars: POLARS,
    knownDisconnectedHarborIds: [],
    solverPort: channel.port1,
  });
  const settled = async (id: string): Promise<WorkerResponse> => {
    const terminal = (m: WorkerResponse) =>
      (m.type === 'result' || m.type === 'fatal') && m.id === id;
    await vi.waitFor(() => expect(ladderOut.some(terminal)).toBe(true), { timeout: 60_000 });
    return ladderOut.find(terminal)!;
  };
  return { ladderOut, solverOut, handle, settled };
}

const resultOf = (out: readonly WorkerResponse[], id: string) =>
  out.find((m) => m.type === 'result' && m.id === id);
const sailsOf = (out: readonly WorkerResponse[], type: 'progress', id: string): Set<SailId> =>
  new Set(out.flatMap((m) => (m.type === type && m.id === id ? [m.sailId] : [])));

describe('sibling solve worker over a MessagePort', () => {
  it('returns the single-worker result, with the second rig solved on the sibling', async () => {
    const seq = sequential(openMask);
    seq.handle(planMsg('a', OPEN_REQ));
    const pool = pooled(openMask);
    pool.handle(planMsg('a', OPEN_REQ));
    const done = await pool.settled('a');

    expect(done).toEqual(resultOf(seq.out, 'a'));
    expect(done.type).toBe('result');
    expect([...sailsOf(pool.ladderOut, 'progress', 'a')]).toEqual(['genoa']);
    expect([...sailsOf(pool.solverOut, 'progress', 'a')]).toEqual(['fock']);

    const starts = pool.ladderOut.filter((m) => m.type === 'sailStart');
    const dones = [...pool.ladderOut, ...pool.solverOut].filter((m) => m.type === 'sailDone');
    expect(starts.map((m) => m.sailId)).toEqual(['genoa', 'fock']);
    expect(dones.map((m) => m.sailId).sort()).toEqual(['fock', 'genoa']);
    // Every start is paired with exactly one done by solve id.
    expect(dones.map((m) => m.solveId).sort()).toEqual(starts.map((m) => m.solveId).sort());
  });

  it('degrades through relaxation with the same probes and shallow result', async () => {
    const seq = sequential(wallMask);
    seq.handle(planMsg('w', WALL_REQ));
    const pool = pooled(wallMask);
    pool.handle(planMsg('w', WALL_REQ));
    expect(await pool.settled('w')).toEqual(resultOf(seq.out, 'w'));
    const probes = (out: readonly WorkerResponse[]) => out.filter((m) => m.type === 'probe');
    expect(probes(pool.ladderOut)).toEqual(probes(seq.out));
    expect(probes(seq.out)).not.toHaveLength(0);
    const r = resultOf(pool.ladderOut, 'w');
    expect(r?.type === 'result' && r.result.status === 'ok' && r.result.shallow?.usedDepthM).toBe(
      2.5,
    );
  });

  it('runs queued plans one at a time, in order', async () => {
    const pool = pooled(openMask);
    pool.handle(planMsg('first', OPEN_REQ));
    pool.handle(planMsg('second', WALL_REQ));
    await pool.settled('second');
    const order = pool.ladderOut.filter((m) => m.type === 'result').map((m) => m.id);
    expect(order).toEqual(['first', 'second']);
    // No progress for the second plan before the first one's result.
    const firstResult = pool.ladderOut.findIndex((m) => m.type === 'result' && m.id === 'first');
    expect(pool.ladderOut.slice(0, firstResult).some((m) => 'id' in m && m.id === 'second')).toBe(
      false,
    );
  });

  it('reports a sibling-side failure as the same fatal the single worker raises', async () => {
    const seq = sequential(openMask);
    seq.handle(planMsg('f', OPEN_REQ, { polarKeys: [KEYS[0]] }));
    const pool = pooled(openMask);
    pool.handle(planMsg('f', OPEN_REQ, { polarKeys: [KEYS[0]] }));
    const done = await pool.settled('f');
    const expected = seq.out.find((m) => m.type === 'fatal');
    expect(expected?.type).toBe('fatal');
    expect(done.type).toBe('fatal');
    expect(done.type === 'fatal' && done.message).toBe(
      expected?.type === 'fatal' && expected.message,
    );
  });

  it('a spent budget cuts both rigs, as on the single worker', async () => {
    const seq = sequential(openMask);
    seq.handle(planMsg('b', OPEN_REQ, { budgetMs: 0 }));
    const pool = pooled(openMask);
    pool.handle(planMsg('b', OPEN_REQ, { budgetMs: 0 }));
    const done = await pool.settled('b');
    expect(done).toEqual(resultOf(seq.out, 'b'));
    expect(done.type === 'result' && done.result).toEqual({
      status: 'error',
      reason: 'search-budget-exceeded',
    });
  });
});
