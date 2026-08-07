# #282 acceptance sweep

Flensburg → all 33 harbours × 6 settings arms = **198 plans**, against the real
committed mask and polars, with every `PlanResult` serialised for byte-for-byte
comparison between two revisions.

Issue #282 makes this a **standing requirement**: the no-route cause is a
control input, so any change to how `solve()` *classifies* a failure can move
real routes. Run this before trusting such a change. A change that is only
meant to be presentational must move nothing.

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
identity: the six arms and their wind fields, the `{ hours: 3 }` override on
`short-horizon`, the settings deltas, the origin (`harbors.json`'s
`flensburg.snap`), `T0`, and `serialize()`'s replacer and 1-space indent.
Change any one of them and previously recorded output is no longer comparable.
**Add an arm rather than editing one.**

## Recorded baseline — 2026-08-07, PR #450 (`dbcd519`)

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
