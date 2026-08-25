import type { Lang } from '../i18n';
import { formatLatLon } from './format';
import { nextFullHourMs } from '../components/PlannerPanel';
import { planViaPoints } from './planViaPoints';
import {
  DEFAULT_SETTINGS,
  type Harbor,
  type LatLon,
  type PickedPoint,
  type Plan,
  type Settings,
} from '../types';

/**
 * #301 re-plan-from-Plan-view: prefills the planner FORM from a plan that
 * just became active (loaded from PlansList, restored on boot, or the result
 * of a completed run/via-replan/live-reroute — every setPlan caller, in one
 * place, per App.tsx's sync effect next to planIdRef). Deliberately NOT
 * folded into lib/recalc.ts: that module's docstring scopes it to #114's
 * PlansList seeding of a fresh PlanRequest for run(); this instead seeds the
 * Plan view's own input STATE (origin/destination/departureMs), which
 * recalcRequest never touches.
 */

function pickedPointOf(
  point: LatLon,
  harborId: string | null,
  harbors: Harbor[],
  lang: Lang,
): PickedPoint {
  // Mirrors PlannerPanel.tsx's harborToPickedPoint's *shape* but sources the
  // coordinate from the plan's own request, not from harbor.snap — the sync
  // writes the plan's own numbers back verbatim (see planFormDirty's exact-
  // equality comment below), and a harbor pick's point is byte-identical to
  // harbor.snap anyway (that's how it got into the request in the first
  // place), so this changes nothing for the common case while staying
  // correct if the curated harbor list ever moves independently of a plan.
  if (harborId !== null) {
    const harbor = harbors.find((h) => h.id === harborId);
    if (harbor) return { source: 'harbor', point, harborId: harbor.id, label: harbor.names[lang] };
  }
  // Falls back to a 'tap' point when the harbor id is absent from the
  // curated list (harbors not loaded yet, or the id was pruned since this
  // plan was created). Consequence: a subsequent re-plan then writes
  // originHarborId/destinationHarborId back as null — verified low-
  // consequence, those two fields are read only by state/reroute.ts (which
  // clears origin's anyway).
  return { source: 'tap', point, label: formatLatLon(point) };
}

/** Origin/destination as PickedPoints, ready to seed the form's state. */
export function pickedPointsOfPlan(
  plan: Plan,
  harbors: Harbor[],
  lang: Lang,
): { origin: PickedPoint; destination: PickedPoint } {
  return {
    origin: pickedPointOf(plan.request.origin, plan.request.originHarborId, harbors, lang),
    destination: pickedPointOf(
      plan.request.destination,
      plan.request.destinationHarborId,
      harbors,
      lang,
    ),
  };
}

/**
 * The departure to prefill the form with: the plan's own departure while it
 * is still in the future, else the planner's own default (next full hour) —
 * re-planning for a past departure would only yield 'beyond-horizon' against
 * a fresh grid. Extracted from PlansList.tsx's handleRecalcTap (:152), which
 * keeps its own inline copy of the identical rule (PlansList.tsx is
 * deliberately untouched by #301 — see the design doc) — this is the
 * canonical definition for any FUTURE caller to converge on, not a refactor
 * of that call site.
 */
export function departureSeedMs(plan: Plan, nowMs: number = Date.now()): number {
  return plan.request.departureMs > nowMs ? plan.request.departureMs : nextFullHourMs(nowMs);
}

/** The form snapshot planFormDirty compares against a plan's own request. */
export interface PlanFormSnapshot {
  origin: PickedPoint;
  destination: PickedPoint;
  departureMs: number;
  settings: Settings;
  // #571 redesign: the DRAFT via list (App.tsx's `draftViaPoints`) — a via
  // edit no longer replans in place (the maintainer's #571 ruling: removing
  // a waypoint "should only calculate once clicked on calculate"), so the
  // via list can now genuinely diverge from `plan.request.viaPoints` between
  // edits and the next Plan-route press, same as origin/destination/
  // departure/settings already could.
  viaPoints: LatLon[];
}

/**
 * True when two via-point lists differ in length or in any point's lat/lon —
 * ORDER-SENSITIVE (reordering IS a real edit), never an epsilon comparison
 * (same rationale as planFormDirty's coordinate checks below: the values
 * being compared are either byte-identical carries or genuinely new points,
 * never "close enough"). Shared by planFormDirty's own viaPoints term below
 * and by App.tsx's on-map staleness disclosure (ViaMarkers' repurposed
 * `replanning` prop, fed a boolean computed with this same function) — one
 * comparison, two presentation sites.
 */
export function viaPointsDiffer(a: LatLon[], b: LatLon[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((p, i) => p.lat !== b[i].lat || p.lon !== b[i].lon);
}

/**
 * True when a form's origin/destination has moved from a reference point —
 * exact `===` on lat/lon, no epsilon, mirroring planFormDirty's own
 * coordinate comparison above (same rationale: the values being compared are
 * either byte-identical carries or genuinely new points, never "close
 * enough"). `null` counts as different from any non-null point and the same
 * as another `null`.
 *
 * Used by App.tsx's #660 sync-effect guard: unlike planFormDirty (which
 * compares the CURRENT form against the ACTIVE plan's own request, to detect
 * an edit made AFTER a sync completed), this compares the CURRENT form
 * against a BASELINE captured the instant a new plan became pending — so it
 * can detect an edit made BEFORE the first sync for that plan ever runs (the
 * harborsLoaded-parked window #660 is about). The reference point differs by
 * caller; the equality semantics are the same function, not a second
 * definition of dirtiness.
 */
export function pickedPointMoved(
  current: PickedPoint | null,
  baseline: PickedPoint | null,
): boolean {
  if (current === null || baseline === null) return current !== baseline;
  return current.point.lat !== baseline.point.lat || current.point.lon !== baseline.point.lon;
}

// #301: the eight ROUTING-RELEVANT Settings fields — each has a real call
// site under app/src/routing/ (grep-verified: safetyDepthM x9 files,
// depthComfortMarginM incl. planRoute.ts, motorSpeedKn/motorThresholdKn/
// sailPreferenceKn/motorEnabled incl. isochrone.ts, maneuverPenaltyS
// isochrone.ts, performanceFactor planRoute.ts). showOwnship/aisApiKey/
// ownMmsi are DELIBERATELY excluded — zero references anywhere under
// app/src/routing/ — so pasting an AIS key or toggling the ownship marker
// never marks a displayed route stale.
export const ROUTING_RELEVANT_SETTINGS_KEYS = [
  'safetyDepthM',
  'depthComfortMarginM',
  'motorSpeedKn',
  'motorThresholdKn',
  'sailPreferenceKn',
  'maneuverPenaltyS',
  'performanceFactor',
  'motorEnabled',
] as const satisfies readonly (keyof Settings)[];

/**
 * True when the LIVE settings (App.tsx's `useSettings()`, editable from the
 * Boat tab or the Plan tab's compact safety-depth field) have drifted from
 * the settings the displayed plan actually ran with, on any of the eight
 * ROUTING_RELEVANT_SETTINGS_KEYS. Extracted from planFormDirty below (#299
 * PR #486 review) as its own export: App.tsx's cross-tab staleness BANNER
 * uses this NARROWER signal rather than the full planFormDirty, because
 * Routes/Live/Boat have no UI to edit origin/destination/departure at all —
 * a Setting is the only thing reachable from those tabs — and because
 * origin/departure drift can arise WITHOUT any user edit (state/reroute.ts's
 * rerouteFromFix sets `departureMs: nowMs` at reroute time, and by the time
 * the #301 sync effect's `departureSeedMs` reseeds the form a moment later
 * "now" has already advanced past it, so the reseeded value is structurally
 * never equal to the stored one — a correct-by-construction mismatch, not a
 * user change). Showing "your route is stale, replan" the instant a Live
 * reroute SUCCEEDS is a cry-wolf false positive on exactly the tab where
 * attention is scarcest; scoping the banner to settings avoids it, since
 * rerouteFromFix carries the ORIGINAL plan's settings forward unchanged.
 * PlannerPanel's own Chip keeps using the full planFormDirty unchanged —
 * origin/destination/departure edits ARE reachable there. Its live region
 * does NOT stay on the full planFormDirty (Refs #299, cross-PR composition
 * fix over PR #486 — see PlannerPanel.tsx's `statusText` comment for the
 * full story): it calls THIS function itself with its own `plan`/`settings`
 * props and folds the stale sentence only when `formDirty &&
 * !routingSettingsDirty(...)`, i.e. exactly the part of a dirty form the
 * App-level Banner above cannot see — announcing the settings-only case
 * would double it.
 *
 * Backfilled from DEFAULT_SETTINGS before comparing — mirrors lib/
 * recalc.ts's identical backfill. A plan saved before a Settings field
 * existed (e.g. depthComfortMarginM, added #243) simply lacks that key in
 * its stored snapshot; without this, every such plan would read
 * permanently dirty on a field the user never touched, since live settings
 * (always backfilled at load — see state/AppState.tsx) would carry a real
 * number against the plan's `undefined`.
 */
export function routingSettingsDirty(plan: Plan, formSettings: Settings): boolean {
  const planSettings: Settings = { ...DEFAULT_SETTINGS, ...plan.request.settings };
  return ROUTING_RELEVANT_SETTINGS_KEYS.some((key) => formSettings[key] !== planSettings[key]);
}

/**
 * True when the form (current origin/destination/departure/via list/
 * settings) has drifted from the plan actually displayed — i.e. a re-run
 * right now would produce a DIFFERENT route than the one on screen.
 *
 * #571 redesign: vias ARE now compared (`viaPointsDiffer`, above) — they no
 * longer immediately replan in place, so they can diverge exactly like
 * origin/destination/departure/settings already could. This is what makes
 * the existing stale-route disclosure (the Chip + live-region fold in
 * PlannerPanel.tsx, and the map-corner chip ViaMarkers.tsx renders) cover a
 * via edit for free, with no new UI surface: `formDirty` already drives all
 * of them.
 *
 * Coordinates compare with exact `===` on lat/lon, not an epsilon: the sync
 * effect writes the plan's own numbers back verbatim, and re-picking the
 * same harbor yields the byte-identical harbor.snap, so exact equality is
 * already correct — an epsilon would invent a "close enough" notion the
 * router has no concept of.
 *
 * `harborsAvailable` gates ONLY the two harborId-equality checks below, never
 * lat/lon/departure/settings (PR #443 review, Minor). When the curated
 * harbor list is empty — a permanent asset-load failure (App.tsx's `.catch`
 * still flips `harborsLoaded`) or a harbor since pruned from the list —
 * `pickedPointOf`'s tap-point fallback drops a REAL `originHarborId`/
 * `destinationHarborId` from the synced form even though nothing was
 * touched, so comparing it unconditionally would read a freshly, correctly
 * loaded plan as dirty. Safe to suppress: harborId doesn't influence what a
 * re-run produces (it's a display/bookkeeping field only, per
 * `pickedPointOf`'s own comment above), and the lat/lon check just above
 * already independently catches an actual endpoint change — HarborPicker
 * itself shows no results while harbors are unavailable, so the only way a
 * form's point can change then is a raw map tap, which the lat/lon check
 * alone already detects.
 */
export function planFormDirty(
  plan: Plan,
  form: PlanFormSnapshot,
  harborsAvailable: boolean,
): boolean {
  const req = plan.request;

  if (form.departureMs !== req.departureMs) return true;

  if (form.origin.point.lat !== req.origin.lat || form.origin.point.lon !== req.origin.lon) {
    return true;
  }
  const formOriginHarborId = form.origin.source === 'harbor' ? form.origin.harborId : null;
  if (harborsAvailable && formOriginHarborId !== req.originHarborId) return true;

  if (
    form.destination.point.lat !== req.destination.lat ||
    form.destination.point.lon !== req.destination.lon
  ) {
    return true;
  }
  const formDestinationHarborId =
    form.destination.source === 'harbor' ? form.destination.harborId : null;
  if (harborsAvailable && formDestinationHarborId !== req.destinationHarborId) return true;

  // #654: req.viaPoints read through the shared accessor — defends a
  // hand-edited/corrupted stored record; see planViaPoints.ts.
  if (viaPointsDiffer(form.viaPoints, planViaPoints(req))) return true;

  return routingSettingsDirty(plan, form.settings);
}
