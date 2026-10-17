import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import { destinationPoint } from '../lib/geo';
import { withHarborHandover, type HarborHandoverEnds } from '../lib/harborHandover';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  PLAN_SCHEMA_VERSION,
  defaultBoatSnapshot,
  type LatLon,
  type Plan,
  type RigResult,
} from '../types';
import { HarborHandoverNotice } from './HarborHandoverNotice';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const ORIGIN: LatLon = { lat: 54.8, lon: 9.5 };
const DESTINATION: LatLon = { lat: 54.9, lon: 9.7 };
const HALF_NM = destinationPoint(ORIGIN, 90, 0.5);
const ONE_NM = destinationPoint(DESTINATION, 90, 1);

// `snap` is which ends the solver moved off the harbour; `flags` is what the
// result stores (null = a plan whose flag was stripped).
function makePlan(flags: HarborHandoverEnds | null, snap: HarborHandoverEnds = flags ?? {}): Plan {
  const base = {
    status: 'ok' as const,
    recommended: 'genoa' as const,
    comparisonComplete: true,
    snappedOrigin: snap.origin ? HALF_NM : ORIGIN,
    snappedDestination: snap.destination ? ONE_NM : DESTINATION,
    sails: [{ sailId: 'genoa' as const, result: null, reason: 'unreachable' as const }],
  };
  return {
    id: 'p',
    name: 'p',
    createdAtMs: 0,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [],
      originHarborId: 'a',
      destinationHarborId: 'b',
      departureMs: 0,
      settings: { ...DEFAULT_SETTINGS, safetyDepthM: 3.5 },
      sailIds: ['genoa'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: uniformWindGrid(10, 270),
    result: flags === null ? base : withHarborHandover(base, flags),
  };
}

const RIG_RESULT: RigResult = {
  sailId: 'genoa',
  legs: [],
  etaMs: 0,
  durationMs: 0,
  distanceNm: 0,
  maneuverCount: 0,
  motorDistanceNm: 0,
};

function renderNotice(plan: Plan, lang: 'de' | 'en', result: RigResult | null = RIG_RESULT) {
  localStorage.setItem('sc-lang', lang);
  return render(
    <I18nProvider>
      <HarborHandoverNotice plan={plan} result={result} />
    </I18nProvider>,
  );
}

const fill = (template: string, vars: Record<string, string>): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);

describe('HarborHandoverNotice (#1721)', () => {
  it('renders nothing for an ordinary plan', () => {
    const { container } = renderNotice(makePlan(null), 'en');
    expect(container.querySelector('.harbor-handover-notice')).toBeNull();
  });

  it.each([
    ['en', en],
    ['de', de],
  ] as const)('names the start end with boat, depth and distance in %s', (lang, dict) => {
    const plan = makePlan({ origin: true });
    const { container } = renderNotice(plan, lang);
    const notice = container.querySelector('.harbor-handover-notice');
    expect(notice).not.toBeNull();
    const dist = lang === 'en' ? '0.5 nm' : '0,5 nm';
    const depth = lang === 'en' ? '3.5' : '3,5';
    const boat = plan.request.boat.name;
    expect(notice?.textContent).toContain(
      fill(dict['route.handover.origin'], { boat, depth, dist }),
    );
    expect(notice?.textContent).not.toContain(dict['route.handover.destination'].slice(0, 30));
    expect(notice?.textContent).toContain(dict['route.handover.title']);
    expect(notice?.textContent).toContain(dict['route.handover.body']);
  });

  it('names the destination end only when only the destination is flagged', () => {
    const plan = makePlan({ destination: true });
    const { container } = renderNotice(plan, 'en');
    const text = container.querySelector('.harbor-handover-notice')?.textContent ?? '';
    expect(text).toContain(
      fill(en['route.handover.destination'], {
        boat: plan.request.boat.name,
        depth: '3.5',
        dist: '1.0 nm',
      }),
    );
    expect(text).not.toContain(en['route.handover.origin'].slice(0, 30));
  });

  it('lists both ends, origin first', () => {
    const { container } = renderNotice(makePlan({ origin: true, destination: true }), 'en');
    const paras = Array.from(container.querySelectorAll('.harbor-handover-notice p')).map(
      (p) => p.textContent ?? '',
    );
    expect(paras).toHaveLength(4);
    expect(paras[1]).toContain('Start:');
    expect(paras[2]).toContain('Destination:');
  });

  it('discloses a plan whose stored flag was stripped but whose snap is far off the harbour', () => {
    const { container } = renderNotice(makePlan(null, { origin: true }), 'en');
    expect(container.querySelector('.harbor-handover-notice')).not.toBeNull();
  });

  it('renders nothing while the active rig has no route, like the stripe and legend row', () => {
    const plan = makePlan({ origin: true });
    const { container } = renderNotice(plan, 'en', null);
    expect(container.querySelector('.harbor-handover-notice')).toBeNull();
  });

  it('is a plain always-visible block: no alert role, no labelled region', () => {
    const { container } = renderNotice(makePlan({ origin: true }), 'en');
    const notice = container.querySelector('.harbor-handover-notice');
    expect(notice?.tagName).toBe('DIV');
    expect(notice?.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });
});
