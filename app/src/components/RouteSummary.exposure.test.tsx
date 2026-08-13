// #516 increment 1: RouteSummary's ShallowWarning exposure sentence — its own
// file (repo precedent: PlannerPanel.dst.test.tsx, planRoute.shallow.test.ts)
// rather than an addition to the large, UNMOCKED RouteSummary.test.tsx, whose
// 42 existing cases depend on `useNavMask()` staying permanently null with no
// services/assets mock at all. Adding a module-level mock there — even one
// only CONFIGURED by a subset of tests — risks every other case: an
// unconfigured `vi.fn()` factory returns `undefined` from
// `loadRoutingAssets()`, and `undefined.then(...)` throws synchronously
// inside useNavMask's effect. This file owns its own mock end to end instead.
import { act, render, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { TEST_MASK_META, TEST_POLAR } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg, type Plan } from '../types';

vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
import { loadRoutingAssets } from '../services/assets';
import { SAFETY_DEPTH_FIELD } from './OptionsPanel';
import RouteSummary from './RouteSummary';

const mockedLoad = vi.mocked(loadRoutingAssets);

const CELL_LAT = (TEST_MASK_META.north - TEST_MASK_META.south) / TEST_MASK_META.rows;
const CELL_LON = (TEST_MASK_META.east - TEST_MASK_META.west) / TEST_MASK_META.cols;

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
    polarGenoa: TEST_POLAR,
    polarFock: TEST_POLAR,
    harbors: [],
    seamarks: { type: 'FeatureCollection' as const, features: [] },
  };
}

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
const ROW = 100;
// Same geometry as shallowExposure.test.ts's own "hand-derived value" case:
// a pure-longitude leg from grid-x 50.3 to 70.7 (never on a cell boundary),
// columns 55/56/57 charted shallow (2.0 m, below the 3.0 m requestedDepthM
// below), everything else 20 m. distanceNm is set to the leg's own grid-x
// span so the exposure fraction (3 shallow columns / span) times distanceNm
// resolves to almost exactly 3.0 nm — verified against the unit test's own
// independent hand derivation, not re-derived here.
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

function shallowMask() {
  return assetsWithMask(
    (row, col) =>
      row === ROW && (col === 55 || col === 56 || col === 57) ? 20 /* 2.0 m */ : 200 /* 20 m */,
  );
}

// Every cell 20 m — the SAME leg then measures an exposure of exactly 0
// against a fully loaded mask (PR #523 review, Blocker 1). Reachable in
// production two ways: `shallow` folds over BOTH rigs' legs while the walk
// uses only the ACTIVE rig's, and the walk uses the currently-loaded mask
// rather than the one the plan was routed against.
function deepMask() {
  return assetsWithMask(() => 200 /* 20 m */);
}

function makePlan(legs: Leg[], usedDepthM = 2.5): Plan {
  return {
    id: 'plan-1',
    name: 'Exposure test plan',
    createdAtMs: DEPARTURE_MS,
    request: {
      origin: START,
      destination: END,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
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
      genoa: {
        rig: 'genoa',
        legs,
        etaMs: DEPARTURE_MS + 3_600_000,
        durationMs: 3_600_000,
        distanceNm: legs[0]?.distanceNm ?? 0,
        maneuverCount: 0,
        motorDistanceNm: legs[0]?.distanceNm ?? 0,
      },
      fock: null,
      genoaReason: null,
      fockReason: 'unreachable',
      recommended: 'genoa',
      shallow: { requestedDepthM: 3.0, usedDepthM, minGateDepthM: 2.0 },
      snappedOrigin: START,
      snappedDestination: END,
    },
  };
}

async function renderAndSettle(legs: Leg[], usedDepthM?: number) {
  localStorage.setItem('sc-lang', 'en');
  const plan = usedDepthM === undefined ? makePlan(legs) : makePlan(legs, usedDepthM);
  const { container } = render(
    <I18nProvider>
      <RouteSummary plan={plan} rig="genoa" onRigChange={vi.fn()} />
    </I18nProvider>,
  );
  return container;
}

beforeEach(() => {
  // Default: a promise that never settles — matches the pre-#516 unmocked
  // behaviour (mask stays null forever) for any test that doesn't opt in to
  // a resolved mask, so this file's own tests don't need boilerplate in the
  // common "no mask yet" case.
  mockedLoad.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('#516: ShallowWarning exposure sentence', () => {
  it('renders the rendered NUMBER (never just that a key resolved) once the mask loads', async () => {
    mockedLoad.mockResolvedValue(shallowMask());
    const container = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => {
      expect(container.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const detail = container.querySelector('.shallow-warning__detail');
    // Hand-verified in shallowExposure.test.ts's own independent derivation:
    // this exact leg/mask geometry yields ~3.0 nm, which formatNm renders as
    // "3.0 nm" (toFixed(1)). Asserting the VALUE, not that SOME sentence
    // rendered — the #388 prose-vs-value trap.
    expect(detail?.textContent).toContain('3.0 nm of this route crosses water charted shallower');
    expect(detail?.textContent).toContain('safety depth of 3.0 m');
    // The remedy line is paired with it (same gating condition) — always
    // appears alongside the exposure figure, never alone.
    const text = detail?.textContent ?? '';
    expect(text).toContain(
      'A lower safety depth setting might let the planner find a more direct route.',
    );
    // PR #523 review, Minor 3: the remedy must follow the mechanism sentence
    // that justifies it, never precede it.
    expect(text.indexOf('A lower safety depth setting')).toBeGreaterThan(
      text.indexOf('was not passable'),
    );
  });

  it('omits the exposure sentence while the mask is still loading — lead/detail/caveat still render', async () => {
    // mockedLoad left at the beforeEach default: never resolves.
    const container = await renderAndSettle([EXPOSURE_LEG]);
    const banner = container.querySelector('.shallow-warning');
    expect(banner).not.toBeNull();
    const lead = banner?.querySelector('.shallow-warning__lead');
    const detail = banner?.querySelector('.shallow-warning__detail');
    const caveat = banner?.querySelector('.shallow-warning__caveat');
    expect(lead?.textContent).toBeTruthy();
    expect(detail?.textContent).toBeTruthy();
    expect(caveat?.textContent).toBeTruthy();
    expect(detail?.textContent).not.toContain('of this route crosses');
    expect(detail?.textContent).not.toContain('lower safety depth setting');
    // The pre-existing "what happened" mechanism sentence is unaffected.
    expect(detail?.textContent).toContain('was not passable');
  });

  it('omits the exposure sentence when the mask load fails outright — no fallback number', async () => {
    mockedLoad.mockRejectedValue(new Error('network unavailable'));
    const container = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => {
      // useNavMask's own catch path resolves before this — give it a tick.
      expect(mockedLoad).toHaveBeenCalled();
    });
    const detail = container.querySelector('.shallow-warning__detail');
    expect(detail?.textContent).not.toContain('of this route crosses');
    expect(detail?.textContent).toContain('was not passable');
  });

  it('omits BOTH sentences when the mask has loaded and the measured exposure is exactly zero', async () => {
    // PR #523 review, Blocker 1. The mask here RESOLVES — the distinguishing
    // condition against the three rows around it is that the walk really ran
    // and returned 0, not that it never ran. "0.0 nm of this route crosses
    // shallow water" plus "try lowering your safety depth" is wrong on both
    // halves; the banner must degrade to lead + detail + caveat, the same
    // fail-safe shape firstShallowLeg already uses for the locator.
    mockedLoad.mockResolvedValue(deepMask());
    const container = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => expect(mockedLoad).toHaveBeenCalled());
    await act(async () => {});
    const banner = container.querySelector('.shallow-warning');
    const detail = container.querySelector('.shallow-warning__detail');
    expect(banner?.querySelector('.shallow-warning__lead')?.textContent).toBeTruthy();
    expect(banner?.querySelector('.shallow-warning__caveat')?.textContent).toBeTruthy();
    expect(detail?.textContent).toContain('was not passable');
    expect(detail?.textContent).not.toContain('of this route crosses');
    expect(detail?.textContent).not.toContain('lower safety depth setting');
    // Not merely "no sentence": the formatted zero itself must never appear.
    expect(detail?.textContent).not.toContain('0.0 nm');
  });

  it('keeps the figure but drops the remedy when no selectable safety depth is lower', async () => {
    // PR #523 review, Minor 5. SAFETY_DEPTH_FIELD clamps the user's input to
    // >= its own min, so at a usedDepthM equal to that min every value they
    // can choose is at or above the gate already used and "lower your safety
    // depth" cannot be acted on. Only the advice is suppressed — the measured
    // figure is still true and still renders.
    mockedLoad.mockResolvedValue(shallowMask());
    const container = await renderAndSettle([EXPOSURE_LEG], SAFETY_DEPTH_FIELD.min);
    await waitFor(() => {
      expect(container.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const detail = container.querySelector('.shallow-warning__detail');
    expect(detail?.textContent).toContain('3.0 nm of this route crosses water charted shallower');
    expect(detail?.textContent).not.toContain('lower safety depth setting');
  });

  it('omits the exposure sentence when the active rig has no legs at all', async () => {
    mockedLoad.mockResolvedValue(shallowMask());
    const container = await renderAndSettle([]);
    await waitFor(() => expect(mockedLoad).toHaveBeenCalled());
    const detail = container.querySelector('.shallow-warning__detail');
    expect(detail?.textContent).not.toContain('of this route crosses');
  });
});
