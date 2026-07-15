import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlanFlow } from './usePlanFlow';
import { AppStateProvider, useActivePlan } from './AppState';
import { RoutingClient } from '../routing/workerClient';
import type { WorkerRequest, WorkerResponse } from '../routing/protocol';
import { OpenMeteoError, type OpenMeteoErrorKind } from '../services/openMeteo';
import * as assetsModule from '../services/assets';
import { __resetDbForTests } from '../services/db';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type NoRouteReason, type Plan, type PlanResultOk } from '../types';
import type { MsgKey } from '../i18n/dict.de';

const FOCK_POLAR = { ...TEST_POLAR, rig: 'fock' as const };

function openWaterBuffer(): ArrayBuffer {
  return new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200).buffer;
}

const ASSETS_FIXTURE: assetsModule.RoutingAssets = {
  maskMeta: TEST_MASK_META,
  maskBuffer: openWaterBuffer(),
  polarGenoa: TEST_POLAR,
  polarFock: FOCK_POLAR,
  harbors: [],
};

// Mirrors workerClient.test.ts's fakeWorker, plus an auto-reply on
// receiving 'init' — usePlanFlow creates the RoutingClient (and wires its
// onmessage) lazily inside run(), so a test can't pre-emit 'ready' before
// the listener exists; replying from postMessage matches how a real worker
// would behave and needs no test-side timing choreography. `failInit`
// simulates a worker that reports a fatal error during init instead.
function fakeWorker(opts: { failInit?: boolean } = {}) {
  const w = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as ((e: MessageEvent) => void) | null,
    posted: [] as WorkerRequest[],
    postMessage(m: WorkerRequest) {
      this.posted.push(m);
      if (m.type === 'init') {
        if (opts.failInit) this.emit({ type: 'fatal', id: null, message: 'bad mask length' });
        else this.emit({ type: 'ready' });
      }
    },
    // A spy (not a no-op) so tests can assert the Worker thread is actually
    // torn down (e.g. a failed-init client's dispose()) rather than leaked.
    terminate: vi.fn(),
    emit(m: WorkerResponse) {
      this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
    },
  };
  return w;
}

const REQ = {
  // cell centers, open water throughout TEST_MASK_META (see fixtures.ts).
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.3025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
};

const OK_RESULT: PlanResultOk = {
  status: 'ok',
  genoa: {
    rig: 'genoa', legs: [], etaMs: REQ.departureMs + 3_600_000, durationMs: 3_600_000,
    distanceNm: 10, maneuverCount: 0, motorDistanceNm: 0,
  },
  fock: null,
  genoaReason: null,
  fockReason: 'calm-motor-off',
  recommended: 'genoa',
  snappedOrigin: REQ.origin,
  snappedDestination: REQ.destination,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function findPosted<T extends WorkerRequest['type']>(
  posted: WorkerRequest[],
  type: T,
): Extract<WorkerRequest, { type: T }> {
  const msg = posted.find((m) => m.type === type);
  if (!msg) throw new Error(`expected a '${type}' message to have been posted`);
  return msg as Extract<WorkerRequest, { type: T }>;
}

describe('usePlanFlow', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('guards navigator.onLine === false with error.offline and never calls fetchWind', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchWind = vi.fn();
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker) }),
      { wrapper: AppStateProvider },
    );

    await act(async () => {
      await result.current.run(REQ, 'Test plan');
    });

    expect(result.current.planning).toEqual({ phase: 'error', messageKey: 'error.offline' });
    expect(fetchWind).not.toHaveBeenCalled();
  });

  it('happy path: saves the same windGrid object it fetched, sets the active plan, returns to idle', async () => {
    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () => ({
        flow: usePlanFlow({ fetchWind, save, makeClient: () => new RoutingClient(() => w as unknown as Worker) }),
        active: useActivePlan(),
      }),
      { wrapper: AppStateProvider },
    );

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.flow.run(REQ, 'Flensburg → Marstal');
      await flush();
    });
    expect(result.current.flow.planning).toEqual({ phase: 'fetching-wind' }); // still in flight

    await flush(); // let the fetch-wind/load-assets/init chain settle

    const initMsg = findPosted(w.posted, 'init');
    // Binding contract: maskBuffer is transferred to the worker, so run()
    // must always pass a copy — the module-cached original in assets.ts
    // (ASSETS_FIXTURE.maskBuffer here) must stay intact.
    expect(initMsg.maskBuffer).not.toBe(ASSETS_FIXTURE.maskBuffer);
    expect(new Uint8Array(initMsg.maskBuffer)).toEqual(new Uint8Array(ASSETS_FIXTURE.maskBuffer));

    const planMsg = findPosted(w.posted, 'plan');
    expect(planMsg.windGrid).toBe(windGrid);

    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });

    expect(save).toHaveBeenCalledTimes(1);
    const savedPlan = save.mock.calls[0][0];
    expect(savedPlan.windGrid).toBe(windGrid); // never-transfer rule: the fetched object, not a clone
    expect(savedPlan.name).toBe('Flensburg → Marstal');
    expect(savedPlan.result).toBe(OK_RESULT);
    expect(savedPlan.request).toEqual(REQ);
    expect(typeof savedPlan.id).toBe('string');

    expect(result.current.active.plan).toBe(savedPlan);
    expect(result.current.flow.planning).toEqual({ phase: 'idle' });
  });

  it.each<[OpenMeteoErrorKind, MsgKey]>([
    ['offline', 'error.offline'],
    ['rate-limited', 'error.rateLimited'],
    ['http', 'error.windService'],
    ['malformed', 'error.windService'],
  ])('maps an OpenMeteoError of kind %s to %s', async (kind, messageKey) => {
    const fetchWind = vi.fn().mockRejectedValue(new OpenMeteoError(kind, 'boom'));
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker) }),
      { wrapper: AppStateProvider },
    );

    await act(async () => {
      await result.current.run(REQ, 'Test plan');
    });

    expect(result.current.planning).toEqual({ phase: 'error', messageKey });
    expect(save).not.toHaveBeenCalled();
  });

  it.each<[NoRouteReason, MsgKey]>([
    ['unreachable', 'error.noRoute.unreachable'],
    ['calm-motor-off', 'error.noRoute.calmMotorOff'],
  ])('maps a PlanResultError reason %s to %s', async (reason, messageKey) => {
    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient: () => new RoutingClient(() => w as unknown as Worker) }),
      { wrapper: AppStateProvider },
    );

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(REQ, 'Test plan');
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: { status: 'error', reason } });
      await runPromise;
    });

    expect(result.current.planning).toEqual({ phase: 'error', messageKey });
    expect(save).not.toHaveBeenCalled();
  });

  it('progress reaches the routing phase for both rigs, and simulatedToMs is monotone per rig despite a regressing tMs', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient: () => new RoutingClient(() => w as unknown as Worker) }),
      { wrapper: AppStateProvider },
    );

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(REQ, 'Test plan');
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');

    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'genoa', tMs: 1000, frontierSize: 3 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa', simulatedToMs: 1000 });

    now += 150; // clear the 100 ms per-rig progress throttle
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'genoa', tMs: 800, frontierSize: 4 }); // via-joint regression
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa', simulatedToMs: 1000 }); // clamped

    now += 150;
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'genoa', tMs: 1500, frontierSize: 5 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa', simulatedToMs: 1500 });

    now += 150;
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'fock', tMs: 200, frontierSize: 1 });
    });
    // The genoa→fock rig switch is a legitimate reset, not a regression:
    // fock starts its own monotone sequence at its own tMs, not clamped up
    // against genoa's high-water mark (a UI can't otherwise distinguish
    // that plateau from a stall).
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'fock', simulatedToMs: 200 });

    now += 150;
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'fock', tMs: 100, frontierSize: 2 }); // fock's own via-joint regression
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'fock', simulatedToMs: 200 }); // clamped within fock

    now += 150;
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'fock', tMs: 600, frontierSize: 3 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'fock', simulatedToMs: 600 });

    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });
    expect(result.current.planning).toEqual({ phase: 'idle' });
  });

  it('a failed init does not stick: the next run() creates a fresh client and can succeed', async () => {
    const brokenWorker = fakeWorker({ failInit: true });
    const workingWorker = fakeWorker();
    const makeClient = vi
      .fn()
      .mockImplementationOnce(() => new RoutingClient(() => brokenWorker as unknown as Worker))
      .mockImplementationOnce(() => new RoutingClient(() => workingWorker as unknown as Worker));
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient }),
      { wrapper: AppStateProvider },
    );

    await act(async () => {
      await result.current.run(REQ, 'First attempt');
    });
    expect(result.current.planning).toEqual({ phase: 'error', messageKey: 'error.internal' });
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(brokenWorker.posted.some((m) => m.type === 'plan')).toBe(false); // never got past init
    // The broken client's Worker thread must be torn down, not leaked, when
    // init fails — dispose() is called exactly once on the recovery path.
    expect(brokenWorker.terminate).toHaveBeenCalledTimes(1);

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(REQ, 'Retry');
      await flush();
    });
    expect(makeClient).toHaveBeenCalledTimes(2); // a fresh client was created, not the broken one reused

    const initMsg = findPosted(workingWorker.posted, 'init');
    // The retry's init must still receive a real, intact maskBuffer — proves
    // the cached assets.ts original wasn't detached by the first (failed)
    // client's transfer.
    expect(initMsg.maskBuffer.byteLength).toBe(ASSETS_FIXTURE.maskBuffer.byteLength);
    expect(initMsg.maskBuffer.byteLength).toBeGreaterThan(0);

    const planMsg = findPosted(workingWorker.posted, 'plan');
    await act(async () => {
      workingWorker.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });

    expect(result.current.planning).toEqual({ phase: 'idle' });
    expect(save).toHaveBeenCalledTimes(1);
    // The working client's own Worker must still be alive (not disposed).
    expect(workingWorker.terminate).not.toHaveBeenCalled();
  });

  it('run() is a guarded no-op while a plan is already in flight', async () => {
    const fetchWind = vi.fn().mockImplementation(() => new Promise(() => {})); // never settles
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker) }),
      { wrapper: AppStateProvider },
    );

    act(() => {
      void result.current.run(REQ, 'First');
      void result.current.run(REQ, 'Second');
    });

    expect(fetchWind).toHaveBeenCalledTimes(1);
    expect(result.current.planning).toEqual({ phase: 'fetching-wind' });
  });
});
