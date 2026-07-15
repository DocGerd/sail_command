import { useCallback, useEffect, useState } from 'react';
import { useLang, useT } from './i18n';
import { AppStateProvider, useActivePlan, useOnline, usePersistenceError, useSettings } from './state/AppState';
import { usePlanFlow, type PlanningState as FlowPlanningState } from './state/usePlanFlow';
import { loadRoutingAssets } from './services/assets';
import { FORECAST_DAYS } from './services/openMeteo';
import MapView from './components/MapView';
import RouteLayer from './components/RouteLayer';
import PlannerPanel, {
  nextFullHourMs,
  type PickedPoint,
  type PlanningState as PlannerPlanningState,
} from './components/PlannerPanel';
import PlansList from './components/PlansList';
import RouteSummary from './components/RouteSummary';
import LiveView from './components/LiveView';
import Banner from './components/Banner';
import AboutDialog from './components/AboutDialog';
import { isStaleForecast } from './lib/plan';
import { formatLatLon } from './lib/format';
import type { Harbor, LatLon } from './types';

type Tab = 'plan' | 'routes' | 'live';

const FORECAST_HORIZON_MS = FORECAST_DAYS * 86_400_000;

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
  const { plan, rig, setRig, activeLegIndex } = useActivePlan();
  const [persistenceError, clearPersistenceError] = usePersistenceError();
  const { planning, run } = usePlanFlow();

  const [tab, setTab] = useState<Tab>('plan');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [harbors, setHarbors] = useState<Harbor[]>([]);
  const [origin, setOrigin] = useState<PickedPoint | null>(null);
  const [destination, setDestination] = useState<PickedPoint | null>(null);
  const [departureMs, setDepartureMs] = useState(() => nextFullHourMs());
  // null = tap-to-pick disarmed; 'origin'/'destination' = MapView.tapActive
  // is armed for that target, disarmed again the moment a tap resolves.
  const [tapTarget, setTapTarget] = useState<'origin' | 'destination' | null>(null);

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

  const handleRequestMapTap = useCallback((target: 'origin' | 'destination') => {
    setTapTarget(target);
  }, []);

  const handleMapTap = useCallback((p: LatLon) => {
    setTapTarget((current) => {
      if (!current) return current;
      const picked: PickedPoint = { point: p, harborId: null, label: formatLatLon(p) };
      if (current === 'origin') setOrigin(picked);
      else setDestination(picked);
      return null; // disarm
    });
  }, []);

  const handlePlan = useCallback(() => {
    if (!origin || !destination) return;
    void run(
      {
        origin: origin.point,
        destination: destination.point,
        // No via-point UI yet (backlog: issue #4, via-waypoint re-route).
        viaPoints: [],
        originHarborId: origin.harborId,
        destinationHarborId: destination.harborId,
        departureMs,
        settings,
      },
      `${origin.label} → ${destination.label}`,
    );
  }, [origin, destination, departureMs, settings, run]);

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
          <RouteLayer plan={plan} rig={rig} activeLegIndex={activeLegIndex} />
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
      </div>

      <div className="app-bottom-sheet">
        <nav className="app-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'plan'} onClick={() => setTab('plan')}>
            {t('nav.plan')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'routes'} onClick={() => setTab('routes')}>
            {t('nav.routes')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'live'} onClick={() => setTab('live')}>
            {t('nav.live')}
          </button>
        </nav>

        <div className="app-panel">
          {tab === 'plan' && (
            <PlannerPanel
              harbors={harbors}
              origin={origin}
              destination={destination}
              onPickOrigin={setOrigin}
              onPickDestination={setDestination}
              onRequestMapTap={handleRequestMapTap}
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
