import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneWindGrid, rerouteFromFix, useLiveReroute } from './reroute';
import { type ReplanClient } from './replan';
import { RoutingError, type RoutingFailureKind } from '../routing/workerClient';
import type { MsgKey } from '../i18n/dict.de';
import * as openMeteoModule from '../services/openMeteo';
import { __resetDbForTests } from '../services/db';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SAIL_IDS } from '../data/boats';
import {
  DEFAULT_SETTINGS,
  type LatLon,
  type NoRouteReason,
  type Plan,
  type PlanRequest,
  type PlanResultOk,
} from '../types';

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const VIA: LatLon = { lat: 54.9, lon: 10.2 };
const FIX: LatLon = { lat: 54.83, lon: 9.53 };
const HOUR = 3_600_000;
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
// The fixture grid below starts one hour before departure and carries 48
// hourly steps, so its last covered hour is literally:
//   (DEPARTURE_MS - 1h) + 47h = DEPARTURE_MS + 46h.
const GRID_T0_MS = DEPARTURE_MS - HOUR;
const HORIZON_MS = DEPARTURE_MS + 46 * HOUR;
// "Now" for the happy paths: mid-passage, well inside the grid's coverage.
const NOW_MS = DEPARTURE_MS + 2 * HOUR;

const OK_RESULT: PlanResultOk = {
  status: 'ok',
  sails: [
    {
      sailId: 'genoa',
      result: {
        sailId: 'genoa',
        legs: [],
        etaMs: NOW_MS + HOUR,
        durationMs: HOUR,
        distanceNm: 10,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      reason: null,
    },
    { sailId: 'fock', result: null, reason: 'calm-motor-off' },
  ],
  recommended: 'genoa',
  comparisonComplete: true,
  snappedOrigin: FIX,
  snappedDestination: DESTINATION,
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const windGrid = uniformWindGrid(12, 0, { t0Ms: GRID_T0_MS, hours: 48 });
  return {
    id: 'plan-1',
    name: 'Flensburg → Marstal',
    createdAtMs: GRID_T0_MS,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [VIA],
      originHarborId: 'de-flensburg',
      destinationHarborId: 'dk-marstal',
      departureMs: DEPARTURE_MS,
      settings: { ...DEFAULT_SETTINGS },
      sailIds: ['genoa', 'fock'],
    },
    windGrid,
    result: OK_RESULT,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cloneWindGrid', () => {
  it('deep-copies every array/typed-array field with equal content and fresh identities', () => {
    const grid = uniformWindGrid(12, 270, { t0Ms: GRID_T0_MS, hours: 3 });
    const clone = cloneWindGrid(grid);

    expect(clone).not.toBe(grid);
    expect(clone.lats).not.toBe(grid.lats);
    expect(clone.lons).not.toBe(grid.lons);
    expect(clone.timesMs).not.toBe(grid.timesMs);
    expect(clone.speedKn).not.toBe(grid.speedKn);
    expect(clone.speedKn.buffer).not.toBe(grid.speedKn.buffer);
    expect(clone.dirFromDeg).not.toBe(grid.dirFromDeg);
    expect(clone.gustKn).not.toBe(grid.gustKn);
    expect(clone).toEqual(grid);
  });
});

describe('rerouteFromFix', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('seeds the request literally from the fix: fix origin, plan destination, NO vias, cleared origin harbor, kept destination harbor, departure = now', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    expect(client.plan).toHaveBeenCalledTimes(1);
    const [request, windGrid] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    // Literal expectation, recomputed from the fixture — not derived from the
    // function under test.
    expect(request).toEqual({
      origin: { lat: 54.83, lon: 9.53 },
      destination: { lat: 54.75, lon: 10.4 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: 'dk-marstal',
      departureMs: Date.UTC(2026, 6, 15, 10, 0, 0),
      settings: DEFAULT_SETTINGS,
      // #54: rerouteFromFix reroutes the SAME sails the plan being rerouted
      // was originally solved with — makePlan()'s fixture requests both.
      sailIds: ['genoa', 'fock'],
    });
    // Copied, never aliased: mutating the request later must not reach the
    // caller's fix object or the original plan's request.
    expect(request.origin).not.toBe(FIX);
    expect(request.destination).not.toBe(plan.request.destination);
    expect(request.settings).not.toBe(plan.request.settings);
    // The STORED grid goes to the worker — same object identity, no refetch.
    expect(windGrid).toBe(plan.windGrid);
  });

  // #243 fix wave item 3: a plan saved before depthComfortMarginM existed on
  // Settings has that field simply absent from its stored snapshot (an old
  // IndexedDB record, never migrated). Without backfilling from
  // DEFAULT_SETTINGS first, rerouteFromFix would carry `undefined` forward
  // into a field typed as a required `number`, and — because
  // planRoute.ts:133 treats "not > 0" as "off" — would silently disable the
  // depth comfort preference on every reroute of that old plan.
  it('backfills depthComfortMarginM (and any other newer field) from DEFAULT_SETTINGS on a pre-#243-shaped saved plan', async () => {
    const oldShapedSettings = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
    delete oldShapedSettings.depthComfortMarginM;
    const plan = makePlan({
      request: {
        ...makePlan().request,
        settings: oldShapedSettings as typeof DEFAULT_SETTINGS,
      },
    });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.settings.depthComfortMarginM).toBe(DEFAULT_SETTINGS.depthComfortMarginM);
  });

  // #254: same mechanism as the depthComfortMarginM case above. A plan saved
  // before sailPreferenceKn existed has the field absent from its snapshot;
  // without the DEFAULT_SETTINGS backfill, rerouteFromFix would carry
  // `undefined` into a required `number`, and the floor computation in
  // isochrone.ts (`Math.max(motorThresholdKn, motorSpeedKn - undefined)`)
  // would evaluate to NaN. Every `sailSpeed >= NaN` comparison is false, so
  // the decision falls through to the motor branch unconditionally — the
  // route would silently go all-motor, not lose its motor legs.
  it('backfills sailPreferenceKn from DEFAULT_SETTINGS on a pre-#254-shaped saved plan', async () => {
    const oldShapedSettings = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
    delete oldShapedSettings.sailPreferenceKn;
    const plan = makePlan({
      request: {
        ...makePlan().request,
        settings: oldShapedSettings as typeof DEFAULT_SETTINGS,
      },
    });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.settings.sailPreferenceKn).toBe(DEFAULT_SETTINGS.sailPreferenceKn);
  });

  // #54 fix round 1: same mechanism as the two backfill cases above, on a
  // field OUTSIDE Settings this time. A plan saved before sailIds existed on
  // PlanRequest (pre-multi-boat) does not carry the key at all in its stored
  // snapshot; without backfilling from DEFAULT_SAIL_IDS, planRoute.ts's
  // `runAll` calls `req.sailIds.map(...)` unconditionally —
  // throwing on reroute of a pre-#54 plan rather than degrading.
  it('backfills sailIds from DEFAULT_SAIL_IDS on a pre-#54-shaped saved plan', async () => {
    // The local cast is what makes `delete` compile on `PlanRequest.sailIds`
    // — the depthComfortMarginM/sailPreferenceKn tests above need no such
    // cast, since Settings's own fields are not readonly.
    const oldShapedRequest = { ...makePlan().request } as Partial<{
      -readonly [K in keyof PlanRequest]: PlanRequest[K];
    }>;
    delete oldShapedRequest.sailIds;
    const plan = makePlan({ request: oldShapedRequest as PlanRequest });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sailIds).toEqual(DEFAULT_SAIL_IDS);
    // The old plan's other fields are still preserved verbatim.
    expect(request.destinationHarborId).toBe('dk-marstal');
  });

  // #54 review round 3: the INHERITANCE half of the backfill ternary. Every
  // other sailIds fixture here is ['genoa', 'fock'], which is value-equal to
  // DEFAULT_SAIL_IDS — so no assertion against one of those can tell an
  // inherited list from a hardcoded default. A non-default fixture can.
  it("reroutes the saved plan's OWN sails, not the default", async () => {
    const plan = makePlan({ request: { ...makePlan().request, sailIds: ['fock'] } });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sailIds).toEqual(['fock']);
  });

  // #54 review round 2: rerouteFromFix's own "copied, never aliased" contract
  // covers sailIds too, and until now nothing discriminated a copy from an
  // alias on either branch — a refactor could drop the spreads and stay
  // green. The two branches share no code, so each needs its own row: the
  // present-field branch must not hand out the saved plan's array (mutating
  // the reroute request would rewrite the original plan's request in place),
  // and the absent-field branch must not hand out the DEFAULT_SAIL_IDS
  // module constant (which every later backfill would then inherit).
  it("copies sailIds, never aliasing the saved plan's array", async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sailIds).toEqual(plan.request.sailIds);
    expect(request.sailIds).not.toBe(plan.request.sailIds);
  });

  it('copies the backfill, never aliasing the DEFAULT_SAIL_IDS module constant', async () => {
    const oldShapedRequest = { ...makePlan().request } as Partial<{
      -readonly [K in keyof PlanRequest]: PlanRequest[K];
    }>;
    delete oldShapedRequest.sailIds;
    const plan = makePlan({ request: oldShapedRequest as PlanRequest });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sailIds).toEqual(DEFAULT_SAIL_IDS);
    expect(request.sailIds).not.toBe(DEFAULT_SAIL_IDS);
  });

  it('never fetches: zero network calls and no fetchWindGrid, even with navigator.onLine === false', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const fetchWindSpy = vi.spyOn(openMeteoModule, 'fetchWindGrid');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);

    const rerouted = await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    expect(rerouted.result).toBe(OK_RESULT);
    expect(fetchWindSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('persists a NEW plan (fresh id, given name, createdAt = now) and returns it', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const save = vi.fn().mockResolvedValue(undefined);

    const rerouted = await rerouteFromFix(plan, FIX, NOW_MS, 'Flensburg → Marstal (replanned)', {
      client,
      save,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(rerouted);
    expect(rerouted.id).not.toBe(plan.id);
    expect(rerouted.name).toBe('Flensburg → Marstal (replanned)');
    expect(rerouted.createdAtMs).toBe(NOW_MS);
    expect(rerouted.result).toBe(OK_RESULT);
    // The new plan carries a deep COPY of the stored grid (equal content,
    // fresh identities) — two saved plans must not share mutable state.
    expect(rerouted.windGrid).not.toBe(plan.windGrid);
    expect(rerouted.windGrid.speedKn).not.toBe(plan.windGrid.speedKn);
    expect(rerouted.windGrid).toEqual(plan.windGrid);
  });

  it('leaves the original plan untouched: request deep-equal and grid identity + content intact', async () => {
    const plan = makePlan();
    const gridRef = plan.windGrid;
    const speedRef = plan.windGrid.speedKn;
    const dirRef = plan.windGrid.dirFromDeg;
    const gustRef = plan.windGrid.gustKn;
    const requestSnapshot = structuredClone(plan.request);
    const speedSnapshot = plan.windGrid.speedKn.slice(0);
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    expect(plan.id).toBe('plan-1');
    expect(plan.request).toEqual(requestSnapshot);
    expect(plan.request.viaPoints).toEqual([{ lat: 54.9, lon: 10.2 }]);
    expect(plan.windGrid).toBe(gridRef);
    expect(plan.windGrid.speedKn).toBe(speedRef);
    expect(plan.windGrid.dirFromDeg).toBe(dirRef);
    expect(plan.windGrid.gustKn).toBe(gustRef);
    expect(plan.windGrid.speedKn).toEqual(speedSnapshot);
  });

  it('defaults to the real savePlan when deps.save is omitted, and the original stays retrievable alongside the reroute', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const { savePlan, getPlan } = await import('../services/db');
    await savePlan(plan);

    const rerouted = await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client });

    const persistedOriginal = await getPlan('plan-1');
    const persistedReroute = await getPlan(rerouted.id);
    expect(persistedOriginal?.request.origin).toEqual({ lat: 54.75, lon: 10.0 });
    expect(persistedReroute?.request.origin).toEqual({ lat: 54.83, lon: 9.53 });
    expect(persistedReroute?.name).toBe('Rerouted');
  });

  it('throws ReplanError(error.rerouteStaleWind) when now is past the stored grid horizon, without calling the client or saving', async () => {
    const plan = makePlan();
    // Literal horizon, recomputed from the fixture parameters (t0 = departure
    // - 1h, 48 hourly steps): Date.UTC(2026, 6, 17, 6:00) = departure + 46 h.
    expect(plan.windGrid.timesMs[plan.windGrid.timesMs.length - 1]).toBe(
      Date.UTC(2026, 6, 17, 6, 0, 0),
    );
    const client: ReplanClient = { plan: vi.fn() };
    const save = vi.fn();

    await expect(
      rerouteFromFix(plan, FIX, HORIZON_MS + 1, 'Rerouted', { client, save }),
    ).rejects.toMatchObject({ messageKey: 'error.rerouteStaleWind' });
    expect(client.plan).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not throw when now sits exactly on the grid horizon (boundary inclusive, mirrors replanWithVias)', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await expect(
      rerouteFromFix(plan, FIX, HORIZON_MS, 'Rerouted', {
        client,
        save: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBeDefined();
  });

  it('maps a snap-failed-origin result (GPS fix outside the mask/region or not navigable) to the dedicated error.rerouteFixOutside key, without saving', async () => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'snap-failed-origin' }),
    };
    const save = vi.fn();

    await expect(
      rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client, save }),
    ).rejects.toMatchObject({ messageKey: 'error.rerouteFixOutside' });
    expect(save).not.toHaveBeenCalled();
  });

  it.each<[NoRouteReason, string]>([
    ['unreachable', 'error.noRoute.unreachable'],
    ['beyond-horizon', 'error.noRoute.beyondHorizon'],
    ['calm-motor-off', 'error.noRoute.calmMotorOff'],
    ['snap-failed-destination', 'error.noRoute.snapDestination'],
  ])(
    'maps every other no-route reason (%s) to the standard key (%s)',
    async (reason, messageKey) => {
      const plan = makePlan();
      const client: ReplanClient = { plan: vi.fn().mockResolvedValue({ status: 'error', reason }) };
      const save = vi.fn();

      await expect(
        rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client, save }),
      ).rejects.toMatchObject({ messageKey });
      expect(save).not.toHaveBeenCalled();
    },
  );

  // #432: mirrors replan.test.ts's table. Same bare-`catch {}` defect, same
  // fix, and this is the path that matters most for a timeout — it is reached
  // from Live view, mid-passage. Expected keys hand-written per kind, not read
  // off ROUTING_FAILURE_MESSAGE_KEY.
  it.each<[RoutingFailureKind, MsgKey]>([
    ['timeout', 'error.routingTimeout'],
    ['worker-fatal', 'error.routingFailed'],
    ['worker-error', 'error.routingCrashed'],
    ['messageerror', 'error.routingMessageError'],
    ['disposed', 'error.routingInterrupted'],
  ])('preserves RoutingError kind %s as ReplanError(%s)', async (kind, messageKey) => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockRejectedValue(new RoutingError(kind, `simulated ${kind}`)),
    };

    await expect(rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client })).rejects.toMatchObject({
      messageKey,
    });
  });

  it('falls back to error.internal for a throw that is not a RoutingError', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockRejectedValue(new Error('worker crashed')) };

    await expect(rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client })).rejects.toMatchObject({
      messageKey: 'error.internal',
    });
  });

  it('disposes the client after a rejected plan(), so a retry gets a fresh worker', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = {
      plan: vi.fn().mockRejectedValue(new RoutingError('timeout', 'routing timed out')),
      dispose,
    };

    await expect(rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client })).rejects.toBeDefined();
    expect(dispose, 'a timed-out reroute must dispose its client').toHaveBeenCalledTimes(1);
  });

  it('does NOT dispose the client on a successful reroute', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT), dispose };

    await rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('maps a rejected save() to ReplanError(error.planSaveFailed), and leaves the client alone', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT), dispose };
    const save = vi.fn().mockRejectedValue(new Error('idb full'));

    await expect(
      rerouteFromFix(plan, FIX, NOW_MS, 'Rerouted', { client, save }),
    ).rejects.toMatchObject({ messageKey: 'error.planSaveFailed' });
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe('useLiveReroute', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useLiveReroute(() => Promise.resolve(null)));
    expect(result.current.state).toEqual({ rerouting: false, error: null });
  });

  it('a failed ensureClient surfaces error.replanInit — not a silent no-op', async () => {
    const ensureClient = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useLiveReroute(ensureClient));

    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.reroute(makePlan(), FIX, 'Rerouted');
    });

    expect(outcome).toBeNull();
    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ rerouting: false, error: 'error.replanInit' });
  });

  it('uses the injected clock as the departure and returns the rerouted plan on success', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const { result } = renderHook(() =>
      useLiveReroute(() => Promise.resolve(client), {
        save: vi.fn().mockResolvedValue(undefined),
        now: () => NOW_MS,
      }),
    );

    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.reroute(plan, FIX, 'Rerouted');
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.name).toBe('Rerouted');
    expect(outcome!.request.departureMs).toBe(Date.UTC(2026, 6, 15, 10, 0, 0));
    expect(result.current.state).toEqual({ rerouting: false, error: null });
  });

  it('transitions rerouting true while the solve is in flight', async () => {
    const plan = makePlan();
    let resolvePlan!: (r: PlanResultOk) => void;
    const client: ReplanClient = {
      plan: vi.fn(
        () =>
          new Promise<PlanResultOk>((res) => {
            resolvePlan = res;
          }),
      ),
    };
    const { result } = renderHook(() =>
      useLiveReroute(() => Promise.resolve(client), {
        save: vi.fn().mockResolvedValue(undefined),
        now: () => NOW_MS,
      }),
    );

    let reroutePromise!: Promise<Plan | null>;
    act(() => {
      reroutePromise = result.current.reroute(plan, FIX, 'Rerouted');
    });
    await waitFor(() => expect(result.current.state.rerouting).toBe(true));

    await act(async () => {
      resolvePlan(OK_RESULT);
      await reroutePromise;
    });
    expect(result.current.state.rerouting).toBe(false);
  });

  it('a second reroute() while one is in flight is a guarded no-op — the guard is set before ensureClient is even awaited', async () => {
    const plan = makePlan();
    let resolvePlan!: (r: PlanResultOk) => void;
    const client: ReplanClient = {
      plan: vi.fn(
        () =>
          new Promise<PlanResultOk>((res) => {
            resolvePlan = res;
          }),
      ),
    };
    const ensureClient = vi.fn().mockResolvedValue(client);
    const { result } = renderHook(() =>
      useLiveReroute(ensureClient, {
        save: vi.fn().mockResolvedValue(undefined),
        now: () => NOW_MS,
      }),
    );

    let first!: Promise<Plan | null>;
    let second!: Promise<Plan | null>;
    act(() => {
      first = result.current.reroute(plan, FIX, 'Rerouted');
      second = result.current.reroute(plan, FIX, 'Rerouted');
    });

    expect(ensureClient).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.plan).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePlan(OK_RESULT);
      await Promise.all([first, second]);
    });
    expect(await second).toBeNull();
  });

  it('surfaces the ReplanError messageKey on failure, and clearError resets it', async () => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'snap-failed-origin' }),
    };
    const { result } = renderHook(() =>
      useLiveReroute(() => Promise.resolve(client), { now: () => NOW_MS }),
    );

    await act(async () => {
      await result.current.reroute(plan, FIX, 'Rerouted');
    });
    expect(result.current.state).toEqual({ rerouting: false, error: 'error.rerouteFixOutside' });

    act(() => result.current.clearError());
    expect(result.current.state.error).toBeNull();
  });

  it('a reroute() after a prior one settled is not blocked (guard is per-call)', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const { result } = renderHook(() =>
      useLiveReroute(() => Promise.resolve(client), {
        save: vi.fn().mockResolvedValue(undefined),
        now: () => NOW_MS,
      }),
    );

    await act(async () => {
      await result.current.reroute(plan, FIX, 'Rerouted');
    });
    await act(async () => {
      await result.current.reroute(plan, FIX, 'Rerouted');
    });
    expect(client.plan).toHaveBeenCalledTimes(2);
  });

  it('returns a stable {state, reroute, clearError} object identity across renders that do not change state', () => {
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const ensureClient = () => Promise.resolve(client);
    const { result, rerender } = renderHook(() => useLiveReroute(ensureClient));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
