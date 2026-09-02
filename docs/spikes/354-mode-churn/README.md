# #354 reproduction artefacts

Companion to [`../354-mode-churn.md`](../354-mode-churn.md). Everything here
was produced against `origin/develop @ 84b049a2`; nothing was re-measured at a
later tip. This directory sits under `docs/spikes/` so that **no vitest config
collects it**: `app/vite.config.ts` includes only `src/**/*.test.{ts,tsx}` and
`app/sweep/vitest.config.ts` pins `root: here` (`grep -rn 'docs/spikes'
app/vite.config.ts app/sweep/vitest.config.ts` is empty). Nothing in it is
linted or type-checked by CI either — it is evidence, not code.

## Inventory

| path | what it is |
|---|---|
| `scratch354.test.ts` | The reproduction driver, byte-identical to the copy run in the BASE worktree and in all seven candidate worktrees. sha256 `13487727fa7db42420b8fbae7a8ace658f1ec1f67bcde75718bb5a60125a350f`. |
| `base-output/run1.json`, `run2.json` | The BASE run at `84b049a2`: full per-sail (`sails[]`) and per-plan (`plans[]`) rows. The spike's §3.2 table is a transcription of `run1.json`. |
| `base-output/double-run-control.json` | `{ byteIdentical: true, mismatches: [] }` — run 1 vs run 2 over every fingerprint. |
| `base-output/positive-control.json` | The `sailPreferenceKn` +2.0 kn perturbation on R1: `anyDiffered: true`, `revertMatches: true`, with the baseline and perturbed sail rows in full. |
| `candidates/354-<x>-<slug>.diff` | One diff per rejected candidate (§4 of the spike), applies to `84b049a2` — and, verified with `git apply --check`, still to `b7bfc0c8`, since none of the touched files changed in between. |
| `candidates/probes/` | Two measurement instruments that are NOT part of any candidate: E's threshold-reachability probe and F's non-vacuity control. Each expects to be copied into `app/sweep/` beside the driver, like the driver itself. |

The BASE worktree's own `git diff` was empty (no source edit — the driver is
test-harness instrumentation from outside `app/src/`), so there is no
`354-baseline.diff`; `base-output/` is the baseline.

## How to run the driver

From the driver's original README, verbatim:

> From a checkout of `sail_command` with `app/node_modules` installed
> (`npm --prefix app ci`), copy `scratch354.test.ts` into `app/sweep/`, then
> from the `app/` directory:
>
> ```
> npx vitest run --config sweep/vitest.config.ts scratch354.test.ts
> ```
>
> or from the repo root:
>
> ```
> npm --prefix app run test -- --config sweep/vitest.config.ts scratch354.test.ts
> ```

`SC_DRIVER_OUT=/abs/path` chooses where the JSON dumps land; the default is
`app/sweep/scratch354-out/`. **That directory is NOT gitignored** (the original
README said it was; `git check-ignore -v app/sweep/scratch354-out/` returns
nothing at `b7bfc0c8`), and the copied driver lints with 4 warnings (unused
`eslint-disable` directives) under CI's `eslint src e2e sweep` — delete both
before committing anything. Outputs are written even when an assertion fails
(the `writeFileSync` calls precede the `expect`s). The three `it()` blocks
took ~31.5 s together on a quiet machine at `84b049a2`: 6 routes x 2 sails x
2 runs = 24 sail solves for the double-run control, plus 3 route plans (6
sail solves) for the positive control, all against the real committed mask and polars.

## The candidate diffs

| file | candidate | tracked files touched | notes |
|---|---|---|---|
| `354-a-mode-penalty-geometric.diff` | A — geometric mode penalty on `effS`, new `Settings.modeChangePenaltyS` | `isochrone.ts`, `types.ts`, `OptionsPanel.tsx`, `SettingsPanel.tsx`, both dicts, `planForm.ts`, `gpx.test.ts`, `planForm.test.ts`, `recalc.test.ts`, `db.test.ts` | The worktree's untracked `changelog.d/354.fixed.md` is appended as a new-file hunk. A's penalty-0 control arm is the same code with `DEFAULT_SETTINGS.modeChangePenaltyS = 0`; not a separate diff. |
| `354-b-mode-penalty-cost-only.diff` | B — module constant `MODE_CHANGE_PENALTY_S = 45` on `costMs` only | `isochrone.ts` | Re-wraps two `edgeFactor(...)` calls onto one line (the repo's prettier hook): one is a standalone whitespace-only hunk (`@@ -578`), the other sits inside the substantive `@@ -451` hunk; B's report says so, and they are not part of the candidate. |
| `354-c-minimum-segment.diff` | C — `Node.modeRunMs` + a 45 s minimum sail run before a motor candidate is admitted | `isochrone.ts`, `isochrone.followups.test.ts` | C's 900 s arm was a temporary env override, reverted; not a separate diff. |
| `354-d-postprocess-absorption.diff` | D — post-hoc absorption of a motor-sandwiched sail run under 45 s | `postprocess.ts` | D's 300 s arm is the same code with the threshold constant raised; not a separate diff. |
| `354-e-presentation-only.diff` | E — legs-table disclosure of mode runs shorter than `settings.maneuverPenaltyS` | `RouteSummary.tsx`, both dicts, `app.css` | The worktree's untracked `lib/briefModeRuns.ts`, `lib/briefModeRuns.test.ts`, `components/RouteSummary.briefRun.test.tsx` and `changelog.d/354.changed.md` are appended as new-file hunks. Its reachability probe is `probes/scratch354e-reach.test.ts`. |
| `354-f-fairway-aware.diff` | F — #244 §6.1 corridor cost term on `costMs` | `isochrone.ts`, `planRoute.ts` | The worktree's untracked `lib/fairway.ts` is appended as a new-file hunk. Carries two whitespace-only prettier hunks (`@@ -457` and `@@ -578`), both `edgeFactor(...)` calls re-wrapped onto one line. Its non-vacuity control is `probes/scratch354F-control.test.ts`. |
| `354-g-floor-hysteresis-band.diff` | G — two-sided hysteresis band around `sailFloorKn` | `isochrone.ts` | The enter-only ablation arm was a one-line temporary change (`sailStayKn = sailFloorKn`), reverted; not a separate diff. |

To reproduce a candidate: check out `84b049a2` in a fresh worktree, `git apply`
the diff, copy `scratch354.test.ts` into `app/sweep/`, run it as above, and
diff the resulting `run1.json` rows against the spike's §3.2 (BASE) and §4.1
(HEAD) tables. The per-candidate `scratch354-out/` dumps each report was read
from are not committed; the rows they contained are transcribed in the spike.
