// #1164 T6: fire-and-forget region pinning after a successful plan save.
// Pinning must never block, delay or fail the save, and has no UI this
// release (maintainer ruling on #1164). It lives here, not in usePlanFlow.ts,
// so that file keeps its zero-console.* property (CLAUDE.md).
//
// SW gate (orchestrator decision on PR #1231 r4009825924, consistent with the
// maintainer ruling that an uncontrolled page downloads no full archive): pin
// only while a service worker controls the page, the same condition under
// which MapView.tsx enables regions. Otherwise return with no network request.
import type { Plan } from '../types';
import { pinRegionsForPlan } from './regionPinning';

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

/** The app's single instance, used by usePlanFlow. */
export const pinRegionsAfterSave: PinAfterSave = createPinAfterSave();
