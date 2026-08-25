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
import { boatById, DEFAULT_BOAT_ID, polarKey } from '../data/boats';
import { boatSnapshot, defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

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
    polars: {
      [polarKey(DEFAULT_BOAT_ID, 'genoa')]: TEST_POLAR,
      [polarKey(DEFAULT_BOAT_ID, 'fock')]: TEST_POLAR,
    },
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

function makePlan(
  legs: Leg[],
  usedDepthM = 2.5,
  // #539: the remedy gate reads the PLAN's boat, so a row that varies the boat
  // needs to vary exactly this and nothing else.
  boat = defaultBoatSnapshot(),
): Plan {
  return {
    id: 'plan-1',
    name: 'Exposure test plan',
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
      boat,
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

  // #539 (spec J OQ-1). The row directly above proves the remedy is
  // suppressed at `SAFETY_DEPTH_FIELD.min` — but that constant is the DEFAULT
  // boat's 2.2 m, and until #539 this gate read it for every boat. The Elan
  // Impression 444's own minimum is 2.0 m (ceil₁₀(1.90 + 0.1)), so on that
  // boat the remedy was suppressed right across usedDepthM in (2.0, 2.2] —
  // the band where lowering the setting is exactly the available action.
  //
  // Both halves use the SAME mask, the SAME leg and the SAME usedDepthM and
  // vary ONLY `request.boat`, so the difference cannot come from anything
  // else. 2.1 m is hand-picked to sit strictly inside that band: above the
  // Elan's 2.0 m minimum, at or below the Salona's 2.2 m one.
  it('#539: the remedy gate is the PLAN boat’s own field minimum, not the default boat’s', async () => {
    const IN_BAND_USED_DEPTH_M = 2.1;
    mockedLoad.mockResolvedValue(shallowMask());

    localStorage.setItem('sc-lang', 'en');
    const elanPlan = makePlan(
      [EXPOSURE_LEG],
      IN_BAND_USED_DEPTH_M,
      boatSnapshot(boatById('elan-444-piranja')),
    );
    const { container: elan } = render(
      <I18nProvider>
        <RouteSummary plan={elanPlan} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(elan.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    expect(elan.querySelector('.shallow-warning__detail')?.textContent).toContain(
      'lower safety depth setting',
    );
    cleanup();

    // Same everything, default boat: 2.1 is at or below its 2.2 m minimum, so
    // there IS no lower setting and the advice stays suppressed. This half is
    // what makes the half above a comparison rather than a bare assertion.
    //
    // PER-ASSERTION ATTRIBUTION, MEASURED 2026-08-18: the elan half is the
    // SOLE discriminator for the stale-minimum defect (reverting the gate to
    // the literal 2.2 reds this row, and deleting that one assertion makes it
    // green again). The salona half's own suppression check is what catches
    // the opposite mutation — the gate forced always-true — where it is again
    // the only red. The `toContain('of this route crosses…')` line between
    // them is defence in depth against PR #523's Blocker-1 shape (suppressing
    // the remedy must not take the measured figure with it) and is NOT
    // individually load-bearing under any mutation measured here.
    const salona = await renderAndSettle([EXPOSURE_LEG], IN_BAND_USED_DEPTH_M);
    await waitFor(() => {
      expect(salona.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const salonaDetail = salona.querySelector('.shallow-warning__detail');
    expect(salonaDetail?.textContent).toContain('of this route crosses water charted shallower');
    expect(salonaDetail?.textContent).not.toContain('lower safety depth setting');
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

// #654: a plan record saved before eb2d7ee ("feat: via-waypoint segmented
// routing", 2026-07-15) never carries `request.viaPoints` at all — the field
// didn't exist yet. `confinedWithin`'s useMemo (RouteSummary.tsx) used to
// spread and `.map()` that value unconditionally, which throws
// "TypeError: plan.request.viaPoints is not iterable" once the mask resolves
// and the memo body actually runs (on the FIRST render `mask` is still null,
// so the crash is invisible until this exact re-render). This regression
// test drives the same real component path as the confined-mask test above,
// against a plan whose `viaPoints` key is entirely absent — never merely
// `[]` — and asserts it renders IDENTICALLY to the explicit-empty-list case,
// proving the accessor's normalisation rather than just "did not throw".
describe('#654: viaPoints read through the shared accessor on an unmigrated stored plan', () => {
  it('renders the confinement sentence exactly as with an empty via list when request.viaPoints is entirely absent', async () => {
    mockedLoad.mockResolvedValue(confinedShallowMask());
    localStorage.setItem('sc-lang', 'en');
    const base = makePlan([EXPOSURE_LEG]);
    // Dropping the key IS the point of this destructure, so the binding is
    // deliberately unused — mirrors makeNonRelaxedPlan's identical pattern
    // below for `shallow`. A cast is required: PlanRequest.viaPoints is a
    // required LatLon[], so a record genuinely missing the key can only be
    // represented by stepping outside the type it violates.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { viaPoints: _dropped, ...requestWithoutViaPoints } = base.request;
    const plan = { ...base, request: requestWithoutViaPoints } as unknown as Plan;

    const { container } = render(
      <I18nProvider>
        <RouteSummary plan={plan} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(container.querySelector('.shallow-warning__detail')?.textContent).toMatch(/nm/);
    });
    const detail = container.querySelector('.shallow-warning__detail');
    const text = detail?.textContent ?? '';
    // Byte-identical to the '#516 increment 2' confined-mask assertion above
    // — an absent viaPoints key must behave exactly like an explicit `[]`.
    expect(text).toContain(
      'Every stretch below your safety depth lies within 1.0 nm of your origin, destination or waypoints.',
    );
  });
});

// ---------------------------------------------------------------------------
// #612: the quiet MARGINAL-depth notice, for a route that did NOT relax.
//
// Everything above renders off a NON-NULL `PlanResult.shallow`, which is what
// #455 found: planRoute.ts sets that field only inside its relaxation branch,
// so every test in this file (and every other test of the disclosure stack)
// hands the component the one state the defect could not occur in. These rows
// use `shallow: null` — the ordinary route — throughout.
// ---------------------------------------------------------------------------

// Cells charted 3.5 m: ABOVE the 3.0 m default gate, so the route is fully
// solver-valid and the whole `route.shallow.*` family measures 0.0 nm here
// (the MEASURED trap — #455 spike section 9 reads 0.0 nm on 67/67 non-relaxed
// plans at the bare gate). Below the 3.9 m marginal threshold, so the
// conservative walk reads them. Same row/columns as shallowMask() above, so
// the exposure arithmetic is the same independently hand-derived 3.0 nm.
function marginalMask() {
  return assetsWithMask(
    (row, col) =>
      row === ROW && (col === 55 || col === 56 || col === 57) ? 35 /* 3.5 m */ : 200 /* 20 m */,
  );
}

/**
 * A plan that did NOT relax — `shallow: null`, the state no existing test in
 * this file constructs. `safetyDepthM` is spread over DEFAULT_SETTINGS so a
 * row can vary the gate (and hence the severity condition) and nothing else.
 */
function makeNonRelaxedPlan(legs: Leg[], safetyDepthM = DEFAULT_SETTINGS.safetyDepthM): Plan {
  const base = makePlan(legs);
  // `PlanResult.shallow` is `readonly shallow?: ShallowInfo` and, under
  // exactOptionalPropertyTypes, a non-relaxed plan OMITS the key entirely —
  // it is never set to null or undefined (types.ts says so at the field).
  // So the absent state has to be built by DELETING the key, not by assigning
  // a falsy one; assigning `shallow: null` does not even typecheck, and if it
  // had, it would have hidden a production gate that read `!== null`.
  // Dropping the key IS the point of this destructure, so the binding is
  // deliberately unused. Keeps full typing (no cast), which a `delete` on a
  // Record<string, unknown> copy would have to give up.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { shallow: _dropped, ...resultWithoutShallow } = base.result;
  return {
    ...base,
    request: { ...base.request, settings: { ...DEFAULT_SETTINGS, safetyDepthM } },
    result: resultWithoutShallow,
  };
}

async function renderNonRelaxed(legs: Leg[], safetyDepthM?: number) {
  localStorage.setItem('sc-lang', 'en');
  const plan =
    safetyDepthM === undefined ? makeNonRelaxedPlan(legs) : makeNonRelaxedPlan(legs, safetyDepthM);
  const { container } = render(
    <I18nProvider>
      <RouteSummary plan={plan} rig="genoa" onRigChange={vi.fn()} />
    </I18nProvider>,
  );
  await waitFor(() => expect(mockedLoad).toHaveBeenCalled());
  await act(async () => {});
  return container;
}

describe('#612: the marginal-depth notice on a route that did not relax', () => {
  it('renders the quiet line with its measured FIGURE', async () => {
    mockedLoad.mockResolvedValue(marginalMask());
    const container = await renderNonRelaxed([EXPOSURE_LEG]);
    const notice = container.querySelector('.marginal-depth-notice');
    expect(notice).not.toBeNull();
    // The VALUE, never merely that a key resolved (#388's prose-vs-value
    // trap). 3.0 nm is shallowExposure.test.ts's own hand derivation for this
    // exact leg/column geometry, unchanged by the depth swap.
    expect(notice?.textContent).toContain(
      '3.0 nm of this route crosses water that a more cautious reading of the charted depth data puts below your safety depth of 3.0 m.',
    );
    // The banner the relaxed path renders must NOT appear — this plan has no
    // `shallow` block, and the two disclosures are complementary, never both.
    expect(container.querySelector('.shallow-warning')).toBeNull();
  });

  it('renders NOTHING at all when the route touches no marginal cell — with a discriminating control', async () => {
    // The absence half. `deepMask()` (every cell 20 m) is the ONE difference
    // from the row above: same legs, same plan, same settle sequence.
    mockedLoad.mockResolvedValue(deepMask());
    const absent = await renderNonRelaxed([EXPOSURE_LEG]);
    expect(absent.querySelector('.marginal-depth-notice')).toBeNull();
    // Not merely "no element": no zero-valued sentence either, in any of the
    // shapes a degraded render could take. Scoped to the notice's OWN
    // wording — a bare `not.toContain('0.0 nm')` over the whole card fires on
    // the sail/motor split strip's legitimate "Sailing · 0.0 nm · 0%"
    // (MEASURED: that is what this assertion caught first), which is a
    // different element saying a true thing.
    expect(absent.textContent).not.toContain('a more cautious reading');
    expect(absent.textContent).not.toContain('nm of this route crosses');

    // THE CONTROL. An absence assertion carries no information until the
    // evidence-generating process is shown to run, so change exactly one
    // input — the mask — and confirm the same construction DOES render.
    cleanup();
    mockedLoad.mockResolvedValue(marginalMask());
    const present = await renderNonRelaxed([EXPOSURE_LEG]);
    const revived = present.querySelector('.marginal-depth-notice');
    // Non-null FIRST, so a control that silently stops rendering reports the
    // missing element rather than an "undefined and string" argument error.
    expect(revived, 'control: a marginal mask must make the notice render').not.toBeNull();
    expect(revived?.textContent).toContain('3.0 nm');
  });

  it('never renders on a RELAXED route — that is the banner’s job', async () => {
    // makePlan (not makeNonRelaxedPlan) carries a non-null `shallow`, and the
    // mask is marginal, so the notice's own trigger would fire if the
    // relaxation gate were absent. Both disclosures describing one hazard in
    // two vocabularies is exactly what the #455 ruling forbids.
    mockedLoad.mockResolvedValue(marginalMask());
    const container = await renderAndSettle([EXPOSURE_LEG]);
    await waitFor(() => expect(mockedLoad).toHaveBeenCalled());
    await act(async () => {});
    expect(container.querySelector('.shallow-warning')).not.toBeNull();
    expect(container.querySelector('.marginal-depth-notice')).toBeNull();
  });

  it('is QUIET: no role="alert" and no banner treatment at a default gate', async () => {
    // The #455 ruling amendment honours its own wallpaper bar by demoting the
    // SURFACE (measured trip rate 61.5% on shipped defaults), so this element
    // must not be assertive in the ordinary case.
    mockedLoad.mockResolvedValue(marginalMask());
    const container = await renderNonRelaxed([EXPOSURE_LEG]);
    const notice = container.querySelector('.marginal-depth-notice');
    expect(notice?.getAttribute('role')).toBeNull();
    expect(notice?.className).not.toContain('marginal-depth-notice--severe');
    // And it makes NO claim about the draft in this branch — writing one
    // would read as "below-draft requires a user-lowered gate", which the
    // app's own about.caveats.depthMask contradicts.
    expect(notice?.textContent).not.toContain('draft');
    expect(notice?.textContent).not.toContain('Caution:');
  });

  it('escalates only when the gate’s own cautious floor falls under the boat’s draft', async () => {
    // gate - MASK_TOLERANCE_M < draftM. At the default boat's 2.1 m draft
    // that is 3.0 - 0.9 = 2.1, NOT below 2.1 — false at the default gate by
    // construction. 2.9 m (above this boat's 2.2 m field minimum, so a user
    // can really type it) gives 2.0 < 2.1 and fires.
    mockedLoad.mockResolvedValue(marginalMask());
    const container = await renderNonRelaxed([EXPOSURE_LEG], 2.9);
    const notice = container.querySelector('.marginal-depth-notice');
    expect(notice?.className).toContain('marginal-depth-notice--severe');
    expect(notice?.getAttribute('role')).toBe('alert');
    const text = notice?.textContent ?? '';
    expect(text).toContain('Caution: 3.0 nm of this route crosses water');
    expect(text).toContain('safety depth of 2.9 m');
    // Names the SETTING as the condition, never a general claim about drafts.
    expect(text).toContain("at this setting that reading can fall below this boat's 2.1 m draft");
  });

  it('never borrows the relaxed copy, which is false on this route in both clauses', async () => {
    // route.shallow.detail says the requested depth "was not passable, so
    // this route was planned at a reduced X m instead" — nothing was reduced.
    // route.shallow.exposure measures charted-below-gate distance, which is
    // 0 here by construction. Both are false, in both languages.
    mockedLoad.mockResolvedValue(marginalMask());
    const container = await renderNonRelaxed([EXPOSURE_LEG]);
    expect(container.textContent).not.toContain('was not passable');
    expect(container.textContent).not.toContain('crosses water charted shallower');
    expect(container.textContent).not.toContain('A lower safety depth setting');
  });

  it('omits the line while the mask is still loading — no fallback number', async () => {
    // mockedLoad left at the beforeEach default: never resolves. Same
    // contract as ShallowWarning's own exposure figure.
    localStorage.setItem('sc-lang', 'en');
    const { container } = render(
      <I18nProvider>
        <RouteSummary plan={makeNonRelaxedPlan([EXPOSURE_LEG])} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(container.querySelector('.marginal-depth-notice')).toBeNull();
  });

  it('does not crash on a stored plan whose request has no settings at all (#551/#624)', async () => {
    // CROSS-PR COMPOSITION regression, invisible against this branch's own
    // base: #624 (#551) landed after it and established that
    // `migratePlan.ts` never validates `request.settings`, so such a record
    // migrates NON-NULL and any bare `settings.safetyDepthM` read throws.
    // With no error boundary anywhere in app/src that blanks the whole app.
    // Pinned HERE rather than relying on App.test.tsx's own #551 row, which
    // lives in a different file and could pass while this component is the
    // thing throwing.
    mockedLoad.mockResolvedValue(marginalMask());
    localStorage.setItem('sc-lang', 'en');
    const base = makeNonRelaxedPlan([EXPOSURE_LEG]);
    // `settings` is REQUIRED on PlanRequest, so the stored-record shape this
    // guards against has to be built by dropping the key — the same reason
    // makeNonRelaxedPlan above drops `shallow`.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { settings: _dropped, ...requestWithoutSettings } = base.request;
    const plan = { ...base, request: requestWithoutSettings } as unknown as Plan;
    const { container } = render(
      <I18nProvider>
        <RouteSummary plan={plan} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(mockedLoad).toHaveBeenCalled());
    await act(async () => {});
    // Not merely "did not throw": it falls back to DEFAULT_SETTINGS and still
    // states a real gate, so the notice degrades to correct rather than to a
    // "safety depth of NaN m" sentence — the failure mode `Number.isFinite`
    // closes that a `typeof === 'number'` check or an object spread would not.
    const notice = container.querySelector('.marginal-depth-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      `safety depth of ${DEFAULT_SETTINGS.safetyDepthM.toFixed(1)} m`,
    );
    expect(notice?.textContent).not.toContain('NaN');
  });

  it('renders the German copy with a German number', async () => {
    // The de/en pair is what makes a mixed-language announcement impossible
    // to ship unnoticed — formatNm is locale-aware (#525), so the DE figure
    // must read "3,0 nm", never "3.0 nm".
    localStorage.setItem('sc-lang', 'de');
    mockedLoad.mockResolvedValue(marginalMask());
    const { container } = render(
      <I18nProvider>
        <RouteSummary plan={makeNonRelaxedPlan([EXPOSURE_LEG])} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(mockedLoad).toHaveBeenCalled());
    await act(async () => {});
    const notice = container.querySelector('.marginal-depth-notice');
    expect(notice?.textContent).toContain(
      '3,0 nm dieser Route verlaufen durch Wasser, das eine vorsichtigere Lesart der Kartentiefen unter die eingestellte Sicherheitstiefe von 3.0 m setzt.',
    );
  });
});
