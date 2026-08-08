import { useCallback, useMemo, useRef, useState } from 'react';
import { savePlan } from '../services/db';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { haversineNm } from '../lib/geo';
import { RoutingError, type RoutingFailureKind } from '../routing/workerClient';
import type { MsgKey } from '../i18n/dict.de';
import type { LatLon, Plan, PlanRequest, PlanResult, WindGrid } from '../types';

// ~60 m in nautical miles (haversineNm's unit) — the coincident-waypoint
// dedupe guard every via-replan (and a plan's initial via list) enforces.
// The segmented router (routing/planRoute.ts) solves
// origin->via->...->destination as independent solve() segments; two
// consecutive request points that snap to the same (or an adjacent) mask
// cell produce a zero-duration leg, so any via this close to a neighboring
// waypoint is dropped rather than submitted.
const DEDUPE_THRESHOLD_NM = 60 / 1852;

export interface ViaDedupeResult {
  kept: LatLon[];
  droppedCount: number;
}

/**
 * Drops any via lying within ~60 m of an adjacent waypoint in the chain
 * (origin, prior *kept* via, next via, destination). A left-to-right scan
 * against the last *kept* waypoint naturally implements the "prior via"
 * half of that rule (a via too close to a just-kept via is dropped, so it
 * never becomes any later via's "previous"); a trailing pass against
 * destination implements the "next waypoint is the destination" half,
 * which only ever applies to the last surviving via. Exactly at the
 * threshold is kept (strict `<` only) — "~60 m" is a floor, not a ceiling.
 */
export function dedupeViaPoints(
  origin: LatLon,
  viaPoints: LatLon[],
  destination: LatLon,
): ViaDedupeResult {
  const kept: LatLon[] = [];
  let previous = origin;
  for (const via of viaPoints) {
    if (haversineNm(via, previous) < DEDUPE_THRESHOLD_NM) continue;
    kept.push(via);
    previous = via;
  }
  while (kept.length > 0 && haversineNm(kept[kept.length - 1], destination) < DEDUPE_THRESHOLD_NM) {
    kept.pop();
  }
  return { kept, droppedCount: viaPoints.length - kept.length };
}

// Mirrors OpenMeteoError (services/openMeteo.ts): a typed reason (here, the
// i18n key to show) alongside the Error's own message. NOT structured-clone-
// safe, same caveat as OpenMeteoError — never let this cross a postMessage/
// IndexedDB boundary.
export class ReplanError extends Error {
  readonly messageKey: MsgKey;

  constructor(messageKey: MsgKey, message: string) {
    super(message);
    this.name = 'ReplanError';
    this.messageKey = messageKey;
  }
}

/**
 * #433/#435 spike §12: the presentation-boundary classification for every
 * routing-side failure workerClient.ts's RoutingClient can throw
 * (RoutingFailureKind), plus the three causes that never reach
 * workerClient.ts at all — ensureClient() returning null (asset/worker init
 * failure), a post-SUCCESS savePlan() failure, and a fetchWind() rejection
 * that mapWindError can't otherwise classify. Each of these used to collapse
 * onto the single 'error.internal' key (#433); each now gets its own key so
 * the banner (App.tsx) and a future diagnostics record (#435, not built
 * here) can tell them apart. The remedy per key genuinely differs — see
 * App.tsx's RETRY_MAY_HELP_KEYS and CLAUDE.md's #433 bullet for the full
 * per-path reasoning: a retry hands the user a FRESH worker (every call site
 * disposes and clears the client before erroring out), which helps a crashed
 * worker or an undeserializable message, but cannot change the outcome of an
 * input-deterministic failure (the same solve hits the same limit or throw
 * again).
 *
 * #433 fix-wave (review Minor 1): 'worker-fatal' bundles TWO different
 * causes protocol.ts's catch(err) cannot tell apart — a deterministic
 * planRoute() throw (retry genuinely can't help, same inputs reproduce it)
 * and a resource-exhaustion throw (retry CAN help, since dispose() frees the
 * failed worker's whole heap before the retry builds a fresh one; CLAUDE.md's
 * #433 bullet). `err` at protocol.ts's catch is only ever `unknown`/`Error`
 * — no field distinguishes "ran out of memory" from "hit a logic bug", and
 * sniffing `err.constructor`/`instanceof RangeError` would be exactly as
 * unreliable as matching on `.message` (a RangeError can just as easily come
 * from an ordinary bounds bug), which is the discriminator-fabrication
 * workerClient.ts's own header comment warns against. So the two stay ONE
 * kind, and error.routingFailed's copy hedges rather than asserting retry is
 * futile.
 *
 * #432: this table LIVES HERE rather than in usePlanFlow.ts (where #433 put
 * it) because all three call paths that can observe a RoutingError now need
 * it — run(), replanWithVias() below, and reroute.ts's rerouteFromFix() —
 * and this module is already the shared base of that trio (it owns
 * ReplanError, ReplanClient and ReplanDeps, which the other two import).
 * usePlanFlow.ts imports dedupeViaPoints from here, so the dependency runs
 * one way only and putting it in usePlanFlow.ts instead would be an import
 * cycle. It is deliberately NOT in workerClient.ts: that would pull the i18n
 * MsgKey vocabulary into the routing layer, which is the direction #282
 * exists to prevent.
 */
export const ROUTING_FAILURE_MESSAGE_KEY: Record<
  RoutingFailureKind | 'worker-init' | 'persist-failed' | 'wind-unclassified',
  MsgKey
> = {
  timeout: 'error.routingTimeout',
  'worker-fatal': 'error.routingFailed',
  'worker-error': 'error.routingCrashed',
  messageerror: 'error.routingMessageError',
  disposed: 'error.routingInterrupted',
  'worker-init': 'error.workerInit',
  'persist-failed': 'error.planSaveFailed',
  'wind-unclassified': 'error.windUnknown',
};

/**
 * #432: the MsgKey for an error thrown out of `RoutingClient.plan()`.
 * Classified by the typed `kind`, NEVER by matching `err.message` — see
 * workerClient.ts's RoutingFailureKind comment on the #282/#411 precedent
 * that avoids. The plain-Error fallback mirrors usePlanFlow.run()'s: a throw
 * shape that isn't a RoutingError is genuinely unexpected and keeps the
 * generic key.
 */
export function routingFailureKey(err: unknown): MsgKey {
  return err instanceof RoutingError ? ROUTING_FAILURE_MESSAGE_KEY[err.kind] : 'error.internal';
}

/**
 * #432: tear down a routing client whose `plan()` just rejected, so a retry
 * is handed a FRESH worker instead of one that may still be running the
 * abandoned solve (the client-side deadline settles the promise but does not
 * terminate the thread) or may be dead underneath a resolved ready promise.
 *
 * Mirrors usePlanFlow.run()'s own recovery exactly, including being
 * UNCONDITIONAL on the failure kind rather than timeout-only: after any
 * rejection the client is either dead, wedged, or holding a worker whose
 * state we can no longer reason about, and disposing uniformly is both
 * simpler and the behaviour the primary plan path already ships. Optional on
 * ReplanClient so a test fake stays `{ plan: vi.fn() }`; wrapped because
 * dispose() on an already-dead client must not derail the error we are
 * actually reporting.
 *
 * Disposing is only half the job — usePlanFlow's ensureClient() holds this
 * client as a SINGLETON and would otherwise hand the disposed one back
 * forever. That is why RoutingClient exposes `isDisposed` and ensureClient()
 * rebuilds on it; the two halves are load-bearing together, and disposing
 * without that check would turn every subsequent replan into
 * 'error.routingInterrupted'.
 *
 * SHARED-SINGLETON CONSEQUENCE, spelled out so the next reader does not have
 * to re-derive it (PR #453 review, Minor 4): `RoutingClient.dispose()` calls
 * `failAll()`, which rejects EVERY pending entry, not just this caller's.
 * Three consumers share one client — useViaReplan, useLiveReroute and
 * usePlanFlow's run() — and their in-flight guards are independent
 * (`busyRef` in each of the first two, `planning` state in the third); no
 * guard spans them. So a reroute that fails at the client deadline can tear
 * down a client carrying an unrelated in-flight primary plan, which surfaces
 * to that operation as 'disposed' -> error.routingInterrupted.
 *
 * That is NOT new in kind — usePlanFlow.run()'s catch already disposed
 * unconditionally, so a failing primary plan could already abort an in-flight
 * replan — but #432 takes the reachable surface from one disposer to three,
 * and the justification above reasons only about THIS caller's worker, never
 * about a sibling operation sharing it. Accepted deliberately: the uniform
 * teardown is what makes a retry trustworthy, and the alternative (a shared
 * in-flight count across all three consumers) is a larger change than #432.
 */
export function disposeAfterFailure(client: ReplanClient): void {
  try {
    client.dispose?.();
  } catch {
    // Best-effort teardown of an already-broken client.
  }
}

// Minimal structural slice of RoutingClient (routing/workerClient.ts) —
// just the one method replanWithVias needs. A real RoutingClient satisfies
// this (its `plan` takes an extra optional onProgress param, which replans
// don't use), and tests can pass a bare `{ plan: vi.fn() }` fake without
// standing up a fakeWorker/postMessage harness.
export interface ReplanClient {
  plan(request: PlanRequest, windGrid: WindGrid): Promise<PlanResult>;
  // #432: optional so a bare `{ plan: vi.fn() }` fake still satisfies this,
  // per the note above. A real RoutingClient always has it.
  dispose?(): void;
}

export interface ReplanDeps {
  client: ReplanClient;
  save?: typeof savePlan;
}

/**
 * Re-routes `plan` through `viaPoints`, reusing the plan's *stored*
 * `windGrid` — never refetched (spec hard rule: a saved route always
 * renders against the forecast it was computed from). Returns an updated
 * Plan (same id, request.viaPoints/result replaced), persisted via
 * `savePlan`. Throws `ReplanError` instead of resolving on any failure
 * path (stale wind, no route, worker/persistence failure) so a caller
 * always gets a `MsgKey` to show, never a bare rejection.
 */
export async function replanWithVias(
  plan: Plan,
  viaPoints: LatLon[],
  deps: ReplanDeps,
): Promise<Plan> {
  const { timesMs } = plan.windGrid;
  const horizonMs = timesMs[timesMs.length - 1];
  // Simplest honest check (design resolution): only the plan's fixed
  // departureMs is validated against the stored grid's own coverage, not
  // the replanned route's eventual ETA. A detour that pushes the new ETA
  // past the grid's last hour is instead caught by the router itself and
  // surfaces as the ordinary 'beyond-horizon' NoRouteReason below, reusing
  // the same NO_ROUTE_MESSAGE_KEY mapping a fresh plan uses — a separate
  // duration-aware pre-check here would just duplicate that path.
  if (plan.request.departureMs > horizonMs) {
    throw new ReplanError(
      'error.replanStaleWind',
      `departureMs ${plan.request.departureMs} is beyond the stored wind grid's last hour ${horizonMs}`,
    );
  }

  // Ledgered intake (design resolution): the dedupe guard is enforced here,
  // at the point the request is actually submitted, regardless of whether
  // the caller already pre-filtered (dedupeViaPoints is exported separately
  // so a caller can also use it to decide whether to show the "waypoint
  // skipped" info banner — see state/replan.ts's useViaReplan).
  const { kept } = dedupeViaPoints(plan.request.origin, viaPoints, plan.request.destination);
  const request: PlanRequest = { ...plan.request, viaPoints: kept };

  let result: PlanResult;
  try {
    result = await deps.client.plan(request, plan.windGrid);
  } catch (err) {
    // #432: bind the error and preserve its discriminator. This used to be a
    // bare `catch {}` collapsing every routing failure — a spent wall-clock
    // budget, a crashed worker, an undeserializable reply — onto one
    // 'error.internal' banner, which is #433's defect reproduced on the
    // replan path. Classified by RoutingError.kind, never by err.message.
    disposeAfterFailure(deps.client);
    throw new ReplanError(
      routingFailureKey(err),
      `routing worker rejected the replan request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.status === 'error') {
    throw new ReplanError(NO_ROUTE_MESSAGE_KEY[result.reason], `no route: ${result.reason}`);
  }

  const updated: Plan = { ...plan, request, result };
  const save = deps.save ?? savePlan;
  try {
    await save(updated);
  } catch (err) {
    // #432: the 'persist-failed' cause, not 'error.internal'. Routing
    // SUCCEEDED here — only the write failed — so the generic "route
    // planning failed unexpectedly" copy was actively misleading about what
    // went wrong and what to do about it (error.planSaveFailed names storage).
    // No dispose: the worker is healthy and did its job.
    throw new ReplanError(
      ROUTING_FAILURE_MESSAGE_KEY['persist-failed'],
      `failed to persist the replanned plan: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return updated;
}

export interface ViaReplanState {
  replanning: boolean;
  error: MsgKey | null;
  // > 0 right after a replan silently dropped a too-close via (design
  // resolution: a silent drop rather than blocking the edit) — surfaced so
  // the UI can show a brief info banner ("Wegpunkt zu nah am Nachbarn —
  // übersprungen"). Reset to 0 at the start of every replace() call.
  droppedCount: number;
}

const IDLE_STATE: ViaReplanState = { replanning: false, error: null, droppedCount: 0 };

/**
 * Stateful wrapper around replanWithVias for ViaMarkers/PlannerPanel to
 * share: tracks `replanning`/`error`/`droppedCount` and guards against
 * overlapping calls. Mirrors usePlanFlow.run's in-flight guard (a synchronous
 * ref, not just React state, since state only commits on the next render) —
 * design resolution: a replace() made while one is already in flight is a
 * no-op (GUARD, not cancel/dispose — per-plan cancellation is deliberately
 * out of scope; see usePlanFlow.ts's own note on run()).
 *
 * Takes an `ensureClient` function (usePlanFlow.ts's own exposed
 * ensureClient, typically), not a client value — the client may not exist
 * yet (a plan loaded from PlansList without a prior run() in this session
 * has none), so replace() awaits it to lazily create/init one on demand.
 * This is also why a replan stays usable offline: ensureClient only loads
 * routing assets and inits the worker, never fetches a forecast — the
 * navigator.onLine gate lives solely in usePlanFlow.ts's run().
 */
export function useViaReplan(
  ensureClient: () => Promise<ReplanClient | null>,
  deps: { save?: typeof savePlan } = {},
): {
  state: ViaReplanState;
  replace: (plan: Plan, viaPoints: LatLon[]) => Promise<Plan | null>;
  clearError: () => void;
  clearDroppedNotice: () => void;
} {
  const [state, setState] = useState<ViaReplanState>(IDLE_STATE);
  const busyRef = useRef(false);

  const replace = useCallback(
    async (plan: Plan, viaPoints: LatLon[]): Promise<Plan | null> => {
      // Set synchronously, before the first await, so a second synchronous
      // replace() call (same tick) observes busyRef.current === true and
      // bails out immediately rather than racing ensureClient/client.plan.
      if (busyRef.current) return null;
      busyRef.current = true;
      setState({ replanning: true, error: null, droppedCount: 0 });

      // Computed independently of replanWithVias's own internal dedupe call
      // (which enforces the hard rule regardless) — purely to surface
      // droppedCount for the info banner, using the same pure helper.
      const { droppedCount } = dedupeViaPoints(
        plan.request.origin,
        viaPoints,
        plan.request.destination,
      );

      try {
        const client = await ensureClient();
        if (!client) {
          // Not silent: a failed ensure (asset load or worker init) is a
          // real failure, distinct from "no via was ever queued" — the UI
          // must show something, not just quietly leave the via unedited.
          setState({ replanning: false, error: 'error.replanInit', droppedCount });
          return null;
        }

        // exactOptionalPropertyTypes: ReplanDeps.save is optional-if-present,
        // not optional-or-undefined, so an absent deps.save must omit the key
        // entirely rather than pass `{ save: undefined }` (mirrors
        // workerClient.ts's onProgress handling).
        const updated = await replanWithVias(
          plan,
          viaPoints,
          deps.save ? { client, save: deps.save } : { client },
        );
        setState({ replanning: false, error: null, droppedCount });
        return updated;
      } catch (err) {
        const messageKey = err instanceof ReplanError ? err.messageKey : 'error.internal';
        setState({ replanning: false, error: messageKey, droppedCount });
        return null;
      } finally {
        busyRef.current = false;
      }
    },
    [ensureClient, deps.save],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);
  const clearDroppedNotice = useCallback(() => setState((s) => ({ ...s, droppedCount: 0 })), []);

  // Stable object identity across renders that don't change state/replace
  // themselves — App.tsx's handleViaDragEnd/handleViaPointsChange close over
  // this whole return value in their own useCallback deps, so an
  // unmemoized object here would silently defeat that memoization (a new
  // identity every render, even though nothing meaningful changed) and,
  // downstream, ViaMarkers' rebuild effect would see a "changed" onDragEnd
  // on every render too.
  return useMemo(
    () => ({ state, replace, clearError, clearDroppedNotice }),
    [state, replace, clearError, clearDroppedNotice],
  );
}
