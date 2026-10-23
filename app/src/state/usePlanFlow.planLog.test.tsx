import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { usePlanFlow } from './usePlanFlow';
import { AppStateProvider } from './AppState';
import { RoutingClient } from '../routing/workerClient';
import type { WorkerRequest, WorkerResponse } from '../routing/protocol';
import { OpenMeteoError } from '../services/openMeteo';
import * as assetsModule from '../services/assets';
import { __resetDbForTests } from '../services/db';
import { DEFAULT_BOAT_ID, polarKey } from '../data/boats';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type Plan,
  type PlanRequest,
  type PlanResultOk,
} from '../types';

// #1777: stage-transition and non-routing failure logging in run(). The plan
// lifecycle lines are the client's (workerClient.planLog.test.ts).

const ASSETS: assetsModule.RoutingAssets = {
  maskMeta: TEST_MASK_META,
  maskBuffer: new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200).buffer,
  polars: {
    [polarKey(DEFAULT_BOAT_ID, 'genoa')]: TEST_POLAR,
    [polarKey(DEFAULT_BOAT_ID, 'fock')]: { ...TEST_POLAR, rig: 'fock' as const },
  },
  harbors: [],
  seamarks: { type: 'FeatureCollection', features: [] },
};

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
    terminate: vi.fn(),
    emit(m: WorkerResponse) {
      this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
    },
  };
  return w;
}

const REQ: PlanRequest = {
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

const OK_RESULT: PlanResultOk = {
  status: 'ok',
  sails: [],
  recommended: 'genoa',
  comparisonComplete: true,
  snappedOrigin: REQ.origin,
  snappedDestination: REQ.destination,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

let info: MockInstance<typeof console.info>;
let error: MockInstance<typeof console.error>;

beforeEach(async () => {
  await __resetDbForTests();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  vi.spyOn(assetsModule, 'loadRoutingAssets').mockResolvedValue(ASSETS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stageLines = (): Record<string, unknown>[] =>
  info.mock.calls.filter((c) => c[0] === '[SailCommand] plan stage').map((c) => c[1] as never);

describe('usePlanFlow console logging (#1777)', () => {
  it('logs each stage once, however many progress messages change the readout', async () => {
    const w = fakeWorker();
    const save = vi.fn<(plan: Plan) => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind: vi.fn().mockResolvedValue(uniformWindGrid(12, 0)),
          save,
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );

    let run!: Promise<void>;
    await act(async () => {
      run = result.current.run(REQ, 'plan');
      await flush();
    });
    await flush();
    const planId = w.posted.find((m) => m.type === 'plan');
    if (planId?.type !== 'plan') throw new Error('expected a plan message');
    const id = planId.id;

    // The client forwards at most one progress message per sail per 100 ms.
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 200));

    // Rigs reporting alternately (the parallel path) change the state every
    // time but stay in one stage.
    await act(async () => {
      w.emit({ type: 'progress', id, sailId: 'fock', tMs: 1, frontierSize: 1 });
    });
    await act(async () => {
      w.emit({ type: 'progress', id, sailId: 'genoa', tMs: 1, frontierSize: 1 });
    });
    expect(result.current.planning).toMatchObject({ phase: 'routing' });
    await act(async () => {
      w.emit({ type: 'progress', id, sailId: 'fock', tMs: 2, frontierSize: 1, secondPass: true });
      w.emit({ type: 'probe', id, probeDepthM: 2.5, done: 1, total: 4 });
    });
    await act(async () => {
      w.emit({ type: 'result', id, result: OK_RESULT });
      await run;
    });

    expect(stageLines().map((l) => l.stage)).toEqual([
      'fetching-wind',
      'starting',
      'routing',
      'routing-pass-2',
      'probing-depth',
      'idle',
    ]);
  });

  it('logs the typed wind failure kind and the resulting banner key', async () => {
    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind: vi.fn().mockRejectedValue(new OpenMeteoError('rate-limited', 'slow down')),
          makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );
    await act(async () => {
      await result.current.run(REQ, 'plan');
    });

    const call = error.mock.calls.find((c) => c[0] === '[SailCommand] wind fetch failed');
    expect(call?.[1]).toEqual({ kind: 'rate-limited' });
    expect(stageLines().at(-1)).toEqual({
      stage: 'error:error.rateLimited',
      messageKey: 'error.rateLimited',
    });
  });

  it('logs a second error with a different key that skips every other stage', async () => {
    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind: vi.fn().mockRejectedValue(new OpenMeteoError('rate-limited', 'slow down')),
          makeClient: () => new RoutingClient(() => fakeWorker() as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );
    await act(async () => {
      await result.current.run(REQ, 'plan');
    });
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => {
      await result.current.run(REQ, 'plan');
    });

    expect(stageLines().map((l) => l.stage)).toEqual([
      'fetching-wind',
      'error:error.rateLimited',
      'error:error.offline',
    ]);
  });

  it('logs a routing start-up failure', async () => {
    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind: vi.fn().mockResolvedValue(uniformWindGrid(12, 0)),
          makeClient: () =>
            new RoutingClient(() => fakeWorker({ failInit: true }) as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );
    await act(async () => {
      await result.current.run(REQ, 'plan');
    });

    const call = error.mock.calls.find((c) => c[0] === '[SailCommand] routing start-up failed');
    expect(call?.[1]).toEqual({ failure: 'worker-init' });
  });

  it('logs a failed save as a persist failure', async () => {
    const w = fakeWorker();
    const { result } = renderHook(
      () =>
        usePlanFlow({
          fetchWind: vi.fn().mockResolvedValue(uniformWindGrid(12, 0)),
          save: vi.fn().mockRejectedValue(new Error('quota')),
          makeClient: () => new RoutingClient(() => w as unknown as Worker),
        }),
      { wrapper: AppStateProvider },
    );
    let run!: Promise<void>;
    await act(async () => {
      run = result.current.run(REQ, 'plan');
      await flush();
    });
    await flush();
    const sent = w.posted.find((m) => m.type === 'plan');
    if (sent?.type !== 'plan') throw new Error('expected a plan message');
    await act(async () => {
      w.emit({ type: 'result', id: sent.id, result: OK_RESULT });
      await run;
    });

    const call = error.mock.calls.find((c) => c[0] === '[SailCommand] saving the plan failed');
    expect(call?.[1]).toEqual({ kind: 'persist-failed' });
  });
});
