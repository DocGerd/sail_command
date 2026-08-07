import type { Lang } from '../i18n';
import { formatLatLon } from './format';
import { nextFullHourMs } from '../components/PlannerPanel';
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
 * True when the form (current origin/destination/departure/settings) has
 * drifted from the plan actually displayed — i.e. a re-run right now would
 * produce a DIFFERENT route than the one on screen. Vias are deliberately
 * NOT compared: once a plan exists, the via list IS plan.request.viaPoints
 * (App.tsx), and every via edit immediately replans in place — they cannot
 * structurally diverge.
 *
 * Coordinates compare with exact `===` on lat/lon, not an epsilon: the sync
 * effect writes the plan's own numbers back verbatim, and re-picking the
 * same harbor yields the byte-identical harbor.snap, so exact equality is
 * already correct — an epsilon would invent a "close enough" notion the
 * router has no concept of.
 */
export function planFormDirty(plan: Plan, form: PlanFormSnapshot): boolean {
  const req = plan.request;

  if (form.departureMs !== req.departureMs) return true;

  if (form.origin.point.lat !== req.origin.lat || form.origin.point.lon !== req.origin.lon) {
    return true;
  }
  const formOriginHarborId = form.origin.source === 'harbor' ? form.origin.harborId : null;
  if (formOriginHarborId !== req.originHarborId) return true;

  if (
    form.destination.point.lat !== req.destination.lat ||
    form.destination.point.lon !== req.destination.lon
  ) {
    return true;
  }
  const formDestinationHarborId =
    form.destination.source === 'harbor' ? form.destination.harborId : null;
  if (formDestinationHarborId !== req.destinationHarborId) return true;

  // Backfilled from DEFAULT_SETTINGS before comparing — mirrors lib/
  // recalc.ts's identical backfill. A plan saved before a Settings field
  // existed (e.g. depthComfortMarginM, added #243) simply lacks that key in
  // its stored snapshot; without this, every such plan would read
  // permanently dirty on a field the user never touched, since live
  // settings (always backfilled at load — see state/AppState.tsx) would
  // carry a real number against the plan's `undefined`.
  const planSettings: Settings = { ...DEFAULT_SETTINGS, ...req.settings };
  for (const key of ROUTING_RELEVANT_SETTINGS_KEYS) {
    if (form.settings[key] !== planSettings[key]) return true;
  }

  return false;
}
