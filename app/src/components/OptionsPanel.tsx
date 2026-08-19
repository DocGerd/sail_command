import type { Settings } from '../types';
import type { MsgKey } from '../i18n/dict.de';
import { minSafetyDepthM, type DraftedBoat } from '../lib/boatDepth';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';

// #299: this file no longer renders anything — its default-exported
// component (and OptionsPanel.test.tsx, which exercised it directly) were
// DELETED in the #299 fix wave (PR #486 review, Minor 4) once the Boat tab's
// SettingsPanel.tsx took over as the only place these fields are actually
// rendered in the live app. What remains here is the shared SOURCE OF TRUTH
// both SettingsPanel.tsx and PlannerPanel.tsx (for the still-inline safety
// depth field) import from: the field specs (bounds + i18n label keys) and
// the commit helper. Every one of SettingsPanel.test.tsx's behavioural
// assertions that only this file's now-deleted component used to cover
// (the no-op blur skip, the ownship aria-describedby, the AIS privacy help
// text, the empty-MMSI case) was ported into SettingsPanel.test.tsx BEFORE
// the deletion — see that file's own "Ported from OptionsPanel.test.tsx"
// comments.

export type NumericKey =
  | 'safetyDepthM'
  | 'depthComfortMarginM'
  | 'motorSpeedKn'
  | 'motorThresholdKn'
  | 'sailPreferenceKn'
  | 'maneuverPenaltyS'
  | 'performanceFactor';

export interface FieldSpec {
  key: NumericKey;
  labelKey: MsgKey;
  min: number;
  max: number;
  step: number;
}

// Safety depth is pulled OUT of the advanced group (#64 §3.3): it is one of the
// two most-changed inputs, so it stays visible in PlannerPanel's compact row.
// The spec (bounds included) lives here so both surfaces share one source.
// 2.2 m is a safety decision, not a UI nicety: it must never allow a value
// below the 2.1 m draft plus a minimum safety margin.
// #539 item 2: this is the DEFAULT boat's spec, and only the default boat's.
// `min` is the one boat-dependent field in it — spec J OQ-1 makes the UI
// minimum `draftM + 0.1` per boat — so ANY SURFACE THAT RENDERS AN INPUT MUST
// GO THROUGH `safetyDepthFieldFor(selectedBoat)` BELOW, never through this
// constant. It stays exported because `max`, `step` and `labelKey` are
// boat-independent, and because RouteSummary and the drift guard in
// test/maskTolerance.test.ts legitimately reason about the default boat.
//
// Why this path needs fixing rather than being left to the shallow banner:
// it is QUIETER than the #53 relaxation path. A gate the user typed under
// their own keel produces no `shallow` block at all, so nothing discloses a
// wrong minimum — where a relaxed gate at least banners itself.
export const SAFETY_DEPTH_FIELD: FieldSpec = {
  key: 'safetyDepthM',
  labelKey: 'options.safetyDepth.label',
  // #54: derived per-boat minimum (spec J OQ-1) rather than a hand-written
  // literal — evaluates to 2.2 for the release-1 default boat.
  min: minSafetyDepthM(boatById(DEFAULT_BOAT_ID)),
  max: 10,
  step: 0.1,
};

/**
 * #539 item 2 / spec J OQ-1. The safety-depth input's bounds for the boat the
 * user has actually selected.
 *
 * Spread-then-override rather than a second literal, so `max`, `step` and
 * `labelKey` cannot drift apart from `SAFETY_DEPTH_FIELD`'s — the two would
 * otherwise be a pair of hand-written tables with no derivation between them,
 * the shape this repo has been bitten by before.
 *
 * Takes {@link DraftedBoat} rather than `BoatDef` (#539) so the shallow
 * warning can ask this question of a SAVED PLAN's `BoatSnapshot`, which is not
 * structurally a catalogue entry. Type-only; see `boatDepth.ts` for why the
 * widening stops at the two depth helpers.
 */
export function safetyDepthFieldFor(b: DraftedBoat): FieldSpec {
  return { ...SAFETY_DEPTH_FIELD, min: minSafetyDepthM(b) };
}

// #243: depth comfort preference margin, rendered on the Boat tab
// (SettingsPanel.tsx) with its own help paragraph, unlike the four plain
// specs below — kept separate from SAFETY_DEPTH_FIELD's compact-row
// treatment because the spec lists it alongside the other advanced
// settings, not as a second most-changed input. 0 = feature off
// (byte-identical solve).
export const DEPTH_COMFORT_MARGIN_FIELD: FieldSpec = {
  key: 'depthComfortMarginM',
  labelKey: 'options.depthComfortMargin.label',
  min: 0,
  max: 5,
  step: 0.1,
};

// #254: sailing preference margin. Rendered with its own help paragraph like
// DEPTH_COMFORT_MARGIN_FIELD above, because the behaviour it controls is not
// guessable from the label. max 10 so the disabling value stays reachable at
// any motorSpeedKn (which itself maxes at 10).
export const SAIL_PREFERENCE_FIELD: FieldSpec = {
  key: 'sailPreferenceKn',
  labelKey: 'options.sailPreference.label',
  min: 0,
  max: 10,
  step: 0.1,
};

// The four plain numeric specs SettingsPanel.tsx splits across its
// "Boat & safety" (MANEUVER_PENALTY_FIELD, PERFORMANCE_FACTOR_FIELD) and
// "Propulsion" (MOTOR_SPEED_FIELD, MOTOR_THRESHOLD_FIELD) groups — exported
// individually, rather than as one bundled array, precisely because that
// split means no single place ever `.map()`s over all four together.
export const MOTOR_SPEED_FIELD: FieldSpec = {
  key: 'motorSpeedKn',
  labelKey: 'options.motorSpeed.label',
  min: 1,
  max: 10,
  step: 0.1,
};
export const MOTOR_THRESHOLD_FIELD: FieldSpec = {
  key: 'motorThresholdKn',
  labelKey: 'options.motorThreshold.label',
  min: 0,
  max: 5,
  step: 0.1,
};
export const MANEUVER_PENALTY_FIELD: FieldSpec = {
  key: 'maneuverPenaltyS',
  labelKey: 'options.maneuverPenalty.label',
  min: 0,
  max: 300,
  step: 1,
};
export const PERFORMANCE_FACTOR_FIELD: FieldSpec = {
  key: 'performanceFactor',
  labelKey: 'options.performanceFactor.label',
  min: 0.5,
  max: 1.1,
  step: 0.05,
};

/** Commit a single numeric setting, skipping a redundant update on an unchanged blur. */
export function commitSetting(
  value: Settings,
  key: NumericKey,
  n: number,
  onChange: (s: Settings) => void,
): void {
  if (n === value[key]) return;
  onChange({ ...value, [key]: n });
}
