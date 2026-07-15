import { useCallback, useEffect, useState } from 'react';
import { useLang, useT } from './i18n';
import { AppStateProvider, useActivePlan, useOnline, usePersistenceError, useSettings } from './state/AppState';
import { usePlanFlow, type PlanningState as FlowPlanningState } from './state/usePlanFlow';
import { useViaReplan } from './state/replan';
import { loadRoutingAssets } from './services/assets';
import { FORECAST_DAYS } from './services/openMeteo';
import MapView from './components/MapView';
import RouteLayer from './components/RouteLayer';
import PlannerPanel, {
  nextFullHourMs,
  type PickedPoint,
  type PlanningState as PlannerPlanningState,
  type TapTarget,
} from './components/PlannerPanel';
import PlansList from './components/PlansList';
import RouteSummary from './components/RouteSummary';
import LiveView from './components/LiveView';
import Banner from './components/Banner';
import AboutDialog from './components/AboutDialog';
import { isStaleForecast } from './lib/plan';
import { formatLatLon } from './lib/format';
import type { MsgKey } from './i18n/dict.de';
import type { Harbor, LatLon } from './types';

type Tab = 'plan' | 'routes' | 'live';

const FORECAST_HORIZON_MS = FORECAST_DAYS * 86_400_000;

const TAP_TARGET_LABEL_KEY: Record<TapTarget, MsgKey> = {
  origin: 'planner.origin.label',
  destination: 'planner.destination.label',
  via: 'planner.via.label',
};

// Reconciles usePlanFlow.ts's PlanningState (fetching-wind / routing{rig,
// simulatedToMs} / error{messageKey}) with PlannerPanel's own, coarser
// PlanningState (fetching / routing{progress?} / error{message}) — flagged
// as an open gap by both E1 and E3's reports; App.tsx (the wiring task) is
// where it gets resolved. `progress` is simulatedToMs's advance through the
// departure->forecast-horizon window — an approximation (the router may
// finish well before the horizon), good enough for a progress indicator.
function toPlannerPlanningState(
  flow: FlowPlanningState,
  departureMs: number,
  t: ReturnType<typeof useT>,
): PlannerPlanningState {
  switch (flow.phase) {
    case 'idle':
      return { phase: 'idle' };
    case 'fetching-wind':
      return { phase: 'fetching' };
    case 'routing': {
      const progress = Math.min(1, Math.max(0, (flow.simulatedToMs - departureMs) / FORECAST_HORIZON_MS));
      return { phase: 'routing', progress };
    }
    case 'error':
      return { phase: 'error', message: t(flow.messageKey) };
  }
}

function AppShell() {
  const t = useT();
  const [lang, setLang] = useLang();
  const online = useOnline();
  const [settings, setSettings] = useSettings();
  const { plan, rig, setRig, activeLegIndex, setPlan } = useActivePlan();
  const [persistenceError, clearPersistenceError] = usePersistenceError();
  const { planning, run, getClient } = usePlanFlow();
  // E8: via-waypoint re-route. Reuses usePlanFlow's singleton RoutingClient
  // (via the getClient getter — see usePlanFlow.ts's docstring on why it's a
  // getter, not a value) rather than spawning a second worker.
  const viaReplan = useViaReplan(getClient);

  const [tab, setTab] = useState<Tab>('plan');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [harbors, setHarbors] = useState<Harbor[]>([]);
  const [origin, setOrigin] = useState<PickedPoint | null>(null);
  const [destination, setDestination] = useState<PickedPoint | null>(null);
  const [departureMs, setDepartureMs] = useState(() => nextFullHourMs());
  // Pre-first-plan via draft, mirroring origin/destination — only read once
  // `plan` is null. Once a plan exists, the committed plan.request.viaPoints
  // *is* the via list (see `viaPoints` below): every edit past that point
  // goes through a replan, so there is no separate optimistic draft to keep
  // in sync — a rejected replan leaves plan.request.viaPoints (and thus the
  // displayed list) exactly where it was, which is the "snap back" behavior
  // ViaMarkers/the panel both rely on.
  const [draftViaPoints, setDraftViaPoints] = useState<LatLon[]>([]);
  const viaPoints = plan ? plan.request.viaPoints : draftViaPoints;
  // null = tap-to-pick disarmed; 'origin'/'destination'/'via' = MapView.tapActive
  // is armed for that target. Disarmed by: a tap resolving (handleMapTap),
  // a harbor-search pick filling the armed field (handlePickOrigin/
  // handlePickDestination), switching away from the Plan tab
  // (handleTabChange), or the cancel banner/Escape (handleCancelTapPick) —
  // every path a user could take that should stop treating the next map tap
  // as a coordinate pick. 'via' extends the same machinery (E8): all of the
  // above disarm paths apply to it unchanged.
  const [tapTarget, setTapTarget] = useState<TapTarget | null>(null);

  // Eager load, matching spec §7's "first load downloads ~30-40 MB" —
  // mask/polars/harbors are meant to be fetched up front, not deferred to
  // first Plan tap. Best-effort: a failed fetch leaves `harbors` empty
  // (HarborPicker just shows no results; map tap-to-pick still works) rather
  // than blocking the rest of the app.
  useEffect(() => {
    let cancelled = false;
    void loadRoutingAssets()
      .then((assets) => {
        if (!cancelled) setHarbors(assets.harbors);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRequestMapTap = useCallback((target: TapTarget) => {
    setTapTarget(target);
  }, []);

  // E8: shared by ViaMarkers' drag-replan, the panel's add/remove/reorder
  // chips, and handleMapTap's 'via' branch below — one place that decides
  // "pre-plan draft edit" vs. "post-plan replan". A rejected replan is a
  // no-op here (viaReplan.replace already resolved null and recorded the
  // error in viaReplan.state; nothing to revert since plan.request.viaPoints,
  // which `viaPoints` derives from, was never touched).
  const handleViaPointsChange = useCallback(
    (next: LatLon[]) => {
      if (!plan) {
        setDraftViaPoints(next);
        return;
      }
      void viaReplan.replace(plan, next).then((updated) => {
        if (updated) setPlan(updated);
      });
    },
    [plan, viaReplan, setPlan],
  );

  const handleMapTap = useCallback(
    (p: LatLon) => {
      setTapTarget((current) => {
        if (!current) return current;
        if (current === 'via') {
          // Side effect inside a setState updater, same as the
          // origin/destination branches below — StrictMode double-invokes
          // updater functions in dev, but handleViaPointsChange's replan
          // path is protected by useViaReplan's synchronous in-flight guard
          // (set before any await), and its pre-plan draft path is a plain,
          // idempotent setState computed identically both times.
          handleViaPointsChange([...viaPoints, p]);
          return null;
        }
        const picked: PickedPoint = { point: p, harborId: null, label: formatLatLon(p) };
        if (current === 'origin') setOrigin(picked);
        else setDestination(picked);
        return null; // disarm
      });
    },
    [viaPoints, handleViaPointsChange],
  );

  const handleRemoveVia = useCallback(
    (index: number) => {
      handleViaPointsChange(viaPoints.filter((_, i) => i !== index));
    },
    [viaPoints, handleViaPointsChange],
  );

  const handleReorderVia = useCallback(
    (index: number, direction: 'up' | 'down') => {
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= viaPoints.length) return;
      const next = [...viaPoints];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      handleViaPointsChange(next);
    },
    [viaPoints, handleViaPointsChange],
  );

  // ViaMarkers' dragend handler: resolves true (accepted) once the plan's
  // committed viaPoints reflect the drag, or false (rejected) to tell the
  // marker to snap back to its last committed position.
  const handleViaDragEnd = useCallback(
    async (index: number, next: LatLon): Promise<boolean> => {
      if (!plan) return false; // ViaMarkers only ever renders once a plan exists; guarded defensively
      const nextVias = plan.request.viaPoints.map((v, i) => (i === index ? next : v));
      const updated = await viaReplan.replace(plan, nextVias);
      if (updated) {
        setPlan(updated);
        return true;
      }
      return false;
    },
    [plan, viaReplan, setPlan],
  );

  const handleCancelTapPick = useCallback(() => setTapTarget(null), []);

  // Harbor-search picks go through here rather than straight to
  // setOrigin/setDestination, so picking a harbor for whichever field is
  // currently armed for tap-to-pick disarms it — otherwise the map would
  // stay armed and silently steal the user's next unrelated map tap.
  // Picking the *other* field while armed leaves the arming untouched.
  const handlePickOrigin = useCallback((p: PickedPoint) => {
    setOrigin(p);
    setTapTarget((current) => (current === 'origin' ? null : current));
  }, []);

  const handlePickDestination = useCallback((p: PickedPoint) => {
    setDestination(p);
    setTapTarget((current) => (current === 'destination' ? null : current));
  }, []);

  // Tap-to-pick arming is scoped to the Plan tab (that's the only place it
  // can be armed from) — leaving it armed while on Routes/Live would let a
  // stray tap on the map overwrite origin/destination without any visible
  // indicator in view.
  const handleTabChange = useCallback((next: Tab) => {
    setTab(next);
    if (next !== 'plan') setTapTarget(null);
  }, []);

  // Escape is the keyboard equivalent of the banner's cancel button below.
  useEffect(() => {
    if (!tapTarget) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTapTarget(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tapTarget]);

  const handlePlan = useCallback(() => {
    if (!origin || !destination) return;
    void run(
      {
        origin: origin.point,
        destination: destination.point,
        // Whatever via chips are currently shown feed into the next plan
        // request, whether that's the pre-plan draft or (re-planning from
        // scratch with new origin/destination while a plan is still active)
        // the previous plan's committed via list.
        viaPoints,
        originHarborId: origin.harborId,
        destinationHarborId: destination.harborId,
        departureMs,
        settings,
      },
      `${origin.label} → ${destination.label}`,
    );
  }, [origin, destination, departureMs, settings, run, viaPoints]);

  // The Plan button independently guards offline (spec §4) on top of the
  // banner; canPlan also requires both endpoints and an idle/error (not
  // already in-flight) planning phase.
  const canPlan =
    origin !== null && destination !== null && online && (planning.phase === 'idle' || planning.phase === 'error');
  const planDisabledReason = online ? null : t('error.offline');

  const plannerPlanningState = toPlannerPlanningState(planning, departureMs, t);
  const stale = plan !== null && isStaleForecast(plan);

  return (
    <div className="app-shell">
      {/* Base layer: full-viewport map. Header/banners/bottom-sheet below are
          positioned overlays painted on top of it (later in DOM order, same
          stacking context — no z-index needed), each occupying only its own
          natural height, so untouched screen area still reaches the map for
          tap-to-pick. */}
      <div className="map-area">
        {/* MapView's label language is baked in at first mount (see
            MapView.tsx's own comment) — a live language switch does not
            re-diff the style/labels. Documented limitation, not a bug:
            re-styling in place risked disturbing RouteLayer/BoatMarker's
            child-added sources; a full remount would need viewport capture
            plumbing this assembly pass deliberately keeps out of scope. */}
        <MapView tapActive={tapTarget !== null} onTap={handleMapTap}>
          <RouteLayer
            plan={plan}
            rig={rig}
            activeLegIndex={activeLegIndex}
            viaReplanning={viaReplan.state.replanning}
            onViaDragEnd={handleViaDragEnd}
          />
          {/* LiveView must live inside MapView's subtree so its BoatMarker
              child can resolve useMapInstance() (see E6's report). Styled to
              occupy the same bottom-sheet screen region as .app-bottom-sheet
              below, even though it's a different DOM subtree. Only mounted
              while the Live tab is active — switching away stops GPS
              tracking rather than running it in the background. */}
          {tab === 'live' && <LiveView />}
        </MapView>
      </div>

      <header className="app-header">
        <h1>{t('app.title')}</h1>
        <div className="app-header-actions">
          <button type="button" aria-label={t('nav.langToggle')} onClick={() => setLang(lang === 'de' ? 'en' : 'de')}>
            {lang === 'de' ? 'EN' : 'DE'}
          </button>
          <button type="button" aria-label={t('about.open')} onClick={() => setAboutOpen(true)}>
            ⓘ
          </button>
        </div>
      </header>

      <div className="banner-area">
        {!online && <Banner kind="warning">{t('banner.offline')}</Banner>}
        {stale && <Banner kind="warning">{t('route.staleForecast')}</Banner>}
        {persistenceError && (
          <Banner kind="error" onDismiss={clearPersistenceError} dismissLabel={t('banner.dismiss')}>
            {t('banner.persistenceError')}
          </Banner>
        )}
        {tapTarget && (
          <Banner kind="info" onDismiss={handleCancelTapPick} dismissLabel={t('banner.tapPick.cancel')}>
            {t('banner.tapPick', { target: t(TAP_TARGET_LABEL_KEY[tapTarget]) })}
          </Banner>
        )}
        {viaReplan.state.error && (
          <Banner kind="error" onDismiss={viaReplan.clearError} dismissLabel={t('banner.dismiss')}>
            {t(viaReplan.state.error)}
          </Banner>
        )}
        {viaReplan.state.droppedCount > 0 && (
          <Banner kind="info" onDismiss={viaReplan.clearDroppedNotice} dismissLabel={t('banner.dismiss')}>
            {t('banner.viaTooClose')}
          </Banner>
        )}
      </div>

      <div className="app-bottom-sheet">
        <nav className="app-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'plan'} onClick={() => handleTabChange('plan')}>
            {t('nav.plan')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'routes'} onClick={() => handleTabChange('routes')}>
            {t('nav.routes')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'live'} onClick={() => handleTabChange('live')}>
            {t('nav.live')}
          </button>
        </nav>

        <div className="app-panel">
          {tab === 'plan' && (
            <PlannerPanel
              harbors={harbors}
              origin={origin}
              destination={destination}
              onPickOrigin={handlePickOrigin}
              onPickDestination={handlePickDestination}
              onRequestMapTap={handleRequestMapTap}
              viaPoints={viaPoints}
              onRemoveVia={handleRemoveVia}
              onReorderVia={handleReorderVia}
              viaReplanning={viaReplan.state.replanning}
              departureMs={departureMs}
              onDepartureChange={setDepartureMs}
              settings={settings}
              onSettingsChange={setSettings}
              canPlan={canPlan}
              planDisabledReason={planDisabledReason}
              onPlan={handlePlan}
              planning={plannerPlanningState}
            />
          )}
          {tab === 'routes' && (
            <>
              {plan && rig && <RouteSummary plan={plan} rig={rig} onRigChange={setRig} />}
              <PlansList />
            </>
          )}
          {/* tab === 'live': LiveView is already mounted above, inside
              MapView's subtree — its own JSX (toggle, HTS/COG/SOG, hint) is
              what the Live panel shows; nothing extra to render here. */}
        </div>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  );
}
