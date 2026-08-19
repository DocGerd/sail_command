import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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
  setNeedRefresh: vi.fn(),
  // Captures the options object ReloadPrompt passes to useRegisterSW each
  // render, so tests can invoke callbacks (e.g. onRegisterError) directly —
  // there's no real SW registration to trigger them in jsdom.
  lastOptions: undefined as { onRegisterError?: (error: unknown) => void } | undefined,
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: { onRegisterError?: (error: unknown) => void }) => {
    registerSWMock.lastOptions = options;
    return {
      offlineReady: [registerSWMock.offlineReady, registerSWMock.setOfflineReady],
      needRefresh: [registerSWMock.needRefresh, registerSWMock.setNeedRefresh],
      updateServiceWorker: registerSWMock.updateServiceWorker,
    };
  },
}));

afterEach(() => {
  cleanup();
  registerSWMock.offlineReady = false;
  registerSWMock.needRefresh = false;
  registerSWMock.updateServiceWorker.mockClear();
  registerSWMock.setOfflineReady.mockClear();
  registerSWMock.setNeedRefresh.mockClear();
  registerSWMock.lastOptions = undefined;
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

  it('#441: the update banner has an independent dismiss control that clears local state without applying the update', () => {
    registerSWMock.needRefresh = true;
    render(
      <I18nProvider>
        <ReloadPrompt />
      </I18nProvider>,
    );
    const alert = screen.getByRole('alert');
    // Two distinct controls now share this banner (#441) — the reload
    // action from the test above, and this dismiss ×. Scoped to the alert
    // so a name collision with the (currently absent) offline-ready toast's
    // own dismiss button can never make this pass for the wrong reason.
    fireEvent.click(within(alert).getByRole('button', { name: de['banner.dismiss'] }));
    expect(registerSWMock.setNeedRefresh).toHaveBeenCalledWith(false);
    // SESSION-scoped, not "apply and reload": dismissing must never itself
    // trigger the update — that's the reload button's job alone. Reusing
    // the SAME `setNeedRefresh` mock also means this assertion could not
    // pass by accident if the dismiss button were wired to the reload
    // button's handler instead of its own.
    expect(registerSWMock.updateServiceWorker).not.toHaveBeenCalled();
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

  it('logs a console error when SW registration fails, instead of failing silently', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <I18nProvider>
        <ReloadPrompt />
      </I18nProvider>,
    );
    const registrationError = new Error('registration failed');
    registerSWMock.lastOptions?.onRegisterError?.(registrationError);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'SW registration failed — offline mode unavailable',
      registrationError,
    );
    consoleErrorSpy.mockRestore();
  });
});
