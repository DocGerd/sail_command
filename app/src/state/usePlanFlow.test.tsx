import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlanFlow } from './usePlanFlow';
import { useViaReplan } from './replan';
import { AppStateProvider, useActivePlan } from './AppState';
import { RoutingClient, RoutingError, type RoutingFailureKind } from '../routing/workerClient';
import type { WorkerRequest, WorkerResponse } from '../routing/protocol';
import { OpenMeteoError, type OpenMeteoErrorKind } from '../services/openMeteo';
import * as assetsModule from '../services/assets';
import { __resetDbForTests, getPlan, listPlans, savePlan } from '../services/db';
import { destinationPoint } from '../lib/geo';
import { recalcRequest } from '../lib/recalc';
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
  seamarks: { type: 'FeatureCollection', features: [] },
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
    rig: 'genoa',
    legs: [],
    etaMs: REQ.departureMs + 3_600_000,
    durationMs: 3_600_000,
    distanceNm: 10,
    maneuverCount: 0,
    motorDistanceNm: 0,
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
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker),
        }),
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
        flow: usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
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
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );

    await act(async () => {
      await result.current.run(REQ, 'Test plan');
    });

    expect(result.current.planning).toEqual({ phase: 'error', messageKey });
    expect(save).not.toHaveBeenCalled();
  });

  // #433: this used to collapse onto error.internal — mapWindError's
  // fallthrough is now its own distinguishable key (kind 'wind-unclassified'
  // in usePlanFlow.ts's ROUTING_FAILURE_MESSAGE_KEY), since a retry helps
  // here (re-fetching) unlike most of error.internal's other former causes.
  it('maps a fetchWind rejection that is not an OpenMeteoError (e.g. a bare Error) to error.windUnknown', async () => {
    const fetchWind = vi.fn().mockRejectedValue(new Error('unexpected'));
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );

    await act(async () => {
      await result.current.run(REQ, 'Test plan');
    });

    expect(result.current.planning).toEqual({ phase: 'error', messageKey: 'error.windUnknown' });
    expect(save).not.toHaveBeenCalled();
  });

  it.each<[NoRouteReason, MsgKey]>([
    ['unreachable', 'error.noRoute.unreachable'],
    ['calm-motor-off', 'error.noRoute.calmMotorOff'],
    ['beyond-horizon', 'error.noRoute.beyondHorizon'],
    ['snap-failed-origin', 'error.noRoute.snapOrigin'],
    ['snap-failed-destination', 'error.noRoute.snapDestination'],
  ])('maps a PlanResultError reason %s to %s', async (reason, messageKey) => {
    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
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

  // #340: the routing phase carries only `rig` — no simulatedToMs/progress
  // number — since the router solves genoa then fock SEQUENTIALLY
  // (planRoute.ts's runBoth) and `rig` alone is an honest, bounded phase
  // signal. tMs/frontierSize still arrive on every progress message (the
  // worker protocol is unchanged) but are no longer reflected into state.
  it('the routing phase tracks which rig is solving, regardless of tMs — including a same-rig regression, which is not a phase change', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
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
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa' });

    // A regressing tMs at a via-segment joint (ledgered) is invisible to the
    // UI now — there is no number to clamp or regress, only the rig. `now`
    // advances past workerClient.ts's 100 ms per-rig throttle so this
    // message genuinely reaches onProgress rather than being swallowed.
    now += 150;
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'genoa', tMs: 800, frontierSize: 4 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa' });

    // The genoa->fock switch: the ONLY visible change is `rig` — this is the
    // exact transition the removed percentage rendered as a reset to 0.
    now += 150;
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'fock', tMs: 200, frontierSize: 1 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'fock' });

    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });
    expect(result.current.planning).toEqual({ phase: 'idle' });
  });

  it('a relaxed-depth probe enters probing-depth, and the relaxed re-solve renders as its own routing state — never a regression (#53/#68/#340)', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(REQ, 'Test plan');
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');

    // The doomed requested-depth solve reaches genoa.
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'genoa', tMs: 5000, frontierSize: 3 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa' });

    // The worker starts probing relaxed depth gates (mask BFS): the UI shows
    // its own named 'probing-depth' phase, not a routing readout frozen at
    // the doomed run's last rig.
    act(() => {
      w.emit({ type: 'probe', id: planMsg.id, probeDepthM: 2.5, done: 1, total: 4 });
    });
    expect(result.current.planning).toEqual({ phase: 'probing-depth' });

    // The relaxed re-solve restarts at genoa again. There is no number left
    // to regress — the state is byte-identical to the FIRST genoa tick
    // above, which is correct: restarting the same rig is not a new phase.
    now += 150; // clear the 100 ms per-rig progress throttle
    act(() => {
      w.emit({ type: 'progress', id: planMsg.id, rig: 'genoa', tMs: 200, frontierSize: 2 });
    });
    expect(result.current.planning).toEqual({ phase: 'routing', rig: 'genoa' });

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

    const { result } = renderHook(() => usePlanFlow({ fetchWind, save, makeClient }), {
      wrapper: AppStateProvider,
    });

    await act(async () => {
      await result.current.run(REQ, 'First attempt');
    });
    // #433: ensureClient() returning null (asset/worker init failure) is
    // classified as 'worker-init' in usePlanFlow.ts's
    // ROUTING_FAILURE_MESSAGE_KEY — distinguishable from the OTHER causes
    // that used to collapse onto the same error.internal key.
    expect(result.current.planning).toEqual({ phase: 'error', messageKey: 'error.workerInit' });
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

  it('a worker fatal during client.plan() (not init) disposes the poisoned client so the next run() builds a fresh one', async () => {
    const firstWorker = fakeWorker();
    const secondWorker = fakeWorker();
    const makeClient = vi
      .fn()
      .mockImplementationOnce(() => new RoutingClient(() => firstWorker as unknown as Worker))
      .mockImplementationOnce(() => new RoutingClient(() => secondWorker as unknown as Worker));
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(() => usePlanFlow({ fetchWind, save, makeClient }), {
      wrapper: AppStateProvider,
    });

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(REQ, 'First attempt');
      await flush();
    });
    const firstPlanMsg = findPosted(firstWorker.posted, 'plan');
    await act(async () => {
      // Mid-plan worker crash: a targeted fatal for the in-flight id, not
      // the global (id: null) form the "global fatal" workerClient.test.ts
      // case covers.
      firstWorker.emit({ type: 'fatal', id: firstPlanMsg.id, message: 'segment blocked' });
      await runPromise;
    });
    // #433: a targeted 'fatal' rejects client.plan() with a RoutingError of
    // kind 'worker-fatal' (workerClient.ts), classified here as
    // error.routingFailed — distinguishable from the sibling causes that
    // used to collapse onto the same error.internal key.
    expect(result.current.planning).toEqual({ phase: 'error', messageKey: 'error.routingFailed' });
    expect(makeClient).toHaveBeenCalledTimes(1);
    // The poisoned client must be disposed (Worker thread torn down), not
    // just abandoned with the shared singleton still pointing at it.
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);

    let secondRunPromise!: Promise<void>;
    await act(async () => {
      secondRunPromise = result.current.run(REQ, 'Retry');
      await flush();
    });
    expect(makeClient).toHaveBeenCalledTimes(2); // a fresh client was built, not the poisoned one reused

    const secondPlanMsg = findPosted(secondWorker.posted, 'plan');
    await act(async () => {
      secondWorker.emit({ type: 'result', id: secondPlanMsg.id, result: OK_RESULT });
      await secondRunPromise;
    });

    expect(result.current.planning).toEqual({ phase: 'idle' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  // #433: a savePlan() failure AFTER routing already succeeded used to
  // report the same error.internal key as every other cause — genuinely
  // misleading, since routing worked and only persistence failed. Now
  // classified as its own error.planSaveFailed.
  it('a post-success savePlan() failure is classified as error.planSaveFailed, not error.internal (#433)', async () => {
    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi
      .fn<(plan: Plan) => Promise<void>>()
      .mockRejectedValue(new Error('IndexedDB quota exceeded'));
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(REQ, 'Test plan');
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.planning).toEqual({ phase: 'error', messageKey: 'error.planSaveFailed' });
  });

  it('run() dedupes adjacent via points (< 60 m) before submitting the request, and before saving the plan', async () => {
    const w = fakeWorker();
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const via1 = { lat: 54.76, lon: 10.1 }; // far from REQ.origin/REQ.destination
    const via2 = destinationPoint(via1, 10, 50 / 1852); // ~50 m from via1, within the 60 m dedupe threshold
    const reqWithVias = { ...REQ, viaPoints: [via1, via2] };

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.run(reqWithVias, 'Test plan with vias');
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    expect(planMsg.request.viaPoints).toEqual([via1]); // via2 dropped, too close to via1

    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });

    expect(save).toHaveBeenCalledTimes(1);
    const savedPlan = save.mock.calls[0][0];
    expect(savedPlan.request.viaPoints).toEqual([via1]); // the saved plan carries the deduped list too
  });

  it('run() is a guarded no-op while a plan is already in flight', async () => {
    const fetchWind = vi.fn().mockImplementation(() => new Promise(() => {})); // never settles
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);

    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind,
          save,
          makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker),
        }),
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

// ensureClient's whole purpose is being shared with state/replan.ts's
// useViaReplan (see usePlanFlow.ts's own docstring) — these two tests drive
// both hooks together to prove that sharing actually works end-to-end,
// which a usePlanFlow-only or replan-only suite (with a hand-rolled fake
// ensureClient) can't.
describe('usePlanFlow.ensureClient shared with useViaReplan', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a via-replan works with no prior run() in this session — ensureClient lazily creates the client on demand', async () => {
    const w = fakeWorker();
    const makeClient = vi.fn(() => new RoutingClient(() => w as unknown as Worker));
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () => {
        const flow = usePlanFlow({ makeClient });
        const viaReplan = useViaReplan(flow.ensureClient);
        return { flow, viaReplan };
      },
      { wrapper: AppStateProvider },
    );

    const windGrid = uniformWindGrid(12, 0);
    const loadedPlan: Plan = {
      id: 'loaded-not-run',
      name: 'Loaded from PlansList',
      createdAtMs: REQ.departureMs - 3_600_000,
      request: { ...REQ, viaPoints: [] },
      windGrid,
      result: OK_RESULT,
    };

    let replacePromise!: Promise<Plan | null>;
    await act(async () => {
      replacePromise = result.current.viaReplan.replace(loadedPlan, [{ lat: 54.76, lon: 10.15 }]);
      await flush();
    });

    // Proves the client was created by ensureClient itself, not by a run()
    // that never happened in this test.
    expect(makeClient).toHaveBeenCalledTimes(1);
    const planMsg = findPosted(w.posted, 'plan');

    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await replacePromise;
    });

    expect(await replacePromise).not.toBeNull();
    expect(result.current.viaReplan.state.error).toBeNull();
  });

  it('a via-replan through ensureClient works while navigator.onLine is false — the offline guard lives only in run()', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const w = fakeWorker();
    const makeClient = vi.fn(() => new RoutingClient(() => w as unknown as Worker));
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);

    const { result } = renderHook(
      () => {
        const flow = usePlanFlow({ makeClient });
        const viaReplan = useViaReplan(flow.ensureClient);
        return { flow, viaReplan };
      },
      { wrapper: AppStateProvider },
    );

    const windGrid = uniformWindGrid(12, 0);
    const loadedPlan: Plan = {
      id: 'offline-replan',
      name: 'Loaded from PlansList',
      createdAtMs: REQ.departureMs - 3_600_000,
      request: { ...REQ, viaPoints: [] },
      windGrid,
      result: OK_RESULT,
    };

    let replacePromise!: Promise<Plan | null>;
    await act(async () => {
      replacePromise = result.current.viaReplan.replace(loadedPlan, [{ lat: 54.76, lon: 10.15 }]);
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await replacePromise;
    });

    expect(await replacePromise).not.toBeNull();
    expect(result.current.viaReplan.state.error).toBeNull();
  });
});

// #114: recalculate a saved plan with a FRESH forecast. These drive run()
// against the REAL savePlan/getPlan (fake-indexeddb) — the whole point is
// what ends up persisted: recalc-as-new must be additive (original plan +
// stored grid byte-identical afterwards), replace must overwrite only the
// confirmed id, and only when the run actually succeeds.
describe('#114 recalculate with a fresh forecast', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NEW_DEPARTURE_MS = Date.UTC(2026, 6, 16, 9, 0, 0);

  // Stored grid uniformly 17 kn — every untouched-original assertion below
  // pins that literal 17, never a value read back through the code under test.
  function originalPlan(): Plan {
    return {
      id: 'orig-1',
      name: 'Original',
      createdAtMs: Date.UTC(2026, 6, 14, 12, 0, 0),
      request: { ...REQ, viaPoints: [] },
      windGrid: uniformWindGrid(17, 90),
      result: OK_RESULT,
    };
  }

  function setup(freshSpeedKn: number) {
    const w = fakeWorker();
    const freshGrid = uniformWindGrid(freshSpeedKn, 180);
    const fetchWind = vi.fn().mockResolvedValue(freshGrid);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);
    const { result } = renderHook(
      () => ({
        // deps.save deliberately OMITTED: the real savePlan persists into
        // fake-indexeddb so the tests can read back what was actually stored.
        flow: usePlanFlow({
          fetchWind,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
        active: useActivePlan(),
      }),
      { wrapper: AppStateProvider },
    );
    return { w, freshGrid, fetchWind, result };
  }

  it('recalc-as-new: fetches fresh wind, saves under a NEW id, and leaves the original plan and its stored grid untouched', async () => {
    const original = originalPlan();
    await savePlan(original);
    const { w, freshGrid, fetchWind, result } = setup(23);

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.flow.run(
        recalcRequest(original, NEW_DEPARTURE_MS),
        'Original (recalculated)',
      );
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    // Routed against the FRESH fetch with the edited departure — never the
    // stored grid (that reuse is via-replan's job, state/replan.ts).
    expect(planMsg.windGrid).toBe(freshGrid);
    expect(planMsg.request.departureMs).toBe(NEW_DEPARTURE_MS);

    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });

    expect(fetchWind).toHaveBeenCalledTimes(1);

    const activePlan = result.current.active.plan;
    expect(activePlan).not.toBeNull();
    expect(activePlan!.id).not.toBe('orig-1');
    expect(activePlan!.name).toBe('Original (recalculated)');
    expect(activePlan!.windGrid).toBe(freshGrid);
    expect(activePlan!.request.departureMs).toBe(NEW_DEPARTURE_MS);

    // The in-memory original was never mutated (grid object identity is the
    // original's own; values still the literal 17 kn it was built with).
    expect(original.windGrid.speedKn.every((v) => v === 17)).toBe(true);
    expect(original.request.departureMs).toBe(Date.UTC(2026, 6, 15, 8, 0, 0));

    // The PERSISTED original is untouched too, and the recalc was additive.
    const persisted = await getPlan('orig-1');
    expect(persisted).toBeDefined();
    expect(Array.from(persisted!.windGrid.speedKn).every((v) => v === 17)).toBe(true);
    expect(persisted!.request.departureMs).toBe(Date.UTC(2026, 6, 15, 8, 0, 0));
    expect((await listPlans()).length).toBe(2);
  });

  it('recalc-replace: persists under the ORIGINAL id, overwriting it with the fresh grid and edited departure', async () => {
    const original = originalPlan();
    await savePlan(original);
    const { w, freshGrid, result } = setup(23);

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.flow.run(recalcRequest(original, NEW_DEPARTURE_MS), 'Original', {
        replacePlanId: 'orig-1',
      });
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    await act(async () => {
      w.emit({ type: 'result', id: planMsg.id, result: OK_RESULT });
      await runPromise;
    });

    const replaced = await getPlan('orig-1');
    expect(replaced).toBeDefined();
    expect(Array.from(replaced!.windGrid.speedKn).every((v) => v === 23)).toBe(true);
    expect(replaced!.request.departureMs).toBe(NEW_DEPARTURE_MS);
    expect(replaced!.name).toBe('Original');
    expect((await listPlans()).length).toBe(1); // replaced, not added

    expect(result.current.active.plan!.id).toBe('orig-1');
    expect(result.current.active.plan!.windGrid).toBe(freshGrid);
  });

  it('a FAILED replace-recalculation leaves the original untouched — the overwrite only happens at save time', async () => {
    const original = originalPlan();
    await savePlan(original);
    const { w, result } = setup(23);

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = result.current.flow.run(recalcRequest(original, NEW_DEPARTURE_MS), 'Original', {
        replacePlanId: 'orig-1',
      });
      await flush();
    });

    const planMsg = findPosted(w.posted, 'plan');
    await act(async () => {
      w.emit({
        type: 'result',
        id: planMsg.id,
        result: { status: 'error', reason: 'beyond-horizon' },
      });
      await runPromise;
    });

    expect(result.current.flow.planning).toEqual({
      phase: 'error',
      messageKey: 'error.noRoute.beyondHorizon',
    });
    const persisted = await getPlan('orig-1');
    expect(persisted).toBeDefined();
    expect(Array.from(persisted!.windGrid.speedKn).every((v) => v === 17)).toBe(true);
    expect(persisted!.request.departureMs).toBe(Date.UTC(2026, 6, 15, 8, 0, 0));
  });
});

// #433/#435 spike §12: exhaustive proof that usePlanFlow.ts's
// ROUTING_FAILURE_MESSAGE_KEY maps EVERY RoutingFailureKind to its own
// distinguishable MsgKey. A stub client (not a full worker/protocol
// simulation — workerClient.test.ts already proves each of the seven SITES
// throws the correct kind) isolates usePlanFlow's own classification table
// so this test can cover all five kinds cheaply, one at a time.
describe('usePlanFlow classifies every RoutingFailureKind (#433)', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[RoutingFailureKind, MsgKey]>([
    ['timeout', 'error.routingTimeout'],
    ['worker-fatal', 'error.routingFailed'],
    ['worker-error', 'error.routingCrashed'],
    ['messageerror', 'error.routingMessageError'],
    ['disposed', 'error.routingInterrupted'],
  ])('maps a RoutingError of kind %s to %s', async (kind, messageKey) => {
    const windGrid = uniformWindGrid(12, 0);
    const fetchWind = vi.fn().mockResolvedValue(windGrid);
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS_FIXTURE);
    // Minimal structural stub — only the methods run()/ensureClient() call.
    const stubClient = {
      init: vi.fn().mockResolvedValue(undefined),
      plan: vi.fn().mockRejectedValue(new RoutingError(kind, `stub ${kind} failure`)),
      dispose: vi.fn(),
    } as unknown as RoutingClient;

    const { result } = renderHook(
      () => usePlanFlow({ fetchWind, save, makeClient: () => stubClient }),
      {
        wrapper: AppStateProvider,
      },
    );

    await act(async () => {
      await result.current.run(REQ, 'Test plan');
    });

    expect(result.current.planning).toEqual({ phase: 'error', messageKey });
    expect(save).not.toHaveBeenCalled();
  });
});
