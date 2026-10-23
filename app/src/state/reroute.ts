import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { savePlan } from '../services/db';
import { noRouteMessageKey } from '../lib/plan';
import { cloneWaveGrid } from '../lib/waves';
import { pinRegionsAfterReroute, type PinAfterSave } from '../services/pinAfterSave';
import {
  disposeAfterFailure,
  failureLeavesWorkerHealthy,
  ReplanError,
  ROUTING_FAILURE_MESSAGE_KEY,
  routingFailureKey,
  type ReplanClient,
  type ReplanDeps,
} from './replan';
import type { MsgKey } from '../i18n/dict.de';
import { DEFAULT_SAIL_IDS } from '../data/boats';
import {
  boatSnapshot,
  defaultBoatSnapshot,
  DEFAULT_SETTINGS,
  PLAN_SCHEMA_VERSION,
  type LatLon,
  type Plan,
  type PlanRequest,
  type PlanResult,
  type SailId,
  type WindGrid,
} from '../types';

/**
 * #1806: the RoutingClient surface a reroute uses — ReplanClient plus the
 * progress/probe callbacks and cancel(). Structural, so a bare `{ plan }` fake
 * still satisfies it.
 */
export interface RerouteClient extends ReplanClient {
  plan(
    request: PlanRequest,
    windGrid: WindGrid,
    onProgress?: (sailId: SailId, tMs: number, frontierSize: number, secondPass: boolean) => void,
    timeoutMs?: number,
    onProbe?: (probeDepthM: number, done: number, total: number) => void,
  ): Promise<PlanResult>;
  cancel?(): void;
}

/** #1806: what the Live card shows while a reroute runs. */
export type ReroutePhase = 'starting' | 'routing' | 'routing-second-pass' | 'probing';

export interface RerouteDeps extends ReplanDeps {
  client: RerouteClient;
  onPhase?: (phase: ReroutePhase) => void;
  /** #1806: true once the skipper pressed Stop; a stopped reroute is saved but not pinned. */
  isCancelled?: () => boolean;
}

/**
 * Deep copy of a wind grid (arrays and typed arrays re-allocated). The
 * rerouted plan is a NEW saved plan, so it must not share mutable state with
 * the original plan's in-memory grid — mirrors lib/recalc.ts's "copied,
 * never aliased" rule for request fields. `.slice(0)` on the Float32Arrays
 * copies the underlying buffers; nothing here (or downstream) transfers them
 * (repo hard rule: wind-grid buffers are cloned to the worker, never
 * transferred).
 */
export function cloneWindGrid(grid: WindGrid): WindGrid {
  return {
    lats: [...grid.lats],
    lons: [...grid.lons],
    timesMs: [...grid.timesMs],
    speedKn: grid.speedKn.slice(0),
    dirFromDeg: grid.dirFromDeg.slice(0),
    gustKn: grid.gustKn.slice(0),
    fetchedAtMs: grid.fetchedAtMs,
    model: grid.model,
  };
}

/**
 * #115 manual "reroute from here" (Live view): routes the current GPS fix ->
 * the plan's destination, reusing the plan's *stored* wind grid — never
 * refetched (spec hard rule: a saved route always renders against the
 * forecast it was computed from; the fresh-forecast variant is #114's
 * recalculation and stays online-only there). Structurally the stored-grid
 * sibling of replanWithVias (state/replan.ts, tested but with no production
 * caller since #571) — this function IS the live path, and stays fully
 * offline-capable for the same reason replanWithVias would have.
 *
 * Design resolutions (issue #115, recorded in the PR):
 * - Departure is `nowMs` (the moment the skipper asks). If the stored grid's
 *   last hour no longer covers it, fail honestly with a dedicated i18n error
 *   (mirroring error.replanStaleWind) — never a truncated/extrapolated route.
 * - Via points are DROPPED: the question answered is "best route from HERE
 *   to the destination". Classifying which vias are still "ahead" of the
 *   boat would be projection-dependent guesswork, and keeping passed vias
 *   would force absurd backtracking. originHarborId is cleared too (the
 *   origin is a GPS fix, not a harbor); the destination keeps its harbor id.
 * - Both rigs are re-run as usual (standard dual-run, faster rig
 *   recommended) — no mid-passage rig lock.
 * - The result is persisted as a NEW plan (fresh id, caller-provided derived
 *   name): the original plan is preserved untouched, the reroute survives a
 *   reload mid-passage (#113 session restore picks it up), and it is
 *   visibly labeled via its name in PlansList/RouteSummary.
 *
 * This is deliberately a MANUAL, explicit user action producing a new routed
 * result — lib/live.ts's continuous projection math stays non-rerouting
 * (spec §2: "No live re-routing in v1"); no deviation-triggered automation
 * exists or is prepared for here.
 *
 * Throws ReplanError on every failure path so a caller always gets a MsgKey
 * to show, never a bare rejection.
 */
export async function rerouteFromFix(
  plan: Plan,
  fixPoint: LatLon,
  nowMs: number,
  name: string,
  deps: RerouteDeps,
): Promise<Plan> {
  const { timesMs } = plan.windGrid;
  const horizonMs = timesMs[timesMs.length - 1];
  // Same "simplest honest check" as replanWithVias: only the departure (now)
  // is validated against the stored grid's own coverage. A route whose ETA
  // would run past the grid's last hour is caught by the router itself and
  // surfaces as the ordinary 'beyond-horizon' NoRouteReason below.
  if (nowMs > horizonMs) {
    throw new ReplanError(
      'error.rerouteStaleWind',
      `now ${nowMs} is beyond the stored wind grid's last hour ${horizonMs}`,
    );
  }

  // Copied, never aliased (mirrors lib/recalc.ts): nothing downstream may
  // share mutable references with the original plan's request. Settings are
  // backfilled from DEFAULT_SETTINGS before the saved snapshot is spread on
  // top (#243 fix wave item 3, mirrors lib/recalc.ts and AppState.tsx's own
  // load-time backfill) — without it, rerouting a plan saved before a
  // Settings field existed would silently carry `undefined` forward into a
  // required field, and for depthComfortMarginM specifically would silently
  // disable the depth comfort preference on every reroute of a pre-#243 plan.
  const request: PlanRequest = {
    origin: { ...fixPoint },
    destination: { ...plan.request.destination },
    // #885 R6: segmentModes is dropped with the vias (disclosed in live.reroute.hint).
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: plan.request.destinationHarborId,
    departureMs: nowMs,
    settings: { ...DEFAULT_SETTINGS, ...plan.request.settings },
    // #54: reroute the SAME sails the plan being rerouted was originally
    // solved with, not a fresh default — mirrors every other field here
    // being copied from the original plan's own request. #54 fix round 1:
    // backfilled for the same reason as lib/recalc.ts's `settings` backfill
    // above — a plan saved before this field existed has it absent, and
    // planRoute.ts's `runAll` calls `req.sailIds.map(...)` unconditionally.
    // #54 review round 2: BOTH branches spread. The fallback used to alias
    // the module-level DEFAULT_SAIL_IDS, which contradicts this block's own
    // "copied, never aliased" contract and would hand the same one array to
    // every backfilled reroute. Pinned by reroute.test.ts's "copies sailIds,
    // never aliasing the saved plan's array" and "copies the backfill, never
    // aliasing the DEFAULT_SAIL_IDS module constant", one row per branch.
    sailIds: plan.request.sailIds ? [...plan.request.sailIds] : [...DEFAULT_SAIL_IDS],
    // #54 Task 11: same treatment, same two reasons — copied rather than
    // aliased per this block's contract, and backfilled for a plan that
    // reached here without passing through services/migratePlan.ts.
    boat: plan.request.boat ? boatSnapshot(plan.request.boat) : defaultBoatSnapshot(),
  };

  let result: PlanResult;
  try {
    // The stored grid goes to the worker by structured clone (workerClient
    // posts it with no transfer list) — the original plan's forecast
    // survives intact regardless of what the worker does.
    const onPhase = deps.onPhase;
    result = onPhase
      ? await deps.client.plan(
          request,
          plan.windGrid,
          (_sailId, _tMs, _frontierSize, secondPass) =>
            onPhase(secondPass ? 'routing-second-pass' : 'routing'),
          undefined,
          () => onPhase('probing'),
        )
      : await deps.client.plan(request, plan.windGrid);
  } catch (err) {
    // #432: mirrors replanWithVias's own plan() catch exactly — bind the
    // error, dispose the client so a retry gets a fresh worker rather than
    // one still grinding on the abandoned solve, and classify by
    // RoutingError.kind instead of collapsing onto 'error.internal'. This
    // path matters more than the replan one for a timeout: it is reached
    // from Live view, mid-passage.
    // #553: skip the teardown when the worker is provably healthy.
    if (!failureLeavesWorkerHealthy(err)) disposeAfterFailure(deps.client);
    throw new ReplanError(
      routingFailureKey(err),
      `routing worker rejected the reroute request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.status === 'error') {
    // A GPS fix outside the mask region (or on land/too-shallow water) comes
    // back as snap-failed-origin — surfaced with reroute-specific copy: the
    // generic snapOrigin text ("pick a point…") addresses a planner pick,
    // not a position the boat actually is at. #1806: beyond-horizon likewise
    // gets Live copy — departure (now) and destination are fixed here, so the
    // planner's "different departure time" remedy does not apply.
    throw new ReplanError(
      result.reason === 'snap-failed-origin'
        ? 'error.rerouteFixOutside'
        : result.reason === 'beyond-horizon'
          ? 'error.rerouteBeyondHorizon'
          : noRouteMessageKey(result.reason, request),
      `no route: ${result.reason}`,
    );
  }

  const rerouted: Plan = {
    id: crypto.randomUUID(),
    name,
    createdAtMs: nowMs,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request,
    windGrid: cloneWindGrid(plan.windGrid),
    ...(plan.waveGrid !== undefined ? { waveGrid: cloneWaveGrid(plan.waveGrid) } : {}),
    result,
  };
  const save = deps.save ?? savePlan;
  try {
    await save(rerouted);
  } catch (err) {
    // #432: 'persist-failed', not 'error.internal' — the reroute itself
    // SUCCEEDED and only the write failed, so the storage-specific copy is
    // the honest one. No dispose: the worker is healthy.
    throw new ReplanError(
      ROUTING_FAILURE_MESSAGE_KEY['persist-failed'],
      `failed to persist the rerouted plan: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // #1233: never awaited — pinning cannot delay or fail the reroute. A
  // mid-passage reroute is exactly the case most likely to move the
  // corridor into a region the original pin never fetched.
  if (deps.isCancelled?.()) return rerouted;
  const pinRegions = deps.pinRegions ?? pinRegionsAfterReroute;
  pinRegions(rerouted);
  return rerouted;
}

export interface LiveRerouteState {
  rerouting: boolean;
  // #1806: null while idle.
  phase: ReroutePhase | null;
  error: MsgKey | null;
  // #1806: true for REROUTE_SUCCESS_CUE_MS after a reroute became active.
  succeeded: boolean;
}

type BaseState = Omit<LiveRerouteState, 'phase'>;

const IDLE_STATE: BaseState = { rerouting: false, error: null, succeeded: false };

/** How long the Live card's "new route active" cue stays up. */
export const REROUTE_SUCCESS_CUE_MS = 8_000;

/**
 * Stateful wrapper around rerouteFromFix for LiveView/App to share, mirroring
 * useViaReplan (state/replan.ts): tracks `rerouting`/`error` and guards
 * against overlapping calls with a synchronous ref (a reroute() made while
 * one is already in flight is a no-op).
 *
 * Takes usePlanFlow's `ensureClient` (lazily creates/inits the singleton
 * RoutingClient on demand), not a client value — ensureClient only loads
 * routing assets and inits the worker, never fetches a forecast, which is
 * what keeps this action available offline (the navigator.onLine gate lives
 * solely in usePlanFlow.run(), the one path that fetches).
 *
 * #1806 cancel mirrors usePlanFlow's #1193 design: a flag checked after
 * ensureClient() (client.cancel() is a no-op with nothing pending) plus
 * client.cancel(), which terminates the worker. A cancel ends in idle with no
 * error. One landing during save() cannot unsave the plan: it stays in the
 * saved list, but is neither returned (so not activated), cued as a success, nor
 * pinned for offline regions.
 *
 * `deps.now` is injectable for tests only; production uses Date.now() —
 * departure of the reroute is the moment the skipper pressed the button.
 */
export function useLiveReroute(
  ensureClient: () => Promise<RerouteClient | null>,
  deps: { save?: typeof savePlan; now?: () => number; pinRegions?: PinAfterSave } = {},
): {
  state: LiveRerouteState;
  reroute: (plan: Plan, fixPoint: LatLon, name: string) => Promise<Plan | null>;
  cancel: () => void;
  clearError: () => void;
} {
  const [base, setBase] = useState<BaseState>(IDLE_STATE);
  // Separate primitive so repeated progress callbacks bail out unchanged.
  const [phase, setPhase] = useState<ReroutePhase | null>(null);
  const busyRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const clientRef = useRef<RerouteClient | null>(null);
  const cueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCueTimer = () => {
    if (cueTimerRef.current !== null) clearTimeout(cueTimerRef.current);
    cueTimerRef.current = null;
  };
  useEffect(() => clearCueTimer, []);

  const reroute = useCallback(
    async (plan: Plan, fixPoint: LatLon, name: string): Promise<Plan | null> => {
      // Set synchronously, before the first await, so a second synchronous
      // call (same tick) observes busyRef.current === true and bails out
      // immediately rather than racing ensureClient/client.plan.
      if (busyRef.current) return null;
      busyRef.current = true;
      cancelRequestedRef.current = false;
      clearCueTimer();
      setBase({ rerouting: true, error: null, succeeded: false });
      setPhase('starting');

      try {
        const client = await ensureClient();
        if (cancelRequestedRef.current) {
          setBase(IDLE_STATE);
          return null;
        }
        if (!client) {
          // Not silent: a failed ensure (asset load or worker init) is a
          // real failure — the UI must show something.
          setBase({ ...IDLE_STATE, error: 'error.replanInit' });
          return null;
        }
        clientRef.current = client;

        const nowMs = (deps.now ?? Date.now)();
        // exactOptionalPropertyTypes: ReplanDeps's optional fields are
        // optional-if-present — an absent deps.save/pinRegions must omit the
        // key entirely (mirrors useViaReplan).
        const rerouted = await rerouteFromFix(plan, fixPoint, nowMs, name, {
          client,
          onPhase: setPhase,
          isCancelled: () => cancelRequestedRef.current,
          ...(deps.save ? { save: deps.save } : {}),
          ...(deps.pinRegions ? { pinRegions: deps.pinRegions } : {}),
        });
        if (cancelRequestedRef.current) {
          setBase(IDLE_STATE);
          return null;
        }
        setBase({ rerouting: false, error: null, succeeded: true });
        cueTimerRef.current = setTimeout(() => {
          cueTimerRef.current = null;
          setBase((s) => ({ ...s, succeeded: false }));
        }, REROUTE_SUCCESS_CUE_MS);
        return rerouted;
      } catch (err) {
        if (cancelRequestedRef.current) {
          setBase(IDLE_STATE);
          return null;
        }
        const messageKey = err instanceof ReplanError ? err.messageKey : 'error.internal';
        setBase({ ...IDLE_STATE, error: messageKey });
        return null;
      } finally {
        busyRef.current = false;
        clientRef.current = null;
        setPhase(null);
      }
    },
    [ensureClient, deps.save, deps.now, deps.pinRegions],
  );

  // A no-op while idle, so a stray tap cannot poison the next reroute.
  const cancel = useCallback(() => {
    if (!busyRef.current) return;
    cancelRequestedRef.current = true;
    clientRef.current?.cancel?.();
  }, []);

  const clearError = useCallback(() => setBase((s) => ({ ...s, error: null })), []);

  const state = useMemo(() => ({ ...base, phase }), [base, phase]);

  // Stable object identity across renders that don't change state/reroute
  // themselves (mirrors useViaReplan's memoized return — App.tsx's
  // handleLiveReroute closes over this value in its own useCallback deps).
  return useMemo(
    () => ({ state, reroute, cancel, clearError }),
    [state, reroute, cancel, clearError],
  );
}
