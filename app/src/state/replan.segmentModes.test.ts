import { describe, expect, it, vi } from 'vitest';
import {
  dedupeRequestVias,
  dedupeViaPoints,
  mergeSegmentModes,
  replanWithVias,
  type ReplanClient,
} from './replan';
import { destinationPoint } from '../lib/geo';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  PLAN_SCHEMA_VERSION,
  type LatLon,
  type Plan,
  type PlanRequest,
  type PlanResultOk,
  type SegmentMode,
} from '../types';

// #885 / #1232: the dedupe-merge mode rule. Every expectation below is derived
// by hand from the rule (a run takes the one mode its non-null members agree
// on; all-null → null; motor beside sail → conflict), never read back from the
// function.
const O: LatLon = { lat: 54.5, lon: 10.0 };
const D: LatLon = { lat: 54.5, lon: 10.5 };
const P = destinationPoint(O, 90, 2 / 1.852); // 2 km east of O
const N = destinationPoint(P, 90, 2 / 1.852); // 2 km further east
const m = (from: LatLon, bearing: number, metres: number) =>
  destinationPoint(from, bearing, metres / 1852);

type Modes = (SegmentMode | null)[];
function merged(vias: LatLon[], modes: Modes) {
  const { kept, keptIndices } = dedupeViaPoints(O, vias, D);
  const r = mergeSegmentModes(modes, vias.length, keptIndices);
  if (r.kind === 'ok') expect(r.segmentModes.length).toBe(kept.length + 1);
  return { keptIndices, r };
}

describe('#1232 dedupe-merge mode rule', () => {
  // Refuted shape 1 (round 1, "non-degenerate half" undefined for runs):
  // d1 and d2 are each 40 m from P, on opposite sides, so both drop against P
  // and d1->d2 is 80 m — longer than the dedupe radius. The run P..N spans
  // THREE original segments: P->d1, d1->d2, d2->N.
  const d1 = m(P, 0, 40);
  const d2 = m(P, 180, 40);
  const RUN = [P, d1, d2, N];

  it('consecutive forward drops: dedupe keeps P and N (indices 0, 3)', () => {
    expect(dedupeViaPoints(O, RUN, D).keptIndices).toEqual([0, 3]);
  });

  it.each<[string, Modes, Modes]>([
    [
      'a mode on the first run member only',
      [null, 'motor', null, null, 'sail'],
      [null, 'motor', 'sail'],
    ],
    [
      'a mode on the middle (80 m) member only',
      [null, null, 'sail', null, null],
      [null, 'sail', null],
    ],
    ['a mode on the last run member only', [null, null, null, 'sail', null], [null, 'sail', null]],
    [
      'agreeing modes across the run',
      [null, 'motor', 'motor', 'motor', null],
      [null, 'motor', null],
    ],
    ['an all-null run', ['sail', null, null, null, 'motor'], ['sail', null, 'motor']],
  ])('consecutive drops, %s', (_n, modes, expected) => {
    expect(merged(RUN, modes).r).toEqual({ kind: 'ok', segmentModes: expected });
  });

  // Refuted shape 2 (round 2, "longest original segment"): d is 59 m from P
  // (dropped), Q is 61 m from P on the same bearing (kept), so P->d is 59 m and
  // d->Q is 2 m. "Longest" picks P->d, the pair dedupe treated as coincident.
  const d59 = m(P, 90, 59);
  const q61 = m(P, 90, 61);
  const SHORT = [P, d59, q61];

  it('59 m / 61 m: dedupe keeps P and Q (indices 0, 2)', () => {
    expect(dedupeViaPoints(O, SHORT, D).keptIndices).toEqual([0, 2]);
  });

  it.each<[string, Modes, Modes]>([
    // "longest" would return null here and silently free the 2 m constraint.
    ['mode on the 2 m member only', [null, null, 'sail', null], [null, 'sail', null]],
    ['mode on the 59 m member only', [null, 'motor', null, null], [null, 'motor', null]],
  ])('59 m / 61 m, %s', (_n, modes, expected) => {
    expect(merged(SHORT, modes).r).toEqual({ kind: 'ok', segmentModes: expected });
  });

  // Trailing pops: L1 and L2 are 40 m either side of D (80 m apart, so both
  // survive the forward pass) and both pop against D.
  const L1 = m(D, 270, 40);
  const L2 = m(D, 90, 40);

  it('repeated trailing pops: only P survives; the run P..D spans three segments', () => {
    expect(dedupeViaPoints(O, [P, L1, L2], D).keptIndices).toEqual([0]);
    expect(merged([P, L1, L2], [null, 'motor', null, null]).r).toEqual({
      kind: 'ok',
      segmentModes: [null, 'motor'],
    });
    expect(merged([P, L1, L2], [null, null, null, 'sail']).r).toEqual({
      kind: 'ok',
      segmentModes: [null, 'sail'],
    });
  });

  it('a forward drop and trailing pops in one run', () => {
    const dp = m(P, 0, 30); // drops against P
    const vias = [P, dp, L1, L2];
    expect(dedupeViaPoints(O, vias, D).keptIndices).toEqual([0]);
    expect(merged(vias, ['motor', null, null, 'sail', null]).r).toEqual({
      kind: 'ok',
      segmentModes: ['motor', 'sail'],
    });
  });

  it('motor and sail inside one run is a conflict, never a silent pick', () => {
    expect(merged(RUN, [null, 'motor', null, 'sail', null]).r).toEqual({ kind: 'conflict' });
    expect(merged(SHORT, [null, 'motor', 'sail', null]).r).toEqual({ kind: 'conflict' });
  });

  it('no drops leaves the modes unchanged', () => {
    expect(merged([P, N], ['motor', null, 'sail']).r).toEqual({
      kind: 'ok',
      segmentModes: ['motor', null, 'sail'],
    });
  });

  it('modes not matching the input vias are invalid, never realigned', () => {
    // One mode short, and one via drops: the lengths would coincide afterwards.
    expect(merged(SHORT, [null, 'motor', null]).r).toEqual({ kind: 'invalid' });
  });
});

const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
const baseRequest: PlanRequest = {
  origin: O,
  destination: D,
  viaPoints: [P, d59(), N],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: T0,
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa'],
  boat: defaultBoatSnapshot(),
};
function d59(): LatLon {
  return m(P, 90, 59);
}

describe('#885 dedupeRequestVias', () => {
  it('absent segmentModes stays absent', () => {
    const r = dedupeRequestVias(baseRequest);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect('segmentModes' in r.request).toBe(false);
  });

  it('rebuilds segmentModes alongside the deduped vias', () => {
    const r = dedupeRequestVias({ ...baseRequest, segmentModes: [null, 'sail', null, null] });
    expect(r).toMatchObject({ kind: 'ok', request: { segmentModes: [null, 'sail', null] } });
  });

  it('maps a conflict to its message key', () => {
    expect(
      dedupeRequestVias({ ...baseRequest, segmentModes: [null, 'sail', 'motor', null] }),
    ).toEqual({ kind: 'error', messageKey: 'error.segmentModesMergeConflict' });
  });
});

describe('#885 replanWithVias segment modes', () => {
  const OK: PlanResultOk = {
    status: 'ok',
    sails: [
      {
        sailId: 'genoa',
        result: {
          sailId: 'genoa',
          legs: [],
          etaMs: T0 + 3_600_000,
          durationMs: 3_600_000,
          distanceNm: 1,
          maneuverCount: 0,
          motorDistanceNm: 0,
        },
        reason: null,
      },
    ],
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: O,
    snappedDestination: D,
  };
  const plan: Plan = {
    id: 'p',
    name: 'p',
    createdAtMs: 0,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: { ...baseRequest, viaPoints: [P], segmentModes: ['motor', 'sail'] },
    windGrid: {
      lats: [54, 55],
      lons: [10, 11],
      timesMs: [T0, T0 + 48 * 3_600_000],
      speedKn: new Float32Array(8),
      dirFromDeg: new Float32Array(8),
      gustKn: new Float32Array(8),
      fetchedAtMs: T0,
      model: 'test',
    },
    result: OK,
  };

  it('uses modes aligned with the via argument, deduped', async () => {
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK) };
    await replanWithVias(plan, [P, d59(), N], { client, save: vi.fn() }, [
      null,
      'sail',
      null,
      null,
    ]);
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.viaPoints).toHaveLength(2);
    expect(request.segmentModes).toEqual([null, 'sail', null]);
  });

  it('never carries the stored modes onto a different via list', async () => {
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK) };
    await replanWithVias(plan, [P, N], { client, save: vi.fn() });
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect('segmentModes' in request).toBe(false);
  });
});
