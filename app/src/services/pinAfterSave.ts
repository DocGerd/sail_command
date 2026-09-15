// #1164 T6: fire-and-forget region pinning after a successful plan save.
// Pinning must never block, delay or fail the save, and has no UI this
// release (maintainer ruling on #1164). It lives here, not in usePlanFlow.ts,
// so that file keeps its zero-console.* property (CLAUDE.md).
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
// SCOPE (offline/PWA review Minor, PR #1242): `warned` fires only on an
// UNEXPECTED REJECTION (a thrown error, e.g. a malformed plan shape) — never
// on a RESOLVED failure. `pinRegionsForPlan` catches every archive/manifest/
// IndexedDB failure internally and RESOLVES with a named status
// ('manifest-unavailable', 'pin-record-failed', 'plan-gone', or `pinned <
// total`); this factory ignores that resolved value entirely (see the
// `.then(() => pin(plan))` below), so offline, a 404, a short body and a
// quota error all stay silent today, by the existing no-UI-this-release
// ruling — not by an oversight this scoping fix introduces or corrects.
import type { Plan } from '../types';
import { pinRegionsForPlan, type PinRegionsOutcome } from './regionPinning';

export type PinAfterSave = (plan: Plan) => void;

function serviceWorkerControlsPage(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    navigator.serviceWorker.controller != null
  );
}

/** Builds a pin-after-save hook that warns at most once per instance. */
export function createPinAfterSave(
  pin: (plan: Plan) => Promise<unknown> = pinRegionsForPlan,
): PinAfterSave {
  let warned = false;
  return (plan) => {
    if (!serviceWorkerControlsPage()) return;
    // Promise.resolve().then: a synchronous throw from `pin` becomes a rejection too.
    Promise.resolve()
      .then(() => pin(plan))
      .catch((err: unknown) => {
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

/**
 * #1233 Major 2 (offline/PWA review): components/SettingsPanel.tsx's
 * plans-import save path — deliberately NOT a createPinAfterSave() instance
 * like the four above. An import can touch many plans in one call, and
 * `regionPinning.ts`'s pinOneRegion coalesces concurrent fetches of the SAME
 * archive URL, so calling `pinRegionsForPlan` directly here (rather than
 * once per plan through an opaque PinAfterSave) is what lets that dedup
 * apply, AND lets failures be reported as ONE aggregated warning for the
 * whole import instead of either N separate warn-once instances or total
 * silence. Still gated on the page being SW-controlled (checked ONCE for
 * the whole batch — the same "an uncontrolled page downloads nothing" rule
 * every other pin call site follows) and still fire-and-forget: never
 * awaited by the caller, so an import's own success notice is never delayed
 * by archive downloads.
 */
export function pinImportedPlans(
  plans: readonly Plan[],
  pin: (plan: Plan) => Promise<PinRegionsOutcome> = pinRegionsForPlan,
): void {
  if (plans.length === 0 || !serviceWorkerControlsPage()) return;
  void (async () => {
    // Promise.resolve().then per plan (mirrors createPinAfterSave's own
    // technique): a synchronous throw from `pin` becomes a rejection
    // Promise.allSettled can catch, rather than an unhandled exception
    // thrown while building the array below.
    const outcomes = await Promise.allSettled(
      plans.map((p) => Promise.resolve().then(() => pin(p))),
    );
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
