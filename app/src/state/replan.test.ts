import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dedupeViaPoints,
  ReplanError,
  replanWithVias,
  useViaReplan,
  viaReplanDisabledReasonKey,
  type ReplanClient,
} from './replan';
import { destinationPoint } from '../lib/geo';
import { RoutingError, type RoutingFailureKind } from '../routing/workerClient';
import type { MsgKey } from '../i18n/dict.de';
import * as openMeteoModule from '../services/openMeteo';
import { __resetDbForTests } from '../services/db';
import { OFF_CATALOGUE_BOAT, uniformWindGrid } from '../test/fixtures';
import { migratePlan } from '../services/migratePlan';
import { DEFAULT_SAIL_IDS } from '../data/boats';
import {
  DEFAULT_SETTINGS,
  type LatLon,
  type NoRouteReason,
  type Plan,
  type PlanRequest,
  type PlanResultOk,
} from '../types';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

const OK_RESULT: PlanResultOk = {
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
    { sailId: 'fock', result: null, reason: 'calm-motor-off' },
  ],
  recommended: 'genoa',
  comparisonComplete: true,
  snappedOrigin: ORIGIN,
  snappedDestination: DESTINATION,
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const windGrid = uniformWindGrid(12, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 48 });
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

  it("reuses the plan's stored windGrid (same object identity) and never calls fetchWindGrid", async () => {
    const plan = makePlan();
    const via = { lat: 54.9, lon: 10.2 };
    const fetchWindSpy = vi.spyOn(openMeteoModule, 'fetchWindGrid');
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    const updated = await replanWithVias(plan, [via], {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    expect(fetchWindSpy).not.toHaveBeenCalled();
    expect(client.plan).toHaveBeenCalledTimes(1);
    const [request, windGrid] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(windGrid).toBe(plan.windGrid); // the stored grid, not a re-fetched one
    expect(request.viaPoints).toEqual([via]);
    expect(request.settings).toBe(plan.request.settings); // same settings snapshot
    expect(updated.windGrid).toBe(plan.windGrid);
  });

  // #54 review round 2: the third site that builds a router-bound request
  // from a persisted one — the same defect lib/recalc.ts and state/reroute.ts
  // were guarded against in round 1. A plan saved before `sailIds` existed on
  // PlanRequest does not carry the key at all in its stored snapshot; without
  // the backfill, planRoute.ts's `runAll` calls `req.sailIds.map(...)`
  // unconditionally, throwing inside the worker on via-replan of a pre-#54
  // plan rather than degrading.
  it('backfills sailIds from DEFAULT_SAIL_IDS on a pre-#54-shaped saved plan', async () => {
    // The local cast is what makes `delete` compile on `PlanRequest.sailIds`
    // — mirroring reroute.test.ts's and recalc.test.ts's same-named tests.
    const oldShapedRequest = { ...makePlan().request } as Partial<{
      -readonly [K in keyof PlanRequest]: PlanRequest[K];
    }>;
    delete oldShapedRequest.sailIds;
    const plan = makePlan({ request: oldShapedRequest as PlanRequest });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await replanWithVias(plan, [{ lat: 54.9, lon: 10.2 }], {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sailIds).toEqual(DEFAULT_SAIL_IDS);
    // The via list the call actually asked for is still carried through.
    expect(request.viaPoints).toEqual([{ lat: 54.9, lon: 10.2 }]);
  });

  // #54 Task 11: pins the PROPERTY the keeper below rests on, not just its
  // detection logic (#516). That keeper discriminates ONLY because ['fock']
  // is not value-equal to DEFAULT_SAIL_IDS; if the default boat's sail set
  // ever became exactly ['fock'], the keeper would degenerate into the
  // vacuity it was added to close and would still pass.
  it('#54: the non-default fixture below is genuinely non-default', () => {
    expect(DEFAULT_SAIL_IDS).not.toEqual(['fock']);
  });

  // #54 Task 11: the BOAT half of the same inheritance question. Replacing
  // this site's `plan.request.boat ?? defaultBoatSnapshot()` with a bare
  // `defaultBoatSnapshot()` left this suite and its recalc/reroute siblings
  // green — every fixture uses `defaultBoatSnapshot()`, so the substitution
  // is value-identical and nothing asserted identity. Spec §I.3 requires a
  // plan whose boat left the catalogue to keep its own; without this row a
  // regression re-labels a 2.4 m hull as a 2.1 m Salona 45 on every replan.
  it("replans with the saved plan's OWN boat snapshot, not the catalogue default", async () => {
    const plan = makePlan({
      request: { ...makePlan().request, boat: OFF_CATALOGUE_BOAT },
    });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await replanWithVias(plan, [{ lat: 54.9, lon: 10.2 }], {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.boat).toEqual(OFF_CATALOGUE_BOAT);
    // ALIASED here, deliberately — unlike lib/recalc.ts and state/reroute.ts
    // this site has no "copied, never aliased" contract (see its own
    // comment), so identity with the saved plan's snapshot is the pinned
    // behaviour, not an oversight.
    expect(request.boat).toBe(plan.request.boat);
  });

  // #54 review round 3: the INHERITANCE half of the backfill `??`. Every
  // other sailIds fixture here is ['genoa', 'fock'], which is value-equal to
  // DEFAULT_SAIL_IDS — so no assertion against one of those can tell an
  // inherited list from a hardcoded default. A non-default fixture can.
  it("replans the saved plan's OWN sails, not the default", async () => {
    const plan = makePlan({ request: { ...makePlan().request, sailIds: ['fock'] } });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await replanWithVias(plan, [{ lat: 54.9, lon: 10.2 }], {
      client,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sailIds).toEqual(['fock']);
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

  // #54: this site writes under the ORIGINAL record id (see getPlan's doc
  // comment in services/db.ts — the ACCEPTED RESIDUAL paragraph). What that
  // paragraph claims, and what this pins: the record left behind is a
  // COMPLETE current-shape record, so it re-reads through the normaliser
  // unchanged. It deliberately does NOT claim the pre-#54 legacy fields
  // survive — they do not, which is the residual itself, pinned in
  // services/db.test.ts.
  it('#54: the record it saves under the existing id stays readable', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const save = vi.fn().mockResolvedValue(undefined);

    await replanWithVias(plan, [{ lat: 54.9, lon: 10.2 }], { client, save });

    const saved = save.mock.calls[0][0] as Plan;
    const reread = migratePlan(saved);
    expect(reread).not.toBeNull();
    expect(reread!.id).toBe(plan.id);
    expect(reread!.createdAtMs).toBe(plan.createdAtMs);
    // Carried by reference, never re-serialised: the wind grid's
    // Float32Array fields survive only because nothing copies them.
    expect(reread!.windGrid).toBe(plan.windGrid);
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

  it("does not throw when departureMs sits exactly on the grid's last hour (boundary inclusive)", async () => {
    const plan = makePlan();
    const horizonMs = plan.windGrid.timesMs[plan.windGrid.timesMs.length - 1];
    const boundaryPlan = makePlan({ request: { ...plan.request, departureMs: horizonMs } });
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };

    await expect(
      replanWithVias(boundaryPlan, [], { client, save: vi.fn().mockResolvedValue(undefined) }),
    ).resolves.toBeDefined();
  });

  it.each<[NoRouteReason, string]>([
    ['unreachable', 'error.noRoute.unreachable'],
    ['snap-failed-via', 'error.noRoute.snapVia'],
    ['beyond-horizon', 'error.noRoute.beyondHorizon'],
    ['snap-failed-origin', 'error.noRoute.snapOrigin'],
    ['snap-failed-destination', 'error.noRoute.snapDestination'],
  ])('maps a no-route result reason %s to ReplanError(%s)', async (reason, messageKey) => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue({ status: 'error', reason }) };
    const save = vi.fn();

    await expect(replanWithVias(plan, [], { client, save })).rejects.toMatchObject({ messageKey });
    expect(save).not.toHaveBeenCalled();
  });

  // #432: this catch used to be a bare `catch {}` that threw away the
  // RoutingError and reported 'error.internal' for every kind alike — #433's
  // typed discriminator existed but had no effect on this path. The expected
  // keys below are hand-written from each kind's own meaning, NOT read off
  // ROUTING_FAILURE_MESSAGE_KEY, so a change to that table reds these rows
  // instead of silently following it (#50/#388).
  it.each<[RoutingFailureKind, MsgKey]>([
    ['timeout', 'error.routingTimeout'],
    ['worker-fatal', 'error.routingFailed'],
    ['worker-error', 'error.routingCrashed'],
    ['messageerror', 'error.routingMessageError'],
    ['disposed', 'error.routingInterrupted'],
    // #553: added with the kind itself. A five-element array typed by a
    // tuple type is NOT exhaustiveness-checked, so a sixth kind slips past
    // this table silently — measured in review: repointing the mapping to
    // 'error.routingTimeout' left 140 tests green.
    ['boat-not-in-catalogue', 'error.boatNotInCatalogue'],
  ])('preserves RoutingError kind %s as ReplanError(%s)', async (kind, messageKey) => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockRejectedValue(new RoutingError(kind, `simulated ${kind}`)),
    };

    await expect(replanWithVias(plan, [], { client })).rejects.toMatchObject({ messageKey });
  });

  it('falls back to error.internal for a throw that is not a RoutingError', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockRejectedValue(new Error('worker crashed')) };

    await expect(replanWithVias(plan, [], { client })).rejects.toMatchObject({
      messageKey: 'error.internal',
    });
  });

  // #432 part (b): the client is torn down so a RETRY is handed a fresh
  // worker. Without this the abandoned solve keeps running (the deadline
  // settles the promise, it does not terminate the thread) and the next
  // replan stacks onto a saturated worker.
  it('disposes the client after a rejected plan(), so a retry gets a fresh worker', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = {
      plan: vi.fn().mockRejectedValue(new RoutingError('timeout', 'routing timed out')),
      dispose,
    };

    await expect(replanWithVias(plan, [], { client })).rejects.toBeInstanceOf(ReplanError);
    expect(dispose, 'a timed-out replan must dispose its client').toHaveBeenCalledTimes(1);
  });

  // #553 MAJOR 5: the ONE rejection kind that must NOT tear the worker down.
  // `'boat-not-in-catalogue'` is raised by a client-side catalogue lookup
  // BEFORE plan() posts anything, so the worker never saw the request and is
  // healthy — disposing costs a full re-init (mask .slice(0) + transfer + the
  // polar map) for a lookup miss, and because dispose() calls failAll() it can
  // abort an UNRELATED in-flight plan on the shared singleton. Paired with the
  // timeout row above, which must keep disposing: the two together isolate the
  // kind as the deciding variable rather than asserting a blanket no-dispose.
  it('does NOT dispose the client when the boat is not in the catalogue', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = {
      plan: vi
        .fn()
        .mockRejectedValue(new RoutingError('boat-not-in-catalogue', 'boat not in catalogue: x')),
      dispose,
    };

    await expect(replanWithVias(plan, [], { client })).rejects.toMatchObject({
      messageKey: 'error.boatNotInCatalogue',
    });
    expect(
      dispose,
      'a catalogue-miss rejection must leave the healthy worker alone',
    ).not.toHaveBeenCalled();
  });

  it('does NOT dispose the client on a successful replan', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT), dispose };

    await replanWithVias(plan, [], { client, save: vi.fn().mockResolvedValue(undefined) });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('survives a client with no dispose() at all (the bare test-fake shape)', async () => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockRejectedValue(new RoutingError('timeout', 'routing timed out')),
    };

    await expect(replanWithVias(plan, [], { client })).rejects.toMatchObject({
      messageKey: 'error.routingTimeout',
    });
  });

  // #432: routing SUCCEEDED and only the write failed, so the generic
  // "route planning failed unexpectedly" copy was misleading about both what
  // broke and what to do. No dispose either — the worker is healthy.
  it('maps a rejected save() to ReplanError(error.planSaveFailed), and leaves the client alone', async () => {
    const plan = makePlan();
    const dispose = vi.fn();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT), dispose };
    const save = vi.fn().mockRejectedValue(new Error('idb full'));

    await expect(replanWithVias(plan, [], { client, save })).rejects.toMatchObject({
      messageKey: 'error.planSaveFailed',
    });
    expect(dispose).not.toHaveBeenCalled();
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
    const { result } = renderHook(() => useViaReplan(() => Promise.resolve(null)));
    expect(result.current.state).toEqual({ replanning: false, error: null, droppedCount: 0 });
  });

  it('a failed ensureClient (asset load or worker init failure) surfaces error.replanInit — not a silent no-op', async () => {
    const ensureClient = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useViaReplan(ensureClient));

    let outcome: Plan | null = null;
    await act(async () => {
      outcome = await result.current.replace(makePlan(), []);
    });

    expect(outcome).toBeNull();
    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({
      replanning: false,
      error: 'error.replanInit',
      droppedCount: 0,
    });
  });

  it('a successful replace() transitions replanning true then false, and returns the updated plan', async () => {
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
      useViaReplan(() => Promise.resolve(client), { save: vi.fn().mockResolvedValue(undefined) }),
    );

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

  it('a second replace() call while one is in flight is a guarded no-op (same pattern as usePlanFlow.run) — the guard is set before ensureClient is even awaited', async () => {
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
      useViaReplan(ensureClient, { save: vi.fn().mockResolvedValue(undefined) }),
    );

    let first!: Promise<Plan | null>;
    let second!: Promise<Plan | null>;
    act(() => {
      first = result.current.replace(plan, [{ lat: 54.9, lon: 10.1 }]);
      second = result.current.replace(plan, [{ lat: 54.91, lon: 10.11 }]);
    });

    // The second call never even reaches ensureClient, let alone client.plan.
    expect(ensureClient).toHaveBeenCalledTimes(1);

    // ensureClient() is now async, so client.plan() isn't called in the same
    // synchronous tick as replace() — flush the one microtask hop for
    // ensureClient's own promise to resolve before asserting on client.plan.
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

  it('surfaces the ReplanError messageKey on a failed replace(), and clearError resets it', async () => {
    const plan = makePlan();
    const client: ReplanClient = {
      plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'unreachable' }),
    };
    const { result } = renderHook(() => useViaReplan(() => Promise.resolve(client)));

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
    const { result: okResult } = renderHook(() =>
      useViaReplan(() => Promise.resolve(okClient), { save: vi.fn().mockResolvedValue(undefined) }),
    );
    await act(async () => {
      await okResult.current.replace(plan, [tooClose]);
    });
    expect(okResult.current.state.droppedCount).toBe(1);

    const failClient: ReplanClient = {
      plan: vi.fn().mockResolvedValue({ status: 'error', reason: 'unreachable' }),
    };
    const { result: failResult } = renderHook(() =>
      useViaReplan(() => Promise.resolve(failClient)),
    );
    await act(async () => {
      await failResult.current.replace(plan, [tooClose]);
    });
    expect(failResult.current.state.droppedCount).toBe(1);
  });

  it('a replace() after a prior one settled is not blocked by the guard (guard is per-call, not permanent)', async () => {
    const plan = makePlan();
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const { result } = renderHook(() =>
      useViaReplan(() => Promise.resolve(client), { save: vi.fn().mockResolvedValue(undefined) }),
    );

    await act(async () => {
      await result.current.replace(plan, []);
    });
    await act(async () => {
      await result.current.replace(plan, []);
    });

    expect(client.plan).toHaveBeenCalledTimes(2);
  });

  it('returns a stable {state, replace, clearError, clearDroppedNotice} object identity across renders that do not change state', () => {
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK_RESULT) };
    const ensureClient = () => Promise.resolve(client);
    const { result, rerender } = renderHook(() => useViaReplan(ensureClient));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

// #571: viaReplanDisabledReasonKey is the mapping App.tsx's planDisabledReason
// consumes to disclose WHY the planner is locked during a via-replan. Pinned
// directly against ViaReplanState values here — no App render needed — so a
// regression in the mapping itself (not just its wiring) fails a fast,
// focused test.
describe('viaReplanDisabledReasonKey (#571)', () => {
  it('returns the disclosure key while a via-replan is in flight', () => {
    expect(viaReplanDisabledReasonKey({ replanning: true, error: null, droppedCount: 0 })).toBe(
      'planner.disabled.viaReplanning',
    );
  });

  it('returns null when idle, regardless of error/droppedCount', () => {
    expect(
      viaReplanDisabledReasonKey({ replanning: false, error: null, droppedCount: 0 }),
    ).toBeNull();
    // Not vacuous to the `replanning` field alone: error/droppedCount being
    // non-default does not itself flip the disclosure — only `replanning`
    // does, matching App.tsx's own null-means-enabled contract for
    // planDisabledReason.
    expect(
      viaReplanDisabledReasonKey({
        replanning: false,
        error: 'error.replanInit',
        droppedCount: 2,
      }),
    ).toBeNull();
  });
});
