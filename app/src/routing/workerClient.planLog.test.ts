import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PLAN_TIMEOUT_GRACE_MS, RoutingClient } from './workerClient';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, type PlanRequest, type PlanResult } from '../types';

// #1777: the client's console log. Worker-side per-solve lines are covered by
// protocol.planLog.test.ts.

function fakeWorker() {
  const w = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as ((e: MessageEvent) => void) | null,
    posted: [] as WorkerRequest[],
    postMessage(m: WorkerRequest) {
      this.posted.push(m);
    },
    terminate: () => {},
    emit(m: WorkerResponse) {
      this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
    },
  };
  return w;
}

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

const NO_ROUTE: PlanResult = { status: 'error', reason: 'unreachable' };
const BUDGET_MS = 10_000;
const BUDGETED_TIMEOUT_MS = PLAN_TIMEOUT_GRACE_MS + BUDGET_MS;

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function started(req: PlanRequest = REQUEST, timeoutMs = BUDGETED_TIMEOUT_MS) {
  vi.useFakeTimers();
  const w = fakeWorker();
  const client = new RoutingClient(() => w as unknown as Worker);
  w.emit({ type: 'ready' });
  const p = client.plan(req, uniformWindGrid(12, 0), undefined, timeoutMs);
  const outcome = p.then(
    (r) => ({ ok: r }),
    (e: unknown) => ({ err: e }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const sent = w.posted[w.posted.length - 1];
  if (sent?.type !== 'plan') throw new Error('expected a plan message');
  return { w, client, id: sent.id, outcome };
}

const messages = (spy: MockInstance): string[] =>
  spy.mock.calls.map((c: unknown[]) => String(c[0]));

describe('RoutingClient console logging (#1777)', () => {
  it.each([
    ['a harbour origin and a tapped destination', { originHarborId: 'flensburg' }, 'flensburg', 'tap'],
    ['a tapped origin and a harbour destination', { destinationHarborId: 'marstal' }, 'tap', 'marstal'],
  ] as const)(
    'logs the plan start with ids only, never coordinates (%s)',
    async (_name, harbours, origin, destination) => {
      const { w, id, outcome } = await started({ ...REQUEST, ...harbours });
      const call = info.mock.calls.find((c) => c[0] === '[SailCommand] plan start');
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        planId: id,
        boat: REQUEST.boat.id,
        sails: ['genoa', 'fock'],
        origin,
        destination,
        vias: 0,
        departure: '2026-07-15T08:00:00.000Z',
        safetyDepthM: DEFAULT_SETTINGS.safetyDepthM,
        budgetMs: BUDGET_MS,
      });
      const text = JSON.stringify(info.mock.calls);
      expect(text).not.toContain('54.7525');
      expect(text).not.toContain('10.0025');
      expect(text).not.toContain('10.3025');
      w.emit({ type: 'result', id, result: NO_ROUTE });
      await outcome;
    },
  );

  it('logs a finished plan at info, and a no-route result at error with its reason', async () => {
    const ok = await started();
    const okResult: PlanResult = {
      status: 'ok',
      sails: [],
      recommended: 'fock',
      comparisonComplete: false,
      snappedOrigin: REQUEST.origin,
      snappedDestination: REQUEST.destination,
    };
    ok.w.emit({ type: 'result', id: ok.id, result: okResult });
    await ok.outcome;
    const finished = info.mock.calls.find((c) => c[0] === '[SailCommand] plan finished');
    expect(finished?.[1]).toMatchObject({
      planId: ok.id,
      status: 'ok',
      recommended: 'fock',
      comparisonComplete: false,
    });
    expect(error).not.toHaveBeenCalled();

    const bad = await started();
    bad.w.emit({
      type: 'result',
      id: bad.id,
      result: { status: 'error', reason: 'search-budget-exceeded' },
    });
    await bad.outcome;
    expect(error.mock.calls[0]?.[0]).toBe('[SailCommand] plan failed: no route');
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      planId: bad.id,
      reason: 'search-budget-exceeded',
    });
  });

  it('logs the typed failure kind, never one inferred from the message text', async () => {
    const { w, id, outcome } = await started();
    // The message names a different kind on purpose.
    w.emit({ type: 'fatal', id, message: 'timeout' });
    await outcome;
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe('[SailCommand] plan failed');
    expect(error.mock.calls[0]?.[1]).toMatchObject({ planId: id, kind: 'worker-fatal' });
    expect(error.mock.calls[0]?.[2]).toBeInstanceOf(Error);
  });

  it('logs a client-side rejection (boat outside the catalogue) with its kind', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });
    const outcome = client
      .plan(
        { ...REQUEST, boat: { ...REQUEST.boat, id: 'not-in-catalogue' } },
        uniformWindGrid(12, 0),
      )
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await outcome;
    expect(error.mock.calls[0]?.[1]).toMatchObject({ kind: 'boat-not-in-catalogue' });
  });

  it('logs a user cancel at info, not error', async () => {
    const { client, outcome } = await started();
    client.cancel();
    await outcome;
    expect(messages(info)).toContain('[SailCommand] plan cancelled');
    expect(error).not.toHaveBeenCalled();
  });

  it('warns once when the plan passes half its budget, and not before', async () => {
    const { w, id, outcome } = await started();
    await vi.advanceTimersByTimeAsync(BUDGET_MS / 2 - 1);
    expect(warn).not.toHaveBeenCalled();

    w.emit({ type: 'sailStart', id, sailId: 'genoa', solveId: 0 });
    await vi.advanceTimersByTimeAsync(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('[SailCommand] plan past half its budget');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      planId: id,
      budgetMs: BUDGET_MS,
      solving: ['genoa'],
    });

    await vi.advanceTimersByTimeAsync(BUDGET_MS / 2 - 5);
    expect(warn).toHaveBeenCalledTimes(1);
    w.emit({ type: 'result', id, result: NO_ROUTE });
    await outcome;
  });

  it('does not warn for a plan that settles before half its budget, or after a dispose', async () => {
    const fast = await started();
    await vi.advanceTimersByTimeAsync(1_000);
    fast.w.emit({ type: 'result', id: fast.id, result: NO_ROUTE });
    await fast.outcome;
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 2);

    const disposed = await started();
    disposed.client.dispose();
    await disposed.outcome;
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 2);

    expect(warn).not.toHaveBeenCalled();
  });

  it('never warns for an unbudgeted plan', async () => {
    const { w, id, outcome } = await started(REQUEST, 5_000);
    expect(info.mock.calls.find((c) => c[0] === '[SailCommand] plan start')?.[1]).toMatchObject({
      budgetMs: null,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(warn).not.toHaveBeenCalled();
    w.emit({ type: 'result', id, result: NO_ROUTE });
    await outcome;
  });

  it('stays at one start line however many progress messages arrive', async () => {
    const { w, id, outcome } = await started();
    for (let i = 0; i < 300; i++) {
      w.emit({ type: 'progress', id, sailId: 'genoa', tMs: i, frontierSize: 10 });
      w.emit({ type: 'probe', id, probeDepthM: 2.5, done: i, total: 300 });
    }
    expect(messages(info)).toEqual(['[SailCommand] plan start']);
    expect(warn).not.toHaveBeenCalled();
    w.emit({ type: 'result', id, result: NO_ROUTE });
    await outcome;
  });
});
