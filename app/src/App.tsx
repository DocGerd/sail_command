import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang, useT } from './i18n';
import {
  AppStateProvider,
  useActivePlan,
  useOnline,
  useSettingsPersistenceError,
  useSettings,
} from './state/AppState';
import { usePlanFlow, type PlanningState as FlowPlanningState } from './state/usePlanFlow';
import { useViaReplan } from './state/replan';
import { loadRoutingAssets } from './services/assets';
import { FORECAST_DAYS } from './services/openMeteo';
import MapView from './components/MapView';
import DataLayers, { HARBOR_CIRCLE_LAYER } from './components/DataLayers';
import RouteLayer from './components/RouteLayer';
import PlannerPanel, {
  harborToPickedPoint,
  nextFullHourMs,
  type PlannerStatus,
  type TapTarget,
} from './components/PlannerPanel';
import PlansList from './components/PlansList';
import RouteSummary from './components/RouteSummary';
import DepthProfile from './components/DepthProfile';
import LiveView from './components/LiveView';
import Banner from './components/Banner';
import AboutDialog from './components/AboutDialog';
import ReloadPrompt from './components/ReloadPrompt';
import { isStaleForecast } from './lib/plan';
import { useWideLayout } from './lib/useWideLayout';
import { formatLatLon } from './lib/format';
import { resolveHarborPickTarget } from './lib/harborGeoJson';
import type { MsgKey } from './i18n/dict.de';
import type { Harbor, LatLon, PickedPoint } from './types';

type Tab = 'plan' | 'routes' | 'live';

const FORECAST_HORIZON_MS = FORECAST_DAYS * 86_400_000;

// The harbor-marker layer (DataLayers) owns any click that lands on it, so
// MapView gates a raw tap-pick out on a harbor hit (#38). Module-level for a
// stable identity — MapView syncs it into a ref every render.
const INTERACTIVE_MAP_LAYER_IDS = [HARBOR_CIRCLE_LAYER];

const TAP_TARGET_LABEL_KEY: Record<TapTarget, MsgKey> = {
  origin: 'planner.origin.label',
  destination: 'planner.destination.label',
  via: 'planner.via.label',
};

// Reconciles usePlanFlow.ts's PlanningState (fetching-wind / routing{rig,
// simulatedToMs} / error{messageKey}) with PlannerPanel's own, coarser
// PlannerStatus (fetching / routing{progress?} / error{message}) — the two
// hooks are owned by different modules and track planning progress at
// different granularities, so this adapter is what reconciles them.
// `progress` is simulatedToMs's advance through the departure->forecast-
// horizon window — an approximation (the router may finish well before the
// horizon), good enough for a progress indicator.
// Exported for a focused unit test of the phase mapping (App.test.tsx) — the
// full render can't easily hold the transient 'probing-depth' phase, and the
// adapter is the single point where a phase-mapping typo would slip through.
// eslint-disable-next-line react-refresh/only-export-components
export function toPlannerStatus(
  flow: FlowPlanningState,
  departureMs: number,
  t: ReturnType<typeof useT>,
): PlannerStatus {
  switch (flow.phase) {
    case 'idle':
      return { phase: 'idle' };
    case 'fetching-wind':
      return { phase: 'fetching' };
    case 'routing': {
      const progress = Math.min(
        1,
        Math.max(0, (flow.simulatedToMs - departureMs) / FORECAST_HORIZON_MS),
      );
      return { phase: 'routing', progress };
    }
    case 'probing-depth':
      return { phase: 'probing' };
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
  const [settingsPersistenceError, clearSettingsPersistenceError] = useSettingsPersistenceError();
  const { planning, run, ensureClient } = usePlanFlow();
  // E8: via-waypoint re-route. Reuses usePlanFlow's singleton RoutingClient
  // (via the ensureClient function — see usePlanFlow.ts's docstring: it
  // lazily creates/inits the client on demand, so a via edit on a plan
  // that was only ever *loaded* from PlansList, never run() in this
  // session, still works) rather than spawning a second worker.
  const viaReplan = useViaReplan(ensureClient);

  const [tab, setTab] = useState<Tab>('plan');
  const [aboutOpen, setAboutOpen] = useState(false);
  const isWide = useWideLayout();
  // #31: on wide, LiveView (which must stay mounted inside MapView's subtree
  // for BoatMarker's map context) portals its textual readout into this
  // panel-column slot. A callback ref into state so the portal target becomes
  // available as soon as the slot commits; changes only on tab/layout switch,
  // never at the 1 Hz GPS cadence, so it costs no extra per-fix re-render.
  const [liveSlot, setLiveSlot] = useState<HTMLDivElement | null>(null);
  // MapView reports at most one error per mount (see its own comment) —
  // this just needs to flip a banner on and let the user dismiss it; there's
  // no retry path since the underlying map instance isn't recreated.
  const [mapError, setMapError] = useState(false);
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

  // Phase-gate fix (E8 clobber guard): tracks which plan is *currently*
  // active, for the two async via-replan resolution sites below to check
  // against once their replan settles. A ref, not a read of `plan` in the
  // closure — handleViaPointsChange/handleViaDragEnd close over the `plan`
  // that was active when the replan *started*; by the time it resolves the
  // user may have loaded a different plan (PlansList), and `updated.id`
  // (replanWithVias always preserves the original plan's id) would still
  // equal that stale closed-over id, so the closure alone can't detect the
  // race — only a value that's re-read at resolve time, synced from
  // whatever `plan` actually is *then*, can.
  //
  // usePlanFlow.run()'s own setPlan(plan) (usePlanFlow.ts) is deliberately
  // NOT guarded the same way: run() always mints a brand-new plan.id, so a
  // completed run is never "the same plan, possibly superseded" — it's a
  // fresh planning request the user just asked for, which should become
  // active even if another plan was loaded while it was in flight. Guarding
  // it by planIdRef would incorrectly block every legitimate run() result
  // (a new id can never match the ref's pre-existing value). The clobber
  // this guards against is specific to replans: an edit to a *specific*,
  // possibly-since-abandoned plan resolving late.
  const planIdRef = useRef<string | null>(plan?.id ?? null);
  useEffect(() => {
    planIdRef.current = plan?.id ?? null;
  }, [plan?.id]);

  // Eager load, matching spec §7's first-load budget (measured ~44 MB) —
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

  // Shared by ViaMarkers' drag-replan, the panel's add/remove/reorder
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
        // Clobber guard (see planIdRef above): commit only if `plan` is
        // still the active plan. replanWithVias preserves the original
        // plan's id, so `updated.id` is always the id this replan targeted
        // — comparing it against planIdRef.current (not the closed-over
        // `plan.id`, which is the same value and would never catch this)
        // is what actually detects that the user moved on. A guarded-out
        // update is a no-op either way: plan.request.viaPoints (which
        // `viaPoints` derives from) was never touched, so there's nothing
        // to revert. Accepted residual: replanWithVias's own save() (see
        // state/replan.ts) already persisted `updated` to IndexedDB before
        // this guard runs — if the user also deleted this plan (PlansList)
        // in the same window, that save silently resurrects it there. Not
        // worth guarding against for a save that's already in flight by the
        // time we could know the delete happened.
        if (updated && updated.id === planIdRef.current) setPlan(updated);
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
        const picked: PickedPoint = { source: 'tap', point: p, label: formatLatLon(p) };
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
      // Same clobber guard as handleViaPointsChange above. A mismatch here
      // reads as a rejection to the caller (marker snaps back) — a dragged
      // via belonging to a plan that's no longer active shouldn't leave its
      // marker looking "accepted" even if the drag technically succeeded.
      if (updated && updated.id === planIdRef.current) {
        setPlan(updated);
        return true;
      }
      return false;
    },
    [plan, viaReplan, setPlan],
  );

  const handleCancelTapPick = useCallback(() => setTapTarget(null), []);
  const handleMapError = useCallback(() => setMapError(true), []);
  const handleDismissMapError = useCallback(() => setMapError(false), []);

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

  // #38: a harbor-marker click builds the SAME endpoint shape a search-picker
  // selection does (harborToPickedPoint) and fills origin-if-empty, else
  // destination — resolveHarborPickTarget documents the tap-to-pick interplay.
  //
  // No race with MapView's generic tap handler: a click that hits the harbor
  // marker layer is gated OUT of that handler (MapView's interactiveLayerIds
  // queries the layer at the click point and bails on a hit — see MapView.tsx),
  // so exactly one handler ever resolves a given click. This handler owns
  // harbor hits; the generic tap owns open-water taps. That gate replaced an
  // earlier belief that React update ordering let this curated pick "win" over
  // a same-event raw-tap pick: it did NOT — handleMapTap sets the raw tap from
  // inside a setState updater (runs during render), so that write was actually
  // queued LAST and clobbered the harbor snap. The armed-pick regression test
  // in App.test.tsx caught it; the gate removes the ordering question entirely.
  const handleHarborPick = useCallback(
    (h: Harbor) => {
      const target = resolveHarborPickTarget(tapTarget, origin !== null);
      if (!target) return;
      const picked = harborToPickedPoint(h, lang);
      if (target === 'origin') handlePickOrigin(picked);
      else handlePickDestination(picked);
    },
    [tapTarget, origin, lang, handlePickOrigin, handlePickDestination],
  );

  // Tap-to-pick arming is scoped to the Plan tab (that's the only place it
  // can be armed from) — leaving it armed while on Routes/Live would let a
  // stray tap on the map overwrite origin/destination without any visible
  // indicator in view.
  const handleTabChange = useCallback((next: Tab) => {
    setTab(next);
    if (next !== 'plan') setTapTarget(null);
  }, []);

  // Escape is the keyboard equivalent of the banner's cancel button below.
  // Gated on !aboutOpen (and not attached at all while About is open, rather
  // than checking aboutOpen inside the handler) so a single Escape with both
  // the dialog and tap-to-pick open only closes the dialog — AboutDialog
  // owns its own Escape listener, and without this gate both would fire off
  // the same keydown.
  useEffect(() => {
    if (!tapTarget || aboutOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTapTarget(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tapTarget, aboutOpen]);

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
        originHarborId: origin.source === 'harbor' ? origin.harborId : null,
        destinationHarborId: destination.source === 'harbor' ? destination.harborId : null,
        departureMs,
        settings,
      },
      `${origin.label} → ${destination.label}`,
    );
  }, [origin, destination, departureMs, settings, run, viaPoints]);

  // The Plan button independently guards offline (spec §4) on top of the
  // banner; canPlan also requires both endpoints, an idle/error (not
  // already in-flight) planning phase, and no via-replan in flight — a
  // fresh run() while a replan of the current plan is pending would race
  // the same "which result wins" question planIdRef's guard exists for
  // above, so it's simplest to just not let one start.
  const canPlan =
    origin !== null &&
    destination !== null &&
    online &&
    (planning.phase === 'idle' || planning.phase === 'error') &&
    !viaReplan.state.replanning;
  const planDisabledReason = online ? null : t('error.offline');

  const plannerStatus = toPlannerStatus(planning, departureMs, t);
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
        <MapView
          tapActive={tapTarget !== null}
          onTap={handleMapTap}
          onMapError={handleMapError}
          interactiveLayerIds={INTERACTIVE_MAP_LAYER_IDS}
        >
          {/* Always-mounted, plan-independent layers (#38/#39) — must NOT
              live in RouteLayer, which renders null until a plan exists. */}
          <DataLayers onHarborPick={handleHarborPick} />
          <RouteLayer
            plan={plan}
            rig={rig}
            activeLegIndex={activeLegIndex}
            viaReplanning={viaReplan.state.replanning}
            onViaDragEnd={handleViaDragEnd}
          />
          {/* LiveView must live inside MapView's subtree: useMapInstance()
              (its BoatMarker child calls it) reads the map instance off a
              React context that MapView provides, and only descendants of
              MapView can see it — a sibling would always get null. On narrow
              it renders its readout inline, styled to occupy the same
              bottom-sheet screen region as .app-bottom-sheet below; on wide
              (#31) it portals that readout into the left panel column's
              `liveSlot` (BoatMarker stays here on the map either way). Only
              mounted while the Live tab is active — switching away stops GPS
              tracking rather than running it in the background. */}
          {tab === 'live' && <LiveView panelSlot={isWide ? liveSlot : null} />}
        </MapView>
      </div>

      <header className="app-header">
        <h1>
          {/* DocGerdSoft brand mark — decorative, the h1 text carries the name.
              Tight viewBox around the two-shape artwork (x 26.96–73.04, y
              22.59–76); fill inherits the header text color. */}
          <svg
            className="app-brand-mark"
            viewBox="24 20 52 58"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M50 22.59L69 55.5L31 55.5Z" />
            <path d="M26.96 62.5L73.04 62.5L63.5 76L36.5 76Z" />
          </svg>
          {t('app.title')}
        </h1>
        <div className="app-header-actions">
          <button
            type="button"
            aria-label={t('nav.langToggle')}
            onClick={() => setLang(lang === 'de' ? 'en' : 'de')}
          >
            {lang === 'de' ? t('nav.langToggle.en') : t('nav.langToggle.de')}
          </button>
          <button type="button" aria-label={t('about.open')} onClick={() => setAboutOpen(true)}>
            ⓘ
          </button>
        </div>
      </header>

      <div className="banner-area">
        <ReloadPrompt />
        {!online && <Banner kind="warning">{t('banner.offline')}</Banner>}
        {mapError && (
          <Banner kind="error" onDismiss={handleDismissMapError} dismissLabel={t('banner.dismiss')}>
            {t('banner.mapError')}
          </Banner>
        )}
        {stale && <Banner kind="warning">{t('route.staleForecast')}</Banner>}
        {settingsPersistenceError && (
          <Banner
            kind="error"
            onDismiss={clearSettingsPersistenceError}
            dismissLabel={t('banner.dismiss')}
          >
            {t('banner.persistenceError')}
          </Banner>
        )}
        {/* Tab-independent: a plan-run error must be visible even while the
            user has switched away from the Plan tab (e.g. to Routes, while
            waiting) — PlannerPanel's own inline alert only renders while
            that tab is mounted. Self-clearing like offline/stale-forecast
            above (no onDismiss): it tracks planning.phase directly, which
            only leaves 'error' on the next run() attempt. */}
        {planning.phase === 'error' && <Banner kind="error">{t(planning.messageKey)}</Banner>}
        {tapTarget && (
          <Banner
            kind="info"
            onDismiss={handleCancelTapPick}
            dismissLabel={t('banner.tapPick.cancel')}
          >
            {t('banner.tapPick', { target: t(TAP_TARGET_LABEL_KEY[tapTarget]) })}
          </Banner>
        )}
        {viaReplan.state.error && (
          <Banner kind="error" onDismiss={viaReplan.clearError} dismissLabel={t('banner.dismiss')}>
            {t(viaReplan.state.error)}
          </Banner>
        )}
        {viaReplan.state.droppedCount > 0 && (
          <Banner
            kind="info"
            onDismiss={viaReplan.clearDroppedNotice}
            dismissLabel={t('banner.dismiss')}
          >
            {t(
              viaReplan.state.droppedCount === 1
                ? 'banner.viaTooClose'
                : 'banner.viaTooClose.plural',
              {
                count: viaReplan.state.droppedCount,
              },
            )}
          </Banner>
        )}
      </div>

      <div className="app-bottom-sheet">
        <nav className="app-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plan'}
            onClick={() => handleTabChange('plan')}
          >
            {t('nav.plan')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'routes'}
            onClick={() => handleTabChange('routes')}
          >
            {t('nav.routes')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'live'}
            onClick={() => handleTabChange('live')}
          >
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
              planning={plannerStatus}
            />
          )}
          {tab === 'routes' && (
            <>
              {plan && rig && <RouteSummary plan={plan} rig={rig} onRigChange={setRig} />}
              {plan && rig && (
                <DepthProfile plan={plan} rig={rig} safetyDepthM={settings.safetyDepthM} />
              )}
              <PlansList />
            </>
          )}
          {/* tab === 'live': LiveView is mounted above, inside MapView's
              subtree (BoatMarker needs the map context). On wide it portals
              its readout into this slot so the panel column isn't empty (#31);
              on narrow the slot isn't rendered and the readout stays a
              bottom-docked card above the tab strip. */}
          {tab === 'live' && isWide && <div className="app-panel-live" ref={setLiveSlot} />}
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
