/**
 * Inputs of `compare.mjs --estimated-verdict-unsuppressed` (#1716, spec §T.7).
 *
 * Import-free for the same reason as `armNames.ts`: `canonicalize.mjs` loads it
 * under plain Node. Sweep rows carry no `request.boat`, so the arms allowed to
 * change verdict cannot be read off a row; they are pinned here and held to
 * `sweepArms.ts` x `boats.ts` by `src/test/estimateBasedArms.test.ts`.
 */

/** Arms whose boat has an `estimated` sail, i.e. whose verdicts may go from not-compared to compared. */
export const ESTIMATE_BASED_ARM_NAMES = ['salona44-breeze', 'salona44-relaxation'] as const;

/** Twin of `RIG_TIE_BAND_MS` in `src/routing/planRoute.ts`, pinned by the same test. */
export const RIG_TIE_BAND_MS_TWIN = 60_000;
