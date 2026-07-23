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
        PositionReport: {
          Latitude: 54.79,
          Longitude: 9.43,
          Sog: 102.3,
          Cog: 360,
          TrueHeading: 511,
        },
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
  Message: {
    PositionReport: { Latitude: 54.79, Longitude: 9.43, Sog: 6, Cog: 90, TrueHeading: 90 },
  },
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
      {
        kind: 'position',
        mmsi: '211234560',
        lat: 54.79,
        lon: 9.43,
        sogKn: 6,
        cogDeg: 90,
        headingDeg: 90,
      },
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

  // Live-verified (#25 Task 8): aisstream signals a bad key with NO error
  // frame — the socket accepts, takes the subscription, then closes bare
  // (1006, empty reason). Three consecutive opened-and-subscribed closes with
  // zero inbound messages are promoted to the terminal keyError state.
  it('treats repeated bare closes right after subscribing as terminal keyError (wrong-key signature)', () => {
    const { client, fs, timers, statuses } = makeClient();
    client.start(BBOX);
    fs.open();
    fs.remoteClose(); // subscribed close 1 -> still transient, timer armed
    timers.fireLast();
    fs.open();
    fs.remoteClose(); // subscribed close 2 -> still transient, timer armed
    timers.fireLast();
    fs.open();
    fs.remoteClose(); // subscribed close 3 -> terminal keyError, NO new timer
    expect(statuses).toEqual(['connecting', 'keyError']);
    expect(timers.delays()).toEqual([500, 1000]);
  });

  it('a received message resets the early-close counter (transient blips never reach keyError)', () => {
    const { client, fs, timers, statuses } = makeClient();
    client.start(BBOX);
    fs.open();
    fs.remoteClose(); // subscribed close 1
    timers.fireLast();
    fs.open();
    fs.remoteClose(); // subscribed close 2
    timers.fireLast();
    fs.open();
    fs.message(POSITION_RAW); // live -> counter back to 0
    fs.remoteClose(); // not an early close (a message arrived) -> plain retry
    timers.fireLast();
    fs.open();
    fs.remoteClose(); // early close 1 of a NEW streak -> still transient
    expect(statuses).toEqual(['connecting', 'live', 'connecting']);
    // Backoff attempts: 1, 2 (pre-live), reset by the live message, then 1, 2
    // again -> 0.5*1000, 0.5*2000, 0.5*1000, 0.5*2000.
    expect(timers.delays()).toEqual([500, 1000, 500, 1000]);
  });

  it('never counts unopened connection failures toward keyError (offline stays transient)', () => {
    const { client, fs, timers, statuses } = makeClient();
    client.start(BBOX);
    fs.error(); // connect failed without ever opening (no subscription sent)
    timers.fireLast();
    fs.error();
    timers.fireLast();
    fs.error();
    timers.fireLast();
    fs.error(); // 4th straight failure: still transient, still retrying
    expect(statuses).toEqual(['connecting']);
    expect(timers.delays()).toEqual([500, 1000, 2000, 4000]);
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
