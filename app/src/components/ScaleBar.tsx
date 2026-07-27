import { useEffect, useRef, useState } from 'react';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { haversineNm } from '../lib/geo';
import { useWideLayout } from '../lib/useWideLayout';
import {
  SCALE_LIFT_GAP_PX,
  SCALE_LIFT_MAX_VIEWPORT_FRACTION,
  SCALE_SAMPLE_PX,
  pickScaleBar,
  scaleUnitAbbrevKey,
  scaleUnitWordKey,
  type ScaleBarStep,
} from '../lib/mapOrientation';

/**
 * #155: passive nautical scale indicator, bottom-left of the map.
 *
 * Bearing-invariant by construction — the span is measured across the middle
 * of the canvas in SCREEN space, so a rotated chart changes nothing. Unit
 * selection (NM / cables / metres) lives in `lib/mapOrientation.ts`; this
 * component only measures, formats and writes the DOM.
 *
 * `pointer-events: none` (app.css): the bar must never swallow a map tap.
 */
export default function ScaleBar() {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();
  const isWide = useWideLayout();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);

  // The aria-label is the ONLY part of the bar in React state, and it is only
  // rewritten on moveend — a live region rewritten at pan/zoom frame rate is
  // screen-reader spam. The visible label and bar width are written straight
  // to the DOM under rAF instead.
  const [ariaText, setAriaText] = useState('');
  // null = nothing docked over the corner, so the stylesheet's own bottom
  // offset (tab strip + gap, or the map's bottom edge on wide) applies.
  // Holds the FINAL `bottom` px value (gap and #208 NEW-3 clamp already
  // folded in — see the effect below), not a raw occluder measurement.
  const [bottomPx, setBottomPx] = useState<number | null>(null);
  const [suppressed, setSuppressed] = useState(false);

  // `useT()` returns a fresh closure every render, so it can never be an
  // effect dependency. This sync effect is declared BEFORE the map effect, so
  // on a language change the ref is already current when the map effect
  // (keyed on `lang`) re-runs and repaints.
  const formatRef = useRef<(step: ScaleBarStep) => { label: string; aria: string }>(() => ({
    label: '',
    aria: '',
  }));
  useEffect(() => {
    formatRef.current = (step) => ({
      // Every rung is an integer across the app's reachable zoom range (1-2-5
      // per decade in whichever unit is being labelled), so there is no
      // decimal separator to localise here.
      label: `${step.value} ${t(scaleUnitAbbrevKey(step.unit))}`,
      aria: t('map.scale.aria', {
        distance: step.value,
        unit: t(scaleUnitWordKey(step.unit, step.value)),
      }),
    });
  });

  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let last: ScaleBarStep | null = null;

    const measure = () => {
      const canvas = map.getCanvas();
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const half = SCALE_SAMPLE_PX / 2;
      const a = map.unproject([cx - half, cy]);
      const b = map.unproject([cx + half, cy]);
      const maxNm = haversineNm({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
      const step = pickScaleBar(maxNm, SCALE_SAMPLE_PX);
      // A degenerate viewport (zero-sized canvas mid-resize) keeps the last
      // honest bar rather than painting a NaN one.
      if (!step) return;
      last = step;
      if (barRef.current) barRef.current.style.width = `${step.widthPx.toFixed(1)}px`;
      if (labelRef.current) labelRef.current.textContent = formatRef.current(step).label;
    };
    const schedule = () => {
      if (raf === 0)
        raf = requestAnimationFrame(() => {
          raf = 0;
          measure();
        });
    };
    const onMoveEnd = () => {
      measure();
      if (last) setAriaText(formatRef.current(last).aria);
    };

    measure();
    if (last) setAriaText(formatRef.current(last).aria);
    map.on('move', schedule);
    map.on('resize', schedule);
    map.on('moveend', onMoveEnd);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      map.off('move', schedule);
      map.off('resize', schedule);
      map.off('moveend', onMoveEnd);
    };
  }, [map, lang]);

  // ---- narrow-layout occlusion rule ----
  // Two independent things can occlude this corner on narrow, and neither
  // subsumes the other:
  //  - The Live tab docks its readout (`.live-view`) or its no-plan card
  //    (`.live-view-no-plan`) over exactly this corner. Those live INSIDE
  //    `host` (MapView's own wrapper — see the NAMED COUPLING note below);
  //    `.app-bottom-sheet` itself stays minimal there (the Live panel renders
  //    nothing on narrow, see App.tsx), so this occluder is the only thing to
  //    clear on that tab.
  //  - #208 NEW-1: `.app-bottom-sheet` itself, whose rendered height (tab
  //    strip + whatever the ACTIVE tab's panel content needs, up to 55vh) is
  //    what buried the bar on Plan/Routes — there is no docked readout there
  //    for the old rule to see. `.app-bottom-sheet` is a SIBLING of the whole
  //    map (App.tsx), not a descendant of `host`, but it shares `host`'s
  //    bottom edge exactly (`.map-area`/`.app-bottom-sheet` both resolve
  //    against `.app-shell`'s box, see app.css), so its own `offsetHeight` IS
  //    directly the px the bar must clear — no offsetTop math needed the way
  //    the docked-readout case below needs it.
  // The applied lift is whichever of the two currently reaches further up,
  // and it suppresses the bar outright once that lift would push it past
  // SCALE_LIFT_MAX_VIEWPORT_FRACTION of the viewport (a half-screen occluder
  // would otherwise strand the bar in the middle of the chart).
  //
  // The docked-readout lift is measured to its TOP EDGE (`host.offsetHeight -
  // el.offsetTop`), NOT its height: the two cards dock at different bottom
  // offsets of their own, so lifting by height alone left the bar overlapping
  // the no-plan card by ~20 px (measured in the browser). offsetTop/
  // offsetHeight rather than getBoundingClientRect because the docked card is
  // absolutely positioned against this very host, which makes offsetTop
  // exactly "distance from the host's top".
  //
  // NAMED COUPLING with LiveView.tsx: those two class names are the docked
  // readout's two shapes. On the wide layout LiveView portals both into the
  // panel column (#31), so they are not children of MapView's wrapper at all
  // and the query finds nothing. The MutationObserver catches the
  // mount/unmount and the readout <-> no-plan swap; the two ResizeObservers
  // catch the readout growing as GPS data arrives and the sheet's panel
  // content changing (tab switch, field validation growing a hint, etc.).
  //
  // Gated on `!isWide` (`lib/useWideLayout.ts`, mirrors app.css's own
  // `@media (min-width: 1024px)` breakpoint): on wide, `.app-bottom-sheet` is
  // a static grid column beside the map, not an overlay, and the wide
  // stylesheet rule already parks the bar at the map's own bottom edge
  // (`bottom: 0.75rem`). An inline `style.bottom` always beats that rule by
  // specificity, so measuring the sheet unconditionally would silently break
  // wide the moment its (large, full-column) offsetHeight leaked in here —
  // this effect must produce `null` there instead, which is also why it
  // re-runs (and clears any stale narrow-computed value) on every `isWide`
  // flip, not just at mount.
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    // Nested function, not a direct effect-body call: keeps this in the same
    // shape as every other setState site below (`apply`, reached only
    // through `measureLive`/`measureSheet`), which is what makes them all
    // read as "callback reacting to a measurement" rather than a synchronous
    // effect-body write (react-hooks/set-state-in-effect).
    const clear = () => {
      setBottomPx(null);
      setSuppressed(false);
    };
    if (isWide) {
      clear();
      return;
    }

    const canObserveResize = typeof ResizeObserver === 'function';
    let liveRo: ResizeObserver | null = null;
    let sheetRo: ResizeObserver | null = null;
    let liveLift = 0;
    let sheetLift = 0;

    const apply = () => {
      const lift = Math.max(liveLift, sheetLift);
      if (lift <= 0) {
        setBottomPx(null);
        setSuppressed(false);
        return;
      }
      // Two INDEPENDENT suppression signals, deliberately not unified into one
      // "lift too big" percentage:
      //  - The original heuristic (issue #155), keyed on `liveLift` ALONE. A
      //    docked Live readout eating a large slice of the viewport is the
      //    rare, genuinely-oversized case it was calibrated for.
      //  - `.app-bottom-sheet`'s cap is a routine, near-permanent 55vh on
      //    Plan/Routes with real content, not a rare oversized case — reusing
      //    the SAME 40%-of-viewport threshold for `sheetLift` over-suppressed
      //    the bar even on ordinary tall phones with plenty of headroom
      //    (measured live: 375x667 has ~79 px clear between .map-stack-tl and
      //    the sheet, comfortably more than the bar needs, yet a naive
      //    percentage check hid it anyway). What actually determines whether
      //    the sheet leaves room is geometric, so that's what decides it
      //    below: `floor` (the minimal bottom offset that clears whichever
      //    occluder reaches further) vs `ceiling` (the maximum bottom offset
      //    that still keeps the bar's own box clear of `.map-stack-tl`'s
      //    bottom edge, #208 NEW-3). `floor > ceiling` means no position
      //    clears BOTH at once — clamping to the ceiling in that case would
      //    silently re-introduce NEW-1 (the bar drawn back under the sheet)
      //    just to avoid NEW-3, which is the wrong trade given NEW-1 is the
      //    high-severity bug and NEW-3 is cosmetic — so this suppresses
      //    instead, the same "no scale is better than a scale in the wrong
      //    place" call the original heuristic already makes.
      let suppressed = liveLift > window.innerHeight * SCALE_LIFT_MAX_VIEWPORT_FRACTION;
      const floor = lift + SCALE_LIFT_GAP_PX;
      let bottomPx = floor;
      const mapStack = host.querySelector<HTMLElement>('.map-stack-tl');
      if (mapStack) {
        const barHeight = rootRef.current?.offsetHeight ?? 0;
        const mapStackBottom = mapStack.offsetTop + mapStack.offsetHeight;
        const ceiling = host.offsetHeight - barHeight - mapStackBottom - SCALE_LIFT_GAP_PX;
        if (floor > ceiling) suppressed = true;
        bottomPx = Math.min(floor, Math.max(0, ceiling));
      }
      setSuppressed(suppressed);
      setBottomPx(bottomPx);
    };

    const measureLive = (el: HTMLElement | null) => {
      liveLift = el ? host.offsetHeight - el.offsetTop : 0;
      apply();
    };
    const rewireLive = () => {
      liveRo?.disconnect();
      liveRo = null;
      const el = host.querySelector<HTMLElement>('.live-view, .live-view-no-plan');
      measureLive(el);
      if (el && canObserveResize) {
        liveRo = new ResizeObserver(() => measureLive(el));
        liveRo.observe(el);
      }
    };

    const measureSheet = (el: HTMLElement | null) => {
      sheetLift = el ? el.offsetHeight : 0;
      apply();
    };
    const sheetEl = document.querySelector<HTMLElement>('.app-bottom-sheet');
    measureSheet(sheetEl);
    if (sheetEl && canObserveResize) {
      sheetRo = new ResizeObserver(() => measureSheet(sheetEl));
      sheetRo.observe(sheetEl);
    }

    rewireLive();
    const mo = new MutationObserver(rewireLive);
    mo.observe(host, { childList: true });
    return () => {
      mo.disconnect();
      liveRo?.disconnect();
      sheetRo?.disconnect();
    };
  }, [isWide]);

  return (
    <div
      ref={rootRef}
      className={`scale-bar${suppressed ? ' scale-bar-suppressed' : ''}`}
      /* NAMED COUPLING: SCALE_LIFT_GAP_PX mirrors the `0.5rem` breathing space
         in .scale-bar's own stylesheet offset (app.css). Written inline rather
         than through a custom property because it REPLACES that offset
         wholesale — the docked card (or the sheet itself) already clears the
         tab strip, so the base `var(--sc-tabbar-h)` term must not be added on
         top of it. `bottomPx` is already the final px value (gap + the #208
         NEW-3 map-stack-tl clamp folded in by the effect above), not a raw
         lift. */
      style={bottomPx === null ? undefined : { bottom: `${bottomPx}px` }}
      role="img"
      aria-label={ariaText}
    >
      <span ref={labelRef} className="scale-bar-label" />
      {/* Classic chart bracket: a bottom-open ⊔ whose inner width IS the
          labelled ground distance. */}
      <div ref={barRef} className="scale-bar-bracket" />
    </div>
  );
}
