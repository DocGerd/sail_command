// Panel-width bounds for the #355 resizable desktop left panel.
//
// CLAUDE.md's cross-language-invariant lesson applies here: a CSS `var()`
// fallback and a JS constant have no compiler spanning them, so drift is
// caught only by a test that reads both artifacts (the pattern
// `useBannerHeight.test.ts` established for the banner-height fallback).
// `panelWidth.test.ts` does the same for the numbers below — every bound
// lives in this file as the single source of truth; app.css's wide-layout
// grid rule carries only the `320px` floor as a literal (checked against
// PANEL_MIN_WIDTH_PX) and the `1fr` fallback for "no stored width yet, keep
// today's default layout exactly" (unenforced — there is no numeric value to
// compare it against, only the ABSENCE of the custom property, so a test
// can't pin it the way it pins the 320px literal).

/** Floor, matching the pre-#355 `minmax(320px, ...)` grid rule. */
export const PANEL_MIN_WIDTH_PX = 320;

/**
 * Map reserve subtracted from the viewport to get the panel's maximum
 * width. This is a CHOSEN minimum-useful-map-width (maintainer decision,
 * #355 issue discussion) — not a value derived from any measured layout
 * constant (unlike, e.g., the banner-height fallback or the 320px floor
 * above, both of which restate an existing rendered/CSS number). Named
 * separately so a future reader does not mistake it for a measurement.
 */
export const PANEL_MAP_RESERVE_PX = 480;

/**
 * The other half of the max-width anchor: the panel may take at most this
 * fraction of the viewport, so a very wide monitor still leaves the map
 * dominant rather than "the whole screen minus 480px".
 */
export const PANEL_MAX_VIEWPORT_FRACTION = 0.7;

/**
 * Maximum panel width for a given viewport: `min(70vw, viewportWidth -
 * 480px)` (maintainer decision, #355) — recompute on every viewport change,
 * never cache a bare px literal. Floors at PANEL_MIN_WIDTH_PX so a
 * pathologically narrow "wide" viewport (just past the 1024px breakpoint,
 * where 70vw and viewportWidth-480px can both undershoot 320px) never
 * produces an inverted [min, max) range — `useWideLayout`'s own breakpoint
 * is 1024px, at which `min(0.7*1024, 1024-480) = min(716.8, 544) = 544`,
 * comfortably above the floor, but this function must stay correct for any
 * future breakpoint change too.
 */
export function panelMaxWidthPx(viewportWidthPx: number): number {
  return Math.max(
    PANEL_MIN_WIDTH_PX,
    Math.min(viewportWidthPx * PANEL_MAX_VIEWPORT_FRACTION, viewportWidthPx - PANEL_MAP_RESERVE_PX),
  );
}
