import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  planRouteWithRecord,
  planRouteWithRecordAsync,
  solveRig,
  type PlanDeadline,
  type RigStep,
  type RunOut,
} from './planRoute';
import { solve, type SolveFailureCause, type SolveParams } from './isochrone';
import { findRelaxedGate } from './relaxedDepth';
import { uniformGate } from '../lib/depthGate';
import { makeMask, TEST_POLAR, testPlanDeps, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type Leg,
  type PlanRequest,
  type PolarTable,
  type SailId,
  type Settings,
} from '../types';

// The async driver over the shared ladder must return exactly what the sync
// driver does. `solve` is scripted so each scenario's tier path is known; the
// step runner below solves a step's rigs in REVERSE order with awaits between,
// so results only line up if the driver keys them by `sailIds` index.
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
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
const ORIGIN = { lat: 54.3 + 80.5 * 0.005, lon: 9.4 + 120.5 * 0.005 };
const DESTINATION = { lat: 54.3 + 80.5 * 0.005, lon: 9.4 + 124.5 * 0.005 };
const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const MASKS = {
  open: makeMask(() => 200),
  walled: makeMask((_r, c) => (c === 122 ? 0 : 200)),
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
const ok = (distanceNm = 1, etaMs = T0 + 1) => ({
  status: 'ok' as const,
  legs: [leg(distanceNm)],
  etaMs,
  costMs: etaMs,
});
const fail = (cause: SolveFailureCause) => ({ status: 'no-route' as const, cause });
type Out = ReturnType<typeof ok> | ReturnType<typeof fail>;

/** Keys are `<pass>:<gate>:<comfort>:<rig>`; an unscripted solve throws. */
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

function request(settings: Settings, sailIds: readonly SailId[] = ['genoa', 'fock']): PlanRequest {
  return {
    origin: ORIGIN,
    destination: DESTINATION,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: T0,
    settings,
    sailIds,
    boat: defaultBoatSnapshot(),
  };
}

/** Rigs in reverse order, yielding to the event loop between them. */
async function reverseRunner(step: RigStep): Promise<RunOut[]> {
  const { ctx } = step;
  const out: RunOut[] = [];
  for (let i = ctx.sailIds.length - 1; i >= 0; i--) {
    await Promise.resolve();
    out[i] = solveRig(
      ctx,
      ctx.sailIds[i],
      ctx.polarFor(ctx.sailIds[i]),
      step.gate,
      step.comfortDepthM,
      step.pass2 !== null,
      step.deadline,
    );
  }
  return out;
}

function run(
  settings: Settings,
  where: keyof typeof MASKS,
  sailIds?: readonly SailId[],
  deadline?: PlanDeadline,
) {
  const deps = testPlanDeps(MASKS[where], { genoa: TEST_POLAR, fock: FOCK });
  const req = request(settings, sailIds);
  const wind = uniformWindGrid(12, 0);
  const sync = planRouteWithRecord(req, wind, deps, undefined, undefined, deadline);
  const syncCalls = solveMock.mock.calls.length;
  solveMock.mockClear();
  return {
    sync,
    syncCalls,
    async: () =>
      planRouteWithRecordAsync(req, wind, deps, reverseRunner, undefined, deadline).then((r) => ({
        r,
        calls: solveMock.mock.calls.length,
      })),
  };
}

beforeEach(() => {
  solveMock.mockReset();
  relaxMock.mockReset();
  relaxMock.mockReturnValue(null);
});

const BLOCKED_REQ: Record<string, Out> = {
  'p1:req:c5:genoa': fail('mask-blocked'),
  'p1:req:c5:fock': fail('mask-blocked'),
  'p1:req:none:genoa': fail('mask-blocked'),
  'p1:req:none:fock': fail('mask-blocked'),
};
const BLOCKED_REL: Record<string, Out> = {
  'p1:rel:c5:genoa': fail('mask-blocked'),
  'p1:rel:c5:fock': fail('mask-blocked'),
  'p1:rel:none:genoa': fail('mask-blocked'),
  'p1:rel:none:fock': fail('mask-blocked'),
};

interface Scenario {
  name: string;
  settings: Settings;
  where: keyof typeof MASKS;
  sailIds?: readonly SailId[];
  relax?: boolean;
  table: Record<string, Out>;
  tiers: number[];
  pass2: 'not-admitted' | 'admitted-no-route' | 'rescued';
}
const SCENARIOS: Scenario[] = [
  {
    name: 'tier 1 routes both rigs; genoa decided on ETA',
    settings: DEFAULT_SETTINGS,
    where: 'open',
    table: {
      'p1:req:c5:genoa': ok(5, T0 + 100_000),
      'p1:req:c5:fock': ok(6, T0 + 900_000),
    },
    tiers: [1],
    pass2: 'not-admitted',
  },
  {
    name: 'tier 1 tie within the rig band',
    settings: DEFAULT_SETTINGS,
    where: 'open',
    table: { 'p1:req:c5:genoa': ok(5, T0 + 1), 'p1:req:c5:fock': ok(6, T0 + 2) },
    tiers: [1],
    pass2: 'not-admitted',
  },
  {
    name: 'one rig fails tier 1, tier 2 retry routes both',
    settings: DEFAULT_SETTINGS,
    where: 'open',
    table: {
      'p1:req:c5:genoa': fail('mask-blocked'),
      'p1:req:c5:fock': ok(6, T0 + 5),
      'p1:req:none:genoa': ok(7, T0 + 700_000),
      'p1:req:none:fock': ok(8, T0 + 100_000),
    },
    tiers: [1, 2],
    pass2: 'not-admitted',
  },
  {
    name: 'tier 2 fails on every rig, tier 1 result stands',
    settings: DEFAULT_SETTINGS,
    where: 'open',
    table: {
      'p1:req:c5:genoa': fail('horizon-exceeded'),
      'p1:req:c5:fock': ok(6),
      'p1:req:none:genoa': fail('mask-blocked'),
      'p1:req:none:fock': fail('mask-blocked'),
    },
    tiers: [1, 2],
    pass2: 'not-admitted',
  },
  {
    name: 'disconnected requested gate goes straight to the relaxed tier',
    settings: DEFAULT_SETTINGS,
    where: 'walled',
    relax: true,
    table: { 'p1:rel:c5:genoa': ok(3, T0 + 50), 'p1:rel:c5:fock': ok(4, T0 + 90_000_000) },
    tiers: [3],
    pass2: 'not-admitted',
  },
  {
    name: 'relaxed tier 3 fails, tier 4 retry routes one rig',
    settings: DEFAULT_SETTINGS,
    where: 'walled',
    relax: true,
    table: {
      'p1:rel:c5:genoa': fail('mask-blocked'),
      'p1:rel:c5:fock': fail('mask-blocked'),
      'p1:rel:none:genoa': fail('horizon-exceeded'),
      'p1:rel:none:fock': ok(9),
    },
    tiers: [3, 4],
    pass2: 'not-admitted',
  },
  {
    name: 'motor-off pass 2 rescues after all four tiers',
    settings: MOTOR_OFF,
    where: 'open',
    relax: true,
    table: {
      ...BLOCKED_REQ,
      ...BLOCKED_REL,
      'p2:req:c5:genoa': fail('horizon-exceeded'),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': fail('horizon-exceeded'),
      'p2:req:none:fock': fail('horizon-exceeded'),
      'p2:rel:c5:genoa': fail('horizon-exceeded'),
      'p2:rel:c5:fock': ok(11, T0 + 300_000),
      'p2:rel:none:genoa': ok(12, T0 + 1_000),
      'p2:rel:none:fock': fail('horizon-exceeded'),
    },
    tiers: [1, 2, 3, 4],
    pass2: 'rescued',
  },
  {
    name: 'motor-off pass 2 routes nothing and returns pass 1',
    settings: MOTOR_OFF,
    where: 'open',
    table: {
      ...BLOCKED_REQ,
      'p2:req:c5:genoa': fail('horizon-exceeded'),
      'p2:req:c5:fock': fail('horizon-exceeded'),
      'p2:req:none:genoa': fail('horizon-exceeded'),
      'p2:req:none:fock': fail('horizon-exceeded'),
    },
    tiers: [1, 2],
    pass2: 'admitted-no-route',
  },
  {
    name: 'a single requested sail',
    settings: DEFAULT_SETTINGS,
    where: 'open',
    sailIds: ['fock'],
    table: { 'p1:req:c5:fock': ok(2) },
    tiers: [1],
    pass2: 'not-admitted',
  },
  {
    name: 'both rigs cut by the budget',
    settings: DEFAULT_SETTINGS,
    where: 'open',
    table: {
      'p1:req:c5:genoa': fail('budget-exhausted'),
      'p1:req:c5:fock': fail('budget-exhausted'),
    },
    tiers: [1],
    pass2: 'not-admitted',
  },
];

describe('async driver equals the sync driver over the shared ladder', () => {
  it.each(SCENARIOS)('$name', async (sc) => {
    if (sc.relax) relaxMock.mockReturnValue(RELAXED);
    script(sc.table);
    const h = run(sc.settings, sc.where, sc.sailIds);
    expect(h.sync.record.tiers.map((t) => t.tier)).toEqual(sc.tiers);
    expect(h.sync.pass2).toBe(sc.pass2);
    const { r, calls } = await h.async();
    expect(r).toEqual(h.sync);
    expect(calls).toBe(h.syncCalls);
    expect(calls).toBeGreaterThan(0);
  });

  it('the scenarios cover a decided and a tied comparison', () => {
    const kinds = new Set<string>();
    for (const sc of SCENARIOS.slice(0, 2)) {
      script(sc.table);
      const { sync } = run(sc.settings, sc.where, sc.sailIds);
      if (sync.result.status === 'ok') kinds.add(sync.result.rigRecommendation.kind);
      solveMock.mockReset();
    }
    expect([...kinds].sort()).toEqual(['decided', 'tie']);
  });

  it('a pass-2 step carries the clock reading it started at; unbudgeted carries none', async () => {
    const steps: RigStep[] = [];
    const record = (step: RigStep): Promise<RunOut[]> => {
      steps.push(step);
      return reverseRunner(step);
    };
    const sc = SCENARIOS.find((s) => s.pass2 === 'rescued')!;
    relaxMock.mockReturnValue(RELAXED);
    script(sc.table);
    const deps = testPlanDeps(MASKS.open, { genoa: TEST_POLAR, fock: FOCK });
    const wind = uniformWindGrid(12, 0);
    await planRouteWithRecordAsync(request(MOTOR_OFF), wind, deps, record, undefined, {
      expired: () => false,
      now: () => 4242,
    });
    const pass2 = steps.filter((s) => s.pass2 !== null);
    expect(pass2.length).toBeGreaterThan(0);
    expect(pass2.every((s) => s.pass2?.startMs === 4242)).toBe(true);
    expect(pass2.every((s) => s.deadline === s.pass2?.deadline)).toBe(true);
    expect(steps.filter((s) => s.pass2 === null).every((s) => s.deadline !== undefined)).toBe(true);

    steps.length = 0;
    await planRouteWithRecordAsync(request(MOTOR_OFF), wind, deps, record);
    expect(steps.filter((s) => s.pass2 !== null).map((s) => s.pass2)).not.toHaveLength(0);
    expect(steps.every((s) => s.deadline === undefined)).toBe(true);
    expect(steps.every((s) => s.pass2 === null || s.pass2.startMs === undefined)).toBe(true);
  });
});
