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

**Determinism control (COMPLETE, 2026-08-20 at `00a33ab`): all nine arms run
twice, 297/297 plans byte-identical.** Per-arm sha256 prefixes, both runs:
`becalmed 8dc119cd`, `breeze 7aa9fb56`, `deep-becalmed 7e7ac2e1`,
`light-motorless 0ded5d87`, `margin-extreme ae91bf71`, `margin-zero fa5e30f1`,
`no-comfort 9fa297c8`, `relaxation-dense f4907139`, `short-horizon 3fb63b77`.
This supersedes the earlier partial control (PR #488 review measured only
`margin-zero`, and this file used to record `relaxation-dense` and
`margin-extreme` as UNMEASURED). The "no `deadline` argument passed"
structural argument — `runArm` never budgets `planRoute()`, so #432's
wall-clock `PLAN_BUDGET_MS` never engages and nothing time-dependent feeds the
solver — is now corroborated empirically for all nine arms rather than argued
for seven of them.

That run's A-side outcome distribution was `ok` 74, `ok+shallow` 83, plus 140
typed failures (`calm-motor-off` 55, `unreachable` 54, `beyond-horizon` 28,
`snap-failed-destination` 3). The three AGGREGATE figures (`ok` 74,
`ok+shallow` 83, 140 typed failures) match the record at `0c494f9` — that
record carries only those three, not the per-cause split, so this is agreement
on what both measured, NOT a full match. It is also **not** the "stronger
control" CLAUDE.md defines: that requires matching per-arm sha256 PREFIXES
across machine/day/merge-base, and no prefixes are on record for `0c494f9`.

Note `margin-zero`'s prefix here (`fa5e30f1`) differs from the `44f1e2…`
recorded at the PR #488 review — different arm definitions and merge-base, so
the two are not comparable; do not read the difference as non-determinism.

Carry the standing caveat with any citation: `becalmed` and `deep-becalmed` are
VACUOUS as safety evidence (33/33 error rows each), so their byte-identity
above is determinism evidence only, never safety evidence.

**"COMPLETE" describes THIS run's nine arms at `00a33ab` — it does NOT
discharge the per-change BASE double-run.** That control must still be recorded
against the merge-base of whatever branch it will certify.

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
  over the *canonicalised* serialisation in this mode (via
  `canonicalize.mjs`'s `canonicalizeArmFile`), not raw bytes: raw bytes
  would print `*** DIFFERS ***` beside a correct canonically-identical
  verdict (the rename changes field names, hence every byte), while
  dropping the digest check entirely would silently lose its real job —
  catching TWO kinds of order regression a per-plan compare can't see: an
  intra-plan key-order change (`canonicalizePlan` normalises only the
  container fields the rename itself touches, so every other key keeps the
  input's own order), and an inter-plan HARBOUR-order change (the per-plan
  compare iterates a shared sorted key list, so it can never see a harbour
  reordering — `canonicalizeArmFile` is called once per side, each on that
  side's own on-disk key order, specifically so the digest can). The digest
  line is diagnostic only in both modes — it never drives the exit code,
  which comes solely from the per-plan compare.

  **Canonical mode is BLIND TO SAIL ORDER (#549)** — a third order regression
  it cannot see, unlike the two the digest exists to catch. `canonicalizePlan`
  SORTS each plan's `sails` array by `sailId`, which is precisely what makes
  the pre-/post-rename shapes comparable, so two plans holding identical sail
  entries in a DIFFERENT ORDER canonicalise to the same object and compare
  IDENTICAL — including the whole-file digest, which is computed over that
  same sorted serialisation. Sail order is not cosmetic: spec §E.3 makes
  `PlanRequest.sailIds` the SOLVE order. Two things bound this, and neither
  is the canonicaliser: **byte mode is not blind to it** (a reordered array
  changes the serialised bytes), and `recommended`, `comparisonComplete` and
  `rigRecommendation` pass through UNSORTED, so a reordering that actually
  changed the verdict still shows. What canonical mode cannot see is a
  reordering that changed nothing *but* the order. **Certify a deliberate
  sail-order change in BYTE mode**; do not reach for `--canonical` for it, and
  do not "fix" this by dropping the sort — that would break the rename
  comparison the mode exists for.

- **Rig-verdict-change mode (`--rig-verdict-change`)** —
  `node app/sweep/compare.mjs --rig-verdict-change <BASE> <HEAD>`. The one
  mode valid for a change that deliberately moves `rigRecommendation` and
  nothing else (#553 / spec §N.4's `not-compared` verdict). It exists because
  **neither other mode can certify that class**: `canonicalizePlan`'s `rest`
  destructure excludes only `genoa`/`fock`/`genoaReason`/`fockReason`/`sails`/
  `comparisonComplete`, so `rigRecommendation` passes straight through and is
  compared verbatim in byte AND canonical mode alike. Measured on
  `light-motorless` while #553 was in review: **12/33 differ in byte mode,
  12/33 in canonical, 0/33 with the field elided** — and the only arms that
  read IDENTICAL are `becalmed`/`deep-becalmed`, which the section below
  already names as vacuous. Partial green from exactly the arms that prove
  nothing.

  It is deliberately **two assertions**, because eliding a field is otherwise
  a comparator that cannot fail:

  1. every plan compares equal with `rigRecommendation` deleted from both
     sides — so any real routing change still fails, and
  2. every plan whose verdict *did* change went `{kind:'decided',rig:R}` ->
     `{kind:'not-compared'}` **and** the HEAD plan really has fewer than two
     non-null `sails[].result`. Without (2) a HEAD that withheld a comparison
     it actually made would pass.

  **ORDER-SENSITIVE**, unlike the other two modes: `<dirA>` must be BASE and
  `<dirB>` HEAD, because (2) asks a directional question. Passing
  `--canonical` alongside it is refused — they are different claims. The
  summary prints the number of verdicts that moved, so a run that observed
  ZERO changes is visibly different from a correct one rather than reading
  the same. Pinned end-to-end (as real child processes) in
  `canonicalize.test.mjs`, including a row asserting that **byte mode fails
  on the very pair this mode passes**.

**The byte comparator is BLIND to a `PlanResultOk` rename in the reassuring
direction on `becalmed` and `deep-becalmed`.** Every plan in those two arms
is `PlanResultError` (`error/calm-motor-off`, `error/unreachable`, or on
`deep-becalmed` also `error/snap-failed-destination` — see the outcome table
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
