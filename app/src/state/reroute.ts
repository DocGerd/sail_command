import { useCallback, useMemo, useRef, useState } from 'react';
import { savePlan } from '../services/db';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { ReplanError, type ReplanClient, type ReplanDeps } from './replan';
import type { MsgKey } from '../i18n/dict.de';
import type { LatLon, Plan, PlanRequest, PlanResult, WindGrid } from '../types';

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
 * recalculation and stays online-only there). This is the stored-grid
 * sibling of replanWithVias (state/replan.ts), with a new ORIGIN instead of
 * new vias; like a via-replan it stays fully offline-capable.
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
  deps: ReplanDeps,
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
  // share mutable references with the original plan's request.
  const request: PlanRequest = {
    origin: { ...fixPoint },
    destination: { ...plan.request.destination },
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: plan.request.destinationHarborId,
    departureMs: nowMs,
    settings: { ...plan.request.settings },
  };

  let result: PlanResult;
  try {
    // The stored grid goes to the worker by structured clone (workerClient
    // posts it with no transfer list) — the original plan's forecast
    // survives intact regardless of what the worker does.
    result = await deps.client.plan(request, plan.windGrid);
  } catch {
    throw new ReplanError('error.internal', 'routing worker rejected the reroute request');
  }

  if (result.status === 'error') {
    // A GPS fix outside the mask region (or on land/too-shallow water) comes
    // back as snap-failed-origin — surfaced with reroute-specific copy: the
    // generic snapOrigin text ("pick a point…") addresses a planner pick,
    // not a position the boat actually is at.
    throw new ReplanError(
      result.reason === 'snap-failed-origin'
        ? 'error.rerouteFixOutside'
        : NO_ROUTE_MESSAGE_KEY[result.reason],
      `no route: ${result.reason}`,
    );
  }

  const rerouted: Plan = {
    id: crypto.randomUUID(),
    name,
    createdAtMs: nowMs,
    request,
    windGrid: cloneWindGrid(plan.windGrid),
    result,
  };
  const save = deps.save ?? savePlan;
  try {
    await save(rerouted);
  } catch {
    throw new ReplanError('error.internal', 'failed to persist the rerouted plan');
  }
  return rerouted;
}

export interface LiveRerouteState {
  rerouting: boolean;
  error: MsgKey | null;
}

const IDLE_STATE: LiveRerouteState = { rerouting: false, error: null };

/**
 * Stateful wrapper around rerouteFromFix for LiveView/App to share, mirroring
 * useViaReplan (state/replan.ts): tracks `rerouting`/`error` and guards
 * against overlapping calls with a synchronous ref (a reroute() made while
 * one is already in flight is a no-op — GUARD, not cancel).
 *
 * Takes usePlanFlow's `ensureClient` (lazily creates/inits the singleton
 * RoutingClient on demand), not a client value — ensureClient only loads
 * routing assets and inits the worker, never fetches a forecast, which is
 * what keeps this action available offline (the navigator.onLine gate lives
 * solely in usePlanFlow.run(), the one path that fetches).
 *
 * `deps.now` is injectable for tests only; production uses Date.now() —
 * departure of the reroute is the moment the skipper pressed the button.
 */
export function useLiveReroute(
  ensureClient: () => Promise<ReplanClient | null>,
  deps: { save?: typeof savePlan; now?: () => number } = {},
): {
  state: LiveRerouteState;
  reroute: (plan: Plan, fixPoint: LatLon, name: string) => Promise<Plan | null>;
  clearError: () => void;
} {
  const [state, setState] = useState<LiveRerouteState>(IDLE_STATE);
  const busyRef = useRef(false);

  const reroute = useCallback(
    async (plan: Plan, fixPoint: LatLon, name: string): Promise<Plan | null> => {
      // Set synchronously, before the first await, so a second synchronous
      // call (same tick) observes busyRef.current === true and bails out
      // immediately rather than racing ensureClient/client.plan.
      if (busyRef.current) return null;
      busyRef.current = true;
      setState({ rerouting: true, error: null });

      try {
        const client = await ensureClient();
        if (!client) {
          // Not silent: a failed ensure (asset load or worker init) is a
          // real failure — the UI must show something.
          setState({ rerouting: false, error: 'error.replanInit' });
          return null;
        }

        const nowMs = (deps.now ?? Date.now)();
        // exactOptionalPropertyTypes: ReplanDeps.save is optional-if-present
        // — an absent deps.save must omit the key entirely (mirrors
        // useViaReplan).
        const rerouted = await rerouteFromFix(
          plan,
          fixPoint,
          nowMs,
          name,
          deps.save ? { client, save: deps.save } : { client },
        );
        setState({ rerouting: false, error: null });
        return rerouted;
      } catch (err) {
        const messageKey = err instanceof ReplanError ? err.messageKey : 'error.internal';
        setState({ rerouting: false, error: messageKey });
        return null;
      } finally {
        busyRef.current = false;
      }
    },
    [ensureClient, deps.save, deps.now],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  // Stable object identity across renders that don't change state/reroute
  // themselves (mirrors useViaReplan's memoized return — App.tsx's
  // handleLiveReroute closes over this value in its own useCallback deps).
  return useMemo(() => ({ state, reroute, clearError }), [state, reroute, clearError]);
}
