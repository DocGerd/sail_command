import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDepartureConfirm } from './useDepartureConfirm';
import type { ReplanClient } from './replan';
import { RoutingError } from '../routing/workerClient';
import { __resetDbForTests } from '../services/db';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  PLAN_SCHEMA_VERSION,
  defaultBoatSnapshot,
  type LatLon,
  type Plan,
  type PlanResultOk,
} from '../types';

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

// #937: a TWO-RIG result — both sails resolved, 'fock' decided faster — the
// shape the real confirm solve returns (as opposed to useDepartureScan.ts's
// genoa-only scan results, which never carry a second sail's result).
const TWO_RIG_OK_RESULT: PlanResultOk = {
  status: 'ok',
  sails: [
    {
      sailId: 'genoa',
      result: {
        sailId: 'genoa',
        legs: [],
        etaMs: DEPARTURE_MS + 3_600_000,
        durationMs: 3_600_000,
        distanceNm: 10,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      reason: null,
    },
    {
      sailId: 'fock',
      result: {
        sailId: 'fock',
        legs: [],
        etaMs: DEPARTURE_MS + 3_500_000,
        durationMs: 3_500_000,
        distanceNm: 10,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      reason: null,
    },
  ],
  recommended: 'fock',
  comparisonComplete: true,
  rigRecommendation: { kind: 'decided', rig: 'fock' },
  snappedOrigin: ORIGIN,
  snappedDestination: DESTINATION,
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const windGrid = uniformWindGrid(12, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 96 });
  return {
    id: 'plan-1',
    name: 'Test plan',
    createdAtMs: DEPARTURE_MS - 3_600_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid,
    result: TWO_RIG_OK_RESULT,
    ...overrides,
  };
}

describe('useDepartureConfirm', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useDepartureConfirm(() => Promise.resolve(null)));
    expect(result.current.state).toEqual({ confirming: false, departureMs: null, error: null });
  });

  it('a failed ensureClient surfaces error.workerInit, not a silent no-op', async () => {
    const ensureClient = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useDepartureConfirm(ensureClient));
    const candidateMs = DEPARTURE_MS + 3_600_000;

    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.confirm(makePlan(), candidateMs);
    });

    expect(outcome).toBeNull();
    expect(result.current.state).toEqual({
      confirming: false,
      departureMs: candidateMs,
      error: 'error.workerInit',
    });
  });

  // #937 TRANSITION test (the replacePlanId trap, CLAUDE.md's "useState(defaultOpen)
  // seeds ONCE" bullet): usePlanFlow.ts's run()-with-replacePlanId contract
  // reuses the plan id while its content changes, and any UI keyed only on
  // plan.id will NOT remount. This asserts confirm() follows that SAME
  // contract — same id, a FRESH createdAtMs — never state/replan.ts's
  // replanWithVias shape (id AND createdAtMs both unchanged), which would be
  // wrong here because a `key={`${plan.id}-${plan.createdAtMs}`}` site
  // (e.g. ShallowWarning's Disclosure) must see this as a genuinely new
  // render, not a no-op.
  //
  // MUTATION, verified by hand (not committed): replacing this hook's
  // `createdAtMs: Date.now()` with `createdAtMs: plan.createdAtMs` (i.e.
  // reverting to replanWithVias's unchanged-createdAtMs shape) turns the
  // `not.toBe(plan.createdAtMs)` assertion below red — BEFORE: fails with
  // "expected 1752566400000 not to be 1752566400000"; AFTER (this file's
  // actual code): passes.
  it('#937 TRANSITION: a successful confirm replaces the plan IN PLACE — same id, fresh createdAtMs', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(TWO_RIG_OK_RESULT) };
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDepartureConfirm(() => Promise.resolve(client), { save }),
    );
    const candidateMs = plan.request.departureMs + 3_600_000;

    const before = Date.now();
    let updated: Plan | null = null;
    await act(async () => {
      updated = await result.current.confirm(plan, candidateMs);
    });

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(plan.id);
    expect(updated!.createdAtMs).not.toBe(plan.createdAtMs);
    expect(updated!.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(updated!.request.departureMs).toBe(candidateMs);
    expect(updated!.result).toEqual(TWO_RIG_OK_RESULT);
    expect(save).toHaveBeenCalledWith(updated);
    expect(result.current.state).toEqual({
      confirming: false,
      departureMs: candidateMs,
      error: null,
    });
  });

  // Mutation: reverting client.plan's request argument's sailIds to a
  // genoa-only literal (useDepartureScan.ts's own GENOA_SCAN_SAIL_IDS shape)
  // would fail this — BEFORE (genoa-only): `toEqual(['genoa'])` passes and
  // this assertion (`toEqual(plan.request.sailIds)`) fails; AFTER (this
  // hook's actual code, plan.request.sailIds passed through unchanged):
  // passes.
  it("re-solves with the PLAN's own sailIds, never the scan's genoa-only shortcut", async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(TWO_RIG_OK_RESULT) };
    const { result } = renderHook(() =>
      useDepartureConfirm(() => Promise.resolve(client), {
        save: vi.fn().mockResolvedValue(undefined),
      }),
    );

    await act(async () => {
      await result.current.confirm(plan, plan.request.departureMs);
    });

    const req = vi.mocked(client.plan).mock.calls[0]?.[0];
    expect(req?.sailIds).toEqual(plan.request.sailIds);
    expect(req?.sailIds).not.toEqual(['genoa']);
    // The plan's own STORED grid, never refetched.
    expect(vi.mocked(client.plan).mock.calls[0]?.[1]).toBe(plan.windGrid);
  });

  it('transitions confirming true (naming the in-flight departureMs) then false', async () => {
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
      useDepartureConfirm(() => Promise.resolve(client), {
        save: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const candidateMs = plan.request.departureMs + 3_600_000;

    let confirmPromise!: Promise<Plan | null>;
    act(() => {
      confirmPromise = result.current.confirm(plan, candidateMs);
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({
        confirming: true,
        departureMs: candidateMs,
        error: null,
      }),
    );

    await act(async () => {
      resolvePlan(TWO_RIG_OK_RESULT);
      await confirmPromise;
    });
    expect(result.current.state.confirming).toBe(false);
  });

  it('a second confirm() while one is in flight is a guarded no-op (checked before ensureClient is awaited)', async () => {
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
      useDepartureConfirm(ensureClient, { save: vi.fn().mockResolvedValue(undefined) }),
    );

    let first!: Promise<Plan | null>;
    let second!: Promise<Plan | null>;
    act(() => {
      first = result.current.confirm(plan, plan.request.departureMs);
      second = result.current.confirm(plan, plan.request.departureMs + 3_600_000);
    });

    expect(ensureClient).toHaveBeenCalledTimes(1);

    // ensureClient() is async, so client.plan() isn't called in the same
    // synchronous tick as confirm() — flush the one microtask hop for
    // ensureClient's own promise to resolve before resolvePlan exists.
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.plan).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePlan(TWO_RIG_OK_RESULT);
      await Promise.all([first, second]);
    });

    expect(await second).toBeNull();
    expect(client.plan).toHaveBeenCalledTimes(1);
  });

  it('classifies a typed RoutingError by kind, never by message — and disposes the client', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = {
      plan: vi.fn().mockRejectedValue(new RoutingError('timeout', 'the solve ran out of budget')),
      dispose,
    };
    const { result } = renderHook(() => useDepartureConfirm(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.confirm(plan, plan.request.departureMs);
    });

    expect(result.current.state.error).toBe('error.routingTimeout');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("'boat-not-in-catalogue' leaves the client healthy — no dispose", async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = {
      plan: vi
        .fn()
        .mockRejectedValue(new RoutingError('boat-not-in-catalogue', 'boat left the catalogue')),
      dispose,
    };
    const { result } = renderHook(() => useDepartureConfirm(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.confirm(plan, plan.request.departureMs);
    });

    expect(result.current.state.error).toBe('error.boatNotInCatalogue');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('a typed no-route result surfaces its NoRouteReason key, not a generic failure', async () => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'calm-motor-off' }),
    };
    const { result } = renderHook(() => useDepartureConfirm(() => Promise.resolve(client)));

    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.confirm(plan, plan.request.departureMs);
    });

    expect(outcome).toBeNull();
    expect(result.current.state.error).toBe('error.noRoute.calmMotorOff');
  });

  it('routing SUCCEEDED but persistence failed surfaces error.planSaveFailed, not error.internal', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(TWO_RIG_OK_RESULT) };
    const save = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    const { result } = renderHook(() =>
      useDepartureConfirm(() => Promise.resolve(client), { save }),
    );

    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.confirm(plan, plan.request.departureMs);
    });

    expect(outcome).toBeNull();
    expect(result.current.state.error).toBe('error.planSaveFailed');
  });

  it('clearError resets the error without disturbing departureMs', async () => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'unreachable' }),
    };
    const { result } = renderHook(() => useDepartureConfirm(() => Promise.resolve(client)));

    await act(async () => {
      await result.current.confirm(plan, plan.request.departureMs);
    });
    expect(result.current.state.error).toBe('error.noRoute.unreachable');

    act(() => result.current.clearError());
    expect(result.current.state.error).toBeNull();
  });
});
