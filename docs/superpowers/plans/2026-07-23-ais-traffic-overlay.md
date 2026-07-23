# AIS Traffic Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Show live surrounding vessel traffic on the Live tab map, sourced browser-direct from aisstream.io over a BYOK WebSocket, with the user's own vessel filtered out by MMSI, degrading exactly like planning when offline and staying fully inert (zero network) with no key.

**Architecture:** A pure, React-free `AisStreamClient` (injectable socket factory) owns the aisstream.io connection/subscription/reconnect state machine; a pure target store (`aisTargets.ts`) merges PositionReport + ShipStaticData by MMSI and ages targets; a component-local `useAisTraffic` hook (mirroring `useOwnshipGps`'s local-state discipline) holds the target `Map` in a ref and publishes a snapshot to React/MapLibre at ≤1 Hz. Rendering follows the seamarks (#7) precedent: one GeoJSON source updated via `setData`, imperative layers behind a style-ready gate, a themed popup, and the layer id registered in MapView's `interactiveLayerIds`. All map-bound components are verified in a real browser (jsdom has no WebGL); every pure module is unit-tested.

**Tech Stack:** Vite + React + TypeScript (strict, `exactOptionalPropertyTypes`), MapLibre GL, IndexedDB (idb) for settings, Vitest (unit) with injected fake socket + fake timers. Browser-native `WebSocket` (no new runtime dependency).

## Global Constraints (apply to EVERY task)

- **TypeScript `strict` + `exactOptionalPropertyTypes` are ON.** Never assign `undefined` to a `?`-optional object property — omit the key. Where a value is genuinely "string-or-absent" at a call site (e.g. `settings.aisApiKey`), type the *receiving* field as `string | undefined` (a required key whose value may be undefined), NOT as `field?: string`. Build objects by conditionally assigning keys only when the value is defined.
- **No enums, no constructor parameter properties** (`erasableSyntaxOnly`). Use `type` unions and plain class fields.
- **i18n both dicts with `satisfies` parity.** Every new UI string key goes into `app/src/i18n/dict.de.ts` (which defines `MsgKey = keyof typeof de`) AND `app/src/i18n/dict.en.ts` (which ends `} satisfies Record<MsgKey, string>`). Add the German key first, then the English. Never hardcode a user-facing string.
- **UI primitives + `--sc-*` tokens only.** Reuse `Field`, `Chip`, `NumberInput`, etc.; never hardcode colors/spacing. Any new MapLibre `Popup` needs a `className` plus app.css overrides theming `.maplibregl-popup-content` and BOTH popup-tip borders with `--sc-bg` (see `.seamark-popup`).
- **No new runtime dependency.** WebSocket is a browser global.
- **No runtime fetch to any new origin** except the aisstream.io WebSocket itself. There is deliberately no backend.
- **Feature fully inert without a key.** With `aisApiKey` empty/absent the hook creates no client and opens no socket, so the e2e suite and offline tests stay network-free and unchanged.
- **Structured-clone-safe data.** `AisTarget` and all stored/published data are plain objects (no class instances, no typed arrays that get transferred). The target `Map` lives in a ref, never in IndexedDB or `AppState`.
- **Per-second data is component-local, never `AppState`.** 1 Hz updates must not re-render the whole app (the `useOwnshipGps` / `LiveView` rule).
- **Testing discipline (every test step):** explicit `import { describe, it, expect, vi } from 'vitest'`; literal pinned expectations recomputed by hand, NEVER derived from the code under test (mutation-check); fake timers for aging/backoff; an injected fake socket for the client (no real network in any test).

---

### Task 1: Settings extension (`aisApiKey`, `ownMmsi`) + MMSI validation

Adds the two device-local settings fields and the MMSI validator. Both fields are OPTIONAL on `Settings` and omitted from `DEFAULT_SETTINGS` (absent = feature off), so no existing `Settings` literal or `DEFAULT_SETTINGS` consumer breaks and `db.ts` needs no migration (structured clone carries new optional fields; `AppState`'s `{ ...DEFAULT_SETTINGS, ...persisted, ...pending }` merge preserves them).

**Files**
- Create: `app/src/lib/mmsi.ts`
- Create: `app/src/lib/mmsi.test.ts`
- Modify: `app/src/types.ts` (add `aisApiKey?`, `ownMmsi?` to `Settings`)
- Test (modify): `app/src/services/db.test.ts` (round-trip the new fields)

**Interfaces**
- Produces: `export function isValidMmsi(value: string): boolean` — true iff `value` is exactly 9 decimal digits (leading zeros significant).
- Produces: `Settings.aisApiKey?: string`, `Settings.ownMmsi?: string`.

Steps:

- [ ] Write the failing test `app/src/lib/mmsi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isValidMmsi } from './mmsi';

describe('isValidMmsi', () => {
  it('accepts exactly nine decimal digits', () => {
    expect(isValidMmsi('211234560')).toBe(true);
  });

  it('accepts nine digits with significant leading zeros (coast-station form)', () => {
    expect(isValidMmsi('002110000')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidMmsi('')).toBe(false);
  });

  it('rejects eight digits (too short)', () => {
    expect(isValidMmsi('21123456')).toBe(false);
  });

  it('rejects ten digits (too long)', () => {
    expect(isValidMmsi('2112345601')).toBe(false);
  });

  it('rejects non-digit characters', () => {
    expect(isValidMmsi('21123456a')).toBe(false);
  });

  it('rejects embedded whitespace', () => {
    expect(isValidMmsi('211 234 56')).toBe(false);
  });
});
```

- [ ] Run to see it fail: `npm --prefix app run test -- mmsi` — fails with "Cannot find module './mmsi'" / `isValidMmsi is not a function`.

- [ ] Minimal implementation `app/src/lib/mmsi.ts`:

```ts
/**
 * AIS MMSI validation (#25): a Maritime Mobile Service Identity is exactly 9
 * decimal digits. Kept a string throughout the app so leading zeros (valid for
 * coast-station / group identifiers, form 00MIDxxxx) survive; a numeric type
 * would silently drop them.
 */
export function isValidMmsi(value: string): boolean {
  return /^\d{9}$/.test(value);
}
```

- [ ] Run to pass: `npm --prefix app run test -- mmsi` — 7 passing.

- [ ] Add the fields to `Settings` in `app/src/types.ts`, immediately after `showOwnship: boolean;` (before the closing brace of the interface):

```ts
  // #25 AIS live traffic overlay (Live tab only): BYOK aisstream.io API key +
  // the user's own vessel MMSI, both device-local (IndexedDB settings), never
  // transmitted anywhere except (the key) inside aisstream's subscription
  // message. Both OPTIONAL and absent-by-default = feature off;
  // exactOptionalPropertyTypes means an unset field is omitted, never
  // `undefined`. `ownMmsi` is a string (preserves leading zeros; validated via
  // isValidMmsi before use) and only ever filters the display — never sent.
  aisApiKey?: string;
  ownMmsi?: string;
```

Leave `DEFAULT_SETTINGS` unchanged — both new keys are optional and default to absent (feature off).

- [ ] Add a settings round-trip test to `app/src/services/db.test.ts`, inside the `describe('IndexedDB persistence', ...)` block (after the existing `'settings roundtrip preserves all values'` test):

```ts
  it('settings roundtrip preserves the #25 AIS fields (aisApiKey, ownMmsi)', async () => {
    const settings: Settings = {
      safetyDepthM: 3.0,
      motorSpeedKn: 6.5,
      motorThresholdKn: 2.5,
      maneuverPenaltyS: 45,
      performanceFactor: 0.9,
      motorEnabled: true,
      showOwnship: false,
      aisApiKey: 'abc123-key',
      ownMmsi: '002110000',
    };

    await saveSettings(settings);
    const retrieved = await loadSettings();

    expect(retrieved).toEqual(settings);
    // Explicitly pin the leading-zero MMSI survives as a string, not a number.
    expect(retrieved?.ownMmsi).toBe('002110000');
  });
```

- [ ] Run to pass: `npm --prefix app run test -- db.test` — new test green (existing tests untouched).

- [ ] Typecheck: `npm --prefix app run typecheck` — clean.

- [ ] Commit:
  - `git add app/src/lib/mmsi.ts app/src/lib/mmsi.test.ts app/src/types.ts app/src/services/db.test.ts`
  - `git commit -m "feat: add AIS settings fields + MMSI validation (#25)"`

---

### Task 2: aisstream.io WebSocket client (`aisStream.ts`)

Pure, React-free client: subscription/bbox builders, message parsing with sentinel mapping, capped-exponential-backoff-with-jitter reconnect, and a connection state machine with a terminal auth-failure state. The only browser-touching part is the `browserAisSocket` adapter; everything else is driven by an injected fake socket + injected timers in tests.

> Auth-vs-transient note: the spec says exact live close semantics are verified against the service during implementation (owner provides the key). This task pins a DETERMINISTIC rule now — an aisstream **error frame** (`{"error": "..."}`) is the terminal `keyError` path (no retry storm); every other close/error is transient (backoff reconnect). The state machine already routes to a terminal `keyError` state, so if live testing shows an invalid key manifests as a bare early close instead, the implementer promotes that signal to the same terminal state without restructuring.

**Files**
- Create: `app/src/services/aisStream.ts`
- Create: `app/src/services/aisStream.test.ts`

**Interfaces**
- Produces:
  - `export const AIS_STREAM_URL = 'wss://stream.aisstream.io/v0/stream'`
  - `export type AisBoundingBox = [[number, number], [number, number]]` (`[[latSW, lonSW], [latNE, lonNE]]`)
  - `export function buildSubscription(apiKey: string, bbox: AisBoundingBox): AisSubscription`
  - `export function padBoundingBox(sw: { lat: number; lon: number }, ne: { lat: number; lon: number }, fraction: number): AisBoundingBox`
  - `export function viewportEscapedBbox(subscribed: AisBoundingBox, viewSW: { lat: number; lon: number }, viewNE: { lat: number; lon: number }): boolean`
  - `export type ParsedAisData = { kind: 'position'; mmsi: string; lat: number; lon: number; sogKn?: number; cogDeg?: number; headingDeg?: number; name?: string } | { kind: 'static'; mmsi: string; name?: string; shipType?: number }`
  - `export type ParsedAisMessage = ParsedAisData | { kind: 'error'; message: string }`
  - `export function parseAisMessage(raw: string): ParsedAisMessage | null`
  - `export function nextReconnectDelayMs(attempt: number, random: () => number): number`
  - `export type AisClientStatus = 'connecting' | 'live' | 'keyError' | 'closed'`
  - `export interface AisStreamCallbacks { onMessage: (msg: ParsedAisData) => void; onStatus: (status: AisClientStatus) => void }`
  - `export type AisSocketFactory = (url: string, handlers: AisSocketHandlers) => AisSocket`
  - `export const browserAisSocket: AisSocketFactory`
  - `export class AisStreamClient` with `start(bbox)`, `updateBbox(bbox)`, `stop()`.
- Consumes: nothing from the app (self-contained).

Steps:

- [ ] Write the failing test `app/src/services/aisStream.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  AIS_STREAM_URL,
  AisStreamClient,
  buildSubscription,
  nextReconnectDelayMs,
  padBoundingBox,
  parseAisMessage,
  viewportEscapedBbox,
  type AisClientStatus,
  type AisSocket,
  type AisSocketHandlers,
  type ParsedAisData,
} from './aisStream';

const BBOX: [[number, number], [number, number]] = [
  [54.6, 9.3],
  [55.0, 10.1],
];

describe('buildSubscription', () => {
  it('builds the exact aisstream subscription envelope', () => {
    expect(buildSubscription('KEY', BBOX)).toEqual({
      APIKey: 'KEY',
      BoundingBoxes: [
        [
          [54.6, 9.3],
          [55.0, 10.1],
        ],
      ],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    });
  });
});

describe('padBoundingBox', () => {
  it('pads each side by the given fraction of the span', () => {
    // span lat = 1.0, lon = 2.0; 20% pad = 0.2 lat / 0.4 lon each side.
    expect(padBoundingBox({ lat: 54.0, lon: 9.0 }, { lat: 55.0, lon: 11.0 }, 0.2)).toEqual([
      [53.8, 8.6],
      [55.2, 11.4],
    ]);
  });
});

describe('viewportEscapedBbox', () => {
  const subscribed: [[number, number], [number, number]] = [
    [54.0, 9.0],
    [55.0, 11.0],
  ];
  it('is false when the viewport is fully inside the subscribed box', () => {
    expect(viewportEscapedBbox(subscribed, { lat: 54.2, lon: 9.2 }, { lat: 54.8, lon: 10.8 })).toBe(
      false,
    );
  });
  it('is true when the viewport crosses the south or west edge', () => {
    expect(viewportEscapedBbox(subscribed, { lat: 53.9, lon: 9.2 }, { lat: 54.8, lon: 10.8 })).toBe(
      true,
    );
  });
  it('is true when the viewport crosses the north or east edge', () => {
    expect(viewportEscapedBbox(subscribed, { lat: 54.2, lon: 9.2 }, { lat: 54.8, lon: 11.1 })).toBe(
      true,
    );
  });
});

describe('parseAisMessage', () => {
  it('parses a PositionReport, converting MMSI to a 9-digit string and carrying MetaData name', () => {
    const raw = JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 211234560, ShipName: '  ALBATROS  ' },
      Message: {
        PositionReport: { Latitude: 54.79, Longitude: 9.43, Sog: 6.3, Cog: 91.4, TrueHeading: 90 },
      },
    });
    expect(parseAisMessage(raw)).toEqual({
      kind: 'position',
      mmsi: '211234560',
      lat: 54.79,
      lon: 9.43,
      sogKn: 6.3,
      cogDeg: 91.4,
      headingDeg: 90,
      name: 'ALBATROS',
    });
  });

  it('maps sentinel values (heading 511, SOG 102.3, COG 360) to omitted keys', () => {
    const raw = JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 211234560 },
      Message: {
        PositionReport: { Latitude: 54.79, Longitude: 9.43, Sog: 102.3, Cog: 360, TrueHeading: 511 },
      },
    });
    expect(parseAisMessage(raw)).toEqual({
      kind: 'position',
      mmsi: '211234560',
      lat: 54.79,
      lon: 9.43,
    });
  });

  it('zero-pads a short (coast-station) MMSI back to nine digits', () => {
    const raw = JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 2110000 },
      Message: { PositionReport: { Latitude: 54.0, Longitude: 9.0 } },
    });
    const parsed = parseAisMessage(raw) as ParsedAisData & { kind: 'position' };
    expect(parsed.mmsi).toBe('002110000');
  });

  it('parses ShipStaticData name (trimmed) and ship type', () => {
    const raw = JSON.stringify({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 211234560 },
      Message: { ShipStaticData: { Name: 'SEEADLER ', Type: 36 } },
    });
    expect(parseAisMessage(raw)).toEqual({
      kind: 'static',
      mmsi: '211234560',
      name: 'SEEADLER',
      shipType: 36,
    });
  });

  it('maps an aisstream error frame to a kind:error message', () => {
    expect(parseAisMessage(JSON.stringify({ error: 'Invalid API Key' }))).toEqual({
      kind: 'error',
      message: 'Invalid API Key',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseAisMessage('not json{')).toBeNull();
  });

  it('returns null for an unknown MessageType', () => {
    const raw = JSON.stringify({
      MessageType: 'StaticDataReport',
      MetaData: { MMSI: 1 },
      Message: {},
    });
    expect(parseAisMessage(raw)).toBeNull();
  });
});

describe('nextReconnectDelayMs', () => {
  it('is full-jittered exponential from a 1 s base, capped at 60 s', () => {
    const half = () => 0.5;
    expect(nextReconnectDelayMs(1, half)).toBe(500); // 0.5 * 1000
    expect(nextReconnectDelayMs(2, half)).toBe(1000); // 0.5 * 2000
    expect(nextReconnectDelayMs(3, half)).toBe(2000); // 0.5 * 4000
    // attempt 7 -> base*2^6 = 64000, capped to 60000.
    expect(nextReconnectDelayMs(7, half)).toBe(30000);
    expect(nextReconnectDelayMs(100, () => 0.999)).toBe(59940); // floor(0.999 * 60000)
    expect(nextReconnectDelayMs(5, () => 0)).toBe(0);
  });
});

// ---- state-machine tests: injected fake socket + injected timers ----

function fakeSocket() {
  const sent: string[] = [];
  let handlers: AisSocketHandlers | null = null;
  const socket: AisSocket = {
    send: (d) => sent.push(d),
    close: vi.fn(),
  };
  return {
    socket,
    sent,
    bind: (h: AisSocketHandlers) => {
      handlers = h;
    },
    open: () => handlers?.onOpen(),
    message: (raw: string) => handlers?.onMessage(raw),
    remoteClose: () => handlers?.onClose(),
    error: () => handlers?.onError(),
  };
}

/** A deterministic timer harness: records scheduled callbacks + delays. */
function fakeTimers() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  return {
    setTimer: (fn: () => void, ms: number): number => {
      scheduled.push({ fn, ms });
      return scheduled.length; // 1-based id
    },
    clearTimer: vi.fn(),
    delays: () => scheduled.map((s) => s.ms),
    fireLast: () => scheduled[scheduled.length - 1].fn(),
  };
}

function makeClient() {
  const fs = fakeSocket();
  const timers = fakeTimers();
  const statuses: AisClientStatus[] = [];
  const messages: ParsedAisData[] = [];
  const client = new AisStreamClient(
    'KEY',
    {
      onMessage: (m) => messages.push(m),
      onStatus: (s) => statuses.push(s),
    },
    {
      socketFactory: (url, handlers) => {
        expect(url).toBe(AIS_STREAM_URL);
        fs.bind(handlers);
        return fs.socket;
      },
      random: () => 0.5,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    },
  );
  return { client, fs, timers, statuses, messages };
}

const POSITION_RAW = JSON.stringify({
  MessageType: 'PositionReport',
  MetaData: { MMSI: 211234560 },
  Message: { PositionReport: { Latitude: 54.79, Longitude: 9.43, Sog: 6, Cog: 90, TrueHeading: 90 } },
});

describe('AisStreamClient', () => {
  it('sends the subscription envelope on open and reports connecting', () => {
    const { client, fs, statuses } = makeClient();
    client.start(BBOX);
    expect(statuses).toEqual(['connecting']);
    fs.open();
    expect(JSON.parse(fs.sent[0])).toEqual(buildSubscription('KEY', BBOX));
  });

  it('transitions to live on the first inbound message and delivers it', () => {
    const { client, fs, statuses, messages } = makeClient();
    client.start(BBOX);
    fs.open();
    fs.message(POSITION_RAW);
    expect(statuses).toEqual(['connecting', 'live']);
    expect(messages).toEqual([
      { kind: 'position', mmsi: '211234560', lat: 54.79, lon: 9.43, sogKn: 6, cogDeg: 90, headingDeg: 90 },
    ]);
  });

  it('treats an error frame as terminal keyError: closes and schedules NO reconnect', () => {
    const { client, fs, timers, statuses } = makeClient();
    client.start(BBOX);
    fs.open();
    fs.message(JSON.stringify({ error: 'Invalid API Key' }));
    expect(statuses).toEqual(['connecting', 'keyError']);
    expect(fs.socket.close).toHaveBeenCalledTimes(1);
    // A subsequent transport close must not arm a retry.
    fs.remoteClose();
    expect(timers.delays()).toEqual([]);
  });

  it('reconnects with capped-exponential backoff on transient closes (no message received)', () => {
    const { client, fs, timers } = makeClient();
    client.start(BBOX);
    fs.open();
    fs.remoteClose(); // attempt 1 -> 0.5 * 1000
    expect(timers.delays()).toEqual([500]);
    timers.fireLast(); // re-open
    fs.open();
    fs.remoteClose(); // attempt 2 -> 0.5 * 2000
    expect(timers.delays()).toEqual([500, 1000]);
  });

  it('resets backoff after a live subscription (attempt counter returns to 1)', () => {
    const { client, fs, timers } = makeClient();
    client.start(BBOX);
    fs.open();
    fs.message(POSITION_RAW); // live -> resets attempt
    fs.remoteClose(); // attempt 1 again -> 0.5 * 1000
    expect(timers.delays()).toEqual([500]);
  });

  it('re-sends the subscription on updateBbox over an open socket without reconnecting', () => {
    const { client, fs } = makeClient();
    client.start(BBOX);
    fs.open();
    const bbox2: [[number, number], [number, number]] = [
      [54.7, 9.4],
      [55.1, 10.2],
    ];
    client.updateBbox(bbox2);
    expect(JSON.parse(fs.sent[1])).toEqual(buildSubscription('KEY', bbox2));
    expect(fs.socket.close).not.toHaveBeenCalled();
  });

  it('stop() closes the socket, clears any pending timer, and reports closed', () => {
    const { client, fs, statuses } = makeClient();
    client.start(BBOX);
    fs.open();
    client.stop();
    expect(fs.socket.close).toHaveBeenCalledTimes(1);
    expect(statuses[statuses.length - 1]).toBe('closed');
  });
});
```

- [ ] Run to see it fail: `npm --prefix app run test -- aisStream` — fails ("Cannot find module './aisStream'").

- [ ] Minimal implementation `app/src/services/aisStream.ts`:

```ts
// #25 AIS live traffic overlay — pure aisstream.io WebSocket client. No React,
// no map, no DOM: the connection state machine, subscription/message shapes,
// sentinel mapping, and reconnect policy live here and are unit-tested against
// an injected fake socket + injected timers. Only browserAisSocket touches a
// real WebSocket.

export const AIS_STREAM_URL = 'wss://stream.aisstream.io/v0/stream';

// aisstream's BoundingBoxes element: [ [latSW, lonSW], [latNE, lonNE] ].
export type AisBoundingBox = [[number, number], [number, number]];

export interface AisSubscription {
  APIKey: string;
  BoundingBoxes: AisBoundingBox[];
  FilterMessageTypes: ['PositionReport', 'ShipStaticData'];
}

export function buildSubscription(apiKey: string, bbox: AisBoundingBox): AisSubscription {
  return {
    APIKey: apiKey,
    BoundingBoxes: [bbox],
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  };
}

export function padBoundingBox(
  sw: { lat: number; lon: number },
  ne: { lat: number; lon: number },
  fraction: number,
): AisBoundingBox {
  const dLat = (ne.lat - sw.lat) * fraction;
  const dLon = (ne.lon - sw.lon) * fraction;
  return [
    [sw.lat - dLat, sw.lon - dLon],
    [ne.lat + dLat, ne.lon + dLon],
  ];
}

// True once the current viewport pokes outside the padded box we subscribed to,
// i.e. it's time to re-send the subscription with a fresh padded bbox.
export function viewportEscapedBbox(
  subscribed: AisBoundingBox,
  viewSW: { lat: number; lon: number },
  viewNE: { lat: number; lon: number },
): boolean {
  const [[sLat, sLon], [nLat, nLon]] = subscribed;
  return viewSW.lat < sLat || viewSW.lon < sLon || viewNE.lat > nLat || viewNE.lon > nLon;
}

export type ParsedAisData =
  | {
      kind: 'position';
      mmsi: string;
      lat: number;
      lon: number;
      sogKn?: number;
      cogDeg?: number;
      headingDeg?: number;
      name?: string;
    }
  | { kind: 'static'; mmsi: string; name?: string; shipType?: number };

export type ParsedAisMessage = ParsedAisData | { kind: 'error'; message: string };

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Maps aisstream's "not available" sentinel to undefined (an omitted key).
function sentinel(v: number | undefined, sentinelValue: number): number | undefined {
  return v === undefined || v === sentinelValue ? undefined : v;
}

function cleanName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseAisMessage(raw: string): ParsedAisMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;

  // Bad / revoked key: aisstream returns { "error": "..." }.
  if (typeof obj.error === 'string') return { kind: 'error', message: obj.error };

  const messageType = obj.MessageType;
  const meta = obj.MetaData as Record<string, unknown> | undefined;
  const message = obj.Message as Record<string, unknown> | undefined;
  if (typeof messageType !== 'string' || !meta || !message) return null;

  const rawMmsi = meta.MMSI;
  if (typeof rawMmsi !== 'number' && typeof rawMmsi !== 'string') return null;
  // The wire carries MMSI as a number, dropping leading zeros; zero-pad back to
  // 9 digits so a coast-station id (00MIDxxxx) and the user's 9-digit ownMmsi
  // compare equal.
  const mmsi = String(rawMmsi).padStart(9, '0');
  const metaName = cleanName(meta.ShipName);

  if (messageType === 'PositionReport') {
    const pr = message.PositionReport as Record<string, unknown> | undefined;
    if (!pr) return null;
    const lat = num(pr.Latitude);
    const lon = num(pr.Longitude);
    if (lat === undefined || lon === undefined) return null;
    const out: ParsedAisData = { kind: 'position', mmsi, lat, lon };
    const sog = sentinel(num(pr.Sog), 102.3);
    const cog = sentinel(num(pr.Cog), 360);
    const heading = sentinel(num(pr.TrueHeading), 511);
    if (sog !== undefined) out.sogKn = sog;
    if (cog !== undefined) out.cogDeg = cog;
    if (heading !== undefined) out.headingDeg = heading;
    if (metaName !== undefined) out.name = metaName;
    return out;
  }

  if (messageType === 'ShipStaticData') {
    const sd = message.ShipStaticData as Record<string, unknown> | undefined;
    if (!sd) return null;
    const out: ParsedAisData = { kind: 'static', mmsi };
    const name = cleanName(sd.Name) ?? metaName;
    const shipType = num(sd.Type);
    if (name !== undefined) out.name = name;
    if (shipType !== undefined) out.shipType = shipType;
    return out;
  }

  return null;
}

export const AIS_BACKOFF_BASE_MS = 1_000;
export const AIS_BACKOFF_CAP_MS = 60_000;

// Full-jitter capped exponential backoff. attempt is 1-based (consecutive
// failed connects); delay in [0, min(cap, base * 2^(attempt-1))). random()
// in [0,1) is injected for deterministic tests.
export function nextReconnectDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(AIS_BACKOFF_CAP_MS, AIS_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export type AisClientStatus = 'connecting' | 'live' | 'keyError' | 'closed';

export interface AisStreamCallbacks {
  onMessage: (msg: ParsedAisData) => void; // position/static only; never error
  onStatus: (status: AisClientStatus) => void;
}

// Minimal socket surface the client drives (a real WebSocket, or a fake).
export interface AisSocket {
  send(data: string): void;
  close(): void;
}
export interface AisSocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
  onError: () => void;
}
export type AisSocketFactory = (url: string, handlers: AisSocketHandlers) => AisSocket;

// Browser adapter (not unit-tested: jsdom has no WebSocket). Normalizes a real
// WebSocket's events into AisSocketHandlers; aisstream sends JSON text frames,
// but a Blob frame is decoded defensively.
export const browserAisSocket: AisSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (e: MessageEvent) => {
    const { data } = e;
    if (typeof data === 'string') handlers.onMessage(data);
    else if (data instanceof Blob) void data.text().then((text) => handlers.onMessage(text));
  };
  ws.onclose = () => handlers.onClose();
  ws.onerror = () => handlers.onError();
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
  };
};

export interface AisStreamDeps {
  socketFactory: AisSocketFactory;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export class AisStreamClient {
  private readonly apiKey: string;
  private readonly callbacks: AisStreamCallbacks;
  private readonly socketFactory: AisSocketFactory;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  private socket: AisSocket | null = null;
  private socketOpen = false;
  private running = false;
  private authFailed = false;
  private attempt = 0;
  private receivedSinceConnect = false;
  private timerId: number | null = null;
  private currentBbox: AisBoundingBox | null = null;
  private status: AisClientStatus = 'closed';

  constructor(apiKey: string, callbacks: AisStreamCallbacks, deps: AisStreamDeps) {
    this.apiKey = apiKey;
    this.callbacks = callbacks;
    this.socketFactory = deps.socketFactory;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => window.clearTimeout(id));
  }

  start(bbox: AisBoundingBox): void {
    if (this.running) {
      this.updateBbox(bbox);
      return;
    }
    this.running = true;
    this.authFailed = false;
    this.attempt = 0;
    this.currentBbox = bbox;
    this.open();
  }

  updateBbox(bbox: AisBoundingBox): void {
    this.currentBbox = bbox;
    // Re-sending on an open socket replaces the server-side filter — no reconnect.
    if (this.socketOpen) this.sendSubscription();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      this.clearTimer(this.timerId);
      this.timerId = null;
    }
    const s = this.socket;
    this.socket = null;
    this.socketOpen = false;
    s?.close();
    this.emitStatus('closed');
  }

  private open(): void {
    this.receivedSinceConnect = false;
    this.emitStatus('connecting');
    let disconnected = false;
    const handleDisconnect = () => {
      if (disconnected) return;
      disconnected = true;
      this.socket = null;
      this.socketOpen = false;
      if (!this.running || this.authFailed) return;
      this.attempt += 1;
      this.timerId = this.setTimer(() => this.open(), nextReconnectDelayMs(this.attempt, this.random));
    };
    this.socket = this.socketFactory(AIS_STREAM_URL, {
      onOpen: () => {
        if (!this.running) return;
        this.socketOpen = true;
        this.sendSubscription();
      },
      onMessage: (data) => {
        const parsed = parseAisMessage(data);
        if (!parsed) return;
        if (parsed.kind === 'error') {
          // Terminal: a bad/revoked key must not spin a retry storm.
          this.authFailed = true;
          disconnected = true; // suppress the retry the imminent close would arm
          this.emitStatus('keyError');
          const s = this.socket;
          this.socket = null;
          this.socketOpen = false;
          s?.close();
          return;
        }
        if (!this.receivedSinceConnect) {
          this.receivedSinceConnect = true;
          this.attempt = 0; // a live subscription resets backoff
          this.emitStatus('live');
        }
        this.callbacks.onMessage(parsed);
      },
      onClose: handleDisconnect,
      onError: handleDisconnect,
    });
  }

  private sendSubscription(): void {
    if (!this.socket || !this.currentBbox) return;
    this.socket.send(JSON.stringify(buildSubscription(this.apiKey, this.currentBbox)));
  }

  private emitStatus(status: AisClientStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.callbacks.onStatus(status);
  }
}
```

- [ ] Run to pass: `npm --prefix app run test -- aisStream` — all green (~20 tests).

- [ ] Typecheck + lint: `npm --prefix app run typecheck && npm --prefix app run lint` — clean.

- [ ] Commit:
  - `git add app/src/services/aisStream.ts app/src/services/aisStream.test.ts`
  - `git commit -m "feat: add aisstream.io WebSocket client (#25)"`

---

### Task 3: Target store + aging (`aisTargets.ts`)

Pure module: merge PositionReport + ShipStaticData (+ MetaData name) by MMSI into a `Map`, drop the ownship at ingest, age targets (fresh `< 3 min`, stale `3–10 min`, dropped `> 10 min`), and produce a renderable snapshot (position-less static-only targets excluded). No timers here — every function takes an explicit `nowMs`/`arrivalMs`, so all tests pin literal timestamps.

**Files**
- Create: `app/src/lib/aisTargets.ts`
- Create: `app/src/lib/aisTargets.test.ts`

**Interfaces**
- Consumes: `ParsedAisData` from `app/src/services/aisStream.ts`.
- Produces:
  - `export interface AisTarget { mmsi: string; position?: { lat: number; lon: number }; sogKn?: number; cogDeg?: number; headingDeg?: number; name?: string; shipType?: number; lastUpdateMs: number }`
  - `export type AisAgeTier = 'fresh' | 'stale'`
  - `export interface AisTargetSnapshot extends AisTarget { position: { lat: number; lon: number }; tier: AisAgeTier }`
  - `export const AIS_FRESH_MS: number`, `export const AIS_DROP_MS: number`
  - `export function mergeAisMessage(store: Map<string, AisTarget>, msg: ParsedAisData, arrivalMs: number, ownMmsi?: string): void`
  - `export function ageTier(lastUpdateMs: number, nowMs: number): AisAgeTier`
  - `export function sweepDropped(store: Map<string, AisTarget>, nowMs: number): void`
  - `export function snapshotTargets(store: Map<string, AisTarget>, nowMs: number): AisTargetSnapshot[]`

Steps:

- [ ] Write the failing test `app/src/lib/aisTargets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  AIS_DROP_MS,
  AIS_FRESH_MS,
  ageTier,
  mergeAisMessage,
  snapshotTargets,
  sweepDropped,
  type AisTarget,
} from './aisTargets';
import type { ParsedAisData } from '../services/aisStream';

const POS: ParsedAisData = {
  kind: 'position',
  mmsi: '211234560',
  lat: 54.79,
  lon: 9.43,
  sogKn: 6.3,
  cogDeg: 91,
  headingDeg: 90,
  name: 'ALBATROS',
};
const STATIC: ParsedAisData = { kind: 'static', mmsi: '211234560', name: 'SEEADLER', shipType: 36 };

describe('mergeAisMessage', () => {
  it('creates a target from a PositionReport, carrying its fields and arrival time', () => {
    const store = new Map<string, AisTarget>();
    mergeAisMessage(store, POS, 1000);
    expect(store.get('211234560')).toEqual({
      mmsi: '211234560',
      position: { lat: 54.79, lon: 9.43 },
      sogKn: 6.3,
      cogDeg: 91,
      headingDeg: 90,
      name: 'ALBATROS',
      lastUpdateMs: 1000,
    });
  });

  it('back-fills ship type from a later ShipStaticData while keeping the position', () => {
    const store = new Map<string, AisTarget>();
    mergeAisMessage(store, POS, 1000);
    mergeAisMessage(store, STATIC, 2000);
    const t = store.get('211234560');
    expect(t?.position).toEqual({ lat: 54.79, lon: 9.43 });
    expect(t?.shipType).toBe(36);
    expect(t?.name).toBe('SEEADLER'); // static Name overrides the position's MetaData name
    expect(t?.lastUpdateMs).toBe(2000);
  });

  it('a ShipStaticData before any position creates a position-less (unrenderable) stub', () => {
    const store = new Map<string, AisTarget>();
    mergeAisMessage(store, STATIC, 500);
    const t = store.get('211234560');
    expect(t?.position).toBeUndefined();
    expect(t?.name).toBe('SEEADLER');
    expect(t?.shipType).toBe(36);
  });

  it('a position message replaces stale course fields (sentinel-omitted keys clear)', () => {
    const store = new Map<string, AisTarget>();
    mergeAisMessage(store, POS, 1000);
    mergeAisMessage(store, { kind: 'position', mmsi: '211234560', lat: 54.8, lon: 9.5 }, 2000);
    const t = store.get('211234560');
    expect(t?.position).toEqual({ lat: 54.8, lon: 9.5 });
    expect(t?.sogKn).toBeUndefined();
    expect(t?.cogDeg).toBeUndefined();
    expect(t?.headingDeg).toBeUndefined();
    expect(t?.name).toBe('ALBATROS'); // name persists across a nameless position
  });

  it('drops the ownship at ingest (never stored)', () => {
    const store = new Map<string, AisTarget>();
    mergeAisMessage(store, POS, 1000, '211234560');
    expect(store.size).toBe(0);
  });
});

describe('ageTier', () => {
  it('is fresh below 3 minutes and stale at/after 3 minutes', () => {
    expect(AIS_FRESH_MS).toBe(180_000);
    expect(ageTier(0, 179_999)).toBe('fresh');
    expect(ageTier(0, 180_000)).toBe('stale');
    expect(ageTier(0, 600_000)).toBe('stale');
  });
});

describe('sweepDropped', () => {
  it('removes targets older than 10 minutes, keeping those exactly at the boundary', () => {
    expect(AIS_DROP_MS).toBe(600_000);
    const store = new Map<string, AisTarget>([
      ['keep', { mmsi: 'keep', position: { lat: 54, lon: 9 }, lastUpdateMs: 0 }],
      ['drop', { mmsi: 'drop', position: { lat: 54, lon: 9 }, lastUpdateMs: 0 }],
    ]);
    sweepDropped(store, 600_000); // exactly 10 min: not > drop, both kept
    expect(store.size).toBe(2);
    store.set('drop', { mmsi: 'drop', position: { lat: 54, lon: 9 }, lastUpdateMs: -1 });
    sweepDropped(store, 600_000); // 'drop' now 600_001 old -> removed
    expect(store.has('drop')).toBe(false);
    expect(store.has('keep')).toBe(true);
  });
});

describe('snapshotTargets', () => {
  it('excludes position-less targets and tags each survivor with its age tier', () => {
    const store = new Map<string, AisTarget>([
      ['fresh', { mmsi: 'fresh', position: { lat: 54, lon: 9 }, lastUpdateMs: 500_000 }],
      ['stale', { mmsi: 'stale', position: { lat: 55, lon: 10 }, lastUpdateMs: 0 }],
      ['stub', { mmsi: 'stub', name: 'NO FIX', lastUpdateMs: 500_000 }],
    ]);
    const snap = snapshotTargets(store, 550_000);
    const byMmsi = Object.fromEntries(snap.map((t) => [t.mmsi, t.tier]));
    expect(snap).toHaveLength(2);
    expect(byMmsi).toEqual({ fresh: 'fresh', stale: 'stale' });
  });
});
```

- [ ] Run to see it fail: `npm --prefix app run test -- aisTargets` — fails ("Cannot find module './aisTargets'").

- [ ] Minimal implementation `app/src/lib/aisTargets.ts`:

```ts
import type { ParsedAisData } from '../services/aisStream';

// #25 AIS target store: MMSI-keyed merge of PositionReport + ShipStaticData,
// ownship-filtered at ingest, aged by message-arrival time. Pure — every
// function takes an explicit clock, so the cadence (a ~1 Hz sweeper) lives in
// useAisTraffic and this stays timer-free and unit-testable.

export interface AisTarget {
  mmsi: string;
  // Optional: a ShipStaticData can arrive before any PositionReport, producing a
  // name/type stub that is not renderable until a position exists.
  position?: { lat: number; lon: number };
  sogKn?: number;
  cogDeg?: number;
  headingDeg?: number;
  name?: string;
  shipType?: number;
  lastUpdateMs: number;
}

export type AisAgeTier = 'fresh' | 'stale';

// A renderable target: position guaranteed present, tier computed.
export interface AisTargetSnapshot extends AisTarget {
  position: { lat: number; lon: number };
  tier: AisAgeTier;
}

export const AIS_FRESH_MS = 3 * 60_000; // < 3 min = fresh
export const AIS_DROP_MS = 10 * 60_000; // > 10 min = removed

export function mergeAisMessage(
  store: Map<string, AisTarget>,
  msg: ParsedAisData,
  arrivalMs: number,
  ownMmsi?: string,
): void {
  if (ownMmsi && msg.mmsi === ownMmsi) return; // ownship never enters the store
  const prev = store.get(msg.mmsi);

  if (msg.kind === 'position') {
    // Course fields come solely from this report (a target that stops
    // reporting SOG shows no vector — honest). Name persists from prior data
    // when this report omits it; ship type only ever comes from static data.
    const next: AisTarget = {
      mmsi: msg.mmsi,
      position: { lat: msg.lat, lon: msg.lon },
      lastUpdateMs: arrivalMs,
    };
    const name = msg.name ?? prev?.name;
    if (msg.sogKn !== undefined) next.sogKn = msg.sogKn;
    if (msg.cogDeg !== undefined) next.cogDeg = msg.cogDeg;
    if (msg.headingDeg !== undefined) next.headingDeg = msg.headingDeg;
    if (name !== undefined) next.name = name;
    if (prev?.shipType !== undefined) next.shipType = prev.shipType;
    store.set(msg.mmsi, next);
    return;
  }

  // static: update name/type on the existing target (or a stub), preserving any
  // known position and course.
  const next: AisTarget = { mmsi: msg.mmsi, lastUpdateMs: arrivalMs };
  if (prev?.position !== undefined) next.position = prev.position;
  if (prev?.sogKn !== undefined) next.sogKn = prev.sogKn;
  if (prev?.cogDeg !== undefined) next.cogDeg = prev.cogDeg;
  if (prev?.headingDeg !== undefined) next.headingDeg = prev.headingDeg;
  const name = msg.name ?? prev?.name;
  const shipType = msg.shipType ?? prev?.shipType;
  if (name !== undefined) next.name = name;
  if (shipType !== undefined) next.shipType = shipType;
  store.set(msg.mmsi, next);
}

export function ageTier(lastUpdateMs: number, nowMs: number): AisAgeTier {
  return nowMs - lastUpdateMs < AIS_FRESH_MS ? 'fresh' : 'stale';
}

export function sweepDropped(store: Map<string, AisTarget>, nowMs: number): void {
  for (const [mmsi, t] of store) {
    if (nowMs - t.lastUpdateMs > AIS_DROP_MS) store.delete(mmsi);
  }
}

export function snapshotTargets(
  store: Map<string, AisTarget>,
  nowMs: number,
): AisTargetSnapshot[] {
  const out: AisTargetSnapshot[] = [];
  for (const t of store.values()) {
    if (!t.position) continue; // position-less stubs are not renderable
    out.push({ ...t, position: t.position, tier: ageTier(t.lastUpdateMs, nowMs) });
  }
  return out;
}
```

- [ ] Run to pass: `npm --prefix app run test -- aisTargets` — all green (~9 tests).

- [ ] Typecheck: `npm --prefix app run typecheck` — clean.

- [ ] Commit:
  - `git add app/src/lib/aisTargets.ts app/src/lib/aisTargets.test.ts`
  - `git commit -m "feat: add AIS target store with aging (#25)"`

---

### Task 4: `useAisTraffic` hook

Component-local hook (mirrors `useOwnshipGps`'s local-state discipline): holds the target `Map` in a ref, owns the `AisStreamClient` lifecycle, publishes a snapshot to React at ≤1 Hz, and derives the five-state UI status. It takes `bbox`/`online`/`visible` as plain INPUTS (the map-bound viewport tracking lives in Task 7's `AisTraffic` component), which keeps this hook fully unit-testable with an injected fake client + fake timers — no map, no real socket.

> exactOptionalPropertyTypes: the input's `apiKey`/`ownMmsi` are typed `string | undefined` (required keys whose value may be undefined), NOT `?`-optional — `settings.aisApiKey` is `string | undefined` and passing that into a `?`-optional property is a type error under this compiler flag.

**Files**
- Create: `app/src/state/useAisTraffic.ts`
- Create: `app/src/state/useAisTraffic.test.tsx`

**Interfaces**
- Consumes: `AisStreamClient`, `browserAisSocket`, `AisStreamCallbacks`, `AisClientStatus`, `AisBoundingBox` from `../services/aisStream`; `mergeAisMessage`, `sweepDropped`, `snapshotTargets`, `AisTarget`, `AisTargetSnapshot` from `../lib/aisTargets`.
- Produces:
  - `export type AisStatus = 'off' | 'connecting' | 'live' | 'offline' | 'keyError'`
  - `export interface AisClientLike { start(bbox: AisBoundingBox): void; updateBbox(bbox: AisBoundingBox): void; stop(): void }`
  - `export interface UseAisTrafficInput { apiKey: string | undefined; ownMmsi: string | undefined; bbox: AisBoundingBox | null; online: boolean; visible: boolean }`
  - `export interface UseAisTrafficDeps { createClient?: (apiKey: string, callbacks: AisStreamCallbacks) => AisClientLike; now?: () => number }`
  - `export interface UseAisTrafficResult { status: AisStatus; targets: AisTargetSnapshot[]; targetCount: number }`
  - `export function useAisTraffic(input: UseAisTrafficInput, deps?: UseAisTrafficDeps): UseAisTrafficResult`

Steps:

- [ ] Write the failing test `app/src/state/useAisTraffic.test.tsx`:

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAisTraffic, type AisClientLike, type UseAisTrafficInput } from './useAisTraffic';
import type { AisBoundingBox, AisStreamCallbacks, ParsedAisData } from '../services/aisStream';

const BBOX: AisBoundingBox = [
  [54.6, 9.3],
  [55.0, 10.1],
];
const POS: ParsedAisData = { kind: 'position', mmsi: '211234560', lat: 54.79, lon: 9.43, sogKn: 6 };

function fakeClients() {
  const clients: {
    apiKey: string;
    callbacks: AisStreamCallbacks;
    started: AisBoundingBox[];
    bboxes: AisBoundingBox[];
    stopped: number;
  }[] = [];
  const createClient = (apiKey: string, callbacks: AisStreamCallbacks): AisClientLike => {
    const rec = { apiKey, callbacks, started: [] as AisBoundingBox[], bboxes: [] as AisBoundingBox[], stopped: 0 };
    clients.push(rec);
    return {
      start: (b) => rec.started.push(b),
      updateBbox: (b) => rec.bboxes.push(b),
      stop: () => (rec.stopped += 1),
    };
  };
  return { clients, createClient };
}

const base: UseAisTrafficInput = {
  apiKey: 'KEY',
  ownMmsi: undefined,
  bbox: BBOX,
  online: true,
  visible: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAisTraffic', () => {
  it('is off and creates no client when no key is configured', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() =>
      useAisTraffic({ ...base, apiKey: undefined }, { createClient }),
    );
    expect(clients).toHaveLength(0);
    expect(result.current.status).toBe('off');
  });

  it('starts a client and reports connecting when key+online+visible+bbox all hold', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    expect(clients).toHaveLength(1);
    expect(clients[0].started).toEqual([BBOX]);
    expect(result.current.status).toBe('connecting');
  });

  it('reports live and publishes a target snapshot at the 1 Hz tick', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => {
      clients[0].callbacks.onStatus('live');
      clients[0].callbacks.onMessage(POS);
    });
    expect(result.current.status).toBe('live');
    expect(result.current.targets).toHaveLength(0); // not published until the tick
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);
    expect(result.current.targetCount).toBe(1);
  });

  it('filters the ownship out of the published snapshot', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() =>
      useAisTraffic({ ...base, ownMmsi: '211234560' }, { createClient }),
    );
    act(() => clients[0].callbacks.onMessage(POS));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(0);
  });

  it('goes offline and stops the client, but keeps already-received targets', () => {
    const { clients, createClient } = fakeClients();
    const { result, rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    act(() => clients[0].callbacks.onMessage(POS));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);

    rerender({ ...base, online: false });
    expect(clients[0].stopped).toBe(1);
    expect(result.current.status).toBe('offline');
    // Targets persist and keep aging while mounted.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);
  });

  it('drops targets older than 10 minutes via the tick sweeper', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => clients[0].callbacks.onMessage(POS));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);
    act(() => vi.advanceTimersByTime(600_001)); // > 10 min
    expect(result.current.targets).toHaveLength(0);
  });

  it('surfaces the terminal keyError status', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => clients[0].callbacks.onStatus('keyError'));
    expect(result.current.status).toBe('keyError');
  });

  it('updates the bbox on an existing client rather than recreating it', () => {
    const { clients, createClient } = fakeClients();
    const bbox2: AisBoundingBox = [
      [54.7, 9.4],
      [55.1, 10.2],
    ];
    const { rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    rerender({ ...base, bbox: bbox2 });
    expect(clients).toHaveLength(1);
    expect(clients[0].bboxes).toEqual([bbox2]);
  });

  it('recreates the client when the API key changes (keyError reset)', () => {
    const { clients, createClient } = fakeClients();
    const { rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    rerender({ ...base, apiKey: 'KEY2' });
    expect(clients).toHaveLength(2);
    expect(clients[0].stopped).toBe(1);
    expect(clients[1].apiKey).toBe('KEY2');
  });

  it('stops the client and clears the store on unmount', () => {
    const { clients, createClient } = fakeClients();
    const { unmount } = renderHook(() => useAisTraffic(base, { createClient }));
    unmount();
    expect(clients[0].stopped).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] Run to see it fail: `npm --prefix app run test -- useAisTraffic` — fails ("Cannot find module './useAisTraffic'").

- [ ] Minimal implementation `app/src/state/useAisTraffic.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import {
  AisStreamClient,
  browserAisSocket,
  type AisBoundingBox,
  type AisClientStatus,
  type AisStreamCallbacks,
} from '../services/aisStream';
import {
  mergeAisMessage,
  snapshotTargets,
  sweepDropped,
  type AisTarget,
  type AisTargetSnapshot,
} from '../lib/aisTargets';

export type AisStatus = 'off' | 'connecting' | 'live' | 'offline' | 'keyError';

export interface AisClientLike {
  start(bbox: AisBoundingBox): void;
  updateBbox(bbox: AisBoundingBox): void;
  stop(): void;
}

export interface UseAisTrafficInput {
  // string | undefined (not ?-optional): settings.aisApiKey is string|undefined
  // and exactOptionalPropertyTypes forbids passing undefined into a ?-optional.
  apiKey: string | undefined;
  ownMmsi: string | undefined;
  bbox: AisBoundingBox | null;
  online: boolean;
  visible: boolean;
}

export interface UseAisTrafficDeps {
  createClient?: (apiKey: string, callbacks: AisStreamCallbacks) => AisClientLike;
  now?: () => number;
}

export interface UseAisTrafficResult {
  status: AisStatus;
  targets: AisTargetSnapshot[];
  targetCount: number;
}

function defaultCreateClient(apiKey: string, callbacks: AisStreamCallbacks): AisClientLike {
  return new AisStreamClient(apiKey, callbacks, { socketFactory: browserAisSocket });
}

/**
 * #25 AIS live traffic overlay hook. Mirrors useOwnshipGps: high-frequency data
 * stays local (the target Map lives in a ref; only the ≤1 Hz snapshot is React
 * state), never AppState. Only mounted while the Live tab is active (App gates
 * the mount), so "Live tab active" is implied; the socket additionally requires
 * a non-empty key, navigator.onLine, and document visibility — all passed in.
 * Going offline/hidden stops the socket but KEEPS the store aging; unmount
 * (tab switch) discards it, so a fresh Live visit starts empty.
 */
export function useAisTraffic(
  input: UseAisTrafficInput,
  deps: UseAisTrafficDeps = {},
): UseAisTrafficResult {
  const { apiKey, ownMmsi, bbox, online, visible } = input;
  const createClient = deps.createClient ?? defaultCreateClient;
  const now = deps.now ?? Date.now;

  const keyValid = apiKey !== undefined && apiKey.length > 0;

  const storeRef = useRef<Map<string, AisTarget>>(new Map());
  const clientRef = useRef<AisClientLike | null>(null);
  const clientKeyRef = useRef<string | null>(null);
  // ownMmsi read through a ref so the client's long-lived onMessage closure
  // always filters against the latest value without recreating the client.
  const ownMmsiRef = useRef(ownMmsi);
  ownMmsiRef.current = ownMmsi;

  const [clientStatus, setClientStatus] = useState<AisClientStatus>('closed');
  const [targets, setTargets] = useState<AisTargetSnapshot[]>([]);

  // ≤1 Hz publish tick: doubles as the drop-sweeper and recomputes age tiers so
  // stale targets fade smoothly. One new array per second is exactly the
  // "setData at most 1 Hz" the renderer wants.
  useEffect(() => {
    const id = setInterval(() => {
      const t = now();
      sweepDropped(storeRef.current, t);
      setTargets(snapshotTargets(storeRef.current, t));
    }, 1000);
    return () => clearInterval(id);
  }, [now]);

  // Connection lifecycle. The guard is written inline (not via the `keyValid`
  // boolean) so TypeScript's control-flow analysis narrows `apiKey` to a
  // non-empty string and `bbox` to non-null past it — a separate boolean const
  // would not narrow them, and `createClient(apiKey, …)` would fail strict.
  useEffect(() => {
    if (apiKey === undefined || apiKey.length === 0 || !online || !visible || bbox === null) {
      clientRef.current?.stop();
      clientRef.current = null;
      clientKeyRef.current = null;
      setClientStatus('closed');
      return; // store intentionally NOT cleared — targets persist & keep aging
    }
    if (!clientRef.current || clientKeyRef.current !== apiKey) {
      clientRef.current?.stop();
      const client = createClient(apiKey, {
        onMessage: (msg) => mergeAisMessage(storeRef.current, msg, now(), ownMmsiRef.current),
        onStatus: (s) => setClientStatus(s),
      });
      clientRef.current = client;
      clientKeyRef.current = apiKey;
      client.start(bbox);
    } else {
      clientRef.current.updateBbox(bbox);
    }
  }, [online, visible, bbox, apiKey, createClient, now]);

  // Unmount teardown: a tab switch discards the store so a fresh Live visit
  // starts empty (spec).
  useEffect(() => {
    const store = storeRef.current;
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
      store.clear();
    };
  }, []);

  const status: AisStatus = !keyValid
    ? 'off'
    : !online
      ? 'offline'
      : clientStatus === 'keyError'
        ? 'keyError'
        : clientStatus === 'live'
          ? 'live'
          : 'connecting';

  return { status, targets, targetCount: targets.length };
}
```

- [ ] Run to pass: `npm --prefix app run test -- useAisTraffic` — all green (~10 tests).

- [ ] Typecheck + lint: `npm --prefix app run typecheck && npm --prefix app run lint` — clean (note the intentional `apiKey` non-null flow: inside the `active` branch `keyValid` guarantees `apiKey` is a non-empty string, so `createClient(apiKey, …)` / `clientKeyRef.current = apiKey` are sound).

- [ ] Commit:
  - `git add app/src/state/useAisTraffic.ts app/src/state/useAisTraffic.test.tsx`
  - `git commit -m "feat: add useAisTraffic lifecycle hook (#25)"`

---

### Task 5: GeoJSON + popup builders (`aisGeoJson.ts`) + `AisLayer` map component

Splits the map layer into a PURE, unit-tested part (feature-collection builder + popup rows) and the imperative `AisLayer` component (GeoJSON source, three declutter-tiered layers, themed popup) that — like `DataLayers`/`BoatMarker` — is NOT unit-tested (jsdom has no MapLibre/WebGL) and is verified in-browser in Task 8.

**Files**
- Create: `app/src/lib/projectionVector.ts` (pure, reusable — #141 ownship vector will consume it too)
- Create: `app/src/lib/projectionVector.test.ts`
- Create: `app/src/lib/aisGeoJson.ts`
- Create: `app/src/lib/aisGeoJson.test.ts`
- Create: `app/src/components/AisLayer.tsx`
- Modify: `app/src/app.css` (`.ais-popup` popup-chrome theming)

**Interfaces**
- Consumes: `AisTargetSnapshot` from `../lib/aisTargets`; `projectionLine` from `../lib/projectionVector`; `formatHeading`, `formatKn` from `../lib/format`; `MsgKey` from `../i18n/dict.de`; `useMapInstance` from `./MapView`; `ROUTE_STACK_BOTTOM_LAYER` from `./RouteLayer`. (`projectionVector.ts` itself consumes `destinationPoint` from `../lib/geo` + `LatLon` from `../types`.)
- Produces:
  - `export function projectionLine(pos: LatLon, cogDeg: number, sogKn: number, minutes: number): [LatLon, LatLon]` — the shared "where in N minutes" geometry; a 2-point line `pos → destinationPoint(pos, cogDeg, sogKn*minutes/60)`. Pure; the caller decides whether to draw (e.g. suppress a stationary zero-length line). Reused by #141 (ownship projection vector) — do NOT inline this math anywhere.
  - `export const AIS_VECTOR_MINUTES = 6`
  - `export function aisFeatureCollection(targets: AisTargetSnapshot[]): GeoJSON.FeatureCollection`
  - `export interface AisPopupProps { mmsi: string; name: string; shipType: number | null; sog: number | null; cog: number | null; heading: number | null; lastUpdateMs: number }`
  - `export function aisPopupRows(props: AisPopupProps, nowMs: number): { labelKey: MsgKey; value: string }[]`
  - (AisLayer) `export const AIS_SOURCE = 'sc-ais'`, `export const AIS_VESSEL_LAYER = 'sc-ais-vessels'`, `export default function AisLayer(props: { targets: AisTargetSnapshot[] })`.

Steps:

- [ ] Write the failing test `app/src/lib/aisGeoJson.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AIS_VECTOR_MINUTES, aisFeatureCollection, aisPopupRows } from './aisGeoJson';
import { destinationPoint } from './geo';
import type { AisTargetSnapshot } from './aisTargets';

function target(overrides: Partial<AisTargetSnapshot>): AisTargetSnapshot {
  return {
    mmsi: '211234560',
    position: { lat: 54.79, lon: 9.43 },
    lastUpdateMs: 1000,
    tier: 'fresh',
    ...overrides,
  };
}

describe('aisFeatureCollection', () => {
  it('emits a vessel Point rotated to true heading, with course available', () => {
    const fc = aisFeatureCollection([target({ headingDeg: 90, cogDeg: 80, sogKn: 0 })]);
    const vessel = fc.features.find((f) => f.geometry.type === 'Point');
    expect(vessel?.properties).toMatchObject({
      mmsi: '211234560',
      kind: 'vessel',
      tier: 'fresh',
      hasCourse: true,
      rotation: 90,
    });
  });

  it('falls back to COG for rotation when true heading is absent', () => {
    const fc = aisFeatureCollection([target({ cogDeg: 80, sogKn: 0 })]);
    const vessel = fc.features.find((f) => f.geometry.type === 'Point');
    expect(vessel?.properties).toMatchObject({ hasCourse: true, rotation: 80 });
  });

  it('marks a target with neither heading nor COG as course-less (rotation 0, no vector)', () => {
    const fc = aisFeatureCollection([target({ sogKn: 5 })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ hasCourse: false, rotation: 0 });
  });

  it('adds a COG vector LineString of 6 minutes at SOG when moving with a course', () => {
    const fc = aisFeatureCollection([target({ cogDeg: 90, sogKn: 6 })]);
    const vector = fc.features.find((f) => f.geometry.type === 'LineString');
    expect(vector?.properties).toMatchObject({ mmsi: '211234560', kind: 'vector', tier: 'fresh' });
    // 6 kn for 6 min = 0.6 nm along COG 90 from the vessel position.
    const end = destinationPoint({ lat: 54.79, lon: 9.43 }, 90, (6 * AIS_VECTOR_MINUTES) / 60);
    const coords = (vector?.geometry as GeoJSON.LineString).coordinates;
    expect(coords[0]).toEqual([9.43, 54.79]);
    expect(coords[1][0]).toBeCloseTo(end.lon, 6);
    expect(coords[1][1]).toBeCloseTo(end.lat, 6);
  });

  it('suppresses the vector when SOG is zero', () => {
    const fc = aisFeatureCollection([target({ cogDeg: 90, sogKn: 0 })]);
    expect(fc.features.filter((f) => f.geometry.type === 'LineString')).toHaveLength(0);
  });

  it('labels with the name, falling back to the MMSI when unnamed', () => {
    const named = aisFeatureCollection([target({ name: 'ALBATROS' })]);
    const unnamed = aisFeatureCollection([target({})]);
    expect(named.features[0].properties?.label).toBe('ALBATROS');
    expect(unnamed.features[0].properties?.label).toBe('211234560');
  });

  it('propagates the stale tier to both the vessel and its vector', () => {
    const fc = aisFeatureCollection([target({ tier: 'stale', cogDeg: 90, sogKn: 6 })]);
    expect(fc.features.every((f) => f.properties?.tier === 'stale')).toBe(true);
  });
});

describe('aisPopupRows', () => {
  it('builds localized rows from a moving, named target', () => {
    const rows = aisPopupRows(
      { mmsi: '211234560', name: 'ALBATROS', shipType: 36, sog: 6.3, cog: 91.4, heading: 90, lastUpdateMs: 0 },
      120_000, // 2 minutes later
    );
    expect(rows).toEqual([
      { labelKey: 'ais.popup.name', value: 'ALBATROS' },
      { labelKey: 'ais.popup.mmsi', value: '211234560' },
      { labelKey: 'ais.popup.shipType', value: '36' },
      { labelKey: 'ais.popup.sog', value: '6.3 kn' },
      { labelKey: 'ais.popup.cog', value: '091°' },
      { labelKey: 'ais.popup.age', value: '2 min' },
    ]);
  });

  it('omits absent fields and uses the MMSI as the name fallback', () => {
    const rows = aisPopupRows(
      { mmsi: '211234560', name: '', shipType: null, sog: null, cog: null, heading: null, lastUpdateMs: 0 },
      30_000,
    );
    expect(rows).toEqual([
      { labelKey: 'ais.popup.name', value: '211234560' },
      { labelKey: 'ais.popup.mmsi', value: '211234560' },
      { labelKey: 'ais.popup.age', value: '0 min' },
    ]);
  });
});
```

> `formatHeading(91.4)` → `'091°'` and `formatKn(6.3)` → `'6.3 kn'` are the existing `lib/format` behaviors — confirm against `app/src/lib/format.test.ts` while implementing and adjust the pinned literals if that file shows a different exact form. These are independent, separately-tested functions, so using them is not a mutation-check tautology.

- [ ] Run to see it fail: `npm --prefix app run test -- aisGeoJson` — fails ("Cannot find module './aisGeoJson'").

- [ ] Minimal implementation `app/src/lib/aisGeoJson.ts`:

```ts
import { destinationPoint } from './geo';
import { formatHeading, formatKn } from './format';
import type { AisTargetSnapshot } from './aisTargets';
import type { MsgKey } from '../i18n/dict.de';

// A COG vector shows where a vessel reaches in this many minutes at current SOG.
export const AIS_VECTOR_MINUTES = 6;

/**
 * #25: one GeoJSON FeatureCollection for the AIS overlay. Per target: a vessel
 * Point (props drive paint/rotation/label + declutter) and, when moving with a
 * known course, a COG-vector LineString. Rotation prefers true heading, falls
 * back to COG, else a neutral dot (hasCourse:false, rotation:0). Nested objects
 * are avoided in properties — a MapLibre GeoJSON source stringifies them on
 * read-back (the seamarks flat-props lesson).
 */
export function aisFeatureCollection(targets: AisTargetSnapshot[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const t of targets) {
    const courseDeg = t.headingDeg ?? t.cogDeg;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.position.lon, t.position.lat] },
      properties: {
        mmsi: t.mmsi,
        kind: 'vessel',
        tier: t.tier,
        hasCourse: courseDeg !== undefined,
        rotation: courseDeg ?? 0,
        label: t.name ?? t.mmsi,
        name: t.name ?? '',
        shipType: t.shipType ?? null,
        sog: t.sogKn ?? null,
        cog: t.cogDeg ?? null,
        heading: t.headingDeg ?? null,
        lastUpdateMs: t.lastUpdateMs,
      },
    });
    if (t.sogKn !== undefined && t.sogKn > 0 && courseDeg !== undefined) {
      const end = destinationPoint(t.position, courseDeg, (t.sogKn * AIS_VECTOR_MINUTES) / 60);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [t.position.lon, t.position.lat],
            [end.lon, end.lat],
          ],
        },
        properties: { mmsi: t.mmsi, kind: 'vector', tier: t.tier },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// Popup content, read back off the tapped feature's (flat) properties. Numeric
// props are `number | null` after the GeoJSON round-trip.
export interface AisPopupProps {
  mmsi: string;
  name: string;
  shipType: number | null;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  lastUpdateMs: number;
}

export function aisPopupRows(props: AisPopupProps, nowMs: number): { labelKey: MsgKey; value: string }[] {
  const rows: { labelKey: MsgKey; value: string }[] = [
    { labelKey: 'ais.popup.name', value: props.name.length > 0 ? props.name : props.mmsi },
    { labelKey: 'ais.popup.mmsi', value: props.mmsi },
  ];
  if (props.shipType !== null) rows.push({ labelKey: 'ais.popup.shipType', value: String(props.shipType) });
  if (props.sog !== null) rows.push({ labelKey: 'ais.popup.sog', value: formatKn(props.sog) });
  if (props.cog !== null) rows.push({ labelKey: 'ais.popup.cog', value: formatHeading(props.cog) });
  const ageMin = Math.max(0, Math.round((nowMs - props.lastUpdateMs) / 60_000));
  rows.push({ labelKey: 'ais.popup.age', value: `${ageMin} min` });
  return rows;
}
```

- [ ] Run to pass: `npm --prefix app run test -- aisGeoJson` — all green (~9 tests).

- [ ] Create the map component `app/src/components/AisLayer.tsx` (NOT unit-tested — verified in-browser, Task 8):

```tsx
import { useEffect, useRef } from 'react';
import { Map as MaplibreMap, Popup } from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { aisFeatureCollection, aisPopupRows, type AisPopupProps } from '../lib/aisGeoJson';
import type { AisTargetSnapshot } from '../lib/aisTargets';

export const AIS_SOURCE = 'sc-ais';
export const AIS_VECTOR_LAYER = 'sc-ais-vectors';
export const AIS_VESSEL_LAYER = 'sc-ais-vessels';
export const AIS_LABEL_LAYER = 'sc-ais-labels';

const ARROW_IMAGE = 'sc-ais-arrow';
const DOT_IMAGE = 'sc-ais-dot';
const AIS_COLOR = '#009E73'; // Okabe-Ito green, distinct from BoatMarker's blue

// Same one-shot style-ready helper as DataLayers/RouteLayer (map 'load' fires
// once; valid only for one-time setup).
function whenStyleReady(map: MaplibreMap, fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('load', fn);
}

// A crisp directional arrow + a neutral dot, registered as map images so the
// symbol layer can rotate the arrow via icon-rotate. Built on a canvas (no DOM
// image fetch); skipped where there's no 2D backend (jsdom).
function registerAisImages(map: MaplibreMap): void {
  const size = 32;
  if (!map.hasImage(ARROW_IMAGE)) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(size / 2, 3); // bow (points "up" = 0°, rotated by icon-rotate)
      ctx.lineTo(size - 7, size - 5);
      ctx.lineTo(size / 2, size - 11);
      ctx.lineTo(7, size - 5);
      ctx.closePath();
      ctx.fillStyle = AIS_COLOR;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      map.addImage(ARROW_IMAGE, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
    }
  }
  if (!map.hasImage(DOT_IMAGE)) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 6, 0, 2 * Math.PI);
      ctx.fillStyle = AIS_COLOR;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      map.addImage(DOT_IMAGE, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
    }
  }
}

function setupLayers(map: MaplibreMap): void {
  // Anchor below the route stack (resolved at add time) so AIS renders ABOVE the
  // depth/seamark overlays (added earlier, also below the anchor) but BELOW the
  // route stack and the ownship marker (a DOM Marker, always on top).
  const beforeId = map.getLayer(ROUTE_STACK_BOTTOM_LAYER) ? ROUTE_STACK_BOTTOM_LAYER : undefined;
  if (map.getSource(AIS_SOURCE)) return;
  map.addSource(AIS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  // COG vectors (below the vessel glyph); hidden below ~zoom 9 (declutter).
  map.addLayer(
    {
      id: AIS_VECTOR_LAYER,
      type: 'line',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vector'],
      minzoom: 9,
      paint: {
        'line-color': AIS_COLOR,
        'line-width': 1.5,
        'line-opacity': ['match', ['get', 'tier'], 'stale', 0.4, 0.85],
      },
    },
    beforeId,
  );

  // Vessel glyphs: arrow when a course is known (and zoom ≥ 9), else a neutral
  // dot; stale targets faded. icon-rotate turns the arrow to heading/COG.
  map.addLayer(
    {
      id: AIS_VESSEL_LAYER,
      type: 'symbol',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vessel'],
      layout: {
        'icon-image': [
          'step',
          ['zoom'],
          DOT_IMAGE,
          9,
          ['case', ['get', 'hasCourse'], ARROW_IMAGE, DOT_IMAGE],
        ],
        'icon-rotate': ['get', 'rotation'],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 0.9],
        'icon-allow-overlap': true,
      },
      paint: { 'icon-opacity': ['match', ['get', 'tier'], 'stale', 0.5, 1] },
    },
    beforeId,
  );

  // Name labels only at ≥ ~zoom 11, collision-culled.
  map.addLayer(
    {
      id: AIS_LABEL_LAYER,
      type: 'symbol',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vessel'],
      minzoom: 11,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
        'text-opacity': ['match', ['get', 'tier'], 'stale', 0.55, 1],
      },
    },
    beforeId,
  );
}

export default function AisLayer({ targets }: { targets: AisTargetSnapshot[] }) {
  const map = useMapInstance();
  const t = useT();
  const styleReadyRef = useRef(false);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  // One-time source/layer/image setup, gated on the style being ready.
  useEffect(() => {
    if (!map) return;
    whenStyleReady(map, () => {
      registerAisImages(map);
      setupLayers(map);
      styleReadyRef.current = true;
      // Paint whatever targets already arrived before the style finished.
      (map.getSource(AIS_SOURCE) as GeoJSONSource | undefined)?.setData(
        aisFeatureCollection(targets),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time setup; targets flow through the setData effect below
  }, [map]);

  // ≤1 Hz setData: `targets` is already published at ≤1 Hz by useAisTraffic.
  useEffect(() => {
    if (!map || !styleReadyRef.current) return;
    (map.getSource(AIS_SOURCE) as GeoJSONSource | undefined)?.setData(aisFeatureCollection(targets));
  }, [map, targets]);

  // Tap a vessel -> themed popup (seamark pattern): built via DOM APIs, one
  // popup at a time, dismissed by a tap elsewhere (MapLibre default).
  useEffect(() => {
    if (!map) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const props: AisPopupProps = {
        mmsi: String(p.mmsi ?? ''),
        name: String(p.name ?? ''),
        shipType: typeof p.shipType === 'number' ? p.shipType : null,
        sog: typeof p.sog === 'number' ? p.sog : null,
        cog: typeof p.cog === 'number' ? p.cog : null,
        heading: typeof p.heading === 'number' ? p.heading : null,
        lastUpdateMs: typeof p.lastUpdateMs === 'number' ? p.lastUpdateMs : Date.now(),
      };
      const container = document.createElement('div');
      container.className = 'ais-popover';
      for (const row of aisPopupRows(props, Date.now())) {
        const line = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = `${tRef.current(row.labelKey)}: `;
        line.append(label, document.createTextNode(row.value));
        container.append(line);
      }
      const disclaimer = document.createElement('p');
      disclaimer.className = 'ais-popover-disclaimer';
      disclaimer.textContent = tRef.current('ais.disclaimer');
      container.append(disclaimer);
      new Popup({ closeButton: true, maxWidth: '240px', className: 'ais-popup' })
        .setLngLat(e.lngLat)
        .setDOMContent(container)
        .addTo(map);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', AIS_VESSEL_LAYER, handleClick);
    map.on('mouseenter', AIS_VESSEL_LAYER, enter);
    map.on('mouseleave', AIS_VESSEL_LAYER, leave);
    return () => {
      map.off('click', AIS_VESSEL_LAYER, handleClick);
      map.off('mouseenter', AIS_VESSEL_LAYER, enter);
      map.off('mouseleave', AIS_VESSEL_LAYER, leave);
    };
  }, [map]);

  return null;
}
```

- [ ] Add `.ais-popup` theming + popover typography to `app/src/app.css`, immediately after the `.seamark-popup .maplibregl-popup-tip { … }` block:

```css
/* AIS vessel popup (#25) — content of a MapLibre Popup's setDOMContent. */
.ais-popover {
  font-size: 0.85rem;
  color: var(--sc-fg);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.ais-popover-disclaimer {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  opacity: 0.75;
}

/* Theme MapLibre's own popup chrome (it hardcodes a white background with no
   dark variant); cover both tip directions. Same fix as .seamark-popup. */
.ais-popup .maplibregl-popup-content {
  background: var(--sc-bg);
}

.ais-popup .maplibregl-popup-tip {
  border-top-color: var(--sc-bg);
  border-bottom-color: var(--sc-bg);
}
```

- [ ] Add the popup + disclaimer i18n keys to BOTH dicts (required now: `aisGeoJson.ts` types its `labelKey`s as `MsgKey`, so typecheck fails without them). In `app/src/i18n/dict.de.ts`, before the closing `} as const;`:

```ts
  // #25 AIS overlay — vessel popup + shared disclaimer.
  'ais.popup.name': 'Name',
  'ais.popup.mmsi': 'MMSI',
  'ais.popup.shipType': 'Schiffstyp',
  'ais.popup.sog': 'SOG',
  'ais.popup.cog': 'COG',
  'ais.popup.age': 'Letztes Signal vor',
  'ais.disclaimer':
    'AIS-Abdeckung stammt von freiwilligen Landstationen und ist nicht garantiert oder vollständig. Diese Anzeige ist eine Aufmerksamkeitshilfe, keine Kollisionsverhütung und kein Navigationsgerät.',
```

In `app/src/i18n/dict.en.ts`, at the matching position before `} satisfies Record<MsgKey, string>;`:

```ts
  // #25 AIS overlay — vessel popup + shared disclaimer.
  'ais.popup.name': 'Name',
  'ais.popup.mmsi': 'MMSI',
  'ais.popup.shipType': 'Ship type',
  'ais.popup.sog': 'SOG',
  'ais.popup.cog': 'COG',
  'ais.popup.age': 'Last signal',
  'ais.disclaimer':
    'AIS coverage comes from volunteer shore stations and is not guaranteed or complete. This overlay is an awareness aid, not collision avoidance and not a navigation device.',
```

- [ ] Typecheck + lint: `npm --prefix app run typecheck && npm --prefix app run lint` — clean.

- [ ] Commit:
  - `git add app/src/lib/aisGeoJson.ts app/src/lib/aisGeoJson.test.ts app/src/components/AisLayer.tsx app/src/app.css app/src/i18n/dict.de.ts app/src/i18n/dict.en.ts`
  - `git commit -m "feat: add AIS GeoJSON builder + map layer (#25)"`

---

### Task 6: Settings UI — AIS group in OptionsPanel

Adds an AIS group to `OptionsPanel`: an API-key text field and an MMSI text field (both wrapped in the existing `Field` primitive), an inline MMSI validation message, and privacy help text. Uses the same `onChange({ ...value, … })` idiom as the panel's existing checkboxes.

**Files**
- Modify: `app/src/components/OptionsPanel.tsx`
- Modify: `app/src/i18n/dict.de.ts`, `app/src/i18n/dict.en.ts`
- Test (modify): `app/src/components/OptionsPanel.test.tsx`

**Interfaces**
- Consumes: `Field` from `./Field`; `isValidMmsi` from `../lib/mmsi`; `Settings` (with `aisApiKey?`, `ownMmsi?`).
- Produces: no new exports (UI only).

Steps:

- [ ] Add the AIS i18n keys to BOTH dicts. In `app/src/i18n/dict.de.ts`, after the `ais.disclaimer` key added in Task 5:

```ts
  'options.ais.apiKey.label': 'AIS-API-Schlüssel (aisstream.io)',
  'options.ais.mmsi.label': 'Eigene MMSI (optional)',
  'options.ais.mmsi.invalid': 'Die MMSI muss aus genau 9 Ziffern bestehen.',
  'options.ais.help':
    'Zeigt Live-Schiffsverkehr aus der Umgebung nur in der Live-Ansicht (nur online). Erstelle einen kostenlosen API-Schlüssel auf aisstream.io und füge ihn hier ein. Schlüssel und MMSI bleiben nur auf diesem Gerät gespeichert; der Schlüssel wird ausschließlich an aisstream.io als Teil des Abonnements gesendet, die MMSI dient nur dazu, das eigene Schiff aus der Anzeige herauszufiltern, und wird niemals übertragen. Aufmerksamkeitshilfe, kein Navigationsgerät.',
```

In `app/src/i18n/dict.en.ts`, at the matching position:

```ts
  'options.ais.apiKey.label': 'AIS API key (aisstream.io)',
  'options.ais.mmsi.label': 'Your MMSI (optional)',
  'options.ais.mmsi.invalid': 'MMSI must be exactly 9 digits.',
  'options.ais.help':
    'Shows live surrounding vessel traffic in the Live view only (online only). Create a free API key at aisstream.io and paste it here. Your key and MMSI stay on this device; the key is sent only to aisstream.io as part of the subscription, and the MMSI is used only to filter your own vessel out of the display and is never transmitted. An awareness aid, not a navigation device.',
```

- [ ] Write the failing test additions in `app/src/components/OptionsPanel.test.tsx` (inside `describe('OptionsPanel', …)`, after the ownship tests). Also extend `renderPanel` to accept a settings override:

```ts
  // #25 AIS group. renderPanel is extended to take a value override so the
  // MMSI-validation branches can be exercised without a controlled parent.
  it('renders the AIS API-key and MMSI fields with the privacy help text', () => {
    renderPanel();
    expect(screen.getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
    expect(screen.getByLabelText('Your MMSI (optional)')).toBeInTheDocument();
    expect(screen.getByText(/stay on this device/)).toBeInTheDocument();
    expect(screen.getByText(/only to aisstream\.io/)).toBeInTheDocument();
    expect(screen.getByText(/never transmitted/)).toBeInTheDocument();
  });

  it('commits the API key on change', () => {
    const onChange = renderPanel();
    fireEvent.change(screen.getByLabelText('AIS API key (aisstream.io)'), {
      target: { value: 'my-key' },
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, aisApiKey: 'my-key' });
  });

  it('shows the MMSI validation message for a non-empty, non-9-digit value', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <OptionsPanel value={{ ...DEFAULT_SETTINGS, ownMmsi: '123' }} onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText('MMSI must be exactly 9 digits.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your MMSI (optional)')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows no MMSI validation message for a valid 9-digit value', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <OptionsPanel value={{ ...DEFAULT_SETTINGS, ownMmsi: '211234560' }} onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your MMSI (optional)')).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows no MMSI validation message when the field is empty (feature simply off)', () => {
    renderPanel();
    expect(screen.queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
  });
```

- [ ] Run to see it fail: `npm --prefix app run test -- OptionsPanel` — the new tests fail (fields not present).

- [ ] Minimal implementation in `app/src/components/OptionsPanel.tsx`. Add imports at the top:

```ts
import Field from './Field';
import { isValidMmsi } from '../lib/mmsi';
```

Inside `OptionsPanel`, compute the validation flag before the `return` (after `const t = useT();`):

```ts
  const mmsi = value.ownMmsi ?? '';
  const mmsiInvalid = mmsi !== '' && !isValidMmsi(mmsi);
```

Then, immediately before the closing `</div>` of `.options-panel` (after the ownship help paragraph), add the AIS group:

```tsx
      {/* #25 AIS live traffic overlay (Live tab only): BYOK aisstream.io key +
          own-vessel MMSI. Text fields (not NumberInput — the key is
          alphanumeric and the MMSI is a string that preserves leading zeros).
          Both commit on change like the checkboxes above. */}
      <Field
        label={t('options.ais.apiKey.label')}
        htmlFor="options-aisApiKey"
        help={t('options.ais.help')}
        helpId="options-ais-help"
      >
        <input
          id="options-aisApiKey"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="options-ais-help"
          value={value.aisApiKey ?? ''}
          onChange={(e) => onChange({ ...value, aisApiKey: e.target.value })}
        />
      </Field>
      <Field label={t('options.ais.mmsi.label')} htmlFor="options-ownMmsi">
        <input
          id="options-ownMmsi"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={mmsiInvalid}
          aria-describedby={mmsiInvalid ? 'options-ownMmsi-error' : undefined}
          value={mmsi}
          onChange={(e) => onChange({ ...value, ownMmsi: e.target.value })}
        />
      </Field>
      {mmsiInvalid && (
        <p className="options-help" id="options-ownMmsi-error" role="alert">
          {t('options.ais.mmsi.invalid')}
        </p>
      )}
```

> `value.aisApiKey ?? ''` / `value.ownMmsi ?? ''` keep the `<input>` controlled with a string even when the optional field is absent. `onChange` always writes a string (never `undefined`), so exactOptionalPropertyTypes stays satisfied — an emptied field stores `''`, which reads as "off".

- [ ] Run to pass: `npm --prefix app run test -- OptionsPanel` — all green (existing + 5 new).

- [ ] Typecheck + lint: `npm --prefix app run typecheck && npm --prefix app run lint` — clean.

- [ ] Commit:
  - `git add app/src/components/OptionsPanel.tsx app/src/components/OptionsPanel.test.tsx app/src/i18n/dict.de.ts app/src/i18n/dict.en.ts`
  - `git commit -m "feat: add AIS settings group to OptionsPanel (#25)"`

---

### Task 7: `AisTraffic` component (status chip + hook + layer) and Live-tab wiring

Creates `AisTraffic`, mounted only while the Live tab is active, inside MapView's subtree: it reads the map instance, tracks the debounced viewport bbox (padded ~20%) and online/visibility, calls `useAisTraffic`, renders `<AisLayer>` (map layers) and a five-state status chip overlay (a map overlay like `.data-layer-controls` — no panel-slot plumbing). The presentational `AisStatusChip` is exported and unit-tested for all five states; `AisTraffic` itself is map/hook-bound and verified in-browser. Finally, wires it into `App` and registers the AIS vessel layer in `interactiveLayerIds`.

**Files**
- Create: `app/src/components/AisTraffic.tsx`
- Create: `app/src/components/AisTraffic.test.tsx` (covers the exported `AisStatusChip`)
- Modify: `app/src/app.css` (`.ais-status` overlay positioning + chip state colors)
- Modify: `app/src/App.tsx` (mount `AisTraffic` under `tab === 'live'`; add `AIS_VESSEL_LAYER` to `INTERACTIVE_MAP_LAYER_IDS`)
- Modify: `app/src/i18n/dict.de.ts`, `app/src/i18n/dict.en.ts` (five status strings)

**Interfaces**
- Consumes: `useMapInstance` from `./MapView`; `useOnline` from `../state/AppState`; `useAisTraffic`, `AisStatus` from `../state/useAisTraffic`; `AisLayer`, `AIS_VESSEL_LAYER` from `./AisLayer`; `padBoundingBox`, `viewportEscapedBbox`, `AisBoundingBox` from `../services/aisStream`; `Chip` from `./Chip`; `useT` from `../i18n`; `MsgKey` from `../i18n/dict.de`.
- Produces:
  - `export function AisStatusChip(props: { status: AisStatus; targetCount: number }): JSX.Element`
  - `export default function AisTraffic(props: { apiKey: string | undefined; ownMmsi: string | undefined }): JSX.Element`

Steps:

- [ ] Add the five status i18n keys to BOTH dicts. In `app/src/i18n/dict.de.ts`, after the `options.ais.*` keys:

```ts
  'ais.status.off': 'AIS aus — Schlüssel in den Optionen eingeben',
  'ais.status.connecting': 'AIS verbindet…',
  'ais.status.live': 'AIS live · {count} Schiffe',
  'ais.status.offline': 'AIS offline',
  'ais.status.keyError': 'AIS: API-Schlüssel prüfen',
```

In `app/src/i18n/dict.en.ts`, at the matching position:

```ts
  'ais.status.off': 'AIS off — add a key in Options',
  'ais.status.connecting': 'AIS connecting…',
  'ais.status.live': 'AIS live · {count} vessels',
  'ais.status.offline': 'AIS offline',
  'ais.status.keyError': 'AIS: check your API key',
```

- [ ] Write the failing test `app/src/components/AisTraffic.test.tsx` (covers the pure `AisStatusChip`):

```ts
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { I18nProvider } from '../i18n';
import { AisStatusChip } from './AisTraffic';
import type { AisStatus } from '../state/useAisTraffic';

function renderChip(status: AisStatus, targetCount = 0) {
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <AisStatusChip status={status} targetCount={targetCount} />
    </I18nProvider>,
  );
}

describe('AisStatusChip', () => {
  it('renders the off state with the enable hint', () => {
    renderChip('off');
    expect(screen.getByText('AIS off — add a key in Options')).toBeInTheDocument();
  });

  it('renders the connecting state', () => {
    renderChip('connecting');
    expect(screen.getByText('AIS connecting…')).toBeInTheDocument();
  });

  it('renders the live state with the target count', () => {
    renderChip('live', 7);
    expect(screen.getByText('AIS live · 7 vessels')).toBeInTheDocument();
  });

  it('renders the offline state', () => {
    renderChip('offline');
    expect(screen.getByText('AIS offline')).toBeInTheDocument();
  });

  it('renders the key-error state', () => {
    renderChip('keyError');
    expect(screen.getByText('AIS: check your API key')).toBeInTheDocument();
  });

  it('carries a status-specific class for styling', () => {
    renderChip('live', 3);
    expect(screen.getByText('AIS live · 3 vessels')).toHaveClass('ais-status-live');
  });
});
```

- [ ] Run to see it fail: `npm --prefix app run test -- AisTraffic` — fails ("Cannot find module './AisTraffic'").

- [ ] Minimal implementation `app/src/components/AisTraffic.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { useOnline } from '../state/AppState';
import { useAisTraffic, type AisStatus } from '../state/useAisTraffic';
import AisLayer from './AisLayer';
import Chip from './Chip';
import {
  padBoundingBox,
  viewportEscapedBbox,
  type AisBoundingBox,
} from '../services/aisStream';
import type { MsgKey } from '../i18n/dict.de';

const AIS_BBOX_PAD = 0.2; // subscribe to the viewport padded 20% each side
const AIS_RESUBSCRIBE_DEBOUNCE_MS = 2000;

const STATUS_KEY: Record<Exclude<AisStatus, 'live'>, MsgKey> = {
  off: 'ais.status.off',
  connecting: 'ais.status.connecting',
  offline: 'ais.status.offline',
  keyError: 'ais.status.keyError',
};

// Pure, unit-tested: the five-state status chip. Kept separate from the
// map/hook wiring so it can be tested without a MapLibre instance.
export function AisStatusChip({ status, targetCount }: { status: AisStatus; targetCount: number }) {
  const t = useT();
  const text = status === 'live' ? t('ais.status.live', { count: targetCount }) : t(STATUS_KEY[status]);
  return (
    <div className="ais-status" role="status">
      <Chip className={`ais-status-chip ais-status-${status}`}>{text}</Chip>
    </div>
  );
}

/**
 * #25: the Live-tab AIS overlay controller. Mounted only while tab === 'live'
 * (App), inside MapView's subtree so useMapInstance()/AisLayer see the map.
 * Owns the viewport→bbox subscription (debounced moveend, padded, re-sent only
 * when the view leaves the padded box) and the online/visibility gates, then
 * delegates the socket lifecycle to useAisTraffic. Renders the vessel layers
 * (AisLayer) plus a status-chip overlay on the map.
 */
export default function AisTraffic({
  apiKey,
  ownMmsi,
}: {
  apiKey: string | undefined;
  ownMmsi: string | undefined;
}) {
  const map = useMapInstance();
  const online = useOnline();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [bbox, setBbox] = useState<AisBoundingBox | null>(null);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Track the viewport, debounced. Re-pad (and thus re-subscribe) only when the
  // current view escapes the padded box we last subscribed to — a small pan
  // inside the pad margin sends nothing.
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const b = map.getBounds();
      const sw = { lat: b.getSouth(), lon: b.getWest() };
      const ne = { lat: b.getNorth(), lon: b.getEast() };
      setBbox((prev) => (prev && !viewportEscapedBbox(prev, sw, ne) ? prev : padBoundingBox(sw, ne, AIS_BBOX_PAD)));
    };
    update(); // initial bbox
    let timer: number | undefined;
    const onMoveEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, AIS_RESUBSCRIBE_DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      window.clearTimeout(timer);
      map.off('moveend', onMoveEnd);
    };
  }, [map]);

  const { status, targets, targetCount } = useAisTraffic({ apiKey, ownMmsi, bbox, online, visible });

  return (
    <>
      <AisLayer targets={targets} />
      <AisStatusChip status={status} targetCount={targetCount} />
    </>
  );
}
```

- [ ] Run to pass: `npm --prefix app run test -- AisTraffic` — 6 passing.

- [ ] Add `.ais-status` overlay styles to `app/src/app.css` (after the `.ais-popup` block from Task 5). Position it so it never collides with `.data-layer-controls` (top-left) or RouteLayer's plan-gated cluster (top-right):

```css
/* AIS status chip (#25) — a small map overlay on the Live tab, top-centered so
   it clears the top-left data-layer controls and the top-right route cluster. */
.ais-status {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  pointer-events: none;
}

.ais-status-chip {
  background: color-mix(in srgb, var(--sc-bg) 88%, transparent);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
}

.ais-status-live {
  color: #009e73;
}

.ais-status-offline,
.ais-status-keyError {
  color: #d55e00;
}
```

- [ ] Wire `AisTraffic` into `app/src/App.tsx`:
  - Add imports near the other component imports:

```ts
import AisTraffic from './components/AisTraffic';
import { AIS_VESSEL_LAYER } from './components/AisLayer';
```

  - Extend the interactive-layer id list (so a tap on a vessel opens its popup instead of falling through to tap-to-pick; `getLayer` guards the id while the Live-only layer is absent):

```ts
const INTERACTIVE_MAP_LAYER_IDS = [HARBOR_CIRCLE_LAYER, SEAMARKS_LAYER, AIS_VESSEL_LAYER];
```

  - Inside MapView's children, in the existing `{tab === 'live' && ( … )}` block, add `AisTraffic` as a sibling of `LiveView` (both gated on the Live tab). Replace the current single-child `LiveView` render with a fragment:

```tsx
          {tab === 'live' && (
            <>
              {/* #25 AIS live traffic overlay — Live tab only, inside MapView's
                  subtree for the map context. Fully inert without a key. */}
              <AisTraffic apiKey={settings.aisApiKey} ownMmsi={settings.ownMmsi} />
              <LiveView
                panelSlot={isWide ? liveSlot : null}
                reroute={{
                  busy: runBusy,
                  rerouting: liveReroute.state.rerouting,
                  onReroute: handleLiveReroute,
                }}
              />
            </>
          )}
```

- [ ] Run the app-wiring-adjacent tests to catch regressions: `npm --prefix app run test -- App.test` — green (the new interactive-layer id and the extra Live-tab child must not break existing App tests; if a FakeMap in App.test.tsx enumerates layers strictly, extend it to tolerate the AIS layer id rather than loosening the gate).

- [ ] Typecheck + lint: `npm --prefix app run typecheck && npm --prefix app run lint` — clean.

- [ ] Commit:
  - `git add app/src/components/AisTraffic.tsx app/src/components/AisTraffic.test.tsx app/src/app.css app/src/App.tsx app/src/i18n/dict.de.ts app/src/i18n/dict.en.ts`
  - `git commit -m "feat: wire AIS overlay into the Live tab (#25)"`

---

### Task 8: Final assembly — full verification, real-browser pass, CHANGELOG, acceptance walkthrough

No new production code. Runs the full gate, verifies the feature end-to-end against the live service, records the changelog entry, and walks the spec's acceptance criteria.

**Files**
- Modify: `CHANGELOG.md` (Unreleased → Added entry, #25)

Steps:

- [ ] Full local gate (CI runs lint + typecheck BEFORE tests): run in order and confirm each is clean before moving on.
  - `npm --prefix app run lint`
  - `npm --prefix app run typecheck`
  - `npm --prefix app run test` (full suite; give it a generous timeout — the seeded property + real-mask files run for minutes)
  - `npm --prefix app run build`

- [ ] Confirm the feature is network-free without a key: grep the test run for any real WebSocket/`aisstream` traffic (there must be none — every client is injected). Re-run the offline-sensitive suites explicitly: `npm --prefix app run test -- db.test aisStream aisTargets useAisTraffic aisGeoJson` all green.

- [ ] E2E smoke (the feature must not disturb existing Live-tab e2e; no key is set in e2e, so zero AIS network): `npm --prefix app run e2e -- live.spec.ts` (and `plan.spec.ts` if the interactive-layer-id change touched tap-to-pick). The `pree2e` hook rebuilds and rewrites `app/public/test-fixtures/wind-sw12.json` — restore that fixture afterward (`git checkout -- app/public/test-fixtures/wind-sw12.json`); never commit its churn.

- [ ] Real-browser pass with the owner-provided key (the repo verification lesson: synthetic tests alone don't count). The live key is at `/tmp/claude-1000/-home-pkuhn-sail-command/1e915eec-a8e1-42c1-bc01-54708e58df08/scratchpad/aisstream-key.txt` — read it from that PATH at run time; never paste its contents into any file, test, commit, or log.
  - Start the dev server: `npm --prefix app run dev`.
  - Open the app, go to Options, paste the key into "AIS API key" and (optionally) enter your own MMSI. Switch to the Live tab. In the Flensburg Fjord / Danish South Sea viewport, confirm:
    - Vessels appear as green arrows rotated to heading/COG (dots where neither is reported), with COG vectors when moving; names at high zoom, dots at low zoom.
    - The status chip cycles `connecting…` → `live · N vessels`.
    - Tapping a vessel opens the themed popup (name/MMSI/type/SOG/COG/age) — verify it is legible in BOTH light and dark theme (the `.ais-popup` chrome fix).
    - With `ownMmsi` set to a visible vessel's MMSI, that vessel disappears from the overlay.
    - Switch away from the Live tab (or hide the tab / DevTools → offline): the socket closes (Network panel), the chip shows `offline` when offline; returning online + Live restores the stream with no user action.
    - Enter a deliberately wrong key: the chip shows `check your API key` with NO reconnect storm (Network panel shows a single closed socket, not a retry flood).
    - Confirm the ownship marker (if `showOwnship` is on) and the route stack still render ABOVE the AIS layer; AIS renders above the depth/seamark overlays.

- [ ] Add the CHANGELOG entry. In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add as the first bullet:

```markdown
- Add a live AIS traffic overlay on the Live view: paste a personal aisstream.io API key in Options to see surrounding vessels (heading/COG, names, tap-for-details), with your own vessel filtered out by MMSI; online-only and fully inert without a key (#25).
```

- [ ] Commit the changelog:
  - `git add CHANGELOG.md`
  - `git commit -m "docs: changelog entry for AIS traffic overlay (#25)"`

- [ ] Spec acceptance-criteria walkthrough — confirm each against the running app + tests, and note the evidence:
  - [ ] Valid key on Live (online, visible): vessels render with heading/COG vectors, names at high zoom, dots at low zoom; popup shows details; own vessel (`ownMmsi`) never appears. → browser pass.
  - [ ] Leaving Live / hiding / going offline closes the socket; offline banner state shows; returning restores the stream without user action. → browser pass + `useAisTraffic` tests (offline/hidden stop + persist).
  - [ ] Invalid key → key-error state, no retry storm. → browser pass + `aisStream` client test (error frame terminal, no timer scheduled).
  - [ ] Stale targets fade at 3 min, disappear at 10 min. → `aisTargets` (`ageTier`/`sweepDropped`) + `useAisTraffic` drop-sweep tests.
  - [ ] No key: zero network from the feature, off-state hint, existing tests (incl. offline e2e) untouched. → `useAisTraffic` off test + e2e smoke.
  - [ ] All new strings in both dicts; no CPA/TCPA functionality anywhere. → dict parity (`satisfies` compiles) + code review (no CPA/TCPA code exists).

---

## Notes for the implementer

- **Reuse the three re-run/data primitives correctly:** this feature adds a FOURTH data path — a live streaming source that is neither a plan nor a forecast. It never touches `Plan`, `PlanRequest`, the router, or IndexedDB plan storage; the only persisted state is the two `Settings` fields.
- **Never introduce a backend.** aisstream.io is called browser-direct over WebSocket, exactly like Open-Meteo is called browser-direct over HTTPS.
- **exactOptionalPropertyTypes recurs throughout:** build objects by conditionally assigning keys; type "string-or-absent" call-site values as `string | undefined`, not `?`-optional; narrow with inline guards (see Task 4).
- **Map-bound components are verified in-browser, not jsdom-unit-tested** — `AisLayer` and `AisTraffic`'s map wiring follow `DataLayers`/`BoatMarker`'s precedent. Everything pure (`aisStream`, `aisTargets`, `aisGeoJson`, `mmsi`, `useAisTraffic`, `AisStatusChip`) is unit-tested.
- **The live auth-vs-transient semantics are pinned deterministically now** (error frame = terminal keyError; everything else = transient backoff). During the Task 8 browser pass, confirm how aisstream actually signals a bad key; if it is a bare early close rather than an error frame, route that signal to the existing terminal `keyError` state in `AisStreamClient` (a small change, no restructuring) and add/adjust a client test.
