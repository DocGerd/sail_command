import type { MaskMeta, PlanRequest, PlanResult, PolarTable, SailId, WindGrid } from '../types';
import { NavMask } from '../lib/mask';
import { boatById, type BoatId } from '../data/boats';
import { planRoute, type PlanDeps } from './planRoute';

export type WorkerRequest =
  | {
      type: 'init';
      maskMeta: MaskMeta;
      maskBuffer: ArrayBuffer;
      /**
       * #54 spec F.3: EVERY catalogue boat's polars, keyed by
       * `data/boats.ts`'s polarKey(). Plain objects, so they are CLONED by
       * structured clone, never transferred — only the mask buffer is
       * transferred. Single-digit KB, paid once at startup, which is what
       * keeps "init once, plan many" true for a multi-boat catalogue.
       */
      polars: Readonly<Record<string, PolarTable>>;
    }
  | {
      type: 'plan';
      id: string;
      request: PlanRequest;
      /**
       * #54: which boat the solver plans with. SAFETY-CRITICAL — it is what
       * `planRoute` derives the spec C.4(a) relaxation floor from, so it is
       * carried explicitly rather than parsed back out of `polarKeys`.
       *
       * #553 / spec §I.3: this field STAYS, and it is still not
       * `request.boat.id` — but the reason has changed and the previous
       * comment here now describes the opposite of what happens. It used to
       * say Task 11 deliberately did not derive this from `PlanRequest.boat`
       * because `boatById(req.boatId)` below throws on an off-catalogue id.
       * The client no longer sends a constant: `workerClient.ts`'s `plan()`
       * resolves `request.boat.id` through `catalogueBoatId()` and REJECTS an
       * unknown one as a typed `'boat-not-in-catalogue'` failure before this
       * message is ever posted. So the field is still the NARROWED `BoatId`
       * (which is what keeps `boatById` below total), and the narrowing
       * simply happens client-side where it can produce a graceful error
       * rather than a worker throw.
       */
      boatId: BoatId;
      /**
       * #54 spec F.3: which of `init`'s keys this plan runs, in
       * `request.sailIds` order. Selects the subset handed to `PlanDeps`, so
       * a key missing here is a key the solver cannot reach.
       */
      polarKeys: readonly string[];
      windGrid: WindGrid;
      /**
       * #432: wall-clock budget for the WHOLE plan (all tiers, both rigs,
       * every waypoint segment), measured from the moment this handler
       * starts. Defined and sent by routing/workerClient.ts so the budget
       * and the client-side liveness deadline that backstops it have a
       * single definition and cannot drift apart.
       *
       * OPTIONAL, and absent means UNBUDGETED — the same fail-open default
       * planRoute()/solve() use. That is the right asymmetry for this
       * particular control: it is a diagnostic/UX bound rather than a safety
       * one, and its absence degrades exactly to the pre-#432 shipped
       * behaviour (the client deadline still bounds the wait), never to
       * something unbounded that is bounded today.
       */
      budgetMs?: number;
    };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: string; sailId: SailId; tMs: number; frontierSize: number }
  // #53: one message per relaxed-depth connectivity probe (mask BFS, no solver
  // run) so the UI can show the probe phase instead of a stalled routing bar.
  | { type: 'probe'; id: string; probeDepthM: number; done: number; total: number }
  | { type: 'result'; id: string; result: PlanResult }
  // #433/#435 spike §12: `stack` is the worker-side stack trace at the real
  // throw site inside planRoute() — populated below, consumed by
  // workerClient.ts's RoutingError so the resulting client-side error names
  // where the failure actually happened, not just where it was reported.
  | { type: 'fatal'; id: string | null; message: string; stack?: string };

export function createHandler(post: (r: WorkerResponse) => void): (req: WorkerRequest) => void {
  let state: { mask: NavMask; polars: Readonly<Record<string, PolarTable>> } | null = null;
  return (req) => {
    try {
      if (req.type === 'init') {
        state = {
          mask: new NavMask(req.maskMeta, new Uint8Array(req.maskBuffer)),
          polars: req.polars,
        };
        post({ type: 'ready' });
        return;
      }
      if (!state) throw new Error('plan requested before init');
      // #432: ONE deadline object for the whole plan, created here — the
      // worker request handler is the only place in the routing stack with a
      // human actually waiting on the answer, which is why the budget is
      // imposed here rather than defaulted inside planRoute(). Keeping
      // planRoute() pure is what stops a wall-clock bound from deciding the
      // outcome of a vitest run whose speed swings with the runner
      // (CLAUDE.md: ~2.1x on CI, and a separate 8x multiplier under coverage
      // for solver-heavy work).
      const budgetMs = req.budgetMs;
      const startedAtMs = Date.now();
      const deadline =
        budgetMs === undefined
          ? undefined
          : { expired: () => Date.now() - startedAtMs >= budgetMs };
      // #54: `polarKeys` selects the subset of init's map this plan may reach.
      // A key init never carried is simply absent here; planRoute() owns the
      // fail-closed throw, so the check lives at ONE boundary rather than two
      // (the sweep harness and every test construct PlanDeps directly and
      // must hit the same check).
      const polars: Record<string, PolarTable> = {};
      for (const key of req.polarKeys) {
        const table: PolarTable | undefined = state.polars[key];
        if (table !== undefined) polars[key] = table;
      }
      const deps: PlanDeps = { polars, boat: boatById(req.boatId), mask: state.mask };
      const result = planRoute(
        req.request,
        req.windGrid,
        deps,
        (sailId, info) =>
          post({
            type: 'progress',
            id: req.id,
            sailId,
            tMs: info.tMs,
            frontierSize: info.frontierSize,
          }),
        (p) =>
          post({
            type: 'probe',
            id: req.id,
            probeDepthM: p.probeDepthM,
            done: p.done,
            total: p.total,
          }),
        deadline,
      );
      post({ type: 'result', id: req.id, result });
    } catch (err) {
      try {
        // exactOptionalPropertyTypes: `stack` must be OMITTED, not set to
        // `undefined`, when the throw carries none — same idiom as
        // workerClient.ts's PendingEntry construction.
        const stack = err instanceof Error ? err.stack : undefined;
        post({
          type: 'fatal',
          id: req.type === 'plan' ? req.id : null,
          message: err instanceof Error ? err.message : String(err),
          ...(stack !== undefined ? { stack } : {}),
        });
      } catch {
        // If even the fatal report can't be serialized/posted, there's nothing
        // more we can do here — the client's worker.onerror/failAll path is
        // the backstop.
      }
    }
  };
}
