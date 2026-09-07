import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EndpointMarkers from './EndpointMarkers';
import { de } from '../i18n/dict.de';
import { makeFakeMap } from '../test/fakeMaplibre';
import type { PickedPoint } from '../types';

// #1020: before this fix, a map-picked origin/destination rendered NO
// marker at all — this file mirrors ViaMarkers.test.tsx's fake-`Marker`
// pattern (jsdom has no MapLibre/WebGL runtime, so the component's own
// construct/rebuild/teardown logic is exercised against a recording fake,
// never against real rendering — real visual correctness needs a
// real-browser pass, this repo's `verify` skill).

interface RecordedMarker {
  element: HTMLElement;
  setLngLatCalls: [number, number][];
  addToMap: unknown;
  removed: boolean;
}

const hoisted = vi.hoisted(() => ({
  map: null as unknown,
  createdMarkers: [] as RecordedMarker[],
}));

vi.mock('maplibre-gl', () => ({
  Marker: class {
    element: HTMLElement;
    setLngLatCalls: [number, number][] = [];
    addToMap: unknown = undefined;
    removed = false;
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
      hoisted.createdMarkers.push(this as unknown as RecordedMarker);
    }
    setLngLat(coords: [number, number]) {
      this.setLngLatCalls.push(coords);
      return this;
    }
    addTo(map: unknown) {
      this.addToMap = map;
      return this;
    }
    remove() {
      this.removed = true;
    }
  },
}));

vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

const createdMarkers = hoisted.createdMarkers;

const origin: PickedPoint = {
  source: 'harbor',
  point: { lat: 54.512345, lon: 9.876543 },
  harborId: 'langballigau',
  label: 'Langballigau',
};
const destination: PickedPoint = {
  source: 'tap',
  point: { lat: 54.7, lon: 10.2 },
  label: '54.700°N 10.200°E',
};

beforeEach(() => {
  createdMarkers.length = 0;
  hoisted.map = null;
});

afterEach(() => {
  cleanup();
});

describe('EndpointMarkers null-map render phase (#1020)', () => {
  it('creates no markers before the map instance exists, and builds them once it does', () => {
    const { rerender } = render(<EndpointMarkers origin={origin} destination={destination} />);
    expect(createdMarkers).toHaveLength(0);

    hoisted.map = makeFakeMap();
    rerender(<EndpointMarkers origin={origin} destination={destination} />);
    expect(createdMarkers).toHaveLength(2);
    expect(createdMarkers[0]!.addToMap).toBe(hoisted.map);
  });
});

describe('EndpointMarkers presence (#1020)', () => {
  it('renders no marker at all when both origin and destination are null', () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={null} destination={null} />);
    expect(createdMarkers).toHaveLength(0);
  });

  it('renders exactly one marker for a lone origin, none for a null destination', () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={origin} destination={null} />);
    expect(createdMarkers).toHaveLength(1);
    expect(createdMarkers[0]!.element.className).toBe(
      'sc-endpoint-marker sc-endpoint-marker-origin',
    );
  });

  it('renders exactly one marker for a lone destination, none for a null origin', () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={null} destination={destination} />);
    expect(createdMarkers).toHaveLength(1);
    expect(createdMarkers[0]!.element.className).toBe(
      'sc-endpoint-marker sc-endpoint-marker-destination',
    );
  });
});

describe('EndpointMarkers construction coordinates (#1020)', () => {
  it('passes origin/destination to setLngLat as [lon, lat], never swapped', () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={origin} destination={destination} />);

    expect(createdMarkers).toHaveLength(2);
    // origin is built before destination — see the component's own
    // `points` array literal order.
    expect(createdMarkers[0]!.setLngLatCalls[0]).toEqual([9.876543, 54.512345]);
    expect(createdMarkers[1]!.setLngLatCalls[0]).toEqual([10.2, 54.7]);
  });
});

describe('EndpointMarkers mutual distinguishability (#1020)', () => {
  it('gives origin and destination different CSS classes and shapes, never relying on colour alone', () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={origin} destination={destination} />);
    const [originMarker, destinationMarker] = createdMarkers as [RecordedMarker, RecordedMarker];

    expect(originMarker.element.className).toBe('sc-endpoint-marker sc-endpoint-marker-origin');
    expect(destinationMarker.element.className).toBe(
      'sc-endpoint-marker sc-endpoint-marker-destination',
    );
    // Circle vs rounded square — a shape distinction independent of colour.
    expect(originMarker.element.style.borderRadius).toBe('50%');
    expect(destinationMarker.element.style.borderRadius).toBe('3px');
    expect(originMarker.element.style.background).not.toBe(
      destinationMarker.element.style.background,
    );
  });
});

describe('EndpointMarkers accessibility contract (#1020)', () => {
  it("builds the aria-label from the target's translated role label and the point's own label", () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={origin} destination={destination} />);
    const [originMarker, destinationMarker] = createdMarkers as [RecordedMarker, RecordedMarker];

    const expectedOriginLabel = de['map.endpoint.ariaLabel']
      .replace('{target}', de['planner.origin.label'])
      .replace('{label}', origin.label);
    const expectedDestinationLabel = de['map.endpoint.ariaLabel']
      .replace('{target}', de['planner.destination.label'])
      .replace('{label}', destination.label);

    expect(originMarker.element.getAttribute('aria-label')).toBe(expectedOriginLabel);
    expect(destinationMarker.element.getAttribute('aria-label')).toBe(expectedDestinationLabel);
  });
});

// #947-style visible-label coverage, same rationale as ViaMarkers.test.tsx's
// own block: jsdom computes no layout/paint, so this proves the label node
// and its text exist in the tree, not that it is legible or positioned
// correctly on screen.
describe('EndpointMarkers visible label (#1020)', () => {
  it('renders the aria-label text visibly on the marker element, hidden from assistive tech', () => {
    hoisted.map = makeFakeMap();
    render(<EndpointMarkers origin={origin} destination={null} />);
    const [marker] = createdMarkers as [RecordedMarker];

    const expectedLabel = de['map.endpoint.ariaLabel']
      .replace('{target}', de['planner.origin.label'])
      .replace('{label}', origin.label);
    expect(marker.element.textContent).toBe(expectedLabel);
    const labelEl = marker.element.querySelector('.sc-endpoint-marker-label');
    expect(labelEl).not.toBeNull();
    expect(labelEl?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('EndpointMarkers rebuild on a pick change (#1020)', () => {
  it('tears down the existing marker and rebuilds when origin changes', () => {
    hoisted.map = makeFakeMap();
    const { rerender } = render(<EndpointMarkers origin={origin} destination={null} />);
    expect(createdMarkers).toHaveLength(1);
    const original = createdMarkers[0]!;

    const movedOrigin: PickedPoint = { source: 'tap', point: { lat: 55.0, lon: 10.5 }, label: 'x' };
    rerender(<EndpointMarkers origin={movedOrigin} destination={null} />);

    expect(original.removed).toBe(true);
    expect(createdMarkers).toHaveLength(2);
    expect(createdMarkers[1]!.removed).toBe(false);
    expect(createdMarkers[1]!.setLngLatCalls[0]).toEqual([10.5, 55.0]);
  });

  it('removes markers when origin/destination are cleared to null', () => {
    hoisted.map = makeFakeMap();
    const { rerender } = render(<EndpointMarkers origin={origin} destination={destination} />);
    expect(createdMarkers).toHaveLength(2);
    const [first, second] = createdMarkers as [RecordedMarker, RecordedMarker];

    rerender(<EndpointMarkers origin={null} destination={null} />);

    expect(first.removed).toBe(true);
    expect(second.removed).toBe(true);
  });

  it('removes every marker on unmount', () => {
    hoisted.map = makeFakeMap();
    const { unmount } = render(<EndpointMarkers origin={origin} destination={destination} />);
    expect(createdMarkers).toHaveLength(2);
    unmount();
    expect(createdMarkers.every((m) => m.removed)).toBe(true);
  });
});
