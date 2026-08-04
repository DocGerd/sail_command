import { useLayoutEffect, useState } from 'react';

// #368: an unmeasurable environment must assume a GENEROUS banner height,
// never zero — this repo's guard-asymmetry convention (CLAUDE.md: a NUDGE
// fails open, a BLOCKING guard fails closed) applies here because the two
// failure directions cost very differently: over-pushing the map chrome only
// costs some screen space, while under-pushing it (or not pushing at all)
// leaves a control genuinely unreachable underneath the banner, which is the
// exact defect this hook exists to prevent. The figure is roughly three
// wrapped banner lines at this app's compact `.banner` sizing (0.9rem text,
// 0.5rem vertical padding each side, ~22px per wrapped line measured live —
// see app.css's own `.banner-area` residual note) plus headroom for a second
// stacked banner: generous on purpose, not a tight fit.
export const BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX = 176;

// NAMED COUPLING: this is the ONLY place `--sc-banner-height` is written —
// app.css's narrow-layout banner-clearance rule (`.route-layer-controls`,
// `.map-stack-tl`) reads it via `var(--sc-banner-height, 176px)`. Change the
// property name in both places together. The CSS fallback is the SAME
// `BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX` constant above, kept in sync BY
// HAND (a CSS `var()` fallback can't import a JS constant) — belt-and-braces
// with the `useLayoutEffect` below, not a duplicate of the same guard: the
// `useLayoutEffect` closes the FIRST-PAINT timing window (this hook hasn't
// measured yet), while the CSS fallback is what protects the layout if the
// custom property is never written at all for any OTHER reason (this hook
// not mounted, an error thrown before the write, a future refactor) — see
// the PR #382 review finding this pair fixes: a `0px` CSS default failed the
// WRONG way (under- rather than over-pushing) for exactly the window a
// PLAIN `useEffect` (fires after paint) left open on a cold load with a
// banner already visible.
const CSS_VAR = '--sc-banner-height';

/**
 * #368: the REAL rendered height of `.banner-area`, in px, kept in sync with
 * a `ResizeObserver` — replaces the old viewport-height CLAMP HEURISTIC that
 * used to live in app.css (a function of `100dvh` alone, blind to how many
 * banners were actually on screen or whether one had wrapped to two lines).
 * One line, several stacked banners, or a wrapped German string are all just
 * "however tall `.banner-area` measured today", not cases to special-case.
 *
 * Every call site gets its own `ResizeObserver` instance (this hook takes no
 * ref/element argument — it queries `.banner-area` itself, the same
 * cross-component convention ScaleBar.tsx already uses for `.app-bottom-
 * sheet`/`.live-view`, both siblings outside its own subtree, not a
 * descendant it could hold a ref to). Multiple instances are deliberately
 * NOT deduplicated into a single shared observer: each computes the
 * identical value from the same DOM node, so redundant instances can never
 * disagree — simpler than plumbing a singleton/context through components
 * that today don't share one.
 *
 * The CSS custom property write is IMPERATIVE (`element.style.setProperty`),
 * not routed through React state -> re-render -> inline style. This matters
 * because TWO independent call sites exist (App.tsx, ScaleBar.tsx) and
 * ScaleBar's own effect re-measures `.map-stack-tl`'s rendered position
 * (`offsetTop`/`offsetHeight`) whenever ITS OWN `useBannerHeight()` call
 * returns a new number — if the property update instead waited on App.tsx's
 * *separate* render/commit to land the inline style, ScaleBar's own commit
 * could in principle run first and read a stale, not-yet-pushed position for
 * one frame. Writing the property synchronously inside this hook's own
 * `ResizeObserver` callback — before the `setState` that ScaleBar's effect
 * ultimately depends on even schedules a render — makes every call site
 * self-sufficient: the DOM is already correct by the time ANY consumer's own
 * effect runs, regardless of which call site's commit happens to land first.
 *
 * `useLayoutEffect`, NOT `useEffect` (PR #382 review): a plain `useEffect`
 * fires AFTER paint, so on a cold load with a banner already visible (the
 * common case — see App.tsx's ReloadPrompt/offline-banner comments) there
 * was a real first-paint frame where `--sc-banner-height` had not been
 * written yet and the CSS `var(..., 0px)` fallback (now `176px`, the CSS_VAR
 * comment above) collapsed the push to nothing — reopening the exact
 * hit-test collision this hook exists to prevent, for one frame on every
 * cold load. No SSR runs in this app, so `useLayoutEffect`'s
 * synchronous-before-paint timing is safe to rely on unconditionally.
 *
 * jsdom has no `ResizeObserver` (`src/test/setup.ts` does not stub it
 * globally) — the guard-asymmetry fallback above applies: `canObserve` false
 * means this hook returns the generous constant unconditionally and never
 * touches the DOM (nothing in that environment reads the custom property
 * either).
 */
export function useBannerHeight(): number {
  const canObserve = typeof ResizeObserver === 'function';
  const [height, setHeight] = useState(() =>
    canObserve ? 0 : BANNER_HEIGHT_UNMEASURABLE_FALLBACK_PX,
  );

  useLayoutEffect(() => {
    if (!canObserve) return;
    const el = document.querySelector<HTMLElement>('.banner-area');
    if (!el) return;

    const write = (px: number) => {
      document.documentElement.style.setProperty(CSS_VAR, `${px}px`);
      setHeight(px);
    };

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) write(cr.height);
    });
    ro.observe(el);
    // The first `ResizeObserver` callback is queued for a later frame, not
    // delivered synchronously — measure once immediately so a banner already
    // mounted at effect-run time (e.g. straight after a reload) doesn't read
    // as 0px for that first frame.
    write(el.getBoundingClientRect().height);

    return () => ro.disconnect();
  }, [canObserve]);

  return height;
}
