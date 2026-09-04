import { useLayoutEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useT } from '../i18n';

// #871: `.reload-prompt` (this component's rendered banner, needRefresh OR
// offlineReady) is a TRANSIENT toast — but `DataLayers.tsx`'s depth-legend
// reachability gate and app.css's narrow-layout `.map-stack-tl`/
// `.route-layer-controls` clearance rule both derive from `.banner-area`'s
// FULL rendered height, with no distinction between this toast and a
// persistent banner (offline, stale-forecast, ...). At narrow viewports the
// toast ALONE can push that budget under `LEGEND_COLLAPSED_HEIGHT_PX`,
// hiding the whole `<details class="depth-legend">` — #597 caveat included —
// with zero user action (#871's own measured repro: `budgetPx` 62.556px with
// the toast dismissed, `hidden: true` with it up).
//
// #909 (four failed placements from PR #908, retained on branch
// `fix/toast-hides-depth-caveat`) proves this cannot be fixed by MOVING the
// toast to any fixed CSS position: `.map-stack-tl`'s own low bound
// (`100dvh - 55vh - 0.5rem`, app.css) is a CONSTANT distance from the
// viewport bottom regardless of banner height, so a fixed `top`/`bottom`
// value and that bound inevitably cross at SOME viewport/plan-state
// combination — each of the four tried positions traded one victim
// (tab strip, depth checkbox, compass, `.route-layer-controls`) for another.
//
// Fix instead pulls this toast OUT of `.banner-area`'s flow at narrow
// layouts (`app.css`'s own `.reload-prompt` narrow-only rule, beside the
// `.banner-area`/`--sc-banner-height` block) so its height stops counting
// toward EITHER `--sc-banner-height` (app.css) or `DataLayers.tsx`'s own
// `bannerEl.getBoundingClientRect()` read — both derive from the SAME
// `.banner-area` node, so this is a single change that keeps both
// consistent (the #908 attempt that touched only DataLayers.tsx's own sum
// left them DISAGREEING, which is what drove the legend into the tab strip
// — see #909's "placement 1" writeup). This effect then positions the
// toast LIVE, below whichever of `.map-stack-tl` / `.depth-legend >
// summary` currently reaches furthest down (`.route-layer-controls` is
// handled SEPARATELY, horizontally — see below) — the same runtime-
// measured idiom `ScaleBar.tsx`'s `apply()` already uses for
// `.map-stack-tl` clearance (CLAUDE.md's own ScaleBar/useBannerHeight
// bullet), rather than a fixed viewport fraction, because only a LIVE
// measurement can track which cluster is tallest across every viewport AND
// plan-loaded/no-plan state — the two axes #909 pins as the "no static
// choice can pick the right victim" argument. `.depth-legend > summary`
// specifically (not the whole `<details>`) so an OPEN legend's unbounded
// wrapped-text body (`app.css`'s own comment: "deliberately sets no
// overflow so it can extend past .map-stack-tl's own computed height
// unclipped") can never push this toast off-screen.
//
// `.route-layer-controls` is excluded from the VERTICAL target set and
// instead cleared HORIZONTALLY (`--sc-toast-right`, narrowing the toast's
// own right edge to sit left of it) whenever it exists — MEASURED
// (844x390/740x360, plan loaded — `#208 "Major 3"`'s own repro sizes) that
// a 44px accessible-touch-target dismiss button (#708) makes this toast's
// OWN minimum height ~60px regardless of message length (the button, not
// text wrapping, sets the flex row's height — a 220px-wide single-line
// message measures the SAME 60px total as a wrapped two-line one), and at
// those two viewports the vertical gap between `.route-layer-controls`'
// bottom and `.app-bottom-sheet`'s top is narrower than that — 59.5px and
// 46px respectively — so NO vertical position clears both, matching #909's
// own structural finding one level deeper. Since `.route-layer-controls`
// sits at the TOP-RIGHT and `.map-stack-tl` at the TOP-LEFT (CLAUDE.md's
// own #324 note: "top-LEFT of the map, so it can never collide with
// RouteLayer's plan-gated cluster at the top-right"), separating this
// toast from `.route-layer-controls` HORIZONTALLY removes the 2-D overlap
// outright, at every viewport wide enough to still fit the message text —
// unlike the vertical-only anchor, this needs no squeeze fallback for the
// `.route-layer-controls` axis at all.
function useToastAnchor(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    // jsdom guard, matching DataLayers.tsx/useBannerHeight.ts's own —
    // real browsers always have ResizeObserver, jsdom by default does not.
    if (typeof ResizeObserver !== 'function') return;

    const GAP_PX = 8; // 0.5rem, matching .map-stack-tl's own gap tokens.
    // MEASURED (debug pass on 280x568, before this constraint existed): a
    // below-clusters-only anchor put a two-line DE toast at y=229.59-289.59
    // while `.app-bottom-sheet`'s Tier-3 `.app-tabs` strip (SAME tier as
    // this toast's own `.banner-area` ancestor, app.css's tier-order
    // comment) starts at y≈255.6 — the tab strip WON the same-tier paint/
    // hit-test tie by DOM order (App.tsx renders it after `.banner-area`),
    // making the dismiss button itself un-clickable. So a below-clusters
    // anchor alone reproduces the shape of #909's finding one level lower:
    // this toast can itself become the fifth victim of the same squeeze it
    // was built to route around. `belowMinY` (must clear
    // `.map-stack-tl`/`.depth-legend > summary`) and `aboveMaxY` (must
    // clear `.app-bottom-sheet`, using the toast's OWN live height) are two
    // INDEPENDENT bounds on `top`; `Math.min` picks `belowMinY` whenever
    // both are satisfiable (the ordinary case) and falls back to
    // `aboveMaxY` when they conflict (a genuine squeeze) — deliberately
    // siding with keeping the ALWAYS-OPERABLE tab strip clear (Tier 3,
    // "always operable" in app.css's own tier philosophy) over the
    // map-surface cluster (Tier 2), rather than the other way round. In the
    // squeeze case this toast MAY still partially overlap the lower part of
    // `.map-stack-tl`'s content — a residual, not eliminated. MEASURED
    // (#909, real Chromium, 2026-09-04) at `deepPortrait320` (320x568) and
    // `wrapForcing280` (280x568), no plan: the depth checkbox stays fully
    // clear (0px² overlap), but the compass button's bottom ~34 of its
    // 44px height is covered (~1495px² overlap) and a real
    // `locator.click({trial:true})` at its own centre point TIMES OUT — a
    // genuine interactive block, not just visual overlap. Pinned by
    // `layout.spec.ts`'s own `#909` guard (`hitState`).
    const VERTICAL_TARGETS = ['.map-stack-tl', '.depth-legend > summary'];

    const recompute = () => {
      // Wide layout: app.css's `.reload-prompt` narrow-only override never
      // applies, so this toast stays in .banner-area's ordinary flow and
      // the value written here is simply unused — skip the work.
      if (window.matchMedia('(min-width: 1024px)').matches) return;
      let belowMinY = 0;
      for (const selector of VERTICAL_TARGETS) {
        const el = document.querySelector<HTMLElement>(selector);
        if (el) belowMinY = Math.max(belowMinY, el.getBoundingClientRect().bottom);
      }
      belowMinY += GAP_PX;

      const toastEl = document.querySelector<HTMLElement>('.reload-prompt');
      const toastHeight = toastEl ? toastEl.getBoundingClientRect().height : 0;
      const sheetEl = document.querySelector<HTMLElement>('.app-bottom-sheet');
      // No sheet found (shouldn't happen — App.tsx renders it
      // unconditionally): fall back to the viewport bottom, i.e. impose no
      // upper constraint at all, matching this hook's own guard-asymmetry
      // convention of failing toward the GENEROUS (unclamped) direction.
      const sheetTop = sheetEl ? sheetEl.getBoundingClientRect().top : window.innerHeight;
      const aboveMaxY = sheetTop - GAP_PX - toastHeight;

      // 48px = .banner-area's own unmeasured `top: 3rem` — never render the
      // toast above where it always used to start.
      const top = Math.max(48, Math.min(belowMinY, aboveMaxY));
      document.documentElement.style.setProperty('--sc-toast-top', `${top}px`);

      // Horizontal clearance of `.route-layer-controls` (see the effect's
      // own comment above) — only when it exists (plan loaded); otherwise
      // the toast spans full width, matching app.css's `right: 0` default.
      const routeControlsEl = document.querySelector<HTMLElement>('.route-layer-controls');
      const rightPx = routeControlsEl
        ? Math.max(0, window.innerWidth - routeControlsEl.getBoundingClientRect().left + GAP_PX)
        : 0;
      document.documentElement.style.setProperty('--sc-toast-right', `${rightPx}px`);
    };

    let ro: ResizeObserver | null = null;
    // Re-queries and re-observes every target — `.route-layer-controls`
    // mounts only once a plan exists (RouteLayer.tsx) and `.depth-legend`
    // unmounts once one does (#813), so the live element set changes over
    // this toast's lifetime and a one-time `querySelector` at effect setup
    // would miss both transitions. `.reload-prompt` and `.app-bottom-sheet`
    // are always present once this effect is active, but are re-queried
    // here too for the SAME uniform rewire — observing `.reload-prompt`
    // itself is what lets `recompute` pick up the toast's OWN height
    // changing (e.g. `needRefresh` <-> `offlineReady`, or a wrapped vs.
    // single-line message at a narrower width). `.route-layer-controls` is
    // observed too, for the horizontal calc above.
    const rewire = () => {
      ro?.disconnect();
      ro = new ResizeObserver(recompute);
      for (const selector of [
        ...VERTICAL_TARGETS,
        '.route-layer-controls',
        '.reload-prompt',
        '.app-bottom-sheet',
      ]) {
        const el = document.querySelector<HTMLElement>(selector);
        if (el) ro.observe(el);
      }
      recompute();
    };

    rewire();
    // ReloadPrompt is a SIBLING of the map subtree (App.tsx renders it in
    // `.banner-area`, not inside MapView's wrapper), so — unlike
    // ScaleBar.tsx, which can scope its own MutationObserver to
    // `rootRef.current.parentElement` — there is no single shared ancestor
    // narrower than the document to watch for `.route-layer-controls`/
    // `.depth-legend` mounting or unmounting.
    const mo = new MutationObserver(rewire);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', recompute);

    return () => {
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [active]);
}

// Reuses Banner's .banner-* CSS classes for visual consistency with the
// rest of banner-area, but isn't <Banner> itself: the needRefresh state
// needs a real, labeled "Reload" action ALONGSIDE Banner's dismiss ×
// slot (not instead of it, #441 — see the dismiss button below), and
// offlineReady is a one-shot toast that self-dismisses once and never
// reappears (workbox only flips offlineReady true once, on the precache
// install that follows this page's own SW registration).
export default function ReloadPrompt() {
  const t = useT();
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swScriptUrl, registration) {
      // Deliberate update checks on good connectivity only. registerType
      // 'prompt' (vite.config.ts) already rules out autoUpdate reloading
      // mid-passage-planning; this only decides *when* the app bothers to
      // ask the browser whether a newer SW exists — on window focus, and
      // only while online, so a check never fires against a forecast-only
      // offline session.
      // Never removed: ReloadPrompt mounts once for the app's lifetime, so
      // there's no unmount to clean this listener up on.
      window.addEventListener('focus', () => {
        // Transient rejections (e.g. a mid-flight network drop) are benign —
        // swallowed here so they never surface as an unhandledrejection.
        if (navigator.onLine) void registration?.update().catch(() => {});
      });
    },
    onRegisterError(error) {
      console.error('SW registration failed — offline mode unavailable', error);
    },
  });

  // Called every render regardless of which branch below fires (Rules of
  // Hooks) — the effect inside no-ops unless a toast is actually showing.
  useToastAnchor(needRefresh || offlineReady);

  if (needRefresh) {
    return (
      <div role="alert" className="banner banner-info reload-prompt">
        <span className="banner-message">{t('pwa.updateAvailable')}</span>
        <button
          type="button"
          className="reload-prompt-action"
          onClick={() => void updateServiceWorker(true)}
        >
          {t('pwa.reload')}
        </button>
        {/* #441: SESSION-scoped dismiss only — `setNeedRefresh(false)` clears
            the local React state, not the underlying SW "waiting" registration,
            so the update is still there and `updateServiceWorker` (above)
            still applies it. The banner reappears on the NEXT SW update event:
            vite-plugin-pwa's `useRegisterSW` re-fires `onNeedRefresh` (which
            sets this same state back to true) from workbox-window's own
            `waiting` listener, which re-triggers whenever a NEW service
            worker enters the waiting state — i.e. a genuinely newer deploy,
            not a re-check of the one just dismissed (source:
            vite-plugin-pwa's react client, `wb.addEventListener('waiting',
            showSkipWaitingPrompt)`). A user who dismisses today's update is
            therefore never silently stuck on a stale build forever — only
            ever silent about ONE deploy, for the rest of THIS session. */}
        <button
          type="button"
          className="banner-dismiss"
          aria-label={t('banner.dismiss')}
          onClick={() => setNeedRefresh(false)}
        >
          ×
        </button>
      </div>
    );
  }

  if (offlineReady) {
    return (
      <div role="status" className="banner banner-info reload-prompt">
        <span className="banner-message">{t('pwa.offlineReady')}</span>
        <button
          type="button"
          className="banner-dismiss"
          aria-label={t('banner.dismiss')}
          onClick={() => setOfflineReady(false)}
        >
          ×
        </button>
      </div>
    );
  }

  return null;
}
