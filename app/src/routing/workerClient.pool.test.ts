import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_TIMEOUT_GRACE_MS, RoutingClient, RoutingError } from './workerClient';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { polarKey } from '../data/boats';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, type PlanRequest, type PolarTable } from '../types';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function fakeWorker() {
  return {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as ((e: MessageEvent) => void) | null,
    posted: [] as unknown[],
    transfers: [] as unknown[][],
    terminate: vi.fn(),
    postMessage(m: unknown, transfer?: unknown[]) {
      this.posted.push(m);
      this.transfers.push(transfer ?? []);
    },
    emit(m: WorkerResponse) {
      this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
    },
  };
}

function pool() {
  const ladder = fakeWorker();
  const solver = fakeWorker();
  const client = new RoutingClient(() => ladder as unknown as Worker, {
    solverFactory: () => solver as unknown as Worker,
    poolSize: 2,
  });
  return { ladder, solver, client };
}

const assets = () => ({
  maskMeta: TEST_MASK_META,
  maskBuffer: new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200).buffer,
  polars: {
    [polarKey('salona-45', 'genoa')]: TEST_POLAR,
    [polarKey('salona-45', 'fock')]: FOCK,
  },
  knownDisconnectedHarborIds: [],
});

const REQUEST: PlanRequest = {
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

describe('RoutingClient with a sibling solve worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives each worker its own mask copy and joins them with a port', () => {
    const { ladder, solver, client } = pool();
    const a = assets();
    const original = a.maskBuffer;
    void client.init(a);

    const ladderInit = ladder.posted[0] as Extract<WorkerRequest, { type: 'init' }>;
    const solverInit = solver.posted[0] as {
      type: string;
      maskBuffer: ArrayBuffer;
      port: MessagePort;
    };
    expect(ladderInit.type).toBe('init');
    expect(ladderInit.maskBuffer).toBe(original);
    expect(solverInit.type).toBe('init-solver');
    expect(solverInit.maskBuffer).not.toBe(original);
    expect(solverInit.maskBuffer.byteLength).toBe(original.byteLength);
    expect(new Uint8Array(solverInit.maskBuffer)[0]).toBe(200);
    expect(ladder.transfers[0]).toEqual([original, ladderInit.solverPort]);
    expect(solver.transfers[0]).toEqual([solverInit.maskBuffer, solverInit.port]);
    expect(ladderInit.solverPort).toBeInstanceOf(MessagePort);
    expect(solverInit.port).toBeInstanceOf(MessagePort);
    ladderInit.solverPort?.close();
    solverInit.port.close();
  });

  it('is ready only once both workers are', async () => {
    const { ladder, solver, client } = pool();
    let ready = false;
    void client.init(assets()).then(() => {
      ready = true;
    });
    ladder.emit({ type: 'ready' });
    await Promise.resolve();
    expect(ready).toBe(false);
    solver.emit({ type: 'ready' });
    await Promise.resolve();
    expect(ready).toBe(true);
    (ladder.posted[0] as { solverPort?: MessagePort }).solverPort?.close();
    ((solver.posted[0] as { port: MessagePort }).port as MessagePort).close();
  });

  it('cancel terminates every pool member', async () => {
    const { ladder, solver, client } = pool();
    void client.init(assets());
    ladder.emit({ type: 'ready' });
    solver.emit({ type: 'ready' });
    const p = client.plan(REQUEST, uniformWindGrid(12, 0));
    const outcome = p.catch((e: unknown) => e);
    await Promise.resolve();
    await Promise.resolve();
    client.cancel();
    const err = await outcome;
    expect(err).toBeInstanceOf(RoutingError);
    expect((err as RoutingError).kind).toBe('cancelled');
    expect(ladder.terminate).toHaveBeenCalledTimes(1);
    expect(solver.terminate).toHaveBeenCalledTimes(1);
    (ladder.posted[0] as { solverPort?: MessagePort }).solverPort?.close();
    ((solver.posted[0] as { port: MessagePort }).port as MessagePort).close();
  });

  it('a progress message from the sibling reaches the plan callback', async () => {
    const { ladder, solver, client } = pool();
    void client.init(assets());
    ladder.emit({ type: 'ready' });
    solver.emit({ type: 'ready' });
    const seen: string[] = [];
    void client
      .plan(REQUEST, uniformWindGrid(12, 0), (sailId) => seen.push(sailId))
      .catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    const sent = ladder.posted.find((m) => (m as WorkerRequest).type === 'plan') as Extract<
      WorkerRequest,
      { type: 'plan' }
    >;
    solver.emit({ type: 'progress', id: sent.id, sailId: 'fock', tMs: 1, frontierSize: 1 });
    expect(seen).toEqual(['fock']);
    client.dispose();
    (ladder.posted[0] as { solverPort?: MessagePort }).solverPort?.close();
    ((solver.posted[0] as { port: MessagePort }).port as MessagePort).close();
  });

  it('a sibling crash rejects the plan as worker-error', async () => {
    const { ladder, solver, client } = pool();
    void client.init(assets());
    ladder.emit({ type: 'ready' });
    solver.emit({ type: 'ready' });
    const outcome = client.plan(REQUEST, uniformWindGrid(12, 0)).catch((e: unknown) => e);
    await Promise.resolve();
    await Promise.resolve();
    solver.onerror?.({ message: 'boom' } as ErrorEvent);
    const err = await outcome;
    expect(err).toBeInstanceOf(RoutingError);
    expect((err as RoutingError).kind).toBe('worker-error');
    client.dispose();
    (ladder.posted[0] as { solverPort?: MessagePort }).solverPort?.close();
    ((solver.posted[0] as { port: MessagePort }).port as MessagePort).close();
  });

  it('a sibling messageerror rejects the plan as messageerror', async () => {
    const { ladder, solver, client } = pool();
    void client.init(assets());
    ladder.emit({ type: 'ready' });
    solver.emit({ type: 'ready' });
    const outcome = client.plan(REQUEST, uniformWindGrid(12, 0)).catch((e: unknown) => e);
    await Promise.resolve();
    await Promise.resolve();
    solver.onmessageerror?.({} as MessageEvent);
    const err = await outcome;
    expect(err).toBeInstanceOf(RoutingError);
    expect((err as RoutingError).kind).toBe('messageerror');
    client.dispose();
    (ladder.posted[0] as { solverPort?: MessagePort }).solverPort?.close();
    ((solver.posted[0] as { port: MessagePort }).port as MessagePort).close();
  });
});

describe('liveness with two rigs in flight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const TIMEOUT_MS = PLAN_TIMEOUT_GRACE_MS + 60_000;

  async function started() {
    vi.useFakeTimers();
    const { ladder, solver, client } = pool();
    void client.init(assets());
    ladder.emit({ type: 'ready' });
    solver.emit({ type: 'ready' });
    const outcome = client.plan(REQUEST, uniformWindGrid(12, 0), undefined, TIMEOUT_MS).then(
      () => 'resolved',
      (e: unknown) => (e instanceof RoutingError ? e.kind : 'other'),
    );
    await vi.advanceTimersByTimeAsync(0);
    const sent = ladder.posted.find((m) => (m as WorkerRequest).type === 'plan') as Extract<
      WorkerRequest,
      { type: 'plan' }
    >;
    return { ladder, solver, client, outcome, id: sent.id };
  }

  it('a chatty rig cannot keep a silent one alive past the original deadline', async () => {
    const { ladder, solver, outcome, id } = await started();
    ladder.emit({ type: 'sailStart', id, sailId: 'genoa', solveId: 0 });
    ladder.emit({ type: 'sailStart', id, sailId: 'fock', solveId: 1 });
    solver.emit({ type: 'progress', id, sailId: 'fock', tMs: 1, frontierSize: 1 });
    let state = 'pending';
    void outcome.then((k) => {
      state = k;
    });
    for (let t = 0; t < TIMEOUT_MS + 3 * PLAN_TIMEOUT_GRACE_MS; t += 5_000) {
      ladder.emit({ type: 'progress', id, sailId: 'genoa', tMs: t, frontierSize: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(state).toBe('timeout');
  });

  it('control: both rigs chatty keeps the plan alive past the original deadline', async () => {
    const { ladder, solver, outcome, id } = await started();
    ladder.emit({ type: 'sailStart', id, sailId: 'genoa', solveId: 0 });
    ladder.emit({ type: 'sailStart', id, sailId: 'fock', solveId: 1 });
    let state = 'pending';
    void outcome.then((k) => {
      state = k;
    });
    for (let t = 0; t < TIMEOUT_MS + 3 * PLAN_TIMEOUT_GRACE_MS; t += 5_000) {
      ladder.emit({ type: 'progress', id, sailId: 'genoa', tMs: t, frontierSize: 1 });
      solver.emit({ type: 'progress', id, sailId: 'fock', tMs: t, frontierSize: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(state).toBe('pending');
  });

  it('a finished rig is not waited on: its silence does not time the plan out', async () => {
    const { ladder, solver, outcome, id } = await started();
    ladder.emit({ type: 'sailStart', id, sailId: 'genoa', solveId: 0 });
    ladder.emit({ type: 'sailStart', id, sailId: 'fock', solveId: 1 });
    solver.emit({ type: 'sailDone', id, sailId: 'fock', solveId: 1 });
    let state = 'pending';
    void outcome.then((k) => {
      state = k;
    });
    for (let t = 0; t < TIMEOUT_MS + 3 * PLAN_TIMEOUT_GRACE_MS; t += 5_000) {
      ladder.emit({ type: 'progress', id, sailId: 'genoa', tMs: t, frontierSize: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(state).toBe('pending');
  });

  it('a done that outruns its start still counts as finished', async () => {
    const { ladder, solver, outcome, id } = await started();
    solver.emit({ type: 'sailDone', id, sailId: 'fock', solveId: 1 });
    ladder.emit({ type: 'sailStart', id, sailId: 'genoa', solveId: 0 });
    ladder.emit({ type: 'sailStart', id, sailId: 'fock', solveId: 1 });
    let state = 'pending';
    void outcome.then((k) => {
      state = k;
    });
    for (let t = 0; t < TIMEOUT_MS + 3 * PLAN_TIMEOUT_GRACE_MS; t += 5_000) {
      ladder.emit({ type: 'progress', id, sailId: 'genoa', tMs: t, frontierSize: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(state).toBe('pending');
  });
});
