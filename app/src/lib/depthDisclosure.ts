import type { Lang } from '../i18n';
import type { BoatDef } from '../data/boats';
import { defaultSafetyDepthM, relaxationFloorM } from './boatDepth';
import { MASK_TOLERANCE_M } from './mask';

/**
 * #539 / #54 spec §C.8 R5 + §J OQ-2 — the About dialog's mask-tolerance
 * disclosure, parameterised by the SELECTED boat.
 *
 * Before this, `about.caveats.depthMask` stated the Salona 45's 2.1 m draft,
 * its 3.0 m derived gate and its 1.2 m relaxation floor as UNIVERSAL facts. On
 * a three-boat catalogue that is simply false for the Elan Impression 444
 * (1.90 m draft -> 2.8 m gate -> 1.0 m floor), in the app's own explanation of
 * how deep the water under the keel may really be.
 *
 * PRESENTATION-ONLY, deliberately: this module derives numbers that already
 * exist and stores nothing. `PlanResult` is untouched, so the `app/sweep/`
 * baseline stays comparable and no #282 acceptance run is owed.
 *
 * SELECTED boat, never the plan's — spec §J OQ-2: "the user plans for one
 * boat, so that is the number that applies to them". The About dialog is not
 * scoped to any plan, which is the opposite of the rule governing
 * `ShallowWarning`, where the copy must follow `plan.request.boat`.
 */

const LOCALES: Record<Lang, string> = { de: 'de-DE', en: 'en-GB' };

/**
 * One decimal place BY DEFAULT, in the active language's own decimal
 * separator — "1,9" for German, "1.9" for English. `fractionDigits` is an
 * escape hatch for a caller with no fraction to show at all (an integer
 * axis-tick label) — it is display precision, never a licence to show more
 * precision than the mask can justify.
 *
 * The shipped German copy hardcoded "2,1 m" / "1,2 m" before these numbers
 * became placeholders, and a bare `toFixed(1)` would have silently regressed
 * every one of them to an English decimal point. That is also what
 * `maskTolerance.test.ts`'s hand-written `measurement()` twin expects, so a
 * regression here reds a real assertion rather than passing unnoticed.
 *
 * #596: this comment used to defer reusing this formatter for
 * `route.shallow.lead`'s `{draft}` slot as "a separate, wider copy decision
 * and not #539's to make". That decision is now MADE: every USER-VISIBLE
 * depth figure across RouteSummary.tsx/LiveView.tsx/BoatPicker.tsx/
 * DepthProfile.tsx now goes through this function, because #525 made
 * `formatNm`/`formatKn` locale-aware while depth figures stayed on bare
 * `toFixed(1)` — which is what let one German sentence mix a comma-formatted
 * distance beside a point-formatted depth (`route.shallow.exposure`,
 * `route.marginal.notice`). The ~40 SVG-geometry `toFixed(` calls in
 * DepthProfile.tsx (path `d` strings, `transform`, `viewBox`, bare
 * `x`/`y`/`width`/`height` attributes) are deliberately EXCLUDED — a locale
 * comma inside an SVG coordinate or path attribute corrupts the rendering,
 * so those stay locale-invariant.
 */
export function formatDepthM(value: number, lang: Lang, fractionDigits = 1): string {
  return new Intl.NumberFormat(LOCALES[lang], {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * The four numbers spec §C.8 R5 requires the disclosure to state, plus the
 * boat's own name so a reader can see WHICH boat they apply to.
 *
 * `floor` is the #53 relaxation floor's conservative reading,
 * `relaxationFloorM(b) - T` — NOT the UI-minimum floor `minSafetyDepthM(b) - T`.
 * Relaxation reaches lower than any value a user can type, and spec §C.8
 * records the UI-minimum form as "the earlier, WRONG version of this test and
 * of the disclosure copy". Do not re-derive the discarded version.
 *
 * The copy says the default gate is set so its floor never falls below the
 * draft, which is `defaultSafetyDepthM(b) - T >= b.draftM` — true for every
 * boat by construction (spec §C.3, pinned as R3). It deliberately does not
 * claim the two are EQUAL: they are for all three catalogue boats today, but a
 * draft the ceiling rounds up (2.25 m -> a 3.2 m gate -> a 2.3 m floor) breaks
 * that equality while leaving the inequality intact.
 */
export function depthMaskCaveatVars(b: BoatDef, lang: Lang): Record<string, string> {
  return {
    boat: b.name,
    tolerance: formatDepthM(MASK_TOLERANCE_M, lang),
    gate: formatDepthM(defaultSafetyDepthM(b), lang),
    draft: formatDepthM(b.draftM, lang),
    floor: formatDepthM(relaxationFloorM(b) - MASK_TOLERANCE_M, lang),
  };
}
