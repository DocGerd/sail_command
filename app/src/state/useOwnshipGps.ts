import { useEffect, useState } from 'react';
import { claimGpsHintOnce } from '../lib/gpsHint';
import { watchPosition as realWatchPosition, type GpsFix } from '../services/geolocation';

export interface UseOwnshipGpsResult {
  fix: GpsFix | null;
  hintVisible: boolean;
  dismissHint: () => void;
}

/**
 * #25 addendum: GPS subscription backing the standalone "show my position"
 * marker, decoupled from Live View's own tracking. Subscribes to
 * watchPosition only while `enabled` (the Settings.showOwnship toggle) is
 * true, in ANY map context — planning, no plan, or Live View — mirroring
 * LiveView.tsx's own local-state pattern (1 Hz fixes must not re-render the
 * whole app via AppState; see AppState.tsx's docstring). A denied/unavailable
 * error claims the SAME one-time hint LiveView uses (lib/gpsHint.ts): shown
 * at most once, ever, regardless of which of the two GPS consumers hits it
 * first.
 *
 * `watchPosition` is injectable (default the real geolocation.ts wrapper),
 * mirroring LiveViewProps — lets tests drive fixes/errors without a real
 * navigator.geolocation.
 */
export function useOwnshipGps(
  enabled: boolean,
  watchPosition: typeof realWatchPosition = realWatchPosition,
): UseOwnshipGpsResult {
  const [rawFix, setRawFix] = useState<GpsFix | null>(null);
  const [hintVisible, setHintVisible] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    return watchPosition(
      (f) => setRawFix(f),
      () => {
        if (claimGpsHintOnce()) setHintVisible(true);
      },
    );
  }, [enabled, watchPosition]);

  // Derived rather than reset via a second effect branch: a stale fix from a
  // previous session must not linger once the toggle switches off (mirrors
  // LiveView.tsx's toggleActive), but a synchronous setState inside an
  // effect body risks a cascading extra render (eslint's react-hooks
  // set-state-in-effect rule) — deriving it at render time avoids that and
  // is simpler besides.
  const fix = enabled ? rawFix : null;

  const dismissHint = () => setHintVisible(false);

  return { fix, hintVisible, dismissHint };
}
