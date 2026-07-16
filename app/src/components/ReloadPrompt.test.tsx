import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import ReloadPrompt from './ReloadPrompt';

// virtual:pwa-register/react is a build-time virtual module vite-plugin-pwa
// injects — it doesn't exist as a real package, so it can't be resolved (or
// meaningfully exercised: jsdom has no navigator.serviceWorker) outside an
// actual build. Mocked directly here, rather than relying on vite-plugin-
// pwa's own dev-mode no-op stub, so tests can drive
// needRefresh/offlineReady/updateServiceWorker deterministically.
const registerSWMock = vi.hoisted(() => ({
  offlineReady: false,
  needRefresh: false,
  updateServiceWorker: vi.fn(),
  setOfflineReady: vi.fn(),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    offlineReady: [registerSWMock.offlineReady, registerSWMock.setOfflineReady],
    needRefresh: [registerSWMock.needRefresh, vi.fn()],
    updateServiceWorker: registerSWMock.updateServiceWorker,
  }),
}));

afterEach(() => {
  cleanup();
  registerSWMock.offlineReady = false;
  registerSWMock.needRefresh = false;
  registerSWMock.updateServiceWorker.mockClear();
  registerSWMock.setOfflineReady.mockClear();
});

describe('ReloadPrompt', () => {
  it('renders nothing when there is no waiting update and no offline-ready state', () => {
    render(
      <I18nProvider>
        <ReloadPrompt />
      </I18nProvider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an update banner with a reload button when a waiting SW is detected, and triggers updateServiceWorker(true) on accept', () => {
    registerSWMock.needRefresh = true;
    render(
      <I18nProvider>
        <ReloadPrompt />
      </I18nProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(de['pwa.updateAvailable']);
    fireEvent.click(screen.getByRole('button', { name: de['pwa.reload'] }));
    expect(registerSWMock.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('shows a dismissible offline-ready toast once precaching completes', () => {
    registerSWMock.offlineReady = true;
    render(
      <I18nProvider>
        <ReloadPrompt />
      </I18nProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(de['pwa.offlineReady']);
    fireEvent.click(screen.getByRole('button', { name: de['banner.dismiss'] }));
    expect(registerSWMock.setOfflineReady).toHaveBeenCalledWith(false);
  });
});
