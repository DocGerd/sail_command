import { useEffect, useState } from 'react';

// #155: the JS half of the app's reduced-motion handling. Paint-only motion
// (transitions, the compass pulse) is switched off in app.css's
// `@media (prefers-reduced-motion: reduce)` block; this hook exists only for
// the decisions CSS cannot make — MapLibre camera ease durations and the
// widened track-up bearing deadband.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// jsdom has no matchMedia (see src/test/setup.ts — it is not stubbed
// globally), so absent it we default to "motion allowed", which is the branch
// the existing unit tests exercise. Mirrors lib/useWideLayout.ts.
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mql.matches);
    // Sync once in case the preference changed between the initial useState
    // read and this effect running.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
