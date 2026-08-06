import { useEffect, useRef, useState } from 'react';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { haversineNm } from '../lib/geo';
import { useWideLayout } from '../lib/useWideLayout';
import { useBannerHeight } from '../lib/useBannerHeight';
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
  // #368: `.map-stack-tl` can reposition at runtime (app.css's banner-
  // clearance rule reads `--sc-banner-height`, written by this SAME hook —
  // see its own comment) whenever `.banner-area`'s rendered height changes:
  // a banner mounting/unmounting, OR a banner wrapping to a second line with
  // no child added/removed at all (the case a `.banner-area` `childList`
  // MutationObserver, this effect's previous mechanism, could not see — see
  // the effect below's own comment on why that observer was removed rather
  // than kept alongside this one). The returned number is used only as an
  // effect-rerun trigger below; the actual geometry this effect needs
  // (`.map-stack-tl`'s real `offsetTop`/`offsetHeight`) is already correct
  // by the time that effect runs, because this hook's own `ResizeObserver`
  // callback writes the CSS custom property SYNCHRONOUSLY, before it calls
  // the `setState` this render is even responding to.
  const bannerHeight = useBannerHeight();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  // Last-known-good rendered height of the bar itself, for the #208 NEW-3
  // ceiling below. Deliberately NOT a live `rootRef.current.offsetHeight`
  // read at the moment of use — see the effect's own comment for why that
  // was a real, measured bug (review finding "Major 1").
  const barHeightRef = useRef(0);

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
    let barRo: ResizeObserver | null = null;
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
      //
      // Recorded consequence (review finding "Minor 6"): `.map-stack-tl`
      // alone (the compass/toggle column this guards against) occupies
      // `top: 3.5rem` to roughly 222px regardless of viewport height — on
      // landscape phones that is ~46% of the whole screen, which leaves no
      // room for the bar under EITHER occluder, so it is suppressed on
      // EVERY tab at those sizes (measured: 740x360 on all three tabs;
      // 844x390/932x430/667x375 on Plan). Honest per the #208 acceptance
      // criteria, but the actual constraint is `.map-stack-tl`'s height, not
      // the sheet — tracked as a compacting-the-chrome-column follow-up in
      // issue #231 rather than attempted here.
      let suppressed = liveLift > window.innerHeight * SCALE_LIFT_MAX_VIEWPORT_FRACTION;
      const floor = lift + SCALE_LIFT_GAP_PX;
      let bottomPx = floor;
      const mapStack = host.querySelector<HTMLElement>('.map-stack-tl');
      if (mapStack) {
        // Review finding "Major 1": reading `rootRef.current.offsetHeight`
        // live here is wrong at exactly the two moments this runs. (1) At
        // the FIRST measurement — this effect runs synchronously after
        // commit, before the map effect above has painted a real label into
        // `.scale-bar-label` (it needs a live `map` instance, which arrives
        // asynchronously) — the empty label contributes no line box, so the
        // bar reads ~18px instead of its true ~30px. (2) After ANY
        // suppression episode, `.scale-bar-suppressed` is `display: none`
        // (app.css), which makes `offsetHeight` exactly 0 — and nothing
        // previously re-measured the bar itself once hidden. Both inflate
        // `ceiling`, which both wrongly clears `floor > ceiling` (no
        // suppression when there should be one) and draws the bar closer to
        // `.map-stack-tl` than the true height allows — measured overlaps of
        // 4-13px on real cold loads, and — because the SAME viewport can
        // land on either a real or a zeroed reading depending on what
        // resized last — non-deterministic (the same viewport visible after
        // a plain resize, suppressed after a tab bounce). A live reading is
        // only ever trusted when it is POSITIVE (never after the CSS itself
        // has zeroed it); a zero/undersized reading keeps the last one that
        // wasn't. The `barRo` ResizeObserver below is what re-triggers this
        // once the label's real text has actually painted, and again every
        // time the bar's own visibility flips — a live, always-current
        // reading whenever one is trustworthy, the frozen last-good one
        // whenever it briefly isn't.
        const freshBarHeight = rootRef.current?.offsetHeight ?? 0;
        if (freshBarHeight > 0) barHeightRef.current = freshBarHeight;
        const barHeight = barHeightRef.current;
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

    // #368: `.map-stack-tl` can reposition at runtime (app.css's banner-
    // clearance rule, driven by `--sc-banner-height`) whenever `.banner-
    // area`'s rendered height changes — a banner mounting/unmounting, OR a
    // banner wrapping to a second line with no child added/removed at all.
    // This effect re-runs (see the dependency array below) whenever this
    // component's OWN `useBannerHeight()` call (top of the component)
    // returns a new number, which `apply()` (re-invoked below via the
    // `measureSheet`/`rewireLive` calls this whole effect re-runs) then
    // reads the FRESH `.map-stack-tl` position for.
    //
    // Previously this was a `MutationObserver({childList: true})` on
    // `.banner-area` — SUBSUMED by (not stacked alongside) the shared
    // `useBannerHeight()` `ResizeObserver`, and deliberately removed rather
    // than kept as a second, redundant trigger: `childList` fires on banner
    // mount/unmount but is BLIND to a banner that grows taller by wrapping
    // to a second line — no child was added, the box just got taller — which
    // is exactly the #368 "wrapped banner" residual a resize-based trigger
    // closes and a mutation-based one structurally cannot.

    // Re-applies whenever the BAR's own box changes size — the first real
    // label paint (async, see the `barHeight` comment inside `apply` above)
    // and every suppress/un-suppress toggle (`display: none` <-> real box)
    // both fire this, which is what lets `apply()` ever pick up a corrected,
    // trustworthy `barHeight` instead of being stuck with whatever the very
    // first (possibly wrong) reading happened to be.
    if (canObserveResize && rootRef.current) {
      barRo = new ResizeObserver(() => apply());
      barRo.observe(rootRef.current);
    }

    return () => {
      mo.disconnect();
      liveRo?.disconnect();
      sheetRo?.disconnect();
      barRo?.disconnect();
    };
  }, [isWide, bannerHeight]);

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
