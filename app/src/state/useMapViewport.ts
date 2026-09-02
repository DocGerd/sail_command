// #830: the map's current viewport as React state, SETTLE-GATED.
//
// MapLibre fires `moveend` once per completed camera change — a drag, a
// wheel tick, a keyboard nudge, an inertia settle, a `jumpTo`, a resize —
// which is already a gesture-rate signal, not a frame-rate one. But a held
// arrow key or a flick-and-follow fires it every few hundred milliseconds,
// and the consumer here re-renders a DOM list of up to SEAMARKS_IN_VIEW_MAX
// buttons from it. CLAUDE.md's #158 rule for per-fix GPS signals applies
// unchanged to moveend-rate ones: anything that rebuilds DOM keyed on the
// signal goes through a settle gate. The gate is `useSettledValue`
// (state/useAisTraffic.ts, the #158 primitive itself) with the map as the
// reset key, so a map swap bypasses it exactly as a plan change bypasses
// the AIS gate.
//
// The raw subscription is a `useSyncExternalStore` over `moveend` with a
// per-map snapshot cache — NOT a `setState` inside an effect (the repo's
// react-hooks `recommended-latest` rules flag that) and NOT a ref read
// during render. The cache is a module WeakMap keyed by the map instance
// and ref-counted by subscribers, dropped when the last one unsubscribes:
// a stale entry outliving an unmount would otherwise hand a remounting
// consumer (Plan tab -> Routes tab -> pan -> Plan tab) the viewport from
// BEFORE the pan until the next moveend — a wrong list with no signal.
import { useCallback, useSyncExternalStore } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { useSettledValue } from './useAisTraffic';
import type { ViewportBounds } from '../lib/seamarksInView';

export type MapViewport = ViewportBounds;

/** Exactly what this hook reads off the map — typed as a Pick so a test can
 * hand it a three-method fake instead of a MapLibre instance. `getBounds`
 * only, no `getCenter`: the centre is derived from the bounds below, which
 * also keeps the shared `test/fakeMaplibre.ts` (bounds, no centre) usable
 * by every App-level test that mounts this hook's consumer. */
export type ViewportMapLike = Pick<MaplibreMap, 'getBounds' | 'on' | 'off'>;

/**
 * The settle window. A maintainer JUDGEMENT CALL (panelWidth.ts's
 * PANEL_MAP_RESERVE_PX sense): long enough to swallow the ~300 ms cadence
 * of a held keyboard pan (each MapLibre keyboard step is a 300 ms ease and
 * fires its own moveend) so the list rebuilds once per pan, not once per
 * step; short enough that a single pan or zoom reads as an immediate
 * update. Deliberately far below the AIS gate's 2 s — that one absorbs
 * GPS jitter at fix rate; this one absorbs a user's own gesture train.
 */
export const MAP_VIEWPORT_SETTLE_MS = 350;

/**
 * Bounds plus the centre DERIVED from them — the midpoint of the bounding
 * box, not `map.getCenter()`. With pitch locked flat (MapView.tsx's
 * `maxPitch: 0`) the viewport is a rectangle symmetric about the map centre
 * in Mercator space, so the longitude midpoint is the centre exactly; the
 * latitude midpoint differs from it by a second-order Mercator term (tens
 * of metres over a fjord-wide view). The centre only orders the list and
 * decides which marks survive the cap (lib/seamarksInView.ts), never a
 * displayed number, so that residual cannot reach the user.
 */
export function readMapViewport(map: Pick<ViewportMapLike, 'getBounds'>): MapViewport {
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();
  return {
    west,
    south,
    east,
    north,
    centerLon: (west + east) / 2,
    centerLat: (south + north) / 2,
  };
}

function sameViewport(a: MapViewport, b: MapViewport): boolean {
  return (
    a.west === b.west &&
    a.south === b.south &&
    a.east === b.east &&
    a.north === b.north &&
    a.centerLon === b.centerLon &&
    a.centerLat === b.centerLat
  );
}

const snapshots = new WeakMap<object, MapViewport>();
const subscriberCounts = new WeakMap<object, number>();

function snapshotFor(map: ViewportMapLike): MapViewport {
  let viewport = snapshots.get(map);
  if (!viewport) {
    viewport = readMapViewport(map);
    snapshots.set(map, viewport);
  }
  return viewport;
}

/**
 * The map's bounds + centre, re-read on every `moveend` and returned only
 * once no further `moveend` has arrived for `settleMs`. `null` without a
 * map. The very first viewport (and the first after a map swap) is
 * returned immediately — the gate only ever delays a CHANGE.
 */
export function useMapViewport(
  map: ViewportMapLike | null,
  settleMs: number = MAP_VIEWPORT_SETTLE_MS,
): MapViewport | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!map) return () => {};
      subscriberCounts.set(map, (subscriberCounts.get(map) ?? 0) + 1);
      // Re-check on subscribe: the effect that subscribes runs after the
      // first render, and a cached snapshot can predate a move nobody was
      // listening for (a render that cached one but never committed, e.g.
      // under StrictMode's double-render). Replace it only when the VALUES
      // differ — React re-reads the snapshot right after subscribing and a
      // new identity would cost a wasted re-render plus a settle timer on
      // every mount even when nothing moved.
      const fresh = readMapViewport(map);
      const cached = snapshots.get(map);
      if (!cached || !sameViewport(cached, fresh)) snapshots.set(map, fresh);
      const update = () => {
        snapshots.set(map, readMapViewport(map));
        onChange();
      };
      map.on('moveend', update);
      return () => {
        map.off('moveend', update);
        const remaining = (subscriberCounts.get(map) ?? 1) - 1;
        if (remaining <= 0) {
          subscriberCounts.delete(map);
          snapshots.delete(map);
        } else {
          subscriberCounts.set(map, remaining);
        }
      };
    },
    [map],
  );
  const getSnapshot = useCallback(() => (map ? snapshotFor(map) : null), [map]);
  const raw = useSyncExternalStore(subscribe, getSnapshot);
  return useSettledValue(raw, settleMs, map);
}
