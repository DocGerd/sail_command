import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Harbor, LatLon, PickedPoint, Plan, Rig, RigResult, Settings } from '../types';
// #340 NAMED COUPLING: RIG_ORDER's coupling to the router's real solve order
// is enforced by routing/planRoute.test.ts — see its definition in types.ts.
import { RIG_ORDER } from '../types';
import { useLang, useT } from '../i18n';
import { FORECAST_DAYS } from '../services/openMeteo';
import {
  formatDateTime,
  formatDuration,
  formatLatLon,
  formatNm,
  toLocalInputValue,
} from '../lib/format';
import { GpxParseError, MAX_GPX_FILE_BYTES, parseGpx, type GpxErrorReason } from '../lib/gpx';
import { activeRigResult } from '../lib/plan';
import { RIG_LABEL_KEY, resultSummary } from '../lib/resultSummary';
import { useRecentHarbors } from '../lib/useRecentHarbors';
import HarborPicker from './HarborPicker';
import { SAFETY_DEPTH_FIELD, commitSetting } from './OptionsPanel';
import NumberInput from './NumberInput';
import Card from './Card';
import Field from './Field';
import Button from './Button';
import Chip from './Chip';
import Skeleton from './Skeleton';
// #452: the shallow-water warning is plan-level (RouteSummary's own note
// explains why) — shared here so the FIRST surface a user sees a result on
// carries the same warning as the Routes tab, not just a second copy of it.
import { ShallowWarning } from './RouteSummary';

export type TapTarget = 'origin' | 'destination' | 'via';

// This panel's own idle/fetching/routing/error view of planning progress —
// coarser than usePlanFlow.ts's PlanningState in naming only (fetching vs.
// fetching-wind, message vs. messageKey); the 'routing' rig is carried
// through unchanged (#340). App.tsx's toPlannerStatus adapts one to the other.
export type PlannerStatus =
  | { phase: 'idle' }
  | { phase: 'fetching' }
  | { phase: 'routing'; rig: Rig }
  // #53: probing relaxed depth gates after an unreachable requested-depth solve
  | { phase: 'probing' }
  | { phase: 'error'; message: string };

export interface PlannerPanelProps {
  harbors: Harbor[];
  origin: PickedPoint | null;
  destination: PickedPoint | null;
  onPickOrigin: (p: PickedPoint) => void;
  onPickDestination: (p: PickedPoint) => void;
  // GPX import (#3): prefill origin/destination/viaPoints from a parsed .gpx.
  // The parent owns the planner input state (App.tsx), so import routes through
  // it — origin+destination as tap-source PickedPoints, vias as raw LatLon.
  onImportRoute: (origin: PickedPoint, destination: PickedPoint, viaPoints: LatLon[]) => void;
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
  // #64 phase 4 (§3.5): drives the empty/first-run onboarding line, which only
  // makes sense while online — offline gets the `error.offline` disabled reason
  // (planDisabledReason) instead, since no endpoints can be planned offline.
  online: boolean;
  onPlan: () => void;
  planning: PlannerStatus;
  // #64 phase 3: the active plan + rig drive the compact Ergebnis strip and the
  // plan-completion announcement. Null before the first plan.
  plan: Plan | null;
  rig: Rig | null;
  // #301: true when the form (origin/destination/departure/live settings)
  // has drifted from `plan` — a re-run right now would produce a DIFFERENT
  // route than the one shown in the Ergebnis card below. Drives a second
  // Chip there plus a sentence folded into the panel's one live region;
  // never a second live region and never map styling (#324's dash+opacity
  // vocabulary already means "the other rig").
  formDirty: boolean;
  // "Details ansehen": switch to the Routes tab and focus its Ergebnis heading.
  onViewDetails: () => void;
  // #299: discoverable route from the (still inline) safety-depth field to
  // the dedicated Boat tab, which now hosts the depth comfort margin and the
  // rest of the boat/propulsion/AIS settings — switches App.tsx's active tab.
  onOpenBoatSettings: () => void;
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
  onImportRoute,
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
  online,
  onPlan,
  planning,
  plan,
  rig,
  formDirty,
  onViewDetails,
  onOpenBoatSettings,
}: PlannerPanelProps) {
  const t = useT();
  const [lang] = useLang();
  const { recent, remember } = useRecentHarbors();
  // Per-endpoint "editing" flag: a selected endpoint collapses to a compact row,
  // and "Ändern"/"Change" reopens its combobox without clearing the selection.
  // Arming map-pick clears it so the endpoint re-collapses once the map tap
  // lands on the parent's origin/destination.
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [editingDestination, setEditingDestination] = useState(false);

  // GPX import (#3): a hidden file input triggered by the Button primitive.
  // Parsing is pure local file handling (available offline); only the later
  // Plan action needs network. On success we prefill the planner inputs and
  // surface any non-blocking notices; on rejection we show a specific message.
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotices, setImportNotices] = useState<string[]>([]);

  const importErrorMessage = (reason: GpxErrorReason | null): string => {
    switch (reason) {
      case 'too-few-points':
        return t('planner.import.error.tooFewPoints');
      case 'bad-coord':
        return t('planner.import.error.badCoord');
      case 'out-of-bounds':
        return t('planner.import.error.outOfBounds');
      case 'too-large':
        return t('planner.import.error.tooLarge');
      case 'not-xml':
      case 'not-gpx':
        return t('planner.import.error.notGpx');
      default:
        return t('planner.import.error.failed');
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-selecting the same file re-fires change
    if (!file) return;
    setImportError(null);
    setImportNotices([]);
    // DoS guard (#3 hardening): reject an oversized file BEFORE reading it into
    // memory. parseGpx runs synchronously on the main thread, so a hundreds-of-MB
    // GPX would freeze the tab (blast radius = the user's own tab). The 10 MB cap
    // (MAX_GPX_FILE_BYTES) is far above any real route/track export, so this never
    // rejects a legitimate file; a belt-and-suspenders element-count guard lives
    // in parseGpx for a well-formed file that slips under the byte cap.
    if (file.size > MAX_GPX_FILE_BYTES) {
      setImportError(t('planner.import.error.tooLarge'));
      return;
    }
    try {
      const route = parseGpx(await file.text());
      const toPicked = (p: LatLon): PickedPoint => ({
        source: 'tap',
        point: p,
        label: formatLatLon(p),
      });
      onImportRoute(toPicked(route.origin), toPicked(route.destination), route.viaPoints);
      setImportNotices([
        t('planner.import.success'),
        ...route.notices.map((n) => {
          if (n.kind === 'track-reduced') return t('planner.import.notice.trackReduced');
          if (n.kind === 'multiple-routes') return t('planner.import.notice.multipleRoutes');
          if (n.kind === 'multiple-tracks') return t('planner.import.notice.multipleTracks');
          return t('planner.import.notice.viaCapped', { dropped: n.dropped });
        }),
      ]);
    } catch (err) {
      setImportError(importErrorMessage(err instanceof GpxParseError ? err.reason : null));
    }
  };

  // Soft form guidance for the datetime-local min/max, computed once at
  // mount — not a ticking clock; the actual horizon check happens server
  // side (in the plan request), this is just UX guardrails.
  const [bounds] = useState(() => {
    const now = Date.now();
    return { min: now, max: now + FORECAST_DAYS * 86_400_000 };
  });

  // Full approach caveat for a selected endpoint row — only harbor picks carry a
  // harborId to look one up; a map-tap pick has just a coordinate label.
  const originHarbor =
    origin?.source === 'harbor' ? harbors.find((h) => h.id === origin.harborId) : undefined;
  const destinationHarbor =
    destination?.source === 'harbor'
      ? harbors.find((h) => h.id === destination.harborId)
      : undefined;

  // The active rig's result + its single-source display fields — used by the
  // compact Ergebnis strip below and the completion announcement.
  const result = plan && rig ? activeRigResult(plan, rig) : null;
  const summary = plan && result ? resultSummary(plan, result, lang) : null;
  // #452: plan-level, like RouteSummary's own — both rigs solve at the same
  // relaxed gate, so this must show regardless of which rig tab is active
  // and is deliberately NOT derived from `result`/`summary` (a null-rig tab
  // must still surface it if the plan as a whole carries it). The RENDER
  // site below must honour this too — it used to be nested inside a
  // `summary &&` gate, which silently hid the warning on exactly a null-rig
  // tab (review finding, PR #461 Major 1, measured: 0 nodes rendered for a
  // shallow plan on a rig whose own result is null). The Card below is now
  // gated on `summary || shallow`, not `summary` alone.
  const shallow = plan?.result.shallow ?? null;

  // #64 §3.4 (Option B) a11y: announce the terminal result in the persistent
  // live region, ONCE per completed plan. We freeze the RESULT that completed
  // (not the rendered string) and re-derive the sentence from the CURRENT
  // language each render — so a language switch re-announces in the new
  // language, while a via-edit (same plan.id, new result) leaves the frozen
  // result untouched. Seeded from the plan present at mount so re-entering the
  // tab with an existing result does NOT re-announce; a genuinely new plan (new
  // id) does. Via-edits preserve plan.id (App.tsx); slider/map re-renders don't
  // touch `plan` at all.
  const lastAnnouncedIdRef = useRef<string | null>(plan?.id ?? null);
  const [announcedResult, setAnnouncedResult] = useState<RigResult | null>(null);
  useEffect(() => {
    if (planning.phase !== 'idle' || !plan) return;
    const res = rig ? activeRigResult(plan, rig) : null;
    if (!res || plan.id === lastAnnouncedIdRef.current) return;
    lastAnnouncedIdRef.current = plan.id;
    setAnnouncedResult(res);
  }, [planning.phase, plan, rig]);

  const announcement = announcedResult
    ? t('planner.result.announce', {
        arrival: formatDateTime(announcedResult.etaMs, lang),
        duration: formatDuration(announcedResult.durationMs),
        distance: formatNm(announcedResult.distanceNm),
      })
    : '';

  // Single derived text for the ONE persistent live region: in-flight phase
  // messages while planning, then the completion summary once idle. Never a
  // second aria-live region.
  let statusText = '';
  if (planning.phase === 'fetching') statusText = t('planner.status.fetching');
  else if (planning.phase === 'routing')
    // #340: phase readout ("sail N of 2") — RIG_ORDER is the router's actual,
    // fixed solve order (genoa then fock), so the index always matches which
    // solve is really running.
    statusText = t('planner.status.routingRig', {
      index: RIG_ORDER.indexOf(planning.rig) + 1,
      total: RIG_ORDER.length,
      rig: t(RIG_LABEL_KEY[planning.rig]),
    });
  else if (planning.phase === 'probing') statusText = t('planner.status.probing');
  else if (planning.phase === 'idle') {
    // #301: the same dirty-form sentence the Ergebnis card's Chip shows,
    // folded into this ONE existing live region rather than a second one —
    // joined (not concatenated) so a plan-less mount (empty announcement)
    // still reads as a clean single sentence, not a leading space. Changes
    // only when formDirty flips (announcement itself is frozen per plan —
    // see announcedResult above), so it announces once, not per keystroke.
    const staleSuffix = formDirty && summary ? t('planner.result.stale') : '';
    statusText = [announcement, staleSuffix].filter(Boolean).join(' ');
  }
  // §3.4 (fix wave): the idle completion announcement is screen-reader-only —
  // the visible surface is the prominent Ergebnis card, so a visible sentence
  // here just duplicates it. Progress/probing stay visible.
  const statusSrOnly = planning.phase === 'idle';

  // §3.5 loading: the worker solves twice (genoa + fock). While a fresh plan is
  // in flight and no result exists yet, a decorative skeleton stands in for the
  // compact Ergebnis card. A replan of an existing plan keeps its card (summary
  // still present), so the skeleton is strictly a first-result placeholder.
  const isPlanningInFlight =
    planning.phase === 'fetching' || planning.phase === 'routing' || planning.phase === 'probing';

  // §3.5 empty/first-run: friendly guidance near the primary action while no
  // plan exists and an endpoint is unpicked. Suppressed offline — the
  // `error.offline` disabled reason is the more actionable message there.
  const showOnboarding = online && !plan && (!origin || !destination);

  return (
    <div className="planner-panel">
      <Card title={t('planner.card.trip')} className="planner-trip">
        <section className="planner-import">
          <input
            ref={importInputRef}
            type="file"
            accept=".gpx,application/gpx+xml"
            className="sr-only"
            onChange={(e) => void handleImportFile(e)}
          />
          <Button variant="secondary" onClick={() => importInputRef.current?.click()}>
            {t('planner.import.button')}
          </Button>
          {importError && (
            <p className="planner-guidance" role="alert">
              {importError}
            </p>
          )}
          {importNotices.length > 0 && (
            <ul className="planner-import-notices" role="status">
              {importNotices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label={t('planner.origin.label')} className="planner-endpoint">
          <h3 className="sc-section-title">{t('planner.origin.label')}</h3>
          {origin && !editingOrigin ? (
            <div className="planner-endpoint-selected">
              <span className="endpoint-pin" style={{ background: '#009e73' }} aria-hidden="true" />
              <div className="endpoint-detail">
                <p className="endpoint-name">{origin.label}</p>
                {originHarbor?.approachNote && (
                  <p className="endpoint-caveat">{originHarbor.approachNote[lang]}</p>
                )}
              </div>
              <Button variant="ghost" onClick={() => setEditingOrigin(true)}>
                {t('planner.change')}
              </Button>
            </div>
          ) : (
            <HarborPicker
              harbors={harbors}
              recentIds={recent}
              onSelect={(h) => {
                remember(h.id);
                setEditingOrigin(false);
                onPickOrigin(harborToPickedPoint(h, lang));
              }}
              // Abandoning a re-pick over a committed origin collapses back to
              // the row (no-op on a first, still-unselected pick — origin stays
              // null, so the combobox keeps showing).
              onCancel={() => setEditingOrigin(false)}
            />
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setEditingOrigin(false);
              onRequestMapTap('origin');
            }}
          >
            {t('planner.pickOnMap')}
          </Button>
        </section>

        <section aria-label={t('planner.destination.label')} className="planner-endpoint">
          <h3 className="sc-section-title">{t('planner.destination.label')}</h3>
          {destination && !editingDestination ? (
            <div className="planner-endpoint-selected">
              <span
                className="endpoint-pin"
                style={{ background: 'var(--sc-accent)' }}
                aria-hidden="true"
              />
              <div className="endpoint-detail">
                <p className="endpoint-name">{destination.label}</p>
                {destinationHarbor?.approachNote && (
                  <p className="endpoint-caveat">{destinationHarbor.approachNote[lang]}</p>
                )}
              </div>
              <Button variant="ghost" onClick={() => setEditingDestination(true)}>
                {t('planner.change')}
              </Button>
            </div>
          ) : (
            <HarborPicker
              harbors={harbors}
              recentIds={recent}
              onSelect={(h) => {
                remember(h.id);
                setEditingDestination(false);
                onPickDestination(harborToPickedPoint(h, lang));
              }}
              onCancel={() => setEditingDestination(false)}
            />
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setEditingDestination(false);
              onRequestMapTap('destination');
            }}
          >
            {t('planner.pickOnMap')}
          </Button>
        </section>

        <section aria-label={t('planner.via.label')} className="planner-via planner-endpoint">
          <h3 className="sc-section-title">{t('planner.via.label')}</h3>
          {viaPoints.length > 0 && (
            <ol className="planner-via-list">
              {viaPoints.map((v, i) => (
                <li key={i} className="planner-via-row">
                  <span className="planner-via-coord">{formatLatLon(v)}</span>
                  <Button
                    variant="ghost"
                    disabled={viaReplanning || i === 0}
                    onClick={() => onReorderVia(i, 'up')}
                    aria-label={t('planner.via.moveUp', { index: i + 1 })}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={viaReplanning || i === viaPoints.length - 1}
                    onClick={() => onReorderVia(i, 'down')}
                    aria-label={t('planner.via.moveDown', { index: i + 1 })}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={viaReplanning}
                    onClick={() => onRemoveVia(i)}
                    aria-label={t('planner.via.remove', { index: i + 1 })}
                  >
                    ×
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <Button variant="ghost" disabled={viaReplanning} onClick={() => onRequestMapTap('via')}>
            {t('planner.via.add')}
          </Button>
        </section>
      </Card>

      {/* §3.3: the two most-changed inputs — departure + safety depth — stay
          visible in this compact row. #299: the rest of what used to sit
          behind the "Erweitert" disclosure (depth comfort margin, motor/sail
          preference, AIS, …) moved to the dedicated Boat tab (SettingsPanel);
          only safety depth stays inline here, sharing SAFETY_DEPTH_FIELD as
          its single source of truth with that tab's own render of it — there
          is no second copy of the value, only a second RENDER of the same
          settings.safetyDepthM via the same commitSetting helper. */}
      <div className="planner-compact-row">
        <Field
          className="planner-departure"
          label={t('planner.departure.label')}
          htmlFor="planner-departure"
        >
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
        </Field>
        <Field
          className="planner-safety-depth"
          label={t(SAFETY_DEPTH_FIELD.labelKey)}
          htmlFor="planner-safety-depth"
        >
          <NumberInput
            id="planner-safety-depth"
            value={settings.safetyDepthM}
            min={SAFETY_DEPTH_FIELD.min}
            max={SAFETY_DEPTH_FIELD.max}
            step={SAFETY_DEPTH_FIELD.step}
            onCommit={(n) => commitSetting(settings, 'safetyDepthM', n, onSettingsChange)}
          />
        </Field>
      </div>

      {/* #299: a discoverable route from safety depth to the depth comfort
          margin (and the rest of the boat settings) now that the two "depth"
          controls live on two different surfaces — without this, a user
          hunting for the comfort margin right next to safety depth (where it
          used to be) could reasonably conclude it was removed. */}
      <Button variant="ghost" className="planner-boat-settings-link" onClick={onOpenBoatSettings}>
        {t('planner.safetyDepth.boatLink')} <span aria-hidden="true">→</span>
      </Button>

      {/* §3.3: the primary action stays reachable at the panel bottom (sticky),
          never below a long scroll. §3.5: a single guidance/reason line under
          it — onboarding when the trip is still empty (online), otherwise the
          disabled reason (offline, or missing endpoints once a plan exists).
          The two never render together, so the empty state reads as one hint. */}
      <div className="planner-actions">
        <Button variant="primary" onClick={onPlan} disabled={!canPlan}>
          {t('planner.plan')}
        </Button>
        {showOnboarding ? (
          <p className="planner-guidance">{t('planner.onboarding')}</p>
        ) : (
          planDisabledReason && (
            <p className="planner-guidance" role="alert">
              {planDisabledReason}
            </p>
          )
        )}
      </div>

      {/* ONE persistent live region (aria-atomic): in-flight status while
          planning (visible), then the stable completion summary once idle
          (sr-only — the Ergebnis card is the visible surface). Its text is
          swapped, never a second region added. */}
      <p
        className={`planner-status${statusSrOnly ? ' sr-only' : ''}`}
        role="status"
        aria-atomic="true"
      >
        {statusText}
      </p>
      {/* Plan-run errors are NOT rendered inline here: the tab-independent
          <Banner> in App.tsx (banner-area) is the single alert surface, so the
          error isn't announced twice. */}

      {/* §3.5 loading: decorative skeleton in the Ergebnis card's slot while a
          first plan solves. The status live region above carries the a11y
          feedback; this block is aria-hidden presentation only. */}
      {isPlanningInFlight && !summary && (
        <div className="sc-card planner-result planner-result-skeleton" aria-hidden="true">
          <Skeleton className="skeleton-chip" />
          <div className="planner-result-primary">
            <Skeleton className="skeleton-stat" />
            <Skeleton className="skeleton-stat" />
          </div>
          <div className="planner-result-secondary">
            <Skeleton className="skeleton-stat" />
            <Skeleton className="skeleton-stat" />
          </div>
        </div>
      )}

      {/* §3.4 (Option B): compact Ergebnis strip, immediately after the status
          live region. A strict subset of the full Routes card; "Details
          ansehen" jumps to the full card. #452: gated on `summary || shallow`,
          NOT `summary` alone — `shallow` is plan-level and must still surface
          here when the ACTIVE rig's own result is null (e.g. the active tab's
          rig failed to route while the other rig succeeded at the relaxed
          gate). Each summary-dependent section below carries its own
          `summary &&` guard so the Card can render with just the warning and
          no stats when that's all there is. */}
      {(summary || shallow) && (
        <Card title={t('planner.card.result')} className="planner-result">
          {summary && (
            <div className="planner-result-chips">
              {/* #259: mirrors RouteSummary's rig-comparison chip — an ETA tie
                  or an all-motor comparison must not silently badge one rig as
                  recommended here either (this strip is the FIRST surface a
                  user sees a result on). */}
              <Chip className="chip-faster-rig">
                {summary.rigRecommendation.kind === 'decided'
                  ? t('route.fasterRig', { rig: t(RIG_LABEL_KEY[summary.rigRecommendation.rig]) })
                  : t(summary.rigRecommendation.kind === 'moot' ? 'route.rigMoot' : 'route.rigTie')}
              </Chip>
              {/* #301: the form has drifted from this displayed route — a
                  re-run right now would produce something different. Sits ON
                  the stale thing (this card / the map route below it), not a
                  tab-independent Banner (#368's contested space) and not map
                  dimming/dashing (#324's dash+opacity already means "the other
                  rig"). The same sentence is folded into the live region above
                  (statusText) — this Chip is the sighted-user surface only. */}
              {formDirty && <Chip>{t('planner.result.stale')}</Chip>}
            </div>
          )}
          {/* #452: shallow-water warning, promoted here from the Routes-tab-only
              RouteSummary card so it's visible on the FIRST surface a user sees
              a result on, without switching tabs. Plan-level (see `shallow`
              above), same shared component and copy as RouteSummary's own —
              and, unlike the sections below, NOT gated on `summary`. */}
          {shallow && <ShallowWarning shallow={shallow} />}
          {summary && (
            <>
              <div className="planner-result-primary">
                <div className="ergebnis-stat ergebnis-stat-lg">
                  <span className="ergebnis-stat-label">{t('route.totals.eta')}</span>
                  <span className="ergebnis-stat-value tabular-nums">{summary.arrivalText}</span>
                </div>
                <div className="ergebnis-stat ergebnis-stat-lg">
                  <span className="ergebnis-stat-label">{t('route.totals.duration')}</span>
                  <span className="ergebnis-stat-value tabular-nums">{summary.durationText}</span>
                </div>
              </div>
              <div className="planner-result-secondary">
                <div className="ergebnis-stat">
                  <span className="ergebnis-stat-label">{t('route.totals.distance')}</span>
                  <span className="ergebnis-stat-value tabular-nums">{summary.distanceText}</span>
                </div>
                <div className="ergebnis-stat">
                  <span className="ergebnis-stat-label">{t('route.totals.avgSpeed')}</span>
                  <span className="ergebnis-stat-value tabular-nums">{summary.avgSpeedText}</span>
                </div>
              </div>
              <Button
                variant="secondary"
                className="planner-result-details"
                onClick={onViewDetails}
              >
                {t('planner.result.details')} <span aria-hidden="true">→</span>
              </Button>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
