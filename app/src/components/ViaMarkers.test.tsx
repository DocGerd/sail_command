import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ViaMarkers, { nearestCandidate } from './ViaMarkers';
import { de } from '../i18n/dict.de';
import { makeFakeMap } from '../test/fakeMaplibre';
import type { LatLon } from '../types';

// #470/#838: RouteLayer.tsx's `import ViaMarkers from './ViaMarkers'`
// (~:30) is ViaMarkers' only production importer, so
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
    // #1198: mirrors real MapLibre's `addTo()` (marker.ts), which appends
    // `_element` into `map.getCanvasContainer()` — ViaMarkers.tsx's overlap
    // effect listens on that SAME container, so a fake that only records
    // `addToMap` (as this one did before #1198) would leave that container
    // permanently empty and the effect's `container.addEventListener` calls
    // unreachable by any dispatched event.
    addTo(map: { getCanvasContainer: () => HTMLElement }) {
      this.addToMap = map;
      map.getCanvasContainer().appendChild(this.element);
      return this;
    }
    on(type: string, handler: () => void) {
      if (type === 'dragend') this.dragendHandler = handler;
      return this;
    }
    // #1198: real MapLibre's public `Marker.getElement()` (marker.ts) —
    // ViaMarkers.tsx's overlap-disambiguation effect calls this on every
    // `markersRef.current` entry.
    getElement() {
      return this.element;
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

  // #846 review Major: `p.name ??` had no coverage — reverting it to drop
  // the fallback entirely left this file 9/9 green. Both branches in ONE
  // test: a named via point's marker gets the name as its accessible name;
  // an unnamed sibling still falls back to the indexed `planner.via.marker`
  // label.
  it("uses a named via point's name as the marker's aria-label, and an unnamed one still falls back to the indexed label", () => {
    hoisted.map = makeFakeMap();
    const viaPoints: (LatLon & { name?: string })[] = [
      { lat: 54.5, lon: 10.0, name: 'Kalkgrund' },
      { lat: 54.6, lon: 10.1 },
    ];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    expect(createdMarkers).toHaveLength(2);
    const [named, unnamed] = createdMarkers as [RecordedMarker, RecordedMarker];

    expect(named.element.getAttribute('aria-label')).toBe('Kalkgrund');
    expect(unnamed.element.getAttribute('aria-label')).toBe(
      de['planner.via.marker'].replace('{index}', '2'),
    );
  });
});

// #1186: jsdom computes no layout, so this pins the STYLE DECLARATIONS that
// determine the rendered hit/visible geometry, not a measured box — see the
// file-level CLAUDE.md note on jsdom's paint blindness. MapLibre centers the
// marker root on the coordinate via a %-based transform regardless of its
// pixel size, so a root inline width/height IS the drag/tap target size.
describe('ViaMarkers hit-target geometry (#1186)', () => {
  it('keeps the marker ROOT at the 44px gloved-use floor while the visible dot stays 16px', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    const [marker] = createdMarkers as [RecordedMarker];
    expect(marker.element.style.width).toBe('44px');
    expect(marker.element.style.height).toBe('44px');

    const dot = marker.element.querySelector<HTMLElement>('.sc-via-marker-dot');
    expect(dot).not.toBeNull();
    expect(dot?.style.width).toBe('16px');
    expect(dot?.style.height).toBe('16px');
  });

  it('keeps the dot inside the root element, so a drag anywhere in the 44px area is still `_element.contains(target)`', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    const [marker] = createdMarkers as [RecordedMarker];
    const dot = marker.element.querySelector('.sc-via-marker-dot');
    expect(dot).not.toBeNull();
    expect(marker.element.contains(dot)).toBe(true);
  });
});

// #947: the accessibility-contract block above asserts `aria-label` only.
// These assertions read `element.textContent` instead, a different DOM
// content-tree surface — they prove the label node and its text exist in
// the tree, marked `aria-hidden`. jsdom computes no layout or paint at all
// (CLAUDE.md), so `textContent` is still NOT the visual/paint surface: it
// cannot see a misplaced marker, a clipped label, or invisible text from a
// broken `color-mix()`. Real visual correctness (including marker
// position) needs a real-browser pass (this repo's `verify` skill).
describe('ViaMarkers visible label (#947)', () => {
  it('renders the aria-label text visibly on the marker element, hidden from assistive tech', () => {
    hoisted.map = makeFakeMap();
    const viaPoints: LatLon[] = [{ lat: 54.5, lon: 10.0 }];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    const [marker] = createdMarkers as [RecordedMarker];
    const expectedLabel = de['planner.via.marker'].replace('{index}', '1');
    expect(marker.element.textContent).toBe(expectedLabel);
    const labelEl = marker.element.querySelector('.sc-via-marker-label');
    expect(labelEl).not.toBeNull();
    expect(labelEl?.getAttribute('aria-hidden')).toBe('true');
  });

  it("shows a named via point's name visibly, not the indexed fallback, matching its aria-label", () => {
    hoisted.map = makeFakeMap();
    const viaPoints: (LatLon & { name?: string })[] = [
      { lat: 54.5, lon: 10.0, name: 'Kalkgrund' },
      { lat: 54.6, lon: 10.1 },
    ];
    render(<ViaMarkers viaPoints={viaPoints} replanning={false} onDragEnd={noopDragEnd} />);

    const [named, unnamed] = createdMarkers as [RecordedMarker, RecordedMarker];
    expect(named.element.textContent).toBe('Kalkgrund');
    expect(unnamed.element.textContent).toBe(de['planner.via.marker'].replace('{index}', '2'));
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
  // Measured (PR #893's mutation battery): reproducing either bug against
  // the old single-point rows left all three GREEN. Dragging index 1 here means a
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

// #1198: adjacent via markers overlapping at the widened 44px hit target
// (#1186) capture each other's drags — MapLibre's own Marker._addDragHandler
// gates purely on `_element.contains(e.originalEvent.target)`, and the
// browser resolves `target` to whichever marker paints on top (the
// LATER-constructed one, since addTo() appends siblings in construction
// order), unrelated to which marker the press was actually closer to.
//
// These tests dispatch REAL DOM events through the fake map's
// `getCanvasContainer()` (this file's local `Marker.addTo` now appends
// `element` into it, mirroring real MapLibre) rather than calling
// ViaMarkers.tsx's internals directly, so they exercise the SAME capture/
// bubble pipeline a real browser would — jsdom computes no LAYOUT (so
// `getBoundingClientRect` is stubbed per element below), but it implements
// the DOM EVENTS spec (capture/target/bubble ordering, `dispatchEvent`
// setting `.target` to the element it is called on) faithfully, which is
// the actual mechanism under test here, not paint.
describe('ViaMarkers overlap disambiguation (#1198)', () => {
  it('nearestCandidate (pure): picks the candidate whose rect CENTRE is nearest the point', () => {
    const a = { rect: { left: 78, top: 78, right: 122, bottom: 122 }, value: 'A' };
    const b = { rect: { left: 93, top: 78, right: 137, bottom: 122 }, value: 'B' };
    expect(nearestCandidate({ x: 100, y: 100 }, [a, b])).toBe('A');
    expect(nearestCandidate({ x: 115, y: 100 }, [a, b])).toBe('B');
  });

  // A (first via point, constructed FIRST -> painted BELOW) and B (second,
  // painted ON TOP) with overlapping 44px boxes: A centred at (100,100),
  // B centred at (115,100) — the overlap band is x in [93,122], y in
  // [78,122].
  function twoOverlappingVias(): LatLon[] {
    return [
      { lat: 54.5, lon: 10.0 },
      { lat: 54.5, lon: 10.001 },
    ];
  }

  function stubRect(
    el: HTMLElement,
    r: { left: number; top: number; right: number; bottom: number },
  ): void {
    el.getBoundingClientRect = () =>
      ({
        ...r,
        width: r.right - r.left,
        height: r.bottom - r.top,
        x: r.left,
        y: r.top,
        toJSON: () => r,
      }) as DOMRect;
  }

  function renderTwoOverlapping(): {
    container: HTMLElement;
    a: RecordedMarker;
    b: RecordedMarker;
    seen: EventTarget[];
  } {
    hoisted.map = makeFakeMap();
    render(
      <ViaMarkers viaPoints={twoOverlappingVias()} replanning={false} onDragEnd={noopDragEnd} />,
    );
    const [a, b] = createdMarkers as [RecordedMarker, RecordedMarker];
    stubRect(a.element, { left: 78, top: 78, right: 122, bottom: 122 });
    stubRect(b.element, { left: 93, top: 78, right: 137, bottom: 122 });
    const container = (hoisted.map as ReturnType<typeof makeFakeMap>).getCanvasContainer();
    // Bubble-phase, undefined options — exactly how handler_manager.ts
    // registers its own 'mousedown' listener on this SAME element, so this
    // spy sees exactly what MapLibre's own dispatch would see.
    const seen: EventTarget[] = [];
    container.addEventListener('mousedown', (e) => seen.push(e.target!));
    return { container, a, b, seen };
  }

  it("redirects a press that lands on the visually-topmost marker (B) but is nearer marker A's centre — the #1198 defect", () => {
    const { a, b, seen } = renderTwoOverlapping();
    const bDot = b.element.querySelector('.sc-via-marker-dot')!;
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    bDot.dispatchEvent(event);

    // At BASE (no #1198 fix) the original event bubbles through unmodified
    // — `seen` would be [bDot], never reaching A. At HEAD the original is
    // suppressed and a synthetic dispatched directly at A's root instead.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(a.element);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not interfere when the browser's own target already agrees with the nearest centre", () => {
    const { b, seen } = renderTwoOverlapping();
    const bDot = b.element.querySelector('.sc-via-marker-dot')!;
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 115, // B's own centre — nearest is B, which already agrees.
      clientY: 100,
    });
    bDot.dispatchEvent(event);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(bDot);
    expect(event.defaultPrevented).toBe(false);
  });

  it("never fires when the press falls inside only ONE via marker's box, whatever the native target", () => {
    const { container, seen } = renderTwoOverlapping();
    // (130,100) is inside B's box (93-137) and outside A's (78-122) — a
    // single candidate. Dispatched on the CONTAINER itself (outside every
    // via marker's own DOM tree), which also pins the >=2-candidate guard
    // specifically: with it relaxed to >=1, a lone candidate whose tree
    // does not contain the native target would wrongly be treated as
    // contended and redirected to that candidate anyway.
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 130,
      clientY: 100,
    });
    container.dispatchEvent(event);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(container);
    expect(event.defaultPrevented).toBe(false);
  });
});
