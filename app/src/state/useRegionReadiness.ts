// #295: per-plan offline-map readiness for the UI. Readiness itself is
// re-derived from CacheStorage on every check (regionPinning.ts's
// regionReadiness — never cached as a boolean); the in-memory pin activity
// (pinAfterSave.ts) only explains a not-ready state. Every "can't tell"
// branch resolves to a non-ready status (CLAUDE.md's guard-asymmetry rule).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Plan } from '../types';
import {
  canPinRegions,
  pinActivityFor,
  pinRegionsOnRetry,
  subscribePinActivity,
  type PinActivity,
} from '../services/pinAfterSave';
import { regionReadiness, type RegionReadiness } from '../services/regionPinning';

export type RegionReadinessStatus =
  /** Not yet checked for this plan — shown as not ready. */
  | 'checking'
  /** Every required region archive is verified present (or none is required). */
  | 'ready'
  /** Not ready; a pin attempt for this plan is in flight in this session. */
  | 'pinning'
  /** Not ready; this session's latest pin attempt did not verify every archive. */
  | 'failed'
  /** Not ready, with no in-session explanation (never pinned, retired cache, no manifest). */
  | 'not-ready';

export interface RegionReadinessView {
  readonly status: RegionReadinessStatus;
  /** Whether a retry could run at all (a service worker controls the page). */
  readonly canRetry: boolean;
  /** Starts a pin attempt for this plan; a no-op without a controlling service worker. */
  readonly retry: () => void;
}

/** Pure mapping, exported for tests: readiness wins; activity explains not-ready. */
export function readinessStatus(
  readiness: RegionReadiness | null,
  activity: PinActivity | undefined,
): RegionReadinessStatus {
  if (readiness?.state === 'ready') return 'ready';
  if (activity === 'pinning') return 'pinning';
  if (activity === 'failed') return 'failed';
  return readiness === null ? 'checking' : 'not-ready';
}

export function useRegionReadiness(plan: Plan): RegionReadinessView {
  const planKey = `${plan.id}-${plan.createdAtMs}`;
  const activity = useSyncExternalStore(subscribePinActivity, () => pinActivityFor(plan.id));
  const [result, setResult] = useState<{ key: string; readiness: RegionReadiness } | null>(null);

  // Re-check on a plan change and whenever this plan's pin activity settles.
  useEffect(() => {
    let cancelled = false;
    void regionReadiness(plan)
      .catch((): RegionReadiness => ({ state: 'not-ready', reason: 'manifest-unavailable' }))
      .then((readiness) => {
        if (!cancelled) setResult({ key: planKey, readiness });
      });
    return () => {
      cancelled = true;
    };
    // `plan` is keyed by planKey; activity drives the re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, activity]);

  // A result for a previous plan is ambiguous for this one: treat as unchecked.
  const readiness = result?.key === planKey ? result.readiness : null;
  const retry = useCallback(() => pinRegionsOnRetry(plan), [plan]);
  return { status: readinessStatus(readiness, activity), canRetry: canPinRegions(), retry };
}
