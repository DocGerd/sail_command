// #1164 T6: fire-and-forget region pinning after a successful plan save.
// Pinning must never block, delay or fail the save. It lives here, not in
// usePlanFlow.ts, so that file keeps its zero-console.* property (CLAUDE.md).
//
// SW gate (orchestrator decision on PR #1231 r4009825924, consistent with the
// maintainer ruling that an uncontrolled page downloads no full archive): pin
// only while a service worker controls the page, the same condition under
// which MapView.tsx enables regions. Otherwise return with no network request.
//
// #1233 (PR #1231 review r4009769671): `warned` must be scoped PER SAVE
// PATH, not to one module-level singleton shared by every caller — an
// UNEXPECTED REJECTION on one path (e.g. Live reroute) would otherwise
// permanently silence a later rejection on every OTHER path (via-replan,
// plans import, the main save) for the rest of the page lifetime. Each
// consumer below gets its own createPinAfterSave() instance.
//
// Save-Data (maintainer ruling on #295, 2026-09-15): automatic pins skip
// while `navigator.connection.saveData` is true; only the chip's explicit
// save button (pinRegionsOnRetry) downloads then.
//
// `warned` fires only on an UNEXPECTED REJECTION. A RESOLVED failure
// (`pinRegionsForPlan`'s named statuses, or `pinned < total`) is surfaced in
// the UI instead (#295): every attempt is recorded in the per-plan pin
// ACTIVITY store below, which useRegionReadiness reads.
import type { Plan } from '../types';
import { pinRegionsForPlan, type PinRegionsOutcome } from './regionPinning';

export type PinAfterSave = (plan: Plan) => void;

/**
 * What THIS page session knows about a plan's most recent pin attempt.
 * In-memory only: it never claims readiness (regionReadiness re-derives that
 * from CacheStorage), it only explains a not-ready state — an attempt still
 * in flight, or one that settled without verifying every archive.
 */
export type PinActivity = 'pinning' | 'failed';

const activity = new Map<string, PinActivity>();
const listeners = new Set<() => void>();
const latestAttempt = new Map<string, number>();

function setActivity(planId: string, next: PinActivity | undefined): void {
  if (next === undefined) activity.delete(planId);
  else activity.set(planId, next);
  for (const l of listeners) l();
}

/** The latest pin activity for `planId`, or undefined (none, or a full pin). */
export function pinActivityFor(planId: string): PinActivity | undefined {
  return activity.get(planId);
}

/** Subscribes to pin-activity changes for any plan. Returns the unsubscribe. */
export function subscribePinActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget all recorded activity. */
export function __resetPinActivityForTests(): void {
  activity.clear();
  latestAttempt.clear();
}

/**
 * Classifies a settled pin. Only a full pin clears the record, and only a
 * deleted plan ('plan-gone') forgets it; every other value, including one
 * that is not a PinRegionsOutcome at all, reads as failed (fail toward
 * not-ready, CLAUDE.md's guard-asymmetry rule).
 */
function activityAfter(outcome: unknown): PinActivity | undefined {
  if (typeof outcome === 'object' && outcome !== null && 'status' in outcome) {
    const o = outcome as PinRegionsOutcome;
    if (o.status === 'plan-gone') return undefined;
    if (o.status === 'pinned' && o.pinned === o.total) return undefined;
  }
  return 'failed';
}

/** Runs `pin(plan)` and records its activity. Resolves with the outcome, rejects like `pin`. */
function trackedPin<T>(plan: Plan, pin: (plan: Plan) => Promise<T>): Promise<T> {
  // Only the LATEST attempt per plan may settle the record, so an older
  // attempt finishing late cannot overwrite a newer one still in flight.
  const attempt = (latestAttempt.get(plan.id) ?? 0) + 1;
  latestAttempt.set(plan.id, attempt);
  const settle = (next: PinActivity | undefined) => {
    if (latestAttempt.get(plan.id) === attempt) setActivity(plan.id, next);
  };
  setActivity(plan.id, 'pinning');
  // Promise.resolve().then: a synchronous throw from `pin` becomes a rejection too.
  return Promise.resolve()
    .then(() => pin(plan))
    .then(
      (outcome) => {
        settle(activityAfter(outcome));
        return outcome;
      },
      (err: unknown) => {
        settle('failed');
        throw err;
      },
    );
}

function serviceWorkerControlsPage(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    navigator.serviceWorker.controller != null
  );
}

/** True when a pin attempt could run at all (the SW gate above). */
export function canPinRegions(): boolean {
  return serviceWorkerControlsPage();
}

/** The browser's data-saver request; absent API reads as not requested. */
export function saveDataRequested(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: unknown } }).connection;
  return connection?.saveData === true;
}

/**
 * Builds a pin-after-save hook that warns at most once per instance.
 * `automatic` instances skip under Save-Data; a user-initiated one does not.
 */
export function createPinAfterSave(
  pin: (plan: Plan) => Promise<unknown> = pinRegionsForPlan,
  { automatic = true }: { automatic?: boolean } = {},
): PinAfterSave {
  let warned = false;
  return (plan) => {
    if (!serviceWorkerControlsPage()) return;
    if (automatic && saveDataRequested()) return;
    // The pin call is deferred past the save (first microtask inside trackedPin).
    trackedPin(plan, pin).catch((err: unknown) => {
      if (warned) return;
      warned = true;
      console.warn('[#1164] basemap region pinning failed after plan save', err);
    });
  };
}

/** usePlanFlow's main plan-save path. */
export const pinRegionsAfterSave: PinAfterSave = createPinAfterSave();
/** state/replan.ts's via-replan save path. */
export const pinRegionsAfterReplan: PinAfterSave = createPinAfterSave();
/** state/reroute.ts's Live reroute save path. */
export const pinRegionsAfterReroute: PinAfterSave = createPinAfterSave();
/** state/useDepartureConfirm.ts's two-rig departure-confirm save path. */
export const pinRegionsAfterDepartureConfirm: PinAfterSave = createPinAfterSave();
/** #295: the readiness chip's user-initiated save button — ignores Save-Data. */
export const pinRegionsOnRetry: PinAfterSave = createPinAfterSave(pinRegionsForPlan, {
  automatic: false,
});
/** #295: a plan shown while the service worker first takes control (useRegionReadiness). */
export const pinRegionsOnControl: PinAfterSave = createPinAfterSave();

/**
 * #1233 Major 2 (offline/PWA review): components/SettingsPanel.tsx's
 * plans-import save path — deliberately NOT a createPinAfterSave() instance
 * like the six above. An import can touch many plans in one call, and
 * `regionPinning.ts`'s pinOneRegion coalesces concurrent fetches of the SAME
 * archive URL, so calling `pinRegionsForPlan` directly here (rather than
 * once per plan through an opaque PinAfterSave) is what lets that dedup
 * apply, AND lets failures be reported as ONE aggregated warning for the
 * whole import instead of either N separate warn-once instances or total
 * silence. Still gated on the page being SW-controlled and on Save-Data
 * being off (both checked ONCE for the whole batch, the same rules every
 * automatic pin call site follows) and still fire-and-forget: never
 * awaited by the caller, so an import's own success notice is never delayed
 * by archive downloads.
 */
export function pinImportedPlans(
  plans: readonly Plan[],
  pin: (plan: Plan) => Promise<PinRegionsOutcome> = pinRegionsForPlan,
): void {
  if (plans.length === 0 || !serviceWorkerControlsPage() || saveDataRequested()) return;
  void (async () => {
    const outcomes = await Promise.allSettled(plans.map((p) => trackedPin(p, pin)));
    const failed = outcomes.filter(
      (o) =>
        o.status === 'rejected' ||
        (o.status === 'fulfilled' &&
          (o.value.status !== 'pinned' || o.value.pinned < o.value.total)),
    ).length;
    if (failed > 0) {
      console.warn(
        `[#1233] basemap region pinning failed for ${failed}/${plans.length} imported plan(s)`,
      );
    }
  })();
}
