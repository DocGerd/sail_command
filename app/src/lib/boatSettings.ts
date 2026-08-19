import type { Settings } from '../types';
import type { BoatDef } from '../data/boats';
import { defaultSafetyDepthM, minSafetyDepthM } from './boatDepth';

/**
 * Spec C.7. The three Settings fields with a natural per-boat default: the
 * depth gate (derived from draft + mask tolerance, spec C.3, `boatDepth.ts`)
 * and the two fields BoatDef already carries directly. Everything else in
 * Settings stays a user preference rather than a boat property — see
 * data/boats.ts's own "Deliberately NOT per-boat" note.
 */
export function settingsDefaultsForBoat(
  b: BoatDef,
): Pick<Settings, 'safetyDepthM' | 'motorSpeedKn' | 'maneuverPenaltyS'> {
  return {
    safetyDepthM: defaultSafetyDepthM(b),
    motorSpeedKn: b.motorSpeedKn,
    maneuverPenaltyS: b.maneuverPenaltyS,
  };
}

/**
 * Spec C.7. Deliberately DIFFERENT from usePersistedNumber's contract (#355),
 * where a bounds change alone leaves the stored value untouched. That
 * asymmetry is right for a panel width and wrong here: per the
 * guard-asymmetry rule the uncertain path must fail toward the
 * expensive-but-safe direction, and a silently retained below-hull gate is
 * the cheap-and-dangerous one.
 *
 * NEVER clamp down: a stored safetyDepthM already at or above the new
 * boat's minimum is returned unchanged, however far above the new floor it
 * sits — a deeper-drafted user's deliberately generous margin is not ours
 * to shrink.
 *
 * WIRED (#539 item 1): `components/BoatPicker.tsx`'s `handleSelect` is the
 * call site — every boat switch goes through it, and the clamp notice the
 * picker renders is derived from the `clamped` flag returned here. Earlier
 * revisions of this comment said nothing called it; that was true when
 * written and is no longer.
 */
export function clampSettingsToBoat(
  s: Settings,
  b: BoatDef,
): { settings: Settings; clamped: boolean } {
  const floor = minSafetyDepthM(b);
  if (s.safetyDepthM >= floor) {
    return { settings: s, clamped: false };
  }
  return { settings: { ...s, safetyDepthM: floor }, clamped: true };
}
