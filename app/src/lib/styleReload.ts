import type { Map as MaplibreMap } from 'maplibre-gl';

/**
 * Runs `setup` once the map's style is ready, and again after every style
 * reload (#153 — the #150 BoatMarker pattern, extracted so AisLayer/
 * RouteLayer/DataLayers/BoatMarker share ONE copy instead of each carrying a
 * one-shot local `whenStyleReady` that never re-added after `map.setStyle`).
 *
 * Ready gate: MapLibre fires 'load' exactly once per map lifetime, when the
 * initial style finishes loading — so the once('load') fallback is only valid
 * when this hook is installed at map arrival, BEFORE 'load' can have fired.
 * `isStyleLoaded()` can transiently read false again later (e.g. right after
 * an addSource, or while basemap tiles are still streaming in), and a
 * once('load') armed at that point would wait forever. Install exactly once
 * per map instance from a `[map]` effect; never re-arm on later dependencies
 * (data refreshes, asset arrivals, layout toggles) — invoke the already-armed
 * `setup` directly instead (see DataLayers' assets-arrival effect).
 *
 * Reload re-add: a mid-session `map.setStyle()` silently drops every
 * component-added source/layer/image. 'styledata' fires once the replacement
 * style is in place (parsed — addSource/addLayer are safe), so `setup` also
 * re-runs on every 'styledata'. That event ALSO fires on routine style
 * mutations map-wide (any addLayer/setPaintProperty, including setup's own
 * adds), so `setup` MUST be idempotent: guard on the presence of its own
 * sources and no-op while they exist.
 *
 * Returns a disposer that removes both listeners (MapLibre's Evented.off
 * removes once()-registered listeners too). Call it on unmount so a later
 * 'load'/'styledata' can never resurrect ownerless layers.
 */
export function installStyleSetup(map: MaplibreMap, setup: () => void): () => void {
  if (map.isStyleLoaded()) setup();
  else map.once('load', setup);
  map.on('styledata', setup);
  return () => {
    map.off('load', setup);
    map.off('styledata', setup);
  };
}
