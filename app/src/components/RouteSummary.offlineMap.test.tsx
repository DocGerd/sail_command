import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import type { Plan } from '../types';
import type { RegionReadinessStatus, RegionReadinessView } from '../state/useRegionReadiness';
import { OfflineMapStatus } from './RouteSummary';

// #295: the readiness chip, driven by a stubbed hook (the hook itself is
// covered by useRegionReadiness.test.ts).
const view: { current: RegionReadinessView } = {
  current: { status: 'checking', canRetry: true, retry: () => {} },
};
vi.mock('../state/useRegionReadiness', () => ({
  useRegionReadiness: () => view.current,
}));
vi.mock('../state/useSeamarks', () => ({ useSeamarks: vi.fn(() => null) }));

const PLAN = { id: 'p1', createdAtMs: 1 } as unknown as Plan;

function renderStatus(status: RegionReadinessStatus, opts: { canRetry?: boolean } = {}) {
  const retry = vi.fn();
  view.current = { status, canRetry: opts.canRetry ?? true, retry };
  render(
    <I18nProvider>
      <OfflineMapStatus plan={PLAN} />
    </I18nProvider>,
  );
  return retry;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OfflineMapStatus (#295)', () => {
  it.each([
    ['checking', de['route.offlineMap.checking']],
    ['ready', de['route.offlineMap.ready']],
    ['pinning', de['route.offlineMap.pinning']],
    ['failed', de['route.offlineMap.failed']],
    ['not-ready', de['route.offlineMap.notReady']],
  ] as const)('%s renders its own copy in a status region', (status, text) => {
    renderStatus(status);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('only "ready" claims the map is saved', () => {
    for (const status of ['checking', 'pinning', 'failed', 'not-ready'] as const) {
      renderStatus(status);
      expect(screen.getByRole('status')).not.toHaveTextContent(de['route.offlineMap.ready']);
      cleanup();
    }
  });

  it.each(['failed', 'not-ready'] as const)('offers a retry when %s', (status) => {
    const retry = renderStatus(status);
    fireEvent.click(screen.getByRole('button', { name: de['route.offlineMap.retry'] }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each(['checking', 'ready', 'pinning'] as const)('offers no retry when %s', (status) => {
    renderStatus(status);
    expect(screen.queryByRole('button', { name: de['route.offlineMap.retry'] })).toBeNull();
  });

  it('offers no retry without a controlling service worker', () => {
    renderStatus('failed', { canRetry: false });
    expect(screen.queryByRole('button', { name: de['route.offlineMap.retry'] })).toBeNull();
  });

  it('offers no retry while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderStatus('failed');
    expect(screen.queryByRole('button', { name: de['route.offlineMap.retry'] })).toBeNull();
  });
});
