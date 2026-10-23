import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import type { Plan } from '../types';
import { regionReadinessAndBytes } from '../services/regionPinning';
import LiveReadiness from './LiveReadiness';

vi.mock('../services/regionPinning', () => ({
  regionReadinessAndBytes: vi.fn(),
  pinRegionsForPlan: vi.fn(),
}));

const H = 3_600_000;
const T0 = 1_800_000_000_000;
const PLAN = {
  id: 'p1',
  createdAtMs: 1,
  request: { departureMs: T0 },
  windGrid: { timesMs: [T0, T0 + 6 * H] },
} as unknown as Plan;
const atT0 = () => T0;
const glyphsYes = () => Promise.resolve(true);
const DEPS = { now: atT0, glyphComplete: glyphsYes };

function renderPanel(lang: 'en' | 'de') {
  localStorage.setItem('sc-lang', lang);
  return render(
    <I18nProvider>
      <LiveReadiness
        plan={PLAN}
        arrivalMs={T0 + 2 * H}
        wakeLockSupported
        aisStatus="live"
        gpsDenied={false}
        deps={DEPS}
      />
    </I18nProvider>,
  );
}

describe('LiveReadiness (#1807)', () => {
  beforeEach(() => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue({
      readiness: { state: 'ready', done: 1, total: 1 },
      bytes: 0,
    });
    const perm = Object.assign(new EventTarget(), { state: 'granted' as PermissionState });
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: () => Promise.resolve(perm) },
    });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    Reflect.deleteProperty(navigator, 'permissions');
  });

  it('is collapsed by default and lists every check by label and state word', async () => {
    renderPanel('en');
    const details = document.querySelector('details.live-readiness') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await waitFor(() =>
      expect(screen.getByText('Pre-sail check: 6 of 6 ready')).toBeInTheDocument(),
    );
    const items = [...document.querySelectorAll('.live-readiness-item')];
    expect(items.map((li) => li.querySelector('.live-readiness-label')?.textContent)).toEqual([
      'Offline map',
      'Map labels',
      'Location',
      'Wind forecast',
      'Screen on',
      'AIS',
    ]);
    for (const li of items) {
      expect(li).toHaveClass('live-readiness-item--ok');
      expect(li.querySelector('.live-readiness-state')).toHaveTextContent('Ready');
    }
  });

  it('renders German copy', async () => {
    renderPanel('de');
    await waitFor(() =>
      expect(screen.getByText('Vor dem Ablegen: 6 von 6 bereit')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Bereit')).toHaveLength(6);
  });

  it('carries no live region, so it never collides with the card status regions', () => {
    renderPanel('en');
    const panel = document.querySelector('.live-readiness') as HTMLElement;
    expect(panel.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});
