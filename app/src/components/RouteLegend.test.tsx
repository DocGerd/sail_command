import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import RouteLegend from './RouteLegend';
import { en } from '../i18n/dict.en';

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

  it('pairs each legend label with its own swatch class in the same row', () => {
    renderLegend();
    // Label -> swatch class. Asserting the swatch sits in the SAME <li> as its
    // label catches a swapped starboard/port color (a mere count would not).
    const entries: [string, string][] = [
      ['Sail, starboard tack', 'route-legend-line-starboard'],
      ['Sail, port tack', 'route-legend-line-port'],
      ['Motor (engine only)', 'route-legend-line-motor'],
      ['Tack/gybe', 'route-legend-maneuver'],
      ['Heading change', 'route-legend-heading'],
      ['Waypoint', 'route-legend-via'],
    ];
    for (const [label, cls] of entries) {
      const li = screen.getByText(label).closest('li');
      expect(li).not.toBeNull();
      expect(li!.querySelector('.' + cls)).not.toBeNull();
    }
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

// #813: consolidation — DataLayers.tsx's own #598 depth-hatch legend is
// suppressed once a plan exists (DataLayers.test.tsx pins THAT half), and its
// content is folded in here instead, under its own sub-heading, so this
// disclosure is the SOLE "Legend" surface reachable while a plan is active.
// Asserts against the SHIPPED `en` dict strings directly (the same technique
// DataLayers.test.tsx already uses for this exact copy) rather than
// hardcoding a second copy of the text here — a real assertion that the
// #597 safety sentence survived the move byte-for-byte, not an inspection.
describe('#813: folded-in #598 depth-hatch legend', () => {
  it('carries the depth sub-heading, hatch swatch, basis and #597 caveat once opened', () => {
    const { container, getByText } = renderLegend();
    const details = container.querySelector('details.route-legend') as HTMLDetailsElement;
    details.open = true;
    expect(getByText(en['route.legend.depthHeading'])).toBeInTheDocument();
    expect(getByText(en['map.depth.legend.hatchLabel'])).toBeInTheDocument();
    expect(getByText(en['map.depth.legend.basis'])).toBeInTheDocument();
    // The #597 caveat this legend must keep reachable once a plan is active —
    // DataLayers.tsx's own `.depth-legend` is gone at that point, so this is
    // the only remaining surface for it.
    expect(getByText(en['map.depth.legend.caveat'])).toBeInTheDocument();
  });

  it('places the depth section inside its own container, distinct from the route swatch list', () => {
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend') as HTMLDetailsElement;
    details.open = true;
    const depthSection = container.querySelector('.route-legend-depth');
    expect(depthSection).not.toBeNull();
    expect(depthSection!.querySelector('.depth-legend-swatch')).not.toBeNull();
    // The route swatch <ul> is a SIBLING of the depth section, never nested
    // inside it — otherwise the two topics would visually run together,
    // exactly the "split mental model" complaint #813 exists to fix.
    expect(depthSection!.querySelector('ul')).toBeNull();
    const list = details.querySelector('ul');
    expect(list).not.toBeNull();
    expect(depthSection!.contains(list)).toBe(false);
  });
});
