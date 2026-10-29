import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import Button from './Button';
import Card from './Card';
import Chip from './Chip';
import Disclosure from './Disclosure';
import Skeleton from './Skeleton';
import Slider from './Slider';
import { useLang, useT } from '../i18n';
import {
  formatAgeShort,
  formatDateTime,
  formatDayShort,
  formatSliderTime,
  formatTime,
} from '../lib/format';
import { STALE_THRESHOLD_MS } from '../lib/plan';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { useWideLayout } from '../lib/useWideLayout';
import { waveHourIndexAt } from '../lib/waves';
import { GRID_CACHE_TTL_MS } from '../services/openMeteo';
import {
  clampHour,
  floorHourMs,
  seedConditionsHour,
  setConditionsHour,
  stepDay,
  stepHour,
  useConditionsHour,
  validHours,
} from '../state/conditionsHour';
import type { AreaForecast } from '../state/useAreaForecast';

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

  useEffect(() => {
    seedConditionsHour(departureMs, options);
  }, [departureMs, options]);

  const hour = hourMs !== null && options.includes(hourMs) ? hourMs : null;
  const hourIdx = hour === null ? -1 : options.indexOf(hour);
  const seedTarget = clampHour(floorHourMs(departureMs), options);
  const seedClamped = seedTarget !== null && seedTarget.clamped && hour === seedTarget.ms;

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

  const coolingDown = forecast.cooldownUntilMs !== null && nowMs < forecast.cooldownUntilMs;
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
      <div className="conditions-header">
        <Chip className={stale ? 'conditions-status conditions-status-stale' : 'conditions-status'}>
          {chipText}
        </Chip>
        {wind !== null && updateButton}
      </div>

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
      {wind !== null && forecast.waveError && (
        <p className="conditions-line">{t('conditions.error.waves')}</p>
      )}
      {noneLeft && <p className="conditions-line">{t('conditions.horizon.noneLeft')}</p>}

      {hour !== null && (
        <>
          <div className="conditions-hour" role="group" aria-label={t('conditions.hour.label')}>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.day.prev')}
              disabled={hourIdx <= 0}
              onClick={() => setConditionsHour(stepDay(options, hour, -1))}
            >
              «
            </Button>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.hour.prev')}
              disabled={hourIdx <= 0}
              onClick={() => setConditionsHour(stepHour(options, hour, -1))}
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
              onClick={() => setConditionsHour(stepHour(options, hour, 1))}
            >
              ▶
            </Button>
            <Button
              variant="secondary"
              className="conditions-step"
              aria-label={t('conditions.day.next')}
              disabled={hourIdx >= options.length - 1}
              onClick={() => setConditionsHour(stepDay(options, hour, 1))}
            >
              »
            </Button>
          </div>
          {seedClamped && (
            <p className="conditions-line">
              {t('conditions.horizon.seedClamped', {
                datetime: formatDateTime(departureMs, lang),
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
      {depthSuppressed && (
        <div className="conditions-depth">
          <span>{t('conditions.depthHidden')}</span>
          <Button variant="ghost" onClick={onShowDepth}>
            {t('conditions.depthShow')}
          </Button>
        </div>
      )}

      <Disclosure
        key={isWide ? 'wide' : 'narrow'}
        className="conditions-more"
        defaultOpen={isWide}
        summary={t('conditions.more.summary')}
      >
        {hour !== null && (
          <>
            <div className="conditions-scrubber">
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
                  if (ms !== undefined) setConditionsHour(ms);
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
                      setConditionsHour(stepDay(options, hour, delta));
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
        <p className="conditions-disclaimer">{t('conditions.disclaimer')}</p>
      </Disclosure>
    </Card>
  );
}
