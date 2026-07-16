import { useState } from 'react';
import type { Harbor, LatLon, PickedPoint, Settings } from '../types';
import { useLang, useT } from '../i18n';
import { FORECAST_DAYS } from '../services/openMeteo';
import { formatLatLon } from '../lib/format';
import HarborPicker from './HarborPicker';
import OptionsPanel from './OptionsPanel';

export type TapTarget = 'origin' | 'destination' | 'via';

// This panel's own idle/fetching/routing/error view of planning progress —
// coarser than usePlanFlow.ts's PlanningState (which additionally tracks
// per-rig simulatedToMs). App.tsx's toPlannerStatus adapts one to the other.
export type PlannerStatus =
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
  onRequestMapTap: (target: TapTarget) => void; // parent arms MapView tap mode
  // E8: via-waypoint re-route. Source of truth is the caller's — either a
  // pre-first-plan local draft, or (once a plan exists) plan.request.viaPoints
  // itself, so a rejected replan is reflected here automatically. Reorder is
  // up/down buttons, not drag-and-drop (v1 scope).
  viaPoints: LatLon[];
  onRemoveVia: (index: number) => void;
  onReorderVia: (index: number, direction: 'up' | 'down') => void;
  // True while a via edit (from this panel or a map-marker drag) is being
  // replanned — disables the via controls so a second edit can't be queued
  // while one is in flight (mirrors ViaMarkers' own disabled state).
  viaReplanning: boolean;
  departureMs: number;
  onDepartureChange: (ms: number) => void;
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  canPlan: boolean;
  planDisabledReason: string | null;
  onPlan: () => void;
  planning: PlannerStatus;
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

// Exported for App.tsx's harbor-marker click-to-pick (#38): a marker click
// must produce the IDENTICAL endpoint shape a search-picker selection does.
// eslint-disable-next-line react-refresh/only-export-components
export function harborToPickedPoint(h: Harbor, lang: 'de' | 'en'): PickedPoint {
  return { source: 'harbor', point: h.snap, harborId: h.id, label: h.names[lang] };
}

export default function PlannerPanel({
  harbors,
  origin,
  destination,
  onPickOrigin,
  onPickDestination,
  onRequestMapTap,
  viaPoints,
  onRemoveVia,
  onReorderVia,
  viaReplanning,
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

      <section aria-label={t('planner.via.label')} className="planner-via">
        <h2>{t('planner.via.label')}</h2>
        {viaPoints.length > 0 && (
          <ol className="planner-via-list">
            {viaPoints.map((v, i) => (
              <li key={i} className="planner-via-row">
                <span className="planner-via-coord">{formatLatLon(v)}</span>
                <button
                  type="button"
                  disabled={viaReplanning || i === 0}
                  onClick={() => onReorderVia(i, 'up')}
                  aria-label={t('planner.via.moveUp', { index: i + 1 })}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={viaReplanning || i === viaPoints.length - 1}
                  onClick={() => onReorderVia(i, 'down')}
                  aria-label={t('planner.via.moveDown', { index: i + 1 })}
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={viaReplanning}
                  onClick={() => onRemoveVia(i)}
                  aria-label={t('planner.via.remove', { index: i + 1 })}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
        <button type="button" disabled={viaReplanning} onClick={() => onRequestMapTap('via')}>
          {t('planner.via.add')}
        </button>
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
