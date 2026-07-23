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
      this.timerId = this.setTimer(
        () => this.open(),
        nextReconnectDelayMs(this.attempt, this.random),
      );
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
