import { useCallback, useMemo, useRef, useState } from 'react';
import { fetchWindGrid, OpenMeteoError } from '../services/openMeteo';
import { savePlan } from '../services/db';
import { loadRoutingAssets } from '../services/assets';
import { RoutingClient } from '../routing/workerClient';
import { useActivePlan } from './AppState';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { dedupeViaPoints, ROUTING_FAILURE_MESSAGE_KEY, routingFailureKey } from './replan';
import type { MsgKey } from '../i18n/dict.de';
import type { Plan, PlanRequest, PlanResult, Rig, Settings, WindGrid } from '../types';

export type PlanningState =
  | { phase: 'idle' }
  | { phase: 'fetching-wind' }
  // #340: `rig` is the only progress signal — the router runs genoa then
  // fock SEQUENTIALLY (routing/planRoute.ts's `runBoth` evaluates
  // `run('genoa', …)` then `run('fock', …)` as plain object-literal
  // properties, both synchronous, no interleaving), so "which rig is
  // currently solving" is an honest, bounded phase indicator — unlike the
  // removed simulatedToMs/FORECAST_HORIZON_MS percentage, which capped
  // around 5% and reset to 0 at this exact rig switch (#340).
  | { phase: 'routing'; rig: Rig }
  // #53: the worker is probing relaxed depth gates (mask connectivity BFS)
  // after an unreachable solve at the requested safety depth. Reported so the
  // UI shows the probe phase instead of a stalled routing bar; the relaxed
  // re-solve transitions back to 'routing'.
  | { phase: 'probing-depth' }
  | { phase: 'error'; messageKey: MsgKey };

export interface PlanFlowDeps {
  fetchWind?: typeof fetchWindGrid;
  makeClient?: () => RoutingClient;
  save?: typeof savePlan;
}

// #432: ROUTING_FAILURE_MESSAGE_KEY (and its `routingFailureKey` accessor)
// moved to state/replan.ts — all three paths that can observe a RoutingError
// share it now, not just this one. Its full rationale, including why
// 'worker-fatal' deliberately bundles two causes, lives with the table.

function mapWindError(err: unknown): MsgKey {
  if (err instanceof OpenMeteoError) {
    switch (err.kind) {
      case 'offline':
        return 'error.offline';
      case 'rate-limited':
        return 'error.rateLimited';
      case 'http':
      case 'malformed':
        return 'error.windService';
    }
  }
  return ROUTING_FAILURE_MESSAGE_KEY['wind-unclassified'];
}

// #114: options for run(). `replacePlanId` is the explicit-confirm
// "recalculate and replace" path: the completed run is persisted under that
// EXISTING plan id (overwriting the saved plan atomically at save time — a
// failed run never touches it). Every other caller omits it and gets a fresh
// UUID, which keeps the default "recalculate as new plan" and ordinary
// planner runs non-destructive.
export interface RunOptions {
  replacePlanId?: string;
}

export function usePlanFlow(deps: PlanFlowDeps = {}): {
  planning: PlanningState;
  run: (
    req: Omit<PlanRequest, 'settings'> & { settings: Settings },
    name: string,
    opts?: RunOptions,
  ) => Promise<void>;
  // Lazily creates/inits the singleton RoutingClient (loading routing assets
  // first, if this is the first call), or returns the already-init'd one.
  // Shared by run() and by replanWithVias (state/replan.ts's useViaReplan)
  // so a via re-route through a plan that was *loaded* (PlansList), not
  // just planned in this session, can still init a client on demand instead
  // of requiring a prior run() in the same session — replans only ever need
  // the plan's already-stored windGrid, so this never touches the network
  // itself and stays available offline (the navigator.onLine gate lives
  // only in run(), which is the one path that fetches a fresh forecast).
  // Resolves null on a failed load/init (mirrors run()'s own recovery: the
  // broken client is disposed and the singleton cleared so the next call
  // starts fresh); callers must treat a null result as a real failure, not
  // silently do nothing.
  ensureClient: () => Promise<RoutingClient | null>;
} {
  const { setPlan } = useActivePlan();
  const [planning, setPlanning] = useState<PlanningState>({ phase: 'idle' });

  // Mirrors `planning.phase` outside React state so the run() guard below
  // can read it synchronously — setPlanning() only commits on the next
  // render, but the guard must see a call's own 'fetching-wind' transition
  // immediately so a second synchronous call is rejected too.
  const phaseRef = useRef<PlanningState['phase']>('idle');
  const transition = useCallback((next: PlanningState) => {
    phaseRef.current = next.phase;
    setPlanning(next);
  }, []);

  // Singleton client + its init() promise, created lazily on the first
  // run() and reused for the hook's lifetime — init() transfers maskBuffer
  // to the worker, so it must only ever be called once per client.
  const clientRef = useRef<RoutingClient | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);

  const fetchWind = deps.fetchWind ?? fetchWindGrid;
  // Wrapped in useMemo: the `?? (() => ...)` fallback would otherwise
  // allocate a new closure identity every render, which would in turn
  // invalidate run's useCallback below on every render.
  const makeClient = useMemo(
    () => deps.makeClient ?? (() => new RoutingClient()),
    [deps.makeClient],
  );
  const save = deps.save ?? savePlan;

  // Shared by run() below and by the ensureClient this hook returns
  // (state/replan.ts's useViaReplan calls it directly, so a via-replan on a
  // *loaded* plan can init a client on demand without a prior run() in this
  // session). See the return type's own docstring for the offline-replan
  // rationale and the failure-recovery contract.
  const ensureClient = useCallback(async (): Promise<RoutingClient | null> => {
    try {
      // #432: the singleton may have been disposed by a caller that cannot
      // reach these refs — state/replan.ts's and state/reroute.ts's plan()
      // catches now tear the client down so a retry is not handed a worker
      // still grinding on an abandoned solve. Without this check that
      // teardown would be strictly HARMFUL: `clientRef.current` stays
      // truthy and `readyRef.current` stays resolved, so the next call would
      // return the dead client and every subsequent replan would fail with
      // 'disposed' -> error.routingInterrupted. The dispose and this check
      // are one fix in two halves, not two independent improvements.
      if (clientRef.current?.isDisposed) {
        clientRef.current = null;
        readyRef.current = null;
      }
      if (!clientRef.current) {
        const assets = await loadRoutingAssets();
        clientRef.current = makeClient();
        readyRef.current = clientRef.current.init({
          maskMeta: assets.maskMeta,
          // Transferred to the worker on postMessage — always pass a
          // copy and keep assets.ts's module-cached original intact.
          maskBuffer: assets.maskBuffer.slice(0),
          polarGenoa: assets.polarGenoa,
          polarFock: assets.polarFock,
        });
      }
      await readyRef.current;
      return clientRef.current;
    } catch {
      // A failed load/init leaves a permanently-rejected readyRef promise,
      // and (if init() was reached) the broken client is still holding its
      // Worker thread — dispose it (wrapped: dispose() on an already-dead
      // or never-inited client must not throw and derail recovery) before
      // clearing the singleton, so the next call builds a fresh client
      // instead of re-awaiting the same broken one, or leaking the old
      // Worker, forever.
      try {
        clientRef.current?.dispose();
      } catch {
        // Best-effort teardown of an already-broken client.
      }
      clientRef.current = null;
      readyRef.current = null;
      return null;
    }
  }, [makeClient]);

  const run = useCallback(
    async (
      req: Omit<PlanRequest, 'settings'> & { settings: Settings },
      name: string,
      opts: RunOptions = {},
    ): Promise<void> => {
      // Belt, not the primary guard: the UI's canPlan already disables the
      // plan button while a run is in flight. Per-plan cancellation
      // (dispose + recreate the client mid-run) is deliberately deferred —
      // RoutingClient's dispose-race guard (Phase B) makes that safe to add
      // later without touching this hook.
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'error') return;

      // Planning is the only network feature (repo rule) — checked before
      // anything else so a fetch is never attempted while offline. Replans
      // (state/replan.ts) are deliberately NOT gated this way: they reuse a
      // plan's already-stored windGrid and never touch the network, so they
      // must keep working offline.
      if (!navigator.onLine) {
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
      // always match what was actually routed. Silent drop, no banner — v1
      // scope; replans surface a droppedCount (useViaReplan) because there's
      // an existing plan/banner surface to attach it to, but run() has none
      // yet at this point.
      req = { ...req, viaPoints: dedupeViaPoints(req.origin, req.viaPoints, req.destination).kept };

      transition({ phase: 'fetching-wind' });

      // exactOptionalPropertyTypes: fetchWindGrid's `fixtureUrl?: string`
      // rejects an explicit `undefined`, so an absent query param must omit
      // the key entirely rather than pass `{ fixtureUrl: undefined }`.
      const fixtureUrl = new URLSearchParams(location.search).get('windFixture') ?? undefined;
      let windGrid: WindGrid;
      try {
        windGrid = await fetchWind(fixtureUrl ? { fixtureUrl } : {});
      } catch (err) {
        transition({ phase: 'error', messageKey: mapWindError(err) });
        return;
      }

      const client = await ensureClient();
      if (!client) {
        transition({ phase: 'error', messageKey: ROUTING_FAILURE_MESSAGE_KEY['worker-init'] });
        return;
      }

      let result: PlanResult;
      try {
        result = await client.plan(
          req,
          windGrid,
          // #340: only `rig` drives the UI now (phase indication, not a
          // percentage) — the worker's tMs/frontierSize are still throttled
          // upstream (workerClient.ts) but no longer consumed here.
          (rig) => {
            transition({ phase: 'routing', rig });
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
        try {
          client.dispose();
        } catch {
          // Best-effort teardown of an already-broken client.
        }
        clientRef.current = null;
        readyRef.current = null;
        // #433: client.plan() always rejects with a RoutingError (see
        // workerClient.ts) — classify by its typed `kind`, NEVER by matching
        // err.message (that would make a user-adjacent label a control
        // input; see workerClient.ts's own RoutingFailureKind comment on the
        // #282/#411 precedent this avoids repeating). #432 extracted the
        // classification into replan.ts's shared `routingFailureKey`, which
        // this path, replanWithVias() and rerouteFromFix() now all use — one
        // classification, three call sites, instead of one classification
        // and two bare `catch {}`s.
        transition({ phase: 'error', messageKey: routingFailureKey(err) });
        return;
      }

      if (result.status === 'error') {
        transition({ phase: 'error', messageKey: NO_ROUTE_MESSAGE_KEY[result.reason] });
        return;
      }

      const plan: Plan = {
        // #114: a replace-recalculation persists under the original plan's id
        // (see RunOptions) — everything else mints a fresh one.
        id: opts.replacePlanId ?? crypto.randomUUID(),
        name,
        createdAtMs: Date.now(),
        request: req,
        windGrid,
        result,
      };
      try {
        await save(plan);
      } catch {
        transition({ phase: 'error', messageKey: ROUTING_FAILURE_MESSAGE_KEY['persist-failed'] });
        return;
      }
      setPlan(plan);
      transition({ phase: 'idle' });
    },
    [ensureClient, fetchWind, save, setPlan, transition],
  );

  return { planning, run, ensureClient };
}
