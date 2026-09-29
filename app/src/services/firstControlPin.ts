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
import { safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';
import { getPlan, listPlans } from './db';
import { canPinRegions, pinImportedPlans, pinOutcomeDone, saveDataRequested } from './pinAfterSave';
import { pinRegionsForPlan } from './regionPinning';

// #1533: the flag means the batch once fully succeeded, not that the regions
// are present now. Keys
// are scoped by the region cache name (deployment slug + cache version), so
// /uat/ and prod do not share them and a REGION_CACHE_VERSION bump re-runs it.
const KEY_SUFFIX = `@${regionCacheName(import.meta.env.BASE_URL)}`;
export const BACKFILL_DONE_KEY = `sc-region-pin-backfill${KEY_SUFFIX}`;
export const BACKFILL_FAILURES_KEY = `sc-region-pin-backfill-failures${KEY_SUFFIX}`;
/** Failed attempts after which the startup backfill stops; the chip's retry still works. */
export const BACKFILL_MAX_FAILURES = 3;

let batchPinnedThisSession = false;

/** Test-only: forget the once-per-session batch-pin flag. */
export function __resetFirstControlPinForTests(): void {
  batchPinnedThisSession = false;
}

const failedAttempts = (): number => Number(safeGetItem(BACKFILL_FAILURES_KEY) ?? 0);

/** Resolves true only when every plan was fully pinned. */
async function pinBatch(plans: readonly Plan[]): Promise<boolean> {
  if (plans.length === 0) return true;
  const verdicts = new Map<string, boolean>();
  await new Promise<void>((resolve) => {
    const record = (id: string, ok: boolean) => {
      verdicts.set(id, ok);
      if (verdicts.size === plans.length) resolve();
    };
    pinImportedPlans(plans, (plan) => {
      const outcome = pinRegionsForPlan(plan);
      outcome.then(
        (o) => record(plan.id, pinOutcomeDone(o)),
        () => record(plan.id, false),
      );
      return outcome;
    });
  });
  return [...verdicts.values()].every(Boolean);
}

async function pinAllSaved(): Promise<boolean> {
  const summaries = await listPlans().catch(() => null);
  if (summaries === null) return false;
  let complete = true;
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
  return (await pinBatch(plans)) && complete;
}

export async function pinAllSavedPlansOnce(): Promise<void> {
  if (batchPinnedThisSession) return;
  if (!canPinRegions() || saveDataRequested() || navigator.onLine === false) return;
  batchPinnedThisSession = true;
  if (await pinAllSaved()) {
    safeSetItem(BACKFILL_DONE_KEY, '1');
    safeRemoveItem(BACKFILL_FAILURES_KEY);
  } else {
    safeSetItem(BACKFILL_FAILURES_KEY, String(failedAttempts() + 1));
  }
}

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => resolve(), { timeout: 5_000 });
    } else {
      setTimeout(resolve, 1_000);
    }
  });
}

let armed = false;

/**
 * Arms the one-shot batch pin (main.tsx, beside initSwRecovery — before
 * React renders). A page already controlled at arm time has no first-control
 * event left to observe, so it runs the batch at idle unless the persisted
 * flag says an earlier session completed it or failed attempts hit the cap (#1533).
 */
export function armBatchPinOnFirstControl(): void {
  if (armed) return;
  armed = true;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (navigator.serviceWorker.controller) {
    // `<` is false for a corrupt (NaN) count, so a bad value stops the backfill.
    if (safeGetItem(BACKFILL_DONE_KEY) !== '1' && failedAttempts() < BACKFILL_MAX_FAILURES) {
      void whenIdle().then(pinAllSavedPlansOnce);
    }
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
