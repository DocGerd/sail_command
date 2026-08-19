import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang, useT } from './i18n';
import {
  AppStateProvider,
  useActivePlan,
  useOnline,
  useSettingsPersistenceError,
  useSettings,
} from './state/AppState';
import { usePlanFlow, type PlanningState as FlowPlanningState } from './state/usePlanFlow';
import { dedupeViaPoints } from './state/replan';
import { useLiveReroute } from './state/reroute';
import { useOwnshipGps } from './state/useOwnshipGps';
import { useSessionRestore } from './state/useSessionRestore';
import { loadRoutingAssets } from './services/assets';
import MapView from './components/MapView';
import DataLayers, { HARBOR_CIRCLE_LAYER, SEAMARKS_LAYER } from './components/DataLayers';
import CompassControl from './components/CompassControl';
import ScaleBar from './components/ScaleBar';
import RouteLayer from './components/RouteLayer';
import OwnshipMarker from './components/OwnshipMarker';
import PlannerPanel, {
  harborToPickedPoint,
  nextFullHourMs,
  type PlannerStatus,
  type TapTarget,
} from './components/PlannerPanel';
import SettingsPanel from './components/SettingsPanel';
import PlansList, { type RecalcMode } from './components/PlansList';
import RouteSummary from './components/RouteSummary';
import DepthProfile from './components/DepthProfile';
import LiveView from './components/LiveView';
import AisTraffic from './components/AisTraffic';
import { AIS_VESSEL_LAYER } from './components/AisLayer';
import Banner, { type BannerKind } from './components/Banner';
import AboutDialog from './components/AboutDialog';
import ReloadPrompt from './components/ReloadPrompt';
import UatBadge from './components/UatBadge';
import PanelResizer from './components/PanelResizer';
import { isStaleForecast } from './lib/plan';
import { recalcRequest } from './lib/recalc';
import {
  departureSeedMs,
  pickedPointsOfPlan,
  planFormDirty,
  routingSettingsDirty,
  viaPointsDiffer,
} from './lib/planForm';
import { useWideLayout } from './lib/useWideLayout';
import { useBannerHeight } from './lib/useBannerHeight';
import { usePersistedNumber } from './lib/usePersistedNumber';
import { PANEL_MIN_WIDTH_PX, panelMaxWidthPx } from './lib/panelWidth';
import { formatLatLon } from './lib/format';
import { resolveHarborPickTarget } from './lib/harborGeoJson';
import { boatById, sailIdsOf } from './data/boats';
import { usePersistedBoatId } from './lib/usePersistedBoatId';
import type { MsgKey } from './i18n/dict.de';
import type { Tab } from './lib/sessionSnapshot';
import { boatSnapshot, type Harbor, type LatLon, type PickedPoint, type Plan } from './types';

// The harbor-marker and seamark-glyph layers (DataLayers) each own any click
// that lands on them, so MapView gates a raw tap-pick out on a hit (#38,
// #7). Module-level for a stable identity — MapView syncs it into a ref
// every render.
const INTERACTIVE_MAP_LAYER_IDS = [HARBOR_CIRCLE_LAYER, SEAMARKS_LAYER, AIS_VESSEL_LAYER];

const TAP_TARGET_LABEL_KEY: Record<TapTarget, MsgKey> = {
  origin: 'planner.origin.label',
  destination: 'planner.destination.label',
  via: 'planner.via.label',
};

// Reconciles usePlanFlow.ts's PlanningState (fetching-wind / routing{rig} /
// error{messageKey}) with PlannerPanel's own, coarser-in-naming-only
// PlannerStatus (fetching / routing{rig} / error{message}) — the two hooks
// are owned by different modules, so this adapter is what reconciles them.
// #340: this used to also convert simulatedToMs into a 0-1 `progress`
// fraction of the departure->forecast-horizon window — removed because that
// fraction was never an honest measure of solve progress (the denominator
// was the 6-day forecast horizon, unrelated to how long the solve runs or
// how long the passage takes): a realistic passage completed at a few
// percent by construction, and it reset to 0 at every genoa->fock switch and
// #53 depth-relaxation retry. `rig` alone is now the phase signal, honest
// and bounded ("sail N of 2" — PlannerPanel.tsx renders it).
// Exported for a focused unit test of the phase mapping (App.test.tsx) — the
// full render can't easily hold the transient 'probing-depth' phase, and the
// adapter is the single point where a phase-mapping typo would slip through.
// eslint-disable-next-line react-refresh/only-export-components
export function toPlannerStatus(
  flow: FlowPlanningState,
  t: ReturnType<typeof useT>,
): PlannerStatus {
  switch (flow.phase) {
    case 'idle':
      return { phase: 'idle' };
    case 'fetching-wind':
      return { phase: 'fetching' };
    case 'routing':
      return { phase: 'routing', sailId: flow.sailId, index: flow.index, total: flow.total };
    case 'probing-depth':
      return { phase: 'probing' };
    case 'error':
      return { phase: 'error', message: t(flow.messageKey) };
  }
}

// #64 phase 4 (§3.5): the plan-run error banner presents three distinguishable
// groups. The MsgKey taxonomy already separates them (usePlanFlow); this only
// classifies an existing key for presentation — it adds NO new error typing.
//   - network: offline / rate-limited / wind-service — transient, retryable.
//   - noRoute: error.noRoute.* — the copy already states the next step.
//   - unexpected: anything else (error.internal) — genuine failure.
const NETWORK_ERROR_KEYS: ReadonlySet<MsgKey> = new Set([
  'error.offline',
  'error.rateLimited',
  'error.windService',
]);

export type PlanErrorGroup = 'network' | 'noRoute' | 'unexpected';

// eslint-disable-next-line react-refresh/only-export-components
export function planErrorGroup(key: MsgKey): PlanErrorGroup {
  if (NETWORK_ERROR_KEYS.has(key)) return 'network';
  if (key.startsWith('error.noRoute.')) return 'noRoute';
  return 'unexpected';
}

// Only unexpected failures use the assertive error paint; network and no-route
// are recoverable/expected and read as warnings (both still role="alert").
// eslint-disable-next-line react-refresh/only-export-components
export function planErrorBannerKind(key: MsgKey): BannerKind {
  return planErrorGroup(key) === 'unexpected' ? 'error' : 'warning';
}

// #433: whether "Try again" (re-running handlePlan) can plausibly change the
// outcome — a SEPARATE, orthogonal classification from planErrorGroup above
// (which only picks banner paint). This used to just be
// `planErrorGroup(key) === 'network'`, correct back when every non-network
// failure collapsed onto the single error.internal key; now that #433 has
// split that key by cause, causes differ in whether a retry can help at
// all (CLAUDE.md's #433 bullet has the full per-path reasoning; short
// version: usePlanFlow.ts's run() always disposes+nulls the client refs
// before erroring out of a routing failure, so the NEXT run() builds an
// entirely fresh RoutingClient — real for a crashed worker or an
// undeserializable message, but irrelevant to an input-deterministic
// timeout or a real throw inside planRoute(), which reproduce identically
// against the identical request).
const RETRY_MAY_HELP_KEYS: ReadonlySet<MsgKey> = new Set<MsgKey>([
  ...NETWORK_ERROR_KEYS,
  'error.windUnknown',
  'error.routingCrashed',
  'error.routingMessageError',
  'error.routingInterrupted',
  'error.planSaveFailed',
]);

// eslint-disable-next-line react-refresh/only-export-components
export function planErrorRetryMayHelp(key: MsgKey): boolean {
  return RETRY_MAY_HELP_KEYS.has(key);
}

function AppShell() {
  const t = useT();
  const [lang, setLang] = useLang();
  const online = useOnline();
  // #368: keeps `--sc-banner-height` (app.css's narrow-layout banner-
  // clearance rule) in sync with `.banner-area`'s REAL rendered height —
  // called here purely for that side effect (the hook writes the CSS custom
  // property itself; see its own comment). The return value is unused at
  // this call site; ScaleBar.tsx makes its own separate call to know when to
  // re-measure `.map-stack-tl`'s position.
  useBannerHeight();
  const [settings, setSettings] = useSettings();
  // #54: the selected boat. localStorage (usePersistedBoatId), validated
  // against the catalogue on read — deliberately NOT a `Settings` field; see
  // that hook's own docstring. Held here because BOTH tabs need it: the Boat
  // tab renders the picker, and PlannerPanel's inline safety-depth field
  // derives its minimum from the same selection (#539 item 2).
  const [boatId, setBoatId] = usePersistedBoatId();
  const boat = boatById(boatId);
  const { plan, rig, setRig, activeLegIndex, setPlan } = useActivePlan();
  const [settingsPersistenceError, clearSettingsPersistenceError] = useSettingsPersistenceError();
  const { planning, run, ensureClient } = usePlanFlow();
  // #115: manual "reroute from here" (Live view). Shares the same singleton
  // RoutingClient via ensureClient and, like a via-replan, reuses the plan's
  // STORED wind grid — never refetches, so it stays available offline.
  const liveReroute = useLiveReroute(ensureClient);
  // #25 addendum: standalone "show my position" marker, decoupled from Live
  // View — subscribes to GPS whenever the setting is on, regardless of
  // tab/plan/active state (see useOwnshipGps.ts and OwnshipMarker.tsx).
  const {
    fix: ownshipFix,
    hintVisible: ownshipHintVisible,
    dismissHint: dismissOwnshipHint,
  } = useOwnshipGps(settings.showOwnship);

  const [tab, setTab] = useState<Tab>('plan');
  const [aboutOpen, setAboutOpen] = useState(false);
  const isWide = useWideLayout();

  // #355: resizable desktop left panel. `shellRef`/`panelRef` target
  // `.app-shell`/`.app-bottom-sheet` — plain DOM refs, never given a React
  // `style` prop, so PanelResizer's direct `.style.setProperty` writes
  // during a live drag are never clobbered by an unrelated React re-render
  // of either element (see PanelResizer.tsx's own comment). Both hooks
  // below run unconditionally (rules of hooks) even on narrow, where their
  // output is inert: `--sc-panel-w` is only read inside app.css's
  // `@media (min-width: 1024px)` block, so writing it while narrow has no
  // visual effect, and PanelResizer itself is only ever RENDERED when
  // `isWide` (below) — narrow must not gain a resize affordance even in the
  // accessibility tree, so this is a mount gate, not a CSS `display: none`.
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    // Coalesced to one state update per animation frame — a window resize
    // (e.g. dragging the OS window edge) can fire far more often than that.
    //
    // Accepted cost, not fixed (PR #414 review, Minor 7): this re-renders
    // the WHOLE `AppShell` subtree (including `MapView`, not itself
    // `memo()`-wrapped) on every frame of a window drag-resize, even in the
    // common case where `panelWidthPx === null` (no stored override) and
    // the recomputed `panelMaxPx` therefore has no effect on anything
    // rendered. Bailing on `panelWidthPx === null` was considered and
    // rejected: `panelMaxPx` is also the `max` PROP `PanelResizer` clamps a
    // live drag/keyboard step against, so pausing the update while null
    // would leave that prop stale the moment a user's FIRST interaction
    // arrives after a resize — a real (if narrow) correctness regression
    // traded for an unmeasured perf win. The actual cost here is a React
    // reconciliation pass over a subtree whose OWN effects (MapLibre init,
    // GPS subscriptions, etc.) are keyed on stable deps and so do not re-run
    // on this — not a MapLibre re-init or a network refetch — so this is a
    // CPU cost during an already-CPU-bound user gesture (dragging an OS
    // window edge triggers layout on every browser frame regardless), not
    // demonstrated to be visible. Revisit with a measurement (a profiler
    // trace during a real window drag) before "fixing" this preemptively.
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setViewportWidth(window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  const panelMaxPx = panelMaxWidthPx(viewportWidth);
  const [panelWidthPx, setPanelWidthPx] = usePersistedNumber(
    'sc-panel-width',
    PANEL_MIN_WIDTH_PX,
    panelMaxPx,
  );
  // `useLayoutEffect`, NOT `useEffect` — measured, per the same guard-
  // asymmetry class as `lib/useBannerHeight.ts`'s FIRST-PAINT window (#368):
  // a plain `useEffect` here left a real cold-load frame where a user with a
  // STORED width (e.g. 900px) painted at the `1fr` DEFAULT (636.656px)
  // first, then snapped — measured via a rAF sampler + CPU throttle, FCP
  // landing strictly between an UNSET sample and the 900px one. This is
  // `shellRef`'s OWN root element (`AppShell` returns `.app-shell`
  // directly), not a sibling — unlike `PanelResizer.tsx`'s measurement
  // effect (deliberately `useEffect` there: `panelRef` targets a SIBLING
  // declared earlier in this same JSX, and React attaches a fiber's ref /
  // runs its layout effects as it walks the committed tree in fiber order,
  // so a `useLayoutEffect` there could run before that sibling's ref
  // attaches). `commitAttachRef` for a component's OWN returned host fiber
  // runs before that component's OWN layout effects, so `shellRef.current`
  // is always attached here — no such ordering hazard at THIS call site.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    // `null` (no stored override yet, or just reset) removes the property
    // entirely rather than writing a computed default — app.css's
    // `var(--sc-panel-w, 1fr)` fallback is what must govern then, so today's
    // exact pre-#355 layout is reachable byte-for-byte, not merely
    // approximated by a JS-computed number.
    if (panelWidthPx === null) shell.style.removeProperty('--sc-panel-w');
    else shell.style.setProperty('--sc-panel-w', `${panelWidthPx}px`);
  }, [panelWidthPx]);
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
  // #301: true once the harbors asset load's Promise SETTLES (success OR
  // permanent failure) — gates the plan-form sync effect below (next to
  // planIdRef) so it doesn't write a plan's origin/destination labels before
  // harbor names are resolvable (a harborId lookup would fall back to a raw
  // lat/lon 'tap' label prematurely). Set in BOTH the .then and the .catch of
  // the loadRoutingAssets() effect further down, so a permanently failed
  // asset load (harbors stays [], the documented best-effort path) still
  // lets the sync proceed with tap-labeled points rather than silently never
  // firing.
  const [harborsLoaded, setHarborsLoaded] = useState(false);
  // #301: also written by the plan-form sync effect below (next to
  // planIdRef) whenever a NEW plan.id becomes active — origin/destination
  // from harborToPickedPoint-shaped picks, departureMs from PlansList's own
  // future-else-next-full-hour rule (lib/planForm.ts's departureSeedMs).
  const [origin, setOrigin] = useState<PickedPoint | null>(null);
  const [destination, setDestination] = useState<PickedPoint | null>(null);
  const [departureMs, setDepartureMs] = useState(() => nextFullHourMs());
  // #571 redesign (maintainer ruling: a via edit "is kind of a new route and
  // hence should only calculate once clicked on calculate" — no auto-replan
  // on add/remove/reorder/drag). `draftViaPoints` is now the UNCONDITIONAL
  // source of truth for the via list shown in the panel and fed to the next
  // Plan-route press, whether or not a plan is active — mirroring
  // origin/destination/departureMs, which were already plain form state that
  // only takes effect on the next `run()`. It is EPHEMERAL: never persisted,
  // so a reload always shows the saved plan's own committed via list with any
  // unapplied edits gone (no separate "restore a draft" path exists, same as
  // an unsaved departure/origin edit today). Reset to the active plan's own
  // `request.viaPoints` whenever a NEW plan.id becomes active — see the
  // plan-form sync effect below, which now does this alongside
  // origin/destination/departureMs.
  //
  // RouteLayer.tsx renders ViaMarkers FROM this same draft (its own
  // `draftViaPoints` prop, review fix) — not the committed
  // `plan.request.viaPoints` — so an add/remove/reorder/drag shows up as a
  // marker immediately, in step with the panel list. The committed list
  // still exists (it's what the ROUTE LINE is drawn from, and what a
  // rejected/no-op state falls back to) and can disagree with the draft
  // between an edit and the next Plan press — `viaDraftStale` below is the
  // disclosure for that gap, on the map; the panel's own Chip/live-region
  // fold (via `formDirty`) is the equivalent disclosure there.
  const [draftViaPoints, setDraftViaPoints] = useState<LatLon[]>([]);
  const viaPoints = draftViaPoints;
  // MAJOR 4 (review, #571 redesign): count of vias the LAST Plan-route press
  // dropped as coincident with a neighbor (dedupeViaPoints, ~60 m threshold)
  // — set in handlePlan below, drives the banner near the other via-editing
  // banners. Recomputed (never accumulated) on every press, including a
  // press that drops nothing (resets to 0) — same one-shot-per-attempt
  // semantics the pre-#571 viaReplan.state.droppedCount had.
  const [droppedViaCount, setDroppedViaCount] = useState(0);
  // null = tap-to-pick disarmed; 'origin'/'destination'/'via' = MapView.tapActive
  // is armed for that target. Disarmed by: a tap resolving (handleMapTap),
  // a harbor-search pick filling the armed field (handlePickOrigin/
  // handlePickDestination), switching away from the Plan tab
  // (handleTabChange), or the cancel banner/Escape (handleCancelTapPick) —
  // every path a user could take that should stop treating the next map tap
  // as a coordinate pick. 'via' extends the same machinery (E8): all of the
  // above disarm paths apply to it unchanged.
  const [tapTarget, setTapTarget] = useState<TapTarget | null>(null);

  // #571 redesign REMOVED the Phase-E clobber-guard `planIdRef` that used to
  // live here: it existed ONLY to protect the two via-replan resolution
  // sites (handleViaPointsChange/handleViaDragEnd) against a late-resolving
  // async replan landing after the user had switched to a different plan.
  // Neither handler is async-and-plan-mutating any more (both just update
  // `draftViaPoints`, synchronously, in the same tick they're called), so
  // there is no resolve-time race left to guard against. See those two
  // handlers' own comments below.

  // #301: prefills the planner FORM (origin/destination/departure/vias) from
  // the active plan's own stored request — one derivation keyed on plan
  // identity, covering every setPlan caller (PlansList's Load, session
  // restore, a completed run/live-reroute) rather than patching
  // each call site individually. Keyed on plan?.id + harborsLoaded
  // DELIBERATELY, not on `plan`/`harbors`/`lang` object identity: a same-id
  // update to the active plan (e.g. a PlansList "recalculate & replace" on
  // the plan currently on screen) must not clobber a departure the user has
  // just edited — same pattern as RouteLayer.tsx's fitBounds effect, which
  // keys on plan identity rather than the (recreated) result object.
  //
  // #571 redesign: this effect now ALSO resets `draftViaPoints` to
  // `plan.request.viaPoints` (below), for the same reason it resets
  // origin/destination/departureMs — a NEW plan.id means the via list shown
  // should be that plan's own, discarding any unapplied draft edit left over
  // from whatever was active before (draft vias are deliberately EPHEMERAL,
  // never persisted — see `draftViaPoints`'s own comment above).
  //
  // syncedPlanIdRef makes the write happen at most ONCE per plan id
  // (deterministic even under StrictMode's dev-only double-invoke): gated
  // behind `harborsLoaded` so a plan that becomes active before the harbors
  // asset load settles doesn't sync with premature (harbor-id-lookup-miss)
  // tap labels — the ref is only advanced inside the gated branch, so once
  // harborsLoaded flips true the effect re-fires for the SAME (still
  // unsynced) plan id and resolves the real harbor labels then.
  //
  // No-ops on `plan === null`: GPX import deliberately calls setPlan(null)
  // *and* seeds the draft directly in the same batch (handleImportRoute
  // below) — syncing here would clobber that import. handleImportRoute also
  // resets this ref to null alongside its setPlan(null): without that reset,
  // re-loading the SAME plan id later (e.g. re-opening plan A from PlansList
  // after a GPX import) would find the ref already advanced to that id from
  // an earlier load and silently skip the sync, leaving the form on stale
  // GPX-draft values while planFormDirty reads the freshly-loaded plan as
  // dirty — backwards, since the form would actually be WRONG.
  const syncedPlanIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || !harborsLoaded) return;
    if (syncedPlanIdRef.current === plan.id) return;
    syncedPlanIdRef.current = plan.id;
    const { origin: syncedOrigin, destination: syncedDestination } = pickedPointsOfPlan(
      plan,
      harbors,
      lang,
    );
    setOrigin(syncedOrigin);
    setDestination(syncedDestination);
    setDepartureMs(departureSeedMs(plan));
    setDraftViaPoints(plan.request.viaPoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on plan id + harborsLoaded deliberately, see the comment above
  }, [plan?.id, harborsLoaded]);

  // Eager load, matching spec §7's first-load budget (measured ~44 MB) —
  // mask/polars/harbors are meant to be fetched up front, not deferred to
  // first Plan tap. Best-effort: a failed fetch leaves `harbors` empty
  // (HarborPicker just shows no results; map tap-to-pick still works) rather
  // than blocking the rest of the app. Either branch also flips
  // harborsLoaded (#301) — a permanent failure must still unblock the
  // plan-form sync effect above, not silently leave it waiting forever.
  useEffect(() => {
    let cancelled = false;
    void loadRoutingAssets()
      .then((assets) => {
        if (!cancelled) {
          setHarbors(assets.harbors);
          setHarborsLoaded(true);
        }
      })
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) setHarborsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRequestMapTap = useCallback((target: TapTarget) => {
    setTapTarget(target);
  }, []);

  // #571 redesign: shared by the panel's add/remove/reorder chips and
  // handleMapTap's 'via' branch below. Used to branch on `plan` (pre-plan
  // draft edit vs. post-plan replan) — now it's a PLAIN, synchronous
  // `draftViaPoints` write regardless of whether a plan is active. The
  // maintainer's #571 ruling: removing a waypoint "is kind of a new route
  // and hence should only calculate once clicked on calculate" — so no
  // network call, no worker call, nothing async happens here at all. Draft
  // edits take effect only on the next explicit Plan-route press
  // (handlePlan below, which already reads `viaPoints` — i.e. this same
  // draft), exactly like an origin/destination/departure/settings edit
  // already did.
  const handleViaPointsChange = useCallback((next: LatLon[]) => {
    setDraftViaPoints(next);
  }, []);

  const handleMapTap = useCallback(
    (p: LatLon) => {
      setTapTarget((current) => {
        if (!current) return current;
        if (current === 'via') {
          // Side effect inside a setState updater, same as the
          // origin/destination branches below — StrictMode double-invokes
          // updater functions in dev, but handleViaPointsChange is now a
          // plain, idempotent setState computed identically both times (no
          // async replan path any more — see its own comment above).
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

  // ViaMarkers' dragend handler. Markers are now rendered FROM the draft
  // (RouteLayer.tsx's `draftViaPoints` prop, review fix — markers used to be
  // positioned from the committed `plan.request.viaPoints`, which required a
  // reference-equality lookup here that broke on a SECOND drag of the same
  // marker: the first drag replaces the draft element with a new object, so
  // `plan.request.viaPoints[index]` was no longer found by `indexOf` on any
  // later drag, and the marker silently stopped responding — BLOCKER,
  // measured in a real browser). With markers sourced from the draft,
  // `index` IS a draft index directly — no lookup needed, and always valid
  // by construction (ViaMarkers builds it from `draftViaPoints.map`). A drag
  // must not replan either — #571 redesign — just update the draft; always
  // "accepted" (`true`) since there is no longer a case where the dragged
  // point can't be found.
  const handleViaDragEnd = useCallback(
    async (index: number, next: LatLon): Promise<boolean> => {
      if (!plan) return false; // ViaMarkers only ever renders once a plan exists; guarded defensively
      setDraftViaPoints(draftViaPoints.map((v, i) => (i === index ? next : v)));
      return true;
    },
    [plan, draftViaPoints],
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

  // GPX import (#3): seed a FRESH planner draft from a parsed .gpx. Import is
  // prefill-only (design §7): it must never mutate an active plan. So it clears
  // any active plan (setPlan(null)) and sets the draft origin/destination/via
  // state directly, alongside setDraftViaPoints rather than through
  // handleViaPointsChange — not because that handler is unsafe to call (#571
  // redesign: it is now a plain, unconditional setDraftViaPoints, same as
  // this call would be), but because import needs to clear `plan` AND seed
  // origin/destination/vias together, in the SAME batch, which
  // handleViaPointsChange alone doesn't do. After this the panel shows a
  // clean draft; the user sets departure/options and presses Plan, which
  // mints a new plan. (draftViaPoints is read unconditionally now — see
  // its own comment above `viaPoints` — so clearing the plan and seeding
  // the draft in the same batch is coherent regardless.)
  const handleImportRoute = useCallback(
    (o: PickedPoint, d: PickedPoint, vias: LatLon[]) => {
      setPlan(null);
      // #301: also clear the sync guard so a later re-load of the SAME plan
      // id (e.g. the user re-opens plan A from PlansList after importing a
      // GPX) re-syncs the form instead of finding the ref already advanced
      // to that id from an earlier load and silently skipping the sync —
      // see the guard's own comment at its declaration above.
      syncedPlanIdRef.current = null;
      setDraftViaPoints(vias);
      handlePickOrigin(o);
      handlePickDestination(d);
    },
    [setPlan, handlePickOrigin, handlePickDestination],
  );

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

  // #113: restores the last session's plan/rig/tab on boot (pure local
  // replay of PlansList's getPlan→setPlan path) and persists the small
  // session snapshot on every plan/tab/rig change. Goes through
  // handleTabChange, not raw setTab: the restore's getPlan is async, so the
  // user can arm tap-to-pick on the initial Plan tab before it resolves — a
  // raw setTab would then switch tabs with the pick still armed, letting a
  // stray map tap overwrite origin/destination from Routes/Live (the exact
  // state handleTabChange's disarm exists to prevent).
  useSessionRestore(tab, handleTabChange);

  // #64 phase 3: "Details ansehen" from the Plan-tab Ergebnis strip switches to
  // the Routes tab AND moves focus to its Ergebnis heading (user-initiated, so
  // moving focus is correct). The heading only exists once the Routes panel is
  // mounted (panels are conditionally rendered), so focus is applied in an
  // effect after the tab switch commits.
  const routeResultHeadingRef = useRef<HTMLHeadingElement>(null);
  // A ref, not state: setting it must not trigger a render (the tab change
  // already does), and the focus effect keys off the `tab` transition, which
  // is exactly when the Routes heading first mounts.
  const pendingResultFocusRef = useRef(false);
  const handleViewDetails = useCallback(() => {
    handleTabChange('routes');
    pendingResultFocusRef.current = true;
  }, [handleTabChange]);
  useEffect(() => {
    if (tab === 'routes' && pendingResultFocusRef.current) {
      pendingResultFocusRef.current = false;
      routeResultHeadingRef.current?.focus();
    }
  }, [tab]);

  // #299: the safety-depth field's discoverable link to the Boat tab (see
  // PlannerPanel.tsx's own comment). MIRRORS handleViewDetails/
  // routeResultHeadingRef above exactly, corrected from an earlier version
  // of this comment that WRONGLY claimed switching tabs alone moves focus
  // (PR #486 review, Major 1 — measured: activating the link left
  // `document.activeElement` on `document.body`, since the button lives
  // inside PlannerPanel, which UNMOUNTS the instant `tab` becomes 'boat',
  // taking the focused element with it). SettingsPanel's first Card heading
  // is only a "landing spot" once this effect actually focuses it —
  // `titleTabIndex={-1}` alone (SettingsPanel.tsx) makes it a focus TARGET,
  // it does not by itself receive focus.
  const boatSettingsHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingBoatFocusRef = useRef(false);
  const handleOpenBoatSettings = useCallback(() => {
    handleTabChange('boat');
    pendingBoatFocusRef.current = true;
  }, [handleTabChange]);
  useEffect(() => {
    if (tab === 'boat' && pendingBoatFocusRef.current) {
      pendingBoatFocusRef.current = false;
      boatSettingsHeadingRef.current?.focus();
    }
  }, [tab]);

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
    // MAJOR 4 (review, #571 redesign): usePlanFlow.ts's run() dedupes vias
    // internally (~60 m coincident-waypoint guard) but has no banner surface
    // of its own to disclose a drop from — the pre-#571 UI never needed one
    // there, because a via edit on an EXISTING plan used to go through
    // useViaReplan.replace(), which surfaced its own droppedCount via this
    // same banner (state/replan.ts's dedupeViaPoints, reused here). Now that
    // every via edit on an existing plan reaches run() too, that disclosure
    // has to happen here instead — using the identical pure helper, purely
    // to compute what's about to be dropped (run() still performs its own
    // dedupe as the actual, authoritative enforcement; this is presentation
    // only and duplicating the check costs nothing since it's O(vias)).
    setDroppedViaCount(dedupeViaPoints(origin.point, viaPoints, destination.point).droppedCount);
    void run(
      {
        origin: origin.point,
        destination: destination.point,
        // The draft via list (App.tsx's draftViaPoints — the unconditional
        // source since the #571 redesign) is what the next plan request gets;
        // there is no committed-list branch left. run() dedupes it again
        // internally; the pre-check above only computes what that will drop.
        viaPoints,
        originHarborId: origin.source === 'harbor' ? origin.harborId : null,
        destinationHarborId: destination.source === 'harbor' ? destination.harborId : null,
        departureMs,
        settings,
        // #54 / #572: the one production call site with no existing plan to
        // inherit from — every other constructor (recalcRequest,
        // replanWithVias, rerouteFromFix) spreads/copies an existing
        // request's own values instead, and MUST keep doing so: spec §I.3
        // makes the boat a property of the plan, so a saved plan is re-solved
        // against the boat it was planned for, never against today's picker.
        // This is the only site that reads the LIVE selection.
        //
        // Both fields come from the same `boat`, so the sails a plan compares
        // and the hull it is solved against can never name different boats.
        sailIds: sailIdsOf(boat),
        // #54 spec §I.3: denormalised by value, so the saved plan can be
        // rendered without the catalogue.
        //
        // #572: this was `defaultBoatSnapshot()`, which pinned it to the
        // Salona 45 whatever the picker showed. `request.boat.id` is what
        // workerClient.ts resolves the polar tables AND the §C.4(a)
        // relaxation floor from, so the constant here silently solved every
        // boat's plan on the wrong hull while the picker, the tier chip, the
        // keel sentence and the safety-depth field all described the boat the
        // user actually picked.
        boat: boatSnapshot(boat),
      },
      `${origin.label} → ${destination.label}`,
    );
  }, [origin, destination, departureMs, settings, run, viaPoints, boat]);

  // #114: recalculate a saved plan with a FRESH forecast — seeds run() from
  // the plan's own stored request (origin/destination/vias/settings) with the
  // editor's departure. Sharply distinct from the via-replan above, which
  // reuses the stored grid and never refetches. Default mode saves a NEW
  // plan under a derived name; the two-tap-confirmed 'replace' mode persists
  // under the original id (overwriting it only if the run succeeds).
  const handleRecalculate = useCallback(
    (recalcPlan: Plan, departureMs: number, mode: RecalcMode): Promise<void> => {
      const req = recalcRequest(recalcPlan, departureMs);
      return mode === 'replace'
        ? run(req, recalcPlan.name, { replacePlanId: recalcPlan.id })
        : run(req, t('plansList.recalcName', { name: recalcPlan.name }));
    },
    [run, t],
  );

  // #115: reroute the ACTIVE plan from the current GPS fix (LiveView passes
  // the fix point). The result is a NEW plan (fresh id, derived name) — the
  // original stays untouched — and it becomes active unconditionally on
  // success, following run()'s precedent (a fresh id is never "the same
  // plan, possibly superseded": it's the routed result the user explicitly
  // just asked for; planIdRef's clobber guard exists only for replans that
  // update a specific existing plan in place).
  const handleLiveReroute = useCallback(
    (fixPoint: LatLon) => {
      if (!plan) return;
      void liveReroute
        .reroute(plan, fixPoint, t('live.reroute.name', { name: plan.name }))
        .then((rerouted) => {
          if (rerouted) setPlan(rerouted);
        });
    },
    [plan, liveReroute, setPlan, t],
  );

  // The Plan button independently guards offline (spec §4) on top of the
  // banner; canPlan also requires both endpoints and an idle/error (not
  // already in-flight) planning phase.
  // #114: `runBusy` is that same in-flight condition on its own — shared by
  // canPlan and the PlansList recalc actions, so no two runs can overlap
  // regardless of which surface starts them.
  // #115: liveReroute joins the same mutual exclusion — a live reroute is a
  // solver run on the shared client like any other.
  // #571 redesign: a via edit is NEVER part of this condition any more — it
  // only ever touches `draftViaPoints` synchronously, so there is nothing
  // for it to be "in flight" with.
  const runBusy =
    !(planning.phase === 'idle' || planning.phase === 'error') || liveReroute.state.rerouting;
  const canPlan = origin !== null && destination !== null && online && !runBusy;
  // §3.5: the primary button always states WHY it's disabled. Offline is the
  // most blocking (nothing can be planned), then a missing endpoint. When both
  // endpoints are set and online, the button is enabled — reason is null.
  // #571 redesign REVERTED a via-replanning-in-flight branch that used to sit
  // here: a via edit no longer disables anything (see `runBusy` above), so
  // this reason is back to exactly the two pre-#571 cases.
  const planDisabledReason = !online
    ? t('error.offline')
    : origin === null || destination === null
      ? t('planner.disabled.pickEndpoints')
      : null;

  const plannerStatus = toPlannerStatus(planning, t);
  const stale = plan !== null && isStaleForecast(plan);
  // #301: true when the form (origin/destination/departure/vias/live
  // settings) has drifted from the plan actually on screen — a re-run right
  // now would produce a DIFFERENT route than the displayed one. Guarded on
  // origin/destination being non-null: right after loading a plan there's a
  // one-effect-tick window where `plan` is already set but the #301 sync
  // effect above hasn't yet written origin/destination (nor `draftViaPoints`,
  // now synced in the SAME effect) — reading false there (nothing to compare
  // yet) avoids a one-frame false-dirty flicker rather than feeding
  // planFormDirty a stale/null form.
  // `harbors.length > 0` (PR #443 review, Minor) tells planFormDirty whether
  // a harborId mismatch is trustworthy — see planForm.ts's own comment on
  // the `harborsAvailable` parameter for why an empty list must suppress
  // just that one comparison.
  // #571 redesign: `viaPoints` (== `draftViaPoints`) is now part of the
  // snapshot planFormDirty compares — see PlanFormSnapshot's own comment.
  const formDirty =
    plan && origin && destination
      ? planFormDirty(
          plan,
          { origin, destination, departureMs, viaPoints, settings },
          harbors.length > 0,
        )
      : false;
  // #571 redesign: the MAP-side counterpart of the same signal, fed to
  // ViaMarkers via RouteLayer's `viaReplanning` prop (kept exactly that PROP
  // NAME — see ViaMarkers.tsx's own comment on the identically-repurposed
  // prop). Narrower than `formDirty` on purpose — the map disclosure is
  // specifically about the via list, not every dirty form field.
  //
  // Guarded on `origin !== null && destination !== null` for the SAME reason
  // `formDirty` is, just above: right after loading a plan there's a
  // one-effect-tick window where `plan` is already set but the sync effect
  // hasn't yet written origin/destination/draftViaPoints — reading false
  // there avoids comparing the stale/initial draft against the newly active
  // plan's via list (review finding: measured on a warm reload, this window
  // made the chip briefly disagree with the panel's own, correctly-silent
  // stale indicator). `plan !== null` mirrors ViaMarkers' OWN precondition —
  // it renders nothing without an active plan.
  const viaDraftStale =
    plan !== null &&
    origin !== null &&
    destination !== null &&
    viaPointsDiffer(draftViaPoints, plan.request.viaPoints);
  // #299 fix (PR #486 review): the cross-tab staleness BANNER (.banner-area,
  // below) intentionally uses this NARROWER signal instead of `formDirty` —
  // see routingSettingsDirty's own comment in lib/planForm.ts for why (in
  // short: origin/departure can legitimately drift after a Live reroute with
  // no user edit at all, which would otherwise make the banner cry wolf the
  // instant a reroute succeeds; Routes/Live/Boat have no UI to touch
  // origin/destination/departure regardless, only Settings). PlannerPanel's
  // own Chip keeps reading the broader `formDirty` unchanged; its live
  // region does NOT (Refs #299, cross-PR composition fix over PR #486 —
  // see PlannerPanel.tsx's own `statusText` comment): folding the full
  // `formDirty` there would double-announce exactly the cases this Banner
  // already covers, so PlannerPanel computes this SAME `settingsDirty`
  // predicate itself (it already receives `plan`/`settings` as props) and
  // folds the stale sentence only for `formDirty && !settingsDirty` — the
  // complement this Banner cannot see.
  const settingsDirty = plan ? routingSettingsDirty(plan, settings) : false;

  return (
    <div className="app-shell" ref={shellRef}>
      {/* Base layer: full-viewport map. Header/banners/bottom-sheet below are
          positioned overlays painted on top of it (later in DOM order, same
          stacking context), each occupying only its own natural height, so
          untouched screen area still reaches the map for tap-to-pick. That
          DOM-order-only assumption is NOT sufficient across this whole set:
          #208 found `.app-bottom-sheet` and the tab strip inside it each
          able to bury (or be buried by) the map's own chrome depending on
          which one happened to paint last. The full, COMPLETE resolution —
          every participant, the ordering principle, and why it takes three
          tiers rather than one more z-index bump — lives in ONE place, the
          comment above `.app-header` in app.css; read it there rather than
          here, since duplicating it in two files is how it would drift. */}
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
          {/* #155: the top-left map-overlay stack. DataLayers' toggles and the
              compass are static flex children of one absolutely-positioned
              column (app.css .map-stack-tl), so neither control carries its
              own offsets and they can never overlap each other. DOM order is
              paint order — depth/seamark toggles above, compass below.
              Always-mounted, plan-independent (#38/#39) — must NOT live in
              RouteLayer, which renders null until a plan exists. */}
          <div className="map-stack-tl">
            <DataLayers onHarborPick={handleHarborPick} />
            {/* Track-up is available on every tab whenever showOwnship is on
                (#155 decision 2) — the map is shared chrome, so its
                orientation must not flip on a tab switch. */}
            <CompassControl fix={ownshipFix} showOwnship={settings.showOwnship} />
          </div>
          <RouteLayer
            plan={plan}
            rig={rig}
            activeLegIndex={activeLegIndex}
            draftViaPoints={draftViaPoints}
            viaReplanning={viaDraftStale}
            onViaDragEnd={handleViaDragEnd}
          />
          {/* #25 addendum: the standalone ownship marker — always mounted
              (like DataLayers above), gated only on there being a fix, which
              useOwnshipGps only ever produces while settings.showOwnship is
              on. Renders in ANY tab/plan state, Live View included; LiveView
              itself no longer renders a marker (see its #25 comment), so this
              is the single place BoatMarker ever renders — no dedupe logic
              needed beyond that. */}
          <OwnshipMarker fix={ownshipFix} />
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
          {tab === 'live' && (
            <>
              {/* #25 AIS live traffic overlay — Live tab only, inside MapView's
                  subtree for the map context. Fully inert without a key. */}
              <AisTraffic
                apiKey={settings.aisApiKey}
                ownMmsi={settings.ownMmsi}
                plan={plan}
                rig={rig}
                activeLegIndex={activeLegIndex}
              />
              <LiveView
                panelSlot={isWide ? liveSlot : null}
                reroute={{
                  busy: runBusy,
                  rerouting: liveReroute.state.rerouting,
                  onReroute: handleLiveReroute,
                }}
              />
            </>
          )}
          {/* #155: passive nautical scale bar, bottom-left; pointer-events:none,
              so map taps pass through it. DOM order alone does NOT keep it
              clear of everything that matters — #208 found it fully buried
              under `.app-bottom-sheet` on the Plan/Routes tabs at every
              narrow viewport, and the expanded MapLibre attribution can still
              cover it too (that one is pre-existing, low-severity #208 NEW-4,
              deliberately left as-is — see ScaleBar.tsx's own z-index note
              for why a z-index here would make it WORSE, not better). It
              discovers and lifts clear of whichever of the narrow-layout
              docked Live readout or `.app-bottom-sheet` itself currently
              occludes this corner (see ScaleBar.tsx's own comment) — no
              layout prop needed. */}
          <ScaleBar />
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
          {/* #107: UAT environment badge — the gate MUST stay this literal
              `__SC_UAT__ ?` ternary IN the title-child slot: Vite's define
              makes it `false ? … : t('app.title')` in production builds,
              which Rollup folds to exactly the pre-#107 child expression —
              dropping the JSX call, the import, and the whole UatBadge
              module graph (incl. its UAT-local dict) so the prod bundle
              stays byte-identical (#96). An `{__SC_UAT__ && <UatBadge />}`
              sibling would NOT: the dead child slot minifies to a `!1`
              residue (measured: 3-byte bundle drift). Never route the flag
              through a prop or wrapper component either — that keeps the
              module referenced. */}
          {__SC_UAT__ ? (
            <>
              {t('app.title')}
              <UatBadge />
            </>
          ) : (
            t('app.title')
          )}
        </h1>
        <div className="app-header-actions">
          <button
            type="button"
            aria-label={t('nav.langToggle')}
            onClick={() => setLang(lang === 'de' ? 'en' : 'de')}
          >
            {lang === 'de' ? t('nav.langToggle.en') : t('nav.langToggle.de')}
          </button>
          {/* #427: was the bare U+24D8 CIRCLED LATIN SMALL LETTER I glyph —
              measured (canvas-vs-notdef comparison) to render as tofu on a
              thin Linux font set, since none of the installed families cover
              that codepoint. Inline SVG removes the font dependency entirely,
              matching the CompassControl.tsx pattern exactly: sizing/stroke/
              fill live in app.css classes (currentColor resolves to the
              button's inherited --sc-fg in both color schemes), not inline
              attributes. The accessible name is unchanged — it was always
              carried by aria-label, never by the glyph. */}
          <button type="button" aria-label={t('about.open')} onClick={() => setAboutOpen(true)}>
            <svg
              className="about-icon-svg"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <circle className="about-icon-ring" cx="12" cy="12" r="9.25" />
              <circle className="about-icon-dot" cx="12" cy="7.6" r="1.2" />
              <rect
                className="about-icon-stem"
                x="10.85"
                y="10.6"
                width="2.3"
                height="7"
                rx="1.15"
              />
            </svg>
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
        {/* #299: a ROUTING-RELEVANT setting has changed since the displayed
            plan was computed — previously ONLY surfaced as a Chip inside
            PlannerPanel's Ergebnis strip (still there, unchanged, and driven
            by the broader `formDirty`), which mounts ONLY on the Plan tab.
            Now that settings can be changed from a THIRD surface (the Boat
            tab) as well as the Plan tab itself, a user on Routes/Live/Boat
            had no on-screen indication that the route on screen no longer
            matches their inputs — a safety-shaped silence for a depth-margin
            parameter, not a polish gap. Tab-independent like every other
            banner-area entry (deliberately NOT gated on `tab !== 'plan'`):
            this repo already has the identical "duplicated with an inline
            surface" shape for `route.staleForecast` above (RouteSummary's
            own inline alert on the Routes tab) and treats that duplication
            as legitimate, not a bug — see App.test.tsx's "the stale-forecast
            banner renders through the real App tree" test comment.
            DELIBERATELY `settingsDirty`, NOT the broader `formDirty` —
            see that constant's own comment above for why (a Live reroute
            legitimately drifts origin/departure with no user edit at all,
            and gating on settings alone both avoids that false positive AND
            covers exactly what's editable from a non-Plan tab). */}
        {settingsDirty && <Banner kind="warning">{t('planner.result.stale')}</Banner>}
        {/* #25 addendum: reuses the SAME one-time hint LiveView shows on its
            own GPS denial (lib/gpsHint.ts's shared claim, live.gpsHint copy)
            — whichever of the two consumers hits the denial first is the one
            that ever shows it, so this is not a second, separate hint. */}
        {ownshipHintVisible && (
          <Banner kind="warning" onDismiss={dismissOwnshipHint} dismissLabel={t('banner.dismiss')}>
            {t('live.gpsHint')}
          </Banner>
        )}
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
            waiting). §3.5: this is now the SINGLE alert surface for plan
            errors (PlannerPanel no longer renders an inline duplicate). Kind
            is chosen per error group; a "Try again" action re-runs the plan on
            recoverable NETWORK errors only (no-route/internal copy already
            states the next step, so retry wouldn't help). Self-clearing like
            offline/stale-forecast above: it tracks planning.phase directly,
            which only leaves 'error' on the next run() attempt. */}
        {planning.phase === 'error' && (
          <Banner
            kind={planErrorBannerKind(planning.messageKey)}
            action={
              // "Try again" re-runs the planner form, so it needs both
              // endpoints — a #114 recalculation can error without any form
              // state (handlePlan would silently no-op), in which case the
              // user retries from the plan row instead. #433: eligibility is
              // now per-cause (planErrorRetryMayHelp), not the coarser
              // per-group check this used to be — see that function's own
              // comment for why the causes that used to collapse onto
              // error.internal differ in whether a retry helps at all.
              planErrorRetryMayHelp(planning.messageKey) && origin !== null && destination !== null
                ? { label: t('banner.retry'), onClick: handlePlan }
                : undefined
            }
          >
            {t(planning.messageKey)}
          </Banner>
        )}
        {tapTarget && (
          <Banner
            kind="info"
            onDismiss={handleCancelTapPick}
            dismissLabel={t('banner.tapPick.cancel')}
          >
            {t('banner.tapPick', { target: t(TAP_TARGET_LABEL_KEY[tapTarget]) })}
          </Banner>
        )}
        {/* #115: live-reroute failures (stale stored forecast, fix outside
            the region, no route) — honest error, never a truncated route.
            #571 redesign: this used to sit alongside a via-replan error
            banner (viaReplan.state.error) — REMOVED, since a via edit no
            longer replans at all, so `useViaReplan` (state/replan.ts) has no
            remaining UI caller and can never produce one. Live reroute is a
            deliberately separate, manual feature (state/reroute.ts) and is
            unaffected by that removal. */}
        {liveReroute.state.error && (
          <Banner
            kind="error"
            onDismiss={liveReroute.clearError}
            dismissLabel={t('banner.dismiss')}
          >
            {t(liveReroute.state.error)}
          </Banner>
        )}
        {/* MAJOR 4 (review, #571 redesign): the last Plan-route press silently
            dropped a too-close via — see droppedViaCount's own comment above
            handlePlan. Reuses the SAME banner.viaTooClose/.plural copy the
            pre-#571 viaReplan-driven banner used (never deleted — see
            dict.de.ts's/dict.en.ts's own note on those two keys), just
            triggered from handlePlan's own pre-check instead of a replan. */}
        {droppedViaCount > 0 && (
          <Banner
            kind="info"
            onDismiss={() => setDroppedViaCount(0)}
            dismissLabel={t('banner.dismiss')}
          >
            {t(droppedViaCount === 1 ? 'banner.viaTooClose' : 'banner.viaTooClose.plural', {
              count: droppedViaCount,
            })}
          </Banner>
        )}
      </div>

      {/* #355: only ever mounted on wide — narrow must not gain a resize
          affordance, and gating on the hook (rather than hiding via CSS)
          keeps a meaningless control out of the phone/tablet-portrait tab
          order entirely. */}
      {isWide && (
        <PanelResizer
          panelRef={panelRef}
          targetRef={shellRef}
          min={PANEL_MIN_WIDTH_PX}
          max={panelMaxPx}
          onCommit={setPanelWidthPx}
          aria-label={t('panel.resizer.label')}
        />
      )}

      <div className="app-bottom-sheet" ref={panelRef}>
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
          {/* #299: static boat/skipper settings — a peer content tab, not a
              modal, and named for its referent rather than "Settings" (see
              the design decision recorded on the issue). */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'boat'}
            onClick={() => handleTabChange('boat')}
          >
            {t('nav.boat')}
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
              onImportRoute={handleImportRoute}
              onRequestMapTap={handleRequestMapTap}
              viaPoints={viaPoints}
              onRemoveVia={handleRemoveVia}
              onReorderVia={handleReorderVia}
              departureMs={departureMs}
              onDepartureChange={setDepartureMs}
              settings={settings}
              onSettingsChange={setSettings}
              boat={boat}
              canPlan={canPlan}
              planDisabledReason={planDisabledReason}
              online={online}
              onPlan={handlePlan}
              planning={plannerStatus}
              plan={plan}
              rig={rig}
              formDirty={formDirty}
              onViewDetails={handleViewDetails}
              onOpenBoatSettings={handleOpenBoatSettings}
            />
          )}
          {tab === 'boat' && (
            <SettingsPanel
              value={settings}
              onChange={setSettings}
              boatId={boatId}
              onBoatIdChange={setBoatId}
              titleRef={boatSettingsHeadingRef}
            />
          )}
          {tab === 'routes' && (
            <>
              {plan && rig && (
                <RouteSummary
                  plan={plan}
                  rig={rig}
                  onRigChange={setRig}
                  resultHeadingRef={routeResultHeadingRef}
                />
              )}
              {plan && rig && (
                <DepthProfile plan={plan} rig={rig} safetyDepthM={settings.safetyDepthM} />
              )}
              <PlansList online={online} busy={runBusy} onRecalculate={handleRecalculate} />
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

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} boat={boat} />
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
