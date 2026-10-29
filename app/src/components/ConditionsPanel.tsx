import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import Button from './Button';
import Card from './Card';
import Chip from './Chip';
import Disclosure from './Disclosure';
import Skeleton from './Skeleton';
import SeaStateLegend from './SeaStateLegend';
import Slider from './Slider';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import type { Lang } from '../i18n';
import {
  latticePoint,
  nearestLatticePoint,
  stripWindows,
  summariseScope,
  waterLatticePoints,
  windowOf,
  type ScopeSummary,
} from '../lib/areaForecast';
import { beaufortForce } from '../lib/beaufort';
import {
  formatAgeShort,
  formatCompassPoint,
  formatDateTime,
  formatDayShort,
  formatSliderTime,
  formatTime,
} from '../lib/format';
import { STALE_THRESHOLD_MS } from '../lib/plan';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { useSheetTop } from '../lib/useSheetTop';
import { useWideLayout } from '../lib/useWideLayout';
import { formatSeaStateM, SEA_STATE_COLORS } from '../lib/waveMap';
import { seaStateBand, waveHourIndexAt } from '../lib/waves';
import { useNavMask } from '../state/useNavMask';
import { GRID_CACHE_TTL_MS } from '../services/openMeteo';
import {
  floorHourMs,
  seedConditionsHour,
  stepConditionsHourTo,
  useClampedSeedMs,
  stepDay,
  stepHour,
  useConditionsHour,
  validHours,
} from '../state/conditionsHour';
import type { AreaForecast } from '../state/useAreaForecast';
import type { WindGrid } from '../types';

const HOUR_MS = 3_600_000;
const CLOCK_TICK_MS = 60_000;
const SHORT_FORECAST_H = 6;

export interface ConditionsPanelProps {
  forecast: AreaForecast;
  online: boolean;
  departureMs: number;
  depthSuppressed: boolean;
  onShowDepth: () => void;
  /** `ms` is the departure to set; `viaPointer` tells a tap from a keyboard press. */
  onUseAsDeparture: (ms: number, viaPointer: boolean) => void;
}

type Phase = 'loading' | 'error' | 'offlineNone' | 'offlineHeld' | 'failed' | 'stale' | 'ready';

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function rangeText(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

const NO_DATA = '–';

interface ViewScope {
  wind: number[];
  wave: number[];
  nearest: boolean;
}

type T = ReturnType<typeof useT>;

function windDirSr(s: ScopeSummary, t: T, lang: Lang): string {
  const dir = s.wind?.dirFromDeg;
  return dir === null || dir === undefined
    ? t('conditions.sr.windVariable')
    : t('conditions.sr.windFrom', { cardinal: formatCompassPoint(dir, lang) });
}

// Sr-only words sit between visible tokens with the spaces in text nodes
// outside them, so the name keeps its spaces and the visible spaces collapse.
function Sr({ children }: { children: string }) {
  return <span className="sr-only">{children}</span>;
}

function StripCell({ summary, t, lang }: { summary: ScopeSummary; t: T; lang: Lang }) {
  const w = summary.wind;
  const noData = (
    <>
      <span aria-hidden="true">{NO_DATA}</span> <Sr>{t('conditions.sr.noData')}</Sr>
    </>
  );
  return (
    <>
      <span className="conditions-col-wind">
        <Sr>{windDirSr(summary, t, lang)}</Sr>{' '}
        {w === null ? (
          noData
        ) : (
          <>
            {rangeText(Math.round(w.minKn), Math.round(w.maxKn))}{' '}
            <Sr>{t('conditions.sr.knots')}</Sr>
            {w.gustKn !== null && (
              <>
                {' '}
                <Sr>{t('conditions.sr.gusts')}</Sr>
                {` (${Math.round(w.gustKn)})`}
              </>
            )}
          </>
        )}
      </span>
      <Sr>,</Sr>{' '}
      <span className="conditions-col-sea">
        <Sr>{t('conditions.sr.sea')}</Sr>{' '}
        {summary.seaMaxM === null ? (
          noData
        ) : (
          <>
            {formatSeaStateM(summary.seaMaxM, lang)} <Sr>{t('conditions.sr.metres')}</Sr>
          </>
        )}
      </span>
    </>
  );
}

// The clock for ages and valid hours: set on mount, every minute while the
// page is visible, and on visibilitychange. Never Date.now() during render.
function useClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null && document.visibilityState === 'visible') {
        timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
      }
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      setNowMs(Date.now());
      stop();
      start();
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return nowMs;
}

export default function ConditionsPanel({
  forecast,
  online,
  departureMs,
  depthSuppressed,
  onShowDepth,
  onUseAsDeparture,
}: ConditionsPanelProps) {
  const t = useT();
  const [lang] = useLang();
  const isWide = useWideLayout();
  const nowMs = useClock();
  const hourMs = useConditionsHour();
  const [barbsVisible, setBarbsVisible] = usePersistedToggle('sc-barbs-visible', true);
  const [wavesVisible, setWavesVisible] = usePersistedToggle('sc-waves-visible', true);

  const { wind, wave } = forecast;
  const nowHour = floorHourMs(nowMs);
  const options = useMemo(() => (wind ? validHours(wind.timesMs, nowHour) : []), [wind, nowHour]);

  const enteredRef = useRef(false);
  useEffect(() => {
    // The first seed with hours to choose from is this visit's entry.
    if (options.length === 0) return;
    seedConditionsHour(departureMs, options, !enteredRef.current);
    enteredRef.current = true;
  }, [departureMs, options]);

  const hour = hourMs !== null && options.includes(hourMs) ? hourMs : null;
  const hourIdx = hour === null ? -1 : options.indexOf(hour);
  const clampedSeedMs = useClampedSeedMs();

  const ageMs = wind ? nowMs - wind.fetchedAtMs : 0;
  const stale = wind !== null && ageMs > STALE_THRESHOLD_MS;
  const noneLeft = wind !== null && options.length === 0;
  const fetchedTime = wind ? formatTime(wind.fetchedAtMs, lang) : '';
  const age = formatAgeShort(ageMs);

  let phase: Phase;
  if (!wind) phase = !online ? 'offlineNone' : forecast.errorKey ? 'error' : 'loading';
  else if (!online) phase = 'offlineHeld';
  else if (forecast.refreshFailed) phase = 'failed';
  else if (stale) phase = 'stale';
  else phase = 'ready';

  const phaseMessage = (p: Phase): string => {
    switch (p) {
      case 'loading':
        return t('conditions.status.loading');
      case 'error':
        return forecast.errorKey ? t(forecast.errorKey) : '';
      case 'offlineNone':
        return t('conditions.offline.none');
      case 'offlineHeld':
        return t('conditions.offline.held', { time: fetchedTime, age });
      case 'failed':
        return t('conditions.status.refreshFailed', { time: fetchedTime });
      case 'stale':
        return t('conditions.status.stale', { hours: String(Math.floor(ageMs / HOUR_MS)) });
      case 'ready':
        return t(
          forecast.source === 'plan' ? 'conditions.status.fromPlan' : 'conditions.status.fetched',
          {
            time: fetchedTime,
            age,
          },
        );
    }
  };

  // The polite region speaks on a transition only, never on mount or a tick.
  const [prevPhase, setPrevPhase] = useState(phase);
  const [announcement, setAnnouncement] = useState('');
  if (phase !== prevPhase) {
    setPrevPhase(phase);
    setAnnouncement(phaseMessage(phase));
  }

  // Re-render when the cooldown ends, not at the next minute tick.
  const [cooldownOverMs, setCooldownOverMs] = useState<number | null>(null);
  useEffect(() => {
    const until = forecast.cooldownUntilMs;
    if (until === null) return;
    const timer = setTimeout(() => setCooldownOverMs(until), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [forecast.cooldownUntilMs]);
  const coolingDown =
    forecast.cooldownUntilMs !== null &&
    cooldownOverMs !== forecast.cooldownUntilMs &&
    nowMs < forecast.cooldownUntilMs;
  const showUpdate =
    online &&
    !forecast.pending &&
    (wind === null ? forecast.errorKey !== null : ageMs >= GRID_CACHE_TTL_MS || noneLeft);

  const updateButton = showUpdate && (
    <div className="conditions-update">
      <Button variant="secondary" disabled={coolingDown} onClick={forecast.refresh}>
        {t('conditions.update')}
      </Button>
      {coolingDown && <span className="conditions-note">{t('conditions.update.cooldown')}</span>}
    </div>
  );

  const days = useMemo(() => {
    const seen = new Map<string, number>();
    for (const ms of options) if (!seen.has(localDayKey(ms))) seen.set(localDayKey(ms), ms);
    return [...seen.values()];
  }, [options]);

  const mask = useNavMask();
  const windWater = useMemo(
    () => (mask && wind ? waterLatticePoints(mask, wind) : []),
    [mask, wind],
  );
  const waveWater = useMemo(
    () => (mask && wave ? waterLatticePoints(mask, wave) : []),
    [mask, wave],
  );

  const windows = useMemo(
    () => (hour === null ? [] : stripWindows(options, hour)),
    [options, hour],
  );
  const columns = useMemo(
    () =>
      wind && windWater.length > 0
        ? windows.map((w) => ({
            ...w,
            summary: summariseScope(wind, wave, windWater, waveWater, w.hoursMs),
          }))
        : [],
    [wind, wave, windWater, waveWater, windows],
  );
  const currentWindow = hour === null ? null : windowOf(windows, hour);

  const ribbon = useMemo(
    () =>
      wind && wave && waveWater.length > 0
        ? options.map((h) => summariseScope(wind, wave, [], waveWater, [h]).seaMaxM)
        : [],
    [wind, wave, waveWater, options],
  );

  const map = useMapInstance();
  const sheetTop = useSheetTop(!isWide);
  const [view, setView] = useState<ViewScope | null>(null);
  useEffect(() => {
    if (!map || !wind || windWater.length === 0) return;
    const compute = () => {
      const el = map.getContainer();
      const w = el.clientWidth;
      const h = el.clientHeight;
      const visH =
        sheetTop === null ? h : Math.min(h, Math.max(0, sheetTop - el.getBoundingClientRect().top));
      const inView = (k: number, grid: Pick<WindGrid, 'lats' | 'lons'>) => {
        const p = latticePoint(grid, k);
        const q = map.project([p.lon, p.lat]);
        return q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= visH;
      };
      const windIn = windWater.filter((k) => inView(k, wind));
      if (windIn.length > 0) {
        setView({
          wind: windIn,
          wave: wave ? waveWater.filter((k) => inView(k, wave)) : [],
          nearest: false,
        });
        return;
      }
      const c = map.unproject([w / 2, visH / 2]);
      const centre = { lat: c.lat, lon: c.lng };
      const kWind = nearestLatticePoint(wind, windWater, centre);
      const kWave = wave ? nearestLatticePoint(wave, waveWater, centre) : null;
      setView({
        wind: kWind === null ? [] : [kWind],
        wave: kWave === null ? [] : [kWave],
        nearest: true,
      });
    };
    compute();
    map.on('moveend', compute);
    return () => {
      map.off('moveend', compute);
    };
  }, [map, wind, wave, windWater, waveWater, sheetTop]);

  const areaLine = (() => {
    if (!view || !wind || hour === null) return null;
    const s = summariseScope(wind, wave, view.wind, view.wave, [hour]);
    if (!s.wind) return null;
    const min = Math.round(s.wind.minKn);
    const max = Math.round(s.wind.maxKn);
    const vars = {
      speed: rangeText(min, max),
      force: rangeText(beaufortForce(min), beaufortForce(max)),
      gust: s.wind.gustKn === null ? NO_DATA : String(Math.round(s.wind.gustKn)),
      height: s.seaMaxM === null ? NO_DATA : formatSeaStateM(s.seaMaxM, lang),
    };
    const line =
      s.wind.dirFromDeg === null
        ? t('conditions.area.variable', vars)
        : t('conditions.area', {
            ...vars,
            cardinal: formatCompassPoint(s.wind.dirFromDeg, lang),
          });
    return view.nearest ? `${line} (${t('conditions.scope.nearest')})` : line;
  })();

  const handleUse = (e: MouseEvent<HTMLButtonElement>) => {
    if (hour === null) return;
    const ms = hour === nowHour ? Math.ceil(Date.now() / (5 * 60_000)) * (5 * 60_000) : hour;
    onUseAsDeparture(ms, e.detail > 0);
  };

  const relHours = hour === null ? 0 : Math.round((hour - nowHour) / HOUR_MS);
  const relLabel =
    relHours === 0
      ? t('conditions.hour.now')
      : t('conditions.hour.in', { hours: String(relHours) });
  const lastWindMs = wind?.timesMs[wind.timesMs.length - 1];
  const remainingH =
    hour !== null && lastWindMs !== undefined ? Math.round((lastWindMs - hour) / HOUR_MS) : null;
  const seaNoHour = hour !== null && wave !== null && waveHourIndexAt(wave, hour) === null;
  const lastWaveMs = wave?.timesMs[wave.timesMs.length - 1];

  const chipText =
    wind === null
      ? t('conditions.status.loading')
      : `${
          forecast.pending
            ? t('conditions.status.refreshing', { time: fetchedTime })
            : phaseMessage(
                phase === 'stale' || phase === 'offlineHeld' || phase === 'failed'
                  ? 'ready'
                  : phase,
              )
        } · ${t('conditions.horizon.end', {
          datetime: lastWindMs === undefined ? '' : formatSliderTime(lastWindMs, [], lang, nowMs),
        })}`;

  return (
    <Card title={t('conditions.title')} className="conditions-card">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {(wind !== null || phase === 'loading') && (
        <div className="conditions-header">
          <Chip
            className={stale ? 'conditions-status conditions-status-stale' : 'conditions-status'}
          >
            {chipText}
          </Chip>
          {wind !== null && updateButton}
        </div>
      )}

      {phase === 'offlineNone' && <p className="conditions-line">{t('conditions.offline.none')}</p>}
      {phase === 'error' && (
        <div role="alert" className="conditions-line">
          <p>{phaseMessage('error')}</p>
          {updateButton}
        </div>
      )}
      {phase === 'loading' && (
        <div className="conditions-skeleton">
          <Skeleton style={{ width: '100%', height: '2.75rem' }} />
          <Skeleton style={{ width: '60%', height: '2.75rem' }} />
        </div>
      )}
      {(phase === 'offlineHeld' || phase === 'failed' || phase === 'stale') && (
        <p className="conditions-line conditions-line-warn">{phaseMessage(phase)}</p>
      )}
      {wind !== null && wave === null && forecast.source === 'plan' && (
        <p className="conditions-line">{t('route.waves.unavailable')}</p>
      )}
      {wind !== null && forecast.waveError && (
        <p className="conditions-line">{t('conditions.error.waves')}</p>
      )}
      {noneLeft && <p className="conditions-line">{t('conditions.horizon.noneLeft')}</p>}

      {hour !== null && (
        <>
          <div className="conditions-hour" role="group" aria-label={t('conditions.hour.group')}>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.day.prev')}
              disabled={hourIdx <= 0}
              onClick={() => stepConditionsHourTo(stepDay(options, hour, -1))}
            >
              «
            </Button>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.hour.prev')}
              disabled={hourIdx <= 0}
              onClick={() => stepConditionsHourTo(stepHour(options, hour, -1))}
            >
              ◀
            </Button>
            <span className="conditions-hour-value">
              {formatSliderTime(hour, options, lang, nowMs)} ({relLabel})
            </span>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.hour.next')}
              disabled={hourIdx >= options.length - 1}
              onClick={() => stepConditionsHourTo(stepHour(options, hour, 1))}
            >
              ▶
            </Button>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.day.next')}
              disabled={hourIdx >= options.length - 1}
              onClick={() => stepConditionsHourTo(stepDay(options, hour, 1))}
            >
              »
            </Button>
          </div>
          {clampedSeedMs !== null && (
            <p className="conditions-line">
              {t('conditions.horizon.seedClamped', {
                datetime: formatDateTime(clampedSeedMs, lang),
                shown: formatDateTime(hour, lang),
              })}
            </p>
          )}
          {seaNoHour && lastWaveMs !== undefined && (
            <p className="conditions-line">
              {t('conditions.sea.noHour', { datetime: formatDateTime(lastWaveMs, lang) })}
            </p>
          )}
          <div className="conditions-actions">
            <Button variant="primary" onClick={handleUse}>
              {t(hour === nowHour ? 'conditions.useAsDeparture.now' : 'conditions.useAsDeparture')}
            </Button>
            {!online && (
              <span className="conditions-note">{t('conditions.useAsDeparture.offline')}</span>
            )}
            {remainingH !== null && remainingH < SHORT_FORECAST_H && (
              <span className="conditions-note">
                {t('conditions.useAsDeparture.short', { hours: String(remainingH) })}
              </span>
            )}
          </div>
        </>
      )}

      <p className="conditions-notice">{t('conditions.notice')}</p>
      {depthSuppressed && hour !== null && !seaNoHour && (
        <div className="conditions-depth">
          <span>{t('conditions.depthHidden')}</span>
          <Button variant="ghost" onClick={onShowDepth}>
            {t('conditions.depthShow')}
          </Button>
        </div>
      )}

      {hour !== null && columns.length > 0 && (
        <div
          className="conditions-strip"
          role="group"
          aria-label={t('conditions.strip.group', {
            day: formatDayShort(hour, lang),
            scope: t('conditions.scope.area'),
          })}
        >
          <p className="conditions-strip-caption" aria-hidden="true">
            {formatDayShort(hour, lang)}, {t('conditions.scope.area')}
          </p>
          <div className="conditions-strip-body">
            <div className="conditions-strip-labels" aria-hidden="true">
              <span />
              <span>{t('conditions.strip.rowWind')}</span>
              <span>{t('conditions.strip.rowSea')}</span>
            </div>
            {columns.map((c) => (
              <Button
                key={c.startMs}
                variant="ghost"
                className="conditions-col"
                aria-current={c.startMs === currentWindow ? 'true' : undefined}
                onClick={() => {
                  const first = c.hoursMs[0];
                  if (first !== undefined) setConditionsHour(first);
                }}
              >
                <span className="conditions-col-time">{formatTime(c.startMs, lang)}</span>
                <Sr>,</Sr> <StripCell summary={c.summary} t={t} lang={lang} />
              </Button>
            ))}
          </div>
        </div>
      )}

      <Disclosure
        key={isWide ? 'wide' : 'narrow'}
        className="conditions-more"
        defaultOpen={isWide}
        summary={t('conditions.more.summary')}
      >
        {areaLine !== null && <p className="conditions-area">{areaLine}</p>}
        {hour !== null && (
          <>
            <div className="conditions-scrubber">
              {ribbon.length > 0 && (
                <svg
                  className="conditions-ribbon"
                  aria-hidden="true"
                  viewBox={`0 0 ${ribbon.length} 1`}
                  preserveAspectRatio="none"
                  shapeRendering="crispEdges"
                >
                  {ribbon.map((m, i) => {
                    const band = m === null ? 'no-data' : seaStateBand(m);
                    return band === 'no-data' ? null : (
                      <rect
                        key={options[i]}
                        x={i}
                        y={0}
                        width={1}
                        height={1}
                        fill={SEA_STATE_COLORS[band]}
                        data-band={band}
                      />
                    );
                  })}
                </svg>
              )}
              <label htmlFor="conditions-hour-slider" className="sr-only">
                {t('conditions.hour.label')}
              </label>
              <Slider
                id="conditions-hour-slider"
                value={hourIdx}
                min={0}
                max={options.length - 1}
                step={1}
                aria-valuetext={
                  relHours === 0
                    ? `${formatDateTime(hour, lang)}, ${t('conditions.hour.now')}`
                    : t('conditions.hour.valuetext', {
                        datetime: formatDateTime(hour, lang),
                        hours: String(relHours),
                      })
                }
                onChange={(i) => {
                  const ms = options[i];
                  if (ms !== undefined) stepConditionsHourTo(ms);
                }}
              />
            </div>
            <div className="conditions-days" role="group" aria-label={t('conditions.day.group')}>
              {days.map((ms) => {
                const key = localDayKey(ms);
                return (
                  <Button
                    key={key}
                    variant="secondary"
                    className="conditions-day"
                    aria-pressed={localDayKey(hour) === key}
                    onClick={() => {
                      const delta = Math.round(
                        (new Date(ms).setHours(0, 0, 0, 0) - new Date(hour).setHours(0, 0, 0, 0)) /
                          (24 * HOUR_MS),
                      );
                      stepConditionsHourTo(stepDay(options, hour, delta));
                    }}
                  >
                    {key === localDayKey(nowMs)
                      ? t('conditions.day.today')
                      : formatDayShort(ms, lang)}
                  </Button>
                );
              })}
            </div>
          </>
        )}
        <label className="conditions-toggle">
          <input
            type="checkbox"
            checked={barbsVisible}
            onChange={(e) => setBarbsVisible(e.target.checked)}
          />
          {t('route.windBarbs.toggle')}
        </label>
        <label className="conditions-toggle">
          <input
            type="checkbox"
            checked={wavesVisible}
            onChange={(e) => setWavesVisible(e.target.checked)}
          />
          {t('route.waves.toggle')}
        </label>
        {wavesVisible && wave !== null && <SeaStateLegend />}
        <p className="conditions-disclaimer">{t('conditions.disclaimer')}</p>
      </Disclosure>
    </Card>
  );
}
