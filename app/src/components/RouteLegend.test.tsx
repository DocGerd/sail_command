import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import RouteLegend from './RouteLegend';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderLegend() {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <RouteLegend />
    </I18nProvider>,
  );
}

describe('RouteLegend', () => {
  it('renders a details that is collapsed by default', () => {
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText('Legend')).toBeInTheDocument();
  });

  it('lists the six route legend entries with their swatch spans', () => {
    const { container } = renderLegend();
    for (const label of [
      'Sail, starboard tack',
      'Sail, port tack',
      'Motor (engine only)',
      'Tack/gybe',
      'Heading change',
      'Via waypoint',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('.route-legend-swatch')).toHaveLength(6);
  });

  it('expands and collapses when the summary is toggled', () => {
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend') as HTMLDetailsElement;
    const summary = container.querySelector('summary') as HTMLElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });
});
