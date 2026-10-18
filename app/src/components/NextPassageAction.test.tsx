import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { uniformWindGrid } from '../test/fixtures';
import {
  defaultBoatSnapshot,
  DEFAULT_SETTINGS,
  PLAN_SCHEMA_VERSION,
  type Harbor,
  type Plan,
} from '../types';
import NextPassageAction from './NextPassageAction';

const MARSTAL: Harbor = {
  id: 'marstal',
  names: { de: 'Marstal', da: 'Marstal', en: 'Marstal' },
  country: 'DK',
  snap: { lat: 54.855, lon: 10.52 },
};

const ETA_MS = new Date(2026, 9, 17, 17, 0).getTime();

function makePlan(routed: boolean, etaMs = ETA_MS): Plan {
  const request = {
    origin: { lat: 54.795, lon: 9.435 },
    destination: MARSTAL.snap,
    viaPoints: [],
    originHarborId: 'flensburg',
    destinationHarborId: 'marstal',
    departureMs: ETA_MS - 3_600_000,
    settings: DEFAULT_SETTINGS,
    sailIds: ['genoa' as const],
    boat: defaultBoatSnapshot(),
  };
  return {
    id: 'plan-1',
    name: 'Flensburg → Marstal',
    createdAtMs: ETA_MS - 7_200_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request,
    windGrid: uniformWindGrid(12, 225),
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: routed
            ? {
                sailId: 'genoa',
                legs: [],
                etaMs,
                durationMs: 3_600_000,
                distanceNm: 10,
                maneuverCount: 0,
                motorDistanceNm: 0,
              }
            : null,
          reason: routed ? null : 'unreachable',
        },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: request.origin,
      snappedDestination: request.destination,
    },
  };
}

function renderAction(plan: Plan, disabled: boolean, onNextPassage = vi.fn()) {
  localStorage.setItem('sc-lang', 'en');
  const view = render(
    <I18nProvider>
      <NextPassageAction
        plan={plan}
        rig="genoa"
        harbors={[MARSTAL]}
        disabled={disabled}
        onNextPassage={onNextPassage}
      />
    </I18nProvider>,
  );
  return { ...view, onNextPassage };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(2026, 9, 17, 12, 0));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe('#1707 NextPassageAction', () => {
  it('labels the button and describes it with the seed preview', () => {
    renderAction(makePlan(true), false);
    expect(screen.getByRole('button', { name: 'Plan next passage' })).toHaveAccessibleDescription(
      'Start Marstal · Departure Sun 10:00',
    );
  });

  it('refreshes the preview when the clock passes the previewed departure', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 9, 30));
    renderAction(makePlan(true, new Date(2026, 9, 17, 9, 0).getTime()), false);
    const button = screen.getByRole('button', { name: 'Plan next passage' });
    expect(button).toHaveAccessibleDescription('Start Marstal · Departure Sat 10:00');

    vi.setSystemTime(new Date(2026, 9, 17, 10, 30));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(button).toHaveAccessibleDescription('Start Marstal · Departure Sun 10:00');
  });

  it('#1711: refreshes the preview when the page becomes visible again', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 9, 30));
    renderAction(makePlan(true, new Date(2026, 9, 17, 9, 0).getTime()), false);
    const button = screen.getByRole('button', { name: 'Plan next passage' });
    expect(button).toHaveAccessibleDescription('Start Marstal · Departure Sat 10:00');

    vi.setSystemTime(new Date(2026, 9, 17, 10, 30));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(button).toHaveAccessibleDescription('Start Marstal · Departure Sun 10:00');
  });

  it('#1711: removes the visibilitychange listener on unmount', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderAction(makePlan(true), false);
    const added = add.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(added).toHaveLength(1);
    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.[1]).toBe(added[0]?.[1]);
    add.mockRestore();
    remove.mockRestore();
  });

  it('honours disabled and reports a click otherwise', () => {
    const { onNextPassage, unmount } = renderAction(makePlan(true), true);
    expect(screen.getByRole('button', { name: 'Plan next passage' })).toBeDisabled();
    unmount();
    const enabled = renderAction(makePlan(true), false);
    fireEvent.click(screen.getByRole('button', { name: 'Plan next passage' }));
    expect(enabled.onNextPassage).toHaveBeenCalledTimes(1);
    expect(onNextPassage).not.toHaveBeenCalled();
  });

  it('renders nothing for a plan with no routed rig', () => {
    const { container } = renderAction(makePlan(false), false);
    expect(container.firstChild).toBeNull();
  });
});
