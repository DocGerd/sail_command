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
