# AIS Live Traffic Overlay — Design Addendum (#25)

Status: user-approved 2026-07-23 (data source, scope, and ownship handling decided
by the owner in-session). Extends the main design
`2026-07-14-sail-command-design.md`; this addendum governs where they overlap.

## Goal

Show live surrounding vessel traffic on the Live tab map, sourced browser-direct
from aisstream.io over WebSocket, with the user's own vessel recognized via MMSI
and filtered out of the traffic layer. Explicitly a live-online feature: it must
degrade exactly like planning does when offline and must never break the offline
core.

## Owner decisions (locked)

- **Data source: aisstream.io, BYOK.** The user creates an API key in the
  aisstream.io dashboard and pastes it into app settings. The key is stored
  on-device only (IndexedDB settings), never committed, never sent anywhere
  except aisstream.io's subscription message. No backend, per repo rule.
- **Scope: Live tab only.** The stream runs only while the Live tab is active;
  no traffic on the planning map. Extending later is a separate issue.
- **Ownship: filter only.** `ownMmsi` removes the own vessel from the traffic
  layer (no ghost next to the GPS boat marker). The AIS-vs-GPS cross-check
  panel is deferred to a follow-up issue.
- **Out of scope, recorded:** CPA/TCPA or any collision-avoidance feature
  (navigation-device territory — needs its own spec discussion if ever wanted),
  planning-map overlay, target track trails, AIS transmission of any kind.

## Architecture

Follows the two established precedents:

- **Per-second data stays component-local** (the `useOwnshipGps` / `LiveView`
  discipline): stream state lives in a new `useAisTraffic` hook, never in
  `AppState`. Internally the hook mutates a `Map<mmsi, AisTarget>` held in a
  ref and publishes to React/MapLibre at a throttled ≤1 Hz tick.
- **Overlay rendering follows the seamarks (#7) pattern**: GeoJSON source
  updated via `setData`, layers added imperatively behind a style-ready gate,
  popup via `setDOMContent` with a themed `className` (both popup-tip borders
  themed with `--sc-bg`), and the layer id registered in MapView's
  `interactiveLayerIds` so target taps never fall through to tap-to-pick.

New modules:

- `app/src/services/aisStream.ts` — WebSocket client: connect, subscribe,
  parse, reconnect policy. No React imports; injectable socket factory for
  tests.
- `app/src/state/useAisTraffic.ts` (or sibling of `useOwnshipGps`) — lifecycle
  gating, target store, 1 Hz publish, status for the UI.
- Map layer + popup wiring in the existing overlay component area
  (`DataLayers.tsx` or a dedicated `AisLayer` component using
  `useMapInstance()`).

## aisstream.io contract

- Endpoint `wss://stream.aisstream.io/v0/stream`. After open, the client MUST
  send a subscription message promptly (server closes idle connections):
  `{ APIKey, BoundingBoxes: [[[latSW, lonSW], [latNE, lonNE]]],
  FilterMessageTypes: ["PositionReport", "ShipStaticData"] }`.
- Subscription bbox = current map viewport padded ~20%; re-sent (debounced,
  ~2 s) when the viewport leaves the padded box (`moveend`). Re-sending the
  subscription on an open socket replaces the previous filter — no reconnect
  needed.
- `PositionReport` carries MMSI, lat/lon, SOG, COG, true heading; sentinel
  values (heading 511, SOG 102.3, COG 360 = not available) map to `undefined`.
  `ShipStaticData` carries name and ship type; merged into the same target by
  MMSI. MetaData `ShipName` may back-fill a name before static data arrives.
- Invalid/revoked key: the server responds with an error frame and/or closes.
  The client must distinguish auth-style failure (surface "check your API key",
  do NOT auto-retry) from transient network failure (retry with backoff).
  Exact close semantics are verified against the live service during
  implementation (owner provides the key) and pinned in unit tests via the
  injected socket.

## Lifecycle & gating

The socket is open only while ALL hold:

1. Live tab is the active tab,
2. `aisApiKey` is configured (non-empty),
3. `navigator.onLine` is true,
4. the document is visible (`visibilitychange` — battery rule from the issue).

Any condition dropping closes the socket and clears the "live" status. Targets
persist and keep aging while the Live view stays mounted (hidden/offline); they
are discarded when the Live tab unmounts — a fresh tab visit starts empty. Reconnect on transient failure uses
capped exponential backoff with jitter (1 s doubling to a 60 s cap, reset on a
successful subscription). Going offline mid-session shows the same honest
offline framing planning uses; the feature silently assuming connectivity is a
bug (repo rule).

## Target model & aging

`AisTarget`: mmsi, position, sogKn, cogDeg, headingDeg?, name?, shipType?,
lastUpdateMs. Aging (checked by a ~30 s sweeper, timestamps from message
arrival time):

- **fresh** — last update < 3 min: rendered fully.
- **stale** — 3–10 min: rendered faded (AIS updates are irregular; a faded
  target is honest about staleness).
- **dropped** — > 10 min: removed from the store.

Targets whose MMSI equals `ownMmsi` are dropped at ingest (never stored).

## Rendering

One GeoJSON source (`sc-ais`), three layers:

- **Vessel symbol** — directional glyph rotated to true heading, COG fallback,
  neutral dot when neither is available. Fill/opacity via feature state or
  properties for fresh vs stale.
- **COG vector** — line from the vessel along COG with length = 6 minutes at
  current SOG (zero-length suppressed).
- **Declutter** — below ~zoom 9 vessels render as plain dots (no vectors, no
  labels); name labels only at ≥ ~zoom 11 with MapLibre collision detection.
  Thresholds are implementation-tunable; the principle (three legibility tiers)
  is the spec.

Layer order: above the depth/seamark overlays, below the route stack and the
ownship marker. `setData` at most 1 Hz.

## Interaction

Tap on a target opens a popup (seamark pattern, themed class): vessel name (or
MMSI if unnamed), MMSI, ship type, SOG/COG, and the age of the last update.
One popup at a time; tap elsewhere dismisses as usual.

## Settings & privacy

- `aisApiKey?: string` and `ownMmsi?: string` join `Settings` +
  `DEFAULT_SETTINGS` (absent/empty = feature off). MMSI is a string (preserves
  leading zeros), validated as exactly 9 digits before use.
- OptionsPanel gains an AIS group: two text fields (Field/NumberInput-style
  primitives, no new UI idioms) plus i18n'd help text stating the privacy
  posture: both values stay on this device; the key is sent only to
  aisstream.io as part of the subscription; the MMSI is used only to filter
  the display and is never transmitted.
- With no key configured the feature is entirely inert — the e2e suite and
  offline tests remain network-free and unchanged.

## Status & copy

The Live view carries an AIS status chip/banner with five states, all i18n'd
(de/en, `satisfies` parity): off (no key — short hint how to enable),
connecting, live (with target count), offline, key error. Disclaimer copy
(extending the existing not-a-navigation-device framing): AIS coverage comes
from volunteer shore stations and is not guaranteed or complete; the overlay is
an awareness aid, not collision avoidance and not a navigation device.

## Testing

- Unit (Vitest, injected fake socket/timers): subscription message builder
  (bbox padding, debounce), target store merge (position + static + MetaData
  name precedence), sentinel-value mapping, aging tiers and the sweeper (fake
  timers), ownship ingest filter, backoff policy including the auth-vs-transient
  split, MMSI validation. Literal pinned expectations (mutation-check
  discipline — no expectations derived from the code under test).
- Component: status chip renders all five states from a mocked hook; popup
  content from a fixture target.
- Real-browser pass with the owner-provided key at the end of implementation
  (dev server, Live tab, real traffic in the Flensburg area) — the repo's
  verification lesson: synthetic tests alone don't count.

## Acceptance criteria

- [ ] With a valid key on the Live tab (online, visible): surrounding vessels
      render with heading/COG vectors, names at high zoom, dots at low zoom;
      popup shows vessel details; own vessel (matching `ownMmsi`) never
      appears in the traffic layer.
- [ ] Leaving the Live tab, hiding the app, or going offline closes the
      socket; the offline state shows the honest banner; returning restores
      the stream without user action.
- [ ] Invalid key produces the key-error state with no retry storm.
- [ ] Stale targets fade at 3 min and disappear at 10 min without updates.
- [ ] No key configured: zero network activity from the feature, UI shows the
      off-state hint, all existing tests (incl. offline e2e) untouched.
- [ ] All new strings in both dicts; no CPA/TCPA-style functionality anywhere.
