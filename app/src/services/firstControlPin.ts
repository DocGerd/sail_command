// #1518 (#1483/#1253 item 2 residual): pinAllSavedPlansOnce() used to run
// only inside useRegionReadiness's transition effect, which mounts only
// while a region-readiness chip is on screen (RouteSummary, `tab ===
// 'routes' && plan && rig`). On any other tab at the moment of first
// control the batch pin never ran that session. Module-scope arming from
// main.tsx (armBatchPinOnFirstControl, called beside initSwRecovery) fixes
// that: it listens for the FIRST controllerchange regardless of what is
// mounted.
import type { Plan } from '../types';
import { regionCacheName } from '../lib/basemapRegions';
import { safeGetItem, safeSetItem } from '../lib/storage';
import { getPlan, listPlans } from './db';
import { canPinRegions, pinImportedPlans, saveDataRequested } from './pinAfterSave';
import { pinRegionsForPlan, type PinRegionsOutcome } from './regionPinning';

// #1533: keyed by the region cache name (deployment slug + cache version), so
// /uat/ and prod do not share the flag and a REGION_CACHE_VERSION bump re-runs it.
export const BACKFILL_DONE_KEY = `sc-region-pin-backfill@${regionCacheName(import.meta.env.BASE_URL)}`;

let batchPinnedThisSession = false;

/** Test-only: forget the once-per-session batch-pin flag. */
export function __resetFirstControlPinForTests(): void {
  batchPinnedThisSession = false;
}

const fullyPinned = (o: PinRegionsOutcome): boolean =>
  o.status === 'plan-gone' || (o.status === 'pinned' && o.pinned === o.total);

/** Resolves true only when the batch ran and every plan was fully pinned. */
async function pinBatch(plans: readonly Plan[]): Promise<boolean> {
  const mayPin = canPinRegions() && !saveDataRequested();
  const verdicts = new Map<string, boolean>();
  const allSettled = new Promise<void>((resolve) => {
    if (plans.length === 0 || !mayPin) resolve();
    const record = (id: string, ok: boolean) => {
      verdicts.set(id, ok);
      if (verdicts.size === plans.length) resolve();
    };
    pinImportedPlans(plans, (plan) => {
      const outcome = pinRegionsForPlan(plan);
      outcome.then(
        (o) => record(plan.id, fullyPinned(o)),
        () => record(plan.id, false),
      );
      return outcome;
    });
  });
  await allSettled;
  return mayPin && [...verdicts.values()].every(Boolean);
}

export async function pinAllSavedPlansOnce(): Promise<void> {
  if (batchPinnedThisSession) return;
  batchPinnedThisSession = true;
  let complete = true;
  const summaries = await listPlans().catch(() => null);
  if (summaries === null) return;
  const plans: Plan[] = [];
  for (const s of summaries) {
    if (s.kind !== 'ok') continue; // migratePlan already refused this row; nothing to pin.
    try {
      const p = await getPlan(s.id);
      if (p !== undefined) plans.push(p);
    } catch {
      complete = false;
    }
  }
  if ((await pinBatch(plans)) && complete) safeSetItem(BACKFILL_DONE_KEY, '1');
}

let armed = false;

/**
 * Arms the one-shot batch pin (main.tsx, beside initSwRecovery — before
 * React renders). A page already controlled at arm time has no first-control
 * event left to observe, so it runs the batch at once unless the persisted
 * backfill flag (#1533) says an earlier session completed it.
 */
export function armBatchPinOnFirstControl(): void {
  if (armed) return;
  armed = true;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (navigator.serviceWorker.controller) {
    if (safeGetItem(BACKFILL_DONE_KEY) !== '1') void pinAllSavedPlansOnce();
    return;
  }

  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      void pinAllSavedPlansOnce();
    },
    { once: true },
  );
}
