import { describe, it, expect, vi, afterEach } from 'vitest';
import { collapseAttributionUnderBottomSheet } from './MapView';

// MapView.tsx registers the pmtiles protocol against the real maplibre-gl at
// module load; stub the module so importing the collapse helper stays free of
// MapLibre's runtime (mirrors App.test.tsx's wholesale mock — jsdom has no
// WebGL). Only what MapView.tsx itself imports needs to exist here.
vi.mock('maplibre-gl', () => ({
  Map: class {},
  AttributionControl: class {},
  addProtocol: vi.fn(),
}));

// Unit coverage for the #33 collapse logic itself (one-shot semantics, wide-
// layout gate, disposer). The honest end-to-end proof — a real MapLibre
// attribution control collapsed at load with the Plan button clickable —
// lives in e2e/plan.spec.ts.

/** MapLibre 5.x auto-expansion: compact + compact-show land in one call. */
function simulateAutoExpansion(attrib: HTMLElement) {
  attrib.classList.remove('maplibregl-attrib-empty');
  attrib.setAttribute('open', '');
  attrib.classList.add('maplibregl-compact', 'maplibregl-compact-show');
}

/** MutationObserver callbacks are microtasks; drain them. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeMapContainer(): { container: HTMLElement; attrib: HTMLElement } {
  const container = document.createElement('div');
  const attrib = document.createElement('details');
  attrib.className = 'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-attrib-empty';
  container.appendChild(attrib);
  return { container, attrib };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('collapseAttributionUnderBottomSheet', () => {
  it('collapses the auto-expansion (removes only maplibregl-compact-show)', async () => {
    const { container, attrib } = makeMapContainer();
    collapseAttributionUnderBottomSheet(container);

    simulateAutoExpansion(attrib);
    await flushMicrotasks();

    expect(attrib.classList.contains('maplibregl-compact-show')).toBe(false);
    // Compact mode itself must survive — that's what keeps it collapsed.
    expect(attrib.classList.contains('maplibregl-compact')).toBe(true);
  });

  it('collapses immediately when already expanded at call time', () => {
    const { container, attrib } = makeMapContainer();
    simulateAutoExpansion(attrib);

    collapseAttributionUnderBottomSheet(container);

    expect(attrib.classList.contains('maplibregl-compact-show')).toBe(false);
  });

  it('is one-shot: a later (user) expansion is left alone', async () => {
    const { container, attrib } = makeMapContainer();
    collapseAttributionUnderBottomSheet(container);
    simulateAutoExpansion(attrib);
    await flushMicrotasks();

    // The user taps the toggle button -> MapLibre re-adds compact-show.
    attrib.classList.add('maplibregl-compact-show');
    await flushMicrotasks();

    expect(attrib.classList.contains('maplibregl-compact-show')).toBe(true);
  });

  it('keeps upstream behavior (expanded until drag) on the wide side-panel layout', async () => {
    // jsdom has no matchMedia — stub the wide-layout answer.
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true } as MediaQueryList));
    const { container, attrib } = makeMapContainer();
    collapseAttributionUnderBottomSheet(container);

    simulateAutoExpansion(attrib);
    await flushMicrotasks();

    expect(attrib.classList.contains('maplibregl-compact-show')).toBe(true);
  });

  it('stops observing once disposed (unmount before the map ever expanded)', async () => {
    const { container, attrib } = makeMapContainer();
    const dispose = collapseAttributionUnderBottomSheet(container);
    dispose();

    simulateAutoExpansion(attrib);
    await flushMicrotasks();

    expect(attrib.classList.contains('maplibregl-compact-show')).toBe(true);
  });

  it('no-ops on a container without an attribution control', () => {
    const container = document.createElement('div');
    expect(() => collapseAttributionUnderBottomSheet(container)()).not.toThrow();
  });
});
