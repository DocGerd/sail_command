import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n';
import App from './App.tsx';
import './app.css';

// Best-effort: protects saved plans (IndexedDB) and the ~30-40 MB offline
// cache (SW precache) from browser storage-pressure eviction. The browser
// may still deny the request (no prompt on most desktop browsers, and it's
// not guaranteed even when granted) — nothing here depends on it succeeding.
void navigator.storage?.persist?.();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
