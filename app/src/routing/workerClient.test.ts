import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_BUDGET_MS,
  RoutingClient,
  RoutingError,
  type RoutingFailureKind,
} from './workerClient';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type PlanRequest,
  type PlanResult,
  type PolarTable,
  type SailId,
} from '../types';
import { solverTimeoutMs } from '../test/timeouts';

// #342 fix-wave (PR #351 review M2): this file has no `vi.setConfig`, so its
// file-level budget is vitest's default 5000 ms — the eight per-test `2000`
// overrides below were TIGHTER than that file default, the exact hard rule
// #342 exists to enforce (a per-test timeout may only ever be raised above
// the file-level budget, never below it), and were not coverage-scaled
// either. Raised to the file default and routed through solverTimeoutMs so
// v8 coverage instrumentation gets the same multiplier every other
// solver-touching test file gets — these tests build a full mask buffer and
// wind grid per case even though the fake worker resolves synchronously.
const WORKER_CLIENT_TEST_TIMEOUT_MS = solverTimeoutMs(5000);

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function openWaterBuffer(): ArrayBuffer {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  return data.buffer;
}

function fakeWorker() {
  const w = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    // Assigned by RoutingClient's constructor (fix A1); tests invoke these
    // directly to simulate the runtime firing them.
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

const INIT_ASSETS = {
  maskMeta: TEST_MASK_META,
  maskBuffer: openWaterBuffer(),
  polarGenoa: TEST_POLAR,
  polarFock: FOCK,
};

const PLAN_REQUEST: PlanRequest = {
  // cell centers (grid step 0.005°): keep the spec-mandated 300 m snap
  // radius and adapt test geometry rather than loosen it.
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.3025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

// #433: every RoutingClient failure site is a RoutingError carrying a typed
// `kind` — this asserts BOTH the kind and the message pattern in one place,
// so a test reduced to "some error was thrown" (which discriminates
// nothing) can't creep back in.
async function expectRoutingError(
  p: Promise<unknown>,
  kind: RoutingFailureKind,
  messagePattern: RegExp,
): Promise<void> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RoutingError);
  const routingErr = err as RoutingError;
  expect(routingErr.kind, `expected kind '${kind}', got '${routingErr.kind}'`).toBe(kind);
  expect(routingErr.message).toMatch(messagePattern);
}

describe('RoutingClient promise settling', () => {
  it(
    'dispose() rejects an in-flight plan',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      client.dispose();
      await expectRoutingError(p, 'disposed', /disposed/);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'global fatal rejects an in-flight plan',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      w.emit({ type: 'fatal', id: null, message: 'mask corrupted' });
      await expectRoutingError(p, 'worker-fatal', /mask corrupted/);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'first-init failure rejects init()',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      const p = client.init(INIT_ASSETS);
      w.emit({ type: 'fatal', id: null, message: 'bad mask length' });
      await expectRoutingError(p, 'worker-fatal', /bad mask length/);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'plan() called after dispose() rejects immediately',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      client.dispose();
      await expectRoutingError(
        client.plan(PLAN_REQUEST, uniformWindGrid(12, 0)),
        'disposed',
        /disposed/,
      );
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'plan() resolves with the emitted result and forwards progress intact',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const progress: [SailId, number, number][] = [];
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), (sailId, tMs, frontierSize) =>
        progress.push([sailId, tMs, frontierSize]),
      );
      await flush();
      const sent = w.posted[w.posted.length - 1];
      if (sent.type !== 'plan') throw new Error('expected a plan message');
      w.emit({ type: 'progress', id: sent.id, sailId: 'genoa', tMs: 1000, frontierSize: 5 });
      const result: PlanResult = { status: 'error', reason: 'unreachable' };
      w.emit({ type: 'result', id: sent.id, result });
      await expect(p).resolves.toBe(result);
      expect(progress).toEqual([['genoa', 1000, 5]]);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'two concurrent plan() calls (distinct ids) settle independently',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p1 = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      const p2 = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      const [sent1, sent2] = w.posted.slice(-2);
      if (sent1.type !== 'plan' || sent2.type !== 'plan') throw new Error('expected plan messages');
      expect(sent1.id).not.toBe(sent2.id);
      const result: PlanResult = { status: 'error', reason: 'unreachable' };
      w.emit({ type: 'result', id: sent1.id, result });
      w.emit({ type: 'fatal', id: sent2.id, message: 'segment blocked' });
      await expect(p1).resolves.toBe(result);
      await expectRoutingError(p2, 'worker-fatal', /segment blocked/);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'forwards probe messages (#53) to onProbe untouched and unthrottled',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const probes: [number, number, number][] = [];
      const p = client.plan(
        PLAN_REQUEST,
        uniformWindGrid(12, 0),
        undefined,
        undefined,
        (d, done, total) => probes.push([d, done, total]),
      );
      await flush();
      const sent = w.posted[w.posted.length - 1];
      if (sent.type !== 'plan') throw new Error('expected a plan message');
      // Back-to-back probes (same tick) must both arrive — no 100 ms throttle.
      w.emit({ type: 'probe', id: sent.id, probeDepthM: 2.5, done: 1, total: 4 });
      w.emit({ type: 'probe', id: sent.id, probeDepthM: 2.2, done: 2, total: 4 });
      const result: PlanResult = { status: 'error', reason: 'unreachable' };
      w.emit({ type: 'result', id: sent.id, result });
      await expect(p).resolves.toBe(result);
      expect(probes).toEqual([
        [2.5, 1, 4],
        [2.2, 2, 4],
      ]);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'worker.onerror fired by the runtime rejects an in-flight plan',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      w.onerror?.(new ErrorEvent('error', { message: 'worker crashed' }));
      await expectRoutingError(p, 'worker-error', /worker crashed/);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  // #433: onmessageerror (kind 'messageerror') had no dedicated test before —
  // only onerror (above) and the various 'fatal' shapes were covered.
  it(
    'worker.onmessageerror fired by the runtime rejects an in-flight plan',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      w.onmessageerror?.({} as MessageEvent);
      await expectRoutingError(p, 'messageerror', /could not be deserialized/);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  // #433: protocol.ts's fatal.stack (populated at the real throw site inside
  // the worker) must survive into the client-side RoutingError, replacing
  // the default Error.stack a bare `new RoutingError(...)` would otherwise
  // carry (which would only ever point at workerClient.ts's own
  // construction site, not the real failure).
  it(
    "a fatal message's stack replaces the default RoutingError construction-site stack",
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      const sent = w.posted[w.posted.length - 1];
      if (sent.type !== 'plan') throw new Error('expected a plan message');
      const workerStack = 'Error: boom\n    at planRoute (planRoute.ts:123:4)';
      w.emit({ type: 'fatal', id: sent.id, message: 'boom', stack: workerStack });
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RoutingError);
      expect((err as RoutingError).stack).toBe(workerStack);
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );

  it(
    'a fatal message with no stack still produces a usable (non-empty) RoutingError.stack',
    async () => {
      const w = fakeWorker();
      const client = new RoutingClient(() => w as unknown as Worker);
      w.emit({ type: 'ready' });
      const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0));
      await flush();
      const sent = w.posted[w.posted.length - 1];
      if (sent.type !== 'plan') throw new Error('expected a plan message');
      w.emit({ type: 'fatal', id: sent.id, message: 'boom' });
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RoutingError);
      expect((err as RoutingError).stack).toBeTruthy();
    },
    WORKER_CLIENT_TEST_TIMEOUT_MS,
  );
});

// #432: the worker's plan budget and the client's liveness deadline are two
// halves of one mechanism, and their ORDER is what makes the whole change
// work — the solver must always reach its budget first, because it is the
// only side that can say what it was doing. Nothing else in the suite would
// notice if that ordering inverted.
describe('#432 plan budget vs the client liveness deadline', () => {
  it('ships a budgetMs strictly SHORTER than the deadline the client itself waits', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    const timeoutMs = 60_000;
    void client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), undefined, timeoutMs).catch(() => {});
    await Promise.resolve();

    const sent = w.posted[w.posted.length - 1];
    if (sent.type !== 'plan') throw new Error('expected a plan message');
    expect(sent.budgetMs, 'the worker must be given a budget at all').toBeDefined();
    // Poll the VALUE, not a boolean: a bare `toBeLessThan` would report
    // "false" and nothing about the two numbers involved.
    expect(
      sent.budgetMs,
      `budgetMs ${sent.budgetMs} must be under the client deadline ${timeoutMs}, or the ` +
        `client pre-empts the solver's honest answer (the pre-#432 behaviour)`,
    ).toBeLessThan(timeoutMs);
    expect(sent.budgetMs).toBeGreaterThan(0);
  });

  it('derives budgetMs from the CALL’s timeoutMs, so the two can never invert', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    const budgets: (number | undefined)[] = [];
    for (const timeoutMs of [40_000, 90_000]) {
      void client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), undefined, timeoutMs).catch(() => {});
      await Promise.resolve();
      const sent = w.posted[w.posted.length - 1];
      if (sent.type !== 'plan') throw new Error('expected a plan message');
      budgets.push(sent.budgetMs);
      expect(sent.budgetMs).toBeLessThan(timeoutMs);
    }
    // A constant read off PLAN_BUDGET_MS instead of the call's own timeout
    // would give the same number twice — and would exceed a shortened
    // deadline, restoring exactly the inversion this guards.
    expect(budgets[0], 'budgetMs must track the call, not a module constant').not.toBe(budgets[1]);
  });

  it('the default deadline leaves PLAN_BUDGET_MS of room plus a real grace margin', async () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    // No explicit timeoutMs — exercises DEFAULT_PLAN_TIMEOUT_MS, which is not
    // exported. The budget it yields must be exactly PLAN_BUDGET_MS, which is
    // what pins "the default deadline == budget + grace" from the outside.
    void client.plan(PLAN_REQUEST, uniformWindGrid(12, 0)).catch(() => {});
    await Promise.resolve();

    const sent = w.posted[w.posted.length - 1];
    if (sent.type !== 'plan') throw new Error('expected a plan message');
    expect(sent.budgetMs).toBe(PLAN_BUDGET_MS);
  });

  // PR #453 review, Minor 1: a deadline at or under the grace margin used to
  // clamp to `budgetMs: 0`, which protocol.ts reads as an ALREADY-SPENT
  // budget — every such plan died before expanding a ring. It must degrade to
  // the documented fail-open unbudgeted path instead, i.e. omit the key.
  it.each([
    ['equal to the grace margin', 15_000],
    ['under the grace margin', 5_000],
  ])('omits budgetMs entirely for a deadline %s, rather than sending 0', async (_label, ms) => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    void client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), undefined, ms).catch(() => {});
    await Promise.resolve();

    const sent = w.posted[w.posted.length - 1];
    if (sent.type !== 'plan') throw new Error('expected a plan message');
    // hasOwnProperty, not `=== undefined`: a present-but-undefined key would
    // satisfy the looser check while still violating
    // exactOptionalPropertyTypes, and `budgetMs: 0` would fail neither.
    expect(
      Object.prototype.hasOwnProperty.call(sent, 'budgetMs'),
      `a ${ms} ms deadline must send NO budget, not an unsatisfiable one`,
    ).toBe(false);
  });

  it('exposes isDisposed so a singleton owner can rebuild instead of reusing a dead client', () => {
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    expect(client.isDisposed).toBe(false);
    client.dispose();
    expect(client.isDisposed).toBe(true);
  });
});

describe('RoutingClient.plan() timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with "routing timed out" once timeoutMs elapses without a worker response, and a late result is then a no-op', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), undefined, 5_000);
    // Attach a rejection handler immediately so the promise is never
    // "unhandled" for even a tick, regardless of when the assertion below
    // actually awaits it.
    const outcome = p.catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(5_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(RoutingError);
    expect(
      (err as RoutingError).kind,
      `expected kind 'timeout', got '${(err as RoutingError).kind}'`,
    ).toBe('timeout');
    expect((err as Error).message).toMatch(/routing timed out/);

    // The worker eventually replies anyway — must not throw or otherwise
    // affect anything; the pending entry (and its timer) is already gone.
    const sent = w.posted[w.posted.length - 1];
    if (sent.type !== 'plan') throw new Error('expected a plan message');
    const result: PlanResult = { status: 'error', reason: 'unreachable' };
    expect(() => w.emit({ type: 'result', id: sent.id, result })).not.toThrow();
  });

  it('does not fire the timeout once plan() resolves normally, and clears the underlying timer (no leftover fake timers)', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), undefined, 5_000);
    await vi.advanceTimersByTimeAsync(0); // let postMessage/microtasks settle
    const sent = w.posted[w.posted.length - 1];
    if (sent.type !== 'plan') throw new Error('expected a plan message');
    const result: PlanResult = { status: 'error', reason: 'unreachable' };
    w.emit({ type: 'result', id: sent.id, result });

    await expect(p).resolves.toBe(result);
    // The timeout's setTimeout must have been cleared on settle — otherwise
    // this would still report one pending fake timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer on dispose(), leaving no pending fake timer', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const client = new RoutingClient(() => w as unknown as Worker);
    w.emit({ type: 'ready' });

    const p = client.plan(PLAN_REQUEST, uniformWindGrid(12, 0), undefined, 5_000);
    const outcome = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    client.dispose();

    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
});
