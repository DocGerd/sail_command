// #1830: sea-state column and route line in RouteSummary. Its own file, like
// RouteSummary.exposure.test.tsx, so RouteSummary.test.tsx's fixtures stay as
// they are; services/assets is left unmocked for the same useNavMask reason.
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import { uniformWindGrid } from '../test/fixtures';
import { makeWaveGrid } from '../test/waveFixtures';
import {
  DEFAULT_SETTINGS,
  PLAN_SCHEMA_VERSION,
  defaultBoatSnapshot,
  type Leg,
  type Plan,
  type RigResult,
  type SailId,
  type WaveGrid,
} from '../types';
import RouteSummary from './RouteSummary';

vi.mock('../state/useSeamarks', () => ({ useSeamarks: vi.fn(() => null) }));

const FETCHED_AT_MS = Date.UTC(2026, 6, 15, 6, 0, 0);
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
const H = 3_600_000;

const GENOA_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.8, lon: 10.0 },
    startTimeMs: DEPARTURE_MS,
    endTimeMs: DEPARTURE_MS + 2 * H,
    headingDeg: 88,
    twaDeg: 92,
    twsKn: 10,
    speedKn: 7,
    distanceNm: 15,
    maneuverAtStart: null,
  },
  {
    kind: 'motor',
    board: null,
    start: { lat: 54.8, lon: 10.0 },
    end: { lat: 54.85, lon: 10.52 },
    startTimeMs: DEPARTURE_MS + 2 * H,
    endTimeMs: DEPARTURE_MS + 4 * H,
    headingDeg: 90,
    twsKn: 2,
    speedKn: 6.5,
    distanceNm: 5,
    maneuverAtStart: null,
  },
  {
    kind: 'sail',
    board: 'port',
    start: { lat: 54.85, lon: 10.52 },
    end: { lat: 54.86, lon: 10.55 },
    startTimeMs: DEPARTURE_MS + 4 * H,
    endTimeMs: DEPARTURE_MS + 5 * H,
    headingDeg: 60,
    twaDeg: -80,
    twsKn: 10,
    speedKn: 6,
    distanceNm: 1.5,
    maneuverAtStart: 'tack',
  },
];

const GENOA_RESULT: RigResult = {
  sailId: 'genoa',
  etaMs: DEPARTURE_MS + 5 * H,
  durationMs: 5 * H,
  distanceNm: 21.5,
  maneuverCount: 1,
  motorDistanceNm: 5,
  legs: GENOA_LEGS,
};

const FOCK_RESULT: RigResult = {
  sailId: 'fock',
  etaMs: DEPARTURE_MS + 5 * H,
  durationMs: 5 * H,
  distanceNm: 22,
  maneuverCount: 0,
  motorDistanceNm: 0,
  legs: [
    {
      kind: 'sail',
      board: 'starboard',
      start: { lat: 54.79, lon: 9.43 },
      end: { lat: 54.79, lon: 9.75 },
      startTimeMs: DEPARTURE_MS,
      endTimeMs: DEPARTURE_MS + 5 * H,
      headingDeg: 85,
      twaDeg: 95,
      twsKn: 9,
      speedKn: 5.5,
      distanceNm: 22,
      maneuverAtStart: null,
    },
  ],
};

// Lon index 4 is the rough cell; the fock leg stays in the calm ones.
const LONS = [9.4, 9.7, 10.0, 10.3, 10.6];
const BY_LON = [0.3, 0.3, 0.3, 1.4, 2.6];

function waves(fn: (lo: number) => number = (lo) => BY_LON[lo]!): WaveGrid {
  return makeWaveGrid((_la, lo) => ({ heightM: fn(lo), periodS: 4, dirFromDeg: 270 }), {
    lats: [54.75, 54.8, 54.85, 54.9],
    lons: LONS,
    hours: 10,
    t0Ms: FETCHED_AT_MS,
  });
}

function makePlan(waveGrid?: WaveGrid): Plan {
  return {
    id: 'plan-1',
    name: 'Flensburg to Marstal',
    createdAtMs: FETCHED_AT_MS,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.86, lon: 10.55 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: FETCHED_AT_MS },
    ...(waveGrid ? { waveGrid } : {}),
    result: {
      status: 'ok',
      sails: [
        { sailId: 'genoa', result: GENOA_RESULT, reason: null },
        { sailId: 'fock', result: FOCK_RESULT, reason: null },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.86, lon: 10.55 },
    },
  };
}

function tree(plan: Plan, rig: SailId) {
  return (
    <I18nProvider>
      <RouteSummary plan={plan} rig={rig} onRigChange={vi.fn()} />
    </I18nProvider>
  );
}

function renderSummary(plan: Plan, lang: 'de' | 'en' = 'en', rig: SailId = 'genoa') {
  localStorage.setItem('sc-lang', lang);
  return render(tree(plan, rig));
}

function headers(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('table.route-legs thead th')).map((th) => th.textContent!);
}

function lastCells(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('table.route-legs tbody tr')).map(
    (tr) => tr.lastElementChild!.textContent!,
  );
}

function routeLine(c: HTMLElement, label: string): string | null {
  const p = Array.from(c.querySelectorAll('p.ergebnis-maneuvers')).find((e) =>
    e.textContent!.startsWith(label),
  );
  return p ? p.textContent : null;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(DEPARTURE_MS);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('#1830 sea state in the route summary', () => {
  it('renders nothing wave-related without a wave grid', () => {
    const { container } = renderSummary(makePlan());
    expect(headers(container)).toHaveLength(10);
    expect(headers(container)).not.toContain(en['route.legs.seaState']);
    expect(routeLine(container, en['route.totals.seaState'])).toBeNull();
    expect(container.textContent).not.toContain(en['route.legs.seaStateNote']);
  });

  it('adds a last column, the route line and the note with a wave grid (en)', () => {
    const { container } = renderSummary(makePlan(waves()));
    const h = headers(container);
    expect(h).toHaveLength(11);
    expect(h[10]).toBe(en['route.legs.seaState']);
    expect(lastCells(container)).toEqual(['0.3 m', '2.6 m', '2.6 m']);
    expect(routeLine(container, en['route.totals.seaState'])).toBe(
      `${en['route.totals.seaState']}: 2.6 m · ${en['seaState.band.rough']}`,
    );
    expect(container.textContent).toContain(en['route.legs.seaStateNote']);
  });

  it('uses German labels and decimal comma (de)', () => {
    const { container } = renderSummary(makePlan(waves()), 'de');
    expect(headers(container)[10]).toBe(de['route.legs.seaState']);
    expect(lastCells(container)).toEqual(['0,3 m', '2,6 m', '2,6 m']);
    expect(routeLine(container, de['route.totals.seaState'])).toBe(
      `${de['route.totals.seaState']}: 2,6 m · ${de['seaState.band.rough']}`,
    );
  });

  it('shows no data, never 0, when every cell is NaN', () => {
    const { container } = renderSummary(makePlan(waves(() => NaN)));
    expect(lastCells(container)).toEqual(Array(3).fill(en['route.seaState.noData']));
    expect(routeLine(container, en['route.totals.seaState'])).toBe(
      `${en['route.totals.seaState']}: ${en['route.seaState.noData']}`,
    );
  });

  it('prefixes a partial reading with ≥ and notes the gap on the route line', () => {
    const { container } = renderSummary(makePlan(waves((lo) => (lo === 1 ? NaN : BY_LON[lo]!))));
    expect(lastCells(container)).toEqual(['≥ 0.3 m', '2.6 m', '2.6 m']);
    expect(routeLine(container, en['route.totals.seaState'])).toBe(
      `${en['route.totals.seaState']}: ≥ 2.6 m · ${en['seaState.band.rough']} · ${en['route.seaState.partial']}`,
    );
    expect(container.querySelector('p.ergebnis-maneuvers span.route-legs-note')?.textContent).toBe(
      en['route.seaState.partial'],
    );
  });

  it('reads the active rig, not a fixed one', () => {
    const plan = makePlan(waves());
    const { container, rerender } = renderSummary(plan, 'en', 'genoa');
    expect(lastCells(container)).toHaveLength(3);
    rerender(tree(plan, 'fock'));
    expect(lastCells(container)).toEqual(['0.3 m']);
    expect(routeLine(container, en['route.totals.seaState'])).toBe(
      `${en['route.totals.seaState']}: 0.3 m · ${en['seaState.band.smooth']}`,
    );
  });

  it('gains the column when the same mounted summary receives a wave grid', () => {
    const { container, rerender } = renderSummary(makePlan());
    expect(headers(container)).toHaveLength(10);
    rerender(tree(makePlan(waves()), 'genoa'));
    expect(headers(container)).toHaveLength(11);
    rerender(tree(makePlan(), 'genoa'));
    expect(headers(container)).toHaveLength(10);
  });
});
