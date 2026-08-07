import type { MaskMeta, PlanRequest, PlanResult, PolarTable, Rig, WindGrid } from '../types';
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
  | { type: 'plan'; id: string; request: PlanRequest; windGrid: WindGrid };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: string; rig: Rig; tMs: number; frontierSize: number }
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
      const result = planRoute(
        req.request,
        req.windGrid,
        state,
        (rig, info) =>
          post({
            type: 'progress',
            id: req.id,
            rig,
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
