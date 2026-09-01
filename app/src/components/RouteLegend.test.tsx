import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import RouteLegend from './RouteLegend';
import { en } from '../i18n/dict.en';

afterEach(() => {
  cleanup();
  localStorage.clear();
  // RouteLegend reads `window.matchMedia` directly (its own
  // `isWideAtMount()`, deliberately not `useWideLayout()` — see that file's
  // comment for why) — any test that stubs it must not leak the stub into a
  // later test relying on jsdom's matchMedia-less default (narrow). Same
  // afterEach convention as RouteLayer.test.tsx, which stubs the same
  // global for a different reason.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function renderLegend() {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <RouteLegend />
    </I18nProvider>,
  );
}

// #813 fix-wave MAJOR 1: minimal stand-in for RouteLayer.test.tsx's own
// `setMatchMedia` helper — this file only needs the INITIAL `matches` read
// (RouteLegend's own default-open state is computed once at mount via a
// lazy `useState` initializer, never re-read), so the change-listener
// plumbing that helper carries for rotation tests is not needed here.
function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: '(min-width: 1024px)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

describe('RouteLegend', () => {
  // #813 fix-wave MAJOR 1: jsdom has no `matchMedia` (src/test/setup.ts does
  // not stub it globally), and isWideAtMount()'s own `typeof
  // window.matchMedia === 'function'` guard is to default to the NARROW
  // layout whenever it is absent — so this render exercises the narrow
  // branch, which is exactly the one Major 1 changed.
  // Renamed from "collapsed by default" now that narrow's default is
  // OPEN — see RouteLegend.tsx's own #813 fix-wave comment for why.
  it('renders a details that is OPEN by default on narrow (no matchMedia, #813 fix-wave)', () => {
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText('Legend')).toBeInTheDocument();
  });

  // #813 fix-wave MAJOR 1: the WIDE default is UNCHANGED by this fix — this
  // file's own header comment has always said "Default-collapsed — cockpit
  // pixels are expensive", and that stays true on wide (which has room to
  // spare); only narrow's default moved.
  it('stays collapsed by default on wide layouts (matchMedia reports wide)', () => {
    stubMatchMedia(true);
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend');
    expect((details as HTMLDetailsElement).open).toBe(false);
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

  it('expands and collapses when the summary is toggled (starting from the wide, closed default)', () => {
    // #813 fix-wave MAJOR 1: pinned at WIDE so this test's own initial-state
    // assumption (closed) stays independent of Major 1's narrow-only change
    // — the toggle MECHANISM this test exists to cover is identical either
    // way; only the resting state differs, and that is now covered by the
    // two dedicated tests above.
    stubMatchMedia(true);
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

// #681 x #813 review Major: RouteLegend.tsx's own hatch checkbox carries the
// SAME `disabled={!depthVisible}` mirror as DataLayers.tsx's copy (the #384
// defect class — a control must not offer to change a layer that
// depthVisible=false already keeps invisible regardless), but nothing
// exercised it on THIS surface: the two DataLayers.test.tsx cross-surface
// sync tests assert `checked` and layer visibility, never `.disabled`, and
// no test here touched the checkbox at all. Reads/writes `sc-depth-visible`
// directly via localStorage — the same contract `usePersistedToggle` itself
// uses — rather than needing AppStateProvider/DataLayers, since this
// component never reads Settings context for that flag.
describe('#681 x #813: hatch checkbox disabled mirror (RouteLegend surface)', () => {
  it('disables the hatch checkbox when the base depth-overlay flag is off', () => {
    localStorage.setItem('sc-depth-visible', '0');
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend') as HTMLDetailsElement;
    details.open = true;
    const checkbox = container.querySelector(
      '.route-legend-depth input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('enables the hatch checkbox when the base depth-overlay flag is on', () => {
    localStorage.setItem('sc-depth-visible', '1');
    const { container } = renderLegend();
    const details = container.querySelector('details.route-legend') as HTMLDetailsElement;
    details.open = true;
    const checkbox = container.querySelector(
      '.route-legend-depth input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });
});
