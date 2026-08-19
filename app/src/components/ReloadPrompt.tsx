import { useRegisterSW } from 'virtual:pwa-register/react';
import { useT } from '../i18n';

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
