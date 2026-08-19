import { describe, it, expect } from 'vitest';
import {
  ROUTING_RELEVANT_SETTINGS_KEYS,
  departureSeedMs,
  pickedPointsOfPlan,
  planFormDirty,
  type PlanFormSnapshot,
} from './planForm';
import { nextFullHourMs } from '../components/PlannerPanel';
import { formatLatLon } from './format';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type Harbor,
  type Plan,
  type PlanRequest,
  type Settings,
} from '../types';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

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

const HARBORS: Harbor[] = [FLENSBURG, MARSTAL];

const ORIGINAL_REQUEST: PlanRequest = {
  origin: { lat: 54.795, lon: 9.435 },
  destination: { lat: 54.855, lon: 10.52 },
  viaPoints: [{ lat: 54.83, lon: 9.9 }],
  originHarborId: 'flensburg',
  destinationHarborId: 'marstal',
  departureMs: 1_780_000_000_000,
  settings: {
    safetyDepthM: 2.3,
    depthComfortMarginM: 2.0,
    motorSpeedKn: 6.5,
    motorThresholdKn: 2.5,
    sailPreferenceKn: 2.8,
    maneuverPenaltyS: 45,
    performanceFactor: 0.9,
    motorEnabled: false,
    showOwnship: true,
  },
  sailIds: ['genoa', 'fock'],
  boat: defaultBoatSnapshot(),
};

function makePlan(request: PlanRequest = ORIGINAL_REQUEST): Plan {
  return {
    id: 'plan-1',
    name: 'Flensburg → Marstal',
    createdAtMs: 1_779_990_000_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request,
    windGrid: uniformWindGrid(12, 225),
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [],
            etaMs: 1_780_010_000_000,
            durationMs: 10_000_000,
            distanceNm: 30,
            maneuverCount: 2,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: 'calm-motor-off' },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: request.origin,
      snappedDestination: request.destination,
    },
  };
}

// The exact form snapshot that matches ORIGINAL_REQUEST byte-for-byte —
// every "not dirty" test starts here and mutates exactly one field.
function matchingForm(): PlanFormSnapshot {
  return {
    origin: {
      source: 'harbor',
      point: { lat: 54.795, lon: 9.435 },
      harborId: 'flensburg',
      label: 'Flensburg',
    },
    destination: {
      source: 'harbor',
      point: { lat: 54.855, lon: 10.52 },
      harborId: 'marstal',
      label: 'Marstal',
    },
    departureMs: 1_780_000_000_000,
    settings: { ...ORIGINAL_REQUEST.settings },
  };
}

describe('pickedPointsOfPlan (#301)', () => {
  it('resolves a harbor hit to a source:"harbor" PickedPoint with the current-language name', () => {
    const plan = makePlan();
    expect(pickedPointsOfPlan(plan, HARBORS, 'de')).toEqual({
      origin: {
        source: 'harbor',
        point: { lat: 54.795, lon: 9.435 },
        harborId: 'flensburg',
        label: 'Flensburg',
      },
      destination: {
        source: 'harbor',
        point: { lat: 54.855, lon: 10.52 },
        harborId: 'marstal',
        label: 'Marstal',
      },
    });
    expect(pickedPointsOfPlan(plan, HARBORS, 'en').origin.label).toBe('Flensburg');
  });

  it('falls back to a tap point when the harbor id is absent from the curated list', () => {
    const plan = makePlan({ ...ORIGINAL_REQUEST, originHarborId: 'not-in-the-list' });
    const { origin } = pickedPointsOfPlan(plan, HARBORS, 'de');
    expect(origin).toEqual({
      source: 'tap',
      point: { lat: 54.795, lon: 9.435 },
      label: formatLatLon({ lat: 54.795, lon: 9.435 }),
    });
  });

  it('falls back to tap points for both endpoints when both harbor ids are null', () => {
    const plan = makePlan({ ...ORIGINAL_REQUEST, originHarborId: null, destinationHarborId: null });
    const { origin, destination } = pickedPointsOfPlan(plan, HARBORS, 'en');
    expect(origin.source).toBe('tap');
    expect(destination.source).toBe('tap');
    expect(origin.label).toBe(formatLatLon(ORIGINAL_REQUEST.origin));
    expect(destination.label).toBe(formatLatLon(ORIGINAL_REQUEST.destination));
  });

  it('falls back to a tap point when harbors have not loaded yet (empty list)', () => {
    const plan = makePlan();
    const { origin } = pickedPointsOfPlan(plan, [], 'de');
    expect(origin.source).toBe('tap');
  });
});

describe('departureSeedMs (#301, extracted from PlansList.tsx:152)', () => {
  it('keeps the plan departure when it is still in the future', () => {
    const nowMs = 1_779_000_000_000;
    const plan = makePlan({ ...ORIGINAL_REQUEST, departureMs: nowMs + 3_600_000 });
    expect(departureSeedMs(plan, nowMs)).toBe(nowMs + 3_600_000);
  });

  it('seeds the next full hour when the plan departure has already passed', () => {
    const nowMs = Date.UTC(2026, 6, 15, 14, 23, 10);
    const plan = makePlan({ ...ORIGINAL_REQUEST, departureMs: nowMs - 3_600_000 });
    expect(departureSeedMs(plan, nowMs)).toBe(nextFullHourMs(nowMs));
    expect(departureSeedMs(plan, nowMs)).toBe(Date.UTC(2026, 6, 15, 15, 0, 0));
  });

  it('seeds the next full hour when the plan departure is exactly now', () => {
    const nowMs = Date.UTC(2026, 6, 15, 14, 0, 0);
    const plan = makePlan({ ...ORIGINAL_REQUEST, departureMs: nowMs });
    expect(departureSeedMs(plan, nowMs)).toBe(nextFullHourMs(nowMs));
  });
});

describe('planFormDirty (#301)', () => {
  it('is NOT dirty when the form matches the plan request exactly', () => {
    expect(planFormDirty(makePlan(), matchingForm(), true)).toBe(false);
  });

  it('is dirty when departureMs differs', () => {
    const form = { ...matchingForm(), departureMs: ORIGINAL_REQUEST.departureMs + 3_600_000 };
    expect(planFormDirty(makePlan(), form, true)).toBe(true);
  });

  it('is dirty when the origin point differs', () => {
    const form = matchingForm();
    form.origin = { ...form.origin, point: { lat: 54.8, lon: 9.435 } };
    expect(planFormDirty(makePlan(), form, true)).toBe(true);
  });

  it('is dirty when the origin harbor id differs (a different harbor pick at the same point is very unlikely, but the id is compared independently)', () => {
    const form = matchingForm();
    form.origin = { source: 'tap', point: form.origin.point, label: 'tap label' };
    expect(planFormDirty(makePlan(), form, true)).toBe(true);
  });

  it('is dirty when the destination point differs', () => {
    const form = matchingForm();
    form.destination = { ...form.destination, point: { lat: 54.9, lon: 10.52 } };
    expect(planFormDirty(makePlan(), form, true)).toBe(true);
  });

  it('is dirty when the destination harbor id differs', () => {
    const form = matchingForm();
    form.destination = { source: 'tap', point: form.destination.point, label: 'tap label' };
    expect(planFormDirty(makePlan(), form, true)).toBe(true);
  });

  // One row per routing-relevant field — each alone must flip the predicate.
  it.each(ROUTING_RELEVANT_SETTINGS_KEYS)('is dirty when %s alone differs', (key) => {
    const form = matchingForm();
    const current = ORIGINAL_REQUEST.settings[key];
    const bumped: Settings = {
      ...form.settings,
      [key]: typeof current === 'boolean' ? !current : current + 1,
    };
    form.settings = bumped;
    expect(planFormDirty(makePlan(), form, true)).toBe(true);
  });

  // The falsifiable rows (#301 design doc §2): these three Settings fields
  // have ZERO references under app/src/routing/ (grep-verified — see
  // planForm.ts's own comment) and must NEVER mark the form dirty.
  it('is NOT dirty when showOwnship changes', () => {
    const form = matchingForm();
    form.settings = { ...form.settings, showOwnship: !form.settings.showOwnship };
    expect(planFormDirty(makePlan(), form, true)).toBe(false);
  });

  it('is NOT dirty when aisApiKey is set', () => {
    const form = matchingForm();
    form.settings = { ...form.settings, aisApiKey: 'a-key' };
    expect(planFormDirty(makePlan(), form, true)).toBe(false);
  });

  it('is NOT dirty when ownMmsi is set', () => {
    const form = matchingForm();
    form.settings = { ...form.settings, ownMmsi: '123456789' };
    expect(planFormDirty(makePlan(), form, true)).toBe(false);
  });

  // #243 fix-wave-style backfill: a plan saved before depthComfortMarginM
  // existed has that field simply absent from its stored settings snapshot.
  // Without backfilling from DEFAULT_SETTINGS before comparing, every such
  // plan would read permanently dirty against live (always-backfilled)
  // settings on a field the user never touched.
  it('is NOT dirty on a pre-#243-shaped plan whose settings lack depthComfortMarginM, when the form uses the default', () => {
    const oldShapedSettings = { ...ORIGINAL_REQUEST.settings } as Partial<Settings>;
    delete oldShapedSettings.depthComfortMarginM;
    const plan = makePlan({ ...ORIGINAL_REQUEST, settings: oldShapedSettings as Settings });

    const form = matchingForm();
    form.settings = { ...form.settings, depthComfortMarginM: DEFAULT_SETTINGS.depthComfortMarginM };

    expect(planFormDirty(plan, form, true)).toBe(false);
  });

  it('IS dirty on a pre-#243-shaped plan when the live depthComfortMarginM differs from the default it was backfilled with', () => {
    const oldShapedSettings = { ...ORIGINAL_REQUEST.settings } as Partial<Settings>;
    delete oldShapedSettings.depthComfortMarginM;
    const plan = makePlan({ ...ORIGINAL_REQUEST, settings: oldShapedSettings as Settings });

    const form = matchingForm();
    form.settings = {
      ...form.settings,
      depthComfortMarginM: DEFAULT_SETTINGS.depthComfortMarginM + 1,
    };

    expect(planFormDirty(plan, form, true)).toBe(true);
  });

  // PR #443 review (Minor): pickedPointOf's tap-point fallback (fires when
  // harbors is [] — a permanent asset-load failure, or a harbor since pruned
  // from the curated list) drops a REAL originHarborId/destinationHarborId
  // from the sync-produced form, so a byte-identical, freshly-loaded plan
  // used to read harbor-id-mismatched and therefore dirty. These three rows
  // use pickedPointsOfPlan itself (not a hand-built form) to reproduce
  // exactly what App.tsx's sync effect would write when harbors is empty.
  describe('harborsAvailable gate (PR #443 review, Minor)', () => {
    function formFromEmptyHarborSync(plan: Plan): PlanFormSnapshot {
      const { origin, destination } = pickedPointsOfPlan(plan, [], 'de');
      return {
        origin,
        destination,
        departureMs: ORIGINAL_REQUEST.departureMs,
        settings: { ...ORIGINAL_REQUEST.settings },
      };
    }

    it('is NOT dirty when harborsAvailable=false, even though the tap-point fallback dropped both real harbor ids', () => {
      const plan = makePlan();
      expect(planFormDirty(plan, formFromEmptyHarborSync(plan), false)).toBe(false);
    });

    it('the SAME sync-produced form reads dirty when harborsAvailable=true — proving the gate, not a broader bug, is what closes the false positive', () => {
      const plan = makePlan();
      expect(planFormDirty(plan, formFromEmptyHarborSync(plan), true)).toBe(true);
    });

    it('harborsAvailable=false does not mask an actually-dirty form (departureMs is still compared)', () => {
      const plan = makePlan();
      const form = {
        ...formFromEmptyHarborSync(plan),
        departureMs: ORIGINAL_REQUEST.departureMs + 3_600_000,
      };
      expect(planFormDirty(plan, form, false)).toBe(true);
    });
  });

  // Mutation check (repo rule: a predicate that only reds in one direction is
  // half-tested), MEASURED by hand against this file before trusting it, not
  // merely asserted: forcing planFormDirty to `return true` unconditionally
  // reds exactly the 6 'is NOT dirty' rows above (the matching-form baseline,
  // showOwnship, aisApiKey, ownMmsi, the pre-#243-backfill 'NOT dirty' row,
  // and the harborsAvailable=false 'NOT dirty' row) — 23/29 still pass.
  // Forcing it to `return false` unconditionally reds exactly the 16 'is
  // dirty'/'IS dirty' rows (departure, origin point, origin harbor id,
  // destination point, destination harbor id, all 8 routing-relevant
  // settings via it.each, the pre-#243-backfill 'IS dirty' row, and the two
  // remaining harborsAvailable rows) — 13/29 still pass. Both directions
  // discriminate on DIFFERENT rows, so the predicate is not half-tested.
});
