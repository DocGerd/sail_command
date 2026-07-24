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

export function snapshotTargets(store: Map<string, AisTarget>, nowMs: number): AisTargetSnapshot[] {
  const out: AisTargetSnapshot[] = [];
  for (const t of store.values()) {
    if (!t.position) continue; // position-less stubs are not renderable
    out.push({ ...t, position: t.position, tier: ageTier(t.lastUpdateMs, nowMs) });
  }
  return out;
}
