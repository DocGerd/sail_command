import { useCallback, useMemo, useRef, useState } from 'react';
import { savePlan } from '../services/db';
import { DEFAULT_SAIL_IDS } from '../data/boats';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import {
  disposeAfterFailure,
  failureLeavesWorkerHealthy,
  routingFailureKey,
  ROUTING_FAILURE_MESSAGE_KEY,
  type ReplanClient,
} from './replan';
import type { MsgKey } from '../i18n/dict.de';
import { PLAN_SCHEMA_VERSION, type Plan, type PlanRequest, type PlanResult } from '../types';

// #937: departure comparison (c) — the real two-rig solve for a picked
// window. Design: docs/superpowers/specs/2026-09-04-departure-comparison-design.md
// §2.2/§4. §2.2's scan (useDepartureScan.ts) is genoa-only, MEASURED to rank
// windows correctly but silent on which rig is faster ON the chosen window —
// this hook closes that gap by re-solving the picked candidate with the
// PLAN's own `sailIds` (both rigs that plan was originally solved with, in
// solve order), never GENOA_SCAN_SAIL_IDS.
//
// Deliberately its own file rather than a usePlanFlow.ts addition: run()
// there always fetches a FRESH forecast (navigator.onLine-gated), which would
// violate the "a saved plan renders against the forecast it was computed
// from" rule for a candidate whose whole premise is the plan's *own already
// re-sliced* windGrid (see useDepartureScan.ts's DepartureScanRequest —
// exactly the grid already used to rank this window). Structurally this is
// closest to state/replan.ts's replanWithVias (same shared-client plumbing,
// same stored-grid rule, same typed-failure classification) with departureMs
// varied instead of viaPoints — but replanWithVias always keeps `plan.id`
// AND `plan.createdAtMs` fixed, which is wrong here: this hook mints a FRESH
// createdAtMs (mirrors usePlanFlow.ts's run()-with-replacePlanId "recalculate
// and replace" contract, #114) so `key={`${plan.id}-${plan.createdAtMs}`}`
// sites remount plan-scoped UI state even though the id is unchanged.

export interface DepartureConfirmState {
  confirming: boolean;
  // The departureMs of the candidate currently confirming, or the last one
  // attempted (success or failure) — lets a caller show a per-candidate
  // spinner/error without keeping a parallel copy of this in component
  // state. Never meaningful on its own without also checking `confirming`/
  // `error`.
  departureMs: number | null;
  error: MsgKey | null;
}

const IDLE_STATE: DepartureConfirmState = { confirming: false, departureMs: null, error: null };

export interface DepartureConfirmDeps {
  save?: typeof savePlan;
}

/**
 * Stateful wrapper, mirroring state/replan.ts's useViaReplan: takes
 * `ensureClient` (usePlanFlow.ts's own exposed function) rather than a
 * client value, so confirming a window works even when no plan() has run
 * this session (a plan loaded from PlansList), and stays usable offline —
 * this never touches the network, only the plan's already-stored windGrid.
 * Guards against an overlapping confirm() the same way (a synchronous ref,
 * since React state only commits on the next render).
 */
export function useDepartureConfirm(
  ensureClient: () => Promise<ReplanClient | null>,
  deps: DepartureConfirmDeps = {},
): {
  state: DepartureConfirmState;
  confirm: (plan: Plan, departureMs: number) => Promise<Plan | null>;
  clearError: () => void;
} {
  const [state, setState] = useState<DepartureConfirmState>(IDLE_STATE);
  const busyRef = useRef(false);

  const confirm = useCallback(
    async (plan: Plan, departureMs: number): Promise<Plan | null> => {
      // Set synchronously, before the first await, so a second synchronous
      // confirm() call (same tick — e.g. a double-click on a different
      // card) observes busyRef.current === true and bails immediately
      // rather than racing a second client.plan() call against the first
      // on the shared singleton (see disposeAfterFailure's own comment on
      // why a shared client makes an unguarded second in-flight call risky:
      // a failure in either would tear down BOTH).
      if (busyRef.current) return null;
      busyRef.current = true;
      setState({ confirming: true, departureMs, error: null });

      // The plan's OWN sailIds, unchanged — the rig(s) that plan's boat was
      // actually configured with in solve order, never
      // useDepartureScan.ts's genoa-only GENOA_SCAN_SAIL_IDS. Backfilled for
      // a plan saved before #54's sailIds field existed, same fallback
      // state/replan.ts's replanWithVias uses at the same site.
      const request: PlanRequest = {
        ...plan.request,
        departureMs,
        sailIds: plan.request.sailIds ?? DEFAULT_SAIL_IDS,
      };

      try {
        const client = await ensureClient();
        if (!client) {
          setState({
            confirming: false,
            departureMs,
            error: ROUTING_FAILURE_MESSAGE_KEY['worker-init'],
          });
          return null;
        }

        let result: PlanResult;
        try {
          // The plan's own STORED grid, never refetched — same rule
          // useDepartureScan.ts's scan and replanWithVias both follow. The
          // candidate already solved 'ok' genoa-only against this exact
          // grid at this exact departureMs, so a horizon check here would
          // be redundant: horizon coverage does not depend on which rig is
          // requested.
          result = await client.plan(request, plan.windGrid);
        } catch (err) {
          if (!failureLeavesWorkerHealthy(err)) disposeAfterFailure(client);
          setState({ confirming: false, departureMs, error: routingFailureKey(err) });
          return null;
        }

        if (result.status === 'error') {
          setState({ confirming: false, departureMs, error: NO_ROUTE_MESSAGE_KEY[result.reason] });
          return null;
        }

        const updated: Plan = {
          ...plan,
          // #114-style replace, not replanWithVias's id-and-createdAtMs-
          // unchanged shape — see this file's header comment.
          createdAtMs: Date.now(),
          schemaVersion: PLAN_SCHEMA_VERSION,
          request,
          result,
        };

        const save = deps.save ?? savePlan;
        try {
          await save(updated);
        } catch {
          setState({
            confirming: false,
            departureMs,
            error: ROUTING_FAILURE_MESSAGE_KEY['persist-failed'],
          });
          return null;
        }

        setState({ confirming: false, departureMs, error: null });
        return updated;
      } finally {
        busyRef.current = false;
      }
    },
    [ensureClient, deps.save],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  // Stable identity, same reasoning as useViaReplan's return (state/replan.ts)
  // — a DepartureCompare consumer could close over this in its own
  // useCallback deps.
  return useMemo(() => ({ state, confirm, clearError }), [state, confirm, clearError]);
}
