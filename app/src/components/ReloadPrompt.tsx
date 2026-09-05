import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useT } from '../i18n';

// #909: `.reload-prompt` (this component's rendered banner, needRefresh OR
// offlineReady) is an ordinary flex child of `.banner-area` at every
// viewport width. #871 had pulled it OUT of that flow at narrow
// (`position: fixed`) so its transient height could not squeeze
// `.map-stack-tl`/`.route-layer-controls` and, transitively,
// `DataLayers.tsx`'s depth-legend reachability gate; #909 then measured that
// no overlay position — static OR live-anchored, four placements tried in
// PR #908 — clears every cluster at every viewport, because
// `.map-stack-tl`'s low bound is a constant distance from the viewport
// bottom while the toast's own position is not. The shipped fix moves the
// whole banner ROW out of the map's plane instead (`app.css`'s narrow
// `.app-shell` grid), which makes an anchor unnecessary rather than
// better-placed: `useToastAnchor` and its `--sc-toast-top`/
// `--sc-toast-right` writes are deleted.
//
// What survives is a single measurement. Under that grid the toast's height
// comes out of the MAP ROW, so `app.css` gives the bottom sheet back exactly
// that much (`calc(55vh - var(--sc-toast-height, 0px))`) and the term
// cancels out of the map chrome's own budget — the derivation is in
// `app.css`'s own #909 comment. This hook publishes the one number that
// compensation needs.
//
// `useLayoutEffect`, not `useEffect`: the value is read by CSS during the
// FIRST paint after the toast mounts, and a plain `useEffect` fires after
// paint, leaving a window where `var(--sc-toast-height, 0px)` resolves to
// its fallback and the sheet is momentarily un-trimmed
// (`lib/useBannerHeight.ts` closes the identical window for
// `--sc-banner-height`). Safe here for the same reason `App.tsx`'s
// `--sc-panel-w` writer is: `toastRef` is returned to THIS component and
// attached to the element THIS component returns, so React attaches it
// before this component's own layout effects — never a sibling's ref, which
// is the case `PanelResizer.tsx` documents as unsafe.
//
// The `0px` var() fallback is the guard-asymmetry-correct direction: with no
// measurement the sheet keeps its full `55vh` cap, i.e. the pre-#909 value,
// rather than a speculative trim. Cleanup REMOVES the property rather than
// zeroing it, so a dismissed toast cannot leave the sheet trimmed.
function useToastHeight(
  needRefresh: boolean,
  offlineReady: boolean,
): RefObject<HTMLDivElement | null> {
  const toastRef = useRef<HTMLDivElement | null>(null);
  const active = needRefresh || offlineReady;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const clear = () => root.style.removeProperty('--sc-toast-height');
    const el = active ? toastRef.current : null;
    // jsdom guard, matching DataLayers.tsx/useBannerHeight.ts's own — real
    // browsers always have ResizeObserver, jsdom by default does not.
    if (!el || typeof ResizeObserver !== 'function') {
      clear();
      return clear;
    }
    // Read `getBoundingClientRect().height` (border-box) on every callback
    // rather than the entry's `contentRect`, for the reason DataLayers.tsx's
    // own comment gives: `contentRect` is the CONTENT box, and this element
    // carries `.banner`'s own 0.5rem/0.75rem padding, so the two differ.
    const publish = () => {
      root.style.setProperty('--sc-toast-height', `${el.getBoundingClientRect().height}px`);
    };
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    // The first ResizeObserver callback is queued for a later frame, not
    // delivered synchronously — measure once immediately too, or the
    // pre-paint window `useLayoutEffect` exists to close reopens here.
    publish();
    return () => {
      ro.disconnect();
      clear();
    };
    // `needRefresh`/`offlineReady` rather than the derived `active` alone:
    // the two branches below render different `role`s at the same JSX
    // position, so React may update that node in place — re-running on
    // either flag keeps the observed element and the published height in
    // step regardless of how it reconciles.
  }, [active, needRefresh, offlineReady]);
  return toastRef;
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
  const toastRef = useToastHeight(needRefresh, offlineReady);

  if (needRefresh) {
    return (
      <div role="alert" className="banner banner-info reload-prompt" ref={toastRef}>
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
      <div role="status" className="banner banner-info reload-prompt" ref={toastRef}>
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
