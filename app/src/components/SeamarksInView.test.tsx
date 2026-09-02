import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeamarkFeatureCollection } from '../lib/seamarkGeoJson';
import { SEAMARKS_IN_VIEW_MAX } from '../lib/seamarksInView';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { MAP_VIEWPORT_SETTLE_MS } from '../state/useMapViewport';
import type { SeamarkProperties } from '../types';

// #830: the keyboard-reachable "seamarks in view" list — the panel-hosted
// DOM equivalent of DataLayers.tsx's pointer-only seamark click. jsdom has
// no MapLibre runtime, so the map is a hand-rolled fake exposing exactly
// what the component reads (bounds, moveend subscription) and the
// popup is the same recording `Popup` mock DataLayers.test.tsx uses.
// Copy assertions type the German literals by hand (never read from the
// dict) — the repo's dict-independence rule for a copy pin.

interface PopupRecord {
  options: unknown;
  lngLat: unknown;
  container: HTMLElement | undefined;
  addedTo: unknown;
  removed: boolean;
}

const popups = vi.hoisted(() => ({ created: [] as PopupRecord[] }));

vi.mock('maplibre-gl', () => ({
  Popup: class {
    rec: PopupRecord;
    constructor(options: unknown) {
      this.rec = {
        options,
        lngLat: undefined,
        container: undefined,
        addedTo: undefined,
        removed: false,
      };
      popups.created.push(this.rec);
    }
    setLngLat(lngLat: unknown) {
      this.rec.lngLat = lngLat;
      return this;
    }
    setDOMContent(container: HTMLElement) {
      this.rec.container = container;
      return this;
    }
    addTo(map: unknown) {
      this.rec.addedTo = map;
      return this;
    }
    remove() {
      this.rec.removed = true;
    }
  },
}));

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));
vi.mock('../state/useSeamarks', () => ({ useSeamarks: vi.fn(() => null) }));
import { useSeamarks } from '../state/useSeamarks';
import SeamarksInView from './SeamarksInView';

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type Handler = () => void;

function makeViewportMap(initial: Bounds) {
  let bounds = initial;
  const handlers = new Map<string, Set<Handler>>();
  const map = {
    on: vi.fn((type: string, fn: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
      return map;
    }),
    off: vi.fn((type: string, fn: Handler) => {
      handlers.get(type)?.delete(fn);
      return map;
    }),
    getBounds: () => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    }),
    moveTo(next: Bounds) {
      bounds = next;
      handlers.get('moveend')?.forEach((fn) => fn());
    },
    listenerCount(type: string) {
      return handlers.get(type)?.size ?? 0;
    },
  };
  return map;
}

const VIEW_A: Bounds = { west: 10.0, south: 54.8, east: 10.2, north: 54.9 };
const VIEW_EMPTY: Bounds = { west: 9.0, south: 54.0, east: 9.1, north: 54.1 };

type FeatureLike = SeamarkFeatureCollection['features'][number];

function pt(lon: number, lat: number, props: SeamarkProperties): FeatureLike {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: props,
  };
}

function fc(features: FeatureLike[]): SeamarkFeatureCollection {
  return { type: 'FeatureCollection', features };
}

// Three inside VIEW_A (indices 0-2), two outside (3-4). Nearest-first order
// inside VIEW_A is 1 (centre), 0, 2.
const FIXTURE = fc([
  pt(10.12, 54.85, { seamarkType: 'buoy_cardinal', category: 'north', colour: 'black;yellow' }),
  pt(10.1, 54.85, { seamarkType: 'buoy_lateral', category: 'port' }),
  pt(10.19, 54.89, { seamarkType: 'light_minor' }),
  pt(10.3, 54.85, { seamarkType: 'buoy_lateral', category: 'starboard' }),
  pt(9.9, 54.85, { seamarkType: 'buoy_cardinal', category: 'south' }),
]);

let slot: HTMLDivElement;
let map: ReturnType<typeof makeViewportMap>;

function details(): HTMLDetailsElement | null {
  return slot.querySelector('details.seamarks-in-view');
}

function rowButtons(): HTMLButtonElement[] {
  return Array.from(slot.querySelectorAll<HTMLButtonElement>('button[data-seamark-key]'));
}

function rowKeys(): string[] {
  return rowButtons().map((b) => b.getAttribute('data-seamark-key') ?? '');
}

function note(): string | null {
  return slot.querySelector('.seamarks-in-view-note')?.textContent ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  // The layer is opt-in (#7, default OFF); most rows below want it ON.
  localStorage.setItem('sc-seamarks-visible', '1');
  popups.created.length = 0;
  map = makeViewportMap(VIEW_A);
  hoisted.map = map;
  vi.mocked(useSeamarks).mockReturnValue(FIXTURE);
  slot = document.createElement('div');
  document.body.append(slot);
});

afterEach(() => {
  slot.remove();
  vi.mocked(useSeamarks).mockReturnValue(null);
  hoisted.map = null;
  localStorage.clear();
  vi.useRealTimers();
});

describe('SeamarksInView (#830)', () => {
  it('portals a collapsed Disclosure into the panel slot whose summary carries the in-view count', () => {
    render(<SeamarksInView panelSlot={slot} />);
    const el = details();
    expect(el).not.toBeNull();
    expect(el!.open).toBe(false);
    expect(el!.querySelector('summary')?.textContent).toBe(
      'Schifffahrtszeichen im Kartenausschnitt (3)',
    );
  });

  it('renders nothing at all without a panel slot', () => {
    const { container } = render(<SeamarksInView panelSlot={null} />);
    expect(container.innerHTML).toBe('');
    expect(slot.innerHTML).toBe('');
  });

  it('renders one native <button> row per mark inside the viewport, nearest-first, keyed by collection index, and none for marks outside it', () => {
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowKeys()).toEqual(['1', '0', '2']);
    for (const b of rowButtons()) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      expect(b.tabIndex).toBe(0);
    }
    // MUTATION (bounds filter -> return all): keys gain '3' and '4' — reds.
  });

  it('a row reads as the popover would: the type first, then each further row as "label: value"', () => {
    render(<SeamarksInView panelSlot={slot} />);
    const cardinal = rowButtons().find((b) => b.dataset.seamarkKey === '0');
    expect(cardinal?.textContent).toBe('Kardinaltonne · Kategorie: Nord · Farbe: Schwarz Gelb');
    const lateral = rowButtons().find((b) => b.dataset.seamarkKey === '1');
    expect(lateral?.textContent).toMatch(/^Lateraltonne · Kategorie: /);
    // Every row is described by the one hint sentence (nearest-first order
    // + what activation does), so a screen reader announces it once per row.
    const hint = slot.querySelector('.seamarks-in-view-hint');
    expect(hint?.id).toBeTruthy();
    for (const b of rowButtons()) expect(b.getAttribute('aria-describedby')).toBe(hint!.id);
  });

  it('renders the empty note (and no rows) when nothing is in view', () => {
    map = makeViewportMap(VIEW_EMPTY);
    hoisted.map = map;
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowButtons()).toHaveLength(0);
    expect(note()).toBe('Keine Seezeichen im aktuellen Kartenausschnitt.');
    expect(details()!.querySelector('summary')?.textContent).toBe(
      'Schifffahrtszeichen im Kartenausschnitt (0)',
    );
  });

  it('with the seamark layer OFF (the #7 default) it renders the layer-off note and NO rows, even with marks in view', () => {
    localStorage.removeItem('sc-seamarks-visible');
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowButtons()).toHaveLength(0);
    expect(note()).toBe(
      'Die Seezeichen-Ebene ist ausgeblendet. Zum Auflisten das Kontrollkästchen „Seezeichen“ auf der Karte einschalten.',
    );
    expect(details()!.querySelector('summary')?.textContent).toBe(
      'Schifffahrtszeichen im Kartenausschnitt',
    );
  });

  it('follows the layer toggle LIVE when a sibling instance of the same persisted key switches it on (#681 sync)', () => {
    localStorage.removeItem('sc-seamarks-visible');
    render(<SeamarksInView panelSlot={slot} />);
    const toggle = renderHook(() => usePersistedToggle('sc-seamarks-visible', false));
    expect(rowButtons()).toHaveLength(0);
    act(() => toggle.result.current[1](true));
    expect(rowKeys()).toEqual(['1', '0', '2']);
  });

  it('renders the loading note while the seamark collection has not resolved', () => {
    vi.mocked(useSeamarks).mockReturnValue(null);
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowButtons()).toHaveLength(0);
    expect(note()).toBe('Seezeichen werden geladen …');
  });

  it('applies the persisted display tier the map layers use (BASE hides the STANDARD-tier light_minor)', () => {
    localStorage.setItem('sc-seamark-display-tier', '0');
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowKeys()).toEqual(['1', '0']);
  });

  it('SETTLE GATE: after moveend the rows stay put until MAP_VIEWPORT_SETTLE_MS elapses, then track the new viewport', () => {
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowKeys()).toEqual(['1', '0', '2']);
    act(() => map.moveTo(VIEW_EMPTY));
    expect(rowKeys()).toEqual(['1', '0', '2']);
    act(() => vi.advanceTimersByTime(MAP_VIEWPORT_SETTLE_MS - 1));
    expect(rowKeys()).toEqual(['1', '0', '2']);
    act(() => vi.advanceTimersByTime(1));
    expect(rowKeys()).toEqual([]);
    expect(note()).toBe('Keine Seezeichen im aktuellen Kartenausschnitt.');
    // And back, so the identity of the SET is what tracks (not just a count):
    act(() => map.moveTo({ west: 10.15, south: 54.8, east: 10.2, north: 54.9 }));
    act(() => vi.advanceTimersByTime(MAP_VIEWPORT_SETTLE_MS));
    expect(rowKeys()).toEqual(['2']);
    // MUTATION (gate deleted): the second `['1', '0', '2']` becomes [] — reds.
  });

  it('activating a row opens the seamark popup ON THE MAP at that mark, with the popover content, replacing any previous one', () => {
    render(<SeamarksInView panelSlot={slot} />);
    const lateral = rowButtons().find((b) => b.dataset.seamarkKey === '1')!;
    fireEvent.click(lateral);
    expect(popups.created).toHaveLength(1);
    const first = popups.created[0]!;
    expect(first.options).toEqual({
      closeButton: true,
      maxWidth: '240px',
      className: 'seamark-popup',
    });
    expect(first.lngLat).toEqual([10.1, 54.85]);
    expect(first.addedTo).toBe(map);
    expect(first.container?.className).toBe('seamark-popover');
    expect(first.container?.textContent).toContain('Typ: Lateraltonne');
    expect(first.container?.querySelector('.seamark-popover-disclaimer')).not.toBeNull();
    expect(first.removed).toBe(false);

    const cardinal = rowButtons().find((b) => b.dataset.seamarkKey === '0')!;
    fireEvent.click(cardinal);
    expect(popups.created).toHaveLength(2);
    expect(first.removed).toBe(true);
    expect(popups.created[1]!.lngLat).toEqual([10.12, 54.85]);
    expect(popups.created[1]!.container?.textContent).toContain('Typ: Kardinaltonne');
    // MUTATION (row onClick dropped): `popups.created` stays empty — reds.
  });

  it('caps the rows at SEAMARKS_IN_VIEW_MAX nearest marks and says how many are in view in total', () => {
    const many = fc(
      Array.from({ length: SEAMARKS_IN_VIEW_MAX + 10 }, (_, i) =>
        pt(10.1 + i * 0.001, 54.85, { seamarkType: 'buoy_lateral' }),
      ),
    );
    vi.mocked(useSeamarks).mockReturnValue(many);
    render(<SeamarksInView panelSlot={slot} />);
    expect(rowButtons()).toHaveLength(SEAMARKS_IN_VIEW_MAX);
    expect(rowKeys()[0]).toBe('0');
    expect(note()).toBe(
      `Nur die ${SEAMARKS_IN_VIEW_MAX} der Kartenmitte nächstgelegenen von ${SEAMARKS_IN_VIEW_MAX + 10} Seezeichen werden aufgeführt — hineinzoomen, um alle zu sehen.`,
    );
    expect(details()!.querySelector('summary')?.textContent).toBe(
      `Schifffahrtszeichen im Kartenausschnitt (${SEAMARKS_IN_VIEW_MAX + 10})`,
    );
  });

  it('unsubscribes from moveend and removes its own popup on unmount', () => {
    const { unmount } = render(<SeamarksInView panelSlot={slot} />);
    fireEvent.click(rowButtons()[0]!);
    expect(map.listenerCount('moveend')).toBe(1);
    unmount();
    expect(map.listenerCount('moveend')).toBe(0);
    expect(popups.created[0]!.removed).toBe(true);
  });
});
