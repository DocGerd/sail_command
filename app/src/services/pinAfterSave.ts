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
// PATH, not to one module-level singleton shared by every caller — a pin
// failure on one path (e.g. Live reroute) would otherwise permanently
// silence the warning for every OTHER path (via-replan, plans import, the
// main save) for the rest of the page lifetime. Each consumer below gets
// its own createPinAfterSave() instance.
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

/** usePlanFlow's main plan-save path. */
export const pinRegionsAfterSave: PinAfterSave = createPinAfterSave();
/** state/replan.ts's via-replan save path. */
export const pinRegionsAfterReplan: PinAfterSave = createPinAfterSave();
/** state/reroute.ts's Live reroute save path. */
export const pinRegionsAfterReroute: PinAfterSave = createPinAfterSave();
/** state/useDepartureConfirm.ts's two-rig departure-confirm save path. */
export const pinRegionsAfterDepartureConfirm: PinAfterSave = createPinAfterSave();
/** components/SettingsPanel.tsx's plans-import save path. */
export const pinRegionsAfterImport: PinAfterSave = createPinAfterSave();
