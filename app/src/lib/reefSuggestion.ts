// #325: per-leg mainsail reef suggestion — PRESENTATION-ONLY, option (b) from
// the issue's own two-option analysis. Today's polar tables are TWA x TWS ->
// boat speed for exactly two configurations (main+genoa, main+fock) with no
// reefed variant, so a reef suggestion cannot be *derived* from the data the
// router already optimises against (option (a): adding a reef axis to the
// polars and letting the solver choose) without touching the polar format,
// the solver's candidate generation and `Leg` itself — a materially larger
// change the issue explicitly separates out as a future, independently-
// decided step. This module instead computes an ADVISORY suggestion at
// RENDER time from fields `Leg` already carries (`twsKn`, `twaDeg`,
// `speedKn`), so it changes NOTHING about the route the solver picked: the
// boat speed baked into every leg still assumes full main, exactly as before
// this feature existed. `PlanResult`/`Leg` are UNTOUCHED — no field added, no
// shape changed — so the plan stays structured-clone-safe and byte-identical
// for `app/sweep/`'s (#282) acceptance harness; no sweep is owed by this file.
//
// APPARENT, NOT TRUE, WIND. The issue calls this out explicitly: a sail is
// loaded by the wind it feels, not the wind the router optimises against, and
// a heuristic keyed on TWS alone would under-recommend downwind (where AWS is
// LOWER than TWS) and over-recommend upwind (where AWS is HIGHER). This
// module converts every leg's TWS + TWA + achieved boat speed to apparent
// wind speed via the standard sailing-triangle law of cosines before banding.
//
// WIND SAMPLING. This app deliberately runs two different wind-sampling
// clocks (map barbs sample the plan's grid at the slider hour; the depth
// profile samples each instant's own hour) and the issue asks a per-leg
// figure to follow the profile's convention, each leg against its own hour.
// It does, for free: `leg.twsKn` is already the TWS the ROUTER sampled at
// THIS leg's own start time when it computed the leg — this module adds no
// new wind sampling of its own, so there is no clock to get wrong.
//
// BOAT-SPECIFIC CONFIDENCE. Only the Salona 45 is `hullVerified`, with
// certificate-anchored polars; the other two catalogue boats are tier-C
// polar estimates. The THRESHOLDS themselves are NOT derived from any boat's
// polar at all — they are generic seamanship guidance for a monohull in this
// fleet's size class (all three boats are 44-45 ft cruising yachts), which is
// why the same threshold set and the same caveat apply identically to all
// three boats, unlike the two-rig ★ comparison (which IS suppressed for
// tier-C boats because it depends on the polar itself, #54). But the AWS
// ESTIMATE fed into those thresholds is NOT polar-independent: it consumes
// `leg.speedKn`, which the router derived from the boat's own polar. A 1 kn
// polar error moves AWS by up to ~0.86 kn upwind (measured across TWA at
// TWS 15: +0.86/+0.48/-0.14 depending on point of sail) — up to ~14% of a
// 6 kn band, enough to flip a boundary case at the worst-case TWA. So confidence in the
// SUGGESTED BAND does inherit the boat's polar tier, even though the
// THRESHOLDS that band it do not; do not conflate the two when reasoning
// about accuracy.
//
// THRESHOLDS. `REEF1_AWS_KN`/`REEF2_AWS_KN`/`REEF3_AWS_KN` are a deliberately
// conservative, generic rule of thumb for a cruising monohull of this size —
// NOT a certified figure for any specific hull, and NOT tied to any specific
// external publication (this repo will not fabricate a citation it cannot
// verify — see CLAUDE.md's fabricated-citation lesson). They are named
// constants precisely so a maintainer with better, hull-specific guidance can
// replace them in one place; the values and the advisory-only status are also
// surfaced in the UI itself (RouteSummary's `route.legs.reefNote`), not only
// here, per the issue's "documented where a user can find them" requirement.
//
// GUSTS. This module computes AWS from the forecast's MEAN wind speed
// (`leg.twsKn`) only — `WindGrid.gustKn` exists but nothing here reads it.
// Real seamanship reefs for the gust, not the mean, and a gust factor can
// flip a full band (e.g. TWS 11/TWA 60/BS 6: mean AWS ~14.9 kn = 1st reef,
// but a 1.35x gust factor puts AWS at ~18.6 kn = 2nd reef) — always toward
// UNDER-reefing, the dangerous direction. `route.legs.reefNote` (both dicts)
// states this explicitly; this is a disclosed limitation, not an oversight,
// and deliberately NOT implemented here (a materially larger change, akin to
// option (a) in the issue).
//
// MERGED LEGS. `routing/postprocess.ts`'s `tryMerge` collapses near-collinear
// legs, keeping the FIRST leg's `twaDeg`/`twsKn` while recomputing `headingDeg`
// (up to `MAX_MERGE_DEG`, cascading) and replacing `speedKn` with a made-good
// average. So on a merged leg the stored TWA no longer exactly matches the
// stored heading, and BS is not the polar speed at that TWA — the AWS
// computed here is correspondingly approximate (on the order of 1 kn for a
// 10° drift), the same order of magnitude as the polar-confidence caveat
// above. Pre-existing to this module (the legs table already displays the
// same approximate TWA), not a new hazard it introduces.
import type { Leg } from '../types';

export type ReefBand = 'full' | 'reef1' | 'reef2' | 'reef3';

export interface ReefSuggestion {
  readonly band: ReefBand;
  readonly awsKn: number;
}

/** Below this apparent wind speed: full main. */
export const REEF1_AWS_KN = 12;
/** At/above REEF1_AWS_KN, below this: first reef. */
export const REEF2_AWS_KN = 18;
/** At/above REEF2_AWS_KN, below this: second reef. At/above this: third reef. */
export const REEF3_AWS_KN = 24;

/**
 * Apparent wind speed from true wind speed, the (unsigned) true wind angle,
 * and boat speed through the water, via the sailing triangle:
 *   AWS = sqrt(TWS^2 + BS^2 + 2*TWS*BS*cos(TWA))
 * TWA is the angle between the true wind's source bearing and the boat's
 * heading (0 = head-to-wind, 180 = dead run) — symmetric in cos(), so sign
 * doesn't matter and callers may pass an unsigned TWA. At TWA=0 this reduces
 * to AWS = TWS + BS (beating adds boat speed to the wind felt); at TWA=180 it
 * reduces to AWS = |TWS - BS| (running away from the wind reduces it) —
 * both the textbook limiting cases.
 */
export function apparentWindKn(twsKn: number, twaDeg: number, boatSpeedKn: number): number {
  const twaRad = (twaDeg * Math.PI) / 180;
  const awsSq =
    twsKn * twsKn + boatSpeedKn * boatSpeedKn + 2 * twsKn * boatSpeedKn * Math.cos(twaRad);
  // Guard only against floating-point noise driving a near-zero square
  // negative; a genuinely negative awsSq is not mathematically reachable
  // for real inputs (the expression is the law-of-cosines third-side
  // formula, always >= 0 for real triangle sides).
  return Math.sqrt(Math.max(awsSq, 0));
}

/** Bands a computed apparent wind speed into a reef suggestion. */
export function reefBandForApparentWindKn(awsKn: number): ReefBand {
  if (awsKn < REEF1_AWS_KN) return 'full';
  if (awsKn < REEF2_AWS_KN) return 'reef1';
  if (awsKn < REEF3_AWS_KN) return 'reef2';
  return 'reef3';
}

// #946: BAND-CHANGE HYSTERESIS. The advisory band could flip leg to leg on a
// wind change too small to matter, because `reefBandForApparentWindKn` bands
// a single AWS value against a bare threshold with no memory of what was
// already shown — any crossing, however marginal, flips it. This is a
// PRESENTATION damping fix (Lever A of #946): it changes what is DISPLAYED,
// never what the router priced or picked (see this file's own top-of-file
// #325 argument for why that stays true — nothing here touches `Leg` or
// `PlanResult`). Lever B — pricing a reef change in the solver via a reef
// axis on the polars — is a materially larger, explicitly deferred change
// (issue comment, 2026-09-04) and is NOT this fix.
//
// MARGIN DERIVATION (CLAUDE.md: quote the method, not the result). This
// file's own BOAT-SPECIFIC CONFIDENCE comment above already measures a
// worst-case ~0.86 kn AWS swing from a 1 kn polar-speed error alone (TWA
// giving the worst case at TWS 15 upwind) — i.e. the AWS this module
// computes from `leg.speedKn` already carries about that much uncertainty
// from polar tier alone, before merged-leg TWA drift (~1 kn, see MERGED LEGS
// above) or ordinary forecast noise are even considered. A band flip smaller
// than the estimate's own already-documented error is display noise, not
// new information, so the hysteresis margin is set to that same figure
// (rounded up to one decimal). This is a JUDGEMENT CALL about which existing
// error bound to reuse, not a fresh measurement of its own — same status as
// `panelWidth.ts`'s `PANEL_MAP_RESERVE_PX` comment: it borrows a number this
// file already measured elsewhere rather than inventing one, but the choice
// to reuse exactly that bound (not e.g. double it) is judgement, stated so a
// maintainer can revise it deliberately rather than rediscover it.
// This 0.86 kn source figure is itself tier-C-worst-case (BOAT-SPECIFIC
// CONFIDENCE above), so applying it uniformly over-widens the dead zone for
// the hullVerified Salona 45 — conservative (less responsive display), never
// a wrong band, but not precise for that boat.
export const REEF_HYSTERESIS_MARGIN_KN = 0.9;

const REEF_BAND_ORDER: readonly ReefBand[] = ['full', 'reef1', 'reef2', 'reef3'];
const REEF_BAND_THRESHOLDS: readonly number[] = [REEF1_AWS_KN, REEF2_AWS_KN, REEF3_AWS_KN];

/**
 * Schmitt-trigger band selection: starts from the band already being shown
 * (`previousBand`) and only moves away from it once `awsKn` clears the
 * relevant threshold by `marginKn` in that direction — so a value sitting in
 * the `[threshold - margin, threshold + margin)` dead zone around any
 * boundary keeps showing whatever was already shown. A genuine, sustained
 * change (one that clears the widened threshold) still moves the band —
 * including past more than one boundary in a single step, e.g. a sudden
 * squall jumping straight from full main to 2nd reef — so this damps
 * marginal noise without ever refusing a real change (#946 DoD: "a fix that
 * just freezes the band is worse than the churn").
 */
function reefBandWithHysteresis(awsKn: number, previousBand: ReefBand, marginKn: number): ReefBand {
  let idx = REEF_BAND_ORDER.indexOf(previousBand);
  while (idx < REEF_BAND_THRESHOLDS.length && awsKn >= REEF_BAND_THRESHOLDS[idx]! + marginKn) {
    idx += 1;
  }
  while (idx > 0 && awsKn < REEF_BAND_THRESHOLDS[idx - 1]! - marginKn) {
    idx -= 1;
  }
  return REEF_BAND_ORDER[idx]!;
}

/**
 * The per-leg reef suggestion, or `null` on a motor leg. Motor legs carry
 * `board: null` and no `twaDeg` (`Leg` is a discriminated union on `kind` —
 * narrowed here, never cast) and a reef suggestion is meaningless under
 * engine alone, so this deliberately renders NO suggestion for them (the
 * issue's other licensed option, an explicit "n/a", is not used here because
 * the leg's own Kind chip already reads "Motor" — a second, redundant
 * annotation would not add information).
 *
 * `previousBand` is the band already being SHOWN for this route immediately
 * before this leg (`null` for the first sail leg of a route, or when no
 * hysteresis context is available). Omitting it — the original, one-argument
 * call this module has always supported — reproduces the pre-#946 straight
 * banding exactly, unchanged, so an existing call site compiles and behaves
 * identically without adopting hysteresis. `reefSuggestionsForLegs` below is
 * the production entry point that threads `previousBand` across a route.
 */
export function reefSuggestionForLeg(
  leg: Leg,
  previousBand: ReefBand | null = null,
): ReefSuggestion | null {
  if (leg.kind !== 'sail') return null;
  const awsKn = apparentWindKn(leg.twsKn, Math.abs(leg.twaDeg), leg.speedKn);
  const band =
    previousBand === null
      ? reefBandForApparentWindKn(awsKn)
      : reefBandWithHysteresis(awsKn, previousBand, REEF_HYSTERESIS_MARGIN_KN);
  return { band, awsKn };
}

/**
 * Hysteresis-adjusted reef suggestions for an ORDERED sequence of legs (a
 * whole route) — the production entry point for #946's damping fix. Folds
 * `reefSuggestionForLeg` over the legs in order, threading each sail leg's
 * DISPLAYED band into the next sail leg's hysteresis decision.
 *
 * Motor legs render `null` (unchanged from `reefSuggestionForLeg`) and
 * deliberately do NOT reset the carried band: the boat's sail configuration
 * doesn't change just because one leg happens to motor, so the next sail
 * leg's hysteresis still measures against whatever reef was last actually
 * shown, not against a blank slate.
 */
export function reefSuggestionsForLegs(legs: readonly Leg[]): ReadonlyArray<ReefSuggestion | null> {
  const out: Array<ReefSuggestion | null> = [];
  let previousBand: ReefBand | null = null;
  for (const leg of legs) {
    const suggestion = reefSuggestionForLeg(leg, previousBand);
    out.push(suggestion);
    if (suggestion !== null) previousBand = suggestion.band;
  }
  return out;
}
