// #1881: PlannerPanel's own mount of the opening-bridge notice, so a user who
// stays on the Plan tab after planning still sees it. Its own file for the
// reason PlannerPanel.marginal.test.tsx gives: this panel needs a
// `services/assets` mock owned end to end.
import 'fake-indexeddb/auto';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  PLAN_SCHEMA_VERSION,
  type Leg,
  type LatLon,
  type Plan,
} from '../types';

vi.mock('../services/assets', () => ({
  loadRoutingAssets: vi.fn(() => new Promise(() => {})),
}));
import PlannerPanel, { type PlannerStatus } from './PlannerPanel';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
const NORTH: LatLon = { lat: 54.9210026, lon: 9.7830141 };
const SOUTH: LatLon = { lat: 54.9010026, lon: 9.7830141 };
const ELSEWHERE_A: LatLon = { lat: 54.8, lon: 9.43 };
const ELSEWHERE_B: LatLon = { lat: 54.85, lon: 10.52 };

function legBetween(start: LatLon, end: LatLon): Leg {
  return {
    kind: 'motor',
    board: null,
    start,
    end,
    startTimeMs: DEPARTURE_MS,
    endTimeMs: DEPARTURE_MS + 3_600_000,
    headingDeg: 180,
    twsKn: 0,
    speedKn: 6,
    distanceNm: 1,
    maneuverAtStart: null,
  };
}

function planThrough(start: LatLon, end: LatLon): Plan {
  return {
    id: 'plan-1881',
    name: 'Bridge notice test plan',
    createdAtMs: DEPARTURE_MS,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: start,
      destination: end,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: {
      lats: [54.3, 55.3],
      lons: [9.4, 11.0],
      timesMs: [DEPARTURE_MS],
      speedKn: new Float32Array(4),
      dirFromDeg: new Float32Array(4),
      gustKn: new Float32Array(4),
      fetchedAtMs: DEPARTURE_MS,
      model: 'test',
    },
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [legBetween(start, end)],
            etaMs: DEPARTURE_MS + 3_600_000,
            durationMs: 3_600_000,
            distanceNm: 1,
            maneuverCount: 0,
            motorDistanceNm: 1,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: 'unreachable' },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: start,
      snappedDestination: end,
    },
  };
}

function renderPanel(plan: Plan): HTMLElement {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <PlannerPanel
        harbors={[]}
        origin={null}
        destination={null}
        onPickOrigin={vi.fn()}
        onPickDestination={vi.fn()}
        onImportRoute={vi.fn()}
        onRequestMapTap={vi.fn()}
        tapTarget={null}
        onCancelTapPick={vi.fn()}
        viaPoints={[]}
        onRemoveVia={vi.fn()}
        onReorderVia={vi.fn()}
        onInsertViaAfter={vi.fn()}
        onInsertViaBeforeFirst={vi.fn()}
        onAddVia={vi.fn()}
        onUpdateVia={vi.fn()}
        onSelectSavedWaypoint={vi.fn()}
        departureMs={DEPARTURE_MS}
        onDepartureChange={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onSettingsChange={vi.fn()}
        boat={boatById(DEFAULT_BOAT_ID)}
        boatId={DEFAULT_BOAT_ID}
        canPlan={true}
        planDisabledReason={null}
        online={true}
        onPlan={vi.fn()}
        onCancelPlan={vi.fn()}
        planning={{ phase: 'idle' } as PlannerStatus}
        plan={plan}
        rig="genoa"
        formDirty={false}
        onViewDetails={vi.fn()}
        onOpenBoatSettings={vi.fn()}
      />
    </I18nProvider>,
  ).container;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('#1881: PlannerPanel mounts the opening-bridge notice', () => {
  it('shows it on the Plan tab for a plan crossing the bridge, with a non-crossing control', () => {
    const absent = renderPanel(planThrough(ELSEWHERE_A, ELSEWHERE_B));
    expect(absent.querySelector('.opening-bridge-notice')).toBeNull();
    cleanup();
    const present = renderPanel(planThrough(NORTH, SOUTH));
    const notice = present.querySelector('.opening-bridge-notice');
    expect(notice, 'control: a crossing plan must render the notice').not.toBeNull();
    expect(notice?.textContent).toContain("Kong Christian X's Bro");
    expect(notice?.getAttribute('role')).toBeNull();
  });
});
