import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PASS2_BUDGET_MS,
  planRoute,
  planRouteWithRecord,
  salvagePassAdmitted,
  type Pass1Record,
  type PlanDeadline,
  type TierRecord,
} from './planRoute';
import { solve, type SolveDeadline, type SolveFailureCause, type SolveParams } from './isochrone';
import { findRelaxedGate } from './relaxedDepth';
import { uniformGate } from '../lib/depthGate';
import { makeMask, TEST_POLAR, testPlanDeps, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type Leg,
  type PlanRequest,
  type PlanResult,
  type PolarTable,
  type Settings,
} from '../types';

// #1136: pass 1's record and pass-2 admission (spike
// docs/spikes/1136-motor-off-solve-termination.md §11.1; maintainer rulings on
// #1136 of 2026-09-14). `solve` is mocked so which tier ran, at which gate, with
// which per-sail causes is deterministic.
vi.mock('./isochrone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./isochrone')>();
  return { ...actual, solve: vi.fn() };
});
vi.mock('./relaxedDepth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./relaxedDepth')>();
  return { ...actual, findRelaxedGate: vi.fn() };
});
const solveMock = vi.mocked(solve);
const relaxMock = vi.mocked(findRelaxedGate);

const MOTOR_OFF: Settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
const NOT_EXPIRED: SolveDeadline = { expired: () => false };
const EXPIRED: SolveDeadline = { expired: () => true };
const ONE_TIER: TierRecord = {
  tier: 1,
  gate: uniformGate(3),
  comfortDepthM: 5,
  usedDepthM: null,
  causes: ['mask-blocked', 'mask-blocked'],
};

describe('#1136 salvagePassAdmitted truth table', () => {
  const results: Record<'ok' | 'error', PlanResult> = {
    error: { status: 'error', reason: 'unreachable' },
    ok: {
      status: 'ok',
      sails: [],
      recommended: 'genoa',
      comparisonComplete: true,
      rigRecommendation: { kind: 'not-compared' },
      snappedOrigin: { lat: 0, lon: 0 },
      snappedDestination: { lat: 0, lon: 0 },
    },
  };
  const causes: (SolveFailureCause | null)[] = [
    'mask-blocked',
    'calm-without-motor',
    'horizon-exceeded',
    'budget-exhausted',
    null,
  ];
  const deadlines = [
    ['none', undefined],
    ['live', NOT_EXPIRED],
    ['spent', EXPIRED],
  ] as const;
  // Hand-written from the rulings, not read off the implementation: exactly
  // ONE combination admits — an error plan whose recorded cause is the mask,
  // after a tier ran, with the motor off and budget left.
  for (const status of ['ok', 'error'] as const)
    for (const cause of causes)
      for (const tiers of [[], [ONE_TIER]])
        for (const motorEnabled of [false, true])
          for (const [deadlineName, deadline] of deadlines) {
            const admitted =
              status === 'error' &&
              cause === 'mask-blocked' &&
              tiers.length === 1 &&
              !motorEnabled &&
              deadlineName !== 'spent';
            it(`${status}/${cause}/tiers=${tiers.length}/motor=${motorEnabled}/deadline=${deadlineName} -> ${admitted}`, () => {
              const record: Pass1Record = { tiers, cause };
              const settings = { ...DEFAULT_SETTINGS, motorEnabled };
              expect(salvagePassAdmitted(results[status], record, settings, deadline)).toBe(
                admitted,
              );
            });
          }

  it('never reads the deadline for a plan another clause already rejects', () => {
    const deadline = { expired: vi.fn(() => false) };
    const record: Pass1Record = { tiers: [ONE_TIER], cause: 'mask-blocked' };
    salvagePassAdmitted(results.error, record, DEFAULT_SETTINGS, deadline);
    expect(deadline.expired).not.toHaveBeenCalled();
  });
});

const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
// TEST_MASK_META cell centres (0.005° grid), as in planRoute.depthComfort.test.ts.
const ORIGIN = { lat: 54.3 + 80.5 * 0.005, lon: 9.4 + 120.5 * 0.005 };
const DESTINATION = { lat: 54.3 + 80.5 * 0.005, lon: 9.4 + 124.5 * 0.005 };
const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const MASKS = {
  open: makeMask(() => 200),
  // Land between the endpoints: disconnected at every gate, so tiers 1–2 never
  // run and tiers 3–4 run only on the mocked findRelaxedGate.
  walled: makeMask((_r, c) => (c === 122 ? 0 : 200)),
  // A 2.6 m shoal across the straight track: connected at 3 m round it, so
  // tiers 1–2 run, while a straight leg crosses sub-gate water.
  shoal: makeMask((r, c) => (c === 122 && r >= 75 && r <= 85 ? 26 : 200)),
};
const RELAXED = { gate: uniformGate(2.5), usedDepthM: 2.5 };

function leg(distanceNm: number): Leg {
  return {
    kind: 'sail',
    board: 'starboard',
    start: ORIGIN,
    end: DESTINATION,
    startTimeMs: T0,
    endTimeMs: T0 + 600_000,
    headingDeg: 90,
    twaDeg: 90,
    twsKn: 12,
    speedKn: 6,
    distanceNm,
    maneuverAtStart: null,
  };
}
/** A routed solve; `distanceNm` tags which tier's result the plan reports. */
const ok = (distanceNm = 1) => ({
  status: 'ok' as const,
  legs: [leg(distanceNm)],
  etaMs: T0 + 1,
});
const fail = (cause: SolveFailureCause) => ({
  status: 'no-route' as const,
  cause,
});
type Out = ReturnType<typeof ok> | ReturnType<typeof fail>;

/**
 * Keys are `<pass>:<gate>:<comfort>:<rig>`: pass `p2` iff `salvage` is set,
 * gate `req` or `rel` (the mocked relaxed gate object), comfort `c5` or `none`.
 * An unscripted solve throws, so an unexpected tier fails loudly.
 */
function script(table: Record<string, Out>): void {
  solveMock.mockImplementation((p: SolveParams) => {
    const pass = p.salvage === true ? 'p2' : 'p1';
    const gate = p.gate === RELAXED.gate ? 'rel' : 'req';
    const comfort = p.comfortDepthM === undefined ? 'none' : `c${p.comfortDepthM}`;
    const key = `${pass}:${gate}:${comfort}:${p.polar.rig}`;
    const out = table[key];
    if (out === undefined) throw new Error(`unscripted solve ${key}`);
    return out;
  });
}

function request(settings: Settings): PlanRequest {
  return {
    origin: ORIGIN,
    destination: DESTINATION,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: T0,
    settings,
    sailIds: ['genoa', 'fock'],
    boat: defaultBoatSnapshot(),
  };
}
function plan(settings: Settings, where: keyof typeof MASKS = 'open', deadline?: PlanDeadline) {
  const deps = testPlanDeps(MASKS[where], {
    genoa: TEST_POLAR,
    fock: FOCK,
  });
  return planRouteWithRecord(
    request(settings),
    uniformWindGrid(12, 0),
    deps,
    undefined,
    undefined,
    deadline,
  );
}
const tierSummary = (record: Pass1Record) =>
  record.tiers.map((t) => ({
    tier: t.tier,
    comfortDepthM: t.comfortDepthM,
    usedDepthM: t.usedDepthM,
    causes: t.causes,
  }));
const pass2Keys = () =>
  solveMock.mock.calls
    .filter(([p]) => p.salvage === true)
    .map(
      ([p]) =>
        `${p.gate === RELAXED.gate ? 'rel' : 'req'}:${p.comfortDepthM ?? 'none'}:${p.polar.rig}`,
    );
const sailOf = (res: PlanResult, rig: string) =>
  res.status === 'ok' ? res.sails.find((x) => x.sailId === rig) : undefined;
const distanceOf = (res: PlanResult, rig: string) =>
  sailOf(res, rig)?.result?.legs[0]?.distanceNm ?? null;

// Pass 1, requested gate: tiers 1 and 2 both ran, every sail mask-blocked.
const P1_REQ_BLOCKED: Record<string, Out> = {
  'p1:req:c5:genoa': fail('mask-blocked'),
  'p1:req:c5:fock': fail('mask-blocked'),
  'p1:req:none:genoa': fail('mask-blocked'),
  'p1:req:none:fock': fail('mask-blocked'),
};
const P1_REL_BLOCKED: Record<string, Out> = {
  'p1:rel:c5:genoa': fail('mask-blocked'),
  'p1:rel:c5:fock': fail('mask-blocked'),
  'p1:rel:none:genoa': fail('mask-blocked'),
  'p1:rel:none:fock': fail('mask-blocked'),
};
const P2_REQ_NONE: Record<string, Out> = {
  'p2:req:c5:genoa': fail('horizon-exceeded'),
  'p2:req:c5:fock': fail('horizon-exceeded'),
  'p2:req:none:genoa': fail('horizon-exceeded'),
  'p2:req:none:fock': fail('horizon-exceeded'),
};
const P2_REL_NONE: Record<string, Out> = {
  'p2:rel:c5:genoa': fail('horizon-exceeded'),
  'p2:rel:c5:fock': fail('horizon-exceeded'),
  'p2:rel:none:genoa': fail('horizon-exceeded'),
  'p2:rel:none:fock': fail('horizon-exceeded'),
};

beforeEach(() => {
  solveMock.mockReset();
  relaxMock.mockReset();
  relaxMock.mockReturnValue(null);
});

describe('#1136 pass-1 record', () => {
  it('records tiers 1–2 with per-sail causes, and tier 2 as the plan cause', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p1:req:none:genoa': fail('horizon-exceeded'),
    });
    const { result, record } = plan(MOTOR_OFF);
    expect(result).toEqual({ status: 'error', reason: 'beyond-horizon' });
    expect(tierSummary(record)).toEqual([
      {
        tier: 1,
        comfortDepthM: 5,
        usedDepthM: null,
        causes: ['mask-blocked', 'mask-blocked'],
      },
      {
        tier: 2,
        comfortDepthM: undefined,
        usedDepthM: null,
        causes: ['horizon-exceeded', 'mask-blocked'],
      },
    ]);
    expect(record.tiers.every((t) => t.gate.kind === 'uniform' && t.gate.gateM === 3)).toBe(true);
    // tier2[0], not tier1[0]: the two differ here.
    expect(record.cause).toBe('horizon-exceeded');
  });

  it('records tier 1 alone, and its first sail as the plan cause, when no retry ran', () => {
    script({
      'p1:req:none:genoa': fail('mask-blocked'),
      'p1:req:none:fock': fail('calm-without-motor'),
      'p2:req:none:genoa': fail('mask-blocked'),
      'p2:req:none:fock': fail('mask-blocked'),
    });
    const { record } = plan({ ...MOTOR_OFF, depthComfortMarginM: 0 });
    expect(tierSummary(record)).toEqual([
      {
        tier: 1,
        comfortDepthM: undefined,
        usedDepthM: null,
        causes: ['mask-blocked', 'calm-without-motor'],
      },
    ]);
    expect(record.cause).toBe('mask-blocked');
  });

  it("records tiers 3–4 at pass 1's relaxed gate, with combineAllCauses as the plan cause", () => {
    relaxMock.mockReturnValue(RELAXED);
    script({
      ...P1_REL_BLOCKED,
      'p1:rel:none:fock': fail('calm-without-motor'),
    });
    const { result, record } = plan(MOTOR_OFF, 'walled');
    expect(result).toEqual({ status: 'error', reason: 'calm-motor-off' });
    expect(tierSummary(record)).toEqual([
      {
        tier: 3,
        comfortDepthM: 5,
        usedDepthM: 2.5,
        causes: ['mask-blocked', 'mask-blocked'],
      },
      {
        tier: 4,
        comfortDepthM: undefined,
        usedDepthM: 2.5,
        causes: ['mask-blocked', 'calm-without-motor'],
      },
    ]);
    expect(record.tiers.every((t) => t.gate === RELAXED.gate)).toBe(true);
    expect(record.cause).toBe('calm-without-motor');
  });

  it('records all four tiers in run order when relaxation follows a requested-gate failure', () => {
    relaxMock.mockReturnValue(RELAXED);
    script({
      ...P1_REQ_BLOCKED,
      ...P1_REL_BLOCKED,
      ...P2_REQ_NONE,
      ...P2_REL_NONE,
    });
    const { record } = plan(MOTOR_OFF);
    expect(record.tiers.map((t) => t.tier)).toEqual([1, 2, 3, 4]);
    expect(record.cause).toBe('mask-blocked');
  });

  it('records no plan cause on an ok plan with one sail failed (#1166 shape)', () => {
    script({
      'p1:req:c5:genoa': fail('mask-blocked'),
      'p1:req:c5:fock': ok(),
      'p1:req:none:genoa': fail('mask-blocked'),
      'p1:req:none:fock': ok(),
    });
    const { result, record } = plan(MOTOR_OFF);
    expect(result.status).toBe('ok');
    expect(record.tiers.map((t) => t.causes)).toEqual([
      ['mask-blocked', null],
      ['mask-blocked', null],
    ]);
    expect(record.cause).toBeNull();
  });

  it('records no plan cause on the pre-relaxation deadline exit', () => {
    script(P1_REQ_BLOCKED);
    const { result, record } = plan(MOTOR_OFF, 'open', EXPIRED);
    expect(result).toEqual({
      status: 'error',
      reason: 'search-budget-exceeded',
    });
    expect(record.tiers).toHaveLength(2);
    expect(record.cause).toBeNull();
  });

  it('records no tier when pass 1 solved nothing', () => {
    script({});
    const { result, record } = plan(MOTOR_OFF, 'walled');
    expect(result).toEqual({ status: 'error', reason: 'unreachable' });
    expect(record).toEqual({ tiers: [], cause: 'mask-blocked' });
  });

  it("planRoute returns exactly planRouteWithRecord's result", () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(7),
      'p2:req:c5:fock': ok(8),
    });
    const deps = testPlanDeps(MASKS.open, { genoa: TEST_POLAR, fock: FOCK });
    const direct = planRoute(request(MOTOR_OFF), uniformWindGrid(12, 0), deps);
    const recorded = planRouteWithRecord(request(MOTOR_OFF), uniformWindGrid(12, 0), deps).result;
    expect(direct).toEqual(recorded);
    expect(distanceOf(direct, 'genoa')).toBe(7);
  });
});

describe('#1136 pass-2 admission, through planRoute', () => {
  it('runs pass 2 for a motor-off plan blocked by the mask after tiers ran', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(11),
      'p2:req:c5:fock': ok(12),
    });
    const { result } = plan(MOTOR_OFF);
    expect(distanceOf(result, 'genoa')).toBe(11);
    expect(distanceOf(result, 'fock')).toBe(12);
    // Pass 1 never sets the flag.
    expect(solveMock.mock.calls.slice(0, 4).every(([p]) => !('salvage' in p))).toBe(true);
  });

  it('does not run pass 2 with the motor on (ruling 1)', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(),
      'p2:req:c5:fock': ok(),
    });
    expect(plan(DEFAULT_SETTINGS).result).toEqual({
      status: 'error',
      reason: 'unreachable',
    });
    expect(pass2Keys()).toEqual([]);
  });

  it('does not run pass 2 on an ok plan with one sail failed (ruling 2)', () => {
    script({
      'p1:req:c5:genoa': fail('mask-blocked'),
      'p1:req:c5:fock': ok(21),
      'p1:req:none:genoa': fail('mask-blocked'),
      'p1:req:none:fock': ok(22),
      'p2:req:c5:genoa': ok(),
      'p2:req:c5:fock': ok(),
    });
    const { result } = plan(MOTOR_OFF);
    expect(pass2Keys()).toEqual([]);
    expect(distanceOf(result, 'genoa')).toBeNull();
    expect(distanceOf(result, 'fock')).toBe(22);
  });

  it('does not run pass 2 when pass 1 failed for a cause other than the mask', () => {
    script({
      'p1:req:c5:genoa': fail('calm-without-motor'),
      'p1:req:c5:fock': fail('calm-without-motor'),
      'p2:req:c5:genoa': ok(),
      'p2:req:c5:fock': ok(),
    });
    expect(plan(MOTOR_OFF).result).toEqual({
      status: 'error',
      reason: 'calm-motor-off',
    });
    expect(pass2Keys()).toEqual([]);
  });

  it('does not run pass 2 when pass 1 ran no tier', () => {
    script({});
    expect(plan(MOTOR_OFF, 'walled').result).toEqual({
      status: 'error',
      reason: 'unreachable',
    });
    expect(solveMock).not.toHaveBeenCalled();
  });

  it('does not run pass 2 once the shared deadline is spent', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(),
      'p2:req:c5:fock': ok(),
    });
    // solve() is mocked, so planRoute's own reads are the only ones: the
    // pre-relaxation check (live), then admission (spent).
    let calls = 0;
    const deadline: SolveDeadline = { expired: () => ++calls > 1 };
    expect(plan(MOTOR_OFF, 'open', deadline).result).toEqual({
      status: 'error',
      reason: 'unreachable',
    });
    expect(pass2Keys()).toEqual([]);
  });
});

describe('#1136 pass-2 return path', () => {
  it('upgrade: tier 1′ routes one sail and tier 2′ routes both → tier 2′', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(31),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': ok(32),
      'p2:req:none:fock': ok(33),
    });
    const { result } = plan(MOTOR_OFF);
    expect(distanceOf(result, 'genoa')).toBe(32);
    expect(distanceOf(result, 'fock')).toBe(33);
  });

  it('tier-2′ entry: not entered when tier 1′ routes every sail', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(41),
      'p2:req:c5:fock': ok(42),
    });
    const { result } = plan(MOTOR_OFF);
    expect(pass2Keys()).toEqual(['req:5:genoa', 'req:5:fock']);
    expect(distanceOf(result, 'genoa')).toBe(41);
  });

  it('tier-2′ entry: not entered when pass 1 never ran tier 2', () => {
    script({
      'p1:req:none:genoa': fail('mask-blocked'),
      'p1:req:none:fock': fail('mask-blocked'),
      'p2:req:none:genoa': ok(51),
      'p2:req:none:fock': fail('horizon-exceeded'),
    });
    const { result } = plan({ ...MOTOR_OFF, depthComfortMarginM: 0 });
    expect(pass2Keys()).toEqual(['req:none:genoa', 'req:none:fock']);
    expect(distanceOf(result, 'genoa')).toBe(51);
  });

  it('budget: tier 1′ routed a sail and tier 2′ ends budget-exhausted → tier 1′, not pass 1', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(61),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': fail('budget-exhausted'),
      'p2:req:none:fock': fail('budget-exhausted'),
    });
    const { result } = plan(MOTOR_OFF);
    expect(result.status).toBe('ok');
    expect(distanceOf(result, 'genoa')).toBe(61);
  });

  it('tier 2′ wins when it routes any sail, even a different single sail than tier 1′', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(71),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': fail('horizon-exceeded'),
      'p2:req:none:fock': ok(72),
    });
    const { result } = plan(MOTOR_OFF);
    expect(distanceOf(result, 'genoa')).toBeNull();
    expect(distanceOf(result, 'fock')).toBe(72);
  });

  it('a partial tier 2′ is returned when tier 1′ routed nothing', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': fail('horizon-exceeded'),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': fail('horizon-exceeded'),
      'p2:req:none:fock': ok(81),
    });
    expect(distanceOf(plan(MOTOR_OFF).result, 'fock')).toBe(81);
  });

  it('gate: a sail routed at the requested gate in pass 2 never relaxes, though pass 1 ran tiers 3–4', () => {
    relaxMock.mockReturnValue(RELAXED);
    script({
      ...P1_REQ_BLOCKED,
      ...P1_REL_BLOCKED,
      ...P2_REQ_NONE,
      'p2:req:c5:genoa': ok(91),
      'p2:rel:c5:genoa': ok(),
      'p2:rel:c5:fock': ok(),
    });
    const { result } = plan(MOTOR_OFF, 'shoal');
    expect(pass2Keys().some((k) => k.startsWith('rel:'))).toBe(false);
    expect(distanceOf(result, 'genoa')).toBe(91);
    expect(distanceOf(result, 'fock')).toBeNull();
    if (result.status === 'ok') expect(result.shallow).toBeUndefined();
  });

  it('label: a failed sail carries the cause pass 1 recorded for it in the returned tier', () => {
    script({
      // Pass 1: fock's cause differs between tier 1 and tier 2.
      'p1:req:c5:genoa': fail('mask-blocked'),
      'p1:req:c5:fock': fail('calm-without-motor'),
      'p1:req:none:genoa': fail('mask-blocked'),
      'p1:req:none:fock': fail('horizon-exceeded'),
      // Pass 2 returns tier 1′ with fock failed budget-exhausted.
      'p2:req:c5:genoa': ok(101),
      'p2:req:c5:fock': fail('budget-exhausted'),
      'p2:req:none:genoa': fail('horizon-exceeded'),
      'p2:req:none:fock': fail('horizon-exceeded'),
    });
    const { result } = plan(MOTOR_OFF);
    expect(distanceOf(result, 'genoa')).toBe(101);
    expect(sailOf(result, 'fock')?.reason).toBe('calm-motor-off');
  });

  it('comparisonComplete: false when a sail of the returned tier was cut by the budget in pass 2', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(121),
      'p2:req:c5:fock': fail('budget-exhausted'),
      'p2:req:none:genoa': fail('budget-exhausted'),
      'p2:req:none:fock': fail('budget-exhausted'),
    });
    const { result } = plan(MOTOR_OFF);
    expect(distanceOf(result, 'genoa')).toBe(121);
    expect(result.status === 'ok' && result.comparisonComplete).toBe(false);
  });

  it("comparisonComplete: true when the returned tier's failed sail finished its pass-2 search", () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': ok(131),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': fail('horizon-exceeded'),
      'p2:req:none:fock': fail('horizon-exceeded'),
    });
    const { result } = plan(MOTOR_OFF);
    expect(distanceOf(result, 'genoa')).toBe(131);
    expect(result.status === 'ok' && result.comparisonComplete).toBe(true);
  });

  it('discard: pass 2 routing nothing returns pass 1 verbatim', () => {
    script({ ...P1_REQ_BLOCKED, ...P2_REQ_NONE });
    expect(plan(MOTOR_OFF).result).toEqual({
      status: 'error',
      reason: 'unreachable',
    });
    expect(pass2Keys()).toHaveLength(4);
  });

  it('budget: pass 2 ending budget-exhausted with nothing routed returns pass 1 (ruling 4)', () => {
    script({
      ...P1_REQ_BLOCKED,
      'p2:req:c5:genoa': fail('budget-exhausted'),
      'p2:req:c5:fock': fail('budget-exhausted'),
      'p2:req:none:genoa': fail('budget-exhausted'),
      'p2:req:none:fock': fail('budget-exhausted'),
    });
    expect(plan(MOTOR_OFF).result).toEqual({
      status: 'error',
      reason: 'unreachable',
    });
  });

  it("relaxed tiers replay at pass 1's gate, with no second findRelaxedGate, once the requested gate routed nothing", () => {
    relaxMock.mockReturnValue(RELAXED);
    script({
      ...P1_REQ_BLOCKED,
      ...P1_REL_BLOCKED,
      ...P2_REQ_NONE,
      'p2:rel:c5:genoa': ok(111),
      'p2:rel:c5:fock': ok(112),
    });
    const { result } = plan(MOTOR_OFF, 'shoal');
    expect(relaxMock).toHaveBeenCalledTimes(1);
    expect(pass2Keys()).toEqual([
      'req:5:genoa',
      'req:5:fock',
      'req:none:genoa',
      'req:none:fock',
      'rel:5:genoa',
      'rel:5:fock',
    ]);
    expect(distanceOf(result, 'genoa')).toBe(111);
    if (result.status === 'ok') expect(result.shallow?.usedDepthM).toBe(2.5);
  });
});

describe('#1136 pass-2 cap (ruling of 2026-09-15, comment 5680650879)', () => {
  // A fake clock: a live solve advances it by `costMs`; a solve entered with its
  // deadline expired returns budget-exhausted at once, as `solve()` does.
  function clocked(table: Record<string, { out: Out; costMs: number }>, sharedEndMs: number) {
    let clockMs = 0;
    const entries: string[] = [];
    const shared: PlanDeadline = {
      expired: () => clockMs >= sharedEndMs,
      now: () => clockMs,
    };
    solveMock.mockImplementation((p: SolveParams) => {
      const pass = p.salvage === true ? 'p2' : 'p1';
      const comfort = p.comfortDepthM === undefined ? 'none' : `c${p.comfortDepthM}`;
      const key = `${pass}:req:${comfort}:${p.polar.rig}`;
      if (p.deadline?.expired() === true) {
        entries.push(`${key}@${clockMs}:cut`);
        return fail('budget-exhausted');
      }
      entries.push(`${key}@${clockMs}`);
      const row = table[key];
      if (row === undefined) throw new Error(`unscripted solve ${key}`);
      clockMs += row.costMs;
      return row.out;
    });
    return { shared, entries };
  }
  const P1_SLOW = {
    'p1:req:c5:genoa': { out: fail('mask-blocked'), costMs: 25_000 },
    'p1:req:c5:fock': { out: fail('mask-blocked'), costMs: 25_000 },
    'p1:req:none:genoa': { out: fail('mask-blocked'), costMs: 25_000 },
    'p1:req:none:fock': { out: fail('mask-blocked'), costMs: 25_000 },
  };

  it('stops pass 2 at 60 s after pass 2 starts while the shared budget has time left', () => {
    const { shared, entries } = clocked(
      {
        ...P1_SLOW,
        'p2:req:c5:genoa': { out: fail('horizon-exceeded'), costMs: 25_000 },
        'p2:req:c5:fock': { out: fail('horizon-exceeded'), costMs: 25_000 },
        'p2:req:none:genoa': { out: fail('horizon-exceeded'), costMs: 25_000 },
        'p2:req:none:fock': { out: fail('horizon-exceeded'), costMs: 25_000 },
      },
      240_000,
    );
    const { result } = plan(MOTOR_OFF, 'open', shared);
    expect(PASS2_BUDGET_MS).toBe(60_000);
    // Pass 1 spent 100 s; pass 2 runs 75 s of solves and the fourth is cut at
    // 175 s, 65 s before the shared budget ends.
    expect(entries.slice(4)).toEqual([
      'p2:req:c5:genoa@100000',
      'p2:req:c5:fock@125000',
      'p2:req:none:genoa@150000',
      'p2:req:none:fock@175000:cut',
    ]);
    expect(result).toEqual({ status: 'error', reason: 'unreachable' });
    // Pass 1 solves get the shared deadline; pass 2 solves a sub-deadline.
    const deadlines = solveMock.mock.calls.map(([p]) => p.deadline);
    expect(deadlines.slice(0, 4).every((d) => d === shared)).toBe(true);
    expect(deadlines.slice(4).every((d) => d !== undefined && d !== shared)).toBe(true);
  });

  it('stops pass 2 when the shared budget ends before the cap', () => {
    const { shared, entries } = clocked(
      {
        ...P1_SLOW,
        'p2:req:c5:genoa': { out: fail('horizon-exceeded'), costMs: 25_000 },
        'p2:req:c5:fock': { out: fail('horizon-exceeded'), costMs: 25_000 },
      },
      120_000,
    );
    const { result } = plan(MOTOR_OFF, 'open', shared);
    expect(entries.slice(4)).toEqual([
      'p2:req:c5:genoa@100000',
      'p2:req:c5:fock@125000:cut',
      'p2:req:none:genoa@125000:cut',
      'p2:req:none:fock@125000:cut',
    ]);
    expect(result).toEqual({ status: 'error', reason: 'unreachable' });
  });

  it('a tier cut by the cap leaves the earlier routed pass-2 tier standing', () => {
    const { shared } = clocked(
      {
        ...P1_SLOW,
        'p2:req:c5:genoa': { out: ok(141), costMs: 25_000 },
        'p2:req:c5:fock': { out: fail('horizon-exceeded'), costMs: 40_000 },
      },
      240_000,
    );
    const { result } = plan(MOTOR_OFF, 'open', shared);
    expect(distanceOf(result, 'genoa')).toBe(141);
    expect(result.status === 'ok' && result.comparisonComplete).toBe(true);
  });

  it('an unbudgeted plan gives pass 2 no deadline', () => {
    script({ ...P1_REQ_BLOCKED, ...P2_REQ_NONE });
    plan(MOTOR_OFF);
    expect(solveMock.mock.calls.some(([p]) => 'deadline' in p)).toBe(false);
  });
});

describe('#1136 second-pass progress', () => {
  it('marks progress secondPass: true on pass-2 solves only', () => {
    solveMock.mockImplementation((p: SolveParams) => {
      p.onProgress?.({ tMs: 1, frontierSize: 1 });
      return p.salvage === true ? fail('horizon-exceeded') : fail('mask-blocked');
    });
    const onProgress = vi.fn();
    const deps = testPlanDeps(MASKS.open, { genoa: TEST_POLAR, fock: FOCK });
    planRoute(request(MOTOR_OFF), uniformWindGrid(12, 0), deps, onProgress);
    expect(onProgress.mock.calls).toEqual([
      ['genoa', { tMs: 1, frontierSize: 1 }],
      ['fock', { tMs: 1, frontierSize: 1 }],
      ['genoa', { tMs: 1, frontierSize: 1 }],
      ['fock', { tMs: 1, frontierSize: 1 }],
      ['genoa', { tMs: 1, frontierSize: 1, secondPass: true }],
      ['fock', { tMs: 1, frontierSize: 1, secondPass: true }],
      ['genoa', { tMs: 1, frontierSize: 1, secondPass: true }],
      ['fock', { tMs: 1, frontierSize: 1, secondPass: true }],
    ]);
  });
});
