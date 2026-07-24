import type { Map as MaplibreMap } from 'maplibre-gl';

/**
 * Runs `setup` once the map's style is ready, and again after every style
 * reload (#153 — the #150 BoatMarker pattern, extracted so AisLayer/
 * RouteLayer/DataLayers/BoatMarker share ONE copy instead of each carrying a
 * one-shot local `whenStyleReady` that never re-added after `map.setStyle`).
 *
 * Ready gate (#159 — safe at ANY point in the map lifetime): MapLibre's
 * `isStyleLoaded()` is `Style.loaded()`, which ANDs "style JSON parsed" with
 * "all sources' tiles, sprite and images finished loading" — so it reads
 * transiently false MID-SESSION whenever basemap tiles are streaming, even
 * though addSource/addLayer are already safe (their real gate,
 * `Style._checkLoaded`, only needs the parsed style JSON). And 'load' fires
 * exactly once per map lifetime, so a deferral armed on it AFTER that moment
 * would wait forever (the #159 stranding: mid-session mounts like the Live
 * tab installing while tiles stream). The deferral therefore arms TWO
 * one-shots: 'load' (covers a first install while the initial style is
 * genuinely still loading) AND 'idle' (fires every time the render loop
 * settles with everything loaded — the recurring signal that always follows
 * a transient false, rescuing late installs). Every path fires only when the
 * style JSON is in place, so `setup` never runs against a missing style.
 *
 * Reload re-add: a mid-session `map.setStyle()` silently drops every
 * component-added source/layer/image. 'styledata' fires once the replacement
 * style is in place (parsed — addSource/addLayer are safe), so `setup` also
 * re-runs on every 'styledata'. That event ALSO fires on the INITIAL style
 * parse and on routine style mutations map-wide (any addLayer/
 * setPaintProperty, including setup's own adds), so `setup` MUST be
 * idempotent: guard on the presence of its own sources and no-op while they
 * exist. Idempotence also absorbs the deferral's double one-shot ('load'
 * then 'idle' both firing on an initial load).
 *
 * Install once per map instance per mount ([map] effect); on later
 * dependencies (data refreshes, asset arrivals, layout toggles) invoke the
 * already-armed `setup` directly instead of re-installing (see DataLayers'
 * assets-arrival effect).
 *
 * Returns a disposer that removes all three listeners (MapLibre's Evented.off
 * removes once()-registered listeners too). Call it on unmount so a later
 * 'load'/'idle'/'styledata' can never resurrect ownerless layers.
 */
export function installStyleSetup(map: MaplibreMap, setup: () => void): () => void {
  if (map.isStyleLoaded()) {
    setup();
  } else {
    map.once('load', setup);
    map.once('idle', setup);
  }
  map.on('styledata', setup);
  return () => {
    map.off('load', setup);
    map.off('idle', setup);
    map.off('styledata', setup);
  };
}
