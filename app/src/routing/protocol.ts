import type {
  MaskMeta, PlanRequest, PlanResult, PolarTable, Rig, WindGrid,
} from '../types';
import { NavMask } from '../lib/mask';
import { planRoute } from './planRoute';

export type WorkerRequest =
  | { type: 'init'; maskMeta: MaskMeta; maskBuffer: ArrayBuffer; polarGenoa: PolarTable; polarFock: PolarTable }
  | { type: 'plan'; id: string; request: PlanRequest; windGrid: WindGrid };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: string; rig: Rig; tMs: number; frontierSize: number }
  | { type: 'result'; id: string; result: PlanResult }
  | { type: 'fatal'; id: string | null; message: string };

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
      const result = planRoute(req.request, req.windGrid, state, (rig, info) =>
        post({ type: 'progress', id: req.id, rig, tMs: info.tMs, frontierSize: info.frontierSize }),
      );
      post({ type: 'result', id: req.id, result });
    } catch (err) {
      post({
        type: 'fatal',
        id: req.type === 'plan' ? req.id : null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
