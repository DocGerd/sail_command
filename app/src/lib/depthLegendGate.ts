/**
 * #641 — the ONE number `DataLayers.tsx`'s depth-legend reachability gate and
 * `app.css` both have to agree on, extracted so a test can pin them together.
 *
 * `DataLayers.tsx`'s `useLayoutEffect` decides whether the `#598` depth-hatch
 * legend is offered at all by comparing the vertical budget left under
 * `.map-stack-tl`'s own ceiling against the height of the legend's COLLAPSED
 * box. That height is authored in CSS (`.depth-legend > summary`'s
 * `min-height`), and the gate hard-coded the same literal on the TS side — two
 * copies of one constant, in two languages no compiler spans, exactly the drift
 * `lib/panelWidth.ts` and `lib/useBannerHeight.ts` already pin for their own
 * CSS twins. `depthLegendGate.test.ts` is that pin here.
 *
 * WHY THE COLLAPSED BOX IS THE SUMMARY'S OWN `min-height`, and not something
 * larger: `.depth-legend`'s chrome padding (#638) is deliberately
 * HORIZONTAL-ONLY. Vertical padding there would add to the collapsed box
 * without touching this constant — a silent, one-sided drift — so the twin test
 * asserts the zero-vertical-padding property too, not just the number. Both
 * assertions are load-bearing and neither implies the other.
 *
 * Getting it wrong in either direction has a real cost, which is why it is
 * pinned rather than commented: too LOW and the legend is offered where its box
 * genuinely does not fit (it then overlaps the tab strip, the `#598` failure
 * mode); too HIGH and the control is hidden on viewports where it fits fine.
 */
export const LEGEND_COLLAPSED_HEIGHT_PX = 44;
