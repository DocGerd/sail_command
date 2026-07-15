import type { PlanRequest, PlanResult, Rig, WindGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

type ProgressCb = (rig: Rig, tMs: number, frontierSize: number) => void;

const RIGS: readonly Rig[] = ['genoa', 'fock'];

export class RoutingClient {
  private worker: Worker;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private disposed = false;
  private pending = new Map<string, { resolve: (r: PlanResult) => void; reject: (e: Error) => void; onProgress?: ProgressCb }>();
  // throttle state: last-forwarded timestamp per `${id}:${rig}`, at most 1 progress callback per 100 ms per rig
  private lastProgressAt = new Map<string, number>();

  constructor(workerFactory?: () => Worker) {
    this.worker = workerFactory
      ? workerFactory()
      : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    // Swallow unhandled-rejection warnings when disposed before anyone awaits
    // init(); init() still returns `this.ready` directly, so callers observe it.
    this.ready.catch(() => {});
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => this.failAll(new Error(e.message || 'worker error'));
    this.worker.onmessageerror = () =>
      this.failAll(new Error('worker message could not be deserialized'));
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
    } else if (msg.id) {
      this.pending.get(msg.id)?.reject(new Error(msg.message));
      this.pending.delete(msg.id);
      this.clearProgress(msg.id);
    } else {
      this.failAll(new Error(msg.message));
    }
  }

  private clearProgress(id: string) {
    for (const rig of RIGS) this.lastProgressAt.delete(`${id}:${rig}`);
  }

  private failAll(err: Error) {
    this.readyReject(err);
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
    this.lastProgressAt.clear();
  }

  init(assets: Omit<Extract<WorkerRequest, { type: 'init' }>, 'type'>): Promise<void> {
    this.worker.postMessage({ type: 'init', ...assets }, [assets.maskBuffer]);
    return this.ready;
  }

  async plan(request: PlanRequest, windGrid: WindGrid, onProgress?: ProgressCb): Promise<PlanResult> {
    await this.ready;
    if (this.disposed) throw new Error('RoutingClient disposed');
    const id = crypto.randomUUID();
    return new Promise<PlanResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'plan', id, request, windGrid } satisfies WorkerRequest);
    });
  }

  dispose() {
    this.disposed = true;
    this.failAll(new Error('RoutingClient disposed'));
    this.worker.terminate();
  }
}
