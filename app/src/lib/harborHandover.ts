import type { LatLon, Plan, PlanResultOk } from '../types';
import { haversineNm } from './geo';

// #1721: a plan routed from/to a handover point in grid-connected water because
// the depth grid cannot connect the harbour itself. The flag rides on the
// result as an optional key outside `types.ts` (which sits in the #282 sweep
// closure); this module is its only writer and only reader. Geometry is never
// stored: the harbour end is `plan.request.<end>`, the handover end is
// `plan.result.snapped<End>`.

export type HarborHandoverEnds = { readonly origin?: true; readonly destination?: true };
export type PlanResultWithHandover = PlanResultOk & {
  readonly harborHandovers?: HarborHandoverEnds;
};

export type HarborHandoverEnd = 'origin' | 'destination';

export interface HarborHandoverLine {
  readonly end: HarborHandoverEnd;
  readonly harbour: LatLon;
  readonly handover: LatLon;
  readonly distNm: number;
}

/** Twin of `NavMask.snapToNavigable`'s default `maxRadiusM`; pinned by a test. */
export const SNAP_RADIUS_M = 300;

/** Twin of `state/replan.ts`'s `DEDUPE_THRESHOLD_NM` (not imported: that module pulls in React). */
export const VIA_HANDOVER_CLEARANCE_NM = 60 / 1852;

/** DOM class of the results-panel notice; the e2e specs and `app.css` depend on it. */
export const HARBOR_HANDOVER_NOTICE_CLASS = 'harbor-handover-notice';

const M_PER_NM = 1852;
const END_KEYS = ['origin', 'destination'] as const;

export function withHarborHandover(
  r: PlanResultOk,
  ends: HarborHandoverEnds,
): PlanResultWithHandover {
  const flags: { origin?: true; destination?: true } = {};
  if (ends.origin === true) flags.origin = true;
  if (ends.destination === true) flags.destination = true;
  if (flags.origin === undefined && flags.destination === undefined) return r;
  return { ...r, harborHandovers: flags };
}

/**
 * Read boundary for a stored value. `null`: absent. `'malformed'`: present but
 * not exactly a non-empty subset of {origin, destination} with `true` values;
 * the caller must treat the record as unreadable.
 */
export function parseHarborHandovers(raw: unknown): HarborHandoverEnds | null | 'malformed' {
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'malformed';
  const keys = Reflect.ownKeys(raw);
  if (keys.length === 0) return 'malformed';
  const out: { origin?: true; destination?: true } = {};
  for (const key of keys) {
    if (key !== 'origin' && key !== 'destination') return 'malformed';
    if (!Object.hasOwn(raw, key) || (raw as Record<string, unknown>)[key] !== true) {
      return 'malformed';
    }
    out[key] = true;
  }
  return out;
}

function storedEnds(r: PlanResultOk): HarborHandoverEnds | null {
  if (!Object.hasOwn(r, 'harborHandovers')) return null;
  const parsed = parseHarborHandovers((r as PlanResultWithHandover).harborHandovers);
  return parsed === 'malformed' ? null : parsed;
}

function snappedOf(r: PlanResultOk, end: HarborHandoverEnd): LatLon {
  return end === 'origin' ? r.snappedOrigin : r.snappedDestination;
}

function gapM(plan: Plan, end: HarborHandoverEnd): number {
  return haversineNm(plan.request[end], snappedOf(plan.result, end)) * M_PER_NM;
}

/**
 * Ends with a handover: the stored flag, plus any end whose snap lies beyond
 * what `snapToNavigable` can produce (a plan whose flag was stripped by an
 * older build still discloses). `null` when neither end is one.
 */
export function harborHandoverEndsOf(plan: Plan): HarborHandoverEnds | null {
  const stored = storedEnds(plan.result);
  const out: { origin?: true; destination?: true } = {};
  for (const end of END_KEYS) {
    if (stored?.[end] === true || gapM(plan, end) > SNAP_RADIUS_M + 1) out[end] = true;
  }
  return out.origin === undefined && out.destination === undefined ? null : out;
}

export function harborHandoverLines(plan: Plan): HarborHandoverLine[] {
  const ends = harborHandoverEndsOf(plan);
  if (ends === null) return [];
  const lines: HarborHandoverLine[] = [];
  for (const end of END_KEYS) {
    if (ends[end] !== true) continue;
    const harbour = plan.request[end];
    const handover = snappedOf(plan.result, end);
    lines.push({ end, harbour, handover, distNm: haversineNm(harbour, handover) });
  }
  return lines;
}
