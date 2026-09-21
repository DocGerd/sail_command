# #282 acceptance sweep

All 40 harbours × 11 settings arms = **440 plans** (9 arms / 297 plans
through #452; #653 added the two `salona44-*` arms below; #295 grew the
harbour list 33 -> 40, see "#295 sweep control" below), against the real
committed mask and polars, with every `PlanResult` serialised for
byte-for-byte comparison between two revisions.

Issue #282 makes this a **standing requirement**: the no-route cause is a
control input, so any change to how `solve()` *classifies* a failure can move
real routes. Run this before trusting such a change. A change that is only
meant to be presentational must move nothing.

**#653**: every arm through `margin-extreme` plans exclusively for
`DEFAULT_BOAT_ID` (`salona-45`) — `sweepArms.ts`'s `runArm()` resolved a
single hardcoded boat for all nine, so a `boatDepth.ts`/`depthGate.ts`
regression correct for the Salona 45's gate but wrong for a DIFFERENT
per-boat gate (a `defaultSafetyDepthM`/`relaxationFloorM` mixup, or a
boat-keyed polar lookup bug) was invisible to this harness. `runArm()` now
takes its boat from the new `Arm.boatId` field (defaulting to
`DEFAULT_BOAT_ID` when absent, so every PRE-#653 arm is UNCHANGED — see that
field's own doc comment in `sweepArms.ts`), and two new arms exercise it:

- `salona44-breeze` — the Salona 44 "SPEEDY GO!" mirror of `breeze`
  (Flensburg origin, `DEFAULT_SETTINGS`, no depth relaxation on 27 of its 33
  rows — like `breeze`, the Marstal leg is the one row that does relax, per
  the #452 paragraph below).
- `salona44-relaxation` — the Salona 44 mirror of `relaxation-dense`
  (Marstal origin, `DEFAULT_SETTINGS`, #53 relaxation exercised).

**Both Salonas draft 2.1 m** (`app/src/data/boats.ts`), so
`defaultSafetyDepthM`/`relaxationFloorM` — both pure functions of `b.draftM`
— compute the IDENTICAL gate for either boat: these two arms do NOT
discriminate a depth-gate regression by themselves. `salona44-breeze`'s
depth outcome (`usedDepthM`, `shallow` flags) matches `breeze`'s exactly on
every row (verified: zero status-differing rows, Marstal's `usedDepthM`
identical). `salona44-relaxation`'s `usedDepthM` likewise matches
`relaxation-dense`'s exactly on every both-ok row — but the OUTCOME SET does
not: `relaxation-dense` is 27 `ok+shallow` / 5 `unreachable` while
`salona44-relaxation` is 26 / 6, because `rudkoebing` is `ok+shallow` for the
Salona 45 and `unreachable` for the Salona 44 at the identical gate. Cause
not established — tracked as #866, MAX_FRONTIER search-capacity truncation
is the leading hypothesis, not a finding. What both arms DO discriminate
(beyond that one open question) is the boat-keyed
POLAR lookup (`polarKey(boat.id, sail.id)`) and the plan/ETA it produces — a
tier-C estimated table genuinely different from the Salona 45's
certificate/modelled one, though not uniformly faster (see #866's own data
for two rows where the Salona 44 plan is markedly slower) — end to end
through both the ordinary and the
depth-relaxed solve path, for a boat other than the one all nine prior arms
exercise. See `app/src/routing/realmask.repro.salona44.test.ts`'s `#653`
describe block for the pinned, boat-sensitive evidence at the
individual-plan level.

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

**Determinism control (COMPLETE, 2026-08-20 at `00a33ab`, HISTORIC — not
reproducible at current develop (predates at least #1322's
`pruneCellConfined`)): all nine arms run twice, 297/297 plans byte-identical.** Per-arm sha256 prefixes, both runs:
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
on what both measured, NOT a full match. It is also **not** the stronger,
cross-machine control: that needs BASE *and* HEAD per-arm sha256 prefixes
matching a prior run on a different machine, day and merge-base, which would
prove the baseline stable against the very thing that could invalidate it
rather than merely deterministic against itself — and no prefixes are on
record for `0c494f9`.

Note `margin-zero`'s prefix here (`fa5e30f1`) differs from the `44f1e2…`
recorded at the PR #488 review. The ARM DEFINITION is byte-identical between
the two commits — the difference comes from the intervening merge-base
(serializer and solver changes), so the two prefixes are not comparable; do not
read the difference as non-determinism.

Carry the standing caveat with any citation: `becalmed` and `deep-becalmed` are
VACUOUS as safety evidence (33/33 error rows each), so their byte-identity
above is determinism evidence only, never safety evidence.

**"COMPLETE" describes THIS run's nine arms at `00a33ab` — it does NOT
discharge the per-change BASE double-run.** That control must still be recorded
against the merge-base of whatever branch it will certify.

## #653 sweep control — two new arms, salona44-breeze/salona44-relaxation

**COMPLETE, 2026-09-02 at `d23d4c0`, HISTORIC — not reproducible at current
develop (predates at least #1322's `pruneCellConfined`): two full runs of
the ELEVEN-arm harness on this branch's own HEAD, 363/363 plans
byte-identical, all eleven arm files sha-identical.** Per-arm sha256 prefixes, both runs (`compare.mjs`
output; the nine pre-#653 prefixes below were independently re-verified by
PR #861's round-2 claim-auditor on 2026-09-02 by re-hashing `run2`'s raw
arm-file bytes with `compare.mjs`'s own byte-mode algorithm
(`sha256(raw)[:16]`), not by copying either run's printed line — all eleven
arms matched, and run 1 and run 2 agreed on all eleven):

`becalmed 8dc119cd9a1fdced`, `breeze 7aa9fb563dd8fea0`,
`deep-becalmed 7e7ac2e14d5305ae`, `light-motorless 0ded5d87bca1a190`,
`margin-extreme ae91bf7128102b15`, `margin-zero fa5e30f17325d4e6`,
`no-comfort 9fa297c8e55cd0fc`, `relaxation-dense f4907139a4d4ddd6`,
`salona44-breeze 77cb11e848e51799`, `salona44-relaxation f3c0f61ba277bbe2`,
`short-horizon 3fb63b775bce2fab`.

**The nine PRE-#653 arms' prefixes above match the `00a33ab` table
recorded higher up this file, 9/9, exactly** — independently re-derived
(not assumed from the arm literals being byte-unchanged): every one of
`becalmed`/`breeze`/`deep-becalmed`/`light-motorless`/`margin-extreme`/
`margin-zero`/`no-comfort`/`relaxation-dense`/`short-horizon`'s 16-hex
prefix above starts with its corresponding 8-hex `00a33ab` prefix. This is
the cross-run form CLAUDE.md calls a STRONGER control than a self
double-run — the same nine arms reproduce a prior run from a different
merge-base and day, not merely themselves.

A-side outcome distribution across all 363 plans: `ok` 102, `ok+shallow`
110, `error/calm-motor-off` 55, `error/unreachable` 65,
`error/beyond-horizon` 28, `error/snap-failed-destination` 3.
**`becalmed`/`deep-becalmed` contribute 66 of the 151 error rows (33 each,
100% error in both — every row in both arms is an error) and remain VACUOUS
as safety evidence**, per this file's own standing caveat above; the other
nine arms' error rows carry the real distinguishing signal.

The two new arms' own distributions (independently computed from `run2`'s
JSON, not copied from either reviewer's prose): `salona44-breeze` — `ok` 27,
`ok+shallow` 1 (`marstal`), `error/unreachable` 5 (the #9
KNOWN_DISCONNECTED harbours, matching `breeze`'s own 5); `salona44-relaxation`
— `ok+shallow` 26, `error/unreachable` 6, `ok` 1 — the one extra
`unreachable` relative to `relaxation-dense`'s 27/5/1 split is `rudkoebing`,
tracked as #866 (see the paragraph above).

**Durations DISCARDED as evidence**: both runs executed under this session's
own multi-agent load (run 1: 2710.17s wall for 11 parallel arms; run 2:
2184.14s), which is why `vitest.config.ts`'s "no new slowest-arm candidate"
claim was corrected to a measured-under-load figure rather than a clean one
— see that file's own comment. Byte-identity, not timing, is this section's
evidence.

**Both runs executed against the PRE-review-round-1-fix-wave module
content.** `vitest` imported `sweepArms.ts`/`armNames.ts` for both runs'
collection phase before either run started its arms (run 1 at
2026-09-02T09:47:11Z, run 2 at 10:29:40Z); the review-round-1 fixes to those
files landed on disk at 10:43–10:46Z, after both collection phases had
already read the pre-fix content — so this double-run certifies commit
`d23d4c0`, not the file content as currently committed. The only
non-comment code change since `d23d4c0` is `sweepArms.ts`'s `runArm()`
passing `boatSnapshot(boat)` instead of `defaultBoatSnapshot()` for
`request.boat`.

**PROVEN output-inert, not merely argued**: a single-arm `salona44-breeze`
re-run at commit `3a0072b` (after the `boatSnapshot(boat)` change) —
`SC_SWEEP_OUT=.../head-breeze`, driver PID 1124098 — produced a
`salona44-breeze.json` that hashes to `77cb11e848e51799`, byte-identical to
this section's own run1/run2 prefix for that arm. Only
`salona44-breeze.timings.json` differs (`640c066a` at `3a0072b` vs
`52a87c64` in run 2), exactly as expected for a wall-clock field that was
never claimed to match. This closes the gap the caveat above leaves open:
the `boatSnapshot(boat)` change is confirmed to move no route, so the
determinism control this double-run establishes carries forward to the
file content as currently committed, not only to `d23d4c0`.

**Re-sync ruling** (PR #861's round-4 reviewer, `8b22bfe` -> `3c94221`, one
sentence so the next reader need not re-run this sweep to re-derive it):
that 11-file delta needed no re-sweep because it contains no closure
member, no solver-path import of any of the 11 files (grepped
`routing/`/`lib/{mask,depthGate,geo,polar,wind,boatDepth}.ts`/`types.ts`/
`data/boats.ts`, zero hits), and `types.ts` itself is unchanged — so
`DEFAULT_SETTINGS`, `app/public/data/` and `pipeline/` stay untouched and
the double-run above still certifies the branch.

## #295 sweep control — 40-harbour baseline

**COMPLETE, recorded at `e1346bd`** (#295 grew `harbors.json` 33 -> 40).
**HISTORIC — not reproducible at current develop (predates at least #1322's
`pruneCellConfined`).**
`node .claude/skills/sweep-closure/closure.mjs diff e1346bd 5f3eeeb` reports
NOT OWED: PR #1245's four changed files past this commit
(`app/e2e/seamarks.spec.ts`,
`app/src/routing/realmask.repro.relaxationFloor.test.ts`,
`app/src/routing/relaxationTrade.differential.test.ts`,
`app/vite.config.ts`) sit outside the sweep's import-walk closure and
outside `app/public/data/`/`pipeline/`, so this baseline still certifies the
PR head at `5f3eeeb`.

Two full runs of the eleven-arm harness at `e1346bd`, **440/440 plans
byte-identical across 11 arms x 40 harbours** (`node app/sweep/compare.mjs
sa1 sa2`). Per-arm sha256 prefixes, both runs identical: `becalmed
bfa4e82d1b41a7ed`, `breeze ccfffed81dc680b5`, `deep-becalmed
9c56e946f1ebdd8e`, `light-motorless d733f4f2d0163ca0`, `margin-extreme
50df940335e1f3d2`, `margin-zero 98f15ecf7c5a0a9e`, `no-comfort
917dde9fa1b8592a`, `relaxation-dense 04a11f4569b6459f`, `salona44-breeze
46d950d2789d5223`, `salona44-relaxation ad49449d8430abf5`, `short-horizon
0afc647344fba0bc`.

A-side outcome distribution across all 440 plans: `ok` 125, `ok+shallow`
138, `error/calm-motor-off` 67, `error/unreachable` 70,
`error/beyond-horizon` 35, `error/snap-failed-destination` 5.

A companion 33-harbour BASE double-run at the same commit lineage
(pre-#295 harbour list) reproduces the "#653 sweep control" table above
prefix-for-prefix, 11/11 — cross-run corroboration of that existing
baseline, not a new measurement.

The maintainer accepted this diff (against `develop`'s `33dbad2`) on
2026-09-15. Classification of the accepted routing differences (grid-step
drift, frontier-cap pressure, one status flip, two rig flips; residuals
#1257, #1258, #1259) is in the sweep-verdict comment on PR #1245.

## Why it lives here and not under `src/`

`app/vite.config.ts`'s `test.include` is `['src/**/*.test.{ts,tsx}']`, so
nothing in this directory is collected by `npm --prefix app run test` or by CI.
That is deliberate — the sweep costs real solver time, on the order of
half an hour: run 2 of this PR's own double-run (11 arms, `fileParallelism`)
measured **2184.14 s wall** (driver log), with the slowest single arm alone
at 2048.7 s (`salona44-relaxation`, summed from its `timings.json`) — the
`~20 minutes` figure this used to say predates even the nine-arm #452
expansion — introduced at the original six-arm harness (PR #450, `37b924c`)
and never touched since — and is stale even before accounting for load.
Both numbers were measured under this session's own concurrent
multi-agent load, not a quiet machine — see "#653 sweep control" above for
the full caveat. It is run on demand, via
its own `vitest.config.ts` in this directory.

That config is necessary, not decoration: vitest 4 has **no `--include` flag**
(it exits `CACError: Unknown option \`--include\``, measured against
`vitest@4.1.10`), and `--dir` only narrows the scan — neither can widen the
root config's `include`, which by construction excludes this directory.

One consequence worth knowing: they are typechecked only because
`tsconfig.test.json`'s `include` names `sweep/**/*.ts` — they need node
builtins, like the other entries there. (This directory USED to be excluded
from `npm --prefix app run lint` too — `app/package.json`'s `lint` script
was `eslint src e2e` until PR #602 added `sweep` at the v0.17.0 cut, so
these files ARE linted by CI now, same as `app/e2e/**` since PR #508/#420,
2026-08-11.)

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

## Sharding (#1262)

Arms are file-parallel (`vitest.config.ts`'s `fileParallelism`), so a plain
run's wall time is its SLOWEST single arm — measured at 4303 s (~72 min) over
40 harbours (#1262's own issue text; see CLAUDE.md's `app/sweep/` bullet for
the up-to-date figure, which decays on the same schedule this note does).
`SC_SWEEP_SHARD=<index>/<count>` (1-indexed, Playwright's `--shard`
convention) splits EVERY arm's destinations across `<count>` invocations
instead, each computing only its own slice — run them in parallel and merge.

**`run-sharded.mjs` (#1338) drives this end to end** — spawns `<count>`
`SC_SWEEP_SHARD` invocations concurrently, merges via `merge-shards.mjs`
(unmodified), and writes a manifest of per-arm sha256 prefixes in the
sweep-closure ledger's own `arms` shape:

```bash
node app/sweep/run-sharded.mjs --shards 4 --max-workers 6 --out /tmp/sweep/head

# compare.mjs is UNCHANGED — point it at the merged directory as always.
node app/sweep/compare.mjs /tmp/sweep/base1 /tmp/sweep/head/merged
```

`--shards`/`--max-workers`/`--out` are required (fail-closed, no default);
`--out` must be absolute; `--limit` is optional, same meaning as
`SC_SWEEP_LIMIT` below. It prints every shard/merged/manifest path BEFORE
spawning anything, and never runs `npm --prefix app exec vitest` (wrong cwd,
loads no config — see the file's own header). It also refuses a non-empty
`--out` outright (exit 2, before anything spawns) — a reused directory would
merge stale part files from a prior run into this run's manifest. A
non-zero shard exit is logged, not the verdict — the verdict is
`merge-shards.mjs`'s own fail-closed checks over that freshly created `--out`.
The manual for-loop form below still works if you need to run a subset of
shards by hand or on separate machines. For a REAL, multi-hour sharded
sweep, detach it the same way CLAUDE.md's `app/sweep/` bullet requires for
an unsharded run — `setsid`/`nohup`, reporting the `--out` path at detach,
not on completion — the example above runs in the foreground only to show
the invocation shape.

**Reusing a recorded BASE instead of re-running it**: before paying either
side of a sharded run, ask `.claude/skills/sweep-closure/`'s `reuse
<recorded-sha> <base>` whether a ledger entry
(`.claude/skills/sweep-closure/recorded-runs.json`) already covers your BASE
— see that skill's own "Reusing a stored BASE" section for the schema and
fail-closed rules.

```bash
# Manual form — one invocation per shard, each its own SC_SWEEP_OUT.
for i in 1 2 3 4; do
  SC_SWEEP_OUT=/tmp/sweep/head-shard-${i}of4 SC_SWEEP_SHARD=${i}/4 \
    npm --prefix app run test -- --config sweep/vitest.config.ts --maxWorkers=6 &
done
wait
node app/sweep/merge-shards.mjs /tmp/sweep/head \
  /tmp/sweep/head-shard-1of4 /tmp/sweep/head-shard-2of4 \
  /tmp/sweep/head-shard-3of4 /tmp/sweep/head-shard-4of4
```

The split is `idx % count`, applied AFTER `SC_SWEEP_LIMIT` — so a
`SC_SWEEP_LIMIT`-truncated calibration run can still be sharded, and each
destination keeps its relative position from `harbors.json`. Each shard's
output filename is `<label>.shard<i>of<count>.limit<limit>.json`
(`sweepArms.ts`'s `armFileBase`; `<limit>` is the literal `SC_SWEEP_LIMIT`
value that invocation ran under, `0` when unset), never `<label>.json` —
`compare.mjs`'s own arm-name check would (correctly) reject a shard part file
pointed at directly, since its name is not in `armNames.ts`. **Never point
`compare.mjs` at a shard directory** — always merge first.

`merge-shards.mjs` reassembles the parts in `harbors.json`'s own order — the
same order an unsharded `runArm()` inserts rows in — using the identical
`serialize()` (`serialize.ts`, extracted from `sweepArms.ts` so this plain-Node
script can import it without pulling in the app's module graph — see
`armNames.ts`'s own doc comment for why that constraint exists). A merged
directory is therefore BYTE-IDENTICAL to what one unsharded run at the same
commit would have written; sharding changes WHICH destinations a process
solves and WHERE it writes them, never `T0`, `settings`, `wind()`, the
origin, or the serialized bytes — the baseline-identity parameters named
below are untouched. It fails CLOSED on a missing shard, two shards run under
DIFFERENT `SC_SWEEP_LIMIT` values (#1283 — the limit lives in the filename
precisely so this is a filename-level check, not an inferred one), a
harbour double-counted across shards, an incomplete arm set, or a harbour id
the CURRENT `harbors.json` no longer lists — see its own header comment for
the full list. `sweep/merge-shards.test.mjs` (run via `npm --prefix app run
test:sweep-unit`, in CI's required `app` job) mutation-checks the ordering
claim and the fail-closed paths against synthetic fixtures; it cannot
substitute for the empirical BASE double-run above, which still needs a real
solver run start to finish.

**`--maxWorkers` cap.** Each shard invocation still runs all eleven arms in
parallel within itself (`fileParallelism`'s one-worker-per-arm-file shape is
unchanged), so `<count>` concurrent invocations multiply potential
concurrency to up to `11 * <count>` solver workers. #1262's own estimate is
~0.66 GB per solver worker — size `--maxWorkers` (passed after `--` to the
underlying vitest invocation, as in the manual example above) so `<count> *
--maxWorkers` stays around 20–24 on a 26 GB host, never uncapped. A cap that
is too low costs wall time; one that is too high risks the host, which is
the worse failure. `run-sharded.mjs` enforces this as `MAX_TOTAL_WORKERS =
24` and refuses `--shards * --max-workers` above it — the manual for-loop
form has no such guard, so size it by hand.

**Overlaying onto an older BASE tree.** A BASE checkout predating #1262 has
no `SC_SWEEP_SHARD` branch, no `serialize.ts`, and no `merge-shards.mjs` — so
it cannot be sharded as-is. Overlay from **`<the #1262 merge commit>`** — a
FIXED ref, never `<HEAD-commit>` of whatever branch is under test: that
commit's own `sweepArms.ts` may carry OTHER, later hunks (a changed arm), and
overlaying its whole file would silently run HEAD's arms at BASE. FIRST
confirm the precondition: `git diff <BASE> <the #1262 merge commit> --
app/sweep/sweepArms.ts` must show only the #1262 hunks (the arm list, wind
fields, settings, origins, boats, `T0`, or `serialize()`'s bytes are
untouched — `serialize` was only MOVED, not changed, out of `sweepArms.ts`).
Then copy the three harness files forward with
`git restore --source=<the #1262 merge commit> -- app/sweep/sweepArms.ts
app/sweep/serialize.ts app/sweep/merge-shards.mjs` onto the BASE checkout —
never touching `app/src/**`. `armNames.ts`, the test
file and `package.json` need no copy: `armNames.ts` is unchanged by #1262,
and the other two aren't needed to RUN the harness. Merge each side's shards
with THAT SIDE's own `merge-shards.mjs` — it reads `harbors.json` and
`armNames.ts` relative to its own file location, not the shard directory —
so a BASE run's shards get merged by the overlaid BASE-tree copy, a HEAD
run's by HEAD's own copy. This is the same portability `sweepArms.ts`'s own
header already documents for the arm-definition file itself ("imports
nothing that exists on only one side of a refactor … runs unchanged at BASE
and at HEAD").

## The baseline is defined by these parameters

Everything in `sweepArms.ts` that shapes the input is part of the baseline's
identity: the arm list and their wind fields, the `{ hours: 3 }` override on
`short-horizon`, the settings deltas, **each arm's origin** (`Arm.originId`,
`harbors.json`'s `flensburg.snap` by default, `marstal.snap` for the three
#452 relaxation arms — added #452, PR #488: a PRE-#452 baseline's implicit
"the origin is always flensburg.snap" is no longer true of the file as a
whole, only of arms that omit `originId`), **each arm's boat** (`Arm.boatId`,
`DEFAULT_BOAT_ID`/`salona-45` by default, `salona-44-speedy-go` for the two
#653 arms — same shape as `originId`: a PRE-#653 baseline's implicit "the
boat is always DEFAULT_BOAT_ID" is no longer true of the file as a whole,
only of arms that omit `boatId`), `T0`, and `serialize()`'s replacer and
1-space indent. Change any one of them and previously recorded output is no
longer comparable. **Add an arm rather than editing one.**

## Recorded baseline — 2026-08-07, PR #450 (`dbcd519`)

**HISTORIC — not reproducible at current develop (predates at least #1322's
`pruneCellConfined`).**

**Covers only the ORIGINAL six arms (198 of the 363 plans this harness
produced at 33 harbours).** No BASE-vs-HEAD baseline has been recorded for the three #452
arms (`margin-zero`, `relaxation-dense`, `margin-extreme`) — that comparison
was deliberately deferred to whenever a real depth-relaxation change is
actually implemented, so it can be recorded against that change's own
merge-base rather than a `develop` that keeps moving underneath it (see PR
#450's description). Their DETERMINISM control is a separate matter and is
NOT outstanding: the 2026-08-20 nine-arm double run at `00a33ab` (above)
covers all three — but per that section's own caveat it does not discharge
the per-change BASE double-run, which must still be recorded against the
certifying branch's merge-base.

**Nor for the two #653 `salona44-*` arms** — same deferral, same reason: no
prior commit ever ran a Salona-44 arm, so there is no BASE side to compare
against. See "#653 sweep control" further up this file for the substitute
recorded instead: a self double-run of the eleven-arm harness on this
branch's own HEAD (a BASE run cannot produce a Salona-44 arm at all — that
is exactly why there is no BASE side above), plus a sha256-prefix
cross-check of the nine PRE-#653 arms against the `00a33ab`
determinism-control table above — the closest available equivalent to a
BASE-vs-HEAD comparison when the change under certification is "these two
arms are new." **COMPLETE** — see "#653 sweep control" above for the
results (363/363 byte-identical, 9/9 prefix match, plus the pre-fix-wave
caveat and its single-arm re-run control).

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
