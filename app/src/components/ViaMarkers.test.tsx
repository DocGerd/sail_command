import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ViaMarkers from './ViaMarkers';
import { de } from '../i18n/dict.de';
import { makeFakeMap } from '../test/fakeMaplibre';
import type { LatLon } from '../types';

// #470: ViaMarkers was executed by nothing in the suite — RouteLayer.test.tsx
// loads it (its only importer), but that file's own `maplibre-gl` mock is a
// no-op `Marker` that records nothing, and every RouteLayer test that reaches
// it passes an EMPTY `draftViaPoints`, so no marker was ever constructed
// under any existing test run. This file exercises exactly the three things
// #470 named as still unasserted after the #571 redesign made ViaMarkers
// reachable via the integration path: construction coordinates, the marker
// element's accessibility contract, and both `snapBack` branches (dragend
// rejected, dragend rejected-promise) — plus the null-map render phase
// (ViaMarkers renders before `MapView`'s Map instance exists; `useMapInstance()`
// returns null until then, mirroring the RouteLayer null-render-phase lesson
// in CLAUDE.md: a component that skips work on a null dependency needs a test
// that renders it in THAT phase and then transitions, not just steady state).

// Recording `Marker` fake (BoatMarker.test.tsx's pattern, `test/fakeMaplibre.ts`'s
// header note: jsdom has no MapLibre/WebGL runtime, so map CHILDREN are
// exercised against fakes for their own logic, never against real rendering).
// `getLngLat()`/`setLngLat()` use maplibre's real field names (`lng`, not
// `lon`) so a lat/lng transposition bug in ViaMarkers.tsx would be caught
// rather than silently matched by a same-named fake field.
//
// The class is defined INSIDE the `vi.mock` factory (not as a top-level
// declaration referenced from it) because `vi.mock` factories are hoisted
// above the rest of the module — a top-level `class`/`const` referenced from
// the factory throws "Cannot access '...' before initialization" (measured).
// `hoisted.createdMarkers` is the only channel the factory and the test body
// can safely share, per vitest's own `vi.hoisted` contract.
interface RecordedMarker {
  element: HTMLElement;
  draggable: boolean;
  setLngLatCalls: [number, number][];
  addToMap: unknown;
  removed: boolean;
  dragendHandler: (() => void) | null;
  draggedTo: { lat: number; lng: number } | null;
}

const hoisted = vi.hoisted(() => ({
  map: null as unknown,
  createdMarkers: [] as RecordedMarker[],
}));

vi.mock('maplibre-gl', () => ({
  Marker: class {
    element: HTMLElement;
    draggable: boolean;
    setLngLatCalls: [number, number][] = [];
    addToMap: unknown = undefined;
    removed = false;
    dragendHandler: (() => void) | null = null;
    draggedTo: { lat: number; lng: number } | null = null;
    constructor(opts: { element: HTMLElement; draggable?: boolean }) {
      this.element = opts.element;
      this.draggable = Boolean(opts.draggable);
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
    on(type: string, handler: () => void) {
      if (type === 'dragend') this.dragendHandler = handler;
      return this;
    }
    getLngLat() {
      if (!this.draggedTo) {
        throw new Error('test bug: set draggedTo before firing dragend');
      }
      return this.draggedTo;
    }
    remove() {
      this.removed = true;
    }
  },
}));

vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

const createdMarkers = hoisted.createdMarkers;

const noopDragEnd = () => Promise.resolve(true);

beforeEach(() => {
  createdMarkers.length = 0;
  hoisted.map = null;
});

afterEach(() => {
  cleanup();
});

describe('ViaMarkers null-map render phase', () => {
  it('creates no markers before the map instance exists, and builds them once it does (#470)', () => {
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    const { rerender } = render(
      <ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />,
    );
    expect(createdMarkers).toHaveLength(0);

    hoisted.map = makeFakeMap();
    rerender(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);
    expect(createdMarkers).toHaveLength(1);
    expect(createdMarkers[0]!.addToMap).toBe(hoisted.map);
  });
});

describe('ViaMarkers construction coordinates (#470)', () => {
  it('passes each via point to setLngLat as [lon, lat], in list order, never swapped', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [
      { lat: 54.512345, lon: 9.876543 },
      { lat: 54.6, lon: 10.1 },
    ];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    expect(createdMarkers).toHaveLength(2);
    expect(createdMarkers[0]!.setLngLatCalls[0]).toEqual([9.876543, 54.512345]);
    expect(createdMarkers[1]!.setLngLatCalls[0]).toEqual([10.1, 54.6]);
  });

  it('marks every marker draggable', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    expect(createdMarkers[0]!.draggable).toBe(true);
  });
});

describe('ViaMarkers marker accessibility contract (#470)', () => {
  it('gives each marker element role=button, tabIndex=0 and an index-based aria-label', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [
      { lat: 54.5, lon: 10.0 },
      { lat: 54.6, lon: 10.1 },
    ];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    expect(createdMarkers).toHaveLength(2);
    const [first, second] = createdMarkers as [RecordedMarker, RecordedMarker];

    expect(first.element.getAttribute('role')).toBe('button');
    expect(first.element.tabIndex).toBe(0);
    expect(first.element.className).toBe('sc-via-marker');
    expect(first.element.getAttribute('aria-label')).toBe(
      de['planner.via.marker'].replace('{index}', '1'),
    );
    expect(second.element.getAttribute('aria-label')).toBe(
      de['planner.via.marker'].replace('{index}', '2'),
    );
  });
});

describe('ViaMarkers rebuild on a draft change (#470)', () => {
  it('tears down every existing marker and rebuilds from the new via list', () => {
    hoisted.map = makeFakeMap();
    const first: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    const { rerender } = render(
      <ViaMarkers viaPoints={first} replanning={false} onDragEnd={noopDragEnd} />,
    );
    expect(createdMarkers).toHaveLength(1);
    const original = createdMarkers[0]!;

    const next: LatLon[] = [
      { lat: 54.5, lon: 10.0 },
      { lat: 54.7, lon: 10.2 },
    ];
    rerender(<ViaMarkers viaPoints={next} replanning={false} onDragEnd={noopDragEnd} />);

    expect(original.removed).toBe(true);
    expect(createdMarkers).toHaveLength(3);
    expect(createdMarkers[1]!.removed).toBe(false);
    expect(createdMarkers[2]!.removed).toBe(false);
  });

  it('removes every marker on unmount', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [
      { lat: 54.5, lon: 10.0 },
      { lat: 54.7, lon: 10.2 },
    ];
    const { unmount } = render(
      <ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />,
    );
    expect(createdMarkers).toHaveLength(2);
    unmount();
    expect(createdMarkers.every((m) => m.removed)).toBe(true);
  });
});

describe('ViaMarkers dragend / snapBack branches (#470)', () => {
  // Multiple `await Promise.resolve()` ticks flush the `.then(cb).catch(cb2)`
  // chain `dragendHandler` fires without a fixed-time wait (the E2E-style
  // "no waitForTimeout as a sync wait" rule generalised to a promise chain —
  // no numeric `timeout:` literal appears anywhere in this file, keeping
  // `timeoutGuard.test.ts` clean).
  async function fireDragendAndFlush(marker: RecordedMarker) {
    await act(async () => {
      marker.dragendHandler?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('reports the dragged-to position via onDragEnd with lat/lon correctly mapped from lat/lng, and does not snap back once accepted', async () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    const onDragEnd = vi.fn().mockResolvedValue(true);
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={onDragEnd} />);
    const marker = createdMarkers[0]!;
    // lat !== lng here so a `{ lat: lngLat.lng, lon: lngLat.lat }` transposition
    // bug would be caught, not silently matched.
    marker.draggedTo = { lat: 54.55, lng: 10.05 };

    await fireDragendAndFlush(marker);

    expect(onDragEnd).toHaveBeenCalledWith(0, { lat: 54.55, lon: 10.05 });
    // Only the original construction call — accepted means no snapBack.
    expect(marker.setLngLatCalls).toHaveLength(1);
  });

  it('snaps back to the ORIGINAL construction position when onDragEnd resolves false (rejected)', async () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    const onDragEnd = vi.fn().mockResolvedValue(false);
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={onDragEnd} />);
    const marker = createdMarkers[0]!;
    marker.draggedTo = { lat: 54.55, lng: 10.05 };

    await fireDragendAndFlush(marker);

    expect(marker.setLngLatCalls).toHaveLength(2);
    // The snap-back target is the point's ORIGINAL [lon, lat], never the
    // dragged-to position.
    expect(marker.setLngLatCalls[1]).toEqual([10.0, 54.5]);
  });

  it('snaps back to the ORIGINAL construction position when onDragEnd rejects (defense-in-depth catch)', async () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    const onDragEnd = vi.fn().mockRejectedValue(new Error('boom'));
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={onDragEnd} />);
    const marker = createdMarkers[0]!;
    marker.draggedTo = { lat: 54.55, lng: 10.05 };

    await fireDragendAndFlush(marker);

    expect(marker.setLngLatCalls).toHaveLength(2);
    expect(marker.setLngLatCalls[1]).toEqual([10.0, 54.5]);
  });
});
