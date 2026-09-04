import { useCallback, useRef, useState } from 'react';
import {
  disposeAfterFailure,
  failureLeavesWorkerHealthy,
  routingFailureKey,
  ROUTING_FAILURE_MESSAGE_KEY,
  type ReplanClient,
} from './replan';
import { GENOA_SAIL_ID } from '../data/boats';
import type { MsgKey } from '../i18n/dict.de';
import type { NoRouteReason, PlanRequest, PlanResultOk, SailId, WindGrid } from '../types';

// #356 part (a): departure-time comparison scan orchestration. Design:
// docs/superpowers/specs/2026-09-04-departure-comparison-design.md.
//
// §2.2 — SCAN THE GENOA, AND ONLY THE GENOA. THIS IS MEASURED, NOT A
// SHORTCUT. Measured 2026-09-04, real solver against the real committed
// mask/polars, a deliberately time-varying wind field: ranking departure
// windows by a genoa-only scan produced a BYTE-IDENTICAL ordering, at every
// position, to ranking by the true two-rig best (both routes tested, N=8).
// Fock-only was NOT equivalent — it matched the top pick but swapped
// adjacent positions lower down. Zero decided flips to fock cleared
// RIG_TIE_BAND_MS across 23 hour-probes. The aperture was narrow: two
// routes, synthetic wind, no via points, the Salona 45 polar pair only — see
// the spec's §2.2 for the full table. If this is ever changed to scan the
// fock sail, or "whichever rig the boat prefers", or generalised in any
// way, THAT MEASUREMENT MUST BE RE-RUN FIRST. Do not generalise this
// constant quietly. `GENOA_SAIL_ID` is imported from data/boats.ts (its own
// comment there explains why the id lives there rather than as a bare
// literal here) — this array wraps it as `readonly SailId[]` purely because
// that is the shape `PlanRequest.sailIds` and `client.plan()` expect; it
// selects nothing on its own.
const GENOA_SCAN_SAIL_IDS: readonly SailId[] = [GENOA_SAIL_ID];

export type DepartureCandidateOutcome =
  | { kind: 'ok'; result: PlanResultOk }
  | { kind: 'no-route'; reason: NoRouteReason }
  // client.plan() itself rejected (worker timeout/crash/disposed, or a
  // boat-not-in-catalogue guard) — distinct from a typed no-route finding,
  // which is a genuine per-window search result. Reuses routingFailureKey()
  // (state/replan.ts), the same classifier usePlanFlow.ts/replanWithVias use,
  // so this never infers a cause by matching err.message.
  | { kind: 'failed'; messageKey: MsgKey };

export interface DepartureCandidate {
  departureMs: number;
  outcome: DepartureCandidateOutcome;
}

export interface DepartureScanState {
  scanning: boolean;
  // 1-based index of the candidate currently solving (or last solved), 0
  // before the first one starts. `total` is the requested candidate count —
  // NOT necessarily `candidates.length`, which can be shorter after a
  // cancel or a worker-killing failure (see scan()'s own comment on both).
  index: number;
  total: number;
  candidates: DepartureCandidate[];
  // Set only when ensureClient() itself failed (asset load / worker init) —
  // a per-candidate failure lives in that candidate's own outcome, never
  // here, mirroring useViaReplan's ViaReplanState.error split.
  error: MsgKey | null;
  // True when the last scan stopped before reaching `total` candidates
  // because cancel() was called. A worker-killing failure (see scan()) also
  // stops the loop early but reports through `error`/the failed candidate's
  // own outcome instead, so this flag names ONLY the user-cancel path.
  cancelled: boolean;
}

const IDLE_STATE: DepartureScanState = {
  scanning: false,
  index: 0,
  total: 0,
  candidates: [],
  error: null,
  cancelled: false,
};

export interface DepartureScanRequest {
  // The active plan's own request, minus sailIds (overridden per candidate
  // below) — departureMs here is candidate 0's departure time; later
  // candidates step forward from it. Pass plan.request with `sailIds`
  // omitted, e.g. `{ ...plan.request, sailIds: undefined }` is NOT valid
  // (exactOptionalPropertyTypes) — callers should build this via object
  // destructuring instead (see DepartureCompare.tsx).
  base: Omit<PlanRequest, 'sailIds'>;
  // §2.3: the plan's own STORED wind grid, never refetched — one grid,
  // re-sliced at N offsets, matching the plan-level "wind grids are stored
  // with each plan" rule (CLAUDE.md Domain rules). A candidate whose ETA
  // outruns this grid's own coverage is an expected 'beyond-horizon'
  // no-route outcome, not a special case here.
  windGrid: WindGrid;
  stepHours: number; // caller-validated: 1 | 3 | 6 per the design spec §2.3
  count: number; // caller-validated: 4-8 per the design spec §2.3
}

/**
 * #356 part (a): explicit, cancellable genoa-only departure-time scan.
 * Takes `ensureClient` (usePlanFlow.ts's own exposed function, the same
 * pattern state/replan.ts's useViaReplan and state/reroute.ts's
 * useLiveReroute already use) rather than a client value, so a scan works
 * even when no plan() has run yet this session — it lazily
 * loads/inits the shared worker on demand and stays usable offline (the
 * scan reuses the plan's own stored wind grid; nothing here touches the
 * network).
 *
 * §4 residual — CANCEL SEMANTICS: a solve in flight cannot be interrupted
 * between rings today (no per-plan cancellation exists anywhere in this
 * codebase). cancel() therefore lets the CURRENT candidate's solve finish
 * and skips every remaining one — the honest option the design spec names
 * explicitly as acceptable. The cancellation check runs at the TOP of each
 * loop iteration, i.e. after the previous candidate's `await` has already
 * settled, never mid-solve.
 */
export function useDepartureScan(ensureClient: () => Promise<ReplanClient | null>): {
  state: DepartureScanState;
  scan: (req: DepartureScanRequest) => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<DepartureScanState>(IDLE_STATE);
  // Synchronous guard against an overlapping scan() call, mirroring
  // usePlanFlow.run's phaseRef / useViaReplan's busyRef — React state only
  // commits on the next render, so a second synchronous call must see this
  // immediately, not after a re-render.
  const busyRef = useRef(false);
  const cancelRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const reset = useCallback(() => {
    if (busyRef.current) return;
    setState(IDLE_STATE);
  }, []);

  const scan = useCallback(
    async (req: DepartureScanRequest): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      cancelRef.current = false;

      const total = req.count;
      setState({ scanning: true, index: 0, total, candidates: [], error: null, cancelled: false });

      const client = await ensureClient();
      if (!client) {
        busyRef.current = false;
        setState({
          scanning: false,
          index: 0,
          total,
          candidates: [],
          error: ROUTING_FAILURE_MESSAGE_KEY['worker-init'],
          cancelled: false,
        });
        return;
      }

      const candidates: DepartureCandidate[] = [];
      let stoppedByWorkerFailure = false;

      for (let i = 0; i < total; i++) {
        // Checked BEFORE starting a new solve, never mid-solve — see this
        // hook's own doc comment on cancel semantics.
        if (cancelRef.current) break;

        const departureMs = req.base.departureMs + i * req.stepHours * 3_600_000;
        const candidateReq: PlanRequest = {
          ...req.base,
          departureMs,
          sailIds: GENOA_SCAN_SAIL_IDS,
        };

        setState((s) => ({ ...s, index: i + 1 }));

        let outcome: DepartureCandidateOutcome;
        try {
          const result = await client.plan(candidateReq, req.windGrid);
          outcome =
            result.status === 'ok'
              ? { kind: 'ok', result }
              : { kind: 'no-route', reason: result.reason };
        } catch (err) {
          // #432/#553 pattern (usePlanFlow.ts, state/replan.ts): only tear
          // down the client when the failure actually leaves the worker
          // unhealthy — 'boat-not-in-catalogue' is raised client-side before
          // anything is posted and costs nothing to keep. When the worker IS
          // dead, every remaining candidate would fail identically (each a
          // fresh 'disposed' RoutingError) — stop the loop rather than
          // burning through the rest for no new information; this is a
          // second, independent early-stop from cancel(), reported through
          // this candidate's own 'failed' outcome, not the `cancelled` flag.
          if (!failureLeavesWorkerHealthy(err)) {
            disposeAfterFailure(client);
            stoppedByWorkerFailure = true;
          }
          outcome = { kind: 'failed', messageKey: routingFailureKey(err) };
        }

        candidates.push({ departureMs, outcome });
        setState((s) => ({ ...s, candidates: [...candidates] }));

        if (stoppedByWorkerFailure) break;
      }

      busyRef.current = false;
      setState({
        scanning: false,
        index: candidates.length,
        total,
        candidates,
        error: null,
        cancelled: cancelRef.current,
      });
    },
    [ensureClient],
  );

  return { state, scan, cancel, reset };
}
