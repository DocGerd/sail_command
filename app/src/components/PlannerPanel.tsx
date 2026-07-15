import { useState } from 'react';
import type { Harbor, LatLon, Settings } from '../types';
import { useLang, useT } from '../i18n';
import { FORECAST_DAYS } from '../services/openMeteo';
import HarborPicker from './HarborPicker';
import OptionsPanel from './OptionsPanel';

// Presentational output of a harbor selection or a map tap. Wiring (turning
// a raw map-tap LatLon or harbor pick into app state) is E3's job; this type
// may move to a shared module once that lands.
export interface PickedPoint {
  point: LatLon;
  harborId: string | null;
  label: string;
}

// Placeholder for E3's planning-state type — idle/fetching/routing/error per
// the Phase E task brief. E3 owns and will refine the real type; this is
// kept minimal so PlannerPanel can be built and tested ahead of that wiring.
export type PlanningState =
  | { phase: 'idle' }
  | { phase: 'fetching' }
  | { phase: 'routing'; progress?: number }
  | { phase: 'error'; message: string };

export interface PlannerPanelProps {
  harbors: Harbor[];
  origin: PickedPoint | null;
  destination: PickedPoint | null;
  onPickOrigin: (p: PickedPoint) => void;
  onPickDestination: (p: PickedPoint) => void;
  onRequestMapTap: (target: 'origin' | 'destination') => void; // parent arms MapView tap mode
  departureMs: number;
  onDepartureChange: (ms: number) => void;
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  canPlan: boolean;
  planDisabledReason: string | null;
  onPlan: () => void;
  planning: PlanningState;
}

/**
 * Next full hour strictly after `nowMs` — the departure default E3 seeds
 * initial state with. Always strictly after `nowMs`, even when `nowMs`
 * already sits exactly on an hour boundary.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function nextFullHourMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  d.setHours(d.getHours() + 1, 0, 0, 0); // setHours tracks wall-clock hour boundaries across DST folds; raw +3600000 does not
  return d.getTime();
}

// datetime-local reads/writes LOCAL wall-clock time with no offset suffix;
// the Date getters/constructor below both operate in local time by design,
// so ms <-> string round-trips through the browser's own timezone.
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function harborToPickedPoint(h: Harbor, lang: 'de' | 'en'): PickedPoint {
  return { point: h.snap, harborId: h.id, label: h.names[lang] };
}

export default function PlannerPanel({
  harbors,
  origin,
  destination,
  onPickOrigin,
  onPickDestination,
  onRequestMapTap,
  departureMs,
  onDepartureChange,
  settings,
  onSettingsChange,
  canPlan,
  planDisabledReason,
  onPlan,
  planning,
}: PlannerPanelProps) {
  const t = useT();
  const [lang] = useLang();

  // Soft form guidance for the datetime-local min/max, computed once at
  // mount — not a ticking clock; the actual horizon check happens server
  // side (in the plan request), this is just UX guardrails.
  const [bounds] = useState(() => {
    const now = Date.now();
    return { min: now, max: now + FORECAST_DAYS * 86_400_000 };
  });

  return (
    <div className="planner-panel">
      <section aria-label={t('planner.origin.label')}>
        <h2>{t('planner.origin.label')}</h2>
        <p>{origin ? origin.label : t('planner.notSelected')}</p>
        <button type="button" onClick={() => onRequestMapTap('origin')}>
          {t('planner.pickOnMap')}
        </button>
        <HarborPicker
          harbors={harbors}
          onSelect={(h) => onPickOrigin(harborToPickedPoint(h, lang))}
        />
      </section>

      <section aria-label={t('planner.destination.label')}>
        <h2>{t('planner.destination.label')}</h2>
        <p>{destination ? destination.label : t('planner.notSelected')}</p>
        <button type="button" onClick={() => onRequestMapTap('destination')}>
          {t('planner.pickOnMap')}
        </button>
        <HarborPicker
          harbors={harbors}
          onSelect={(h) => onPickDestination(harborToPickedPoint(h, lang))}
        />
      </section>

      <div className="planner-departure">
        <label htmlFor="planner-departure">{t('planner.departure.label')}</label>
        <input
          id="planner-departure"
          type="datetime-local"
          value={toLocalInputValue(departureMs)}
          min={toLocalInputValue(bounds.min)}
          max={toLocalInputValue(bounds.max)}
          onChange={(e) => {
            if (!e.target.value) return;
            onDepartureChange(new Date(e.target.value).getTime());
          }}
        />
      </div>

      <OptionsPanel value={settings} onChange={onSettingsChange} />

      <button type="button" onClick={onPlan} disabled={!canPlan}>
        {t('planner.plan')}
      </button>
      {planDisabledReason && <p role="alert">{planDisabledReason}</p>}

      {planning.phase === 'fetching' && <p role="status">{t('planner.status.fetching')}</p>}
      {planning.phase === 'routing' && (
        <p role="status">
          {planning.progress !== undefined
            ? t('planner.status.routingProgress', { progress: Math.round(planning.progress * 100) })
            : t('planner.status.routing')}
        </p>
      )}
      {planning.phase === 'error' && <p role="alert">{planning.message}</p>}
    </div>
  );
}
