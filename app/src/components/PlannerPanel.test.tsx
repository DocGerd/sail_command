import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/dict.en';
import { formatTime, toLocalInputValue } from '../lib/format';
import { MAX_GPX_FILE_BYTES } from '../lib/gpx';
import { FORECAST_DAYS } from '../services/openMeteo';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type Harbor,
  type LatLon,
  type Leg,
  type PickedPoint,
  type Plan,
  type RigRecommendation,
  type RigResult,
  type SailId,
  type Settings,
} from '../types';
import PlannerPanel, { nextFullHourMs, type PlannerStatus, type TapTarget } from './PlannerPanel';
import { boatById, DEFAULT_BOAT_ID, type BoatDef } from '../data/boats';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

// PR #763 review Minor 7: see RouteSummary.test.tsx's own copy of this
// helper for the full rationale (jsdom does not hide closed-<details>
// content, so `getByText`/`getByRole` alone no longer distinguish VISIBLE
// from merely PRESENT). Every shallow-warning fixture in this file uses a
// usedDepthM below the severe boundary — which USED to mean a fresh
// `renderPanel()` mounted with the Disclosure open. #788 made `defaultOpen`
// the constant `false`, so they now mount CLOSED and every call here reads
// `false`. Only the expectations moved: the body text these rows assert on
// is still in the DOM (jsdom renders closed-<details> content), and the
// hazard itself was never in the body — it is in the <summary> and the
// caveat sibling. RouteSummary.test.tsx's twin of this comment says the same.
function expectShallowDetailOpen(expected: boolean): void {
  const details = document.querySelector(
    'details.shallow-warning-disclosure',
  ) as HTMLDetailsElement | null;
  expect(
    details,
    'expected a <details class="shallow-warning-disclosure"> element in the DOM',
  ).not.toBeNull();
  expect(details?.open).toBe(expected);
}

// #731 review round 2: PlannerPanel now ALSO always mounts a second
// `role="status"` element (the blur-clamp correction notice, scoped to
// `.planner-safety-depth .boat-picker-notice` — see that describe block's
// own `notice()` helper), so a bare `screen.getByRole('status')` — this
// file's PRE-EXISTING pattern for the "plan ready"/routing-phase live
// region, `.planner-status` — now throws on multiple matches. Scope to the
// specific element instead of the role.
function plannerStatus(): HTMLElement {
  const el = document.querySelector('.planner-status');
  if (!el) throw new Error('expected .planner-status to exist');
  return el as HTMLElement;
}

const FLENSBURG: Harbor = {
  id: 'flensburg',
  names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
  country: 'DE',
  snap: { lat: 54.795, lon: 9.435 },
};

const MARSTAL: Harbor = {
  id: 'marstal',
  names: { de: 'Marstal', da: 'Marstal', en: 'Marstal' },
  country: 'DK',
  snap: { lat: 54.855, lon: 10.52 },
};

const HARBORS = [FLENSBURG, MARSTAL];

const DEPARTURE_MS = Date.UTC(2026, 6, 20, 9, 0, 0);
const PLAN_DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

const GENOA_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.85, lon: 10.52 },
    startTimeMs: PLAN_DEPARTURE_MS,
    endTimeMs: PLAN_DEPARTURE_MS + 5 * 3_600_000,
    headingDeg: 88,
    twaDeg: 92,
    twsKn: 10,
    speedKn: 7,
    distanceNm: 21.5,
    maneuverAtStart: null,
  },
];

const GENOA_RESULT: RigResult = {
  sailId: 'genoa',
  etaMs: PLAN_DEPARTURE_MS + 5 * 3_600_000,
  durationMs: 5 * 3_600_000,
  distanceNm: 21.5,
  maneuverCount: 1,
  motorDistanceNm: 5,
  legs: GENOA_LEGS,
};

// #452 gap 3: two flagged legs (index 0 and 2) with an UNFLAGGED leg between
// them (index 1) — non-contiguous on purpose, so a "first" that's really
// "last", or a count that's really "total legs", would both be caught.
const NON_CONTIGUOUS_SHALLOW_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.8, lon: 10.0 },
    startTimeMs: PLAN_DEPARTURE_MS,
    endTimeMs: PLAN_DEPARTURE_MS + 2 * 3_600_000,
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
    startTimeMs: PLAN_DEPARTURE_MS + 2 * 3_600_000,
    endTimeMs: PLAN_DEPARTURE_MS + 4 * 3_600_000,
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
    end: { lat: 54.85, lon: 10.52 },
    startTimeMs: PLAN_DEPARTURE_MS + 4 * 3_600_000,
    endTimeMs: PLAN_DEPARTURE_MS + 5 * 3_600_000,
    headingDeg: 60,
    twaDeg: -80,
    twsKn: 10,
    speedKn: 6,
    distanceNm: 1.5,
    maneuverAtStart: 'tack',
    shallow: { minDepthM: 1.9 },
  },
];

function makePlan(
  over: {
    id?: string;
    distanceNm?: number;
    rigRecommendation?: RigRecommendation;
    // #540: defaults to true (every pre-existing test's assumption); pass
    // false to exercise the budget-truncated disclosure path.
    comparisonComplete?: boolean;
  } = {},
): Plan {
  const distanceNm = over.distanceNm ?? GENOA_RESULT.distanceNm;
  return {
    id: over.id ?? 'plan-1',
    name: 'Flensburg to Marstal',
    createdAtMs: PLAN_DEPARTURE_MS,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.52 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: PLAN_DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: PLAN_DEPARTURE_MS },
    result: {
      status: 'ok',
      sails: [
        { sailId: 'genoa', result: { ...GENOA_RESULT, distanceNm }, reason: null },
        { sailId: 'fock', result: null, reason: 'calm-motor-off' },
      ],
      recommended: 'genoa',
      comparisonComplete: over.comparisonComplete ?? true,
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.52 },
      // #259: only set when a test explicitly asks for it — most tests
      // exercise rigRecommendationOf's fallback (absent field).
      ...(over.rigRecommendation ? { rigRecommendation: over.rigRecommendation } : {}),
    },
  };
}

// #54: the pre-#54 shape exposed `plan.result.genoa`/`.fock`/`.shallow`
// directly-mutable; the `sails` list's own entries and PlanResultOk's own
// fields are now `readonly`, so a test that used to write
// `plan.result.genoa = X` instead REPLACES the whole `result` object
// (Plan.result itself is not readonly — only PlanResultOk's own fields are).
function setSail(plan: Plan, sailId: SailId, patch: { result?: RigResult | null }): void {
  plan.result = {
    ...plan.result,
    sails: plan.result.sails.map((s) => (s.sailId === sailId ? { ...s, ...patch } : s)),
  };
}

interface Overrides {
  harbors?: Harbor[];
  origin?: PickedPoint | null;
  destination?: PickedPoint | null;
  onPickOrigin?: (p: PickedPoint) => void;
  onPickDestination?: (p: PickedPoint) => void;
  onRequestMapTap?: (target: TapTarget) => void;
  viaPoints?: LatLon[];
  onRemoveVia?: (index: number) => void;
  onReorderVia?: (index: number, direction: 'up' | 'down') => void;
  onDepartureChange?: (ms: number) => void;
  settings?: Settings;
  onSettingsChange?: (s: typeof DEFAULT_SETTINGS) => void;
  // #539 item 2: overridable so a row can exercise a draft where the
  // per-boat floor and the catalogue default DISAGREE.
  boat?: BoatDef;
  canPlan?: boolean;
  planDisabledReason?: string | null;
  online?: boolean;
  onPlan?: () => void;
  planning?: PlannerStatus;
  plan?: Plan | null;
  rig?: SailId | null;
  formDirty?: boolean;
  onViewDetails?: () => void;
  onOpenBoatSettings?: () => void;
}

function baseProps(overrides: Overrides = {}) {
  return {
    harbors: HARBORS,
    origin: null,
    destination: null,
    onPickOrigin: vi.fn(),
    onPickDestination: vi.fn(),
    onImportRoute: vi.fn(),
    onRequestMapTap: vi.fn(),
    viaPoints: [],
    onRemoveVia: vi.fn(),
    onReorderVia: vi.fn(),
    departureMs: DEPARTURE_MS,
    onDepartureChange: vi.fn(),
    settings: DEFAULT_SETTINGS,
    onSettingsChange: vi.fn(),
    // #539 item 2: the panel derives its inline safety-depth bounds from
    // the SELECTED boat. This default keeps every pre-existing row on the
    // catalogue default boat, i.e. the 2.2 m floor they already assert.
    boat: boatById(DEFAULT_BOAT_ID),
    canPlan: true,
    planDisabledReason: null,
    online: true,
    onPlan: vi.fn(),
    planning: { phase: 'idle' } as PlannerStatus,
    plan: null as Plan | null,
    rig: null as SailId | null,
    formDirty: false,
    onViewDetails: vi.fn(),
    onOpenBoatSettings: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Overrides = {}) {
  localStorage.setItem('sc-lang', 'en');
  const props = baseProps(overrides);
  render(
    <I18nProvider>
      <PlannerPanel {...props} />
    </I18nProvider>,
  );
  return props;
}

// Same as renderPanel but exposes the container for class-based structural
// assertions (the skeleton/onboarding presentation carries no accessible role).
function renderPanelReturningContainer(overrides: Overrides = {}) {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <PlannerPanel {...baseProps(overrides)} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('nextFullHourMs', () => {
  it('rounds up to the next full hour, strictly after now', () => {
    const now = Date.UTC(2026, 6, 15, 14, 23, 10);
    const result = nextFullHourMs(now);
    expect(result).toBe(Date.UTC(2026, 6, 15, 15, 0, 0));
  });

  it('advances a full hour even when now already sits exactly on an hour boundary', () => {
    const now = Date.UTC(2026, 6, 15, 14, 0, 0);
    expect(nextFullHourMs(now)).toBe(Date.UTC(2026, 6, 15, 15, 0, 0));
  });

  it('always stays within [now, now + FORECAST_DAYS days]', () => {
    const now = Date.UTC(2026, 6, 15, 23, 50, 0);
    const result = nextFullHourMs(now);
    expect(result).toBeGreaterThan(now);
    expect(result).toBeLessThanOrEqual(now + FORECAST_DAYS * 86_400_000);
  });
});

describe('PlannerPanel', () => {
  it('shows a search combobox for each endpoint when none is selected', () => {
    renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
    expect(within(destinationSection).getByRole('combobox')).toBeInTheDocument();
  });

  it('renders the picked origin and destination labels', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
      destination: {
        source: 'harbor',
        point: MARSTAL.snap,
        harborId: MARSTAL.id,
        label: 'Marstal',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(destinationSection).getByText('Marstal', { selector: 'p' })).toBeInTheDocument();
  });

  it('collapses a selected endpoint to a row (name + Change), hiding the combobox but keeping map-pick', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Pick on map' })).toBeInTheDocument();
    expect(within(originSection).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('reopens the combobox when Change is clicked on a selected endpoint', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
  });

  // #737: reopening a picked endpoint via "Ändern"/"Change" used to drop
  // focus to <body> — the Change button unmounts and nothing called
  // .focus() on the combobox that replaced it (the OPENING side of #695,
  // which only covers the four EXIT paths). Mutation-checked: removing the
  // `autoFocus={editingOrigin}`/`autoFocus={editingDestination}` prop wiring
  // in PlannerPanel.tsx reds exactly these two rows.
  it('#737: focuses the origin combobox when Change reopens it', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    expect(within(originSection).getByRole('combobox')).toHaveFocus();
  });

  it('#737: focuses the destination combobox when Change reopens it', () => {
    renderPanel({
      destination: {
        source: 'harbor',
        point: MARSTAL.snap,
        harborId: MARSTAL.id,
        label: 'Marstal',
      },
    });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.click(within(destinationSection).getByRole('button', { name: 'Change' }));
    expect(within(destinationSection).getByRole('combobox')).toHaveFocus();
  });

  // #737 (design rule, see the module-level #695 comment this fix extends):
  // the trigger must be the Change click itself, never merely "a combobox is
  // showing" — a cold load with no endpoint picked yet also renders the
  // combobox (origin/destination null), and that path must NOT steal focus.
  it('#737: does not autofocus the origin combobox on initial mount before anything is picked', () => {
    renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    expect(within(originSection).getByRole('combobox')).not.toHaveFocus();
  });

  it('reverts a re-picked selected endpoint to its row when the search is dismissed with Escape', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(within(originSection).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('reverts a re-picked selected endpoint to its row when the search loses focus without a pick', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.blur(combobox);
    expect(within(originSection).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  // #695: all four HarborPicker exit paths (origin/destination x select/
  // cancel) used to drop focus to <body> — the combobox unmounted and
  // nothing called .focus() on the "Ändern"/"Change" button that replaced
  // it. These four rows are the missing guards the issue itself calls out;
  // each is mutation-checked in the PR report by removing exactly one
  // exit path's restoration and confirming only that row reds.
  it('#695: returns focus to the origin Change button after selecting a harbor from a re-picked search', async () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    fireEvent.change(within(originSection).getByRole('combobox'), { target: { value: 'Marstal' } });
    fireEvent.click(within(originSection).getByRole('option', { name: 'Marstal' }));
    await waitFor(() =>
      expect(within(originSection).getByRole('button', { name: 'Change' })).toHaveFocus(),
    );
  });

  it('#695: returns focus to the origin Change button after cancelling a re-picked search (Escape)', async () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape' });
    await waitFor(() =>
      expect(within(originSection).getByRole('button', { name: 'Change' })).toHaveFocus(),
    );
  });

  it('#695: returns focus to the destination Change button after selecting a harbor from a re-picked search', async () => {
    renderPanel({
      destination: {
        source: 'harbor',
        point: MARSTAL.snap,
        harborId: MARSTAL.id,
        label: 'Marstal',
      },
    });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.click(within(destinationSection).getByRole('button', { name: 'Change' }));
    fireEvent.change(within(destinationSection).getByRole('combobox'), {
      target: { value: 'Flensburg' },
    });
    fireEvent.click(within(destinationSection).getByRole('option', { name: 'Flensburg' }));
    await waitFor(() =>
      expect(within(destinationSection).getByRole('button', { name: 'Change' })).toHaveFocus(),
    );
  });

  it('#695: returns focus to the destination Change button after cancelling a re-picked search (Escape)', async () => {
    renderPanel({
      destination: {
        source: 'harbor',
        point: MARSTAL.snap,
        harborId: MARSTAL.id,
        label: 'Marstal',
      },
    });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.click(within(destinationSection).getByRole('button', { name: 'Change' }));
    const combobox = within(destinationSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape' });
    await waitFor(() =>
      expect(within(destinationSection).getByRole('button', { name: 'Change' })).toHaveFocus(),
    );
  });

  // #695 (PR #736 review Minor): the four rows above all use a re-pick (the
  // endpoint already had a value, "Change" was clicked to reopen the
  // search), where `onPickOrigin` being a stub in `baseProps` doesn't matter
  // — `origin` was already truthy. A first-ever pick needs the picked value
  // to actually flow back into the `origin` prop for the Change button to
  // mount at all, so this row wraps PlannerPanel in a tiny stateful harness
  // that plays the role App.tsx plays in production.
  it('#695: returns focus to the origin Change button after a first-ever pick (previously null origin)', async () => {
    localStorage.setItem('sc-lang', 'en');
    function Harness() {
      const [origin, setOrigin] = useState<PickedPoint | null>(null);
      return <PlannerPanel {...baseProps({ origin, onPickOrigin: setOrigin })} />;
    }
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>,
    );
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.change(within(originSection).getByRole('combobox'), { target: { value: 'Marstal' } });
    fireEvent.click(within(originSection).getByRole('option', { name: 'Marstal' }));
    await waitFor(() =>
      expect(within(originSection).getByRole('button', { name: 'Change' })).toHaveFocus(),
    );
  });

  // #695 (PR #736 review Blocker): an earlier version of the fix keyed
  // restoration off a PROP diff (`!origin || editingOrigin` transitioning),
  // which also fired — and stole focus — whenever `origin`/`destination`
  // changed for any reason OTHER than a HarborPicker exit, e.g. App.tsx's
  // session/plan-restore sync effect setting them on cold load. This row
  // reproduces exactly that shape directly against PlannerPanel: an origin
  // prop change via `rerender`, with no picker interaction at all, must
  // leave focus wherever it already was.
  it('#695: does not move focus when the origin prop changes without a HarborPicker interaction', () => {
    localStorage.setItem('sc-lang', 'en');
    const { rerender } = render(
      <I18nProvider>
        <PlannerPanel {...baseProps({ origin: null })} />
      </I18nProvider>,
    );
    const departureField = screen.getByLabelText('Departure');
    departureField.focus();
    expect(departureField).toHaveFocus();

    rerender(
      <I18nProvider>
        <PlannerPanel
          {...baseProps({
            origin: {
              source: 'harbor',
              point: FLENSBURG.snap,
              harborId: FLENSBURG.id,
              label: 'Flensburg',
            },
          })}
        />
      </I18nProvider>,
    );

    expect(departureField).toHaveFocus();
  });

  it('keeps the combobox for a first, still-unselected endpoint when the search is dismissed', () => {
    renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
  });

  it('shows the full approach caveat on a selected endpoint row', () => {
    const noted: Harbor = {
      ...MARSTAL,
      approachNote: { de: 'Enge Zufahrt.', en: 'Narrow entrance.' },
    };
    renderPanel({
      harbors: [FLENSBURG, noted],
      origin: { source: 'harbor', point: noted.snap, harborId: noted.id, label: 'Marstal' },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    expect(within(originSection).getByText('Narrow entrance.')).toBeInTheDocument();
  });

  it('requests map-tap mode for the correct target when its "pick on map" button is clicked', () => {
    const props = renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Pick on map' }));
    expect(props.onRequestMapTap).toHaveBeenCalledWith('origin');

    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.click(within(destinationSection).getByRole('button', { name: 'Pick on map' }));
    expect(props.onRequestMapTap).toHaveBeenCalledWith('destination');
  });

  it('picking a harbor from the origin search calls onPickOrigin with a PickedPoint, not onPickDestination', () => {
    const props = renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.change(within(originSection).getByRole('combobox'), { target: { value: 'Marstal' } });
    fireEvent.click(within(originSection).getByRole('option', { name: 'Marstal' }));
    expect(props.onPickOrigin).toHaveBeenCalledWith({
      source: 'harbor',
      point: MARSTAL.snap,
      harborId: MARSTAL.id,
      label: 'Marstal',
    });
    expect(props.onPickDestination).not.toHaveBeenCalled();
  });

  it('picking a harbor from the destination search calls onPickDestination with a PickedPoint', () => {
    const props = renderPanel();
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.change(within(destinationSection).getByRole('combobox'), {
      target: { value: 'Flensburg' },
    });
    fireEvent.click(within(destinationSection).getByRole('option', { name: 'Flensburg' }));
    expect(props.onPickDestination).toHaveBeenCalledWith({
      source: 'harbor',
      point: FLENSBURG.snap,
      harborId: FLENSBURG.id,
      label: 'Flensburg',
    });
    expect(props.onPickOrigin).not.toHaveBeenCalled();
  });

  it('renders the departure time as a local datetime-local value and round-trips edits to epoch ms', () => {
    const props = renderPanel();
    const input = screen.getByLabelText('Departure') as HTMLInputElement;
    const expected = new Date(DEPARTURE_MS);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedValue = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}T${pad(expected.getHours())}:${pad(expected.getMinutes())}`;
    expect(input.value).toBe(expectedValue);

    fireEvent.change(input, { target: { value: '2026-07-21T10:30' } });
    expect(props.onDepartureChange).toHaveBeenCalledWith(new Date('2026-07-21T10:30').getTime());
  });

  it('#643 follow-up: the departure input stays CONTROLLED — its value tracks the departureMs prop across a re-render, not just at mount', () => {
    // An earlier version of this row fired an empty-string change event and
    // asserted the DOM value restored to the rendered prop. That is VACUOUS
    // in this codebase: MEASURED 2026-08-24 (jsdom here, plus real Chromium
    // 151.0.7922.34 and real WebKit 26.5 against two genuine `vite build`
    // outputs — see PR #665) that react-dom 19.2.8's own controlled-input
    // restore (`restoreStateOfTarget`) performs that exact resync
    // synchronously, in BOTH engines, WITH THE PRODUCTION RESYNC LINE
    // DELETED. So "fire an empty change, read the value back" cannot tell
    // this component's own resync apart from React's, and stays green
    // either way — a theorem given React's behavior, not a fact about this
    // component's code.
    //
    // What the #643 SYMPTOM (a required field frozen on a stale/empty value)
    // actually depends on is this input remaining a CONTROLLED React
    // element — i.e. its displayed value re-derives from the `departureMs`
    // PROP on every render, not merely once at mount. Both the resync write
    // in the handler and React's own restore work by writing the CURRENT
    // value prop into the DOM; neither can help once the element stops
    // being controlled (e.g. `value=` swapped for `defaultValue=`, an
    // easy-to-make, diff-innocuous mistake), because an uncontrolled
    // element's initial value is never revisited after mount.
    //
    // This row pins THAT — re-render with a DIFFERENT departureMs prop, no
    // onChange event fired at all — and is a real, mutation-checked
    // discriminator: switching `value=` to `defaultValue=` on the
    // production input (resync line left untouched) turns this row RED
    // (measured: `Expected: "2026-07-20T12:00", Received: "2026-07-20T11:00"`
    // — the input freezes at its mount-time value and never sees the
    // re-rendered prop); reverting turns it back GREEN. It intentionally
    // never fires onChange, so it does NOT discriminate for or against the
    // handler's own resync line — that line stays as documented,
    // measured-redundant defensive code.
    localStorage.setItem('sc-lang', 'en');
    const props = baseProps();
    const { rerender } = render(
      <I18nProvider>
        <PlannerPanel {...props} />
      </I18nProvider>,
    );
    const input = screen.getByLabelText('Departure') as HTMLInputElement;
    expect(input.value).toBe(toLocalInputValue(DEPARTURE_MS));

    const NEXT_DEPARTURE_MS = DEPARTURE_MS + 3_600_000;
    rerender(
      <I18nProvider>
        <PlannerPanel {...props} departureMs={NEXT_DEPARTURE_MS} />
      </I18nProvider>,
    );

    expect(input.value).toBe(toLocalInputValue(NEXT_DEPARTURE_MS));
    // Scope pin, unchanged in intent from the deleted row: no onChange event
    // was fired here at all, so this is trivially true — kept only to
    // document that a prop-driven re-render must never itself invoke the
    // callback.
    expect(props.onDepartureChange).toHaveBeenCalledTimes(0);
  });

  it('disables the plan button and shows the offline disabled reason (offline suppresses onboarding)', () => {
    // Offline: onboarding is suppressed (nothing can be planned), so the
    // disabled reason itself renders. role="alert" — an actionable blocker.
    renderPanel({
      canPlan: false,
      online: false,
      planDisabledReason: 'Wind forecast service is unreachable.',
    });
    expect(screen.getByRole('button', { name: 'Plan route' })).toBeDisabled();
    const reason = screen.getByText('Wind forecast service is unreachable.');
    expect(reason).toBeInTheDocument();
    expect(reason).toHaveAttribute('role', 'alert');
    // The empty-state onboarding must NOT also show — one message only.
    expect(
      screen.queryByText('Pick a start and destination to plan a route.'),
    ).not.toBeInTheDocument();
  });

  it('shows the missing-endpoints disabled reason (no onboarding) once a plan already exists', () => {
    // A plan exists but an endpoint is missing: onboarding (a first-run hint)
    // is gone, so the terse disabled reason renders instead.
    renderPanel({
      plan: makePlan(),
      rig: 'genoa',
      origin: null,
      destination: null,
      canPlan: false,
      planDisabledReason: 'Select a start and destination.',
    });
    expect(screen.getByText('Select a start and destination.')).toBeInTheDocument();
    expect(
      screen.queryByText('Pick a start and destination to plan a route.'),
    ).not.toBeInTheDocument();
  });

  it('enables the plan button and calls onPlan when clicked, with no reason shown', () => {
    const props = renderPanel({ canPlan: true, planDisabledReason: null });
    const button = screen.getByRole('button', { name: 'Plan route' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(props.onPlan).toHaveBeenCalled();
  });

  it('renders a fetching status message during planning.phase "fetching"', () => {
    renderPanel({ planning: { phase: 'fetching' } });
    expect(plannerStatus()).toHaveTextContent('Fetching wind forecast');
  });

  // #340: the readout is a bounded phase indicator ("sail N of 2 (Rig)"),
  // not a percentage — pinning literal text for both rigs so a mixed-up
  // index/rig-name substitution would fail visibly.
  it('renders the genoa routing phase as "sail 1 of 2 (Genoa)"', () => {
    renderPanel({ planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 } });
    expect(plannerStatus()).toHaveTextContent('Calculating route… sail 1 of 2 (Genoa)');
  });

  it('renders the fock routing phase as "sail 2 of 2 (Fock)" — the genoa->fock switch is not a regression', () => {
    renderPanel({ planning: { phase: 'routing', sailId: 'fock', index: 2, total: 2 } });
    expect(plannerStatus()).toHaveTextContent('Calculating route… sail 2 of 2 (Fock)');
  });

  it('does NOT render a plan-run error inline (the App banner is the single alert surface)', () => {
    // §3.5 consolidation: the error lives only in App.tsx's tab-independent
    // <Banner>, so it is never announced twice. The panel stays quiet.
    renderPanel({ planning: { phase: 'error', message: 'Open-Meteo is unreachable.' } });
    expect(screen.queryByText('Open-Meteo is unreachable.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('via waypoints', () => {
    const VIA_A = { lat: 54.8, lon: 9.9 };
    const VIA_B = { lat: 54.82, lon: 9.95 };

    it('shows no chip list when there are no via points', () => {
      renderPanel({ viaPoints: [] });
      const viaSection = screen.getByRole('region', { name: 'Waypoints' });
      expect(within(viaSection).queryByRole('list')).not.toBeInTheDocument();
    });

    it('requests map-tap mode for "via" when "Add waypoint" is clicked', () => {
      const props = renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Add waypoint' }));
      expect(props.onRequestMapTap).toHaveBeenCalledWith('via');
    });

    it('renders one chip per via point, formatted as a coordinate label', () => {
      renderPanel({ viaPoints: [VIA_A, VIA_B] });
      const viaSection = screen.getByRole('region', { name: 'Waypoints' });
      const items = within(viaSection).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent('54.800°N 9.900°E');
      expect(items[1]).toHaveTextContent('54.820°N 9.950°E');
    });

    it("removing a chip calls onRemoveVia with that chip's index", () => {
      const props = renderPanel({ viaPoints: [VIA_A, VIA_B] });
      fireEvent.click(screen.getByRole('button', { name: 'Remove waypoint 2' }));
      expect(props.onRemoveVia).toHaveBeenCalledWith(1);
    });

    it('reordering a chip calls onReorderVia with its index and direction', () => {
      const props = renderPanel({ viaPoints: [VIA_A, VIA_B] });
      fireEvent.click(screen.getByRole('button', { name: 'Move waypoint 2 up' }));
      expect(props.onReorderVia).toHaveBeenCalledWith(1, 'up');
      fireEvent.click(screen.getByRole('button', { name: 'Move waypoint 1 down' }));
      expect(props.onReorderVia).toHaveBeenCalledWith(0, 'down');
    });

    it('disables the first chip\'s "move up" and the last chip\'s "move down" buttons', () => {
      renderPanel({ viaPoints: [VIA_A, VIA_B] });
      expect(screen.getByRole('button', { name: 'Move waypoint 1 up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 2 down' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 1 down' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 2 up' })).toBeEnabled();
    });

    // #571 redesign: a via edit never replans in place any more (only the
    // Plan-route button does — see App.tsx's handleViaPointsChange), so
    // there is no in-flight-replan state left to disable these controls
    // for. Add/Remove are never boundary-gated either way, which is what
    // makes them a clean, unconditional assertion.
    it("#571 redesign: Add/Remove waypoint stay enabled — via editing is now plain, synchronous form state with nothing to be 'in flight'", () => {
      renderPanel({ viaPoints: [VIA_A] });
      expect(screen.getByRole('button', { name: 'Add waypoint' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Remove waypoint 1' })).toBeEnabled();
    });
  });

  // §3.3 / #299: safety depth stays inline in the compact row; the rest of
  // what used to sit behind "Erweitert" moved to the dedicated Boat tab
  // (SettingsPanel.tsx, covered by SettingsPanel.test.tsx) — this panel no
  // longer renders it at all, only a discoverable link back to it.
  describe('safety depth compact row + boat-settings link (§3.3, #299)', () => {
    it('keeps departure AND safety depth visible in the compact row', () => {
      renderPanel();
      expect(screen.getByLabelText('Departure')).toBeInTheDocument();
      expect(screen.getByLabelText('Safety depth (m)')).toBeInTheDocument();
    });

    // #699: the boat-dependent min/max previously existed only as native
    // min/max attributes on the <input> — never as visible or
    // accessible-description text. Assert BOTH halves: the wiring
    // (aria-describedby actually pointing at the help paragraph's id) and
    // the paragraph's own text, so a broken id match can't pass by
    // coincidence with a help paragraph that merely exists somewhere.
    // Both bounds go through formatDepthM (fractionDigits defaults to 1),
    // so max renders "10.0" here, not a bare "10" — see the review-fix test
    // below for why passing raw numbers was wrong in the first place.
    it('#699: discloses the allowed range as visible, described help text', () => {
      renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      expect(input).toHaveAttribute('aria-describedby', 'planner-safety-depth-help');
      const help = document.getElementById('planner-safety-depth-help');
      expect(help).not.toBeNull();
      // #744: toHaveTextContent's default normalizeWhitespace path collapses
      // the dict's \u00A0 (non-breaking space, before the unit) to a plain
      // space on the RECEIVED side only — the expected string built from the
      // dict template is compared verbatim, so it needs the same collapse or
      // this assertion never matches.
      expect(help).toHaveTextContent(
        en['options.safetyDepth.help']
          .replace('{min}', '2.2')
          .replace('{max}', '10.0')
          .replace('\u00A0', ' '),
      );
    });

    // #539 item 2: the help text's range must follow the SELECTED boat, not
    // the catalogue default — same boat-dependence the clamp-floor test
    // above pins for the numeric bound.
    it('#699: the help text range follows the SELECTED boat', () => {
      renderPanel({ boat: { ...boatById(DEFAULT_BOAT_ID), id: 'deep-46', draftM: 2.3 } });
      const help = document.getElementById('planner-safety-depth-help');
      // #744: see the sibling test above for why this needs the same
      // \u00A0-to-space collapse.
      expect(help).toHaveTextContent(
        en['options.safetyDepth.help']
          .replace('{min}', '2.4')
          .replace('{max}', '10.0')
          .replace('\u00A0', ' '),
      );
    });

    // #699 REVIEW FIX (MAJOR): useT()'s interpolation is a bare
    // String(v) (i18n/index.tsx) — locale-blind, always a decimal POINT.
    // Passing raw numbers as {min}/{max} therefore rendered a German
    // decimal POINT ("Erlaubter Bereich: 2.2-10 m"), contradicting the
    // comma convention every OTHER depth figure in this app uses via
    // formatDepthM — including this very PR's own boat.clamp.notice two
    // components over ("Sicherheitstiefe auf 2,4 m angehoben"). renderPanel()
    // hardcodes English, so this test renders directly under 'de' to reach
    // the gap no other row in this describe block exercises. MUTATION-CHECKED:
    // reverting PlannerPanel.tsx's help vars to the bare numbers (no
    // formatDepthM) reds this row, rendering the point form instead of the
    // comma form asserted here.
    it('#699: renders the range with the LOCALE decimal separator (German comma, not a point)', () => {
      localStorage.setItem('sc-lang', 'de');
      const props = baseProps();
      render(
        <I18nProvider>
          <PlannerPanel {...props} />
        </I18nProvider>,
      );
      const help = document.getElementById('planner-safety-depth-help');
      expect(help).toHaveTextContent('Erlaubter Bereich: 2,2–10,0 m');
    });

    it('commits a clamped safety depth on blur (max 10)', () => {
      const props = renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '12' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(10);
      expect(props.onSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_SETTINGS,
        safetyDepthM: 10,
      });
    });

    it('clamps safety depth below the 2.2 m floor (never below draft + margin)', () => {
      const props = renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(2.2);
      expect(props.onSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_SETTINGS,
        safetyDepthM: 2.2,
      });
    });

    it('#539 item 2: the inline floor follows the SELECTED boat, not the catalogue default', () => {
      // The clamp row above pins 2.2 m for the default boat; this pins that
      // the floor is DERIVED rather than fixed. 2.30 m draft -> spec J OQ-1's
      // `draftM + 0.1` -> 2.4, so a panel still reading the module-level
      // SAFETY_DEPTH_FIELD would clamp a 2.30 m keel to 2.2 m — under its own
      // hull, on the quiet path that produces no `shallow` block and so
      // discloses nothing.
      const props = renderPanel({
        boat: { ...boatById(DEFAULT_BOAT_ID), id: 'deep-46', draftM: 2.3 },
      });
      const input = screen.getByLabelText('Safety depth (m)');
      expect(input).toHaveAttribute('min', '2.4');
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(2.4);
      expect(props.onSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_SETTINGS,
        safetyDepthM: 2.4,
      });
    });

    // #731: the silent blur-clamp now reports a visible correction, scoped
    // to `.planner-safety-depth` throughout — PlannerPanel also renders an
    // ALWAYS-MOUNTED `.planner-status` `role="status"` live region (the
    // "plan ready" announcement), so an unscoped role query would throw on
    // multiple matches.
    //
    // MOUNT SHAPE (PR #758 review round 2): the notice is now ALWAYS
    // mounted (matching BoatPicker's own #563 shape), empty until a
    // correction — never absent — so `notice()` below always finds the
    // element and "no notice" is asserted as EMPTY text content, never as
    // `.toBeNull()`.
    describe('#731: blur-clamp correction notice', () => {
      function notice(): HTMLElement {
        const el = document.querySelector('.planner-safety-depth .boat-picker-notice');
        if (!el) throw new Error('expected the always-mounted #731 notice element to exist');
        return el as HTMLElement;
      }

      // The assertion that distinguishes always-mounted from conditionally-
      // mounted (PR #758 review round 2): the live region must exist in the
      // DOM BEFORE any correction has happened, or AT has nothing to
      // observe a later text mutation on.
      it('mounts the correction live region BEFORE any correction has occurred', () => {
        renderPanel();
        const el = notice();
        expect(el).toBeInTheDocument();
        expect(el).toHaveAttribute('role', 'status');
        expect(el).toHaveTextContent('');
      });

      it('shows the notice after a real out-of-range commit, unit-less (the label already carries one)', () => {
        const props = renderPanel();
        const input = screen.getByLabelText('Safety depth (m)');
        fireEvent.change(input, { target: { value: '1' } });
        fireEvent.blur(input);
        expect(props.onSettingsChange).toHaveBeenCalledWith({
          ...DEFAULT_SETTINGS,
          safetyDepthM: 2.2,
        });
        expect(notice()).toHaveAttribute('role', 'status');
        expect(notice()).toHaveTextContent('Corrected to 2.2 (allowed range 2.2–10)');
      });

      it('shows no notice for an in-range commit', () => {
        renderPanel();
        const input = screen.getByLabelText('Safety depth (m)');
        fireEvent.change(input, { target: { value: '5' } });
        fireEvent.blur(input);
        expect(notice()).toHaveTextContent('');
      });

      it('clears a previous notice once a later commit lands in range', () => {
        renderPanel();
        const input = screen.getByLabelText('Safety depth (m)');
        fireEvent.change(input, { target: { value: '1' } });
        fireEvent.blur(input);
        expect(notice()).not.toHaveTextContent('');
        fireEvent.change(input, { target: { value: '5' } });
        fireEvent.blur(input);
        expect(notice()).toHaveTextContent('');
      });

      // The DoD's own required browser-pass scenario, reproduced as a unit
      // test: a boat switch that moves safety depth's own bounds
      // (elan-444-piranja's 1.9 m draft -> 2.0 m floor, vs the Salona 45's
      // 2.1 m -> 2.2 m) must not leave a stale "corrected to 2.2" notice
      // standing once the field it was correcting no longer has that floor.
      it('clears a stale notice when a boat switch moves the field bounds out from under it', () => {
        localStorage.setItem('sc-lang', 'en');
        const props = baseProps();
        const { rerender } = render(
          <I18nProvider>
            <PlannerPanel {...props} />
          </I18nProvider>,
        );
        const input = screen.getByLabelText('Safety depth (m)');
        fireEvent.change(input, { target: { value: '1' } });
        fireEvent.blur(input);
        expect(notice()).not.toHaveTextContent('');
        rerender(
          <I18nProvider>
            <PlannerPanel {...props} boat={boatById('elan-444-piranja')} />
          </I18nProvider>,
        );
        expect(notice()).toHaveTextContent('');
      });
    });

    it('no longer renders the advanced fields/disclosure inline — they moved to the Boat tab', () => {
      localStorage.setItem('sc-lang', 'en');
      const { container } = render(
        <I18nProvider>
          <PlannerPanel {...baseProps()} />
        </I18nProvider>,
      );
      expect(container.querySelector('details.planner-advanced')).toBeNull();
      expect(screen.queryByLabelText('Motoring speed (kn)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Depth comfort margin (m)')).not.toBeInTheDocument();
    });

    it('renders a discoverable link to the Boat tab next to safety depth, naming the depth comfort margin', () => {
      const props = renderPanel();
      const link = screen.getByRole('button', {
        name: /More boat settings.*depth comfort margin/,
      });
      expect(link).toBeInTheDocument();
      fireEvent.click(link);
      expect(props.onOpenBoatSettings).toHaveBeenCalledTimes(1);
    });
  });

  // §3.4 (Option B): compact Ergebnis strip + completion announcement.
  describe('compact Ergebnis strip (§3.4)', () => {
    it('renders no Ergebnis strip before a plan exists', () => {
      renderPanel({ plan: null, rig: null });
      expect(screen.queryByRole('button', { name: /View details/ })).not.toBeInTheDocument();
    });

    it('renders the strip with distance, avg speed and a faster-rig chip once a plan is present', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa' });
      // 21.5 nm / 5 h = 4.3 kn (hand-derived).
      expect(screen.getByText('21.5 nm')).toBeInTheDocument();
      expect(screen.getByText('4.3 kn')).toBeInTheDocument();
      expect(screen.getByText('Faster: Genoa')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /View details/ })).toBeInTheDocument();
    });

    it('"View details" calls onViewDetails (tab switch + focus handled by the parent)', () => {
      const props = renderPanel({ plan: makePlan(), rig: 'genoa' });
      fireEvent.click(screen.getByRole('button', { name: /View details/ }));
      expect(props.onViewDetails).toHaveBeenCalledTimes(1);
    });

    it('swaps the status live region to the completion summary on the routing->idle transition', () => {
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 },
              plan: null,
              rig: null,
            })}
          />
        </I18nProvider>,
      );
      // In-flight: the region shows the routing message.
      expect(plannerStatus()).toHaveTextContent('Calculating route');

      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa' })}
          />
        </I18nProvider>,
      );
      const status = plannerStatus();
      // Stable summary swapped into the SAME region (no second live region).
      expect(status).toHaveTextContent('Route calculated');
      expect(status).toHaveTextContent('21.5 nm');
      expect(status).toHaveTextContent('5 h 00 min');
    });

    it('does NOT re-announce on a same-id plan update (via-edit/slider re-render freezes the summary)', () => {
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 },
              plan: null,
              rig: null,
            })}
          />
        </I18nProvider>,
      );
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa' })}
          />
        </I18nProvider>,
      );
      expect(plannerStatus()).toHaveTextContent('21.5 nm');

      // A new plan OBJECT with the SAME id but a different distance (as a via
      // re-plan produces). The announcement must stay frozen at 21.5, proving
      // it did not re-derive/re-fire on a same-id update.
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan({ id: 'plan-1', distanceNm: 30 }),
              rig: 'genoa',
            })}
          />
        </I18nProvider>,
      );
      const status = plannerStatus();
      expect(status).toHaveTextContent('21.5 nm');
      expect(status).not.toHaveTextContent('30.0 nm');
    });

    it('does NOT announce on mount when a plan is already present (only on a genuine completion)', () => {
      renderPanel({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa' });
      // Seeded from the mount plan id, so re-entering the tab with an existing
      // result stays quiet — the region is empty, not restating the summary.
      expect(plannerStatus().textContent).toBe('');
    });
  });

  // #452: the shallow-water warning + the effective (relaxed) depth must be
  // visible on THIS strip — the first surface a user sees a result on —
  // without switching to the Routes tab. Distinct requested/used/minGate
  // values (3.0 / 2.5 / 2.3) so a test asserting on `usedDepthM` cannot pass
  // by accident against `minGateDepthM` or `requestedDepthM` instead.
  describe('shallow-water warning (#452)', () => {
    function makeShallowPlan(): Plan {
      const plan = makePlan();
      plan.result = {
        ...plan.result,
        shallow: { requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.3 },
      };
      return plan;
    }

    it('renders the plan-level shallow warning, naming the effective (used) depth', () => {
      renderPanel({ plan: makeShallowPlan(), rig: 'genoa' });
      // #504 wave 5: pin the PROPERTY (the shallow warning is announced as an
      // alert region), not which tag happens to carry role="alert" — the
      // wave 4 restructure moved it onto a wrapping <div>, an implementation
      // detail this assertion no longer depends on.
      const banner = screen.getByRole('alert');
      expect(banner).toHaveTextContent(/was not passable/);
      expectShallowDetailOpen(false);
      // Requested depth.
      expect(banner.textContent).toContain('3.0 m');
      // #452: the effective depth the route was actually computed at — the
      // defect this test guards was that usedDepthM rendered nowhere.
      expect(banner.textContent).toContain('2.5 m');
      // Shallowest charted depth crossed by the plan (Minor 5, PR #461: not
      // "actually crossed" — minGateDepthM folds over BOTH rigs' legs, so on
      // one rig's tab it can name the OTHER rig's leg).
      expect(banner.textContent).toContain('2.3 m');
      // Honest passage-planning-aid copy (#455): never claims an unflagged
      // section IS safe. review (PR #461 Major 3): the ORIGINAL
      // `/\bis (verified|guaranteed)\b/i` matched only those two exact word
      // pairs, so appending "All unmarked water on this route is safe." to
      // the EN string reproduced 91/91 GREEN — measured directly against
      // this branch before this fix. Widened to also catch "is/are safe" and
      // "is/are clear", the reviewer's specific counter-example. NARROWED,
      // NOT CLOSED (re-run against MY OWN replacement, per the fix-wave
      // brief): appending "This route poses no risk beyond the marked
      // sections." to the EN string still passes the WIDENED regex too —
      // no finite word list closes this class for free-form prose. The
      // POSITIVE `toContain` below is what actually earns its
      // keep (it reds the moment the required hedge clause is removed,
      // added-to, or reworded away); this negative check is a regression pin
      // against the two SPECIFIC phrasings already seen going wrong, not a
      // content classifier.
      expect(banner.textContent).not.toMatch(/\b(is|are) (safe|clear|verified|guaranteed)\b/i);
      expect(banner.textContent).toContain('not guaranteed to be clear');
    });

    it('is absent on a plan with no relaxation', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa' });
      // PR #763 review Minor 7: ABSENCE check, not a visibility one — see
      // RouteSummary.test.tsx's twin comment. No ShallowWarning mounts at
      // all on a non-relaxed plan, so there is no Disclosure open/closed
      // state for this assertion to distinguish.
      expect(screen.queryByText(/was not passable/)).not.toBeInTheDocument();
    });

    it('is absent before any plan exists', () => {
      renderPanel({ plan: null, rig: null });
      expect(screen.queryByText(/was not passable/)).not.toBeInTheDocument();
    });

    // Review finding (PR #461 Major 1): the warning is plan-level, but its
    // OLD render site lived inside a `summary &&` gate, and `summary` is
    // null whenever the ACTIVE rig's own result is null — so a user on the
    // rig tab whose solve failed saw no warning for a plan that carries one.
    // `makeShallowPlan()` -> `makePlan()` sets `fock: null` by default
    // (`fockReason: 'calm-motor-off'`), which is exactly this shape; viewing
    // it on the fock tab reproduces the reviewer's measured probe.
    it('#452 Major 1: still renders when the ACTIVE rig itself has no result', () => {
      renderPanel({ plan: makeShallowPlan(), rig: 'fock' });
      const banner = screen.getByText(/was not passable/);
      expect(banner).toBeInTheDocument();
      expectShallowDetailOpen(false);
      // No summary-dependent content exists for fock — the warning is the
      // only thing this rig's strip has to show; "View details" needs
      // `summary` too and must stay absent.
      expect(screen.queryByRole('button', { name: /View details/ })).not.toBeInTheDocument();
      // #452 gap 3: fock has no result here (no legs at all to inspect), so
      // the locator sentence must fail safe rather than crash or invent one.
      expect(banner.textContent).not.toContain('starts at');
    });
  });

  // #452 gap 3: the locator sentence appended to the shared ShallowWarning
  // banner — same shared component as RouteSummary's, so this only needs to
  // pin PlannerPanel's OWN call site (result.legs -> the `legs` prop) rather
  // than re-prove the sentence-selection logic itself (covered exhaustively
  // in RouteSummary.test.tsx).
  describe('shallow-water locator sentence (#452 gap 3)', () => {
    function makeNonContiguousShallowPlan(): Plan {
      const plan = makePlan();
      setSail(plan, 'genoa', { result: { ...GENOA_RESULT, legs: NON_CONTIGUOUS_SHALLOW_LEGS } });
      plan.result = {
        ...plan.result,
        shallow: { requestedDepthM: 3.0, usedDepthM: 2.3, minGateDepthM: 1.9 },
      };
      return plan;
    }

    it('reports the right count and first occurrence for non-contiguous flagged legs', () => {
      renderPanel({ plan: makeNonContiguousShallowPlan(), rig: 'genoa' });
      const banner = screen.getByText(/was not passable/);
      expectShallowDetailOpen(false);
      const expected = en['route.shallow.locator.plural']
        .replace('{count}', '2')
        .replace('{time}', formatTime(PLAN_DEPARTURE_MS, 'en'));
      expect(banner.textContent).toContain(expected);
    });

    it('uses the singular sentence (no count) when exactly one leg is flagged', () => {
      const plan = makeNonContiguousShallowPlan();
      // Drop the second flagged leg (index 2) — exactly one remains.
      setSail(plan, 'genoa', {
        result: {
          ...GENOA_RESULT,
          legs: [NON_CONTIGUOUS_SHALLOW_LEGS[0], NON_CONTIGUOUS_SHALLOW_LEGS[1]],
        },
      });
      renderPanel({ plan, rig: 'genoa' });
      const banner = screen.getByText(/was not passable/);
      expectShallowDetailOpen(false);
      const expected = en['route.shallow.locator'].replace(
        '{time}',
        formatTime(PLAN_DEPARTURE_MS, 'en'),
      );
      expect(banner.textContent).toContain(expected);
      expect(banner.textContent).not.toContain('legs are affected');
    });

    it('omits the locator sentence when relaxation fired but no individual leg is flagged', () => {
      // The default GENOA_LEGS fixture never sets leg.shallow — the
      // plan-level banner still renders, but the locator sentence must fail
      // safe rather than render a nonsensical "0 legs" sentence.
      const plan = makePlan();
      plan.result = {
        ...plan.result,
        shallow: { requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.3 },
      };
      renderPanel({ plan, rig: 'genoa' });
      const banner = screen.getByText(/was not passable/);
      expectShallowDetailOpen(false);
      expect(banner.textContent).not.toContain('starts at');
    });
  });

  // #301: the dirty-form indicator — a second Chip in the Ergebnis card,
  // always on the broad `formDirty` regardless of `settingsDirty`.
  //
  // The live region is more subtle. #486 review (Minor 5) originally removed
  // an EARLIER fold of the stale sentence into this region entirely,
  // reasoning that App.tsx's tab-independent `settingsDirty` Banner "already
  // announces this exact sentence whenever it's true" — TRUE only for the
  // settings-only subset of dirtiness the Banner can see, and FALSE for
  // `formDirty && !settingsDirty` (e.g. only the destination changed): that
  // case left the panel's ONE live region silently announcing nothing,
  // re-opening the exact accessibility gap #301 existed to close. Found by
  // an adversarial cross-PR composition sweep over the cumulative diff
  // (Refs #299) — no single hunk of #486 contained both the Banner add and
  // this removal, which is why per-hunk review passed it. Fixed by folding
  // on the COMPLEMENT of what the Banner covers: `settingsDirty` true → stay
  // silent (the Banner alone announces, preserving #486's real fix — no
  // double announcement); `formDirty && !settingsDirty` → fold the sentence
  // in (the Banner cannot see this case, so nothing else will announce it).
  describe('dirty-form indicator (#301) and the #299 live-region complement', () => {
    it('renders a second Chip when formDirty && summary', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa', formDirty: true });
      // `{ selector: 'span' }` targets the Chip specifically — with the
      // default (unchanged) settings, `settingsDirty` is false, so the live
      // region ALSO folds this same sentence in (a `<p>`, asserted in its
      // own tests below); scoping here keeps this test about the Chip only.
      expect(
        screen.getByText(en['planner.result.stale'], { selector: 'span' }),
      ).toBeInTheDocument();
      // Beside the existing faster-rig chip, not replacing it.
      expect(screen.getByText('Faster: Genoa')).toBeInTheDocument();
    });

    it('does NOT render the stale chip when formDirty is false', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa', formDirty: false });
      expect(screen.queryByText(en['planner.result.stale'])).not.toBeInTheDocument();
    });

    it('does NOT render the stale chip when formDirty is true but there is no result yet (no plan)', () => {
      renderPanel({ plan: null, rig: null, formDirty: true });
      expect(screen.queryByText(en['planner.result.stale'])).not.toBeInTheDocument();
    });

    // Case 1 (Refs #299): formDirty for a reason the Banner cannot see —
    // renderPanel()'s default `settings` prop is byte-identical to
    // makePlan()'s own `request.settings` (both DEFAULT_SETTINGS), so
    // `settingsDirty` is false here and `formDirty: true` can only be
    // standing in for an endpoint/departure edit. The status region must
    // announce it — mutation check: reverting the `!settingsDirty` fold back
    // to the #486 shape (statusText = announcement only) fails this with
    // `Received: ""`.
    it('DOES fold the stale sentence into the panel status region when formDirty && !settingsDirty', () => {
      renderPanel({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa', formDirty: true });
      // 2, not 1, since #731: `.planner-status` (this test's subject) plus
      // the always-mounted `.boat-picker-notice` blur-clamp notice on the
      // compact row's safety-depth field (empty here — no clamp occurred).
      // The count still guards against an ACCIDENTAL third/duplicate live
      // region; it just isn't 1 any more now that #731 added a second,
      // legitimate one.
      expect(screen.getAllByRole('status')).toHaveLength(2);
      // No fresh completion announcement fires on this mount (seeded from
      // the mount plan id, per the transition tests above), so the region's
      // entire text is the folded stale sentence.
      expect(plannerStatus().textContent).toBe(en['planner.result.stale']);
      // The Chip (asserted above) stays visible too — both surfaces show it,
      // this is not a replacement. `{ selector: 'span' }` targets the Chip
      // specifically, since the live region just asserted above ALSO
      // contains this exact text now.
      expect(
        screen.getByText(en['planner.result.stale'], { selector: 'span' }),
      ).toBeInTheDocument();
    });

    // Case 2 (Refs #299): settingsDirty true — the Banner (App.tsx) already
    // announces this. The panel's live region MUST stay silent, or a
    // Plan-tab user hears the identical sentence twice — exactly the
    // double-announcement #486 was right to remove. Mutation check: folding
    // unconditionally on `formDirty` (dropping the `!settingsDirty` term)
    // fails this with `Received: "<en['planner.result.stale']>"` — the
    // sentence appearing where it must not.
    it('does NOT fold the stale sentence into the panel status region when settingsDirty is true', () => {
      const driftedSettings: Settings = { ...DEFAULT_SETTINGS, maneuverPenaltyS: 999 };
      renderPanel({
        planning: { phase: 'idle' },
        plan: makePlan(),
        rig: 'genoa',
        formDirty: true,
        settings: driftedSettings,
      });
      expect(plannerStatus().textContent).toBe('');
      // The Chip still shows — it stays on the broader `formDirty`
      // regardless of `settingsDirty` (see its own comment in the source).
      expect(screen.getByText(en['planner.result.stale'])).toBeInTheDocument();
    });

    it('a genuine completion announcement folds the stale suffix on when formDirty && !settingsDirty', () => {
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 },
              plan: null,
              rig: null,
            })}
          />
        </I18nProvider>,
      );
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan(),
              rig: 'genoa',
              formDirty: true,
            })}
          />
        </I18nProvider>,
      );
      const status = plannerStatus();
      const text = status.textContent ?? '';
      expect(text).toContain('Route calculated');
      expect(text).toContain(en['planner.result.stale']);
    });

    it('a genuine completion announcement does NOT fold the stale suffix on when settingsDirty is true', () => {
      localStorage.setItem('sc-lang', 'en');
      const driftedSettings: Settings = { ...DEFAULT_SETTINGS, maneuverPenaltyS: 999 };
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 },
              plan: null,
              rig: null,
            })}
          />
        </I18nProvider>,
      );
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan(),
              rig: 'genoa',
              formDirty: true,
              settings: driftedSettings,
            })}
          />
        </I18nProvider>,
      );
      const status = plannerStatus();
      const text = status.textContent ?? '';
      expect(text).toContain('Route calculated');
      expect(text).not.toContain(en['planner.result.stale']);
    });
  });

  // §3.5: empty/first-run onboarding + loading skeleton.
  describe('states & motion (§3.5)', () => {
    const ORIGIN: PickedPoint = {
      source: 'harbor',
      point: FLENSBURG.snap,
      harborId: FLENSBURG.id,
      label: 'Flensburg',
    };
    const DESTINATION: PickedPoint = {
      source: 'harbor',
      point: MARSTAL.snap,
      harborId: MARSTAL.id,
      label: 'Marstal',
    };

    it('shows the onboarding line when no plan exists and an endpoint is unpicked', () => {
      renderPanel({ origin: null, destination: null, plan: null });
      expect(screen.getByText('Pick a start and destination to plan a route.')).toBeInTheDocument();
    });

    it('hides the onboarding line once both endpoints are set', () => {
      renderPanel({ origin: ORIGIN, destination: DESTINATION, plan: null });
      expect(
        screen.queryByText('Pick a start and destination to plan a route.'),
      ).not.toBeInTheDocument();
    });

    it('hides the onboarding line once a plan exists', () => {
      renderPanel({ origin: null, destination: null, plan: makePlan(), rig: 'genoa' });
      expect(
        screen.queryByText('Pick a start and destination to plan a route.'),
      ).not.toBeInTheDocument();
    });

    it('suppresses the onboarding line while offline (the offline reason takes its place)', () => {
      renderPanel({ online: false, origin: null, destination: null, plan: null });
      expect(
        screen.queryByText('Pick a start and destination to plan a route.'),
      ).not.toBeInTheDocument();
    });

    it('renders a decorative skeleton in the result slot while a first plan is in flight', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 },
        plan: null,
        rig: null,
      });
      const skeletonCard = container.querySelector('.planner-result-skeleton');
      expect(skeletonCard).not.toBeNull();
      expect(skeletonCard).toHaveAttribute('aria-hidden', 'true');
      // Placeholder shapes: one chip + four stat blocks (matching the compact card).
      expect(skeletonCard!.querySelectorAll('.sc-skeleton')).toHaveLength(5);
      // The live status region still carries the a11y feedback (not the skeleton).
      expect(plannerStatus()).toHaveTextContent('Calculating route');
    });

    it('shows no skeleton once a result is present (real card replaces it)', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan(),
        rig: 'genoa',
      });
      expect(container.querySelector('.planner-result-skeleton')).toBeNull();
    });

    it('shows no skeleton while idle before any planning has started', () => {
      const { container } = renderPanelReturningContainer({ planning: { phase: 'idle' } });
      expect(container.querySelector('.planner-result-skeleton')).toBeNull();
    });

    it('shows no skeleton while re-planning an existing result — the live card stays, not stacked', () => {
      // Replan case: in-flight (routing) WITH an existing summary. The `!summary`
      // gate must keep the real compact Ergebnis card and NOT overlay a skeleton
      // on top of it. Mutating the gate to drop `!summary` makes this fail.
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'routing', sailId: 'genoa', index: 1, total: 2 },
        plan: makePlan(),
        rig: 'genoa',
      });
      expect(container.querySelector('.planner-result-skeleton')).toBeNull();
      // The real card (its faster-rig chip only exists on the real Ergebnis card).
      expect(container.querySelector('.chip-faster-rig')).not.toBeNull();
    });

    it('#259: a tie comparison renders the honest tie chip, not "Faster: X"', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({ rigRecommendation: { kind: 'tie' } }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).toBe('Genoa and Fock are effectively tied for this passage');
    });

    it('#259: a moot (all-motor) comparison renders the honest moot chip, not "Faster: X"', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({ rigRecommendation: { kind: 'moot' } }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).toBe(
        'Rig does not matter here — this passage runs entirely under engine',
      );
    });

    // #553: the MIRROR of RouteSummary.test.tsx's not-compared row. These are
    // two independent call sites and #259's own banner is about exactly this
    // pair drifting apart, so one row cannot stand in for the other.
    it('#553: a not-compared verdict renders the honest no-comparison chip', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({ rigRecommendation: { kind: 'not-compared' } }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).toBe(
        'The sails were not compared for this passage, so no faster rig is claimed',
      );
    });

    // #540 spec §E.3: same 'not-compared' verdict as the row above, but the
    // DISCRIMINATING control (comparisonComplete: false) — the
    // budget-truncated sentence must render INSTEAD of the generic
    // rigNotCompared one used by the #553 row.
    it('#540: a not-compared verdict with comparisonComplete false renders the budget-truncated chip, not the generic one', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({
          rigRecommendation: { kind: 'not-compared' },
          comparisonComplete: false,
        }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).toBe(
        'The search ran out of time before comparing both sails, so no faster rig is claimed',
      );
    });

    // #540: comparisonComplete true (the #553 row's default) must never
    // show the budget-specific sentence — pinned explicitly rather than
    // relying on the #553 row above staying byte-exact by coincidence.
    it('#540: a not-compared verdict with comparisonComplete true never shows the budget-truncated chip', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({ rigRecommendation: { kind: 'not-compared' } }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).not.toBe(
        'The search ran out of time before comparing both sails, so no faster rig is claimed',
      );
    });
  });
});

describe('GPX import — file-size DoS guard (#3 hardening)', () => {
  it('rejects an oversized file with the too-large error and never reads it', async () => {
    renderPanel();
    const fileInput = document.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('import file input not found');

    // A tiny File whose reported .size is stubbed one byte past the cap, so the
    // guard fires without allocating a real >10 MB blob. The text() spy is the
    // load-bearing assertion: the rejection must happen BEFORE any read, so the
    // hundreds-of-MB file is never pulled into memory (parseGpx never runs).
    const file = new File(['<gpx/>'], 'huge.gpx', { type: 'application/gpx+xml' });
    Object.defineProperty(file, 'size', { value: MAX_GPX_FILE_BYTES + 1 });
    const textSpy = vi.spyOn(file, 'text');

    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText(en['planner.import.error.tooLarge'])).toBeInTheDocument();
    expect(textSpy).not.toHaveBeenCalled();
  });
});
