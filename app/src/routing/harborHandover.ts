import type { LatLon, PlanRequest, PlanResult, WindGrid } from '../types';
import type { ProbeProgress } from './relaxedDepth';
import { planRoute, type PlanDeadline, type PlanDeps, type RigProgress } from './planRoute';
import { haversineNm } from '../lib/geo';
import { findHarborHandoverFor, harborEndpointPocketed } from '../lib/harborReachability';
import {
  VIA_HANDOVER_CLEARANCE_NM,
  withHarborHandover,
  type HarborHandoverEnds,
} from '../lib/harborHandover';

export type PlanFn = typeof planRoute;

export type HandoverPlans = Generator<PlanRequest, PlanResult, PlanResult>;

/**
 * The handover decision as one generator: it yields each request to plan and
 * receives its result, so the sync and async wrappers share the logic.
 */
function* handoverPlans(
  req: PlanRequest,
  deps: PlanDeps,
  deadline: PlanDeadline | undefined,
  knownDisconnectedIds: ReadonlySet<string>,
): HandoverPlans {
  const r1 = yield req;
  if (r1.status !== 'error') return r1;
  if (deadline?.expired()) return r1;

  const gateM = req.settings.safetyDepthM;
  const ends: { origin?: LatLon; destination?: LatLon } = {};
  for (const end of ['origin', 'destination'] as const) {
    const id = end === 'origin' ? req.originHarborId : req.destinationHarborId;
    if (id === null || knownDisconnectedIds.has(id)) continue;
    const p = req[end];
    if (!harborEndpointPocketed(deps.mask, p, deps.boat, gateM)) continue;
    const toward =
      end === 'origin'
        ? (req.viaPoints[0] ?? req.destination)
        : (req.viaPoints[req.viaPoints.length - 1] ?? req.origin);
    const h = findHarborHandoverFor(deps.mask, p, deps.boat, gateM, toward);
    if (h === null) return r1;
    ends[end] = h;
  }
  if (ends.origin !== undefined && ends.destination !== undefined && req.viaPoints.length === 0) {
    const { origin, destination } = ends;
    ends.origin =
      findHarborHandoverFor(deps.mask, req.origin, deps.boat, gateM, destination) ?? origin;
    ends.destination =
      findHarborHandoverFor(deps.mask, req.destination, deps.boat, gateM, origin) ?? destination;
  }
  const handovers = [ends.origin, ends.destination].filter((h): h is LatLon => h !== undefined);
  if (handovers.length === 0) return r1;
  if (
    req.viaPoints.some((v) => handovers.some((h) => haversineNm(v, h) < VIA_HANDOVER_CLEARANCE_NM))
  ) {
    return r1;
  }

  const r2 = yield {
    ...req,
    origin: ends.origin ?? req.origin,
    destination: ends.destination ?? req.destination,
  };
  if (r2.status === 'ok') {
    const flags: { origin?: true; destination?: true } = {};
    if (ends.origin !== undefined) flags.origin = true;
    if (ends.destination !== undefined) flags.destination = true;
    return withHarborHandover(r2, flags satisfies HarborHandoverEnds);
  }
  return deadline?.expired() ? r2 : r1;
}

/**
 * #1721: plans as `planRoute` does; only when that fails for a harbour pick the
 * grid cannot connect at the requested gate does it re-plan from/to the
 * handover point on the side leading by water to the adjacent route point and
 * flag the substituted ends.
 * Gates on status and harbour state only, never on the failure reason (#282).
 */
export function planWithHarborHandover(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress: RigProgress | undefined,
  onProbe: ProbeProgress | undefined,
  deadline: PlanDeadline | undefined,
  knownDisconnectedIds: ReadonlySet<string>,
  plan: PlanFn = planRoute,
): PlanResult {
  const g = handoverPlans(req, deps, deadline, knownDisconnectedIds);
  let next = g.next();
  while (!next.done) {
    next = g.next(plan(next.value, windGrid, deps, onProgress, onProbe, deadline));
  }
  return next.value;
}

/** As `planWithHarborHandover`, planning each request through `plan`. */
export async function planWithHarborHandoverAsync(
  req: PlanRequest,
  deps: PlanDeps,
  deadline: PlanDeadline | undefined,
  knownDisconnectedIds: ReadonlySet<string>,
  plan: (req: PlanRequest) => Promise<PlanResult>,
): Promise<PlanResult> {
  const g = handoverPlans(req, deps, deadline, knownDisconnectedIds);
  let next = g.next();
  while (!next.done) next = g.next(await plan(next.value));
  return next.value;
}
