import type { MaskMeta, PlanRequest, PlanResult, PolarTable, SailId, WindGrid } from '../types';
import { NavMask } from '../lib/mask';
import { planRoute } from './planRoute';

export type WorkerRequest =
  | {
      type: 'init';
      maskMeta: MaskMeta;
      maskBuffer: ArrayBuffer;
      polarGenoa: PolarTable;
      polarFock: PolarTable;
    }
  | {
      type: 'plan';
      id: string;
      request: PlanRequest;
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
  let state: { mask: NavMask; polarGenoa: PolarTable; polarFock: PolarTable } | null = null;
  return (req) => {
    try {
      if (req.type === 'init') {
        state = {
          mask: new NavMask(req.maskMeta, new Uint8Array(req.maskBuffer)),
          polarGenoa: req.polarGenoa,
          polarFock: req.polarFock,
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
      const result = planRoute(
        req.request,
        req.windGrid,
        state,
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
