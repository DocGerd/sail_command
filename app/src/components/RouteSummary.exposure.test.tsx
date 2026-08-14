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

// #516 increment 2: a SINGLE shallow cell at col 55 — its centre sits
// ~1665 m from snappedOrigin (START, col 50.3), inside APPROACH_RADIUS_M
// (1852 m); see shallowExposure.test.ts's own precondition-derived geometry
// for the same row/column arithmetic. `shallowMask()` above (cols 55-57)
// is NOT confined as a whole — cols 56/57 sit past the radius from both
// snappedOrigin and snappedDestination — which is why it needs this
// narrower, single-cell sibling to exercise the CONFIRMED case.
function confinedShallowMask() {
  return assetsWithMask(
    (row, col) => (row === ROW && col === 55 ? 20 /* 2.0 m */ : 200) /* 20 m */,
  );
}

// A single shallow cell at col 57 — ~2305 m from snappedOrigin and
// ~4226 m from snappedDestination (END, col 70.7), past APPROACH_RADIUS_M
// from either.
function unconfinedShallowMask() {
  return assetsWithMask(
    (row, col) => (row === ROW && col === 57 ? 20 /* 2.0 m */ : 200) /* 20 m */,
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
      sailIds: ['genoa', 'fock'],
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
            legs,
            etaMs: DEPARTURE_MS + 3_600_000,
            durationMs: 3_600_000,
            distanceNm: legs[0]?.distanceNm ?? 0,
            maneuverCount: 0,
            motorDistanceNm: legs[0]?.distanceNm ?? 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: 'unreachable' },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      shallow: { requestedDepthM: 3.0, usedDepthM, minGateDepthM: 2.0 },
      snappedOrigin: START,
      snappedDestination: END,
    },
  };
}

// #516 item 5: the remedy is wide-layout only, so most rows here need the wide
// branch. jsdom leaves `window.matchMedia` undefined and lib/useWideLayout.ts
// treats that absence as NARROW — same stub + same afterEach delete as
// ScaleBar.test.tsx, so a wide row cannot leak into the next test.
function setWideLayout(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
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
  // Wide by default: the exposure FIGURE renders at every width, so most rows
  // here are about the figure and only the narrow row below is about the
  // remedy's own layout gate.
  setWideLayout(true);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  // @ts-expect-error -- restore the untouched jsdom default (no matchMedia),
  // which lib/useWideLayout.ts reads as the narrow layout.
  delete window.matchMedia;
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

  it('omits the exposure, confinement and remedy sentences when the mask has loaded and the measured exposure is exactly zero', async () => {
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
    // #516 increment 2: the vacuous-true path, and the ONLY row that reaches
    // it. shallowConfinedWithinM returns TRUE here because no shallow cell is
    // ever visited to fail the check, so showConfined's `exposureDist !== null`
    // term is the only thing suppressing a confinement claim about an exposure
    // this banner does not state. Measured: dropping that term leaves the rest
    // of RouteSummary + PlannerPanel (119 tests) entirely green.
    expect(detail?.textContent).not.toContain('Every stretch below your safety depth');
  });

  it('drops the remedy on a narrow layout — everything else renders at both widths', async () => {
    // #516 item 5: a real-browser pass on 2026-08-13 measured the German
    // banner overrunning the panel viewport at 390x844, so the remedy is
    // wide-only. Mount-gated, not CSS-hidden — it must be ABSENT from the DOM,
    // so a screen reader on narrow does not read a sentence a sighted user
    // cannot see.
    mockedLoad.mockResolvedValue(shallowMask());
    setWideLayout(false);
    const narrow = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => {
      expect(narrow.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const narrowBanners = narrow.querySelectorAll('[role="alert"].shallow-warning');
    expect(narrowBanners).toHaveLength(1);
    const narrowDetail = narrowBanners[0].querySelector('.shallow-warning__detail');
    expect(narrowBanners[0].querySelector('.shallow-warning__lead')?.textContent).toBeTruthy();
    expect(narrowBanners[0].querySelector('.shallow-warning__caveat')?.textContent).toBeTruthy();
    expect(narrowDetail?.textContent).toContain('3.0 nm of this route crosses water charted');
    expect(narrowDetail?.textContent).toContain('was not passable');
    expect(narrowDetail?.textContent).not.toContain('lower safety depth setting');

    cleanup();
    setWideLayout(true);
    const wide = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => {
      expect(wide.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const wideBanners = wide.querySelectorAll('[role="alert"].shallow-warning');
    expect(wideBanners).toHaveLength(1);
    const wideDetail = wideBanners[0].querySelector('.shallow-warning__detail');
    expect(wideBanners[0].querySelector('.shallow-warning__lead')?.textContent).toBeTruthy();
    expect(wideBanners[0].querySelector('.shallow-warning__caveat')?.textContent).toBeTruthy();
    expect(wideDetail?.textContent).toContain('3.0 nm of this route crosses water charted');
    expect(wideDetail?.textContent).toContain('was not passable');
    expect(wideDetail?.textContent).toContain('lower safety depth setting');
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

// #516 increment 2 (requires #518). Reuses this file's own mock scaffolding
// rather than app/src/components/RouteSummary.test.tsx, for the SAME reason
// increment 1 does (this file's own header comment): that suite's 42 cases
// depend on useNavMask() staying permanently null with no services/assets
// mock at all, and a module-level mock there risks every one of them.
describe('#516 increment 2: ShallowWarning confinement sentence', () => {
  it('renders the confinement sentence once every shallow cell is within APPROACH_RADIUS_M of a snapped waypoint', async () => {
    mockedLoad.mockResolvedValue(confinedShallowMask());
    const container = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => {
      expect(container.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const detail = container.querySelector('.shallow-warning__detail');
    const text = detail?.textContent ?? '';
    // APPROACH_RADIUS_M (1852 m) / 1852 = 1 exactly -> formatNm(1) = "1.0 nm".
    expect(text).toContain(
      'Every stretch below your safety depth lies within 1.0 nm of your origin, destination or waypoints.',
    );
    // Rendered right after the exposure sentence (design §6): after it, before
    // the existing mechanism sentence — never re-sequenced past either.
    expect(text.indexOf('Every stretch below your safety depth')).toBeGreaterThan(
      text.indexOf('of this route crosses water charted'),
    );
    expect(text.indexOf('Every stretch below your safety depth')).toBeLessThan(
      text.indexOf('was not passable'),
    );
  });

  it('suppresses the confinement sentence when a shallow cell falls outside APPROACH_RADIUS_M of every waypoint — never a negation', async () => {
    mockedLoad.mockResolvedValue(unconfinedShallowMask());
    const container = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => {
      expect(container.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const detail = container.querySelector('.shallow-warning__detail');
    const text = detail?.textContent ?? '';
    expect(text).not.toContain('Every stretch below your safety depth');
    // false/null suppress SILENTLY — never render a negation of the claim.
    expect(text).not.toMatch(/not.*confined|not.*within/i);
    // The exposure sentence itself is unaffected by the suppression.
    expect(text).toContain('of this route crosses water charted');
  });

  it('omits the confinement sentence alongside the exposure sentence while the mask is still loading', async () => {
    // mockedLoad left at the beforeEach default: never resolves.
    const container = await renderAndSettle([EXPOSURE_LEG]);
    const detail = container.querySelector('.shallow-warning__detail');
    expect(detail?.textContent).not.toContain('Every stretch below your safety depth');
    expect(detail?.textContent).toContain('was not passable');
  });
});
