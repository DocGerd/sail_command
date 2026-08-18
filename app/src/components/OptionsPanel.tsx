import type { Settings } from '../types';
import type { MsgKey } from '../i18n/dict.de';
import { minSafetyDepthM } from '../lib/boatDepth';
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
export const SAFETY_DEPTH_FIELD: FieldSpec = {
  key: 'safetyDepthM',
  labelKey: 'options.safetyDepth.label',
  // #54: derived per-boat minimum (spec J OQ-1) rather than a hand-written
  // literal — evaluates to 2.2 for the release-1 default boat.
  min: minSafetyDepthM(boatById(DEFAULT_BOAT_ID)),
  max: 10,
  step: 0.1,
};

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
