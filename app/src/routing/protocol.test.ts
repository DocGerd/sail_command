import { describe, expect, it, vi } from 'vitest';
import { createHandler, type WorkerResponse } from './protocol';
import { planRoute } from './planRoute';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// #433 review Minor 2: wraps the REAL planRoute as the default mock
// implementation (vi.fn(actual.planRoute)) — every existing test below still
// exercises the real solver unmodified. Only the two new tests at the bottom
// of this file override it, one call at a time (mockImplementationOnce
// self-reverts to this real-passthrough default after firing once), so they
// can force a throw with an exact, known shape without touching planRoute.ts
// itself or risking any other test in this solver-heavy file.
vi.mock('./planRoute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./planRoute')>();
  return { ...actual, planRoute: vi.fn(actual.planRoute) };
});

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

// #433/#435 spike §12, review Minor 2: protocol.ts:69's `stack` population is
// the actual reason protocol.ts changed for #433 — tested directly here
// rather than only through workerClient.test.ts's CONSUMPTION-side tests
// (which fabricate a `stack` value on the incoming WorkerResponse and never
// exercise protocol.ts's own catch(err) at all).
describe('worker protocol handler: fatal.stack population (#433 review Minor 2)', () => {
  function planFatal(out: WorkerResponse[]) {
    const handle = createHandler((m) => out.push(m));
    handle({
      type: 'init',
      maskMeta: TEST_MASK_META,
      maskBuffer: openWaterBuffer(),
      polarGenoa: TEST_POLAR,
      polarFock: FOCK,
    });
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
      windGrid: uniformWindGrid(12, 0),
    });
  }

  it('a throw carrying a stack produces a fatal message whose stack is exactly that stack', () => {
    const thrown = new Error('mid-plan throw, exact site');
    // Overwritten with a KNOWN value rather than relying on whatever V8
    // auto-captures — makes the assertion below an exact-equality check
    // against a value this test controls, not a truthy-only guess.
    thrown.stack = 'Error: mid-plan throw, exact site\n    at planRoute (planRoute.ts:242:9)';
    vi.mocked(planRoute).mockImplementationOnce(() => {
      throw thrown;
    });

    const out: WorkerResponse[] = [];
    planFatal(out);

    const fatal = out.find((m) => m.type === 'fatal');
    if (!fatal || fatal.type !== 'fatal') throw new Error('expected a fatal message');
    expect(fatal.stack).toBe(thrown.stack);
  });

  it('a throw with no stack (a non-Error throw) produces a fatal with the stack property ABSENT, not present-and-undefined', () => {
    vi.mocked(planRoute).mockImplementationOnce(() => {
      // Deliberately not an Error — err.stack is undefined for ANY non-Error
      // throw, and exactOptionalPropertyTypes means the `stack` key must be
      // OMITTED entirely (protocol.ts's `...(stack !== undefined ? {stack} : {})`
      // spread), never present with the value undefined.
      throw 'a plain string throw, no .stack at all';
    });

    const out: WorkerResponse[] = [];
    planFatal(out);

    const fatal = out.find((m) => m.type === 'fatal');
    if (!fatal || fatal.type !== 'fatal') throw new Error('expected a fatal message');
    // Object.prototype.hasOwnProperty (not just `fatal.stack === undefined`,
    // which a present-but-undefined property would also satisfy) is what
    // actually distinguishes OMITTED from present-and-undefined.
    expect(Object.prototype.hasOwnProperty.call(fatal, 'stack')).toBe(false);
    expect(fatal.stack).toBeUndefined();
  });
});

// #432: the worker side of the plan budget. This is the only test that
// exercises the whole wire — a budgetMs on the request becoming a deadline
// object that planRoute()/solve() actually honour.
describe('#432 worker plan budget', () => {
  function planWithBudget(out: WorkerResponse[], budgetMs?: number) {
    const handle = createHandler((m) => out.push(m));
    handle({
      type: 'init',
      maskMeta: TEST_MASK_META,
      maskBuffer: openWaterBuffer(),
      polarGenoa: TEST_POLAR,
      polarFock: FOCK,
    });
    handle({
      type: 'plan',
      id: 'budget-1',
      request: {
        origin: { lat: 54.7525, lon: 10.0025 },
        destination: { lat: 54.7525, lon: 10.3025 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
        settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(12, 0),
      ...(budgetMs !== undefined ? { budgetMs } : {}),
    });
    const msg = out.find((m) => m.type === 'result');
    if (!msg || msg.type !== 'result') throw new Error('expected a result message');
    return msg.result;
  }

  it('a zero budget is already spent, so the plan reports search-budget-exceeded', () => {
    const result = planWithBudget([], 0);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('search-budget-exceeded');
  });

  it('an ABSENT budgetMs leaves the worker unbudgeted — the same plan succeeds', () => {
    // The control that makes the row above mean something: the identical
    // request, with no budget, is a perfectly ordinary successful plan. Without
    // this, a zero budget could be "failing" for any unrelated reason.
    const result = planWithBudget([]);
    expect(result.status).toBe('ok');
  });

  it('a budget far larger than the solve does not disturb the result', () => {
    const unbudgeted = planWithBudget([]);
    const generous = planWithBudget([], 10 * 60_000);
    expect(generous).toEqual(unbudgeted);
  });
});
