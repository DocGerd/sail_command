// #612: PlannerPanel's own mount of the quiet marginal-depth notice — its own
// file, following this directory's established precedent
// (PlannerPanel.dst.test.tsx, RouteSummary.exposure.test.tsx) rather than an
// addition to the large, UNMOCKED PlannerPanel.test.tsx, whose 67 existing
// cases run with no `services/assets` mock at all. RouteSummary.exposure's own
// header records why that matters: a module-level mock only CONFIGURED by a
// subset of tests hands every other case an `undefined` from
// `loadRoutingAssets()`, and `undefined.then(...)` throws synchronously inside
// useNavMask's effect. This file owns its own mock end to end instead.
//
// WHY BOTH SURFACES ARE TESTED SEPARATELY rather than trusting the shared
// component: #455's defect was never in a component, it was in whether the
// component MOUNTS. RouteSummary.exposure.test.tsx proves the notice renders;
// this file proves PlannerPanel's own call site reaches it — the two call
// sites are what could drift, and a shared-component test cannot see that.
//
// #848 review fix (Minor): PlannerPanel now unconditionally mounts
// SavedWaypoints, which reads the real 'waypoints' IndexedDB store on
// mount. jsdom has no IndexedDB implementation at all, so without this the
// store read rejects and every test here silently console.errors. A global
// setup.ts registration was tried first and reverted — `sweep-closure`'s
// `closure.mjs diff` flips to OWED the moment setup.ts changes at all,
// because `app/sweep/vitest.config.ts` loads it as a setupFile; a per-file
// import here keeps the sweep verdict untouched.
import 'fake-indexeddb/auto';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { TEST_MASK_META, TEST_POLAR } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  PLAN_SCHEMA_VERSION,
  type Harbor,
  type Leg,
  type Plan,
} from '../types';

vi.mock('../services/assets', () => ({
  // A never-settling promise as the FACTORY default, so a row that does not
  // opt in to a resolved mask still gets useNavMask's honest "not loaded yet"
  // state rather than an `undefined` to call `.then` on.
  loadRoutingAssets: vi.fn(() => new Promise(() => {})),
}));
import { loadRoutingAssets } from '../services/assets';
import PlannerPanel, { type PlannerStatus } from './PlannerPanel';
import { boatById, DEFAULT_BOAT_ID, polarKey } from '../data/boats';

const mockedLoad = vi.mocked(loadRoutingAssets);

const CELL_LAT = (TEST_MASK_META.north - TEST_MASK_META.south) / TEST_MASK_META.rows;
const CELL_LON = (TEST_MASK_META.east - TEST_MASK_META.west) / TEST_MASK_META.cols;
const ROW = 100;

function pointAt(rowCenter: number, gridX: number) {
  return {
    lat: TEST_MASK_META.south + rowCenter * CELL_LAT,
    lon: TEST_MASK_META.west + gridX * CELL_LON,
  };
}

function assetsWithMask(fn: (row: number, col: number) => number) {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols);
  for (let r = 0; r < TEST_MASK_META.rows; r++)
    for (let c = 0; c < TEST_MASK_META.cols; c++) data[r * TEST_MASK_META.cols + c] = fn(r, c);
  return {
    maskMeta: TEST_MASK_META,
    maskBuffer: data.buffer,
    polars: {
      [polarKey(DEFAULT_BOAT_ID, 'genoa')]: TEST_POLAR,
      [polarKey(DEFAULT_BOAT_ID, 'fock')]: TEST_POLAR,
    },
    harbors: [],
    seamarks: { type: 'FeatureCollection' as const, features: [] },
  };
}

// Same geometry and depths as RouteSummary.exposure.test.tsx's own
// marginalMask()/deepMask() pair — 3.5 m is above the 3.0 m default gate (so
// the route is solver-valid and the relaxed-path threshold reads 0.0 nm) and
// below the 3.9 m marginal threshold, over 3 full interior columns of a
// 20.4-cell span, which is the same independently hand-derived 3.0 nm.
const marginalMask = () =>
  assetsWithMask(
    (row, col) =>
      row === ROW && (col === 55 || col === 56 || col === 57) ? 35 /* 3.5 m */ : 200 /* 20 m */,
  );
const deepMask = () => assetsWithMask(() => 200 /* 20 m */);

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
const START = pointAt(ROW + 0.5, 50.3);
const END = pointAt(ROW + 0.5, 70.7);
const LEG_DISTANCE_NM =
  (END.lon - TEST_MASK_META.west) / CELL_LON - (START.lon - TEST_MASK_META.west) / CELL_LON;

const EXPOSURE_LEG: Leg = {
  kind: 'motor',
  board: null,
  start: START,
  end: END,
  startTimeMs: DEPARTURE_MS,
  endTimeMs: DEPARTURE_MS + 3_600_000,
  headingDeg: 90,
  twsKn: 0,
  speedKn: 6,
  distanceNm: LEG_DISTANCE_NM,
  maneuverAtStart: null,
};

const HARBORS: Harbor[] = [];

/**
 * A plan that did NOT relax — the ordinary-route state. `PlanResult.shallow`
 * is `readonly shallow?: ShallowInfo`, so under exactOptionalPropertyTypes
 * that state is the key being ABSENT, never null and never undefined
 * (types.ts says so at the field). This literal therefore simply omits it.
 */
function nonRelaxedPlan(): Plan {
  return {
    id: 'plan-612',
    name: 'Marginal notice test plan',
    createdAtMs: DEPARTURE_MS,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: START,
      destination: END,
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
            legs: [EXPOSURE_LEG],
            etaMs: DEPARTURE_MS + 3_600_000,
            durationMs: 3_600_000,
            distanceNm: LEG_DISTANCE_NM,
            maneuverCount: 0,
            motorDistanceNm: LEG_DISTANCE_NM,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: 'unreachable' },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: START,
      snappedDestination: END,
    },
  };
}

async function renderPanelWithPlan() {
  localStorage.setItem('sc-lang', 'en');
  const { container } = render(
    <I18nProvider>
      <PlannerPanel
        harbors={HARBORS}
        origin={null}
        destination={null}
        onPickOrigin={vi.fn()}
        onPickDestination={vi.fn()}
        onImportRoute={vi.fn()}
        onRequestMapTap={vi.fn()}
        viaPoints={[]}
        onRemoveVia={vi.fn()}
        onReorderVia={vi.fn()}
        // #829: keyboard-reachable coordinate entry — not exercised here,
        // just satisfying the two new required props.
        onAddVia={vi.fn()}
        onUpdateVia={vi.fn()}
        onSelectSavedWaypoint={vi.fn()}
        departureMs={DEPARTURE_MS}
        onDepartureChange={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onSettingsChange={vi.fn()}
        boat={boatById(DEFAULT_BOAT_ID)}
        canPlan={true}
        planDisabledReason={null}
        online={true}
        onPlan={vi.fn()}
        planning={{ phase: 'idle' } as PlannerStatus}
        plan={nonRelaxedPlan()}
        rig="genoa"
        formDirty={false}
        onViewDetails={vi.fn()}
        onOpenBoatSettings={vi.fn()}
      />
    </I18nProvider>,
  );
  // Settle useNavMask's async load: its effect calls the mocked
  // loadRoutingAssets, whose already-resolved promise needs a microtask flush
  // plus the setState it schedules. Deliberately NOT gated on
  // `expect(mockedLoad).toHaveBeenCalled()` — MEASURED: with the
  // MarginalDepthNotice mount deleted from PlannerPanel.tsx, nothing in this
  // subtree calls useNavMask at all, so such a gate fails FIRST with
  // "expected vi.fn() to be called at least once", naming the mock instead of
  // the missing notice. The rows below then carry the real diagnostic.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {});
  return container;
}

beforeEach(() => {
  mockedLoad.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('#612: PlannerPanel mounts the marginal-depth notice', () => {
  it('renders the quiet line with its measured FIGURE on the Ergebnis strip', async () => {
    mockedLoad.mockResolvedValue(marginalMask());
    const container = await renderPanelWithPlan();
    const notice = container.querySelector('.marginal-depth-notice');
    expect(notice).not.toBeNull();
    // The VALUE, not merely that a key resolved.
    expect(notice?.textContent).toContain(
      '3.0 nm of this route crosses water that a more cautious reading of the charted depth data puts below your safety depth of 3.0 m.',
    );
    // Quiet by default: no assertive live region on this surface either.
    expect(notice?.getAttribute('role')).toBeNull();
  });

  it('renders NOTHING when the route touches no marginal cell — with a discriminating control', async () => {
    mockedLoad.mockResolvedValue(deepMask());
    const absent = await renderPanelWithPlan();
    expect(absent.querySelector('.marginal-depth-notice')).toBeNull();
    expect(absent.textContent).not.toContain('a more cautious reading');
    expect(absent.textContent).not.toContain('nm of this route crosses');

    // THE CONTROL — an absence assertion carries no information until the
    // evidence-generating process is shown to run on this surface too. One
    // input changes (the mask); the construction is otherwise identical.
    cleanup();
    mockedLoad.mockResolvedValue(marginalMask());
    const present = await renderPanelWithPlan();
    const revived = present.querySelector('.marginal-depth-notice');
    // Non-null FIRST, so a control that silently stops rendering reports the
    // missing element rather than an "undefined and string" argument error.
    expect(revived, 'control: a marginal mask must make the notice render').not.toBeNull();
    expect(revived?.textContent).toContain('3.0 nm');
  });
});
