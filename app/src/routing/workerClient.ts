import type { PlanRequest, PlanResult, SailId, WindGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { BOATS, polarKey, type BoatId } from '../data/boats';
import { windGridCoversBounds, type WindLatticeCoverageBounds } from '../lib/wind';

type ProgressCb = (sailId: SailId, tMs: number, frontierSize: number, secondPass: boolean) => void;
// #53 relaxed-depth probe phase (one call per mask-connectivity probe). Not
// throttled like ProgressCb: a whole search is at most a handful of probes.
type ProbeCb = (probeDepthM: number, done: number, total: number) => void;

// #54: derived from the BOATS catalogue rather than a hand-written
// two-element array literal — only used to enumerate throttle-map keys for
// clearProgress() below, but the same centralisation the #54 structural
// guard (test/sailLiteralCallSites.test.ts) expects everywhere else.
const SAIL_IDS: readonly SailId[] = BOATS.flatMap((b) => b.sails.map((s) => s.id));

// #433/#435 spike §12: a typed discriminator for every failure RoutingClient
// can produce, mirroring the two existing precedents in this codebase rather
// than inventing a third shape — OpenMeteoError (services/openMeteo.ts:16-24,
// `readonly kind`) and ReplanError (state/replan.ts:50-58, `readonly
// messageKey`). Deliberately kept OUT of types.ts, same rule as
// SolveFailureCause (routing/isochrone.ts): a routing-internal discriminator
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
  | 'disposed' // this client is (or became) disposed
  // #54 spec §I.3: `request.boat.id` names a boat the CURRENT catalogue does
  // not contain, so there is nothing to plan WITH. Rejected here, before the
  // message is posted, rather than letting protocol.ts's `boatById(req.boatId)`
  // throw inside the worker — that would arrive as an untyped 'worker-fatal'
  // and be reported as a generic internal routing error, whose copy names
  // no cause and points the user at "a different route or settings" when
  // the actual remedy is a boat the catalogue still holds.
  // §I.3's guarantee is exactly this narrow: such a plan "still opens, still
  // renders, still exports GPX … Only 'plan again with this boat' is
  // unavailable, and it says so."
  | 'boat-not-in-catalogue'
  // #295: the stored wind grid does not cover the mask's domain — a plan saved
  // on the pre-#295 187-point lattice, re-planned against the widened mask.
  // Rejected here, before posting, with the same predicate planRoute.ts's
  // `new WindField(windGrid, mask.meta)` (#1178) would otherwise throw as an
  // untyped 'worker-fatal'. Only a fresh forecast fixes it; no migration.
  | 'wind-grid-coverage'
  // #1193: a user-initiated cancel, not a fault — the ONE kind this class
  // carries that the presentation layer must not apologise for.
  //
  // A worker's onmessage handler runs planRoute() fully synchronously (no
  // `await` between accepting a request and posting its result), so a
  // posted 'cancel' message would sit unread behind the very handler it is
  // meant to interrupt. `Worker.terminate()` is therefore the only way to
  // actually stop a running solve, and cancel() below uses exactly the
  // dispose() mechanism (terminate + reject every pending entry) — it earns
  // its own kind rather than reusing 'disposed' because 'disposed' means
  // "this client was already dead when you asked", while 'cancelled' means
  // "the user asked, and this client is dead BECAUSE of that ask".
  | 'cancelled';

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
// For scale, with the machine named next to every figure — the headroom is a
// property of the DEVICE, not of the route, and PR #453 review caught the
// first draft stating a one-machine ratio as a general property. This app's
// most expensive real input is Flensburg -> Marstal at DEFAULT_SETTINGS
// against the real committed mask and polars.
//
// Full record of the #1147 headroom measurement:
// docs/spikes/1147-budget-headroom-reference-device.md. Do not restate any of
// this as a bare multiplier without naming a machine and whether the wind was
// live or synthetic.
//
// 360 s: maintainer ruling 2026-09-21 on #1331 (option B). Both rigs solve
// sequentially under this one deadline. Per-rig budgets are #1350.
export const PLAN_BUDGET_MS = 360_000;

// How much longer the CLIENT waits than the budget it handed the worker. The
// solver must always win this race: it is the side that produces the honest,
// specific "budget exceeded" answer, while this deadline can only ever say
// "no reply". Sized to cover, in order: the worker's abort granularity of one
// isochrone ring, plus postMessage + structured-clone of the request on the
// way in (the client's clock starts BEFORE the worker's, so the worker's
// deadline lands strictly later than this one otherwise would), plus
// unwinding four tiers and posting the result back.
//
// #1280: also the RE-ARM window once a plan has started — see armLiveness()
// below. Exported so a test can advance a fake clock by exactly this amount
// rather than duplicating the literal.
export const PLAN_TIMEOUT_GRACE_MS = 15_000;

// #1280: root cause was a single ring (or a late worker clock start) eating
// the WHOLE grace above under CPU contention, so the client timed out
// (`kind: 'timeout'`) while the worker was still genuinely working and would
// have answered. armLiveness() below re-arms the liveness timer to
// PLAN_TIMEOUT_GRACE_MS on every progress/probe message the worker posts
// (isochrone.ts posts one `progress` per RING — the same granularity its own
// deadline check runs at), so the client only times out on a worker that has
// gone SILENT for a full grace window, not merely slow.
//
// This alone does not close the single-super-long-ring case (no progress
// posts until that ring finishes) — pairing a mid-ring deadline check into
// isochrone.ts is tracked separately, out of scope here.
//
// HARD_CAP_EXTRA bounds the other direction: a worker that posts progress
// forever (whether a bug, or simply the case the #1280 comment scopes OUT —
// one ring so long it straddles the worker's own PLAN_BUDGET_MS deadline
// check, which only runs at ring ENTRY) must still not hold the client open
// indefinitely. Four grace windows gives that one straddling ring several
// multiples of the existing per-ring margin to finish and post its own
// honest budget-exhausted answer, so the total extra wait stays a small,
// fixed addition rather than unbounded.
export const PLAN_TIMEOUT_HARD_CAP_EXTRA_MS = 4 * PLAN_TIMEOUT_GRACE_MS;

// Now purely a LIVENESS backstop, not the routing wall it used to be: with
// the budget above, a merely-slow solve is stopped worker-side and answers
// honestly, so reaching this deadline means the worker never replied at all
// (postMessage swallowed, thread wedged, or killed without firing onerror —
// a Chromium OOM frequently does exactly that, #432). Raised from the
// pre-#432 client deadline so it can no longer pre-empt the budget; the cost
// is a genuinely dead worker being reported PLAN_TIMEOUT_GRACE_MS later,
// which does not affect worker.onerror/onmessageerror — those fail fast
// through failAll() and never touch this timer.
//
// #1280: this is now the INITIAL window only (start of plan() to the first
// progress/probe message, or to the result if none ever arrives) — see
// armLiveness() and PLAN_TIMEOUT_HARD_CAP_EXTRA_MS above for what happens
// once the worker is known to be alive.
const DEFAULT_PLAN_TIMEOUT_MS = PLAN_BUDGET_MS + PLAN_TIMEOUT_GRACE_MS;

/**
 * #553 / spec §I.3: narrow a stored plan's `BoatSnapshot.id` (a plain
 * `string`, deliberately — a snapshot is denormalised BY VALUE and outlives
 * the catalogue) to a `BoatId` the catalogue actually contains, or `null`.
 *
 * This is the ONE place the string-to-catalogue crossing happens on the plan
 * path, and it is a lookup rather than a `boatById` call precisely because
 * `boatById` THROWS: the whole point is to answer "is this boat still here?"
 * without turning a documented graceful state into an exception. Exported so
 * the narrowing is testable without a fake worker, the same reason
 * `buildPlanMessage` is.
 *
 * Matched against `BOATS` directly rather than against a hand-written id
 * list, so adding a catalogue entry needs no edit here and no second copy can
 * drift out of step with the catalogue.
 */
export function catalogueBoatId(id: string): BoatId | null {
  return BOATS.find((b) => b.id === id)?.id ?? null;
}

/**
 * #54 spec F.3: assemble the `plan` message, naming which of `init`'s keyed
 * polars this plan runs. Exported so the derivation is testable without a
 * fake worker.
 *
 * `boatId` STAYS an explicit argument rather than being read off
 * `request.boat.id` INSIDE this function: `BoatSnapshot.id` is `string`
 * because a plan's boat may have left the catalogue, while this parameter is
 * the narrowed `BoatId` that protocol.ts feeds to `boatById`, which THROWS on
 * an unknown id. Keeping the narrowing OUTSIDE is what lets `plan()` reject
 * the unknown-boat case as a typed `'boat-not-in-catalogue'` failure instead
 * of it becoming a worker throw.
 *
 * #553 / spec §I.3: what changed is the ARGUMENT `plan()` passes, not this
 * signature. It used to be `DEFAULT_BOAT_ID` — a constant — so a request for
 * any boat other than the default would have been SOLVED with the Salona 45's
 * polars and, via `PlanDeps.boat`, the Salona 45's §C.4(a) relaxation floor,
 * while the UI reported the user's own boat from `request.boat`. Latent while
 * the catalogue held one entry; a silent safety error the moment it held two,
 * because the floor is derived from DRAFT. It is now
 * `catalogueBoatId(request.boat.id)`, resolved at the boundary.
 *
 * `polarKeys` follows `request.sailIds` order, so the worker's subset matches
 * the order the solver runs them in — and it is keyed by the SAME resolved
 * `boatId`, so the polar tables and the relaxation floor can never name
 * different boats.
 */
export function buildPlanMessage(
  request: PlanRequest,
  boatId: BoatId,
  wire: { id: string; windGrid: WindGrid; budgetMs?: number },
): Extract<WorkerRequest, { type: 'plan' }> {
  return {
    type: 'plan',
    id: wire.id,
    request,
    boatId,
    polarKeys: request.sailIds.map((sailId) => polarKey(boatId, sailId)),
    windGrid: wire.windGrid,
    // exactOptionalPropertyTypes: omit the key entirely, never send
    // `budgetMs: undefined`.
    ...(wire.budgetMs !== undefined ? { budgetMs: wire.budgetMs } : {}),
  };
}

interface PendingEntry {
  resolve: (r: PlanResult) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressCb;
  onProbe?: ProbeCb;
  timer: ReturnType<typeof setTimeout>;
  // #1280 review Major 1: the ORIGINAL fixed deadline (plan start + this
  // call's own timeoutMs) — a re-arm may EXTEND past this, never resolve to
  // a moment before it. Without this floor, armLiveness()'s window-only form
  // could time out EARLIER than the pre-#1280 client ever did (a progress
  // message followed by a >grace, sub-timeoutMs silence — e.g. one 20 s ring
  // after a fast first ring — rejected at first-progress + grace, where the
  // old single fixed timer would still have been waiting). See armLiveness().
  softDeadlineAtMs: number;
  // #1280: absolute Date.now()-based ceiling this entry's liveness timer may
  // never be re-armed past, set once at plan() call time. See armLiveness().
  hardDeadlineAtMs: number;
}

export class RoutingClient {
  private worker: Worker;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private disposed = false;
  // #295: the mask domain init() handed the worker, kept for plan()'s
  // wind-grid coverage check. Set before `ready` can resolve.
  private maskBounds: WindLatticeCoverageBounds | null = null;
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
  // throttle state: last-forwarded timestamp per `${id}:${sailId}`, at most 1 progress callback per 100 ms per sail
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
      // #1280: re-arm on every RECEIVED progress message, independent of the
      // 100 ms UI-forwarding throttle just below — a throttled message is
      // still proof the worker is alive.
      this.armLiveness(msg.id, PLAN_TIMEOUT_GRACE_MS);
      const key = `${msg.id}:${msg.sailId}`;
      const last = this.lastProgressAt.get(key);
      const now = Date.now();
      if (last !== undefined && now - last < 100) return;
      this.lastProgressAt.set(key, now);
      this.pending
        .get(msg.id)
        ?.onProgress?.(msg.sailId, msg.tMs, msg.frontierSize, msg.secondPass === true);
    } else if (msg.type === 'probe') {
      // #1280: same re-arm as progress — probes are sparse (#53's "a handful
      // per search" comment on ProbeCb) but equally real liveness evidence.
      this.armLiveness(msg.id, PLAN_TIMEOUT_GRACE_MS);
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
    for (const sailId of SAIL_IDS) this.lastProgressAt.delete(`${id}:${sailId}`);
  }

  // #1280 review Major 1: (re)arms `id`'s liveness timer to fire no EARLIER
  // than `windowMs` from now AND no earlier than the entry's own
  // softDeadlineAtMs (the pre-#1280 fixed deadline this plan started with) —
  // whichever is LATER — but never later than hardDeadlineAtMs. The floor is
  // what makes a re-arm strictly EXTEND the wait a caller would already have
  // gotten pre-#1280, never shorten it: reviewer-supplied form,
  // `delay = min(max(softDeadlineAtMs - now, windowMs), hardDeadlineAtMs -
  // now)`. A no-op once the entry has settled (settle() already deleted it
  // from `pending`).
  private armLiveness(id: string, windowMs: number) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    const now = Date.now();
    const delay = Math.max(
      0,
      Math.min(Math.max(entry.softDeadlineAtMs - now, windowMs), entry.hardDeadlineAtMs - now),
    );
    entry.timer = setTimeout(() => {
      this.settle(id, (e) => e.reject(new RoutingError('timeout', 'routing timed out')));
    }, delay);
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
    const { west, south, east, north } = assets.maskMeta;
    this.maskBounds = { west, south, east, north };
    this.worker.postMessage({ type: 'init', ...assets }, [assets.maskBuffer]);
    return this.ready;
  }

  // `timeoutMs` defaults to DEFAULT_PLAN_TIMEOUT_MS; overridable so tests
  // don't need to wait out (or fake-timer-advance) four real minutes.
  async plan(
    request: PlanRequest,
    windGrid: WindGrid,
    onProgress?: ProgressCb,
    timeoutMs: number = DEFAULT_PLAN_TIMEOUT_MS,
    onProbe?: ProbeCb,
  ): Promise<PlanResult> {
    // #1193 residual: a cancel() landing between this line and pending.set()
    // below sees nothing pending and no-ops. Unreachable today — by the time
    // usePlanFlow.ts calls plan(), `ready` is already resolved (ensureClient()
    // awaited it first), so this is one microtask tick, too narrow for a DOM
    // click to land inside. Reachable if a future caller invokes plan()
    // before `ready` resolves and cancels inside that window.
    await this.ready;
    if (this.disposed) throw new RoutingError('disposed', 'RoutingClient disposed');
    // #553 / spec §I.3: resolve the REQUEST's own boat against the catalogue,
    // BEFORE any pending entry or timer exists, so a rejection here leaves no
    // state to clean up. Rejecting rather than falling back to a default is
    // the whole fix: a fallback is what silently solved a second boat's plan
    // with the Salona 45's polars and relaxation floor.
    const boatId = catalogueBoatId(request.boat.id);
    if (boatId === null) {
      throw new RoutingError('boat-not-in-catalogue', `boat not in catalogue: ${request.boat.id}`);
    }
    // #295: same pre-post position and no-state-to-clean-up property as the
    // boat check above.
    if (this.maskBounds !== null && !windGridCoversBounds(windGrid, this.maskBounds)) {
      throw new RoutingError(
        'wind-grid-coverage',
        'stored wind grid does not cover the mask domain',
      );
    }
    const id = crypto.randomUUID();
    return new Promise<PlanResult>((resolve, reject) => {
      // A hung worker (message lost, or stuck past its own step budget)
      // otherwise leaves this promise — and the UI's "routing…" state —
      // pending forever. Treated exactly like a targeted fatal for this one
      // id via settle(): reject, drop from `pending`, clear its throttle
      // keys, so a worker result that does eventually arrive late is a
      // silent no-op (settle() finds nothing left to settle) rather than a
      // second, conflicting resolution.
      // #1280: softDeadlineAtMs is the ORIGINAL fixed deadline (set once,
      // here, from THIS call's own timeoutMs — never
      // PLAN_BUDGET_MS/DEFAULT_PLAN_TIMEOUT_MS directly, mirroring how
      // budgetMs is already derived from timeoutMs above). armLiveness()'s
      // review-fixed floor means a re-arm can never resolve to a moment
      // before this, so a caller that shortens timeoutMs (every existing
      // test) shortens BOTH the initial wait and that floor together, and
      // the two can never invert.
      const softDeadlineAtMs = Date.now() + timeoutMs;
      // hardDeadlineAtMs is the absolute ceiling armLiveness() below may
      // never re-arm past regardless of the floor above, so
      // PLAN_TIMEOUT_HARD_CAP_EXTRA_MS bounds the total wait even under
      // continuous progress.
      const hardDeadlineAtMs = softDeadlineAtMs + PLAN_TIMEOUT_HARD_CAP_EXTRA_MS;
      // Initial window is timeoutMs itself, exactly as before #1280 — no
      // progress/probe has arrived yet, so there is nothing to re-arm on.
      // The Math.min clamp is a no-op here (hardDeadlineAtMs - now() >
      // timeoutMs by construction) and exists only so this and armLiveness()
      // share one invariant: no timer this entry owns ever exceeds
      // hardDeadlineAtMs.
      const timer = setTimeout(
        () => {
          this.settle(id, (entry) =>
            entry.reject(new RoutingError('timeout', 'routing timed out')),
          );
        },
        Math.min(timeoutMs, hardDeadlineAtMs - Date.now()),
      );
      // exactOptionalPropertyTypes: `onProgress`/`onProbe` are `... | undefined`
      // here (omitted args), but the map's value type declares them as
      // optional-if-present, not optional-or-undefined — so an absent
      // callback must omit its key entirely rather than set it to undefined.
      const entry: PendingEntry = { resolve, reject, timer, softDeadlineAtMs, hardDeadlineAtMs };
      if (onProgress) entry.onProgress = onProgress;
      if (onProbe) entry.onProbe = onProbe;
      this.pending.set(id, entry);
      // #432: `budgetMs` is derived from THIS call's own timeoutMs rather
      // than read off the PLAN_BUDGET_MS constant, so a test (or any future
      // caller) that shortens the client deadline shortens the worker's
      // budget with it and the two can never invert — a worker budget longer
      // than the client deadline would silently restore the pre-#432
      // behaviour of the client pre-empting the solver's honest answer.
      //
      // PR #453 review, Minor 1: a deadline at or under the grace margin
      // leaves no room for a budget, and the first draft clamped it to
      // `Math.max(0, …)`. That made the budget UNSATISFIABLE rather than
      // absent — `expired()` is `Date.now() - startedAtMs >= 0`, true on its
      // first evaluation, so every such plan died before expanding one ring.
      // Latent, not live (no production caller overrides timeoutMs today),
      // but it satisfied "the two can never invert" by making the budget
      // impossible, which is not what that sentence is for. Omitting the key
      // instead degrades to the documented FAIL-OPEN unbudgeted path that
      // planRoute()/solve()/protocol.ts all already take when the deadline is
      // absent — the same direction as the rest of the design, and the client
      // deadline still bounds the wait.
      const budgetMs = timeoutMs - PLAN_TIMEOUT_GRACE_MS;
      // #553 / spec §I.3: the boat resolved from `request.boat.id` above —
      // NEVER DEFAULT_BOAT_ID. `boatId` selects BOTH the polar tables
      // (`polarKeys`) and, through protocol.ts's `boatById(req.boatId)` ->
      // `PlanDeps.boat`, the §C.4(a) relaxation floor, so a constant here
      // would solve every boat's plan as a Salona 45 while the UI reported
      // the user's own boat.
      this.worker.postMessage(
        buildPlanMessage(request, boatId, {
          id,
          windGrid,
          ...(budgetMs > 0 ? { budgetMs } : {}),
        }) satisfies WorkerRequest,
      );
    });
  }

  // Shared by dispose() and cancel(): both stop the client by the same
  // mechanism (terminate + reject everything pending) and differ only in
  // which RoutingFailureKind that rejection carries.
  private teardown(kind: 'disposed' | 'cancelled', message: string) {
    this.disposed = true;
    this.failAll(new RoutingError(kind, message));
    this.worker.terminate();
  }

  dispose() {
    this.teardown('disposed', 'RoutingClient disposed');
  }

  /**
   * #1193: stop whatever plan() call is currently in flight. A no-op when
   * nothing is pending (already settled, or never started) — cancel racing
   * a result that is already on its way, or a stray second click, costs
   * nothing. See RoutingFailureKind's 'cancelled' comment for why this must
   * terminate the worker rather than post a message, and
   * state/replan.ts's disposeAfterFailure doc for the shared-singleton
   * consequence this inherits from dispose(): an unrelated in-flight
   * request on the same client is torn down too.
   */
  cancel() {
    if (this.pending.size === 0) return;
    this.teardown('cancelled', 'plan cancelled by user');
  }
}
