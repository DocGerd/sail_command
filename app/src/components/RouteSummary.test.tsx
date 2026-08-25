import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/dict.en';
import { de } from '../i18n/dict.de';
import { uniformWindGrid } from '../test/fixtures';
import { formatDateTime, formatTime } from '../lib/format';
import { MASK_TOLERANCE_M } from '../lib/mask';
import { BOAT_DRAFT_M } from '../routing/relaxedDepth';
import {
  DEFAULT_SETTINGS,
  type Leg,
  type Plan,
  type RigRecommendation,
  type RigResult,
  type SailId,
  type SailResult,
} from '../types';
import RouteSummary from './RouteSummary';
import { boatSnapshot, defaultBoatSnapshot } from '../types';
import { boatById } from '../data/boats';
import { PLAN_SCHEMA_VERSION } from '../types';

// #54: the pre-#54 shape exposed `plan.result.genoa`/`.fock`/`.fockReason`
// etc. as directly-mutable fields; the `sails` list's own entries are now
// `readonly`, so a test that used to write `plan.result.genoa = X` instead
// REPLACES the whole `result` object (Plan.result itself is not readonly —
// only PlanResultOk's own fields are) with a new `sails` array.
function setSail(plan: Plan, sailId: SailId, patch: Partial<SailResult>): void {
  plan.result = {
    ...plan.result,
    sails: plan.result.sails.map((s) => (s.sailId === sailId ? { ...s, ...patch } : s)),
  };
}

const FETCHED_AT_MS = Date.UTC(2026, 6, 15, 6, 0, 0);
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0); // 2h after fetch: not stale

const GENOA_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.8, lon: 10.0 },
    startTimeMs: DEPARTURE_MS,
    endTimeMs: DEPARTURE_MS + 2 * 3_600_000,
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
    startTimeMs: DEPARTURE_MS + 2 * 3_600_000,
    endTimeMs: DEPARTURE_MS + 4 * 3_600_000,
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
    startTimeMs: DEPARTURE_MS + 4 * 3_600_000,
    endTimeMs: DEPARTURE_MS + 5 * 3_600_000,
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
  etaMs: DEPARTURE_MS + 5 * 3_600_000,
  durationMs: 5 * 3_600_000,
  distanceNm: 21.5,
  maneuverCount: 1,
  motorDistanceNm: 5,
  legs: GENOA_LEGS,
};

const FOCK_RESULT: RigResult = {
  sailId: 'fock',
  etaMs: DEPARTURE_MS + 6 * 3_600_000,
  durationMs: 6 * 3_600_000,
  distanceNm: 22.0,
  maneuverCount: 0,
  motorDistanceNm: 0,
  legs: [
    {
      kind: 'sail',
      board: 'starboard',
      start: { lat: 54.79, lon: 9.43 },
      end: { lat: 54.85, lon: 10.52 },
      startTimeMs: DEPARTURE_MS,
      endTimeMs: DEPARTURE_MS + 6 * 3_600_000,
      headingDeg: 85,
      twaDeg: 95,
      twsKn: 9,
      speedKn: 5.5,
      distanceNm: 22,
      maneuverAtStart: null,
    },
  ],
};

function makePlan(
  overrides: {
    departureMs?: number;
    recommended?: SailId;
    // #259: omitted by default so most tests exercise rigRecommendationOf's
    // fallback (absent field -> `{ kind: 'decided', rig: recommended }`),
    // matching every pre-#259 PlanResultOk literal elsewhere in the suite.
    rigRecommendation?: RigRecommendation;
    // #540: defaults to true (every pre-existing test's assumption); pass
    // false to exercise the budget-truncated disclosure path.
    comparisonComplete?: boolean;
  } = {},
): Plan {
  return {
    id: 'plan-1',
    name: 'Flensburg to Marstal',
    createdAtMs: FETCHED_AT_MS,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.52 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: overrides.departureMs ?? DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: FETCHED_AT_MS },
    result: {
      status: 'ok',
      sails: [
        { sailId: 'genoa', result: GENOA_RESULT, reason: null },
        { sailId: 'fock', result: FOCK_RESULT, reason: null },
      ],
      recommended: overrides.recommended ?? 'genoa',
      comparisonComplete: overrides.comparisonComplete ?? true,
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.52 },
      ...(overrides.rigRecommendation ? { rigRecommendation: overrides.rigRecommendation } : {}),
    },
  };
}

function renderSummary(
  overrides: { plan?: Plan; rig?: SailId; onRigChange?: (r: SailId) => void } = {},
): { plan: Plan; rig: SailId; onRigChange: (r: SailId) => void; container: HTMLElement } {
  localStorage.setItem('sc-lang', 'en');
  const plan = overrides.plan ?? makePlan();
  const rig = overrides.rig ?? 'genoa';
  const onRigChange = overrides.onRigChange ?? vi.fn();
  const { container } = render(
    <I18nProvider>
      <RouteSummary plan={plan} rig={rig} onRigChange={onRigChange} />
    </I18nProvider>,
  );
  return { plan, rig, onRigChange, container };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('RouteSummary', () => {
  it('wraps the results in an Ergebnis card whose heading is a focus target', () => {
    const { container } = renderSummary();
    const heading = container.querySelector('.route-ergebnis > .sc-card-title') as HTMLElement;
    expect(heading).not.toBeNull();
    expect(heading.textContent).toBe('Result');
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  // #54 review: `SailId` is a catalogue-derived union at COMPILE time and an
  // open-world value at REST — services/migratePlan.ts mints it from
  // unvalidated stored strings by design, and
  // migratePlan.catalogueRename.test.ts pins that a renamed catalogue must
  // still READ an existing plan. Indexing the label map directly with such an
  // id yielded `undefined`, and `useT` is a bare `dicts[lang][key]` lookup
  // with no fallback and no throw: the rig tab and the per-leg sail chip
  // rendered an EMPTY accessible name, and the recommendation chip rendered
  // the literal string 'Faster: undefined'.
  it('#54: names a stored sail the catalogue no longer knows, never rendering "undefined"', () => {
    const gone = 'code0' as SailId;
    const plan = makePlan();
    plan.result = {
      ...plan.result,
      sails: [{ sailId: gone, result: { ...GENOA_RESULT, sailId: gone }, reason: null }],
      recommended: gone,
    };
    const { container } = renderSummary({ plan, rig: gone });

    // The interpolated site: `String(undefined)` is what got substituted.
    expect(container.textContent).toContain(`Faster: ${en['route.rig.unknown']}`);
    // The bare-lookup sites: an empty accessible name is invisible to
    // `toContain`, so assert the tab's own name directly.
    expect(screen.getByRole('tab').textContent).toContain(en['route.rig.unknown']);
    // Belt and braces across every surface this card renders.
    expect(container.textContent).not.toContain('undefined');
  });

  it('shows a ★ badge on the recommended tab and not on the other', () => {
    renderSummary({ rig: 'genoa' });
    const genoaTab = screen.getByRole('tab', { name: /Genoa/ });
    const fockTab = screen.getByRole('tab', { name: /Fock/ });
    expect(within(genoaTab).getByLabelText('Recommended')).toBeInTheDocument();
    expect(within(fockTab).queryByLabelText('Recommended')).not.toBeInTheDocument();
  });

  it('keeps the rig tablist named "Rig comparison" with exactly one ★', () => {
    renderSummary();
    const tablist = screen.getByRole('tablist', { name: 'Rig comparison' });
    expect(within(tablist).getAllByLabelText('Recommended')).toHaveLength(1);
  });

  it('renders an additive faster-rig chip for the recommended rig', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Faster: Genoa')).toBeInTheDocument();
  });

  it('#259: a tie comparison shows neither ★ and an honest tie chip instead of "Faster"', () => {
    const plan = makePlan({ rigRecommendation: { kind: 'tie' } });
    renderSummary({ plan, rig: 'genoa' });
    const tablist = screen.getByRole('tablist', { name: 'Rig comparison' });
    expect(within(tablist).queryAllByLabelText('Recommended')).toHaveLength(0);
    expect(
      screen.getByText('Genoa and Fock are effectively tied for this passage'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Faster:/)).not.toBeInTheDocument();
  });

  // #578: NON-VACUOUS against the real hazard — a fixture whose compared
  // sail ids are NOT genoa/fock. A hardcoded "Genoa and Fock are
  // effectively tied..." string would still pass every OTHER test in this
  // file (the default fixture always uses genoa/fock), so this is the one
  // row that would catch a regression back to the literal. `code0` mirrors
  // the existing "#54: names a stored sail the catalogue no longer knows"
  // row's own `'code0' as SailId` cast above — a stored/future sail id
  // outside today's catalogue. Mixing ONE known id (genoa) with ONE unknown
  // one, rather than two unknowns, proves PER-ID resolution: a component
  // that fell back to some other static pair (or swapped in a generic
  // placeholder for BOTH slots) would not produce this exact combination.
  it('#578: a tie chip names the PLAN’s own compared sails, never the hardcoded "Genoa and Fock"', () => {
    const unknown = 'code0' as SailId;
    const plan = makePlan({ rigRecommendation: { kind: 'tie' } });
    plan.result = {
      ...plan.result,
      sails: [
        { sailId: 'genoa', result: GENOA_RESULT, reason: null },
        { sailId: unknown, result: { ...GENOA_RESULT, sailId: unknown }, reason: null },
      ],
    };
    renderSummary({ plan, rig: 'genoa' });
    expect(
      screen.getByText(
        `Genoa and ${en['route.rig.unknown']} are effectively tied for this passage`,
      ),
    ).toBeInTheDocument();
    // The hardcoded literal must never appear for THIS fixture.
    expect(screen.queryByText(/Genoa and Fock/)).not.toBeInTheDocument();
  });

  // #578 review Minor 5: the FALLBACK path specifically — a `tie` verdict
  // whose sailIds has only ONE usable entry. `assemble()`'s own guard (see
  // tiedSailIds' doc comment, lib/resultSummary.ts) means a FRESHLY SOLVED
  // plan cannot reach this branch — the #578 row above tests that real
  // two-sail path. #578 review Minor C found the guard says nothing about
  // a plan loaded from STORAGE: migratePlan.ts passes a stored
  // rigRecommendation through with a bare cast, uncorrelated with the
  // stored sails array's length. #578 review Minor E: this fixture, built
  // the same way as this file's own "#54: names a stored sail the
  // catalogue no longer knows" row above, pins a branch reachable from a
  // stored record: nothing in the current code writes one (assemble()
  // won't), but nothing at the read boundary rejects one either. The
  // worrying door is shut, though — migrateSails fails closed on a
  // damaged sail, so "two stored, one dropped on read" cannot happen; what
  // remains is a hand-edited or corrupted store, a foreign writer, or a
  // future build.
  //
  // Restoring the fallback to `sailIds[1] ?? sailIds[0]` renders "Genoa and
  // Genoa are effectively tied" — a self-tie that reads as a genuine
  // result rather than a degraded one. MEASURED (review round 2, Minor D):
  // under that mutation the row reds at the PRESENCE assertion below —
  // `getByText` cannot find the exact sentence naming "Unknown sail",
  // because the render is "Genoa and Genoa ..." instead — so the ABSENCE
  // assertion never even runs; deleting either assertion alone still reds
  // the row. Both stay as belt-and-braces on a copy defect that reads as a
  // real result: the presence check pins the whole honest sentence, and
  // the absence check names the exact hazard (a duplicated sail name)
  // explicitly, independent of what the correct sentence happens to say.
  it('#578 review Minor 5: a tie verdict with only ONE usable sail id renders the honest fallback, never a self-tie', () => {
    const plan = makePlan({ rigRecommendation: { kind: 'tie' } });
    plan.result = {
      ...plan.result,
      sails: [{ sailId: 'genoa', result: GENOA_RESULT, reason: null }],
    };
    renderSummary({ plan, rig: 'genoa' });
    expect(
      screen.getByText(
        `Genoa and ${en['route.rig.unknown']} are effectively tied for this passage`,
      ),
    ).toBeInTheDocument();
    // Names the exact hazard (a duplicated sail name) explicitly — see the
    // block comment above for why this is kept alongside the presence
    // check rather than instead of it.
    expect(screen.queryByText(/Genoa and Genoa/)).not.toBeInTheDocument();
  });

  it('#259: a moot comparison (all-motor) shows neither ★ and an honest moot chip', () => {
    const plan = makePlan({ rigRecommendation: { kind: 'moot' } });
    renderSummary({ plan, rig: 'fock' });
    const tablist = screen.getByRole('tablist', { name: 'Rig comparison' });
    expect(within(tablist).queryAllByLabelText('Recommended')).toHaveLength(0);
    expect(
      screen.getByText('Rig does not matter here — this passage runs entirely under engine'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Faster:/)).not.toBeInTheDocument();
  });

  it('#553: a not-compared verdict shows neither ★ and says no comparison happened', () => {
    const plan = makePlan({ rigRecommendation: { kind: 'not-compared' } });
    renderSummary({ plan, rig: 'genoa' });
    const tablist = screen.getByRole('tablist', { name: 'Rig comparison' });
    expect(within(tablist).queryAllByLabelText('Recommended')).toHaveLength(0);
    expect(
      screen.getByText('The sails were not compared for this passage, so no faster rig is claimed'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Faster:/)).not.toBeInTheDocument();
  });

  // #540 spec §E.3: same 'not-compared' verdict as the row above, but the
  // DISCRIMINATING control (comparisonComplete: false) — the budget-specific
  // sentence must render INSTEAD of the generic rigNotCompared one, never
  // both, never neither.
  it('#540: a not-compared verdict with comparisonComplete false shows the budget-truncated sentence, not the generic one', () => {
    const plan = makePlan({
      rigRecommendation: { kind: 'not-compared' },
      comparisonComplete: false,
    });
    renderSummary({ plan, rig: 'genoa' });
    const tablist = screen.getByRole('tablist', { name: 'Rig comparison' });
    expect(within(tablist).queryAllByLabelText('Recommended')).toHaveLength(0);
    expect(
      screen.getByText(
        'The search ran out of time before comparing both sails, so no faster rig is claimed',
      ),
    ).toBeInTheDocument();
    // The generic sentence must NOT also render.
    expect(
      screen.queryByText(
        'The sails were not compared for this passage, so no faster rig is claimed',
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Faster:/)).not.toBeInTheDocument();
  });

  // #540: the N=1 / N>=3 / tier-C-suppressed / one-sail-failed cases all
  // report comparisonComplete: true (only budget exhaustion sets it false),
  // so the budget-specific sentence must NOT render for an ordinary
  // not-compared verdict — pinned explicitly rather than relying on the
  // #553 row above staying green by coincidence.
  it('#540: a not-compared verdict with comparisonComplete true (the default) never shows the budget-truncated sentence', () => {
    const plan = makePlan({ rigRecommendation: { kind: 'not-compared' } });
    renderSummary({ plan, rig: 'genoa' });
    expect(
      screen.queryByText(
        'The search ran out of time before comparing both sails, so no faster rig is claimed',
      ),
    ).not.toBeInTheDocument();
  });

  // Discriminating control the other direction: 'tie'/'moot' must ignore
  // comparisonComplete entirely — resultVerdictKey only special-cases
  // 'not-compared'.
  it('#540: comparisonComplete false does not affect a tie verdict', () => {
    const plan = makePlan({ rigRecommendation: { kind: 'tie' }, comparisonComplete: false });
    renderSummary({ plan, rig: 'genoa' });
    expect(
      screen.getByText('Genoa and Fock are effectively tied for this passage'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'The search ran out of time before comparing both sails, so no faster rig is claimed',
      ),
    ).not.toBeInTheDocument();
  });

  it('#259: a decided comparison for fock badges the fock tab, not genoa', () => {
    const plan = makePlan({
      recommended: 'fock',
      rigRecommendation: { kind: 'decided', rig: 'fock' },
    });
    renderSummary({ plan, rig: 'genoa' });
    const genoaTab = screen.getByRole('tab', { name: /Genoa/ });
    const fockTab = screen.getByRole('tab', { name: /Fock/ });
    expect(within(fockTab).getByLabelText('Recommended')).toBeInTheDocument();
    expect(within(genoaTab).queryByLabelText('Recommended')).not.toBeInTheDocument();
    expect(screen.getByText('Faster: Fock')).toBeInTheDocument();
  });

  it('clicking a non-active tab calls onRigChange with that rig', () => {
    const { onRigChange } = renderSummary({ rig: 'genoa' });
    fireEvent.click(screen.getByRole('tab', { name: /Fock/ }));
    expect(onRigChange).toHaveBeenCalledWith('fock');
  });

  it('clicking the already-active tab does not call onRigChange', () => {
    const { onRigChange } = renderSummary({ rig: 'genoa' });
    fireEvent.click(screen.getByRole('tab', { name: /Genoa/ }));
    expect(onRigChange).not.toHaveBeenCalled();
  });

  it('renders the stat grid with hand-derived distance, duration and avg speed', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const stats = container.querySelector('.ergebnis-stats') as HTMLElement;
    expect(stats).not.toBeNull();
    // 21.5 nm over 5 h = 4.3 kn (hand-derived).
    expect(within(stats).getByText('21.5 nm')).toBeInTheDocument();
    expect(within(stats).getByText('5 h 00 min')).toBeInTheDocument();
    expect(within(stats).getByText('4.3 kn')).toBeInTheDocument();
    // Arrival delegates to formatDateTime (separately tested; TZ-independent
    // because both sides format the same instant with the same locale).
    expect(within(stats).getByText(formatDateTime(GENOA_RESULT.etaMs, 'en'))).toBeInTheDocument();
  });

  it('keeps maneuver count as a secondary stat', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const maneuvers = container.querySelector('.ergebnis-maneuvers');
    expect(maneuvers?.textContent).toContain('Maneuvers');
    expect(maneuvers?.textContent).toContain('1');
  });

  it('renders the sail/motor split bar with hand-derived proportions (5 motor of 21.5)', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const split = container.querySelector('.ergebnis-split') as HTMLElement;
    expect(split).not.toBeNull();
    // 21.5 total, 5 motor -> 16.5 sail; 5/21.5 = 23 %, sail 77 %.
    expect(split.textContent).toContain('16.5 nm');
    expect(split.textContent).toContain('77%');
    expect(split.textContent).toContain('5.0 nm');
    expect(split.textContent).toContain('23%');
    // Two proportional segments since motor > 0.
    expect(container.querySelectorAll('.ergebnis-split-bar > span')).toHaveLength(2);
    const sailSeg = container.querySelector('.ergebnis-split-sail') as HTMLElement;
    expect(Number(sailSeg.style.flexGrow)).toBeCloseTo(16.5 / 21.5, 6);
  });

  it('an all-sail rig renders a single split segment at 100 %', () => {
    const { container } = renderSummary({ rig: 'fock' });
    const split = container.querySelector('.ergebnis-split') as HTMLElement;
    expect(split.textContent).toContain('100%');
    // Only the sail segment when motor nm is 0.
    expect(container.querySelectorAll('.ergebnis-split-bar > span')).toHaveLength(1);
    expect(container.querySelector('.ergebnis-split-motor')).toBeNull();
  });

  it('moves the legs table behind a disclosure labelled "Legs (n)"', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const disclosure = container.querySelector(
      'details.route-legs-disclosure',
    ) as HTMLDetailsElement;
    expect(disclosure).not.toBeNull();
    expect(disclosure.querySelector('summary')?.textContent).toBe('Legs (3)');
    // The table lives inside the disclosure (in DOM even when collapsed).
    expect(disclosure.querySelector('table.route-legs')).not.toBeNull();
  });

  it('renders the legs table with kind chips, heading, and a maneuver badge at the tack leg', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Motor')).toBeInTheDocument();
    expect(screen.getByText('Tack')).toBeInTheDocument();
    expect(screen.getByText('088°')).toBeInTheDocument();
  });

  it('#707: every legs-table header cell carries scope="col", and the table has a visually-hidden caption naming it', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const headers = Array.from(container.querySelectorAll('table.route-legs thead th'));
    expect(headers).toHaveLength(10);
    for (const th of headers) {
      expect(th.getAttribute('scope'), th.textContent ?? '(no text)').toBe('col');
    }
    const caption = container.querySelector('table.route-legs caption');
    expect(caption).not.toBeNull();
    expect(caption).toHaveClass('sr-only');
    // Same key/params as the Disclosure summary above the table (#707: no
    // new i18n key) — asserted against the shared en dict so a wording
    // change to route.legs.disclosure can't silently desync the two.
    expect(caption?.textContent).toBe(en['route.legs.disclosure'].replace('{count}', '3'));
  });

  it('renders the ten legs-table headers in order, including Duration (#379) and Shallow (#452)', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const headers = Array.from(container.querySelectorAll('table.route-legs thead th')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual([
      'Time',
      'Duration',
      'Type',
      'COG',
      'TWA',
      'TWS',
      'Speed',
      'Distance',
      'Maneuver',
      'Shallow',
    ]);
  });

  it('renders a real Duration value for both a sail leg and a motor leg (#379)', () => {
    // Anti-regression for the "symmetry ternary" risk: duration lives on
    // LegCommon, so both union variants must render a real value here, never
    // a stray `leg.kind === 'sail' ? ... : '—'` copied from the TWA column.
    const { container } = renderSummary({ rig: 'genoa' });
    const rows = container.querySelectorAll('table.route-legs tbody tr');
    expect(rows).toHaveLength(3);
    const durationCell = (rowIndex: number) =>
      rows[rowIndex]?.querySelectorAll('td')[1]?.textContent;
    // Leg 0: sail, DEPARTURE_MS -> +2h.
    expect(durationCell(0)).toBe('2 h 00 min');
    // Leg 1: motor, +2h -> +4h -- a real duration, not '-'.
    expect(durationCell(1)).toBe('2 h 00 min');
    // Leg 2: sail, +4h -> +5h.
    expect(durationCell(2)).toBe('1 h 00 min');
  });

  it('prefixes each sail-leg chip with the displayed rig name (genoa)', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Genoa · Stbd Reach')).toBeInTheDocument();
    expect(screen.getByText('Genoa · Port Reach')).toBeInTheDocument();
  });

  it('switches the sail-chip rig prefix to the displayed rig (fock)', () => {
    renderSummary({ rig: 'fock' });
    expect(screen.getByText('Fock · Stbd Reach')).toBeInTheDocument();
  });

  it('renders the motor-note footnote inside the legs disclosure when the result has legs', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText(/Motor = engine only/)).toBeInTheDocument();
  });

  it('omits the motor-note footnote when the selected rig result has no legs', () => {
    const plan = makePlan();
    setSail(plan, 'genoa', { result: { ...GENOA_RESULT, legs: [] } });
    renderSummary({ plan, rig: 'genoa' });
    expect(screen.queryByText(/Motor = engine only/)).not.toBeInTheDocument();
  });

  it('shows a stale-forecast warning when departure is more than 12h after the forecast fetch', () => {
    const plan = makePlan({ departureMs: FETCHED_AT_MS + 12 * 3_600_000 + 1 });
    renderSummary({ plan });
    expect(screen.getByText(/12 hours/i)).toBeInTheDocument();
  });

  it('hides the stale-forecast warning when departure is within 12h of the forecast fetch', () => {
    renderSummary();
    expect(screen.queryByText(/hours old relative to departure/i)).not.toBeInTheDocument();
  });

  it('renders a no-route message instead of stats/legs when the selected rig has no result', () => {
    const plan = makePlan();
    setSail(plan, 'fock', { result: null, reason: 'unreachable' });
    renderSummary({ plan, rig: 'fock' });
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be reached/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // #662: `reason: null` alongside `result: null` is the SAVED-plan-only
  // state PR #656 (#614) introduced — a stored no-route reason outside the
  // NoRouteReason union falls back to `null` rather than a bad cast. Before
  // #662 this rendered the generic, live-planning-flavoured `error.internal`
  // ("Try again; reload the app"), which is untrue here: this screen is
  // reading an already-saved record, not running a live plan, so neither
  // action can do anything. The fix names the one thing that DOES help.
  it('#662: a saved plan with an untrusted stored no-route reason gets copy that says to re-plan, not "try again"/"reload"', () => {
    const plan = makePlan();
    setSail(plan, 'fock', { result: null, reason: null });
    renderSummary({ plan, rig: 'fock' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(en['error.savedPlanUnreadable']);
    // The generic live-planning fallback must NOT render for this saved-plan
    // path — that would be the #662 defect reappearing.
    expect(alert.textContent).not.toContain(en['error.internal']);
    // Its remedy framing specifically: no retry/reload language, unlike
    // error.internal's own "Try again; if it keeps happening, reload the
    // app." — a regression back to that generic key would still say "Try
    // again" and this is what would catch it even if the key name survived.
    expect(alert.textContent).not.toMatch(/try again/i);
    expect(alert.textContent).not.toMatch(/reload the app/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('GPX export creates a Blob via URL.createObjectURL and clicks an anchor named "<name>-<rig>.gpx"', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must accept a Blob for the tuple-typed assertion below
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    let downloadName = '';
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    try {
      const { plan } = renderSummary({ rig: 'genoa' });
      fireEvent.click(screen.getByRole('button', { name: 'Export GPX' }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
      expect(downloadName).toBe(`${plan.name}-genoa.gpx`);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      clickSpy.mockRestore();
    }
  });

  it('GPX export button is disabled when result has zero legs', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must accept a Blob for the tuple-typed assertion
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = createObjectURL;

    try {
      const plan = makePlan();
      setSail(plan, 'genoa', { result: { ...GENOA_RESULT, legs: [] } });
      renderSummary({ plan, rig: 'genoa' });

      const button = screen.getByRole('button', { name: 'Export GPX' });
      expect(button).toBeDisabled();

      fireEvent.click(button);
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });
});

describe('shallow-water warning banner (#53/#452)', () => {
  // Distinct requested/used/minGate values so an assertion on one field
  // cannot pass by accident against another (#452: usedDepthM used to render
  // nowhere at all, so a test built on requestedDepthM === usedDepthM could
  // not have caught its absence).
  function makeShallowPlan(): Plan {
    const plan = makePlan();
    plan.result = {
      ...plan.result,
      shallow: { requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.3 },
    };
    return plan;
  }

  it('renders the plan-level warning with the requested, effective (used) and minimum gate depths', () => {
    // #504 wave 4: the warning is now a role="alert" CONTAINER (a <div>)
    // holding three <p> parts, not one <p>. `screen.getByText(/was not
    // passable/)` would now resolve to the .shallow-warning__detail leaf
    // alone (Testing Library's getNodeText only considers a node's OWN
    // direct text-node children, so the wrapping <div> — which has no
    // direct text of its own, only element children — never matches) —
    // querying the container by class is what actually asserts on the
    // element role/class live on.
    const { container } = renderSummary({ plan: makeShallowPlan() });
    const banner = container.querySelector('.shallow-warning');
    expect(banner).not.toBeNull();
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner?.textContent).toContain('3.0 m');
    // #452: the effective (relaxed) depth the route was actually computed at.
    expect(banner?.textContent).toContain('2.5 m');
    expect(banner?.textContent).toContain('2.3 m');
    // Honest passage-planning-aid copy (#455): never claims an unflagged
    // section IS safe. review (PR #461 Major 3, twin of the identical
    // PlannerPanel.test.tsx assertion — see its comment for the full
    // measured mutation record): widened from `/\bis
    // (verified|guaranteed)\b/i`, which let "...is safe." through 91/91
    // GREEN, to also catch "is/are safe" and "is/are clear". NARROWED, NOT
    // CLOSED — "poses no risk" still evades it; the POSITIVE `toContain`
    // below is the assertion actually doing the work.
    expect(banner?.textContent).not.toMatch(/\b(is|are) (safe|clear|verified|guaranteed)\b/i);
    expect(banner?.textContent).toContain('not guaranteed to be clear');
  });

  it('renders on BOTH rig tabs — the warning is plan-level, not per rig', () => {
    renderSummary({ plan: makeShallowPlan(), rig: 'fock' });
    expect(screen.getByText(/was not passable/)).toBeInTheDocument();
  });

  // Review finding (PR #461 Major 2): German is the app's DEFAULT language
  // (`I18nProvider` falls back to 'de' when nothing is stored), but every
  // other test in this describe block forces 'en' via `renderSummary`'s
  // hardcoded `localStorage.setItem('sc-lang', 'en')` — so the string most
  // users actually see had zero coverage. Rendered directly (not through
  // `renderSummary`) so this one case can set 'de' without touching the
  // shared helper's default for every other test in the file.
  it('#452 Major 2: renders the German copy with all three depths and the honesty hedge', () => {
    localStorage.setItem('sc-lang', 'de');
    const { container } = render(
      <I18nProvider>
        <RouteSummary plan={makeShallowPlan()} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    const banner = container.querySelector('.shallow-warning');
    expect(banner).not.toBeNull();
    expect(banner).toHaveAttribute('role', 'alert');
    // Requested / used / minGate — same three distinct values as the English
    // case above, so a dropped placeholder in the DE string reds here too.
    // #596: comma-formatted (formatDepthM), not the English case's points —
    // the discriminating half of the locale pair this test exists to prove.
    expect(banner?.textContent).toContain('3,0 m');
    expect(banner?.textContent).toContain('2,5 m');
    expect(banner?.textContent).toContain('2,3 m');
    // The honesty hedge, in German: never claims an unflagged section IS
    // safe — this is the same #455 constraint as the English copy, and it
    // has to hold independently since the two strings are maintained by hand.
    expect(banner?.textContent).toContain('nicht garantiert frei von Untiefen');
  });

  it('is absent on plans without relaxation', () => {
    renderSummary();
    expect(screen.queryByText(/was not passable/)).toBeNull();
  });
});

describe('#452 gap 3: per-leg shallow marker + locator sentence', () => {
  // Two flagged legs (index 0 and 2) with an UNFLAGGED leg between them
  // (index 1) — non-contiguous on purpose: a "first" that's really "last",
  // or a count that's really "total legs", would both be caught by this
  // shape but not by an all-flagged or a first-two-flagged fixture.
  const NON_CONTIGUOUS_SHALLOW_LEGS: Leg[] = [
    {
      kind: 'sail',
      board: 'starboard',
      start: { lat: 54.79, lon: 9.43 },
      end: { lat: 54.8, lon: 10.0 },
      startTimeMs: DEPARTURE_MS,
      endTimeMs: DEPARTURE_MS + 2 * 3_600_000,
      headingDeg: 88,
      twaDeg: 92,
      twsKn: 10,
      speedKn: 7,
      distanceNm: 15,
      maneuverAtStart: null,
      shallow: { minDepthM: 2.3 },
    },
    {
      kind: 'motor',
      board: null,
      start: { lat: 54.8, lon: 10.0 },
      end: { lat: 54.85, lon: 10.3 },
      startTimeMs: DEPARTURE_MS + 2 * 3_600_000,
      endTimeMs: DEPARTURE_MS + 4 * 3_600_000,
      headingDeg: 90,
      twsKn: 2,
      speedKn: 6.5,
      distanceNm: 5,
      maneuverAtStart: null,
    },
    {
      kind: 'sail',
      board: 'port',
      start: { lat: 54.85, lon: 10.3 },
      end: { lat: 54.86, lon: 10.55 },
      startTimeMs: DEPARTURE_MS + 4 * 3_600_000,
      endTimeMs: DEPARTURE_MS + 5 * 3_600_000,
      headingDeg: 60,
      twaDeg: -80,
      twsKn: 10,
      speedKn: 6,
      distanceNm: 1.5,
      maneuverAtStart: 'tack',
      shallow: { minDepthM: 1.9 },
    },
  ];

  // Same three legs, but only the FIRST is flagged — for the singular-vs-
  // plural sentence test.
  const SINGLE_SHALLOW_LEGS: Leg[] = [
    NON_CONTIGUOUS_SHALLOW_LEGS[0],
    NON_CONTIGUOUS_SHALLOW_LEGS[1],
    {
      kind: 'sail',
      board: 'port',
      start: { lat: 54.85, lon: 10.3 },
      end: { lat: 54.86, lon: 10.55 },
      startTimeMs: DEPARTURE_MS + 4 * 3_600_000,
      endTimeMs: DEPARTURE_MS + 5 * 3_600_000,
      headingDeg: 60,
      twaDeg: -80,
      twsKn: 10,
      speedKn: 6,
      distanceNm: 1.5,
      maneuverAtStart: 'tack',
      // No `shallow` key (exactOptionalPropertyTypes: omitted, not undefined).
    },
  ];

  function makeShallowPlan(legs: Leg[]): Plan {
    const plan = makePlan();
    setSail(plan, 'genoa', { result: { ...GENOA_RESULT, legs } });
    plan.result = {
      ...plan.result,
      shallow: { requestedDepthM: 3.0, usedDepthM: 2.3, minGateDepthM: 1.9 },
    };
    return plan;
  }

  it('marks only the flagged legs in the table, each with its own charted depth', () => {
    const { container } = renderSummary({
      plan: makeShallowPlan(NON_CONTIGUOUS_SHALLOW_LEGS),
      rig: 'genoa',
    });
    const rows = container.querySelectorAll('table.route-legs tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('.chip-shallow')?.textContent).toBe('Shallow 2.3 m');
    expect(rows[1]?.querySelector('.chip-shallow')).toBeNull();
    expect(rows[2]?.querySelector('.chip-shallow')?.textContent).toBe('Shallow 1.9 m');
  });

  it('reports the right count and first occurrence for non-contiguous flagged legs', () => {
    renderSummary({ plan: makeShallowPlan(NON_CONTIGUOUS_SHALLOW_LEGS), rig: 'genoa' });
    const banner = screen.getByText(/was not passable/);
    const expected = en['route.shallow.locator.plural']
      .replace('{count}', '2')
      .replace('{time}', formatTime(DEPARTURE_MS, 'en'));
    expect(banner.textContent).toContain(expected);
  });

  it('uses the singular sentence (no count) when exactly one leg is flagged', () => {
    renderSummary({ plan: makeShallowPlan(SINGLE_SHALLOW_LEGS), rig: 'genoa' });
    const banner = screen.getByText(/was not passable/);
    const expected = en['route.shallow.locator'].replace('{time}', formatTime(DEPARTURE_MS, 'en'));
    expect(banner.textContent).toContain(expected);
    // The plural form must not ALSO appear (a mis-picked key would add it).
    expect(banner.textContent).not.toContain('legs are affected');
  });

  it('omits the locator sentence when relaxation fired but no individual leg is flagged', () => {
    // GENOA_LEGS (the default fixture) never sets leg.shallow — the
    // plan-level banner still renders (see the sibling describe block
    // above), but nothing in the table is flagged, so the locator sentence
    // must fail safe rather than render a nonsensical "0 legs" sentence.
    const plan = makePlan();
    plan.result = {
      ...plan.result,
      shallow: { requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.3 },
    };
    renderSummary({ plan });
    const banner = screen.getByText(/was not passable/);
    expect(banner.textContent).not.toContain('starts at');
  });

  it('omits the locator sentence when the active tab’s own rig has no result', () => {
    const plan = makeShallowPlan(NON_CONTIGUOUS_SHALLOW_LEGS);
    setSail(plan, 'fock', { result: null, reason: 'unreachable' });
    renderSummary({ plan, rig: 'fock' });
    const banner = screen.getByText(/was not passable/);
    expect(banner.textContent).not.toContain('starts at');
  });

  it('renders the German locator sentence with the same count/time contract', () => {
    localStorage.setItem('sc-lang', 'de');
    render(
      <I18nProvider>
        <RouteSummary
          plan={makeShallowPlan(NON_CONTIGUOUS_SHALLOW_LEGS)}
          rig="genoa"
          onRigChange={vi.fn()}
        />
      </I18nProvider>,
    );
    const banner = screen.getByText(/keine durchgehende Route gefunden/);
    const expected = de['route.shallow.locator.plural']
      .replace('{count}', '2')
      .replace('{time}', formatTime(DEPARTURE_MS, 'de'));
    expect(banner.textContent).toContain(expected);
  });
});

// Builds the exact rendered text from a dict TEMPLATE (a real, hand-read
// artifact) plus HAND-CHOSEN literal values — the same "needle from a real
// artifact, haystack from the shipped dict string" shape maskTolerance.test.ts
// uses, generalized to several placeholders via one replaceAll loop each
// (matching useT()'s own per-key replaceAll semantics in i18n/index.tsx, so
// a double-occurrence placeholder — none exist in these two templates today —
// would still resolve identically to production). This is NOT deriving the
// expectation from the code under test: ShallowWarning's own decision logic
// (which key, which class, which values) is exercised for real by rendering
// the component; this helper only stitches together values chosen here.
function interpolate(template: string, vars: Record<string, string>): string {
  let msg = template;
  for (const [k, v] of Object.entries(vars)) msg = msg.replaceAll(`{${k}}`, v);
  return msg;
}

describe('#493: cautious depth disclosure', () => {
  // #504 review (finding #4): pairwise-DISTINCT requestedDepthM/usedDepthM/
  // minGateDepthM/leg-minDepthM — the previous fixture collapsed all three
  // shallow-info fields plus the leg's own minDepthM onto 2.3, so re-keying
  // ShallowWarning's `used` interpolation (or isSevere) onto minGateDepthM
  // would have kept every assertion here green.
  const ONE_SHALLOW_LEG: Leg[] = [
    {
      kind: 'sail',
      board: 'starboard',
      start: { lat: 54.79, lon: 9.43 },
      end: { lat: 54.8, lon: 10.0 },
      startTimeMs: DEPARTURE_MS,
      endTimeMs: DEPARTURE_MS + 2 * 3_600_000,
      headingDeg: 88,
      twaDeg: 92,
      twsKn: 10,
      speedKn: 7,
      distanceNm: 15,
      maneuverAtStart: null,
      shallow: { minDepthM: 2.3 },
    },
  ];

  function makeLegPlan(): Plan {
    const plan = makePlan();
    setSail(plan, 'genoa', { result: { ...GENOA_RESULT, legs: ONE_SHALLOW_LEG } });
    plan.result = {
      ...plan.result,
      shallow: { requestedDepthM: 3.5, usedDepthM: 2.9, minGateDepthM: 2.6 },
    };
    return plan;
  }

  it('renders the cautious lower bound ALONGSIDE the shipped per-leg figure, never in place of it', () => {
    const { container } = renderSummary({ plan: makeLegPlan(), rig: 'genoa' });
    const row = container.querySelector('table.route-legs tbody tr');
    // Unchanged shipped-figure chip — proves the new surface is additive.
    // Reads the LEG's own minDepthM (2.3), distinct from usedDepthM(2.9)/
    // minGateDepthM(2.6) above — a field mix-up here would render 2.9 or 2.6
    // instead of 2.3 and both assertions below would red.
    expect(row?.querySelector('.chip-shallow')?.textContent).toBe('Shallow 2.3 m');
    expect(row?.querySelector('.chip-shallow-cautious')?.textContent).toBe(
      'cautious: as low as 1.4 m',
    );
  });

  it('renders the German cautious lower bound with the same two-number contract', () => {
    localStorage.setItem('sc-lang', 'de');
    const { container } = render(
      <I18nProvider>
        <RouteSummary plan={makeLegPlan()} rig="genoa" onRigChange={vi.fn()} />
      </I18nProvider>,
    );
    const row = container.querySelector('table.route-legs tbody tr');
    // #596: comma-formatted (formatDepthM) — the discriminating half of the
    // locale pair against the English case above, which reads with points.
    expect(row?.querySelector('.chip-shallow')?.textContent).toBe('Untiefe 2,3 m');
    expect(row?.querySelector('.chip-shallow-cautious')?.textContent).toBe(
      'vorsichtig: bis auf 1,4 m',
    );
  });

  // #504 wave 4: the banner restructured from ONE dense <p> into a
  // role="alert" CONTAINER (a <div>) holding three parts —
  // .shallow-warning__lead/__detail/__caveat — chosen between
  // route.shallow.lead/leadSevere by `usedDepthM - MASK_TOLERANCE_M <
  // BOAT_DRAFT_M`, never both rendered at once. requestedDepthM(3.5) and
  // minGateDepthM(2.6) are FIXED across every case here and distinct from
  // both tested usedDepthM values (3.0, 2.9) and from each other (finding
  // #4) — so a field mix-up moves a DIFFERENT number than the one under
  // test.
  describe('the restructured banner (#504 wave 4: lead/detail/caveat inside one alert)', () => {
    const REQUESTED_M = '3.5';
    const MIN_GATE_M = '2.6';
    // Finding #5: derive the boundary from the SAME constants isSevere
    // compares, rounded to one decimal, rather than hardcoding today's 3.0 —
    // this tracks MASK_TOLERANCE_M/BOAT_DRAFT_M if either ever moves.
    const BOUNDARY_USED_DEPTH_M = Math.round((BOAT_DRAFT_M + MASK_TOLERANCE_M) * 10) / 10;
    const BELOW_BOUNDARY_USED_DEPTH_M = Math.round((BOUNDARY_USED_DEPTH_M - 0.1) * 10) / 10;

    function makeSeverityPlan(usedDepthM: number): Plan {
      const plan = makePlan();
      plan.result = {
        ...plan.result,
        shallow: { requestedDepthM: 3.5, usedDepthM, minGateDepthM: 2.6 },
      };
      return plan;
    }

    // Hand-computed, not read from cautiousDepthLowerBoundM — see mask.test.ts
    // for that function's own independently-pinned literals; this table only
    // asserts the two values this suite needs, verified by hand:
    // BOUNDARY(3.0) - 0.9 = 2.1 exactly; BELOW_BOUNDARY(2.9) - 0.9 = 2.0 exactly.
    const CAUTIOUS_AT_BOUNDARY_M = '2.1';
    const CAUTIOUS_BELOW_BOUNDARY_M = '2.0';

    it('renders exactly ONE alert region for the shallow warning, not one per part', () => {
      const { container } = renderSummary({ plan: makeSeverityPlan(BELOW_BOUNDARY_USED_DEPTH_M) });
      // No stale-forecast or no-route alert exists in this fixture (result
      // is present, forecast is fresh) — every role="alert" here comes from
      // ShallowWarning, so this directly catches a regression to a separate
      // role="alert" per lead/detail/caveat part, under ANY class name.
      const alerts = container.querySelectorAll('[role="alert"]');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.tagName).toBe('DIV');
    });

    it('does NOT escalate right at the boundary — lead/detail/caveat each pinned to their exact slots', () => {
      const { container } = renderSummary({ plan: makeSeverityPlan(BOUNDARY_USED_DEPTH_M) });
      const banner = container.querySelector('.shallow-warning');
      expect(banner).not.toBeNull();
      expect(banner).toHaveAttribute('role', 'alert');
      expect(banner).not.toHaveClass('shallow-warning--severe');
      const lead = banner?.querySelector('.shallow-warning__lead');
      const detail = banner?.querySelector('.shallow-warning__detail');
      const caveat = banner?.querySelector('.shallow-warning__caveat');
      expect(lead?.textContent).toBe(
        interpolate(en['route.shallow.lead'], { cautious: CAUTIOUS_AT_BOUNDARY_M }),
      );
      expect(detail?.textContent).toBe(
        interpolate(en['route.shallow.detail'], {
          requested: REQUESTED_M,
          used: BOUNDARY_USED_DEPTH_M.toFixed(1),
          minGate: MIN_GATE_M,
        }),
      );
      expect(caveat?.textContent).toBe(en['route.shallow.caveat']);
      // #504 review round 2's dict-independence requirement, extended to the
      // new lead/detail/caveat structure: this literal is typed here, never
      // read from `en[...]` at runtime, so it cannot shrink along with the
      // dict (MEASURED at wave 2 by the reviewer: deleting the cautious
      // clause from the dict left the old .toBe() pin 107/107 GREEN).
      expect(lead?.textContent).toContain('could run as low as 2.1 m');
    });

    it('escalates one decimetre below the boundary — lead carries the draft clause, pinned to its slot', () => {
      const { container } = renderSummary({ plan: makeSeverityPlan(BELOW_BOUNDARY_USED_DEPTH_M) });
      const banner = container.querySelector('.shallow-warning');
      expect(banner).not.toBeNull();
      expect(banner).toHaveAttribute('role', 'alert');
      expect(banner).toHaveClass('shallow-warning--severe');
      const lead = banner?.querySelector('.shallow-warning__lead');
      const detail = banner?.querySelector('.shallow-warning__detail');
      const caveat = banner?.querySelector('.shallow-warning__caveat');
      expect(lead?.textContent).toBe(
        interpolate(en['route.shallow.leadSevere'], {
          cautious: CAUTIOUS_BELOW_BOUNDARY_M,
          draft: BOAT_DRAFT_M.toFixed(1),
        }),
      );
      expect(detail?.textContent).toBe(
        interpolate(en['route.shallow.detail'], {
          requested: REQUESTED_M,
          used: BELOW_BOUNDARY_USED_DEPTH_M.toFixed(1),
          minGate: MIN_GATE_M,
        }),
      );
      expect(caveat?.textContent).toBe(en['route.shallow.caveat']);
      // Same dict-independence requirement as the non-severe test above,
      // for THIS key's own {cautious} and {draft} slots (the reviewer's
      // "same hole for the severe key's {draft} clause" finding) — both
      // literals are typed here, not read from `en[...]`.
      expect(lead?.textContent).toContain('as low as 2.0 m');
      expect(lead?.textContent).toContain("below this boat's 2.1 m draft");
      // Regression pin, unchanged from before the fold (#455's honesty hedge
      // must hold for the caveat too).
      expect(caveat?.textContent).not.toMatch(/\b(is|are) (safe|clear|verified|guaranteed)\b/i);
    });

    it('German copy: severe case pins the same slots', () => {
      localStorage.setItem('sc-lang', 'de');
      const { container } = render(
        <I18nProvider>
          <RouteSummary
            plan={makeSeverityPlan(BELOW_BOUNDARY_USED_DEPTH_M)}
            rig="genoa"
            onRigChange={vi.fn()}
          />
        </I18nProvider>,
      );
      const banner = container.querySelector('.shallow-warning');
      expect(banner).not.toBeNull();
      expect(banner).toHaveClass('shallow-warning--severe');
      const lead = banner?.querySelector('.shallow-warning__lead');
      // #596: comma-formatted (formatDepthM) — CAUTIOUS_BELOW_BOUNDARY_M and
      // BOAT_DRAFT_M.toFixed(1) above are the ENGLISH-formatted literals the
      // sibling test above shares; German needs its own decimal-comma forms
      // of the same two numbers (2.0 -> 2,0; 2.1 -> 2,1), not a re-use.
      expect(lead?.textContent).toBe(
        interpolate(de['route.shallow.leadSevere'], {
          cautious: '2,0',
          draft: '2,1',
        }),
      );
      // Dict-independence requirement, typed here rather than read from
      // `de[...]`.
      expect(lead?.textContent).toContain('kann bis auf 2,0 m sinken');
      expect(lead?.textContent).toContain('unter den Bootstiefgang von 2,1 m');
    });
  });
});

// #539 (spec C.4(a)). The banner's severity gate and its rendered draft both
// used to read `BOAT_DRAFT_M`, the Salona 45's 2.1 m module constant. Every
// case ABOVE plans on `defaultBoatSnapshot()`, whose draft is that same 2.1 —
// so none of them can tell the fixed code from the broken code, and none of
// them changed when #539 landed. These two rows are the discriminators, and
// they exist because that whole suite above was green through the defect.
//
// The Elan Impression 444 is the catalogue's only DIFFERENT draft (1.90 m),
// which is what makes a comparison possible at all. Both rows below build the
// two plans from the SAME `makePlan()` and vary ONLY `request.boat` — the two
// measurements are of one subject, not of two different fixtures.
//
// ERROR DIRECTION, stated honestly: no catalogue boat is DEEPER than 2.1 m, so
// the stale gate made `isSevere` OVER-fire on the Elan rather than under-warn.
// The live defect was the DRAFT FIGURE — "2.1 m" printed for a 1.9 m hull in
// the app's most severe depth copy — not a missing warning.
//
// PER-ASSERTION ATTRIBUTION, MEASURED 2026-08-18 by deleting each assertion
// alone under a mutation aimed at it (a multi-assertion pin can have a single
// discriminating member — #516/PR #523):
//   'salona IS severe'        catches `isSevere` forced FALSE (4 rows red in
//                             this file; 3 with it deleted) — it is the only
//                             assertion here covering the 2.1 m half.
//   'elan NOT severe'         catches the stale-constant gate.
//   'non-severe lead wording' catches a wrong cautious figure on that branch.
//   'lead has no draft clause' is NOT redundant with the class check, and this
//                             was measured rather than argued: forcing the lead
//                             to the SEVERE key while leaving the CLASS correct
//                             reds 2 rows, and only 1 with this assertion
//                             deleted. The class and the wording are two
//                             surfaces, so both are pinned.
describe('#539: the shallow banner follows the PLAN’s boat, not a module constant', () => {
  const ELAN = boatById('elan-444-piranja');

  // Hand-derived from the two catalogue drafts and TOLERANCE_M = 0.9, typed
  // out rather than computed from MASK_TOLERANCE_M so this block cannot move
  // in step with the code it is testing:
  //   usedDepthM 2.9 -> cautious 2.0 -> severe for a 2.1 m hull, NOT for 1.9 m
  //   usedDepthM 2.7 -> cautious 1.8 -> severe for both
  const SPLIT_USED_DEPTH_M = 2.9;
  const BOTH_SEVERE_USED_DEPTH_M = 2.7;

  function planFor(boat: Plan['request']['boat'], usedDepthM: number): Plan {
    const plan = makePlan();
    plan.request = { ...plan.request, boat };
    plan.result = {
      ...plan.result,
      shallow: { requestedDepthM: 3.5, usedDepthM, minGateDepthM: 2.6 },
    };
    return plan;
  }

  it('splits on severity at one usedDepthM: severe for the 2.1 m hull, not for the 1.9 m one', () => {
    const salona = renderSummary({
      plan: planFor(defaultBoatSnapshot(), SPLIT_USED_DEPTH_M),
    }).container;
    expect(salona.querySelector('.shallow-warning')).toHaveClass('shallow-warning--severe');
    cleanup();

    const elan = renderSummary({
      plan: planFor(boatSnapshot(ELAN), SPLIT_USED_DEPTH_M),
    }).container;
    const banner = elan.querySelector('.shallow-warning');
    expect(banner).not.toBeNull();
    expect(banner).not.toHaveClass('shallow-warning--severe');
    // The non-severe lead has no draft clause at all — assert its ABSENCE by
    // the wording, so a severe lead that merely lost its class would still red.
    expect(banner?.querySelector('.shallow-warning__lead')?.textContent).toContain(
      'could run as low as 2.0 m',
    );
    expect(banner?.querySelector('.shallow-warning__lead')?.textContent).not.toContain('draft');
  });

  it('renders the plan boat’s own draft in the severe lead, never the Salona’s 2.1 m', () => {
    const { container } = renderSummary({
      plan: planFor(boatSnapshot(ELAN), BOTH_SEVERE_USED_DEPTH_M),
    });
    const lead = container.querySelector('.shallow-warning--severe .shallow-warning__lead');
    expect(lead).not.toBeNull();
    // Literals typed here, never read from `en[...]` — this repo's standing
    // dict-independence requirement for a copy pin (#504 review round 2).
    expect(lead?.textContent).toContain('as low as 1.8 m');
    expect(lead?.textContent).toContain("below this boat's 1.9 m draft");
    // Defence in depth, and honestly labelled: MEASURED, no mutation makes
    // this the SOLE red — every one that trips it also trips one of the two
    // above. It stays because it encodes #539's own signature directly ("the
    // Salona's number must not appear on an Elan plan") where the positive
    // pins only encode what the right answer looks like.
    expect(lead?.textContent).not.toContain('2.1 m');
  });
});
