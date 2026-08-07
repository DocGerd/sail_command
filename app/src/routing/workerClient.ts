import type { PlanRequest, PlanResult, Rig, WindGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

type ProgressCb = (rig: Rig, tMs: number, frontierSize: number) => void;
// #53 relaxed-depth probe phase (one call per mask-connectivity probe). Not
// throttled like ProgressCb: a whole search is at most a handful of probes.
type ProbeCb = (probeDepthM: number, done: number, total: number) => void;

const RIGS: readonly Rig[] = ['genoa', 'fock'];

// #433/#435 spike §12: a typed discriminator for every failure RoutingClient
// can produce, mirroring the two existing precedents in this codebase rather
// than inventing a third shape — OpenMeteoError (services/openMeteo.ts:16-24,
// `readonly kind`) and ReplanError (state/replan.ts:50-58, `readonly
// messageKey`). Deliberately kept OUT of types.ts, same rule as
// SolveFailureCause (routing/planRoute.ts): a routing-internal discriminator
// must never leak into UI code as a control input, and never be re-derived
// by matching THIS Error's own `.message` text — that is exactly the
// #282/#411 label-as-control-input coupling this repo already paid to
// narrow once. The presentation-boundary mapping (kind -> MsgKey) lives in
// state/replan.ts as ROUTING_FAILURE_MESSAGE_KEY and is applied at all THREE
// call paths — usePlanFlow.ts's run(), replanWithVias() and
// rerouteFromFix() (#432; before that it was wired only at run()).
//
// CLOSED by #432 (it was recorded here as "narrowed, not closed" while #433
// shipped): the same RoutingClient.plan() is also called from
// state/replan.ts and state/reroute.ts, and both sites used to discard the
// caught error with a bare, unbound `catch {` before rethrowing a fresh,
// unrelated ReplanError('error.internal', …) — four sites in all, the other
// two being each file's own save()-failure catch. All four now bind the
// error and preserve its discriminator: the two plan() sites map
// RoutingError.kind through ROUTING_FAILURE_MESSAGE_KEY (state/replan.ts,
// which is where that table now lives so all three call paths share one
// copy), and the two save() sites carry the distinct 'persist-failed' cause
// instead of collapsing onto 'error.internal'.
export type RoutingFailureKind =
  // #432: no longer the routing wall — the worker's own PLAN_BUDGET_MS stops
  // a merely-slow solve first and answers with a specific no-route reason.
  // Reaching THIS deadline means the worker never replied at all.
  | 'timeout' // plan()'s own client-side liveness deadline (:DEFAULT_PLAN_TIMEOUT_MS) elapsed
  | 'worker-fatal' // protocol.ts forwarded a real throw from inside the worker (+stack)
  | 'worker-error' // the Worker's global onerror fired
  | 'messageerror' // the Worker's onmessageerror fired (undeserializable message)
  | 'disposed'; // this client is (or became) disposed

// NOT structured-clone-safe: Error subclasses lose their prototype chain
// across postMessage/IndexedDB (mirrors OpenMeteoError's and ReplanError's
// own caveat) — RoutingError must never cross a postMessage/IndexedDB
// boundary; it is constructed here, client-side, from plain WorkerResponse
// data, never sent as one.
export class RoutingError extends Error {
  readonly kind: RoutingFailureKind;

  constructor(kind: RoutingFailureKind, message: string) {
    super(message);
    this.name = 'RoutingError';
    this.kind = kind;
  }
}

// #432: the plan's WALL-CLOCK BUDGET, shipped to the worker in every plan
// request and turned into a shared deadline there (routing/protocol.ts) that
// every solve() of that plan checks per ring. Defined HERE, on the client,
// and sent over the wire rather than duplicated worker-side, so there is
// exactly one definition and no drift-guard test is needed to keep two in
// step.
//
// The VALUE is deliberately unchanged from the pre-#432 client deadline
// (120 s): #432 does not argue that number is wrong, only that exceeding it
// was misreported and unbudgeted. Keeping it is what makes "no
// currently-succeeding plan starts failing" true by construction rather than
// by measurement — the wall a slow solve hits is the same wall, moved from
// the client to the solver, which is the only side that can say where it got
// to. For scale: this app's most expensive real input (Flensburg -> Marstal
// at DEFAULT_SETTINGS, real committed mask+polars) measured 41-43 s of pure
// solver time on one dev machine, 2026-08-07 — a device would have to be
// ~3x slower to reach this budget at all.
export const PLAN_BUDGET_MS = 120_000;

// How much longer the CLIENT waits than the budget it handed the worker. The
// solver must always win this race: it is the side that produces the honest,
// specific "budget exceeded" answer, while this deadline can only ever say
// "no reply". Sized to cover, in order: the worker's abort granularity of one
// isochrone ring (MEASURED at 1045 ms worst case on the Flensburg -> Marstal
// input above, so ~3 s even on a device 3x slower), plus postMessage +
// structured-clone of the request on the way in (the client's clock starts
// BEFORE the worker's, so the worker's deadline lands strictly later than
// this one otherwise would), plus unwinding four tiers and posting the
// result back.
const PLAN_TIMEOUT_GRACE_MS = 15_000;

// Now purely a LIVENESS backstop, not the routing wall it used to be: with
// the budget above, a merely-slow solve is stopped worker-side and answers
// honestly, so reaching this deadline means the worker never replied at all
// (postMessage swallowed, thread wedged, or killed without firing onerror —
// a Chromium OOM frequently does exactly that, #432). Raised from the
// pre-#432 bare 120 s so it can no longer pre-empt the budget; the cost is
// that a genuinely dead worker is reported PLAN_TIMEOUT_GRACE_MS later,
// which is a small addition to an already ~2-minute wait and does not affect
// worker.onerror/onmessageerror, which fail fast through failAll() and never
// touch this timer.
const DEFAULT_PLAN_TIMEOUT_MS = PLAN_BUDGET_MS + PLAN_TIMEOUT_GRACE_MS;

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
  // #432: readable so an owner holding this client as a SINGLETON can notice
  // it was disposed by someone else and rebuild instead of handing the dead
  // one back forever. Before #432 the only two dispose() call sites both sat
  // in usePlanFlow.ts and each nulled the singleton refs in the same breath,
  // so the state was unobservable and did not need to be; state/replan.ts and
  // state/reroute.ts are now a third and fourth disposer that cannot reach
  // those refs, which is exactly what makes it observable — see
  // usePlanFlow.ts's ensureClient().
  get isDisposed(): boolean {
    return this.disposed;
  }
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
    this.worker.onerror = (e) =>
      this.failAll(new RoutingError('worker-error', e.message || 'worker error'));
    this.worker.onmessageerror = () =>
      this.failAll(new RoutingError('messageerror', 'worker message could not be deserialized'));
  }

  // #433: `stack` (protocol.ts's `fatal.stack`, populated at the real throw
  // site inside the worker) replaces the default Error.stack a bare `new
  // RoutingError(...)` would otherwise carry — which would only ever show
  // THIS file's own construction site, not where the failure actually
  // happened inside planRoute(). Without this, a forwarded worker throw
  // (cause: a real exception inside planRoute()) arrives stripped of the
  // one detail that identifies it.
  private makeWorkerFatalError(message: string, stack: string | undefined): RoutingError {
    const err = new RoutingError('worker-fatal', message);
    if (stack !== undefined) err.stack = stack;
    return err;
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
      this.settle(msg.id, (entry) =>
        entry.reject(this.makeWorkerFatalError(msg.message, msg.stack)),
      );
    } else {
      this.failAll(this.makeWorkerFatalError(msg.message, msg.stack));
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
    if (this.disposed) throw new RoutingError('disposed', 'RoutingClient disposed');
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
        this.settle(id, (entry) => entry.reject(new RoutingError('timeout', 'routing timed out')));
      }, timeoutMs);
      // exactOptionalPropertyTypes: `onProgress`/`onProbe` are `... | undefined`
      // here (omitted args), but the map's value type declares them as
      // optional-if-present, not optional-or-undefined — so an absent
      // callback must omit its key entirely rather than set it to undefined.
      const entry: PendingEntry = { resolve, reject, timer };
      if (onProgress) entry.onProgress = onProgress;
      if (onProbe) entry.onProbe = onProbe;
      this.pending.set(id, entry);
      // #432: `budgetMs` is derived from THIS call's own timeoutMs rather
      // than read off the PLAN_BUDGET_MS constant, so a test (or any future
      // caller) that shortens the client deadline shortens the worker's
      // budget with it and the two can never invert — a worker budget longer
      // than the client deadline would silently restore the pre-#432
      // behaviour of the client pre-empting the solver's honest answer.
      this.worker.postMessage({
        type: 'plan',
        id,
        request,
        windGrid,
        budgetMs: Math.max(0, timeoutMs - PLAN_TIMEOUT_GRACE_MS),
      } satisfies WorkerRequest);
    });
  }

  dispose() {
    this.disposed = true;
    this.failAll(new RoutingError('disposed', 'RoutingClient disposed'));
    this.worker.terminate();
  }
}
