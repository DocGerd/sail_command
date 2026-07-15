import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupeViaPoints, ReplanError, replanWithVias, useViaReplan, type ReplanClient } from './replan';
import { destinationPoint } from '../lib/geo';
import * as openMeteoModule from '../services/openMeteo';
import { __resetDbForTests } from '../services/db';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type LatLon, type NoRouteReason, type Plan, type PlanResultOk } from '../types';

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

const OK_RESULT: PlanResultOk = {
  status: 'ok',
  genoa: {
    rig: 'genoa', legs: [], etaMs: DEPARTURE_MS + 3_600_000, durationMs: 3_600_000,
    distanceNm: 10, maneuverCount: 0, motorDistanceNm: 0,
  },
  fock: null,
  genoaReason: null,
  fockReason: 'calm-motor-off',
  recommended: 'genoa',
  snappedOrigin: ORIGIN,
  snappedDestination: DESTINATION,
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const windGrid = uniformWindGrid(12, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 48 });
  return {
    id: 'plan-1',
    name: 'Test plan',
    createdAtMs: DEPARTURE_MS - 3_600_000,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
    },
    windGrid,
    result: OK_RESULT,
    ...overrides,
  };
}

describe('dedupeViaPoints', () => {
  it('keeps a via that is far from every other waypoint', () => {
    const via = { lat: 54.9, lon: 10.2 };
    const { kept, droppedCount } = dedupeViaPoints(ORIGIN, [via], DESTINATION);
    expect(kept).toEqual([via]);
    expect(droppedCount).toBe(0);
  });

  it('drops a via within 60 m of the origin', () => {
    const tooClose = destinationPoint(ORIGIN, 45, 50 / 1852); // 50 m from origin
    const { kept, droppedCount } = dedupeViaPoints(ORIGIN, [tooClose], DESTINATION);
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('drops a via within 60 m of the destination', () => {
    const tooClose = destinationPoint(DESTINATION, 200, 50 / 1852);
    const { kept, droppedCount } = dedupeViaPoints(ORIGIN, [tooClose], DESTINATION);
    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('keeps a via just past the 60 m threshold (strict <, not <=)', () => {
    // destinationPoint/haversineNm round-trip introduces sub-meter floating-
    // point error, so a hair past 60 m (not exactly 60 m) is what actually
    // pins the "strict less-than" boundary without being coordinate-system-fragile.
    const justPast = destinationPoint(ORIGIN, 90, 61 / 1852);
    const { kept, droppedCount } = dedupeViaPoints(ORIGIN, [justPast], DESTINATION);
    expect(kept).toEqual([justPast]);
    expect(droppedCount).toBe(0);
  });

  it('drops a second via too close to a kept prior via (sequential, not pairwise-against-origin)', () => {
    const via1 = { lat: 54.85, lon: 10.1 };
    const via2 = destinationPoint(via1, 10, 50 / 1852); // close to via1, far from origin
    const { kept, droppedCount } = dedupeViaPoints(ORIGIN, [via1, via2], DESTINATION);
    expect(kept).toEqual([via1]);
    expect(droppedCount).toBe(1);
  });

  it('a via that collapses into origin does not become the "previous" for the next via', () => {
    // via1 collapses into origin; via2 is far from via1 but must still be
    // measured against origin (the last *kept* waypoint), not the dropped via1.
    const via1 = destinationPoint(ORIGIN, 0, 50 / 1852); // dropped: too close to origin
    const via2 = { lat: 54.9, lon: 10.2 }; // far from both origin and via1
    const { kept, droppedCount } = dedupeViaPoints(ORIGIN, [via1, via2], DESTINATION);
    expect(kept).toEqual([via2]);
    expect(droppedCount).toBe(1);
  });

  it('an empty via list is a no-op', () => {
    expect(dedupeViaPoints(ORIGIN, [], DESTINATION)).toEqual({ kept: [], droppedCount: 0 });
  });
});

describe('replanWithVias', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('reuses the plan\'s stored windGrid (same object identity) and never calls fetchWindGrid', async () => {
    const plan = makePlan();
    const via = { lat: 54.9, lon: 10.2 };
    const fetchWindSpy = vi.spyOn(openMeteoModule, 'fetchWindGrid');
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    const updated = await replanWithVias(plan, [via], { client, save: vi.fn().mockResolvedValue(undefined) });

    expect(fetchWindSpy).not.toHaveBeenCalled();
    expect(client.plan).toHaveBeenCalledTimes(1);
    const [request, windGrid] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(windGrid).toBe(plan.windGrid); // the stored grid, not a re-fetched one
    expect(request.viaPoints).toEqual([via]);
    expect(request.settings).toBe(plan.request.settings); // same settings snapshot
    expect(updated.windGrid).toBe(plan.windGrid);
  });

  it('saves an updated Plan with the same id, request.viaPoints and result replaced', async () => {
    const plan = makePlan();
    const via = { lat: 54.9, lon: 10.2 };
    const newResult: PlanResultOk = { ...OK_RESULT, recommended: 'fock' };
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(newResult) };
    const save = vi.fn().mockResolvedValue(undefined);

    const updated = await replanWithVias(plan, [via], { client, save });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(updated);
    expect(updated.id).toBe(plan.id);
    expect(updated.name).toBe(plan.name);
    expect(updated.request.viaPoints).toEqual([via]);
    expect(updated.result).toBe(newResult);
  });

  it('defaults to the real savePlan when deps.save is omitted', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    const updated = await replanWithVias(plan, [], { client });

    const persisted = await (await import('../services/db')).getPlan(updated.id);
    expect(persisted).toBeDefined();
    expect(persisted?.id).toBe(plan.id);
    expect(persisted?.result).toEqual(OK_RESULT);
  });

  it('throws ReplanError(error.replanStaleWind) when departureMs is beyond the stored grid horizon, without calling the client or saving', async () => {
    const plan = makePlan();
    const horizonMs = plan.windGrid.timesMs[plan.windGrid.timesMs.length - 1];
    const staleplan = makePlan({
      request: { ...plan.request, departureMs: horizonMs + 3_600_000 },
    });
    const client: ReplanClient = { plan: vi.fn() };
    const save = vi.fn();

    await expect(replanWithVias(staleplan, [], { client, save })).rejects.toMatchObject({
      messageKey: 'error.replanStaleWind',
    });
    expect(client.plan).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not throw when departureMs sits exactly on the grid\'s last hour (boundary inclusive)', async () => {
    const plan = makePlan();
    const horizonMs = plan.windGrid.timesMs[plan.windGrid.timesMs.length - 1];
    const boundaryPlan = makePlan({ request: { ...plan.request, departureMs: horizonMs } });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await expect(replanWithVias(boundaryPlan, [], { client, save: vi.fn().mockResolvedValue(undefined) })).resolves.toBeDefined();
  });

  it.each<[NoRouteReason, string]>([
    ['unreachable', 'error.noRoute.unreachable'],
    ['snap-failed-via', 'error.noRoute.snapVia'],
  ])('maps a no-route result reason %s to ReplanError(%s)', async (reason, messageKey) => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue({ status: 'error', reason }) };
    const save = vi.fn();

    await expect(replanWithVias(plan, [], { client, save })).rejects.toMatchObject({ messageKey });
    expect(save).not.toHaveBeenCalled();
  });

  it('maps a rejected client.plan() (worker fatal) to ReplanError(error.internal)', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockRejectedValue(new Error('worker crashed')) };

    await expect(replanWithVias(plan, [], { client })).rejects.toMatchObject({ messageKey: 'error.internal' });
  });

  it('maps a rejected save() to ReplanError(error.internal)', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const save = vi.fn().mockRejectedValue(new Error('idb full'));

    await expect(replanWithVias(plan, [], { client, save })).rejects.toMatchObject({ messageKey: 'error.internal' });
  });

  it('drops a too-close via before submitting the request (ledgered intake, enforced regardless of caller)', async () => {
    const plan = makePlan();
    const tooClose = destinationPoint(ORIGIN, 45, 50 / 1852);
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await replanWithVias(plan, [tooClose], { client, save: vi.fn().mockResolvedValue(undefined) });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.viaPoints).toEqual([]);
  });

  it('ReplanError carries both a messageKey and a human-readable message (mirrors OpenMeteoError)', () => {
    const err = new ReplanError('error.internal', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReplanError');
    expect(err.messageKey).toBe('error.internal');
    expect(err.message).toBe('boom');
  });
});

describe('useViaReplan', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useViaReplan(() => null));
    expect(result.current.state).toEqual({ replanning: false, error: null, droppedCount: 0 });
  });

  it('replace() is a no-op (returns null, does not call client) when client is null', async () => {
    const { result } = renderHook(() => useViaReplan(() => null));
    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.replace(makePlan(), []);
    });
    expect(outcome).toBeNull();
  });

  it('a successful replace() transitions replanning true then false, and returns the updated plan', async () => {
    const plan = makePlan();
    let resolvePlan!: (r: PlanResultOk) => void;
    const client: ReplanClient = {
      plan: vi.fn(() => new Promise<PlanResultOk>((res) => { resolvePlan = res; })),
    };
    const { result } = renderHook(() => useViaReplan(() => client, { save: vi.fn().mockResolvedValue(undefined) }));

    let replacePromise!: Promise<Plan | null>;
    act(() => {
      replacePromise = result.current.replace(plan, []);
    });
    await waitFor(() => expect(result.current.state.replanning).toBe(true));

    await act(async () => {
      resolvePlan(OK_RESULT);
      await replacePromise;
    });

    expect(result.current.state).toEqual({ replanning: false, error: null, droppedCount: 0 });
  });

  it('a second replace() call while one is in flight is a guarded no-op (same pattern as usePlanFlow.run)', async () => {
    const plan = makePlan();
    let resolvePlan!: (r: PlanResultOk) => void;
    const client: ReplanClient = {
      plan: vi.fn(() => new Promise<PlanResultOk>((res) => { resolvePlan = res; })),
    };
    const { result } = renderHook(() => useViaReplan(() => client, { save: vi.fn().mockResolvedValue(undefined) }));

    let first!: Promise<Plan | null>;
    let second!: Promise<Plan | null>;
    act(() => {
      first = result.current.replace(plan, [{ lat: 54.9, lon: 10.1 }]);
      second = result.current.replace(plan, [{ lat: 54.91, lon: 10.11 }]);
    });

    expect(client.plan).toHaveBeenCalledTimes(1); // the second call never reached the client

    await act(async () => {
      resolvePlan(OK_RESULT);
      await Promise.all([first, second]);
    });

    expect(await second).toBeNull();
  });

  it('surfaces the ReplanError messageKey on a failed replace(), and clearError resets it', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'unreachable' }) };
    const { result } = renderHook(() => useViaReplan(() => client));

    await act(async () => {
      await result.current.replace(plan, []);
    });
    expect(result.current.state.error).toBe('error.noRoute.unreachable');
    expect(result.current.state.replanning).toBe(false);

    act(() => result.current.clearError());
    expect(result.current.state.error).toBeNull();
  });

  it('surfaces droppedCount when a via was silently filtered, on both success and failure', async () => {
    const plan = makePlan();
    const tooClose = destinationPoint(ORIGIN, 45, 50 / 1852);
    const okClient: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const { result: okResult } = renderHook(() => useViaReplan(() => okClient, { save: vi.fn().mockResolvedValue(undefined) }));
    await act(async () => {
      await okResult.current.replace(plan, [tooClose]);
    });
    expect(okResult.current.state.droppedCount).toBe(1);

    const failClient: ReplanClient = { plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'unreachable' }) };
    const { result: failResult } = renderHook(() => useViaReplan(() => failClient));
    await act(async () => {
      await failResult.current.replace(plan, [tooClose]);
    });
    expect(failResult.current.state.droppedCount).toBe(1);
  });

  it('a replace() after a prior one settled is not blocked by the guard (guard is per-call, not permanent)', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const { result } = renderHook(() => useViaReplan(() => client, { save: vi.fn().mockResolvedValue(undefined) }));

    await act(async () => {
      await result.current.replace(plan, []);
    });
    await act(async () => {
      await result.current.replace(plan, []);
    });

    expect(client.plan).toHaveBeenCalledTimes(2);
  });
});
