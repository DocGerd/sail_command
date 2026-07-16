import { useEffect, useState } from 'react';

// The wide-layout breakpoint (#24): at >=1024px the shell becomes a two-column
// side-panel grid. This mirrors the `@media (min-width: 1024px)` query in
// app.css — the one value that must stay in sync between the CSS layout and any
// JS that needs to know which layout is active (#31: the Live readout renders
// in the panel column on wide, as a map-corner card on narrow).
const WIDE_LAYOUT_QUERY = '(min-width: 1024px)';

// True while the wide (side-panel) layout is active. jsdom has no matchMedia
// (see src/test/setup.ts — it is not stubbed globally, only inside the one test
// that needs it), so absent it we default to the narrow layout: that keeps the
// existing non-DOM unit tests on the same render branch they exercise today.
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_LAYOUT_QUERY).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(WIDE_LAYOUT_QUERY);
    const onChange = () => setWide(mql.matches);
    // Sync once on mount in case the viewport changed between the initial
    // useState read and this effect running.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return wide;
}
