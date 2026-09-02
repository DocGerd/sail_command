import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Harbor, LatLon, PickedPoint, Plan, RigResult, SailId, Settings } from '../types';
import { useLang, useT } from '../i18n';
// #834: the `harbors` prop is widened from `Harbor[]` to
// `HarborWithReachability[]` below — the selected-endpoint row must see the
// same build-generated `knownDisconnected` field the picker's option row
// already discloses (#652). See that module's own comment for why it lives
// outside the `app/sweep/` #282 closure rather than on `Harbor` in
// `types.ts`.
import type { HarborWithReachability } from '../lib/harborReachability';
import { FORECAST_DAYS } from '../services/openMeteo';
import {
  formatDateTime,
  formatDuration,
  formatLatLon,
  formatNm,
  toLocalInputValue,
} from '../lib/format';
import {
  DATA_AREA,
  GpxParseError,
  MAX_GPX_FILE_BYTES,
  parseGpx,
  type GpxErrorReason,
} from '../lib/gpx';
import { activeRigResult } from '../lib/plan';
import { routingSettingsDirty } from '../lib/planForm';
import { renderRigVerdict, resultSummary, sailLabelKey } from '../lib/resultSummary';
import { useRecentHarbors } from '../lib/useRecentHarbors';
import { formatDepthM } from '../lib/depthDisclosure';
import HarborPicker from './HarborPicker';
import { commitSetting, safetyDepthFieldFor } from './OptionsPanel';
import type { BoatDef } from '../data/boats';
import NumberInput, { formatBound, useClampCorrection } from './NumberInput';
import Card from './Card';
import Field from './Field';
import Button from './Button';
import Chip from './Chip';
import Skeleton from './Skeleton';
// #452: the shallow-water warning is plan-level (ShallowWarning's own note
// explains why) — shared here so the FIRST surface a user sees a result on
// carries the same warning as the Routes tab, not just a second copy of it.
import { ShallowWarning } from './ShallowWarning';
// #612: the non-relaxed complement of that warning, shared for the same
// reason — see MarginalDepthNotice's own doc comment for why it is a quiet
// <p> rather than a second banner.
import { MarginalDepthNotice } from './RouteSummary';

export type TapTarget = 'origin' | 'destination' | 'via';

// This panel's own idle/fetching/routing/error view of planning progress —
// coarser than usePlanFlow.ts's PlanningState in naming only (fetching vs.
// fetching-wind, message vs. messageKey); the 'routing' rig is carried
// through unchanged (#340). App.tsx's toPlannerStatus adapts one to the other.
export type PlannerStatus =
  | { phase: 'idle' }
  | { phase: 'fetching' }
  | { phase: 'routing'; sailId: SailId; index: number; total: number }
  // #53: probing relaxed depth gates after an unreachable requested-depth solve
  | { phase: 'probing' }
  | { phase: 'error'; message: string };

export interface PlannerPanelProps {
  harbors: HarborWithReachability[];
  origin: PickedPoint | null;
  destination: PickedPoint | null;
  onPickOrigin: (p: PickedPoint) => void;
  onPickDestination: (p: PickedPoint) => void;
  // GPX import (#3): prefill origin/destination/viaPoints from a parsed .gpx.
  // The parent owns the planner input state (App.tsx), so import routes through
  // it — origin+destination as tap-source PickedPoints, vias as raw LatLon.
  onImportRoute: (origin: PickedPoint, destination: PickedPoint, viaPoints: LatLon[]) => void;
  onRequestMapTap: (target: TapTarget) => void; // parent arms MapView tap mode
  // #571 redesign: via-waypoint editing. Source of truth is the caller's own
  // DRAFT via list (App.tsx's `draftViaPoints`) — unconditionally, whether
  // or not a plan is active. A via edit never replans in place any more (the
  // maintainer's #571 ruling); it only takes effect on the next explicit
  // Plan-route press. Reorder is up/down buttons, not drag-and-drop (v1
  // scope).
  viaPoints: LatLon[];
  onRemoveVia: (index: number) => void;
  onReorderVia: (index: number, direction: 'up' | 'down') => void;
  // #829: keyboard-reachable equivalents of the map-tap 'via' path — same
  // producer shape as App.tsx's handleMapTap 'via' branch
  // (handleViaPointsChange([...viaPoints, p])), just fed a typed LatLon
  // instead of a map click. onUpdateVia is the same idea for repositioning
  // an already-placed point (spike §2 row 2 / §3.1's "extended slightly").
  onAddVia: (p: LatLon) => void;
  onUpdateVia: (index: number, p: LatLon) => void;
  departureMs: number;
  onDepartureChange: (ms: number) => void;
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  // #539 item 2: the selected boat, read ONLY for this panel's inline
  // safety-depth bounds. The picker itself lives on the Boat tab
  // (SettingsPanel/BoatPicker); this panel never changes the selection.
  boat: BoatDef;
  canPlan: boolean;
  // §3.5: the ONE reason the Plan button (and thus this whole form) is
  // disabled — exactly two possible values today: `error.offline` (nothing
  // can be planned offline) or `planner.disabled.pickEndpoints` (online, but
  // origin/destination aren't both set yet); `null` means enabled. #64 phase
  // 4: while `showOnboarding` below is true, the onboarding line is shown in
  // this slot INSTEAD, and `planDisabledReason` is never rendered alongside
  // it — see `showOnboarding`'s own comment for when each applies.
  //
  // #571 redesign: a dirty/stale form (including an unapplied via edit) is
  // DELIBERATELY NOT a reason here and never disables the button — see
  // `formDirty` below, a wholly separate, non-blocking concept: pressing
  // Plan while dirty is exactly the normal, encouraged way to apply it.
  planDisabledReason: string | null;
  // #64 phase 4 (§3.5): drives the empty/first-run onboarding line, which only
  // makes sense while online AND no plan exists yet — offline gets the
  // `error.offline` disabled reason (planDisabledReason) instead, and once a
  // plan exists (`showOnboarding`'s `!plan` gate) a still-missing endpoint
  // instead gets `planner.disabled.pickEndpoints` — see planDisabledReason's
  // own comment above for the full two-reason enumeration.
  online: boolean;
  onPlan: () => void;
  planning: PlannerStatus;
  // #64 phase 3: the active plan + rig drive the compact Ergebnis strip and the
  // plan-completion announcement. Null before the first plan.
  plan: Plan | null;
  rig: SailId | null;
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

// #829: the coordinate-entry row's seed value, before a user has typed or an
// "edit" trigger has seeded it from an existing via point — the DATA_AREA
// midpoint, which is inside the region by construction (the half-open
// interval below is never on an edge for a midpoint of two bounds that
// differ by 1.6°/1.0°). Module-level so it's computed once, not per render.
const VIA_COORD_DEFAULT: LatLon = {
  lat: (DATA_AREA.south + DATA_AREA.north) / 2,
  lon: (DATA_AREA.west + DATA_AREA.east) / 2,
};

// #829: identical half-open-interval check to gpx.ts's pointFrom (west/south
// inclusive, east/north exclusive) — reusing DATA_AREA rather than a second
// hand-copied bound, per the spike's §3.1 "not a new design decision, it is
// applying an existing one to a second entry point". gpx.ts itself is out of
// this task's scope (its own out-of-bounds check stays the only export
// consumer of DATA_AREA that ALSO throws); this is a second, independent
// reader of the same constant.
// eslint-disable-next-line react-refresh/only-export-components
export function isInViaDataArea(p: LatLon): boolean {
  return !(
    p.lon < DATA_AREA.west ||
    p.lon >= DATA_AREA.east ||
    p.lat < DATA_AREA.south ||
    p.lat >= DATA_AREA.north
  );
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
  onAddVia,
  onUpdateVia,
  departureMs,
  onDepartureChange,
  settings,
  onSettingsChange,
  boat,
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
  // #539 item 2: bounds follow the SELECTED boat (spec J OQ-1's
  // `draftM + 0.1`). Same derivation the Boat tab's own render of this field
  // uses, so the two surfaces still clamp identically.
  const safetyDepthField = safetyDepthFieldFor(boat);
  // #731: the silent blur-clamp's visible correction signal — reset whenever
  // a boat switch moves safetyDepthField's own min/max out from under it. See
  // useClampCorrection's own doc comment.
  const { correctedTo: safetyDepthCorrectedTo, reportCommit: reportSafetyDepthCommit } =
    useClampCorrection(safetyDepthField.min, safetyDepthField.max);
  const { recent, remember } = useRecentHarbors();
  // Per-endpoint "editing" flag: a selected endpoint collapses to a compact row,
  // and "Ändern"/"Change" reopens its combobox without clearing the selection.
  // Arming map-pick clears it so the endpoint re-collapses once the map tap
  // lands on the parent's origin/destination.
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [editingDestination, setEditingDestination] = useState(false);

  // #695: the HarborPicker combobox unmounts on every select/cancel exit, and
  // nothing restored focus, so it dropped to <body>. Deliberately driven from
  // the FOUR exit-path callbacks themselves (onSelect/onCancel below), never
  // from a prop diff: an earlier version of this fix keyed restoration off
  // `!origin || editingOrigin` transitioning true->false, which ALSO fired
  // whenever `origin`/`destination` changed for any OTHER reason — including
  // App.tsx's session/plan-restore sync effect setting them on cold load or
  // on loading a different saved plan mid-session — stealing focus from
  // whatever the user was doing (PR #736 review Blocker; reproduced live: a
  // plain prop change while focus sat on the departure field yanked it to
  // the Change button). A prop diff can only guess why the prop changed; the
  // callback knows the user just acted.
  //
  // `pendingFocusRef` is set by the callback (a ref write, not state — no
  // setState-inside-effect cascade) and consumed by the no-deps effect
  // below, which runs after every commit and is a no-op whenever the ref is
  // null. The commit that mounts the "Ändern"/"Change" button is guaranteed
  // to already have happened by the time it runs non-null, because every
  // caller also fires a REAL state update in the same synchronous handler
  // (setEditingOrigin/setEditingDestination, or the parent's onPickOrigin/
  // onPickDestination prop callback) that React batches together with the
  // ref write's enclosing render — so first-ever pick (origin/destination
  // still null until the parent's callback runs) is covered too, not just
  // the re-pick flow.
  const pendingFocusRef = useRef<'origin' | 'destination' | null>(null);
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    // Identity-based, not style-based (PR #736 review Major): an earlier
    // version queried the rendered `.sc-btn-ghost` class, which only
    // uniquely identified the Change button because "Pick on map" happens to
    // be `variant="secondary"` today — nothing pins that, and a second ghost
    // button added to the section later would silently steal focus via
    // querySelector's first-match-in-document-order semantics. The two
    // Change buttons instead carry a `data-focus-target` unique per endpoint.
    document.querySelector<HTMLButtonElement>(`[data-focus-target="${target}-change"]`)?.focus();
  });

  // #829: keyboard-reachable via-point coordinate entry (spike §3.1/§5.1).
  // ONE coordinate-entry row serves both "Add a new via point" and "Update
  // an already-placed one" — the spike's own framing ("the same component,
  // not a second one") — switching mode via viaCoordMode rather than
  // rendering a duplicate lat/lon pair per row (which would grow every
  // .planner-via-row by a 4th 44px control at exactly the narrow widths
  // #708's own comment already flags as tight with three).
  const [viaCoordMode, setViaCoordMode] = useState<
    { kind: 'add' } | { kind: 'update'; index: number }
  >({ kind: 'add' });
  const [viaCoordLat, setViaCoordLat] = useState(VIA_COORD_DEFAULT.lat);
  const [viaCoordLon, setViaCoordLon] = useState(VIA_COORD_DEFAULT.lon);
  const [viaCoordError, setViaCoordError] = useState(false);

  // #863 review MAJOR: viaCoordMode.index was captured once on entering
  // update mode and never re-validated against viaPoints — nothing disables
  // a DIFFERENT row's remove/reorder buttons while this form is open, so a
  // keyboard user could open update mode on point B, remove or reorder point
  // A via ITS OWN button, then commit — silently overwriting whatever now
  // sits at the stale index (or, once the array is shorter than the index,
  // silently dropping the edit). Fixed the same way NumberInput's own
  // prevValue/draft resync above (this file) derives state from a changed
  // prop during render: viaPoints is a NEW array reference on every add/
  // remove/reorder/update (App.tsx's handleViaPointsChange always replaces
  // it, never mutates in place), so a reference change is exactly the
  // signal that the index this form is holding may no longer mean what it
  // meant when the form was opened. A successful commit already resets to
  // 'add' itself (below) in the SAME synchronous handler that changes the
  // prop, so by the time this component re-renders with the new prop,
  // viaCoordMode is already 'add' and this is a no-op then — it only fires
  // for a change that happened WITHOUT going through this form's own commit.
  const [prevViaPoints, setPrevViaPoints] = useState(viaPoints);
  if (viaPoints !== prevViaPoints) {
    setPrevViaPoints(viaPoints);
    if (viaCoordMode.kind === 'update') {
      setViaCoordMode({ kind: 'add' });
      setViaCoordLat(VIA_COORD_DEFAULT.lat);
      setViaCoordLon(VIA_COORD_DEFAULT.lon);
      setViaCoordError(false);
    }
  }

  // Same ref-write-then-no-deps-effect shape as pendingFocusRef above (#695:
  // drive focus from the callback that knows the user acted, never a derived
  // boolean/prop diff) — here there's only one target element with a stable
  // id, so no data-focus-target indirection is needed.
  const pendingViaCoordFocusRef = useRef(false);
  useEffect(() => {
    if (!pendingViaCoordFocusRef.current) return;
    pendingViaCoordFocusRef.current = false;
    document.getElementById('planner-via-coord-lat')?.focus();
  });

  // Pressing an already-placed via point's own coordinate button (below)
  // toggles: a second press on the SAME index leaves update mode and returns
  // to "Add"; a press on a DIFFERENT index re-seeds the fields for that one.
  function handleEditViaCoord(index: number): void {
    setViaCoordMode((current) => {
      if (current.kind === 'update' && current.index === index) {
        setViaCoordLat(VIA_COORD_DEFAULT.lat);
        setViaCoordLon(VIA_COORD_DEFAULT.lon);
        setViaCoordError(false);
        return { kind: 'add' };
      }
      const v = viaPoints[index];
      setViaCoordLat(v.lat);
      setViaCoordLon(v.lon);
      setViaCoordError(false);
      pendingViaCoordFocusRef.current = true;
      return { kind: 'update', index };
    });
  }

  function handleCommitViaCoord(): void {
    const p: LatLon = { lat: viaCoordLat, lon: viaCoordLon };
    if (!isInViaDataArea(p)) {
      setViaCoordError(true);
      return;
    }
    setViaCoordError(false);
    if (viaCoordMode.kind === 'update') {
      onUpdateVia(viaCoordMode.index, p);
    } else {
      onAddVia(p);
    }
    setViaCoordMode({ kind: 'add' });
    setViaCoordLat(VIA_COORD_DEFAULT.lat);
    setViaCoordLon(VIA_COORD_DEFAULT.lon);
  }

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
  // #540: plan-level, like `shallow` immediately above — feeds
  // renderRigVerdict() for the rig-comparison chip below. Defaults to `true`
  // (never trips the budget-specific copy) when `plan` is absent; the chip
  // that reads it is gated on `summary`, which is itself null whenever
  // `plan` is, so the default is never actually rendered.
  const comparisonComplete = plan?.result.comparisonComplete ?? true;
  // #578: `route.rigTie`'s two sail ids, in solve order — computed here,
  // where `plan` is still a bare `Plan | null` prop, so the chip render site
  // below never needs its own `plan` null-narrowing (mirrors the
  // `comparisonComplete` default immediately above: unused whenever `plan`
  // is absent, since the chip is gated on `summary`).
  const comparedSailIds: readonly SailId[] = plan ? plan.result.sails.map((s) => s.sailId) : [];

  // Cross-PR composition fix (Refs #299, found by an adversarial cumulative-
  // diff sweep over PR #486): computed independently of App.tsx's own
  // `settingsDirty` — same predicate (`routingSettingsDirty`), same two
  // inputs (`plan`, `settings`), both already props here — so this panel can
  // tell which PART of a dirty form the App-level Banner already covers.
  // `formDirty` folds origin/destination/departure/settings together;
  // `settingsDirty` is the settings-only subset the Banner announces. See the
  // `staleSuffix` comment below for why the difference between the two is
  // exactly what this live region needs.
  const settingsDirty = plan ? routingSettingsDirty(plan, settings) : false;

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
        distance: formatNm(announcedResult.distanceNm, lang),
      })
    : '';

  // Single derived text for the ONE persistent live region: in-flight phase
  // messages while planning, then the completion summary once idle. Never a
  // second aria-live region.
  let statusText = '';
  if (planning.phase === 'fetching') statusText = t('planner.status.fetching');
  else if (planning.phase === 'routing')
    // #340/#54: phase readout ("sail N of 2") — index/total now come straight
    // off the PlannerStatus itself (usePlanFlow.ts derives them from
    // request.sailIds, the router's actual solve order), not a module
    // constant, so the index always matches which solve is really running.
    statusText = t('planner.status.routingSail', {
      index: planning.index,
      total: planning.total,
      sail: t(sailLabelKey(planning.sailId)),
    });
  else if (planning.phase === 'probing') statusText = t('planner.status.probing');
  else if (planning.phase === 'idle') {
    // #301 originally folded the dirty-form sentence in here unconditionally
    // on `formDirty`. PR #486 review (Minor 5) removed the fold entirely,
    // reasoning that App.tsx's new tab-independent `settingsDirty` Banner
    // (role="alert", #299) "already announces this exact sentence whenever
    // it's true" — TRUE only for the settings-only subset of dirtiness the
    // Banner can see. It is FALSE for `formDirty && !settingsDirty`: a user
    // who changes only the destination, origin, or departure (all reachable
    // from THIS tab, none reachable from Routes/Live/Boat, and none part of
    // `settingsDirty`) leaves the panel's live region silent with no
    // announcement anywhere — the #486 fix over-removed and re-opened the
    // exact gap #301 existed to close (found by a cross-PR composition
    // sweep over the cumulative diff, Refs #299).
    //
    // Fixed by folding on the COMPLEMENT of what the Banner covers, so every
    // true case is announced exactly once: `settingsDirty` true → the Banner
    // is the sole announcer (this region stays silent, avoiding the
    // original double-announcement #486 was right to kill); `formDirty &&
    // !settingsDirty` → the Banner cannot see it, so this region announces
    // it. The Ergebnis card's Chip below stays on the broader `formDirty`
    // unconditionally — it's a static DOM insertion outside a live region,
    // never itself announced, so showing it regardless of `settingsDirty`
    // does not reintroduce any duplicate announcement.
    const staleSuffix = formDirty && !settingsDirty && summary ? t('planner.result.stale') : '';
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
              {/* #715: was a hardcoded '#009e73' — the map's Okabe-Ito
                  starboard-tack/AIS-vessel green, reused here for no
                  documented reason (no map marker echoes this pin's colour;
                  searched, found none). It also silently diverged from its
                  sibling below in TWO ways: a raw literal vs. a design
                  token, and (since --sc-accent is theme-aware) an
                  appearance that never changed with the theme vs. one that
                  does. Resolved toward the destination pin's existing
                  var(--sc-accent) rather than the reverse: these are
                  decorative panel swatches, not map chrome, so the UI
                  accent token — not a semantic map colour with an
                  established meaning elsewhere (starboard tack, AIS) — is
                  the correct source, and matching the sibling makes both
                  pins consistent on BOTH axes at once. */}
              <span
                className="endpoint-pin"
                style={{ background: 'var(--sc-accent)' }}
                aria-hidden="true"
              />
              <div className="endpoint-detail">
                <p className="endpoint-name">{origin.label}</p>
                {/* #834: HarborPicker's own option row discloses this via
                    the identical key/class BEFORE a harbor is picked (#652);
                    this used to vanish the instant the pick landed here,
                    right before the moment it mattered most. Reuses the
                    picker's exact string and styling — never re-authored —
                    so the two surfaces cannot drift onto different wording. */}
                {originHarbor?.knownDisconnected === true && (
                  <p className="harbor-picker-unreachable">{t('harborPicker.knownDisconnected')}</p>
                )}
                {originHarbor?.approachNote && (
                  <p className="endpoint-caveat">{originHarbor.approachNote[lang]}</p>
                )}
              </div>
              <Button
                data-focus-target="origin-change"
                variant="ghost"
                onClick={() => setEditingOrigin(true)}
              >
                {t('planner.change')}
              </Button>
            </div>
          ) : (
            <HarborPicker
              harbors={harbors}
              recentIds={recent}
              // #737: true only when this mount was caused by the Change
              // button above (see HarborPicker's own `autoFocus` doc comment
              // for why `editingOrigin` itself, not a derived expression, is
              // the right signal here).
              autoFocus={editingOrigin}
              onSelect={(h) => {
                remember(h.id);
                setEditingOrigin(false);
                pendingFocusRef.current = 'origin';
                onPickOrigin(harborToPickedPoint(h, lang));
              }}
              // Abandoning a re-pick over a committed origin collapses back to
              // the row (no-op on a first, still-unselected pick — origin stays
              // null, so the combobox keeps showing).
              onCancel={() => {
                setEditingOrigin(false);
                pendingFocusRef.current = 'origin';
              }}
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
                {/* #834: see the matching comment on the origin row above. */}
                {destinationHarbor?.knownDisconnected === true && (
                  <p className="harbor-picker-unreachable">{t('harborPicker.knownDisconnected')}</p>
                )}
                {destinationHarbor?.approachNote && (
                  <p className="endpoint-caveat">{destinationHarbor.approachNote[lang]}</p>
                )}
              </div>
              <Button
                data-focus-target="destination-change"
                variant="ghost"
                onClick={() => setEditingDestination(true)}
              >
                {t('planner.change')}
              </Button>
            </div>
          ) : (
            <HarborPicker
              harbors={harbors}
              recentIds={recent}
              // #737: see the matching comment on the origin HarborPicker above.
              autoFocus={editingDestination}
              onSelect={(h) => {
                remember(h.id);
                setEditingDestination(false);
                pendingFocusRef.current = 'destination';
                onPickDestination(harborToPickedPoint(h, lang));
              }}
              onCancel={() => {
                setEditingDestination(false);
                pendingFocusRef.current = 'destination';
              }}
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

        {/* #571 redesign: no via control here is disabled while a plan is
            running (`runBusy`) any more — a via edit only ever writes to the
            draft, synchronously, with nothing that could race an in-flight
            solve, matching how origin/destination editing is already
            unblocked during one. */}
        <section aria-label={t('planner.via.label')} className="planner-via planner-endpoint">
          <h3 className="sc-section-title">{t('planner.via.label')}</h3>
          {viaPoints.length > 0 && (
            <ol className="planner-via-list">
              {viaPoints.map((v, i) => (
                <li key={i} className="planner-via-row">
                  {/* #829: was a plain <span> — now a toggle button into the
                      coordinate-entry row below, so repositioning (spike §2
                      row 2) reuses the SAME lat/lon fields rather than adding
                      a duplicate pair per row. aria-label folds the visible
                      coordinate text into the accessible name (WCAG 2.5.3)
                      rather than replacing it. */}
                  <Button
                    variant="ghost"
                    className="planner-via-coord"
                    aria-pressed={viaCoordMode.kind === 'update' && viaCoordMode.index === i}
                    aria-label={t('planner.via.coord.edit', {
                      index: i + 1,
                      coord: formatLatLon(v),
                    })}
                    onClick={() => handleEditViaCoord(i)}
                  >
                    {formatLatLon(v)}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={i === 0}
                    onClick={() => onReorderVia(i, 'up')}
                    aria-label={t('planner.via.moveUp', { index: i + 1 })}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={i === viaPoints.length - 1}
                    onClick={() => onReorderVia(i, 'down')}
                    aria-label={t('planner.via.moveDown', { index: i + 1 })}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => onRemoveVia(i)}
                    aria-label={t('planner.via.remove', { index: i + 1 })}
                  >
                    ×
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <Button variant="ghost" onClick={() => onRequestMapTap('via')}>
            {t('planner.via.add')}
          </Button>

          {/* #829: keyboard-reachable equivalent of the map-tap 'via' path
              (docs/spikes/714-keyboard-map-equivalents.md §3.1/§5.1) — a
              second PRODUCER of the same LatLon the map tap already
              produces, validated against gpx.ts's existing DATA_AREA
              half-open check rather than a second hand-copied bound. In
              "update" mode (entered via a via point's own coordinate button
              above) the SAME fields reposition that point instead of
              appending a new one. */}
          <div className="planner-via-coord-entry">
            <Field label={t('planner.via.coord.latLabel')} htmlFor="planner-via-coord-lat">
              <NumberInput
                id="planner-via-coord-lat"
                value={viaCoordLat}
                min={-90}
                max={90}
                step={0.001}
                onCommit={(n) => setViaCoordLat(n)}
              />
            </Field>
            <Field label={t('planner.via.coord.lonLabel')} htmlFor="planner-via-coord-lon">
              <NumberInput
                id="planner-via-coord-lon"
                value={viaCoordLon}
                min={-180}
                max={180}
                step={0.001}
                onCommit={(n) => setViaCoordLon(n)}
              />
            </Field>
            <Button variant="secondary" onClick={handleCommitViaCoord}>
              {viaCoordMode.kind === 'update'
                ? t('planner.via.coord.update')
                : t('planner.via.coord.add')}
            </Button>
            {/* Always mounted, empty until a rejection — same shape as the
                safety-depth clamp notice above (#731 review round 2's
                always-mounted-live-region rule). */}
            <p className="boat-picker-notice" role="status">
              {viaCoordError ? t('planner.via.coord.outOfRegion') : null}
            </p>
          </div>
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
              // #643: stepping a datetime-local segment (e.g. the month) to a
              // date that doesn't exist (31 Feb) makes the browser set
              // value === '' at the moment the engine parses the composite
              // date. #643's OWN report (reproduced 2026-08-24, Chromium
              // 151.0.7922.34, real keyboard, month-spanning min/max bounds)
              // confirms that blanking DOES occur. What #643 additionally
              // claimed — that the empty value then stays "swallowed",
              // leaving the field visibly empty — was measured NOT to
              // happen: react-dom 19.2.8's own controlled-input restore
              // (`restoreStateOfTarget`) rewrites the DOM node back to the
              // last-rendered `value` prop synchronously, before paint,
              // REGARDLESS of whether this handler does anything at all —
              // confirmed with this exact line deleted, against two real
              // `vite build` outputs, in both Chromium 151.0.7922.34 and
              // WebKit 26.5 (full record in PR #665). So this write is a
              // measured NO-OP in every engine tested, kept only as
              // explicit, self-documenting defensive code (belt-and-braces
              // against an engine/React combination not covered by that
              // measurement) — it does not close #643, and must not be
              // described as fixing it. Do NOT call onDepartureChange here:
              // that would fire a needless state update for a value that
              // never actually changed.
              if (!e.target.value) {
                e.target.value = toLocalInputValue(departureMs);
                return;
              }
              onDepartureChange(new Date(e.target.value).getTime());
            }}
          />
        </Field>
        <Field
          className="planner-safety-depth"
          label={t(safetyDepthField.labelKey)}
          htmlFor="planner-safety-depth"
          help={t('options.safetyDepth.help', {
            min: formatDepthM(safetyDepthField.min, lang),
            max: formatDepthM(safetyDepthField.max, lang),
          })}
          helpId="planner-safety-depth-help"
        >
          <NumberInput
            id="planner-safety-depth"
            value={settings.safetyDepthM}
            min={safetyDepthField.min}
            max={safetyDepthField.max}
            step={safetyDepthField.step}
            aria-describedby="planner-safety-depth-help"
            onCommit={(n, wasClamped) => {
              reportSafetyDepthCommit(n, wasClamped);
              commitSetting(settings, 'safetyDepthM', n, onSettingsChange);
            }}
          />
          {/* #731 review round 2: ALWAYS mounted, empty until a correction
              occurs — see SettingsPanel.tsx's NumericField (identical
              pattern) and useClampCorrection's own doc comment for the full
              record of why this replaced the conditionally-mounted shape. */}
          <p className="boat-picker-notice" role="status">
            {safetyDepthCorrectedTo !== null
              ? t('numberInput.corrected', {
                  value: formatBound(safetyDepthCorrectedTo, lang),
                  min: formatBound(safetyDepthField.min, lang),
                  max: formatBound(safetyDepthField.max, lang),
                })
              : null}
          </p>
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
          it — onboarding while the trip is still empty and online
          (showOnboarding), otherwise planDisabledReason's two possible
          values (offline, or a still-missing endpoint) — see both props' own
          comments above for the exact enumeration. The two never render
          together, so the empty state reads as one hint.
          #571 redesign: a dirty/stale form — including an unapplied via
          edit — is NOT shown in this slot; it never disables the button.
          That disclosure lives in the Ergebnis card's Chip and this panel's
          live region below (both driven by `formDirty`), and on the map in
          ViaMarkers' own chip (App.tsx's `viaDraftStale`). */}
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
                  ? t('route.fasterRig', { rig: t(sailLabelKey(summary.rigRecommendation.rig)) })
                  : renderRigVerdict(
                      summary.rigRecommendation.kind,
                      comparisonComplete,
                      comparedSailIds,
                      t,
                    )}
              </Chip>
              {/* #301: the form has drifted from this displayed route — a
                  re-run right now would produce something different. Sits ON
                  the stale thing (this card / the map route below it), not
                  map dimming/dashing (#324's dash+opacity already means "the
                  other rig"). #299 ALSO added a tab-independent Banner for
                  this same underlying signal (App.tsx, gated on the
                  narrower `settingsDirty`). This Chip stays unconditionally
                  on the broader `formDirty` regardless of whether the Banner
                  is also on screen — a Chip is a plain DOM insertion, not
                  itself a live region, so screen readers don't announce it
                  on their own and it never duplicates anything the Banner or
                  the live region below announce. The live region ABOVE
                  (statusText) DOES now fold this same sentence in — but only
                  for `formDirty && !settingsDirty`, the complement of what
                  the Banner covers (Refs #299; see statusText's own comment
                  for the full reasoning and why an earlier revision of this
                  comment claiming the opposite was wrong). Deliberately
                  still `formDirty`, not `settingsDirty`, here — this tab CAN
                  edit origin/destination/departure, unlike the Banner's
                  narrower scope (see settingsDirty's own comment in
                  App.tsx). */}
              {formDirty && <Chip>{t('planner.result.stale')}</Chip>}
            </div>
          )}
          {/* #452: shallow-water warning, promoted here from the Routes-tab-only
              RouteSummary card so it's visible on the FIRST surface a user sees
              a result on, without switching tabs. Plan-level (see `shallow`
              above), same shared component and copy as RouteSummary's own —
              and, unlike the sections below, NOT gated on `summary`. #452 gap
              3: `legs` is the ACTIVE rig's own legs (`result` above) — null
              whenever that rig has no result of its own, in which case the
              shared component's locator sentence safely stays absent while
              the banner itself still renders. The explicit `plan &&` alongside
              `shallow &&` is a TYPE-LEVEL requirement only: `shallow` is
              derived as `plan?.result.shallow ?? null`, so `shallow` truthy
              already implies `plan` non-null at runtime — TS just can't see
              that implication across the two separately-computed variables. */}
          {/* #747/Blocker 1, narrowed further in PR #763 review round 3 —
              see RouteSummary.tsx's own call site for the full mechanism and
              why `plan.id` alone is not enough: the #114 recalculate-and-
              replace flow keeps `id` fixed while re-planning against a fresh
              forecast, so severity can flip with no remount under a
              `plan.id`-only key. `${plan.id}-${plan.createdAtMs}` changes on
              every genuine re-plan, replace included. */}
          {plan && shallow && (
            <ShallowWarning
              key={`${plan.id}-${plan.createdAtMs}`}
              shallow={shallow}
              legs={result?.legs ?? null}
              plan={plan}
            />
          )}
          {/* #612: the complement of the banner above, for a route that did NOT
              relax — same shared component and copy as RouteSummary's own, so
              the quiet marginal-depth line can never drift between the first
              surface a user sees a result on and the Routes tab. The
              not-relaxed / mask-loaded / non-zero-exposure gate lives inside
              the component itself; the `plan &&` here is the same TYPE-LEVEL
              requirement as the banner's above. */}
          {plan && <MarginalDepthNotice plan={plan} legs={result?.legs ?? null} />}
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
