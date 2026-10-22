import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbForTests, getPlan, savePlan } from './db';
import { migratePlan } from './migratePlan';
import { defaultBoatSnapshot, DEFAULT_SETTINGS, PLAN_SCHEMA_VERSION, type Plan } from '../types';
import { makeWaveGrid } from '../test/waveFixtures';

// #1699: Plan.waveGrid is optional and must survive every read; no DB_VERSION bump.
function plan(extra: Partial<Plan> = {}): Plan {
  return {
    id: 'wave-plan',
    name: 'Flensburg → Sønderborg',
    createdAtMs: 1_790_000_000_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.8, lon: 9.5 },
      destination: { lat: 54.9, lon: 9.8 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: 1_790_000_000_000,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: {
      lats: [54.8, 54.9],
      lons: [9.5, 9.6],
      timesMs: [1_790_000_000_000],
      speedKn: new Float32Array([10, 11, 12, 13]),
      dirFromDeg: new Float32Array([200, 210, 220, 230]),
      gustKn: new Float32Array([14, 15, 16, 17]),
      fetchedAtMs: 1_789_990_000_000,
      model: 'icon_seamless',
    },
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [],
            etaMs: 1_790_003_600_000,
            durationMs: 3_600_000,
            distanceNm: 12,
            maneuverCount: 1,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: null },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: { lat: 54.8, lon: 9.5 },
      snappedDestination: { lat: 54.9, lon: 9.8 },
    },
    ...extra,
  };
}

const brand = (x: unknown) => Object.prototype.toString.call(x);
const grid = () =>
  makeWaveGrid((la, lo, t) => ({ heightM: la + lo / 10 + t, periodS: 4, dirFromDeg: 270 }));

describe('#1699 waveGrid persistence', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('migratePlan carries a stored waveGrid through', () => {
    const g = grid();
    const migrated = migratePlan(structuredClone(plan({ waveGrid: g })));
    // Array.from: a structured clone in vitest crosses realms (see db.test.ts).
    expect(Array.from(migrated!.waveGrid!.waveHeightM)).toEqual(Array.from(g.waveHeightM));
    expect(Array.from(migrated!.waveGrid!.waveDirFromDeg)).toEqual(Array.from(g.waveDirFromDeg));
    expect(migrated!.waveGrid!.timesMs).toEqual(g.timesMs);
  });

  it('survives an IndexedDB save → getPlan round trip with its Float32Arrays', async () => {
    const g = grid();
    await savePlan(plan({ waveGrid: g }));
    const back = await getPlan('wave-plan');
    expect(brand(back?.waveGrid?.waveHeightM)).toBe('[object Float32Array]');
    expect(Array.from(back!.waveGrid!.waveHeightM)).toEqual(Array.from(g.waveHeightM));
    expect(back?.waveGrid?.model).toBe('ewam');
  });

  it('loads a plan saved before the field existed unchanged, with no waveGrid key', async () => {
    const old = plan();
    await savePlan(old);
    const back = await getPlan('wave-plan');
    expect(back).not.toBeNull();
    expect(Object.hasOwn(back!, 'waveGrid')).toBe(false);
    expect(Array.from(back!.windGrid.speedKn)).toEqual(Array.from(old.windGrid.speedKn));
    expect(back!.result).toEqual(old.result);
  });

  it.each<[string, unknown]>([
    ['a string', 'not a grid'],
    ['an array', [1, 2, 3]],
    ['null', null],
  ])('drops a waveGrid that is %s and keeps the plan', (_label, bad) => {
    const raw = { ...structuredClone(plan()), waveGrid: bad };
    const migrated = migratePlan(raw);
    expect(migrated).not.toBeNull();
    expect(Object.hasOwn(migrated!, 'waveGrid')).toBe(false);
  });

  const BUFFERS = ['waveHeightM', 'wavePeriodS', 'waveDirFromDeg'] as const;
  const AXES = ['lats', 'lons', 'timesMs'] as const;
  const emptyBuffers = Object.fromEntries(BUFFERS.map((k) => [k, new Float32Array(0)]));
  const damaged: [string, unknown][] = [
    ...BUFFERS.flatMap((k): [string, unknown][] => [
      [`${k} a plain array`, { ...grid(), [k]: Array.from(grid()[k]) }],
      [`${k} one value short`, { ...grid(), [k]: grid()[k].slice(1) }],
    ]),
    ...AXES.flatMap((k): [string, unknown][] => [
      [`${k} missing`, { ...grid(), [k]: undefined }],
      [`${k} not an array`, { ...grid(), [k]: { length: grid()[k].length } }],
      // Buffers sized to match, so only the non-empty check can reject it.
      [`${k} empty`, { ...grid(), ...emptyBuffers, [k]: [] }],
      [`${k} with a NaN`, { ...grid(), [k]: grid()[k].map((v, i) => (i === 0 ? NaN : v)) }],
      [
        `${k} with a string`,
        { ...grid(), [k]: grid()[k].map((v, i) => (i === 0 ? String(v) : v)) },
      ],
    ]),
  ];

  it('control: the undamaged grid passes the same path', () => {
    const migrated = migratePlan({ ...structuredClone(plan()), waveGrid: grid() });
    expect(Object.hasOwn(migrated!, 'waveGrid')).toBe(true);
  });

  it.each(damaged)('drops a waveGrid with %s and keeps the plan', (_label, bad) => {
    const raw = { ...structuredClone(plan()), waveGrid: bad };
    const migrated = migratePlan(raw);
    expect(migrated).not.toBeNull();
    expect(Object.hasOwn(migrated!, 'waveGrid')).toBe(false);
  });
});
