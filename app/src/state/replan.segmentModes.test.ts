import { describe, expect, it, vi } from 'vitest';
import {
  dedupeRequestVias,
  dedupeViaPoints,
  mergeSegmentModes,
  ReplanError,
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

// #885 / #1232 (maintainer ruling 2026-09-15): a dedupe merge is allowed only
// when every merged segment has the same mode, Auto (null) included; any other
// run is refused. Every expectation is derived by hand from that rule, never
// read back from the function.
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
  return r;
}

describe('#1232 dedupe-merge mode rule', () => {
  // Consecutive forward drops: d1 and d2 are 40 m either side of P, so both
  // drop against P. The run P..N spans three segments: P->d1, d1->d2, d2->N.
  const d1 = m(P, 0, 40);
  const d2 = m(P, 180, 40);
  const RUN = [P, d1, d2, N];

  it('consecutive forward drops: dedupe keeps P and N (indices 0, 3)', () => {
    expect(dedupeViaPoints(O, RUN, D).keptIndices).toEqual([0, 3]);
  });

  // Each refused row would force (extend) or clear (free) ~2 km of water that
  // no one marked. The first dropped via of the run is d1, input index 1.
  it.each<[string, Modes]>([
    ['a mode on the first (40 m) member only', [null, 'motor', null, null, 'sail']],
    ['a mode on the middle (80 m) member only', [null, null, 'sail', null, null]],
    ['a mode on the last (~2 km) member only', [null, null, null, 'sail', null]],
    ['two of three members marked', [null, 'motor', 'motor', null, null]],
    ['motor beside sail', [null, 'motor', null, 'sail', null]],
  ])('consecutive drops, %s: refused', (_n, modes) => {
    expect(merged(RUN, modes)).toEqual({ kind: 'conflict', viaIndex: 1 });
  });

  it.each<[string, Modes, Modes]>([
    ['an all-motor run', [null, 'motor', 'motor', 'motor', null], [null, 'motor', null]],
    ['an all-null run', ['sail', null, null, null, 'motor'], ['sail', null, 'motor']],
  ])('consecutive drops, %s: merges', (_n, modes, expected) => {
    expect(merged(RUN, modes)).toEqual({ kind: 'ok', segmentModes: expected });
  });

  // 59 m / 61 m: d is 59 m from P (dropped), Q 61 m (kept); P->d is 59 m, d->Q 2 m.
  const SHORT = [P, m(P, 90, 59), m(P, 90, 61)];

  it('59 m / 61 m: dedupe keeps P and Q (indices 0, 2)', () => {
    expect(dedupeViaPoints(O, SHORT, D).keptIndices).toEqual([0, 2]);
  });

  it.each<[string, Modes]>([
    ['mode on the 2 m member only', [null, null, 'sail', null]],
    ['mode on the 59 m member only', [null, 'motor', null, null]],
  ])('59 m / 61 m, %s: refused', (_n, modes) => {
    expect(merged(SHORT, modes)).toEqual({ kind: 'conflict', viaIndex: 1 });
  });

  it('59 m / 61 m, equal modes merge', () => {
    expect(merged(SHORT, [null, 'sail', 'sail', null])).toEqual({
      kind: 'ok',
      segmentModes: [null, 'sail', null],
    });
  });

  // Trailing pops: L1 and L2 are 40 m either side of D and both pop against D.
  const L1 = m(D, 270, 40);
  const L2 = m(D, 90, 40);

  it('repeated trailing pops: only P survives; a mixed run P..D is refused', () => {
    expect(dedupeViaPoints(O, [P, L1, L2], D).keptIndices).toEqual([0]);
    expect(merged([P, L1, L2], [null, 'motor', null, null])).toEqual({
      kind: 'conflict',
      viaIndex: 1,
    });
    expect(merged([P, L1, L2], [null, null, null, 'sail'])).toEqual({
      kind: 'conflict',
      viaIndex: 1,
    });
    expect(merged([P, L1, L2], [null, 'sail', 'sail', 'sail'])).toEqual({
      kind: 'ok',
      segmentModes: [null, 'sail'],
    });
  });

  it('a forward drop and trailing pops in one run', () => {
    const vias = [P, m(P, 0, 30), L1, L2];
    expect(dedupeViaPoints(O, vias, D).keptIndices).toEqual([0]);
    expect(merged(vias, ['motor', null, null, 'sail', null])).toEqual({
      kind: 'conflict',
      viaIndex: 1,
    });
    expect(merged(vias, ['motor', 'sail', 'sail', 'sail', 'sail'])).toEqual({
      kind: 'ok',
      segmentModes: ['motor', 'sail'],
    });
  });

  it('names the first dropped via of the conflicting run, not of an earlier one', () => {
    // [P, d1, d2, N] plus a trailing pop L1: two runs, P..N (equal) and N..D.
    const vias = [P, d1, d2, N, L1];
    expect(dedupeViaPoints(O, vias, D).keptIndices).toEqual([0, 3]);
    expect(merged(vias, [null, 'motor', 'motor', 'motor', 'sail', null])).toEqual({
      kind: 'conflict',
      viaIndex: 4,
    });
  });

  it('no drops leaves the modes unchanged', () => {
    expect(merged([P, N], ['motor', null, 'sail'])).toEqual({
      kind: 'ok',
      segmentModes: ['motor', null, 'sail'],
    });
  });

  it('modes not matching the input vias are invalid, never realigned', () => {
    // One mode short, and one via drops: the lengths would coincide afterwards.
    expect(merged(SHORT, [null, 'motor', null])).toEqual({ kind: 'invalid' });
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
    const r = dedupeRequestVias({ ...baseRequest, segmentModes: [null, 'sail', 'sail', null] });
    expect(r).toMatchObject({ kind: 'ok', request: { segmentModes: [null, 'sail', null] } });
  });

  it('maps a conflict to its message key, naming the dropped waypoint (1-based)', () => {
    expect(dedupeRequestVias({ ...baseRequest, segmentModes: [null, 'sail', null, null] })).toEqual(
      {
        kind: 'error',
        messageKey: 'error.segmentModesMergeConflict',
        messageVars: { index: 2 },
      },
    );
  });

  // Review 5210460022's refuted shapes, each of which the previous rule
  // accepted by forcing or clearing miles of unmarked water.
  const req = (viaPoints: LatLon[], segmentModes: Modes): PlanRequest => ({
    ...baseRequest,
    viaPoints,
    segmentModes,
  });
  const A = m(O, 90, 10_000);
  const refusedAt = (index: number) => ({
    kind: 'error',
    messageKey: 'error.segmentModesMergeConflict',
    messageVars: { index },
  });

  it("R6's own flow: O->D motor, append A and A' 20 m away, set A'->D to Auto", () => {
    expect(dedupeRequestVias(req([A, m(A, 0, 20)], ['motor', 'motor', null]))).toEqual(
      refusedAt(2),
    );
  });

  it('trailing pop: L 50 m from D, the motor mark on L->D only', () => {
    expect(dedupeRequestVias(req([A, m(D, 270, 50)], [null, null, 'motor']))).toEqual(refusedAt(2));
  });

  it('forward drop: d 50 m from A, the motor mark on A->d only', () => {
    expect(dedupeRequestVias(req([A, m(A, 90, 50)], [null, 'motor', null]))).toEqual(refusedAt(2));
  });

  it('an all-Auto merge is allowed', () => {
    expect(dedupeRequestVias(req([A, m(A, 0, 20)], [null, null, null]))).toMatchObject({
      kind: 'ok',
      request: { segmentModes: [null, null] },
    });
  });

  it('R4: a motor mark with the motor disabled is refused at intake', () => {
    const off = { ...DEFAULT_SETTINGS, motorEnabled: false };
    expect(dedupeRequestVias({ ...req([A], [null, 'motor']), settings: off })).toEqual({
      kind: 'error',
      messageKey: 'error.noRoute.segmentModeConflict',
    });
    expect(dedupeRequestVias({ ...req([A], [null, 'sail']), settings: off }).kind).toBe('ok');
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
      'sail',
      null,
    ]);
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.viaPoints).toHaveLength(2);
    expect(request.segmentModes).toEqual([null, 'sail', null]);
  });

  it('refuses a mixed merge with a ReplanError naming the waypoint, planning nothing', async () => {
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK) };
    const err = await replanWithVias(plan, [P, d59(), N], { client, save: vi.fn() }, [
      null,
      'sail',
      null,
      null,
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplanError);
    expect(err).toMatchObject({
      messageKey: 'error.segmentModesMergeConflict',
      messageVars: { index: 2 },
    });
    expect(client.plan).not.toHaveBeenCalled();
  });

  it('never carries the stored modes onto a different via list', async () => {
    const client: ReplanClient = { plan: vi.fn().mockResolvedValue(OK) };
    await replanWithVias(plan, [P, N], { client, save: vi.fn() });
    const [request] = (client.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    expect('segmentModes' in request).toBe(false);
  });
});
