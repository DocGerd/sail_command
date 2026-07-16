import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n';
import { initSwRecovery } from './services/swRecovery';
import { scheduleGlyphWarmup } from './services/glyphWarmup';
import App from './App.tsx';
import './app.css';

// Best-effort: protects saved plans (IndexedDB) and the offline storage
// (~33 MB SW precache + up to ~11 MB glyph runtime cache, #28) from browser
// storage-pressure eviction. The browser may still deny the request (no
// prompt on most desktop browsers, and it's not guaranteed even when
// granted) — nothing here depends on it succeeding.
void navigator.storage?.persist?.();

// #27: arm the one-shot broken-pre-SW-map recovery before React renders,
// so its controllerchange listener exists before MapView can start
// erroring. Module-scope (not an effect): must run exactly once per page
// load, immune to StrictMode double-invocation.
initSwRecovery();

// #28: background glyph warm-up — fire-and-forget; it self-defers until
// the SW controls the page and the app is idle, skips silently when
// offline and with a console.warn when the manifest is unavailable. In
// dev it never starts at all: no SW registers, so it parks waiting for a
// controller that never arrives.
void scheduleGlyphWarmup();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
