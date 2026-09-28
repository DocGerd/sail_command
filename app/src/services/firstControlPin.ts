// #1518 (#1483/#1253 item 2 residual): pinAllSavedPlansOnce() used to run
// only inside useRegionReadiness's transition effect, which mounts only
// while a region-readiness chip is on screen (RouteSummary, `tab ===
// 'routes' && plan && rig`). On any other tab at the moment of first
// control the batch pin never ran that session. Module-scope arming from
// main.tsx (armBatchPinOnFirstControl, called beside initSwRecovery) fixes
// that: it listens for the FIRST controllerchange regardless of what is
// mounted.
import type { Plan } from '../types';
import { getPlan, listPlans } from './db';
import { pinImportedPlans } from './pinAfterSave';

let batchPinnedThisSession = false;

/** Test-only: forget the once-per-session batch-pin flag. */
export function __resetFirstControlPinForTests(): void {
  batchPinnedThisSession = false;
}

export async function pinAllSavedPlansOnce(): Promise<void> {
  if (batchPinnedThisSession) return;
  batchPinnedThisSession = true;
  const summaries = await listPlans().catch(() => []);
  const plans: Plan[] = [];
  for (const s of summaries) {
    if (s.kind !== 'ok') continue; // migratePlan already refused this row; nothing to pin.
    const p = await getPlan(s.id).catch(() => undefined);
    if (p !== undefined) plans.push(p);
  }
  pinImportedPlans(plans);
}

let armed = false;

/**
 * Arms the one-shot batch pin (main.tsx, beside initSwRecovery — before
 * React renders). Never fires if the page is already controlled at arm
 * time: the SW-control transition already happened before this ran, so
 * there is no first-control event left to observe for this session.
 */
export function armBatchPinOnFirstControl(): void {
  if (armed) return;
  armed = true;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (navigator.serviceWorker.controller) return;

  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      void pinAllSavedPlansOnce();
    },
    { once: true },
  );
}
