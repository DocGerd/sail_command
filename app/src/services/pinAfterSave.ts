// #1164 T6: fire-and-forget region pinning after a successful plan save.
// Pinning must never block, delay or fail the save, and has no UI this
// release (maintainer ruling on #1164). It lives here, not in usePlanFlow.ts,
// so that file keeps its zero-console.* property (CLAUDE.md).
import type { Plan } from '../types';
import { pinRegionsForPlan } from './regionPinning';

export type PinAfterSave = (plan: Plan) => void;

/** Builds a pin-after-save hook that warns at most once per instance. */
export function createPinAfterSave(
  pin: (plan: Plan) => Promise<unknown> = pinRegionsForPlan,
): PinAfterSave {
  let warned = false;
  return (plan) => {
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
