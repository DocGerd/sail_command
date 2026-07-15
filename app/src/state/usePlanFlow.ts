import { useCallback, useMemo, useRef, useState } from 'react';
import { fetchWindGrid, OpenMeteoError } from '../services/openMeteo';
import { savePlan } from '../services/db';
import { loadRoutingAssets } from '../services/assets';
import { RoutingClient } from '../routing/workerClient';
import { useActivePlan } from './AppState';
import type { MsgKey } from '../i18n/dict.de';
import type { NoRouteReason, Plan, PlanRequest, PlanResult, Rig, Settings, WindGrid } from '../types';

export type PlanningState =
  | { phase: 'idle' }
  | { phase: 'fetching-wind' }
  | { phase: 'routing'; rig: Rig; simulatedToMs: number }
  | { phase: 'error'; messageKey: MsgKey };

export interface PlanFlowDeps {
  fetchWind?: typeof fetchWindGrid;
  makeClient?: () => RoutingClient;
  save?: typeof savePlan;
}

const NO_ROUTE_MESSAGE_KEY: Record<NoRouteReason, MsgKey> = {
  unreachable: 'error.noRoute.unreachable',
  'beyond-horizon': 'error.noRoute.beyondHorizon',
  'calm-motor-off': 'error.noRoute.calmMotorOff',
  'snap-failed-origin': 'error.noRoute.snapOrigin',
  'snap-failed-destination': 'error.noRoute.snapDestination',
  // Not called out by name in the E3 brief's mapping list (which only
  // enumerates unreachable/beyondHorizon/calmMotorOff/snapOrigin/
  // snapDestination), but NoRouteReason has six members and vias are a
  // first-class waypoint kind (viaPoints.ts) — completing the Record here
  // rather than leaving this reason to fall through to error.internal.
  'snap-failed-via': 'error.noRoute.snapVia',
};

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
  return 'error.internal';
}

export function usePlanFlow(deps: PlanFlowDeps = {}): {
  planning: PlanningState;
  run: (req: Omit<PlanRequest, 'settings'> & { settings: Settings }, name: string) => Promise<void>;
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
  const maxSimulatedToMsRef = useRef(-Infinity);

  const fetchWind = deps.fetchWind ?? fetchWindGrid;
  // Wrapped in useMemo: the `?? (() => ...)` fallback would otherwise
  // allocate a new closure identity every render, which would in turn
  // invalidate run's useCallback below on every render.
  const makeClient = useMemo(() => deps.makeClient ?? (() => new RoutingClient()), [deps.makeClient]);
  const save = deps.save ?? savePlan;

  const run = useCallback(
    async (req: Omit<PlanRequest, 'settings'> & { settings: Settings }, name: string): Promise<void> => {
      // Belt, not the primary guard: the UI's canPlan already disables the
      // plan button while a run is in flight. Per-plan cancellation
      // (dispose + recreate the client mid-run) is deliberately deferred to
      // E8's replan work; RoutingClient's dispose-race guard (Phase B)
      // makes that safe to add later without touching this hook.
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'error') return;

      // Planning is the only network feature (repo rule) — checked before
      // anything else so a fetch is never attempted while offline.
      if (!navigator.onLine) {
        transition({ phase: 'error', messageKey: 'error.offline' });
        return;
      }

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

      try {
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
      } catch {
        // A failed init leaves a permanently-rejected readyRef promise —
        // clear the singleton so the next run() builds a fresh client
        // instead of re-awaiting the same broken one forever.
        clientRef.current = null;
        readyRef.current = null;
        transition({ phase: 'error', messageKey: 'error.internal' });
        return;
      }

      maxSimulatedToMsRef.current = -Infinity;
      let result: PlanResult;
      try {
        result = await clientRef.current.plan(req, windGrid, (rig, tMs) => {
          // The solver's progress can regress by up to one step at
          // via-segment joints (ledgered) — clamp so the UI never shows
          // simulated time going backwards within a run.
          const simulatedToMs = Math.max(maxSimulatedToMsRef.current, tMs);
          maxSimulatedToMsRef.current = simulatedToMs;
          transition({ phase: 'routing', rig, simulatedToMs });
        });
      } catch {
        // Worker fatal (rejected promise) — a resolved PlanResult with
        // status 'error' is handled separately below.
        transition({ phase: 'error', messageKey: 'error.internal' });
        return;
      }

      if (result.status === 'error') {
        transition({ phase: 'error', messageKey: NO_ROUTE_MESSAGE_KEY[result.reason] });
        return;
      }

      const plan: Plan = {
        id: crypto.randomUUID(),
        name,
        createdAtMs: Date.now(),
        request: req,
        windGrid,
        result,
      };
      try {
        await save(plan);
      } catch {
        transition({ phase: 'error', messageKey: 'error.internal' });
        return;
      }
      setPlan(plan);
      transition({ phase: 'idle' });
    },
    [fetchWind, makeClient, save, setPlan, transition],
  );

  return { planning, run };
}
