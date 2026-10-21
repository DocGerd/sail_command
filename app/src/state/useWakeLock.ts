import { useEffect, useState } from 'react';

export interface WakeLockState {
  /** The Screen Wake Lock API exists in this browser. */
  supported: boolean;
  /** A sentinel is currently held; follows the sentinel's `release` event. */
  held: boolean;
  /** Diagnostic text of the last `request()` rejection (English, not for display); cleared by a later success or when no longer wanted. */
  error: string | null;
}

/**
 * Holds a screen wake lock while `wanted` (the caller combines tracking and
 * the user's toggle). The browser drops the lock when the page is hidden, so
 * it is re-requested on the next `visibilitychange` to visible; a failed
 * request is not retried until then.
 */
export function useWakeLock(wanted: boolean): WakeLockState {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [held, setHeld] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted || !supported) return;
    // Set here, not only cleared in cleanup: StrictMode runs cleanup then setup on the same component.
    let active = true;
    let sentinel: WakeLockSentinel | null = null;
    let pending = false;

    const acquire = async () => {
      if (sentinel !== null || pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (!active) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
          if (active) setHeld(false);
        });
        setHeld(true);
        setError(null);
      } catch (e) {
        if (active) {
          setHeld(false);
          setError(String(e));
        }
      } finally {
        pending = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void acquire();

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinel;
      sentinel = null;
      // Nothing to act on if the release itself fails: the lock is gone with the page anyway.
      if (s !== null) void s.release().catch(() => {});
      setHeld(false);
      setError(null);
    };
  }, [wanted, supported]);

  return { supported, held, error };
}
