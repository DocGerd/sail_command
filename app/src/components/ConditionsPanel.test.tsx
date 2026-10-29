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
import { SEA_STATE_COLORS } from '../lib/waveMap';

let mockMask: unknown = null;
let mockMap: unknown = null;
vi.mock('../state/useNavMask', () => ({ useNavMask: () => mockMask }));
vi.mock('./MapView', () => ({ useMapInstance: () => mockMap }));

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
  mockMask = null;
  mockMap = null;
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

  it('offline with nothing held: the offline copy, no alert, no hour row', () => {
    renderPanel(props({ online: false }));
    expect(screen.getByText(de['conditions.offline.none'])).toBeInTheDocument();
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

  it('a departure outside the forecast is clamped and says so', () => {
    renderPanel(props({ forecast: ready(), departureMs: HOUR0 + 100 * H }));
    expect(screen.getByText(/liegt außerhalb der Vorhersage/)).toBeInTheDocument();
  });

  it('a short remaining forecast is stated next to the button', () => {
    renderPanel(props({ forecast: ready(), departureMs: HOUR0 + 42 * H }));
    expect(screen.getByText('Danach bleiben nur 3 h Vorhersage.')).toBeInTheDocument();
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

describe('#1854 day strip, sea ribbon and area line', () => {
  const LATS = [54.5, 54.6, 54.7];
  const LONS = [10.0, 10.1, 10.2, 10.3];
  // Water everywhere but the eastern column, whose 30 kn must never count.
  const SPEED: Record<number, number> = { 10: 8, 10.1: 10, 10.2: 14, 10.3: 30 };
  const smallWind = (dir = 225): WindGrid => ({
    ...makeWindGrid((_lat, lon) => ({ speedKn: SPEED[lon]!, dirFromDeg: dir }), {
      south: 54.5,
      north: 54.7,
      west: 10.0,
      east: 10.3,
      t0Ms: HOUR0 - 2 * H,
      hours: 48,
    }),
    fetchedAtMs: NOW - 2 * 60_000,
  });
  const smallWave = (hs: (hourIdx: number) => number, hours = 48): WaveGrid =>
    makeWaveGrid((_la, _lo, t) => ({ heightM: hs(t), periodS: 3, dirFromDeg: 200 }), {
      lats: LATS,
      lons: LONS,
      t0Ms: HOUR0 - 2 * H,
      hours,
    });
  const smallReady = (w: WaveGrid | null = smallWave(() => 0.5), wd = smallWind()) =>
    forecast({ wind: wd, wave: w, source: 'session' });

  beforeEach(() => {
    mockMask = { inBounds: () => true, depthM: (p: { lon: number }) => (p.lon < 10.25 ? 5 : 0) };
  });

  const strip = () => screen.getByRole('group', { name: 'Übersicht Mi 14., Revier' });
  const columns = () => Array.from(strip().querySelectorAll('button'));
  const visibleText = (el: Element) => {
    const c = el.cloneNode(true) as Element;
    c.querySelectorAll('.sr-only').forEach((s) => s.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };

  it('one column per remaining 3-hour window of the day, over the Revier water points', () => {
    renderPanel(props({ forecast: smallReady() }));
    expect(columns().map((b) => b.querySelector('.conditions-col-time')!.textContent)).toEqual([
      '09:00',
      '12:00',
      '15:00',
      '18:00',
      '21:00',
    ]);
    const first = columns()[0]!;
    expect(visibleText(first)).toBe('09:00 8–14 (18) 0,5');
    expect(first).toHaveAccessibleName(
      '09:00, Wind aus SW 8–14 Knoten Böen (18), Seegang 0,5 Meter',
    );
  });

  it('marks the window holding the hour; a column selects its first valid hour', () => {
    renderPanel(props({ forecast: smallReady() }));
    expect(columns()[0]).toHaveAttribute('aria-current', 'true');
    expect(columns()[1]).not.toHaveAttribute('aria-current');
    fireEvent.click(columns()[1]!);
    expect(document.querySelector('.conditions-hour-value')).toHaveTextContent('(in 2 h)');
    expect(columns()[1]).toHaveAttribute('aria-current', 'true');
    expect(columns()[0]).not.toHaveAttribute('aria-current');
  });

  it('missing Hs reads as no model data, never as calm', () => {
    renderPanel(props({ forecast: smallReady(smallWave(() => NaN)) }));
    const sea = columns()[0]!.querySelector('.conditions-col-sea')!;
    expect(visibleText(sea)).toBe('–');
    expect(sea).toHaveTextContent('Seegang – keine Modelldaten');
    expect(document.querySelectorAll('.conditions-ribbon rect')).toHaveLength(0);
  });

  it('a direction spread reads as variable in the column name', () => {
    const spread = makeWindGrid(
      (_lat, lon) => ({ speedKn: 10, dirFromDeg: lon < 10.05 ? 0 : lon < 10.15 ? 120 : 240 }),
      { south: 54.5, north: 54.7, west: 10.0, east: 10.3, t0Ms: HOUR0 - 2 * H, hours: 48 },
    );
    renderPanel(props({ forecast: smallReady(undefined, { ...spread, fetchedAtMs: NOW }) }));
    expect(columns()[0]!.textContent).toContain('Wind umlaufend');
  });

  it('the ribbon has one band per hour with sea data and none past the wave axis', () => {
    const hs = (t: number) => (t < 6 ? 0.3 : 1.5);
    renderPanel(props({ forecast: smallReady(smallWave(hs, 12)) }));
    const rects = Array.from(document.querySelectorAll('.conditions-ribbon rect'));
    // Options start at 10:00 (wave hour 2); the wave axis ends at hour 11.
    expect(rects.map((r) => r.getAttribute('data-band'))).toEqual([
      ...Array(4).fill('smooth'),
      ...Array(6).fill('moderate'),
    ]);
    expect(rects[0]).toHaveAttribute('fill', SEA_STATE_COLORS.smooth);
    expect(rects.map((r) => r.getAttribute('x'))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );
  });

  it('no strip until the mask has loaded', () => {
    mockMask = null;
    renderPanel(props({ forecast: smallReady() }));
    expect(document.querySelector('.conditions-strip')).toBeNull();
  });

  describe('area line', () => {
    let moveend: Array<() => void> = [];
    let shift = 0;
    beforeEach(() => {
      moveend = [];
      shift = 0;
      mockMap = {
        getContainer: () => ({
          clientWidth: 250,
          clientHeight: 300,
          getBoundingClientRect: () => ({ top: 0 }),
        }),
        project: ([lon, lat]: [number, number]) => ({
          x: (lon - 9.9 - shift) * 1000,
          y: (54.8 - lat) * 1000,
        }),
        unproject: ([x, y]: [number, number]) => ({
          lng: 9.9 + shift + x / 1000,
          lat: 54.8 - y / 1000,
        }),
        on: (_e: string, fn: () => void) => moveend.push(fn),
        off: (_e: string, fn: () => void) => (moveend = moveend.filter((f) => f !== fn)),
      };
    });

    const line = () => document.querySelector('.conditions-area')?.textContent ?? null;

    it('summarises the water points in view at the chosen hour', () => {
      renderPanel(props({ forecast: smallReady() }));
      expect(line()).toBe(
        'Im Kartenausschnitt: Wind 8–10 kn (Bft 3) aus SW, Böen bis 13 kn · Seegang bis 0,5 m',
      );
    });

    it('falls back to the water point nearest the view centre, and says so', () => {
      renderPanel(props({ forecast: smallReady() }));
      shift = 1;
      act(() => moveend.forEach((f) => f()));
      expect(line()).toBe(
        'Im Kartenausschnitt: Wind 14 kn (Bft 4) aus SW, Böen bis 18 kn · Seegang bis 0,5 m (am nächsten Modellpunkt)',
      );
    });

    it('missing Hs in view reads as a dash, not as calm', () => {
      renderPanel(props({ forecast: smallReady(smallWave(() => NaN)) }));
      expect(line()).toContain('Seegang bis – m');
    });

    it('leaves out the map band under the bottom sheet', () => {
      const sheet = document.createElement('div');
      sheet.className = 'app-bottom-sheet';
      sheet.getBoundingClientRect = () => ({ top: 150 }) as DOMRect;
      document.body.append(sheet);
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private cb: () => void;
          constructor(cb: () => void) {
            this.cb = cb;
          }
          observe() {
            this.cb();
          }
          disconnect() {}
        },
      );
      // Rows at y 100/200/300: only 54.7 stays above the sheet top; there 10.1 blows 10 kn.
      const rowWind = makeWindGrid(
        (lat, lon) => ({ speedKn: lat > 54.65 ? SPEED[lon]! : 20, dirFromDeg: 225 }),
        { south: 54.5, north: 54.7, west: 10.0, east: 10.3, t0Ms: HOUR0 - 2 * H, hours: 48 },
      );
      renderPanel(props({ forecast: smallReady(undefined, { ...rowWind, fetchedAtMs: NOW }) }));
      expect(line()).toContain('Wind 8–10 kn');
      sheet.remove();
      vi.unstubAllGlobals();
    });

    it('is absent without a map instance', () => {
      mockMap = null;
      renderPanel(props({ forecast: smallReady() }));
      expect(line()).toBeNull();
    });
  });
});
