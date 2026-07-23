import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { I18nProvider } from '../i18n';
import { AisStatusChip } from './AisTraffic';
import type { AisStatus } from '../state/useAisTraffic';

function renderChip(status: AisStatus, targetCount = 0) {
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <AisStatusChip status={status} targetCount={targetCount} />
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
    renderChip('live', 7);
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
    renderChip('live', 3);
    expect(screen.getByText('AIS live · 3 vessels')).toHaveClass('ais-status-live');
  });
});
