import type { PlanRequest, PlanResult, Rig, WindGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

type ProgressCb = (rig: Rig, tMs: number, frontierSize: number) => void;

const RIGS = ['genoa', 'fock'] as const;

export class RoutingClient {
  private worker: Worker;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private pending = new Map<string, { resolve: (r: PlanResult) => void; reject: (e: Error) => void; onProgress?: ProgressCb }>();
  // throttle state: last-forwarded timestamp per `${id}:${rig}`, at most 1 progress callback per 100 ms per rig
  private lastProgressAt = new Map<string, number>();

  constructor(workerFactory?: () => Worker) {
    this.worker = workerFactory
      ? workerFactory()
      : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((res) => (this.readyResolve = res));
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
  }

  private handle(msg: WorkerResponse) {
    if (msg.type === 'ready') this.readyResolve();
    else if (msg.type === 'progress') {
      const key = `${msg.id}:${msg.rig}`;
      const last = this.lastProgressAt.get(key);
      const now = Date.now();
      if (last !== undefined && now - last < 100) return;
      this.lastProgressAt.set(key, now);
      this.pending.get(msg.id)?.onProgress?.(msg.rig, msg.tMs, msg.frontierSize);
    } else if (msg.type === 'result') {
      this.pending.get(msg.id)?.resolve(msg.result);
      this.pending.delete(msg.id);
      this.clearProgress(msg.id);
    } else {
      const entry = msg.id ? this.pending.get(msg.id) : null;
      entry?.reject(new Error(msg.message));
      if (msg.id) {
        this.pending.delete(msg.id);
        this.clearProgress(msg.id);
      }
    }
  }

  private clearProgress(id: string) {
    for (const rig of RIGS) this.lastProgressAt.delete(`${id}:${rig}`);
  }

  init(assets: Omit<Extract<WorkerRequest, { type: 'init' }>, 'type'>): Promise<void> {
    this.worker.postMessage({ type: 'init', ...assets }, [assets.maskBuffer]);
    return this.ready;
  }

  async plan(request: PlanRequest, windGrid: WindGrid, onProgress?: ProgressCb): Promise<PlanResult> {
    await this.ready;
    const id = crypto.randomUUID();
    return new Promise<PlanResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'plan', id, request, windGrid } satisfies WorkerRequest);
    });
  }

  dispose() {
    this.worker.terminate();
  }
}
