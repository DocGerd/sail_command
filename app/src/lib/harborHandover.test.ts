import { describe, expect, it } from 'vitest';
import { PLAN_SCHEMA_VERSION, DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, Plan, PlanResultOk } from '../types';
import { uniformWindGrid } from '../test/fixtures';
import { destinationPoint } from './geo';
import {
  harborHandoverEndsOf,
  harborHandoverLines,
  parseHarborHandovers,
  SNAP_RADIUS_M,
  VIA_HANDOVER_CLEARANCE_NM,
  withHarborHandover,
} from './harborHandover';

// `?raw` is only vacuous for .css; each read is asserted non-empty below.
const sources = import.meta.glob<string>(['./mask.ts', '../state/replan.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const M_PER_NM = 1852;
const ORIGIN: LatLon = { lat: 54.8, lon: 9.5 };
const DESTINATION: LatLon = { lat: 54.9, lon: 9.7 };

function okResult(over: Partial<PlanResultOk> = {}): PlanResultOk {
  return {
    status: 'ok',
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: ORIGIN,
    snappedDestination: DESTINATION,
    sails: [{ sailId: 'genoa', result: null, reason: 'unreachable' }],
    ...over,
  };
}

function makePlan(result: PlanResultOk): Plan {
  return {
    id: 'p',
    name: 'p',
    createdAtMs: 0,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: 0,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: uniformWindGrid(10, 270),
    result,
  };
}

const off = (p: LatLon, metres: number): LatLon => destinationPoint(p, 90, metres / M_PER_NM);

describe('withHarborHandover', () => {
  it('returns the same object when no end is flagged, and omits the key', () => {
    const r = okResult();
    const out = withHarborHandover(r, {});
    expect(out).toBe(r);
    expect(Object.hasOwn(out, 'harborHandovers')).toBe(false);
  });

  it('writes only the flagged ends', () => {
    const out = withHarborHandover(okResult(), { destination: true });
    expect(out.harborHandovers).toEqual({ destination: true });
    expect(Object.hasOwn(out.harborHandovers ?? {}, 'origin')).toBe(false);
  });

  it('does not mutate its input', () => {
    const r = okResult();
    withHarborHandover(r, { origin: true });
    expect(Object.hasOwn(r, 'harborHandovers')).toBe(false);
  });
});

describe('parseHarborHandovers', () => {
  it('treats undefined as absent', () => {
    expect(parseHarborHandovers(undefined)).toBeNull();
  });

  it('round-trips the writer output', () => {
    const both = withHarborHandover(okResult(), { origin: true, destination: true });
    expect(parseHarborHandovers(both.harborHandovers)).toEqual({
      origin: true,
      destination: true,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'origin'],
    ['an array', [true]],
    ['an empty object', {}],
    ['a false value', { origin: false }],
    ['a truthy non-true value', { origin: 1 }],
    ['an unknown key', { origin: true, via: true }],
    ['an undefined value', { origin: undefined }],
  ])('rejects %s as malformed', (_name, raw) => {
    expect(parseHarborHandovers(raw)).toBe('malformed');
  });

  it('rejects every Object.prototype member name as a key', () => {
    const names = Object.getOwnPropertyNames(Object.prototype);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const raw = JSON.parse(JSON.stringify({ [name]: true })) as unknown;
      expect(parseHarborHandovers(raw), name).toBe('malformed');
    }
  });

  it('does not read an inherited flag', () => {
    const raw = Object.create({ origin: true }) as unknown;
    expect(parseHarborHandovers(raw)).toBe('malformed');
  });
});

describe('harborHandoverEndsOf', () => {
  it('is null for an ordinary plan', () => {
    expect(harborHandoverEndsOf(makePlan(okResult()))).toBeNull();
  });

  it('reports a stored flag', () => {
    const plan = makePlan(withHarborHandover(okResult(), { origin: true }));
    expect(harborHandoverEndsOf(plan)).toEqual({ origin: true });
  });

  it('treats an unflagged end whose snap is over the snap radius away as a handover', () => {
    const plan = makePlan(okResult({ snappedDestination: off(DESTINATION, SNAP_RADIUS_M + 5) }));
    expect(harborHandoverEndsOf(plan)).toEqual({ destination: true });
  });

  it('does not treat an unflagged end at the snap radius as a handover', () => {
    const plan = makePlan(
      okResult({
        snappedOrigin: off(ORIGIN, SNAP_RADIUS_M + 0.5),
        snappedDestination: off(DESTINATION, SNAP_RADIUS_M - 20),
      }),
    );
    expect(harborHandoverEndsOf(plan)).toBeNull();
  });

  it('ignores an inherited flag', () => {
    const inherited = Object.assign(
      Object.create({ harborHandovers: { origin: true } }) as object,
      okResult(),
    ) as PlanResultOk;
    expect(harborHandoverEndsOf(makePlan(inherited))).toBeNull();
  });

  it('unions the stored flag with the derived one', () => {
    const plan = makePlan(
      withHarborHandover(okResult({ snappedDestination: off(DESTINATION, 900) }), {
        origin: true,
      }),
    );
    expect(harborHandoverEndsOf(plan)).toEqual({ origin: true, destination: true });
  });
});

describe('harborHandoverLines', () => {
  it('is empty without a handover', () => {
    expect(harborHandoverLines(makePlan(okResult()))).toEqual([]);
  });

  it('derives geometry from the request and the snapped end, origin first', () => {
    const snappedOrigin = off(ORIGIN, 800);
    const snappedDestination = off(DESTINATION, 1200);
    const plan = makePlan(
      withHarborHandover(okResult({ snappedOrigin, snappedDestination }), {
        origin: true,
        destination: true,
      }),
    );
    const lines = harborHandoverLines(plan);
    expect(lines.map((l) => l.end)).toEqual(['origin', 'destination']);
    expect(lines[0]?.harbour).toBe(plan.request.origin);
    expect(lines[0]?.handover).toBe(snappedOrigin);
    expect(lines[0]?.distNm * M_PER_NM).toBeCloseTo(800, 0);
    expect(lines[1]?.harbour).toBe(plan.request.destination);
    expect(lines[1]?.distNm * M_PER_NM).toBeCloseTo(1200, 0);
  });

  it('lists only the flagged end', () => {
    const plan = makePlan(
      withHarborHandover(okResult({ snappedDestination: off(DESTINATION, 500) }), {
        destination: true,
      }),
    );
    expect(harborHandoverLines(plan).map((l) => l.end)).toEqual(['destination']);
  });
});

describe('constant twins', () => {
  function read(rel: string): string {
    const src = sources[rel];
    expect(src?.length ?? 0, `${rel} read as empty`).toBeGreaterThan(0);
    return src ?? '';
  }

  it('SNAP_RADIUS_M matches snapToNavigable default maxRadiusM', () => {
    const m = /snapToNavigable\([^)]*maxRadiusM = (\d+)\)/.exec(read('./mask.ts'));
    expect(m, 'pattern no longer matches mask.ts').not.toBeNull();
    expect(Number(m?.[1])).toBe(SNAP_RADIUS_M);
  });

  it("VIA_HANDOVER_CLEARANCE_NM matches replan's DEDUPE_THRESHOLD_NM", () => {
    const m = /const DEDUPE_THRESHOLD_NM = (\d+) \/ (\d+);/.exec(read('../state/replan.ts'));
    expect(m, 'pattern no longer matches replan.ts').not.toBeNull();
    expect(Number(m?.[1]) / Number(m?.[2])).toBe(VIA_HANDOVER_CLEARANCE_NM);
  });
});
