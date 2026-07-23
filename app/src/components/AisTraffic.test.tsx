import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { I18nProvider } from '../i18n';
import { AisStatusChip } from './AisTraffic';
import type { AisStatus } from '../state/useAisTraffic';

function renderChip(
  status: AisStatus,
  opts: {
    targetCount?: number;
    routeActive?: boolean;
    routeCount?: number;
    lang?: 'en' | 'de';
  } = {},
) {
  const { targetCount = 0, routeActive = false, routeCount = 0, lang = 'en' } = opts;
  localStorage.setItem('sc-lang', lang);
  render(
    <I18nProvider>
      <AisStatusChip
        status={status}
        targetCount={targetCount}
        routeActive={routeActive}
        routeCount={routeCount}
      />
    </I18nProvider>,
  );
}

describe('AisStatusChip', () => {
  it('renders the off state with the enable hint', () => {
    renderChip('off');
    expect(screen.getByText('AIS off — add a key in Options')).toBeInTheDocument();
  });

  it('renders the connecting state', () => {
    renderChip('connecting');
    expect(screen.getByText('AIS connecting…')).toBeInTheDocument();
  });

  it('renders the live state with the target count', () => {
    renderChip('live', { targetCount: 7 });
    expect(screen.getByText('AIS live · 7 vessels')).toBeInTheDocument();
  });

  it('renders the offline state', () => {
    renderChip('offline');
    expect(screen.getByText('AIS offline')).toBeInTheDocument();
  });

  it('renders the key-error state', () => {
    renderChip('keyError');
    expect(screen.getByText('AIS: check your API key')).toBeInTheDocument();
  });

  it('carries a status-specific class for styling', () => {
    renderChip('live', { targetCount: 3 });
    expect(screen.getByText('AIS live · 3 vessels')).toHaveClass('ais-status-live');
  });

  it('splits the live count while a route is active (en)', () => {
    renderChip('live', { targetCount: 7, routeActive: true, routeCount: 3 });
    // Full literal pinned against the dict string, not a re-interpolation of
    // the code under test — the "vessels" noun is test-enforced (#146 OQ1).
    expect(screen.getByText('AIS live · 7 vessels (3 along route)')).toBeInTheDocument();
  });

  it('splits the live count while a route is active (de)', () => {
    renderChip('live', { targetCount: 7, routeActive: true, routeCount: 3, lang: 'de' });
    expect(screen.getByText('AIS live · 7 Schiffe (3 entlang Route)')).toBeInTheDocument();
  });

  it('shows the plain count without a route (en)', () => {
    renderChip('live', { targetCount: 7, routeActive: false });
    const chip = screen.getByText('AIS live · 7 vessels');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).not.toContain('along route');
  });

  it('shows the plain count without a route (de)', () => {
    renderChip('live', { targetCount: 7, routeActive: false, lang: 'de' });
    const chip = screen.getByText('AIS live · 7 Schiffe');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).not.toContain('entlang Route');
  });
});
