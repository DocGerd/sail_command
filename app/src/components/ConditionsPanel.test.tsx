import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import ConditionsPanel, { type ConditionsPanelProps } from './ConditionsPanel';
import { resetConditionsHourForTests } from '../state/conditionsHour';
import type { AreaForecast } from '../state/useAreaForecast';
import { makeWindGrid } from '../test/fixtures';
import { makeWaveGrid } from '../test/waveFixtures';
import type { WaveGrid, WindGrid } from '../types';

const H = 3_600_000;
const NOW = new Date(2026, 9, 14, 10, 32).getTime();
const HOUR0 = new Date(2026, 9, 14, 10, 0).getTime();

function wind(fetchedAtMs = NOW - 2 * 60_000, t0Ms = HOUR0 - 2 * H, hours = 48): WindGrid {
  return {
    ...makeWindGrid(() => ({ speedKn: 10, dirFromDeg: 225 }), { t0Ms, hours }),
    fetchedAtMs,
  };
}
function wave(hours = 48): WaveGrid {
  return makeWaveGrid(() => ({ heightM: 0.5, periodS: 3, dirFromDeg: 200 }), {
    t0Ms: HOUR0 - 2 * H,
    hours,
  });
}

function forecast(over: Partial<AreaForecast> = {}): AreaForecast {
  return {
    wind: null,
    wave: null,
    source: null,
    pending: false,
    errorKey: null,
    refreshFailed: false,
    waveError: false,
    cooldownUntilMs: null,
    refresh: vi.fn(),
    ...over,
  };
}

function props(over: Partial<ConditionsPanelProps> = {}): ConditionsPanelProps {
  return {
    forecast: forecast(),
    online: true,
    departureMs: HOUR0 + H,
    depthSuppressed: false,
    onShowDepth: vi.fn(),
    onUseAsDeparture: vi.fn(),
    ...over,
  };
}

function renderPanel(p: ConditionsPanelProps) {
  const ui = (q: ConditionsPanelProps) => (
    <StrictMode>
      <I18nProvider>
        <ConditionsPanel {...q} />
      </I18nProvider>
    </StrictMode>
  );
  const r = render(ui(p));
  return { ...r, update: (q: ConditionsPanelProps) => r.rerender(ui(q)) };
}

const ready = (over: Partial<AreaForecast> = {}) =>
  forecast({ wind: wind(), wave: wave(), source: 'session', ...over });
const politeText = () =>
  document.querySelector('.conditions-card [aria-live="polite"]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  localStorage.setItem('sc-lang', 'de');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetConditionsHourForTests();
  localStorage.clear();
});

describe('ConditionsPanel states (#1854 §7)', () => {
  it('loading: the loading copy and skeletons, no hour row', () => {
    renderPanel(props());
    expect(screen.getAllByText(de['conditions.status.loading']).length).toBeGreaterThan(0);
    expect(document.querySelector('.conditions-skeleton')).not.toBeNull();
    expect(screen.queryByRole('button', { name: de['conditions.hour.next'] })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('failure with nothing shown: an alert with typed copy and the update button', () => {
    const refresh = vi.fn();
    renderPanel(props({ forecast: forecast({ errorKey: 'error.windService', refresh }) }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(de['error.windService']);
    // Nothing is loading: no chip claims it is.
    expect(document.querySelector('.chip.conditions-status')).toBeNull();
    expect(screen.queryByText(de['conditions.status.loading'])).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: de['conditions.update'] }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rate limit: the update button is disabled with the cooldown text', () => {
    renderPanel(
      props({
        forecast: forecast({ errorKey: 'error.rateLimited', cooldownUntilMs: NOW + 30_000 }),
      }),
    );
    expect(screen.getByRole('button', { name: de['conditions.update'] })).toBeDisabled();
    expect(screen.getByText(de['conditions.update.cooldown'])).toBeInTheDocument();
  });

  it('re-enables the update button when the cooldown ends, not at the next minute tick', () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    vi.setSystemTime(NOW);
    renderPanel(
      props({
        forecast: forecast({ errorKey: 'error.rateLimited', cooldownUntilMs: NOW + 30_000 }),
      }),
    );
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('button', { name: de['conditions.update'] })).toBeEnabled();
    expect(screen.queryByText(de['conditions.update.cooldown'])).toBeNull();
  });

  it('offline with nothing held: the offline copy, no alert, no hour row', () => {
    renderPanel(props({ online: false }));
    expect(screen.getByText(de['conditions.offline.none'])).toBeInTheDocument();
    expect(document.querySelector('.chip.conditions-status')).toBeNull();
    expect(screen.queryByText(de['conditions.status.loading'])).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: de['conditions.update'] })).toBeNull();
  });

  it('ready: fetch time, age and horizon in the chip, and the hour seeded from the departure', () => {
    renderPanel(props({ forecast: ready() }));
    const chip = document.querySelector('.chip.conditions-status')!;
    expect(chip).toHaveTextContent('abgerufen 10:30 (vor 2 min)');
    expect(chip).toHaveTextContent('reicht bis');
    expect(document.querySelector('.conditions-hour-value')).toHaveTextContent('11:00 (in 1 h)');
    expect(screen.getByRole('button', { name: de['conditions.useAsDeparture'] })).toBeEnabled();
    expect(screen.queryByRole('button', { name: de['conditions.update'] })).toBeNull();
  });

  it('a plan source says so', () => {
    renderPanel(props({ forecast: ready({ source: 'plan' }) }));
    expect(document.querySelector('.chip.conditions-status')).toHaveTextContent(
      'aus der geladenen Route',
    );
  });

  it('offers an update from 10 min of age, and none while one runs', () => {
    const old = ready({ wind: wind(NOW - 11 * 60_000) });
    const { update } = renderPanel(props({ forecast: old }));
    expect(screen.getByRole('button', { name: de['conditions.update'] })).toBeInTheDocument();
    update(props({ forecast: { ...old, pending: true } }));
    expect(screen.queryByRole('button', { name: de['conditions.update'] })).toBeNull();
    expect(document.querySelector('.chip.conditions-status')).toHaveTextContent(
      'Wird aktualisiert',
    );
  });

  it('offline with a grid held: the held copy with its age, and the planning note', () => {
    renderPanel(props({ online: false, forecast: ready() }));
    expect(
      screen.getByText(/Offline – zeigt die Vorhersage, abgerufen 10:30 \(vor 2 min\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(de['conditions.useAsDeparture.offline'])).toBeInTheDocument();
  });

  it('refresh failed, waves failed, and no sea data for the hour each show their line', () => {
    renderPanel(
      props({ forecast: ready({ refreshFailed: true, waveError: true, wave: wave(1) }) }),
    );
    expect(screen.getByText(/Aktualisierung fehlgeschlagen/)).toBeInTheDocument();
    expect(screen.getByText(de['conditions.error.waves'])).toBeInTheDocument();
    expect(screen.getByText(/Keine Seegangsdaten für diese Stunde/)).toBeInTheDocument();
  });

  it('no upcoming hours: the noneLeft copy and the update button', () => {
    renderPanel(props({ forecast: ready({ wind: wind(NOW - 30 * H, HOUR0 - 40 * H, 24) }) }));
    expect(screen.getByText(de['conditions.horizon.noneLeft'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de['conditions.update'] })).toBeInTheDocument();
  });

  it('a departure outside the forecast is clamped and says so, until the user steps', () => {
    renderPanel(props({ forecast: ready(), departureMs: HOUR0 + 100 * H }));
    expect(screen.getByText(/liegt außerhalb der Vorhersage/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: de['conditions.hour.prev'] }));
    expect(screen.queryByText(/liegt außerhalb der Vorhersage/)).toBeNull();
    // Stepping back onto the clamped hour is not a seed.
    fireEvent.click(screen.getByRole('button', { name: de['conditions.hour.next'] }));
    expect(screen.queryByText(/liegt außerhalb der Vorhersage/)).toBeNull();
  });

  it('a re-entry that does not seed drops an earlier clamped-seed note', () => {
    const p = props({ forecast: ready(), departureMs: HOUR0 + 100 * H });
    const first = renderPanel(p);
    expect(screen.getByText(/liegt außerhalb der Vorhersage/)).toBeInTheDocument();
    first.unmount();
    renderPanel(p);
    expect(screen.queryByText(/liegt außerhalb der Vorhersage/)).toBeNull();
  });

  it('the hour group and the slider have distinct accessible names', () => {
    renderPanel(props({ forecast: ready() }));
    expect(screen.getByRole('group', { name: de['conditions.hour.group'] })).toBeInTheDocument();
    expect(screen.getAllByLabelText(de['conditions.hour.label'])).toHaveLength(1);
  });

  it('the Disclosure carries the sea-state key while sea state can show', () => {
    const { update } = renderPanel(props({ forecast: ready() }));
    const more = document.querySelector('.conditions-more')!;
    expect(more).toHaveTextContent(de['route.legend.seaStateHeading']);
    expect(more.querySelectorAll('.route-legend-sea')).toHaveLength(5);
    update(props({ forecast: ready({ wave: null }) }));
    expect(more).not.toHaveTextContent(de['route.legend.seaStateHeading']);
  });

  it('a plan source without sea state says so', () => {
    renderPanel(props({ forecast: ready({ source: 'plan', wave: null }) }));
    expect(screen.getByText(de['route.waves.unavailable'])).toBeInTheDocument();
  });

  it('a short remaining forecast is stated next to the button', () => {
    renderPanel(props({ forecast: ready(), departureMs: HOUR0 + 42 * H }));
    expect(screen.getByText('Danach bleiben nur 3 h Vorhersage.')).toBeInTheDocument();
  });

  it('no depth line at an hour the sea state does not draw', () => {
    renderPanel(props({ forecast: ready({ wave: wave(1) }), depthSuppressed: true }));
    expect(screen.queryByText(de['conditions.depthHidden'])).toBeNull();
  });

  it('depth suppression shows its line, and Tiefen zeigen lifts it', () => {
    const onShowDepth = vi.fn();
    renderPanel(props({ forecast: ready(), depthSuppressed: true, onShowDepth }));
    expect(screen.getByText(de['conditions.depthHidden'])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: de['conditions.depthShow'] }));
    expect(onShowDepth).toHaveBeenCalledTimes(1);
  });
});

describe('ConditionsPanel hour control and handoff (#1854 §4, §11)', () => {
  it('steps by hour and day, clamped at the ends', () => {
    renderPanel(props({ forecast: ready() }));
    const value = () => document.querySelector('.conditions-hour-value')!.textContent;
    fireEvent.click(screen.getByRole('button', { name: de['conditions.hour.next'] }));
    expect(value()).toContain('(in 2 h)');
    fireEvent.click(screen.getByRole('button', { name: de['conditions.day.next'] }));
    expect(value()).toContain('(in 26 h)');
    fireEvent.click(screen.getByRole('button', { name: de['conditions.day.prev'] }));
    fireEvent.click(screen.getByRole('button', { name: de['conditions.day.prev'] }));
    expect(value()).toContain('(jetzt)');
    expect(screen.getByRole('button', { name: de['conditions.hour.prev'] })).toBeDisabled();
  });

  it('the slider and the day buttons move the hour', () => {
    renderPanel(props({ forecast: ready() }));
    const slider = screen.getByLabelText(de['conditions.hour.label'], { selector: 'input' });
    fireEvent.change(slider, { target: { value: '5' } });
    expect(document.querySelector('.conditions-hour-value')).toHaveTextContent('(in 5 h)');
    const days = screen.getByRole('group', { name: de['conditions.day.group'] });
    const buttons = days.querySelectorAll('button');
    expect(buttons[0]).toHaveTextContent(de['conditions.day.today']);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(buttons[1]!);
    expect(document.querySelector('.conditions-hour-value')).toHaveTextContent('(in 29 h)');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('hands over the chosen hour, or now rounded up to 5 min for the current hour', () => {
    const onUseAsDeparture = vi.fn();
    renderPanel(props({ forecast: ready(), onUseAsDeparture }));
    fireEvent.click(screen.getByRole('button', { name: de['conditions.useAsDeparture'] }), {
      detail: 1,
    });
    expect(onUseAsDeparture).toHaveBeenLastCalledWith(HOUR0 + H, true);
    fireEvent.click(screen.getByRole('button', { name: de['conditions.hour.prev'] }));
    fireEvent.click(screen.getByRole('button', { name: de['conditions.useAsDeparture.now'] }));
    expect(onUseAsDeparture).toHaveBeenLastCalledWith(
      new Date(2026, 9, 14, 10, 35).getTime(),
      false,
    );
  });

  it('a 13 h clock advance turns stale, drops past hours and announces only the transition', () => {
    const { update } = renderPanel(props({ forecast: forecast() }));
    expect(politeText()).toBe('');
    update(props({ forecast: ready() }));
    expect(politeText()).toBe('abgerufen 10:30 (vor 2 min)');
    fireEvent.click(screen.getByRole('button', { name: de['conditions.hour.next'] }));
    act(() => vi.advanceTimersByTime(13 * H));
    const staleText = 'Vor 13 h abgerufen – für aktuelle Bedingungen aktualisieren.';
    expect(screen.getAllByText(staleText).length).toBeGreaterThan(0);
    expect(politeText()).toBe(staleText);
    expect(document.querySelector('.chip.conditions-status-stale')).not.toBeNull();
    // The chosen 12:00 is past now: the hour moved to 23:00, the first valid one.
    expect(document.querySelector('.conditions-hour-value')).toHaveTextContent('(jetzt)');
    expect(screen.getByRole('button', { name: de['conditions.hour.prev'] })).toBeDisabled();
    // The age ticks outside the polite region.
    expect(document.querySelector('.chip.conditions-status')).toHaveTextContent('vor 13 h');
  });

  it('never moves focus when the forecast loads', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const { update } = renderPanel(props());
    update(props({ forecast: ready() }));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
