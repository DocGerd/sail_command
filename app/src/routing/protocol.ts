import type {
  LatLon,
  MaskMeta,
  PlanRequest,
  PlanResult,
  PolarTable,
  SailId,
  Settings,
  WindGrid,
} from '../types';
import { NavMask } from '../lib/mask';
import { WindField } from '../lib/wind';
import { gateFloorM, type DepthGate } from '../lib/depthGate';
import { planLog } from '../lib/planLog';
import { boatById, type BoatId } from '../data/boats';
import {
  pass2DeadlineFrom,
  planRouteWithRecordAsync,
  polarLookup,
  solveRig,
  type PlanDeps,
  type RigContext,
  type RigStep,
  type RunOut,
} from './planRoute';
import type { SolveDeadline } from './isochrone';
import { planWithHarborHandover, planWithHarborHandoverAsync } from './harborHandover';

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
      /** #1721: harbour ids the handover wrapper must never substitute. */
      knownDisconnectedHarborIds: readonly string[];
      /**
       * Present when a sibling solve worker is attached: the ladder then runs
       * odd-indexed rigs on it. Absent means the single-worker path.
       */
      solverPort?: MessagePort;
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
       * comment here now gives the wrong reason. It used to
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
  | {
      type: 'progress';
      id: string;
      sailId: SailId;
      tMs: number;
      frontierSize: number;
      /** #1136: present (true) only on a pass-2 solve's progress. */
      secondPass?: true;
    }
  // #53: one message per relaxed-depth connectivity probe (mask BFS, no solver
  // run) so the UI can show the probe phase instead of a stalled routing bar.
  | { type: 'probe'; id: string; probeDepthM: number; done: number; total: number }
  // Parallel path only: which rigs are mid-solve, so the client's liveness
  // watch can tell a silent rig from a finished one.
  | { type: 'sailStart'; id: string; sailId: SailId; solveId: number }
  | { type: 'sailDone'; id: string; sailId: SailId; solveId: number }
  | { type: 'result'; id: string; result: PlanResult }
  // #433/#435 spike §12: `stack` is the worker-side stack trace at the real
  // throw site inside planRoute() — populated below, consumed by
  // workerClient.ts's RoutingError so the resulting client-side error names
  // where the failure actually happened, not just where it was reported.
  // `kind` is set when the failure is a lost port message, so the client can
  // type it `messageerror` instead of `worker-fatal`.
  | { type: 'fatal'; id: string | null; message: string; stack?: string; kind?: 'messageerror' };

/**
 * Main thread -> sibling solve worker. The sibling is solve-only: it keeps its
 * own mask copy and polars, takes per-plan contexts and per-rig solve requests
 * over a `MessagePort` shared with the ladder worker, and never runs probes or
 * relaxation.
 */
export interface SolverInitRequest {
  type: 'init-solver';
  maskMeta: MaskMeta;
  maskBuffer: ArrayBuffer;
  polars: Readonly<Record<string, PolarTable>>;
  port: MessagePort;
}

/** Ladder worker -> sibling, over the port. */
export type SolverPortRequest =
  | {
      type: 'ctx';
      ctxId: number;
      planId: string;
      waypoints: readonly LatLon[];
      departureMs: number;
      settings: Settings;
      segmentModes: PlanRequest['segmentModes'];
      sailIds: readonly SailId[];
      boatId: BoatId;
      polarKeys: readonly string[];
      windGrid: WindGrid;
      /** Both rigs measure the budget from this one instant. */
      planStartMs: number;
      budgetMs?: number;
    }
  | {
      type: 'solve';
      stepId: number;
      ctxId: number;
      sailId: SailId;
      gate: DepthGate;
      comfortDepthM: number | undefined;
      secondPass: boolean;
      /** Pass 2's start instant; absent when the plan is unbudgeted. */
      pass2StartMs?: number;
    };

/** Sibling -> ladder worker, over the port. */
export type SolverPortResponse =
  | { type: 'solved'; stepId: number; run: RunOut }
  | { type: 'solve-failed'; stepId: number; message: string; stack?: string };

/** A message on the ladder<->sibling port could not be deserialized. */
export class PortMessageError extends Error {}

function fatalOf(err: unknown, id: string | null): WorkerResponse {
  // exactOptionalPropertyTypes: `stack` must be OMITTED, not set to
  // `undefined`, when the throw carries none.
  const stack = err instanceof Error ? err.stack : undefined;
  return {
    type: 'fatal',
    id,
    message: err instanceof Error ? err.message : String(err),
    ...(stack !== undefined ? { stack } : {}),
    ...(err instanceof PortMessageError ? { kind: 'messageerror' as const } : {}),
  };
}

function safePost(post: (r: WorkerResponse) => void, msg: WorkerResponse): void {
  try {
    post(msg);
  } catch {
    // If even the fatal report can't be serialized/posted, there's nothing
    // more we can do here — the client's worker.onerror/failAll path is
    // the backstop.
  }
}

/** The ladder worker's link to its sibling. */
interface SolverLink {
  port: MessagePort;
  pending: Map<number, { resolve: (r: RunOut) => void; reject: (e: Error) => void }>;
  ctxIds: WeakMap<RigContext, number>;
  nextStepId: number;
  nextCtxId: number;
}

function attachSolver(port: MessagePort): SolverLink {
  const link: SolverLink = {
    port,
    pending: new Map(),
    ctxIds: new WeakMap(),
    nextStepId: 0,
    nextCtxId: 0,
  };
  port.onmessage = (e: MessageEvent<SolverPortResponse>) => {
    const m = e.data;
    const entry = link.pending.get(m.stepId);
    if (!entry) return;
    link.pending.delete(m.stepId);
    if (m.type === 'solved') entry.resolve(m.run);
    else {
      const err = new Error(m.message);
      if (m.stack !== undefined) err.stack = m.stack;
      entry.reject(err);
    }
  };
  port.onmessageerror = () => {
    for (const entry of link.pending.values()) {
      entry.reject(new PortMessageError('solver message could not be deserialized'));
    }
    link.pending.clear();
  };
  return link;
}

/**
 * #1777: one line per finished rig solve. Logged where the solve ran (ladder
 * worker or sibling) so `elapsedMs` is the solve itself, not the wait for the
 * ladder worker to get back to its message queue.
 */
function logSolveFinished(
  planId: string,
  run: RunOut,
  gate: DepthGate,
  secondPass: boolean,
  elapsedMs: number,
): void {
  planLog.info('solve finished', {
    planId,
    sail: run.sailId,
    status: run.rigResult !== null ? 'ok' : 'no-route',
    // Internal SolveFailureCause; null when the rig found a route.
    cause: run.cause,
    gateM: gateFloorM(gate),
    secondPass,
    elapsedMs,
  });
}

/** Odd-indexed rigs run on the sibling; the ladder worker solves the rest itself. */
const runsOnSibling = (index: number): boolean => index % 2 === 1;

interface PlanWire {
  id: string;
  boatId: BoatId;
  polarKeys: readonly string[];
  windGrid: WindGrid;
  planStartMs: number;
  budgetMs: number | undefined;
}

/**
 * One barrier: the sibling's rigs are posted first, the ladder worker then
 * solves its own, and the step resolves once every rig has. Results land in
 * `ctx.sailIds` order whatever order they finish in.
 */
async function runStepOnPool(
  link: SolverLink,
  post: (r: WorkerResponse) => void,
  wire: PlanWire,
  step: RigStep,
): Promise<RunOut[]> {
  const { ctx } = step;
  let ctxId = link.ctxIds.get(ctx);
  if (ctxId === undefined) {
    ctxId = link.nextCtxId++;
    link.ctxIds.set(ctx, ctxId);
    link.port.postMessage({
      type: 'ctx',
      ctxId,
      planId: wire.id,
      waypoints: [...ctx.waypoints],
      departureMs: ctx.departureMs,
      settings: ctx.settings,
      segmentModes: ctx.segmentModes,
      sailIds: [...ctx.sailIds],
      boatId: wire.boatId,
      polarKeys: wire.polarKeys,
      windGrid: wire.windGrid,
      planStartMs: wire.planStartMs,
      ...(wire.budgetMs !== undefined ? { budgetMs: wire.budgetMs } : {}),
    } satisfies SolverPortRequest);
  }
  const solveIds = ctx.sailIds.map(() => link.nextStepId++);
  ctx.sailIds.forEach((sailId, i) =>
    post({ type: 'sailStart', id: wire.id, sailId, solveId: solveIds[i] }),
  );
  const remote = new Map<number, Promise<RunOut>>();
  ctx.sailIds.forEach((sailId, i) => {
    if (!runsOnSibling(i)) return;
    const stepId = solveIds[i];
    const promise = new Promise<RunOut>((resolve, reject) => {
      link.pending.set(stepId, { resolve, reject });
    });
    // Observed by the awaits below; a local throw must not leave this unhandled.
    promise.catch(() => {});
    remote.set(i, promise);
    link.port.postMessage({
      type: 'solve',
      stepId,
      ctxId,
      sailId,
      gate: step.gate,
      comfortDepthM: step.comfortDepthM,
      secondPass: step.pass2 !== null,
      ...(step.pass2?.startMs !== undefined ? { pass2StartMs: step.pass2.startMs } : {}),
    } satisfies SolverPortRequest);
  });
  const out: RunOut[] = [];
  ctx.sailIds.forEach((sailId, i) => {
    if (runsOnSibling(i)) return;
    const solveStartedMs = Date.now();
    out[i] = solveRig(
      ctx,
      sailId,
      ctx.polarFor(sailId),
      step.gate,
      step.comfortDepthM,
      step.pass2 !== null,
      step.deadline,
      (sid, info) =>
        post({
          type: 'progress',
          id: wire.id,
          sailId: sid,
          tMs: info.tMs,
          frontierSize: info.frontierSize,
          ...(info.secondPass ? { secondPass: true } : {}),
        }),
    );
    logSolveFinished(wire.id, out[i], step.gate, step.pass2 !== null, Date.now() - solveStartedMs);
    post({ type: 'sailDone', id: wire.id, sailId, solveId: solveIds[i] });
  });
  for (const [i, promise] of remote) out[i] = await promise;
  return out;
}

export function createHandler(post: (r: WorkerResponse) => void): (req: WorkerRequest) => void {
  let state: {
    mask: NavMask;
    polars: Readonly<Record<string, PolarTable>>;
    knownDisconnectedIds: ReadonlySet<string>;
  } | null = null;
  let solver: SolverLink | null = null;
  // The parallel path awaits between steps, so a second plan must not start
  // inside the first; the sync path never interleaves and never queues.
  let tail: Promise<void> = Promise.resolve();
  return (req) => {
    try {
      if (req.type === 'init') {
        state = {
          mask: new NavMask(req.maskMeta, new Uint8Array(req.maskBuffer)),
          polars: req.polars,
          knownDisconnectedIds: new Set(req.knownDisconnectedHarborIds),
        };
        solver = req.solverPort ? attachSolver(req.solverPort) : null;
        post({ type: 'ready' });
        return;
      }
      if (!state) throw new Error('plan requested before init');
      // #432: ONE deadline object for the whole plan, created here — the
      // worker request handler is the only place in the routing stack with a
      // human actually waiting on the answer, which is why the budget is
      // imposed here rather than defaulted inside planRoute(). Keeping
      // planRoute() pure is what stops a wall-clock bound from deciding the
      // outcome of a vitest run whose speed swings with the runner.
      const budgetMs = req.budgetMs;
      const startedAtMs = Date.now();
      const deadline =
        budgetMs === undefined
          ? undefined
          : { expired: () => Date.now() - startedAtMs >= budgetMs };
      // #54: `polarKeys` selects the subset of init's map this plan may reach.
      // A key init never carried is simply absent here; planRoute() owns the
      // fail-closed throw, so the check lives at ONE boundary rather than two.
      // #601: null-prototype map, never cloned or iterated.
      const polars: Record<string, PolarTable> = Object.create(null);
      for (const key of req.polarKeys) {
        const table: PolarTable | undefined = state.polars[key];
        if (table !== undefined) polars[key] = table;
      }
      const deps: PlanDeps = {
        polars,
        boat: boatById(req.boatId),
        mask: state.mask,
      };
      const onProgress = (
        sailId: SailId,
        info: { tMs: number; frontierSize: number; secondPass?: true },
      ): void =>
        post({
          type: 'progress',
          id: req.id,
          sailId,
          tMs: info.tMs,
          frontierSize: info.frontierSize,
          ...(info.secondPass ? { secondPass: true } : {}),
        });
      const onProbe = (p: { probeDepthM: number; done: number; total: number }): void =>
        post({
          type: 'probe',
          id: req.id,
          probeDepthM: p.probeDepthM,
          done: p.done,
          total: p.total,
        });
      if (solver === null) {
        const result = planWithHarborHandover(
          req.request,
          req.windGrid,
          deps,
          onProgress,
          onProbe,
          deadline,
          state.knownDisconnectedIds,
        );
        // #1777: asymmetry with the pool path. Here planRoute.ts runs every
        // solve internally and exposes no per-solve outcome or timing (and is
        // not to be edited for logging), so one line per sail is derived from
        // the final result instead: no cause, no elapsed.
        if (result.status === 'ok') {
          for (const s of result.sails) {
            planLog.info('solve finished', {
              planId: req.id,
              sail: s.sailId,
              status: s.result !== null ? 'ok' : 'no-route',
              reason: s.reason,
            });
          }
        }
        post({ type: 'result', id: req.id, result });
        return;
      }
      const link = solver;
      const known = state.knownDisconnectedIds;
      const wire: PlanWire = {
        id: req.id,
        boatId: req.boatId,
        polarKeys: req.polarKeys,
        windGrid: req.windGrid,
        planStartMs: startedAtMs,
        budgetMs,
      };
      tail = tail.then(async () => {
        try {
          const result = await planWithHarborHandoverAsync(
            req.request,
            deps,
            deadline,
            known,
            async (r) =>
              (
                await planRouteWithRecordAsync(
                  r,
                  req.windGrid,
                  deps,
                  (step) => runStepOnPool(link, post, wire, step),
                  onProbe,
                  deadline,
                )
              ).result,
          );
          post({ type: 'result', id: req.id, result });
        } catch (err) {
          safePost(post, fatalOf(err, req.id));
        }
      });
    } catch (err) {
      safePost(post, fatalOf(err, req.type === 'plan' ? req.id : null));
    }
  };
}

/**
 * The sibling solve worker's handler. Progress goes straight to the main
 * thread (`post`), results to the ladder worker (over the port).
 */
export function createSolverHandler(
  post: (r: WorkerResponse) => void,
): (req: SolverInitRequest) => void {
  return (init) => {
    const mask = new NavMask(init.maskMeta, new Uint8Array(init.maskBuffer));
    const ctxs = new Map<
      number,
      {
        ctx: RigContext;
        planId: string;
        planStartMs: number;
        budgetMs: number | undefined;
      }
    >();
    const { port } = init;
    port.onmessage = (e: MessageEvent<SolverPortRequest>) => {
      const m = e.data;
      if (m.type === 'ctx') {
        try {
          const polars: Record<string, PolarTable> = Object.create(null);
          for (const key of m.polarKeys) {
            const table: PolarTable | undefined = init.polars[key];
            if (table !== undefined) polars[key] = table;
          }
          // Only the latest plan's contexts are reachable.
          ctxs.clear();
          ctxs.set(m.ctxId, {
            planId: m.planId,
            planStartMs: m.planStartMs,
            budgetMs: m.budgetMs,
            ctx: {
              waypoints: m.waypoints,
              departureMs: m.departureMs,
              settings: m.settings,
              segmentModes: m.segmentModes,
              sailIds: m.sailIds,
              wind: new WindField(m.windGrid, mask.meta),
              mask,
              polarFor: polarLookup(polars, m.boatId),
            },
          });
        } catch (err) {
          safePost(post, fatalOf(err, m.planId));
        }
        return;
      }
      try {
        const c = ctxs.get(m.ctxId);
        if (!c) throw new Error('solve requested for an unknown context');
        const { planStartMs, budgetMs } = c;
        const planDeadline: SolveDeadline | undefined =
          budgetMs === undefined
            ? undefined
            : { expired: () => Date.now() - planStartMs >= budgetMs };
        let deadline = planDeadline;
        if (m.secondPass && planDeadline !== undefined) {
          if (m.pass2StartMs === undefined) throw new Error('pass 2 without a start instant');
          deadline = pass2DeadlineFrom(planDeadline, m.pass2StartMs, Date.now);
        }
        const solveStartedMs = Date.now();
        const run = solveRig(
          c.ctx,
          m.sailId,
          c.ctx.polarFor(m.sailId),
          m.gate,
          m.comfortDepthM,
          m.secondPass,
          deadline,
          (sailId, info) =>
            post({
              type: 'progress',
              id: c.planId,
              sailId,
              tMs: info.tMs,
              frontierSize: info.frontierSize,
              ...(info.secondPass ? { secondPass: true } : {}),
            }),
        );
        logSolveFinished(c.planId, run, m.gate, m.secondPass, Date.now() - solveStartedMs);
        post({ type: 'sailDone', id: c.planId, sailId: m.sailId, solveId: m.stepId });
        port.postMessage({
          type: 'solved',
          stepId: m.stepId,
          run,
        } satisfies SolverPortResponse);
      } catch (err) {
        const stack = err instanceof Error ? err.stack : undefined;
        port.postMessage({
          type: 'solve-failed',
          stepId: m.stepId,
          message: err instanceof Error ? err.message : String(err),
          ...(stack !== undefined ? { stack } : {}),
        } satisfies SolverPortResponse);
      }
    };
    // The lost message's plan is unknown, so fail every pending plan (id null)
    // instead of leaving the ladder worker to time out.
    port.onmessageerror = () =>
      safePost(
        post,
        fatalOf(new PortMessageError('ladder message could not be deserialized'), null),
      );
    post({ type: 'ready' });
  };
}
