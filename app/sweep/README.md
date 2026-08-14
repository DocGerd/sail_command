# #282 acceptance sweep

All 33 harbours × 9 settings arms = **297 plans**, against the real committed
mask and polars, with every `PlanResult` serialised for byte-for-byte
comparison between two revisions.

Issue #282 makes this a **standing requirement**: the no-route cause is a
control input, so any change to how `solve()` *classifies* a failure can move
real routes. Run this before trusting such a change. A change that is only
meant to be presentational must move nothing.

**#452**: the original six arms (Flensburg origin) can each carry a
*successful* #53 depth relaxation (a `shallow` block) on only 1 of their 33
rows (the Marstal leg) — a `cellsConnected` connectivity probe over all 528
unique harbour pairs in `harbors.json` (33 choose 2) found a relaxed gate
connects on 27 of them, and EVERY one of the 27 involves Marstal. The
relaxation-*attempt* gate itself is not rare (`depthRelaxationMayHelp` true
51/198, table below — the five #9 KNOWN_DISCONNECTED harbours enter the same
block on every Flensburg-origin row that names one, they just never find a
gate), but a successful one is. `margin-zero`, `relaxation-dense` and
`margin-extreme` (see their doc comments in `sweepArms.ts`) use Marstal as
origin instead, so 27 of their 33 rows carry a `shallow` block — verified by
running them once (2026-08-10): `margin-zero` 27/33, `relaxation-dense`
27/33, `margin-extreme` 27/33 (5 `unreachable` = the #9 KNOWN_DISCONNECTED
harbours; 1 trivial Marstal→Marstal `ok` row with no `shallow` block).

This is real discriminating coverage, not three more `becalmed`s — verified
plan-by-plan (a whole-file sha256, unlike this, cannot tell "16 routes
changed" from "one timestamp changed", and `becalmed`/`deep-becalmed` are
already this repo's own named example of byte-distinct arms that prove
nothing):

| pair | plans differing |
|---|---|
| `margin-zero` vs `relaxation-dense` | 16 / 33 |
| `relaxation-dense` vs `margin-extreme` | 27 / 33 |
| `margin-zero` vs `margin-extreme` | 27 / 33 |

The `margin-zero` vs `relaxation-dense` figure has a structural explanation
that cannot rot the way a measured number can: `comfortDepthM` is `undefined`
whenever `depthComfortMarginM === 0` (`planRoute.ts:301-302`), and both #243
retry gates are guarded `comfortDepthM !== undefined && …`
(`planRoute.ts:440`, `:515`) — so `margin-zero` can **never** reach tier 2 or
tier 4, while `relaxation-dense` and `margin-extreme` can. Turning the
comfort margin from 0 to the shipped 2.0 m default therefore moves 16 of 33
routes, not all 27 — the remaining 11 rows are ones where the extra pricing
changes nothing observable.

**Determinism control (partial, PR #488 review): `margin-zero` run twice,
byte-identical** — `sha256 44f1e2…4f2342b` both times (matches this
session's own run too). The three #452 arms otherwise share `README.md`'s
"no `deadline` argument passed" structural argument for why a byte-identical
BASE double-run is expected (`runArm` never budgets `planRoute()`, so #432's
wall-clock `PLAN_BUDGET_MS` never engages and nothing time-dependent feeds
the solver) — but only one of the three has actually been run twice.
`relaxation-dense` and `margin-extreme` are UNMEASURED for determinism;
`margin-extreme` is the one to double-run first if this ever needs full
confidence, since it is the only one of the three whose control flow depends
on a tier-3 *failure* rather than a tier-3 success.

## Why it lives here and not under `src/`

`app/vite.config.ts`'s `test.include` is `['src/**/*.test.{ts,tsx}']`, so
nothing in this directory is collected by `npm --prefix app run test` or by CI.
That is deliberate — the sweep costs ~20 minutes of real solver time. It is run
on demand, via its own `vitest.config.ts` in this directory.

That config is necessary, not decoration: vitest 4 has **no `--include` flag**
(it exits `CACError: Unknown option \`--include\``, measured against
`vitest@4.1.10`), and `--dir` only narrows the scan — neither can widen the
root config's `include`, which by construction excludes this directory.

Two consequences worth knowing: `npm --prefix app run lint` is literally
`eslint src`, so these files are not linted by CI (same status as `app/e2e/**`,
issue #420); and they are typechecked only because `tsconfig.test.json`'s
`include` names `sweep/**/*.ts` — they need node builtins, like the other
entries there.

## Running it

```bash
# BASE — check out the revision you are comparing against FIRST.
# Run it TWICE, into two directories (see the control below).
SC_SWEEP_OUT=/tmp/sweep/base1 \
  npm --prefix app run test -- --config sweep/vitest.config.ts
SC_SWEEP_OUT=/tmp/sweep/base2 \
  npm --prefix app run test -- --config sweep/vitest.config.ts

# ...then your change
SC_SWEEP_OUT=/tmp/sweep/head \
  npm --prefix app run test -- --config sweep/vitest.config.ts

node app/sweep/compare.mjs /tmp/sweep/base1 /tmp/sweep/base2   # the control
node app/sweep/compare.mjs /tmp/sweep/base1 /tmp/sweep/head    # the result
```

## Two comparators, and when each one is valid

`compare.mjs` has two modes. **Use the wrong one and you get a confident,
wrong answer** — a byte compare of a deliberate rename fails loud even when
every route is unchanged; a canonical compare of an accidental behavior
change can pass when it shouldn't if the canonicaliser ever normalises more
than container shape (it doesn't — see `canonicalize.mjs`'s own header — but
that is exactly the property to keep re-verifying if this file is ever
touched).

- **Byte mode (default, no flag)** — `node app/sweep/compare.mjs <dirA>
  <dirB>`. Compares `JSON.stringify` per harbour plan plus a whole-file
  sha256 of the raw arm file. Valid for a **no-change claim**: "this PR is
  presentational, prove it moved nothing." Every `PlanResult`'s field names
  and structure must be byte-identical between the two revisions being
  compared, or this mode will (correctly) report a difference for a reason
  that has nothing to do with routing.

- **Canonical mode (`--canonical`, either argument position)** —
  `node app/sweep/compare.mjs --canonical <dirA> <dirB>`. Runs each parsed
  plan through `canonicalize.mjs`'s `canonicalizePlan` before comparing —
  maps the pre-rename `PlanResultOk` shape (named `genoa`/`fock`/
  `genoaReason`/`fockReason` fields, `RigResult.rig`) and the post-rename
  shape (Task 9: a `sails` list, `RigResult.sailId`) onto one form, so a
  BASE plan and a HEAD plan carrying the same routes compare equal across
  the rename. Valid for a **deliberate container-shape change**: "this PR
  renames fields, prove it moved no route." It deliberately does NOT
  normalise leg geometry, ETAs, distances, or `NoRouteReason` values — only
  which field holds a rig's result and what that rig is called — so it
  still fails on an actual routing change. The whole-file digest is computed
  over the *canonicalised* serialisation in this mode, not raw bytes: raw
  bytes would print `*** DIFFERS ***` beside a correct canonically-identical
  verdict (the rename changes field names, hence every byte), while
  dropping the digest check entirely would silently lose its real job —
  catching a key-order regression a per-plan compare can't see.
  `canonicalizePlan` does not normalise key order in general, only the
  container fields the rename itself touches, so that check still has teeth
  in canonical mode.

**The byte comparator is BLIND to a `PlanResultOk` rename in the reassuring
direction on `becalmed` and `deep-becalmed`.** Every plan in those two arms
is `PlanResultError` (`error/calm-without-motor`, per the outcome table
above) — and `PlanResultError` carries no sail fields at all (`{ status:
'error', reason }`, untouched by the Task 9 rename). So a byte compare of
those two arms alone stays byte-identical straight through the rename and
reports IDENTICAL, whether or not the rename broke anything on the other
seven arms. Never treat a byte-mode green on `becalmed`/`deep-becalmed` as
evidence the rename is safe; use canonical mode, and lean on the other seven
arms (which do carry `PlanResultOk` rows) for the routing evidence itself.

`compare.mjs` needs **Node >= 22.18** to run standalone (it `import()`s
`armNames.ts` directly under plain Node — see that file's own doc comment):
below that floor, unflagged TypeScript type-stripping is unavailable and it
fails loudly with `ERR_UNKNOWN_FILE_EXTENSION` rather than silently. CI's
`node-version: 22` resolves to the latest 22.x patch at install time
(comfortably past 22.18 for any recent run), but `compare.mjs` is a manual
tool CI never invokes, so a contributor on an older local Node needs to
upgrade before this works.

`SC_SWEEP_OUT` is required (absolute path); the run fails closed without it.
`SC_SWEEP_LIMIT=N` restricts to the first N destinations — for calibrating a
change to the harness itself, never for a real comparison. A trailing
positional filters arms by filename (`… sweep/vitest.config.ts becalmed`).

**Run BASE twice, into two directories, and compare those first.** If the two
BASE runs are not byte-identical, the harness is not deterministic and a
matching HEAD result proves nothing. This control is not optional; it is what
licenses the comparison at all.

## The baseline is defined by these parameters

Everything in `sweepArms.ts` that shapes the input is part of the baseline's
identity: the arm list and their wind fields, the `{ hours: 3 }` override on
`short-horizon`, the settings deltas, **each arm's origin** (`Arm.originId`,
`harbors.json`'s `flensburg.snap` by default, `marstal.snap` for the three
#452 relaxation arms — added #452, PR #488: a PRE-#452 baseline's implicit
"the origin is always flensburg.snap" is no longer true of the file as a
whole, only of arms that omit `originId`), `T0`, and `serialize()`'s replacer
and 1-space indent. Change any one of them and previously recorded output is
no longer comparable. **Add an arm rather than editing one.**

## Recorded baseline — 2026-08-07, PR #450 (`dbcd519`)

**Covers only the ORIGINAL six arms (198 of the 297 plans this harness now
produces).** No baseline has been recorded for the three #452 arms below
(`margin-zero`, `relaxation-dense`, `tier4-forcing`) — the BASE double-run
control for those was deliberately deferred to whenever a real
depth-relaxation change is actually implemented, so it can be recorded
against that change's own merge-base rather than a `develop` that keeps
moving underneath it (see this PR's description).

| | |
|---|---|
| BASE run 1 vs BASE run 2 (determinism control) | 198/198 byte-identical, all six arm files sha-identical |
| BASE vs HEAD (the #282 solver/label decoupling) | 198/198 byte-identical, against both BASE runs |

Outcome mix: `ok` 71, `ok+shallow` 2 (`breeze/marstal`, `no-comfort/marstal`),
`unreachable` 39, `calm-motor-off` 55, `beyond-horizon` 28,
`snap-failed-destination` 3.

Read that headline as **73 full route geometries + 125 failure
classifications**, not 198 independent routes: the 125 error rows are one of
only four distinct two-field objects, so they verify the cause→label mapping
and nothing about geometry. Essentially all the geometric evidence is carried
by the 73 `ok` plans — which are genuinely diverse (`breeze` and `no-comfort`
share a wind field yet only 6 of 33 rows, and 1 of 28 `ok` rows, are identical
between them).

Gate coverage over the same 198 plans, from an instrumented run (counters added
to both predicates, then reverted; that run's plan output was itself confirmed
byte-identical to BASE, which is what licensed the revert):

| gate | true | false | causes observed |
|---|---|---|---|
| `comfortRetryMayHelp` | 66 | 110 | mask-blocked 43, horizon-exceeded 23, calm-without-motor 110 |
| `depthRelaxationMayHelp` | 51 | 73 | mask-blocked 51, horizon-exceeded 22, calm-without-motor 51 |
