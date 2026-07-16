import { useRegisterSW } from 'virtual:pwa-register/react';
import { useT } from '../i18n';

// Reuses Banner's .banner-* CSS classes for visual consistency with the
// rest of banner-area, but isn't <Banner> itself: the needRefresh state
// needs a real, labeled "Reload" action (not Banner's dismiss-only ×
// slot), and offlineReady is a one-shot toast that self-dismisses once
// and never reappears (workbox only flips offlineReady true once, on the
// precache install that follows this page's own SW registration).
export default function ReloadPrompt() {
  const t = useT();
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swScriptUrl, registration) {
      // Deliberate update checks on good connectivity only. registerType
      // 'prompt' (vite.config.ts) already rules out autoUpdate reloading
      // mid-passage-planning; this only decides *when* the app bothers to
      // ask the browser whether a newer SW exists — on window focus, and
      // only while online, so a check never fires against a forecast-only
      // offline session.
      window.addEventListener('focus', () => {
        if (navigator.onLine) void registration?.update();
      });
    },
  });

  if (needRefresh) {
    return (
      <div role="alert" className="banner banner-info reload-prompt">
        <span className="banner-message">{t('pwa.updateAvailable')}</span>
        <button type="button" className="reload-prompt-action" onClick={() => void updateServiceWorker(true)}>
          {t('pwa.reload')}
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
