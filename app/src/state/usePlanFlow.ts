import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWaveGrid, fetchWindGrid, OpenMeteoError } from '../services/openMeteo';
import { savePlan } from '../services/db';
import { pinRegionsAfterSave, type PinAfterSave } from '../services/pinAfterSave';
import { loadRoutingAssets } from '../services/assets';
import { planLog } from '../lib/planLog';
import { RoutingClient, RoutingError } from '../routing/workerClient';
import { useActivePlan } from './AppState';
import { mapWindError } from './windErrorKey';
import { noRouteMessageKey } from '../lib/plan';
import { windGridReaches } from '../lib/planForm';
import type { HarborWithReachability } from '../lib/harborReachability';
import {
  dedupeRequestVias,
  failureLeavesWorkerHealthy,
  ROUTING_FAILURE_MESSAGE_KEY,
  routingFailureKey,
  type ClientStartFailure,
  type MessageVars,
} from './replan';
import type { MsgKey } from '../i18n/dict.de';
import {
  PLAN_SCHEMA_VERSION,
  type Plan,
  type PlanRequest,
  type PlanResult,
  type SailId,
  type Settings,
  type WaveGrid,
  type WindGrid,
} from '../types';

export type PlanningState =
  | { phase: 'idle' }
  | { phase: 'fetching-wind' }
  // #1775: routing assets load and the worker boots, before the first solver
  // progress message. Distinct from 'fetching-wind' and from 'routing'.
  | { phase: 'starting' }
  // #340/#54: `sailId` is the only progress signal. With a pool size of 1 the
  // router solves req.sailIds SEQUENTIALLY (planRoute.ts's sync driver runs
  // one `solveRig()` per element in order), so `sailId` names the solving
  // sail; with a sibling worker the rigs solve CONCURRENTLY and `sailId`
  // follows whichever rig reported last, so it is not a stable phase
  // indicator. `index`/`total` are computed HERE (from the same `req.sailIds`
  // the solve order follows), not read from a module constant — §E.3 deleted
  // the old `RIG_ORDER` for exactly this reason. PlannerPanel.tsx's status
  // line names the phase only, never a rig or an index.
  // #1136: `secondPass` (present only when true) marks the salvage re-run.
  | { phase: 'routing'; sailId: SailId; index: number; total: number; secondPass?: true }
  // #53: the worker is probing relaxed depth gates (mask connectivity BFS)
  // after an unreachable solve at the requested safety depth. Reported so the
  // UI shows the probe phase instead of a stalled routing bar; the relaxed
  // re-solve transitions back to 'routing'.
  | { phase: 'probing-depth' }
  // #885: `messageVars` fills a key's placeholders (the merge refusal names its waypoints).
  | { phase: 'error'; messageKey: MsgKey; messageVars?: MessageVars };

function planningStatesEqual(a: PlanningState, b: PlanningState): boolean {
  switch (a.phase) {
    case 'idle':
    case 'fetching-wind':
    case 'starting':
    case 'probing-depth':
      return b.phase === a.phase;
    case 'routing':
      return (
        b.phase === 'routing' &&
        a.sailId === b.sailId &&
        a.index === b.index &&
        a.total === b.total &&
        a.secondPass === b.secondPass
      );
    case 'error': {
      if (b.phase !== 'error' || a.messageKey !== b.messageKey) return false;
      const av = a.messageVars;
      const bv = b.messageVars;
      if (av === bv) return true;
      if (av === undefined || bv === undefined) return false;
      const keys = Object.keys(av);
      return (
        keys.length === Object.keys(bv).length &&
        keys.every((k) => Object.hasOwn(bv, k) && av[k] === bv[k])
      );
    }
  }
}

export interface PlanFlowDeps {
  fetchWind?: typeof fetchWindGrid;
  fetchWave?: typeof fetchWaveGrid;
  makeClient?: () => RoutingClient;
  save?: typeof savePlan;
  /** #1164 T6: fire-and-forget region pinning after a successful save. */
  pinRegions?: PinAfterSave;
  /** #1867: a plan adopted after its save timed out (#1776); no other path calls it. */
  onLateAdopted?: (plan: Plan) => void;
}

// #432: ROUTING_FAILURE_MESSAGE_KEY (and its `routingFailureKey` accessor)
// moved to state/replan.ts — all three paths that can observe a RoutingError
// share it now, not just this one. Its full rationale, including why
// 'worker-fatal' deliberately bundles two causes, lives with the table.

// #114: options for run(). `replacePlanId` is the explicit-confirm
// "recalculate and replace" path: the completed run is persisted under that
// EXISTING plan id (overwriting the saved plan atomically at save time — a
// failed run never touches it). Every other caller omits it and gets a fresh
// UUID, which keeps the default "recalculate as new plan" and ordinary
// planner runs non-destructive.
export interface RunOptions {
  replacePlanId?: string;
  /** #1707: a fallback, never an override. Used offline, or when the forecast service is unreachable (network failure or persistent server error). */
  storedWindGrid?: WindGrid;
  /** #1699: used exactly when `storedWindGrid` is, so stored wind never pairs with fresh waves. */
  storedWaveGrid?: WaveGrid;
}

/** #1699: how long a solved plan waits for the marine fetch, which started before the solve. */
export const WAVE_GRACE_MS = 3_000;

/**
 * #1776: bound on routing start-up (asset load + worker init). The first,
 * uncached load includes the whole mask download, so a slow link can exceed it.
 */
export const STARTUP_TIMEOUT_MS = 180_000;

/** #1776: bound on persisting a solved plan; an IndexedDB open can block indefinitely. */
export const SAVE_TIMEOUT_MS = 30_000;

/** #1776: lets callers tell a timeout from a rejection by type, never by message. */
class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type StartupOutcome = { client: RoutingClient } | ClientStartFailure;

export function usePlanFlow(deps: PlanFlowDeps = {}): {
  planning: PlanningState;
  // #1775: wall-clock start of the in-flight run; null while idle or erroring.
  startedAtMs: number | null;
  run: (
    req: Omit<PlanRequest, 'settings'> & { settings: Settings },
    name: string,
    opts?: RunOptions,
  ) => Promise<void>;
  // Lazily creates/inits the singleton RoutingClient (loading routing assets
  // first, if this is the first call), or returns the already-init'd one.
  // Also exposed to state/replan.ts's useViaReplan — tested infrastructure
  // with no production caller since #571 (see replan.ts's own comment) —
  // also called, live, by state/reroute.ts's useLiveReroute (App.tsx wires
  // the same ensureClient into both).
  // Resolves null on a failed load/init, or one exceeding STARTUP_TIMEOUT_MS
  // (#1776): the broken client is disposed and the singleton cleared. The
  // asset load is NOT restarted — assets.ts resets its cache only on
  // rejection — so the next call joins a load still in flight. Callers must
  // treat a null result as a real failure, not silently do nothing.
  ensureClient: () => Promise<RoutingClient | null>;
  // The same start-up, saying WHY it failed, so a consumer can tell a
  // start-up timeout from a load/init failure (#1776; DepartureCompare).
  ensureClientOrFailure: () => Promise<RoutingClient | ClientStartFailure>;
  // #1193: stop whatever run() call is currently in flight. A no-op while
  // idle/erroring — see cancelRequestedRef's own comment for how a cancel
  // before the worker even exists (still fetching wind, or still loading
  // routing assets) is honoured too.
  cancel: () => void;
} {
  const { plan: activePlan, setPlan } = useActivePlan();
  // #1776: read by a late-landing save, which must not replace a plan the
  // user opened after the save timed out.
  const activePlanRef = useRef(activePlan);
  useEffect(() => {
    activePlanRef.current = activePlan;
  }, [activePlan]);
  // #1776: bumped by every run(); a late-landing save acts only while its own
  // run is still the latest.
  const runSeqRef = useRef(0);
  const [planning, setPlanning] = useState<PlanningState>({ phase: 'idle' });

  // Mirrors `planning.phase` outside React state so the run() guard below
  // can read it synchronously — setPlanning() only commits on the next
  // render, but the guard must see a call's own 'fetching-wind' transition
  // immediately so a second synchronous call is rejected too.
  const phaseRef = useRef<PlanningState['phase']>('idle');
  // Last state handed to setPlanning. Every state change goes through
  // transition(), so this cannot drift from what React last received. A new
  // object with equal content still re-renders the un-memoised shell, and
  // progress repeats the same state many times per solve.
  const lastPlanningRef = useRef<PlanningState>({ phase: 'idle' });
  // #1777: the stage last logged. Keyed on phase (plus pass 2 and an error's
  // message key), NOT on the state: with parallel rigs `sailId` flips on every
  // progress message.
  const lastLoggedStageRef = useRef('idle');
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const transition = useCallback((next: PlanningState) => {
    const wasBusy = phaseRef.current !== 'idle' && phaseRef.current !== 'error';
    const isBusy = next.phase !== 'idle' && next.phase !== 'error';
    phaseRef.current = next.phase;
    const stage =
      next.phase === 'routing' && next.secondPass
        ? 'routing-pass-2'
        : next.phase === 'error'
          ? `error:${next.messageKey}`
          : next.phase;
    if (stage !== lastLoggedStageRef.current) {
      lastLoggedStageRef.current = stage;
      planLog.info('plan stage', {
        stage,
        ...(next.phase === 'error' ? { messageKey: next.messageKey } : {}),
      });
    }
    if (isBusy && !wasBusy) setStartedAtMs(Date.now());
    else if (!isBusy && wasBusy) setStartedAtMs(null);

    if (planningStatesEqual(lastPlanningRef.current, next)) return;
    lastPlanningRef.current = next;
    setPlanning(next);
  }, []);

  // #1193: set by cancel(), read at every checkpoint in run() BEFORE the
  // worker exists or has anything pending — client.cancel() alone only
  // reaches an already-posted plan() (workerClient.ts's RoutingFailureKind
  // 'cancelled' comment: it is a no-op with nothing pending), so a click
  // during 'fetching-wind' or while ensureClient() is still loading assets
  // would otherwise be silently ignored and the run would proceed anyway.
  // Reset at the top of every run() so a cancel from a PRIOR, already-
  // finished run can never affect a fresh one.
  const cancelRequestedRef = useRef(false);
  // #1699: ends the post-solve wave wait at once, so a cancel never waits out the grace.
  const endWaveWaitRef = useRef<(() => void) | null>(null);

  // Singleton client, created lazily on the first run() and reused for the
  // hook's lifetime — init() transfers maskBuffer to the worker, so it must
  // only ever be called once per client. #1776: `startupRef` is the one
  // in-flight start-up every concurrent ensureClient() caller shares, so two
  // callers can never build two clients; `clientRef` is set only once it succeeds.
  const clientRef = useRef<RoutingClient | null>(null);
  const startupRef = useRef<Promise<RoutingClient> | null>(null);
  // #1776: resolved by cancel() to end run()'s wait on a start-up it does not own.
  const endStartupWaitRef = useRef<(() => void) | null>(null);

  const fetchWind = deps.fetchWind ?? fetchWindGrid;
  const fetchWave = deps.fetchWave ?? fetchWaveGrid;
  // Wrapped in useMemo: the `?? (() => ...)` fallback would otherwise
  // allocate a new closure identity every render, which would in turn
  // invalidate run's useCallback below on every render.
  const makeClient = useMemo(
    () => deps.makeClient ?? (() => new RoutingClient()),
    [deps.makeClient],
  );
  const save = deps.save ?? savePlan;
  const pinRegions = deps.pinRegions ?? pinRegionsAfterSave;
  const onLateAdoptedRef = useRef(deps.onLateAdopted);
  useEffect(() => {
    onLateAdoptedRef.current = deps.onLateAdopted;
  }, [deps.onLateAdopted]);

  // Shared by run() below and by the ensureClient this hook returns
  // (also called by state/replan.ts's useViaReplan, unused in production —
  // see that file's #571 comment) — also called, live, by state/reroute.ts's
  // useLiveReroute (App.tsx wires the same ensureClient into both). See the
  // return type's own docstring for the failure-recovery contract.
  const startClient = useCallback(async (): Promise<StartupOutcome> => {
    // #432: the singleton may have been disposed by a caller that cannot
    // reach these refs — state/replan.ts's and state/reroute.ts's plan()
    // catches now tear the client down so a retry is not handed a worker
    // still grinding on an abandoned solve. Without this check that
    // teardown would be strictly HARMFUL: the refs would still hand back the
    // dead client and every subsequent replan would fail with
    // 'disposed' -> error.routingInterrupted. The dispose and this check
    // are one fix in two halves, not two independent improvements.
    if (clientRef.current?.isDisposed) {
      clientRef.current = null;
      startupRef.current = null;
    }
    if (clientRef.current) return { client: clientRef.current };
    startupRef.current ??= (async () => {
      // A timed-out attempt is abandoned: its late continuation must not
      // spawn a worker nobody owns, and a client it already built is
      // disposed (which also rejects that client's pending init()).
      const attempt: { client: RoutingClient | null; abandoned: boolean } = {
        client: null,
        abandoned: false,
      };
      const startup = (async () => {
        const assets = await loadRoutingAssets();
        if (attempt.abandoned) throw new Error('start-up abandoned');
        attempt.client = makeClient();
        await attempt.client.init({
          maskMeta: assets.maskMeta,
          // Transferred to the worker on postMessage — always pass a
          // copy and keep assets.ts's module-cached original intact.
          maskBuffer: assets.maskBuffer.slice(0),
          // #54: cloned, never transferred — the whole catalogue's polars,
          // sent once so every later plan only names keys.
          polars: assets.polars,
          knownDisconnectedHarborIds: (assets.harbors as HarborWithReachability[])
            .filter((h) => h.knownDisconnected === true)
            .map((h) => h.id),
        });
        return attempt.client;
      })();
      try {
        return await withTimeout(startup, STARTUP_TIMEOUT_MS);
      } catch (err) {
        attempt.abandoned = true;
        // A failed init leaves the client holding its Worker thread —
        // dispose it (wrapped: dispose() on an already-dead client must not
        // throw and derail recovery) so it is not leaked.
        try {
          attempt.client?.dispose();
        } catch {
          // Best-effort teardown of an already-broken client.
        }
        throw err;
      }
    })();
    const startup = startupRef.current;
    try {
      const client = await startup;
      // A teardown elsewhere may have cleared the refs while this awaited.
      if (startupRef.current === startup) clientRef.current = client;
      return { client };
    } catch (err) {
      // Cleared so the next call builds a new client instead of re-awaiting
      // this failed attempt forever (the asset load itself may still be
      // shared, see the docstring). A timeout fails every caller sharing it.
      if (startupRef.current === startup) startupRef.current = null;
      return { failure: err instanceof TimeoutError ? 'startup-timeout' : 'worker-init' };
    }
  }, [makeClient]);

  const ensureClientOrFailure = useCallback(async (): Promise<
    RoutingClient | ClientStartFailure
  > => {
    const outcome = await startClient();
    return 'client' in outcome ? outcome.client : outcome;
  }, [startClient]);

  // The null form: its consumers (replan, reroute) map null to their own
  // start-up copy, which stays true after a timeout.
  const ensureClient = useCallback(async (): Promise<RoutingClient | null> => {
    const outcome = await startClient();
    return 'client' in outcome ? outcome.client : null;
  }, [startClient]);

  const run = useCallback(
    async (
      req: Omit<PlanRequest, 'settings'> & { settings: Settings },
      name: string,
      opts: RunOptions = {},
    ): Promise<void> => {
      // Belt, not the primary guard: the UI's canPlan already disables the
      // plan button while a run is in flight.
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'error') return;
      const seq = ++runSeqRef.current;
      // #1193: clear any cancel a PRIOR run left set — this is a fresh run
      // the user just started, not the one that was cancelled.
      cancelRequestedRef.current = false;

      // Planning is the only network feature (repo rule) — checked before
      // anything else so a fetch is never attempted while offline. Replans
      // (state/replan.ts) are deliberately NOT gated this way: they reuse a
      // plan's already-stored windGrid and never touch the network, so they
      // must keep working offline.
      const stored =
        opts.storedWindGrid && windGridReaches(opts.storedWindGrid, req.departureMs)
          ? opts.storedWindGrid
          : null;
      if (!navigator.onLine && stored === null) {
        transition({ phase: 'error', messageKey: 'error.offline' });
        return;
      }

      // Ledgered intake (mirrors state/replan.ts's replanWithVias): the same
      // ~60 m coincident-waypoint dedupe that guards every later via-replan
      // must also apply to a plan's *initial* via list, or a via this close
      // to origin/destination/a neighboring via reaches the segmented router
      // (routing/planRoute.ts) as a zero-duration leg on the very first run.
      // Both the request handed to the worker below and the Plan persisted
      // at the end use `req` (reassigned here) so a saved plan's viaPoints
      // always match what was actually routed. NOT a silent drop any more
      // (MAJOR 4, PR #586 review — this comment previously said otherwise
      // in both clauses): App.tsx's handlePlan, the only run() call site
      // reachable from the Plan-route button, computes this SAME dedupe as
      // a presentation-only pre-check and surfaces the dropped count via a
      // banner BEFORE calling run(), so a banner surface DOES exist by the
      // time this line runs. This call remains the actual, authoritative
      // enforcement — App.tsx's is a duplicate purely for disclosure (cheap,
      // O(vias)). The OTHER run() call site (PlansList recalc, App.tsx's
      // handleRecalculate) has no such pre-check, but is not a live hazard:
      // it re-submits a plan's own STORED request unchanged, whose via list
      // already passed this exact dedupe when the plan was first created —
      // droppedCount is 0 there by construction.
      // #885: segmentModes is rebuilt in the same step, or every deduped plan
      // with modes would fail planRoute's length check. A mode set planning
      // would refuse (merge conflict, motor-off conflict) is refused here, so
      // the refusal does not depend on a wind fetch.
      const deduped = dedupeRequestVias(req);
      if (deduped.kind === 'error') {
        transition({
          phase: 'error',
          messageKey: deduped.messageKey,
          ...(deduped.messageVars !== undefined ? { messageVars: deduped.messageVars } : {}),
        });
        return;
      }
      req = deduped.request;

      transition({ phase: 'fetching-wind' });

      // exactOptionalPropertyTypes: fetchWindGrid's `fixtureUrl?: string`
      // rejects an explicit `undefined`, so an absent query param must omit
      // the key entirely rather than pass `{ fixtureUrl: undefined }`.
      // One truthiness test for both params: an empty value means "no fixture".
      const query = new URLSearchParams(location.search);
      const fixtureUrl = query.get('windFixture') || undefined;
      const waveFixtureUrl = query.get('waveFixture') || undefined;
      let windGrid: WindGrid;
      let windFromStore = false;
      if (!navigator.onLine && stored !== null) {
        windGrid = stored;
        windFromStore = true;
      } else {
        try {
          windGrid = await fetchWind(fixtureUrl ? { fixtureUrl } : {});
        } catch (err) {
          // Only an unreachable forecast service (network failure or persistent server error) may fall back; a rate limit or bad payload must not plan on an old forecast.
          if (stored !== null && err instanceof OpenMeteoError && err.kind === 'offline') {
            windGrid = stored;
            windFromStore = true;
          } else {
            planLog.error(
              'wind fetch failed',
              { kind: err instanceof OpenMeteoError ? err.kind : 'unclassified' },
              err,
            );
            transition({ phase: 'error', messageKey: mapWindError(err) });
            return;
          }
        }
      }
      // #1193: nothing was posted to a worker yet (there may not even BE one)
      // — client.cancel() has nothing to reach here, so this checkpoint is
      // what makes a cancel during 'fetching-wind' actually stop the run.
      if (cancelRequestedRef.current) {
        transition({ phase: 'idle' });
        return;
      }

      // #1699: display only, so it never fails a plan and delays one by at
      // most WAVE_GRACE_MS. Started after wind so it cannot add to a wind 429,
      // still overlapping the solve. Any rejection, sync or async, becomes
      // null. Stored wind takes the stored waves; a wind fixture without a
      // wave fixture stays offline.
      const wavePromise: Promise<WaveGrid | null> = windFromStore
        ? Promise.resolve(opts.storedWaveGrid ?? null)
        : fixtureUrl !== undefined && waveFixtureUrl === undefined
          ? Promise.resolve(null)
          : (async () => fetchWave(waveFixtureUrl ? { fixtureUrl: waveFixtureUrl } : {}))().catch(
              () => null,
            );

      transition({ phase: 'starting' });

      // #1776: raced against cancel() so a cancel during start-up takes effect
      // at once. The start-up itself is shared with other consumers, so it is
      // left running, never disposed, and installs its client for later use.
      const outcome = await Promise.race([
        startClient(),
        new Promise<null>((resolve) => {
          endStartupWaitRef.current = () => resolve(null);
        }),
      ]).finally(() => {
        endStartupWaitRef.current = null;
      });
      // #1193: same reasoning as above — a cancel during a slow first-run
      // asset load (loadRoutingAssets + worker init) reaches nothing yet.
      if (cancelRequestedRef.current) {
        transition({ phase: 'idle' });
        return;
      }
      if (outcome === null || !('client' in outcome)) {
        planLog.error('routing start-up failed', {
          failure: outcome?.failure ?? 'worker-init',
        });
        transition({
          phase: 'error',
          messageKey: ROUTING_FAILURE_MESSAGE_KEY[outcome?.failure ?? 'worker-init'],
        });
        return;
      }
      const { client } = outcome;

      // #1775: start-up is over, so the status must stop saying so before the
      // first solver message. The routing line names the phase only, so
      // seeding the first rig is honest.
      const firstSail = req.sailIds[0];
      if (firstSail !== undefined) {
        transition({ phase: 'routing', sailId: firstSail, index: 1, total: req.sailIds.length });
      }

      let result: PlanResult;
      try {
        result = await client.plan(
          req,
          windGrid,
          // #340/#54: the UI shows a phase, not a percentage — the worker's
          // tMs/frontierSize are throttled upstream (workerClient.ts) but not
          // consumed here. `index`/`total` are derived from req.sailIds.
          //
          // #54 fix round 1: an unguarded `indexOf(sailId) + 1` degrades to
          // a fabricated index 0 if the worker ever reports progress
          // for a sailId not in req.sailIds — unreachable today (the worker
          // only ever solves the sails req.sailIds itself lists), but
          // silently WRONG, inconsistent with recommendedResult()'s
          // (types.ts) throw-don't-fabricate stance on the same class of
          // invariant. Throw instead.
          //
          // WHERE THAT THROW GOES — nothing catches it, unlike
          // recommendedResult()'s, which runs on a stack its caller owns.
          // This callback is invoked from workerClient's `worker.onmessage`,
          // so the error escapes as an uncaught error, and nothing in-app
          // observes it: no error boundary and no window.onerror; it surfaces
          // only as the browser's uncaught-error report.
          // MEASURED against the fakeWorker harness, BOTH halves, because
          // either alone misleads: it aborts THAT ONE progress delivery (the
          // phase readout does not advance and run() is still pending), and
          // the plan's own `result` message — delivered on the NEXT onmessage
          // call, as a real worker always sends — still settles the run to
          // idle and saves the plan exactly once. So this refuses to
          // fabricate an index WITHOUT failing the passage plan. It is not a
          // route to a distinct error phase and must not be described as one.
          // Pinned by usePlanFlow.test.tsx's '#54: an unknown sail in a
          // progress message' row.
          (sailId, _tMs, _frontierSize, secondPass) => {
            const index = req.sailIds.indexOf(sailId);
            if (index === -1) {
              throw new Error(
                `invariant violated: worker reported progress for sail '${sailId}', not present in request.sailIds`,
              );
            }
            transition({
              phase: 'routing',
              sailId,
              index: index + 1,
              total: req.sailIds.length,
              ...(secondPass ? { secondPass: true } : {}),
            });
          },
          undefined,
          () => {
            // #53 probe phase. The relaxed re-solve that may follow renders
            // as its own 'routing' state (naming whichever rig restarts
            // first) once it begins — never a regression of the doomed
            // first run's readout, since there is no number to regress.
            transition({ phase: 'probing-depth' });
          },
        );
      } catch (err) {
        // Worker fatal (rejected promise) — a resolved PlanResult with
        // status 'error' is handled separately below. Mirrors ensureClient's
        // own recovery: without this, a mid-plan crash would leave the
        // shared client silently poisoned (its ready promise already
        // resolved, but the Worker thread dead underneath it), so the
        // *next* run()/replan would be handed back the same broken client
        // instead of building a fresh one.
        // #553: gated, not unconditional. `'boat-not-in-catalogue'` is
        // raised client-side before anything is posted, so the worker is
        // healthy and tearing it down costs a full re-init for nothing. The
        // ref nulling is inside the same gate deliberately: nulling while the
        // worker is alive would strand it and have ensureClient build a
        // second one.
        if (!failureLeavesWorkerHealthy(err)) {
          try {
            client.dispose();
          } catch {
            // Best-effort teardown of an already-broken client.
          }
          clientRef.current = null;
          startupRef.current = null;
        }
        // #433: client.plan() always rejects with a RoutingError (see
        // workerClient.ts) — classify by its typed `kind`, NEVER by matching
        // err.message (that would make a user-adjacent label a control
        // input; see workerClient.ts's own RoutingFailureKind comment on the
        // #282/#411 precedent this avoids repeating). #432 extracted the
        // classification into replan.ts's shared `routingFailureKey`, which
        // this path, replanWithVias() and rerouteFromFix() now all use — one
        // classification, three call sites, instead of one classification
        // and two bare `catch {}`s.
        //
        // #1193: a cancel is not an error — it is the outcome the user
        // asked for, so it returns straight to idle instead of the generic
        // error banner. The teardown above still runs unconditionally
        // first: cancel() already terminated the worker, so this is a
        // harmless second call, and the ref-nulling is what makes the next
        // run() build a genuinely fresh worker rather than reusing a dead
        // one.
        if (err instanceof RoutingError && err.kind === 'cancelled') {
          transition({ phase: 'idle' });
          return;
        }
        transition({ phase: 'error', messageKey: routingFailureKey(err) });
        return;
      }

      if (result.status === 'error') {
        transition({ phase: 'error', messageKey: noRouteMessageKey(result.reason, req) });
        return;
      }

      // A timeout abandons the fetch; it may still fill the wave cache.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const waveGrid = await Promise.race([
        wavePromise,
        new Promise<null>((resolve) => {
          endWaveWaitRef.current = () => resolve(null);
          graceTimer = setTimeout(() => resolve(null), WAVE_GRACE_MS);
        }),
      ]).finally(() => {
        clearTimeout(graceTimer);
        endWaveWaitRef.current = null;
      });
      // #1193: the wave wait is a new window a cancel can land in.
      if (cancelRequestedRef.current) {
        transition({ phase: 'idle' });
        return;
      }

      const plan: Plan = {
        // #114: a replace-recalculation persists under the original plan's id
        // (see RunOptions) — everything else mints a fresh one.
        id: opts.replacePlanId ?? crypto.randomUUID(),
        name,
        createdAtMs: Date.now(),
        schemaVersion: PLAN_SCHEMA_VERSION,
        request: req,
        windGrid,
        ...(waveGrid !== null ? { waveGrid } : {}),
        result,
      };
      // An async wrapper, so a synchronous throw from save() is a rejection too.
      const saving = (async () => save(plan))();
      try {
        await withTimeout(saving, SAVE_TIMEOUT_MS);
      } catch (err) {
        if (!(err instanceof TimeoutError)) {
          planLog.error('saving the plan failed', { kind: 'persist-failed' }, err);
          transition({ phase: 'error', messageKey: ROUTING_FAILURE_MESSAGE_KEY['persist-failed'] });
          return;
        }
        planLog.warn('saving the plan timed out', { kind: 'persist-slow' });
        // #1776: the write may still land. Its banner offers no retry (a
        // re-plan would store a second copy); the outcome settles it below,
        // unless a newer run has started since.
        transition({ phase: 'error', messageKey: ROUTING_FAILURE_MESSAGE_KEY['persist-slow'] });
        const shownAtTimeout = activePlanRef.current;
        saving.then(
          () => {
            pinRegions(plan);
            if (runSeqRef.current !== seq) return;
            if (activePlanRef.current === shownAtTimeout) {
              onLateAdoptedRef.current?.(plan);
              setPlan(plan);
            }
            transition({ phase: 'idle' });
          },
          () => {
            if (runSeqRef.current !== seq) return;
            transition({
              phase: 'error',
              messageKey: ROUTING_FAILURE_MESSAGE_KEY['persist-failed'],
            });
          },
        );
        return;
      }
      // #1164 T6: never awaited — pinning cannot delay or fail the saved plan.
      pinRegions(plan);
      setPlan(plan);
      transition({ phase: 'idle' });
    },
    [startClient, fetchWave, fetchWind, pinRegions, save, setPlan, transition],
  );

  // #1193: a no-op while idle/erroring, matching run()'s own guard — set
  // the flag for the pre-worker checkpoints inside run() regardless of
  // whether a client exists yet, then let client.cancel() reach an
  // already-posted plan() if one exists (also a no-op otherwise, per its
  // own doc comment).
  const cancel = useCallback(() => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'error') return;
    cancelRequestedRef.current = true;
    clientRef.current?.cancel();
    endStartupWaitRef.current?.();
    endWaveWaitRef.current?.();
  }, []);

  return { planning, startedAtMs, run, ensureClient, ensureClientOrFailure, cancel };
}
