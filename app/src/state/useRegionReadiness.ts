// #295: per-plan offline-map readiness for the UI. Readiness itself is
// re-derived from CacheStorage on every check (regionPinning.ts's
// regionReadiness — never cached as a boolean); the in-memory pin activity
// (pinAfterSave.ts) only explains a not-ready state. Every "can't tell"
// branch resolves to a non-ready status (CLAUDE.md's guard-asymmetry rule).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Plan } from '../types';
import {
  canPinRegions,
  pinActivityFor,
  pinRegionsOnControl,
  pinRegionsOnRetry,
  subscribePinActivity,
  type PinActivity,
} from '../services/pinAfterSave';
import {
  regionReadinessAndBytes,
  type RegionReadiness,
  type RegionReadinessAndBytes,
} from '../services/regionPinning';

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
  /** Bytes of the region archives this plan needs; null when unknown or none needed. */
  readonly bytes: number | null;
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

function subscribeController(onChange: () => void): () => void {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw || typeof sw.addEventListener !== 'function') return () => {};
  sw.addEventListener('controllerchange', onChange);
  return () => sw.removeEventListener('controllerchange', onChange);
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const isVisible = () => document.visibilityState === 'visible';

interface CheckResult {
  /** The plan OBJECT checked: a via replan keeps id and createdAtMs but not identity. */
  readonly plan: Plan;
  /** The pin activity the check ran under. */
  readonly activity: PinActivity | undefined;
  readonly readiness: RegionReadiness;
  readonly bytes: number | null;
}

export function useRegionReadiness(plan: Plan): RegionReadinessView {
  const activity = useSyncExternalStore(subscribePinActivity, () => pinActivityFor(plan.id));
  const controlled = useSyncExternalStore(subscribeController, canPinRegions);
  const visible = useSyncExternalStore(subscribeVisibility, isVisible);
  const [result, setResult] = useState<CheckResult | null>(null);

  // Re-check on a new plan object, a pin settling, the SW taking control,
  // and the page becoming visible again (eviction or a cache-version bump
  // while the chip stayed mounted).
  useEffect(() => {
    let cancelled = false;
    void regionReadinessAndBytes(plan)
      .catch((): RegionReadinessAndBytes => ({
        readiness: { state: 'not-ready', reason: 'manifest-unavailable' },
        bytes: null,
      }))
      .then(({ readiness, bytes }) => {
        if (!cancelled) setResult({ plan, activity, readiness, bytes });
      });
    return () => {
      cancelled = true;
    };
  }, [plan, activity, controlled, visible]);

  // A result for another plan object is ambiguous for this one: unchecked.
  const current = result?.plan === plan ? result : null;
  let status: RegionReadinessStatus;
  if (current === null) {
    status = readinessStatus(null, activity);
  } else if (activity === undefined && current.activity !== undefined) {
    // A pin just settled; the stored check predates it. Hold the state it was
    // shown under until the re-check lands, so the status region never
    // announces "not saved" between "saving" and "saved".
    status = readinessStatus(current.readiness, current.activity);
  } else {
    status = readinessStatus(current.readiness, activity);
  }

  // The SW taking control mid-session: pin a plan it could not pin before.
  // Automatic, so Save-Data still suppresses it.
  const wasControlled = useRef(controlled);
  useEffect(() => {
    const was = wasControlled.current;
    wasControlled.current = controlled;
    if (!was && controlled && pinActivityFor(plan.id) === undefined && status !== 'ready') {
      pinRegionsOnControl(plan);
    }
  }, [controlled, plan, status]);

  const retry = useCallback(() => pinRegionsOnRetry(plan), [plan]);
  const bytes =
    current !== null && current.bytes !== null && current.bytes > 0 ? current.bytes : null;
  return { status, canRetry: controlled, retry, bytes };
}
