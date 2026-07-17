import type { PlanRequest, PlanResult, Rig, WindGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

type ProgressCb = (rig: Rig, tMs: number, frontierSize: number) => void;
// #53 relaxed-depth probe phase (one call per mask-connectivity probe). Not
// throttled like ProgressCb: a whole search is at most a handful of probes.
type ProbeCb = (probeDepthM: number, done: number, total: number) => void;

const RIGS: readonly Rig[] = ['genoa', 'fock'];

// Generous but finite: a real solve over the full 6-day forecast horizon
// with both rigs can legitimately take tens of seconds on slow hardware, but
// a hung worker (postMessage swallowed, or stuck in an infinite loop past
// isochrone.ts's own step budget) must not leave the UI in "routing…"
// forever with no way out.
const DEFAULT_PLAN_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve: (r: PlanResult) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressCb;
  onProbe?: ProbeCb;
  timer: ReturnType<typeof setTimeout>;
}

export class RoutingClient {
  private worker: Worker;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private disposed = false;
  private pending = new Map<string, PendingEntry>();
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
    } else if (msg.type === 'probe') {
      this.pending.get(msg.id)?.onProbe?.(msg.probeDepthM, msg.done, msg.total);
    } else if (msg.type === 'result') {
      this.settle(msg.id, (entry) => entry.resolve(msg.result));
    } else if (msg.id) {
      this.settle(msg.id, (entry) => entry.reject(new Error(msg.message)));
    } else {
      this.failAll(new Error(msg.message));
    }
  }

  // Shared by every path that finishes a specific pending plan() call
  // (result, targeted fatal, and the timeout below): clears its timer —
  // so a late-arriving worker message after a timeout, or vice versa, can
  // never double-settle the same promise or leave a stray timer running —
  // before removing it from `pending`/`lastProgressAt`.
  private settle(id: string, run: (entry: PendingEntry) => void): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.clearProgress(id);
    run(entry);
  }

  private clearProgress(id: string) {
    for (const rig of RIGS) this.lastProgressAt.delete(`${id}:${rig}`);
  }

  private failAll(err: Error) {
    this.readyReject(err);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.lastProgressAt.clear();
  }

  init(assets: Omit<Extract<WorkerRequest, { type: 'init' }>, 'type'>): Promise<void> {
    this.worker.postMessage({ type: 'init', ...assets }, [assets.maskBuffer]);
    return this.ready;
  }

  // `timeoutMs` defaults to DEFAULT_PLAN_TIMEOUT_MS; overridable so tests
  // don't need to wait out (or fake-timer-advance) two real minutes.
  async plan(
    request: PlanRequest,
    windGrid: WindGrid,
    onProgress?: ProgressCb,
    timeoutMs: number = DEFAULT_PLAN_TIMEOUT_MS,
    onProbe?: ProbeCb,
  ): Promise<PlanResult> {
    await this.ready;
    if (this.disposed) throw new Error('RoutingClient disposed');
    const id = crypto.randomUUID();
    return new Promise<PlanResult>((resolve, reject) => {
      // A hung worker (message lost, or stuck past its own step budget)
      // otherwise leaves this promise — and the UI's "routing…" state —
      // pending forever. Treated exactly like a targeted fatal for this one
      // id via settle(): reject, drop from `pending`, clear its throttle
      // keys, so a worker result that does eventually arrive late is a
      // silent no-op (settle() finds nothing left to settle) rather than a
      // second, conflicting resolution.
      const timer = setTimeout(() => {
        this.settle(id, (entry) => entry.reject(new Error('routing timed out')));
      }, timeoutMs);
      // exactOptionalPropertyTypes: `onProgress`/`onProbe` are `... | undefined`
      // here (omitted args), but the map's value type declares them as
      // optional-if-present, not optional-or-undefined — so an absent
      // callback must omit its key entirely rather than set it to undefined.
      const entry: PendingEntry = { resolve, reject, timer };
      if (onProgress) entry.onProgress = onProgress;
      if (onProbe) entry.onProbe = onProbe;
      this.pending.set(id, entry);
      this.worker.postMessage({ type: 'plan', id, request, windGrid } satisfies WorkerRequest);
    });
  }

  dispose() {
    this.disposed = true;
    this.failAll(new Error('RoutingClient disposed'));
    this.worker.terminate();
  }
}
