import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ViaMarkers from './ViaMarkers';
import { de } from '../i18n/dict.de';
import { makeFakeMap } from '../test/fakeMaplibre';
import type { LatLon } from '../types';

// #470/#838: `RouteLayer.tsx:30` is ViaMarkers' only production importer, so
// besides this file the only vitest files that RENDER it are
// `RouteLayer.test.tsx` (directly) and `App.test.tsx` (through the real
// App -> RouteLayer tree). `RouteLayer.test.tsx` mocks `maplibre-gl` with a
// no-op `Marker` that records nothing, and when this was written every
// render helper there passed an EMPTY `draftViaPoints` — so THAT file
// constructed zero markers.
// But `App.test.tsx` DOES exercise ViaMarkers, through the real
// App -> RouteLayer -> ViaMarkers tree with its own recording `FakeMarker`
// (see that file's header note above its `FakeMarker` class): it renders a
// plan with a via point and drives real construct/drag/remove sequences.
// Measured (#838): with this file removed, mutating ViaMarkers.tsx's rebuild
// effect to construct zero markers reds App.test.tsx (`expected [] to have a
// length of 1 but got +0`). App.test.tsx's `FakeMarker` only became a
// RECORDING fake at the #571 redesign (`4c07500`, 2026-08-19); before that
// it was a no-op, and #470 was filed 2026-08-09 — so nothing ASSERTED
// marker construction when #470 was written, and something does now. What
// THIS file adds is per-unit assertions the integration path does not make:
// construction coordinates, the marker element's
// accessibility contract, both `snapBack` branches (dragend rejected,
// dragend rejected-promise) — plus the null-map render phase (ViaMarkers
// renders before `MapView`'s Map instance exists; `useMapInstance()` returns
// null until then, mirroring the RouteLayer null-render-phase lesson in
// CLAUDE.md: a component that skips work on a null dependency needs a test
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

  // #838: TWO via points, and every assertion below drags the SECOND
  // marker (index 1). With a single via point (the shape these three rows
  // used before #838), `p === viaPoints[0]` and `index === 0` hold for
  // EVERY marker, so a per-marker closure/index bug — `snapBack` closing
  // over `viaPoints[0]` instead of its own `p`, or `onDragEnd` called with
  // a hardcoded `0` instead of `index` — cannot be distinguished from
  // correct code: both produce the exact same (0, point-0-coords) result.
  // Measured (#838 investigation): reproducing either bug against the old
  // single-point rows left all three GREEN. Dragging index 1 here means a
  // hardcoded-0 or wrong-closure bug reports/snaps to marker 0's identity
  // instead of marker 1's OWN — which these rows can see because the two
  // points are distinct.
  const twoViaPoints: LatLon[] = [
    { lat: 54.5, lon: 10.0 },
    { lat: 54.7, lon: 10.2 },
  ];

  it('reports the dragged-to position for the SECOND marker via onDragEnd with its own index (1), and does not snap back once accepted', async () => {
    hoisted.map = makeFakeMap();
    const onDragEnd = vi.fn().mockResolvedValue(true);
    render(<ViaMarkers viaPoints={twoViaPoints} replanning={false} onDragEnd={onDragEnd} />);
    const [first, second] = createdMarkers as [RecordedMarker, RecordedMarker];
    // lat !== lng here so a `{ lat: lngLat.lng, lon: lngLat.lat }` transposition
    // bug would be caught, not silently matched.
    second.draggedTo = { lat: 54.75, lng: 10.25 };

    await fireDragendAndFlush(second);

    expect(onDragEnd).toHaveBeenCalledWith(1, { lat: 54.75, lon: 10.25 });
    // Only the original construction call — accepted means no snapBack.
    expect(second.setLngLatCalls).toHaveLength(1);
    // The FIRST marker was never touched — a shared-closure bug that
    // resolves everything against index 0 would instead move this one.
    expect(first.setLngLatCalls).toHaveLength(1);
  });

  it("snaps the SECOND marker back to ITS OWN original position (never the first marker's) when onDragEnd resolves false (rejected)", async () => {
    hoisted.map = makeFakeMap();
    const onDragEnd = vi.fn().mockResolvedValue(false);
    render(<ViaMarkers viaPoints={twoViaPoints} replanning={false} onDragEnd={onDragEnd} />);
    const [first, second] = createdMarkers as [RecordedMarker, RecordedMarker];
    second.draggedTo = { lat: 54.75, lng: 10.25 };

    await fireDragendAndFlush(second);

    expect(second.setLngLatCalls).toHaveLength(2);
    // The snap-back target is marker 1's OWN original [lon, lat] — never
    // marker 0's, which a closure sharing `viaPoints[0]` would produce.
    expect(second.setLngLatCalls[1]).toEqual([10.2, 54.7]);
    expect(first.setLngLatCalls).toHaveLength(1);
  });

  it("snaps the SECOND marker back to ITS OWN original position (never the first marker's) when onDragEnd rejects (defense-in-depth catch)", async () => {
    hoisted.map = makeFakeMap();
    const onDragEnd = vi.fn().mockRejectedValue(new Error('boom'));
    render(<ViaMarkers viaPoints={twoViaPoints} replanning={false} onDragEnd={onDragEnd} />);
    const [first, second] = createdMarkers as [RecordedMarker, RecordedMarker];
    second.draggedTo = { lat: 54.75, lng: 10.25 };

    await fireDragendAndFlush(second);

    expect(second.setLngLatCalls).toHaveLength(2);
    expect(second.setLngLatCalls[1]).toEqual([10.2, 54.7]);
    expect(first.setLngLatCalls).toHaveLength(1);
  });
});
