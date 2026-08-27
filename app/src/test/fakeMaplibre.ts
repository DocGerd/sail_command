import { vi } from 'vitest';

// Shared minimal MapLibre `Map` fake for layer-component tests (#153),
// modeled on BoatMarker.test.tsx's local fake — the #150/#151 spec, which
// keeps its own copy so those tests stay untouched. jsdom has no MapLibre/
// WebGL runtime, so components are exercised against this object via a
// mocked useMapInstance().
//
// Evented model: plain on() listeners plus once() listeners (drained on
// fire). MapLibre's Evented.off removes a listener regardless of whether it
// was registered via on() or once() — the unmount cleanup of the shared
// installStyleSetup hook (lib/styleReload.ts) relies on exactly that for a
// still-pending 'load' one-shot. Delegated `(type, layerId, fn)`
// registrations (popup/hover handlers) are stored under a separate key so
// `fire('styledata')`/`fire('load')` can never reach them — `fireLayerEvent`
// (#232 item 3) is the deliberate way to reach that separate key and deliver
// an event object to a delegated handler; `fire()` itself stays untouched
// (no args, no delegated bucket) so every existing non-delegated caller is
// unaffected.
//
// #682: real MapLibre also accepts an ARRAY of layer ids as the delegated
// form's second argument (`Map#on<T>(type, layerIds: string[], listener)`,
// `node_modules/maplibre-gl/dist/maplibre-gl.d.ts:13727`, re-derived against
// the installed 6.5.0, matched to `app/package-lock.json`'s pin — #392's
// documented trap) — DataLayers.tsx's seamark click/hover handlers now use
// it to cover both `sc-seamarks*` layers with one registration.
//
// A delegated (layer-scoped) registration is stored as ONE group covering
// every id it was given, in a separate `delegated` array below — NOT as one
// bucket entry per id — because real MapLibre's own `_removeDelegatedListener`
// (`ui/map.ts`, same version) only removes a registration on an EXACT-SET
// match: `delegatedListener.layers.length === layerIds.length &&
// delegatedListener.layers.every((id) => layerIds.includes(id))`. A `off`
// call naming a SUBSET of the original layers is therefore a NO-OP in real
// MapLibre — the whole original group survives — never a partial removal of
// just the named ids. `once()` compounds this: the real implementation wraps
// EVERY delegate to call `_removeDelegatedListener` (removing the WHOLE
// group) BEFORE invoking the original listener, so a multi-layer `once`
// self-destructs as one unit on the FIRST fire from ANY of its layers, not
// once per layer. `fireLayerEvent` models both: it scans `delegated` for a
// `type`+`layers.includes(layerId)` match, and for a `once` entry removes
// the WHOLE registration before invoking. This fake does not model
// `_createDelegatedListener`'s own `queryRenderedFeatures` re-query/merge
// across layers — tests drive `e.features` directly via `fireLayerEvent`'s
// `event` argument.

export interface FakeSource {
  setData: ReturnType<typeof vi.fn>;
  def: { type: string; data?: GeoJSON.FeatureCollection; [k: string]: unknown };
}

export interface FakeLayer {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  filter?: unknown;
  minzoom?: number;
  // Recorded from addLayer's second argument, so tests can assert anchoring
  // (e.g. AisLayer inserting below ROUTE_STACK_BOTTOM_LAYER when it exists).
  beforeId?: string;
}

type Handler = (...args: unknown[]) => void;

export type FakeMap = ReturnType<typeof makeFakeMap>;

export function makeFakeMap({ styleLoaded = true }: { styleLoaded?: boolean } = {}) {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<string, FakeLayer>();
  // #160: insertion-order model of the style's layer array, bottom → top.
  // MapLibre's addLayer(layer, beforeId) inserts the layer immediately BELOW
  // beforeId; with no beforeId it appends on top. The `layers` Map alone only
  // records each layer's beforeId at add time — ordering tests pin the exact
  // final stack against this array instead.
  const layerOrder: string[] = [];
  const images = new Set<string>();
  const listeners = new Map<string, Set<Handler>>();
  const onceListeners = new Map<string, Set<Handler>>();
  // #155: the compass owns the map bearing, so any camera call a layer
  // component makes has to be checkable against a NON-zero one — a fake stuck
  // at 0 cannot tell "preserves the bearing" from "resets it to north", which
  // is exactly the bug RouteLayer's fitBounds had.
  const state = { styleLoaded, bearing: 0 };
  const canvas = { style: {} as Record<string, string> };
  const bucket = (store: Map<string, Set<Handler>>, type: string): Set<Handler> => {
    let set = store.get(type);
    if (!set) {
      set = new Set();
      store.set(type, set);
    }
    return set;
  };
  const key = (type: string, layerOrFn: unknown): string =>
    typeof layerOrFn === 'string' ? `${type}\u0000${layerOrFn}` : type;
  // #682 review MINOR 4: delegated (layer-scoped) registrations, stored as
  // GROUPS (see the file header for why exact-set match matters).
  interface DelegatedRegistration {
    type: string;
    layers: string[];
    listener: Handler;
    once: boolean;
  }
  const delegated: DelegatedRegistration[] = [];
  const sameLayerSet = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((id) => b.includes(id));
  return {
    sources,
    layers,
    layerOrder,
    images,
    setStyleLoaded: (v: boolean) => {
      state.styleLoaded = v;
    },
    fire: (type: string) => {
      for (const fn of [...bucket(listeners, type)]) fn();
      const pending = [...bucket(onceListeners, type)];
      bucket(onceListeners, type).clear();
      for (const fn of pending) fn();
    },
    // #232 item 3: delivers `event` to handlers registered via the delegated
    // `map.on(type, layerId(s), fn)` form (e.g. DataLayers' seamark click
    // handler) — reaches exactly the registrations `fire(type)` above is
    // documented to never reach, and nothing else. A `once` match removes
    // its WHOLE registration group before invoking, mirroring real
    // MapLibre's self-destruct-as-one-unit semantics (file header).
    fireLayerEvent: (type: string, layerId: string, event: unknown) => {
      for (const reg of [...delegated]) {
        if (reg.type !== type || !reg.layers.includes(layerId)) continue;
        if (reg.once) {
          const idx = delegated.indexOf(reg);
          if (idx !== -1) delegated.splice(idx, 1);
        }
        reg.listener(event);
      }
    },
    isStyleLoaded: () => state.styleLoaded,
    on: vi.fn((type: string, layerOrFn: string | string[] | Handler, maybeFn?: Handler) => {
      if (typeof layerOrFn === 'function') {
        bucket(listeners, key(type, layerOrFn)).add(layerOrFn);
        return;
      }
      if (maybeFn) {
        const layers = Array.isArray(layerOrFn) ? layerOrFn : [layerOrFn];
        delegated.push({ type, layers, listener: maybeFn, once: false });
      }
    }),
    once: vi.fn((type: string, layerOrFn: string | string[] | Handler, maybeFn?: Handler) => {
      if (typeof layerOrFn === 'function') {
        bucket(onceListeners, key(type, layerOrFn)).add(layerOrFn);
        return;
      }
      if (maybeFn) {
        const layers = Array.isArray(layerOrFn) ? layerOrFn : [layerOrFn];
        delegated.push({ type, layers, listener: maybeFn, once: true });
      }
    }),
    off: vi.fn((type: string, layerOrFn: string | string[] | Handler, maybeFn?: Handler) => {
      if (typeof layerOrFn === 'function') {
        listeners.get(key(type, layerOrFn))?.delete(layerOrFn);
        onceListeners.get(key(type, layerOrFn))?.delete(layerOrFn);
        return;
      }
      if (!maybeFn) return;
      const layers = Array.isArray(layerOrFn) ? layerOrFn : [layerOrFn];
      // EXACT-SET match only (file header) — a subset `off` is a no-op,
      // never a partial per-id removal.
      const idx = delegated.findIndex(
        (reg) => reg.type === type && reg.listener === maybeFn && sameLayerSet(reg.layers, layers),
      );
      if (idx !== -1) delegated.splice(idx, 1);
    }),
    addSource: vi.fn((id: string, def: FakeSource['def']) => {
      sources.set(id, { setData: vi.fn(), def });
    }),
    getSource: (id: string) => sources.get(id),
    addLayer: vi.fn((layer: FakeLayer, beforeId?: string) => {
      const at = beforeId === undefined ? -1 : layerOrder.indexOf(beforeId);
      // A beforeId that names a MISSING layer is not an append: real MapLibre
      // fires an ErrorEvent and DROPS the layer (Style#addLayer returns
      // without adding). Mirror the observable half so an unguarded anchor
      // turns presence/order assertions red instead of silently passing.
      if (beforeId !== undefined && at === -1) return;
      layers.set(layer.id, beforeId === undefined ? layer : { ...layer, beforeId });
      if (at === -1) layerOrder.push(layer.id);
      else layerOrder.splice(at, 0, layer.id);
    }),
    getLayer: (id: string) => layers.get(id),
    // #599: DataLayers reads the live zoom to pick the depth hatch's stripe
    // band (depthColor.ts's hatchBandForZoom), from inside buildHatchCanvas.
    //
    // WHY THAT CALL IS REACHABLE FROM A TEST AT ALL — one cause, stated once,
    // because an earlier revision of this comment gave three and the
    // load-bearing one was wrong. It is NOT that jsdom supplies a 2D canvas
    // context: jsdom does not, and buildHatchCanvas's `if (!ctx) return null`
    // bails out before the getZoom call in an ordinary test. It is that
    // components/layerOrder.test.tsx installs its OWN
    // HTMLCanvasElement.prototype.getContext fake, which returns a working
    // stub for any 4x4 canvas — exactly the size of that file's maskMeta
    // fixture — so there, and only there, buildHatchCanvas runs to completion
    // and calls map.getZoom(). Without this entry all 6 of that file's tests
    // throw `map.getZoom is not a function` (MEASURED).
    //
    // Returns MapView's own initial ZOOM so the fake starts where the app
    // does. No test asserts band geometry through the fake —
    // depthColor.test.ts covers hatchBandForZoom directly.
    getZoom: vi.fn(() => 9),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
      const at = layerOrder.indexOf(id);
      if (at !== -1) layerOrder.splice(at, 1);
    }),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
    hasImage: (id: string) => images.has(id),
    addImage: vi.fn((id: string) => {
      images.add(id);
    }),
    setLayoutProperty: vi.fn((id: string, prop: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [prop]: value };
    }),
    setFilter: vi.fn((id: string, filter: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.filter = filter;
    }),
    fitBounds: vi.fn(),
    getBearing: () => state.bearing,
    setBearing: (deg: number) => {
      state.bearing = deg;
    },
    getCanvas: () => canvas,
    // Fixed app-region viewport + linear projection (the App.test.tsx stubs):
    // keeps RouteLayer's barb rebuild effect deterministic under jsdom; barb
    // OUTPUT is never asserted against these (that's a real-browser concern).
    getBounds: () => ({
      getWest: () => 9.4,
      getSouth: () => 54.3,
      getEast: () => 11.0,
      getNorth: () => 55.3,
    }),
    project: (lngLat: [number, number]) => ({
      x: (lngLat[0] - 9.4) * 500,
      y: (55.3 - lngLat[1]) * 500,
    }),
  };
}

// ------------------------------------------------------------------ camera
//
// A SECOND fake, for the camera surface rather than the style surface (#155,
// hardened in #203). Kept here rather than inside CompassControl.test.tsx
// because the #203 sweep found the bugs by copying the file's private fake
// into a scratch test — a copy that could then drift from the semantics it is
// supposed to model.
//
// Verified line by line against the maplibre-gl 6.0.0 TypeScript SOURCE
// (`node_modules/maplibre-gl/src/ui/camera.ts` — not the minified `dist/`
// bundle, and re-read fresh for this citation rather than reused from the
// prior 5.24.0 dist-offset pass, per the CLAUDE.md CITATION HALO lesson).
// `Map` no longer EXTENDS `Camera` in v6 (it now HOLDS one, `ui/map.ts:576`),
// but `Camera` itself — where all of the mechanics below live — is otherwise
// unchanged from 5.24 in every particular this fake models:
//
//   easeTo(options, eventData)                                  (camera.ts:749)
//     -> `this._stop(false, options.easeId)` FIRST                     (:750)
//     -> `_stop` runs the pending ease's `_onEaseEnd(easeId)` inline,
//        i.e. `_afterEase` bound via the `_ease()` call below      (:1197-1211)
//     -> `_afterEase(d, id)` returns early ONLY when `this._easeId && id &&
//        this._easeId === id`; otherwise it clears `_easeId` and (further
//        down, not reproduced here) fires rotateend then moveend, both
//        carrying the INTERRUPTED ease's own eventData             (:982-986)
//     -> then `this._easeId = options.easeId`, `_prepareEase` fires
//        rotatestart (only when the bearing actually changes and no
//        rotation was already in progress)                    (:809-810,840-842)
//     -> `_ease` runs `frame(1); finish()` synchronously when duration is 0,
//        otherwise schedules frames and sets `_easeFrameId`     (:1218,1225-1233)
//   isEasing() === `!!this._easeFrameId`                            (:1189-1191)
//
// `isEasing()` itself moved down onto `Camera` (still present there — see
// CLAUDE.md's "established facts" for this migration) but is no longer
// reachable as `Map#isEasing()`, which is why CompassControl.tsx's own guard
// no longer calls it and this fake no longer exposes it (#253): a fake that
// kept a method the real `Map` dropped would make that whole breakage
// structurally unreachable in tests (the #155 lesson).
//
// Two properties are load-bearing and must NOT be "simplified":
//
//   1. An ease stays IN FLIGHT until `finishEase()` or the next `easeTo` —
//      without that no ease is interruptible and the whole bug class is
//      structurally unreachable (the CLAUDE.md lesson from #155).
//   2. The target bearing is applied when the ease SETTLES, never when it
//      starts. A fake that teleports the camera to the target on `easeTo`
//      cannot tell "the ease landed" from "the ease was killed half way",
//      which is exactly the #203 F1 state.
//
// Deliberate simplifications, and what they cost:
//
//   - Only the bearing is modelled (no centre/zoom/pitch), and frames are not
//     interpolated — tests choose the partial bearing with `setBearing`.
//   - `rotating` is tracked per ease rather than as MapLibre's sticky
//     `_rotating` flag.
//   - The end-of-gesture `bearingSnap` branch
//     (`node_modules/maplibre-gl/src/ui/handler_manager.ts:694-712`,
//     `_fireEvents`; unchanged in v6 other than the line numbers) is NOT
//     modelled. KEEP THIS WARNING: it is exactly why no test in this file can
//     prove anything about that branch, and it is what forced #230's fix to
//     be proven in a real browser (e2e/compass.spec.ts) instead of here.
//
//     What the un-modelled branch does depends on the `bearingSnap` value, and
//     this app now passes 0 at map construction (MapView.tsx, #230), which
//     makes `shouldSnapToNorth` unsatisfiable and takes BOTH of its arms out of
//     reach: neither the `map.resetNorth()` call nor the folding of a snap into
//     the inertial ease can happen any more. So the snap-affordance tests in
//     CompassControl.test.tsx now model the whole of the app's OWN snap
//     (`FREE_SNAP_NORTH_DEG`, mapOrientation.ts) rather than the first half of
//     a sequence MapLibre finished differently.
//
//     What is still un-modelled, and still costs these tests accuracy: the
//     ROTATE INERTIA ease. A flick released near north fires
//     `easeTo(inertialEase, {originalEvent})` whose first act is
//     `_stop(false, undefined)` — killing the compass's snap ease, since no
//     easeId matches — and whose own frames carry `originalEvent`, so the
//     camera ends in `free` a couple of degrees off north. A CONTROLLED
//     release (inertia buffer under two entries) has no such ease, the snap
//     survives, and the chart lands at exactly 0 in mode `north`, which is
//     what these tests model. Do not read them as proof about a flick.

type EventData = { originalEvent?: unknown } | undefined;

export interface FakeEaseOptions {
  bearing?: number;
  duration?: number;
  easeId?: string;
  easing?: (t: number) => number;
}

export type FakeCameraMap = ReturnType<typeof makeFakeCameraMap>;

export function makeFakeCameraMap(initialBearing = 0) {
  const listeners = new Map<string, Set<Handler>>();
  const bucket = (type: string): Set<Handler> => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    return set;
  };
  const fire = (type: string, arg: unknown = {}) => {
    for (const fn of [...bucket(type)]) fn(arg);
  };
  const state = { bearing: initialBearing };
  let pending: {
    easeId: string | undefined;
    target: number | undefined;
    rotating: boolean;
    eventData: EventData;
  } | null = null;

  /**
   * `_afterEase(eventData, interruptingEaseId)`. `arrived` distinguishes a
   * natural completion (the camera lands on the target) from an interruption
   * or an abort (it stays wherever it got to). Returns whether the events were
   * suppressed, which is what decides `_prepareEase`'s `currently.rotating`.
   */
  const afterEase = (interruptingEaseId: string | undefined, arrived: boolean): boolean => {
    if (!pending) return false;
    const { easeId, target, rotating, eventData } = pending;
    const suppressed =
      easeId !== undefined && interruptingEaseId !== undefined && easeId === interruptingEaseId;
    pending = null;
    if (suppressed) return true;
    if (arrived && typeof target === 'number') state.bearing = target;
    if (rotating) fire('rotateend', eventData ?? {});
    fire('moveend', eventData ?? {});
    return false;
  };

  const easeTo = vi.fn((options: FakeEaseOptions, eventData?: EventData) => {
    const stillRotating = afterEase(options.easeId, false);
    const rotating =
      typeof options.bearing === 'number' ? options.bearing !== state.bearing : stillRotating;
    pending = {
      easeId: options.easeId,
      target: options.bearing,
      rotating,
      eventData,
    };
    if (rotating && !stillRotating) fire('rotatestart', eventData ?? {});
    if (rotating) fire('rotate', eventData ?? {}); // the new ease's first frame
    if (options.duration === 0) afterEase(undefined, true); // `frame(1); finish()`
  });

  return {
    easeTo,
    /**
     * `Map#fitBounds` as RouteLayer.tsx calls it on every new `plan.id`:
     * duration 0 and the CURRENT bearing, which still interrupts whatever ease
     * is in flight (`_fitInternal` -> `easeTo`).
     */
    fitBounds: vi.fn(
      (_bounds: unknown, options?: { duration?: number; bearing?: number; padding?: number }) => {
        easeTo({
          duration: options?.duration ?? 0,
          ...(options?.bearing === undefined ? {} : { bearing: options.bearing }),
        });
      },
    ),
    /** Let the in-flight ease run to natural completion: the camera lands. */
    finishEase: () => afterEase(undefined, true),
    /**
     * HandlerManager aborting an animation because the user grabbed the chart:
     * `this._camera.stop(true)` -> `Camera#_stop(true)`, no interrupting
     * easeId (`node_modules/maplibre-gl/src/ui/handler_manager.ts:463` when a
     * handler first becomes active, and again at `:543` in
     * `_updateMapTransform` before applying the gesture's own deltas —
     * `camera.ts:1193-1195` for `stop()` itself), and the camera simply stays
     * wherever the ease got to.
     */
    stopForGesture: () => afterEase(undefined, false),
    /** A hand rotation: BOTH events carry the DOM event that caused them. */
    gestureRotateTo: (bearing: number, originalEvent: unknown = new Event('touchmove')) => {
      state.bearing = bearing;
      fire('rotatestart', { originalEvent });
      fire('rotate', { originalEvent });
    },
    getBearing: () => state.bearing,
    setBearing: (deg: number) => {
      state.bearing = deg;
    },
    on: vi.fn((type: string, fn: Handler) => {
      bucket(type).add(fn);
    }),
    off: vi.fn((type: string, fn: Handler) => {
      bucket(type).delete(fn);
    }),
    fire,
  };
}

// What a mid-session map.setStyle() does to component-added content (#150):
// every custom source/layer/image is dropped with the old style, then
// MapLibre fires 'styledata' once the replacement style is in place.
export function simulateStyleReload(map: FakeMap): void {
  map.sources.clear();
  map.layers.clear();
  map.layerOrder.length = 0;
  map.images.clear();
  map.fire('styledata');
}
