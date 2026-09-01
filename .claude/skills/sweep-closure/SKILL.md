---
name: sweep-closure
description: Use when deciding whether a SailCommand diff owes an `app/sweep/` #282 acceptance sweep. Mechanically derives the sweep's real input closure — its transitive import graph, UNIONED with the runtime harness/data/pipeline inputs an import walk cannot see — and intersects it with the diff, instead of consulting the hand-maintained prose path list in CLAUDE.md. Use before running (or skipping) a sweep, and whenever a change touches routing, `app/src/types.ts`, `app/src/data/boats.ts`, anything under `app/src/lib`/`app/src/routing`/`app/src/test`, `app/sweep/**`, `app/public/data/**`, or `pipeline/**`.
---

# Sweep closure: does this diff owe a #282 sweep?

`app/sweep/` is SailCommand's #282 acceptance harness — nine settings arms
across 33 harbours, run against the real committed mask and polars, whose
whole point is that a change meant to be presentational moves **no** route.
A single arm-set costs ~31 minutes unloaded; the required BASE double-run
control doubles that, and a BASE-vs-HEAD comparison triples it. Guessing
"owed" wrong burns ~90 minutes for nothing; guessing "not owed" wrong ships
an unverified routing change.

CLAUDE.md used to answer "does this diff owe a sweep?" from a hand-maintained
prose list of paths — and its own text said that was unsafe ("never a
remembered path list"), because the list was wrong in **both** directions:
too narrow (a `DEFAULT_SETTINGS` field edit in `app/src/types.ts` moves every
arm without touching any "obvious" path) and too wide (an edit confined to
`app/src/data/boats.ts`'s `draftProvenance` field touches a listed file yet
owes nothing, because the serialised `PlanResult` the sweep compares never
carries that field at all).

This skill replaces that list with `closure.mjs`, a script that **derives**
the closure from the sweep's actual import graph — unioned with a small,
individually-pinned set of declared path prefixes for the runtime
harness/data/pipeline inputs an import walk cannot see (see "Method" below)
— and checks a diff against it mechanically.

## Usage

```bash
# List the whole derived closure (for inspection).
node .claude/skills/sweep-closure/closure.mjs closure

# Is a specific file in the closure at all? (no field-level check — see below)
node .claude/skills/sweep-closure/closure.mjs files app/src/types.ts app/src/data/boats.ts

# The real question: does this diff owe a sweep?
node .claude/skills/sweep-closure/closure.mjs diff origin/develop           # base vs. working tree
node .claude/skills/sweep-closure/closure.mjs diff <merge-base> <head-sha>  # base vs. a specific head

# Verify the tool itself (positive/negative controls + mutation checks).
node .claude/skills/sweep-closure/closure.mjs selftest
```

`diff` exits non-zero when a sweep is owed, zero otherwise, so it can gate a
script; either way it prints the verdict, the reason, and (for an import-walk
hit) the **import chain** from `app/sweep/sweepArms.ts`/`vitest.config.ts`
down to the hit, so the answer is auditable rather than asserted. `diff`
internally uses `git diff --merge-base`, so passing a moving branch name
(`origin/develop`, the first line above) is safe: it diffs against the
ancestor the two refs actually share, not a raw two-dot tree comparison that
would widen as `develop` moves ahead (Minor, #729 — see "Failure direction"
below for what this does and does not fix).

## Method

1. **Walk the import graph** from the sweep's two real CODE roots —
   `app/sweep/sweepArms.ts` and `app/sweep/vitest.config.ts` — following
   every relative `import`/`export … from`/dynamic `import()` specifier
   transitively. Bare specifiers (`'vitest'`, `'node:fs'`, …) are external
   packages and are not walked further. This is what makes the closure
   *derived data* rather than a maintained list — re-run `closure` after any
   refactor and it reflects the current graph, not a stale memory of it.

   One edge is **not** discoverable this way and is hardcoded with a comment
   explaining why: `vitest.config.ts`'s `setupFiles: [resolve(here,
   '../src/test/setup.ts')]` builds that path at runtime via `path.resolve()`,
   never as a literal `import` string, so a static scanner is structurally
   blind to it. `EXTRA_EDGES` in `closure.mjs` is the place any future
   non-obvious runtime-constructed edge like this belongs.

2. **Union with `PATH_PREFIXES`** — three declared directories
   (`app/sweep`, `app/public/data`, `pipeline`) for inputs that are not
   `import` statements at all. **This union exists because the import walk
   ALONE was measured to under-report (#729 Blocker)**: it cannot reach
   vitest's real entry points (the nine `app/sweep/arm-*.test.ts` files,
   wired in only through `vitest.config.ts`'s `include: ['**/*.test.ts']` —
   an edge INTO `sweepArms.ts` that a walk FROM it can never traverse), nor
   any of `sweepArms.ts`'s runtime `readFileSync` reads of shipped data
   (`mask.bin`, `mask.meta.json`, `harbors.json`, `polars/*.json`) or that
   data's pipeline generators. Several of those paths are built from a
   variable at runtime, so re-deriving them statically isn't possible in
   general — the three prefixes name the directories those reads live under
   instead. Like `EXTRA_EDGES`, this is hand-maintained data; see "Failure
   direction" below for how each entry is kept honest.

3. **Intersect the union with the diff.**
   `git diff --merge-base --name-only <base> [<head>]`.

4. **Classify each hit.** The default is **OWED** — full stop, whether the
   hit came from the import walk or a `PATH_PREFIXES` match. The one
   exception is `app/src/data/boats.ts`'s `draftProvenance` field: a hunk
   confined entirely to an `interface DraftProvenance { … }` or
   `draftProvenance: { … }` span is **NOT OWED**, because that is
   structurally provable from the type system on disk today, not merely
   assumed (see `classifyBoatsTs`'s doc comment in `closure.mjs`):
   `BoatSnapshot` (the only shape a boat is denormalised into inside a stored
   `Plan`) doesn't declare that field, and `PlanResultOk`/`PlanResultError`
   carry no boat/request field **at all** — the sweep's serialised
   `PlanResult` never contains a boat snapshot in the first place, so nothing
   confined to that field can move a single compared byte.

## Failure direction — stated explicitly, as this repo's guard-asymmetry
convention requires for a NUDGE-class tool

**This tool is designed to over-report, not under-report, against the
UNIVERSE described in "Method" above (the import walk UNIONED with
`PATH_PREFIXES`) — with exactly one modelled exception.** A false "owed"
costs ~31 minutes of unnecessary solver time; a false "not owed" ships an
unverified routing change — those costs are not symmetric, so the tool is
built to fail toward the expensive-but-safe side.

**A prior revision of this file claimed the stronger, unconditional "never
under-reports" — that was FALSIFIED in review (#729, Blocker).** The
import walk alone missed the nine `arm-*.test.ts` files and every runtime
data/pipeline input (see Method step 2), so a diff confined to those
reported NOT OWED, exit 0 — for example editing an arm's target harbour plus
`canonicalize.mjs`, or a full `npm --prefix pipeline run mask` rebuild. The
`PATH_PREFIXES` union closes that specific, measured gap (re-verified
end-to-end against two real historical commits of exactly that shape — see
`closure.mjs`'s own commit history for the transcript). It is not a proof
that no further gap exists: `PATH_PREFIXES` is itself hand-maintained data,
same as `EXTRA_EDGES`, so state the failure direction as "over-reports
against the modelled universe", never as an unconditional guarantee.

Concretely:

- Any closure hit **outside** `app/src/data/boats.ts` is always OWED,
  whether it came from the import walk or a `PATH_PREFIXES` match. No
  field-level modelling is attempted for `app/src/types.ts`,
  `app/src/routing/**`, `app/src/lib/**`, `app/sweep/**`,
  `app/public/data/**`, `pipeline/**`, etc. — an edit anywhere in those
  files/directories reports OWED even if, in a specific case, it happens to
  touch nothing that could move a route (e.g. `app/sweep/README.md`,
  `pipeline/extract_basemap.sh`). That is deliberate: building real
  data-flow analysis for every closure file is out of scope for a NUDGE tool,
  and over-firing there is the safe direction. `PATH_PREFIXES` is
  deliberately WHOLE-DIRECTORY rather than a narrower per-file list, for the
  same reason — a future arm file, data asset, or pipeline generator is
  covered automatically rather than needing its own entry.
- `app/src/data/boats.ts`'s **`polarProvenance`** field (also present on the
  same object literals as `draftProvenance`, also copied into `BoatSnapshot`)
  is **deliberately not exempted**, even though it looks like the same shape
  of change. CLAUDE.md's own "`polarProvenance` and `draftProvenance` have
  DIFFERENT blast radii" bullet warns explicitly that a no-sweep argument
  cleared for one field must never be assumed to transfer to the other
  without independent verification. A `polarProvenance.note`-only edit
  therefore reports OWED under the default, not NOT_OWED by analogy. The
  `selftest` command's "narrow-scope-check" pins this on purpose — extending
  the exception to a new field needs the same structural proof
  `classifyBoatsTs` gives for `draftProvenance`, never a guess by analogy.
- A malformed or unmatched brace while locating a `draftProvenance`/
  `DraftProvenance` span is silently **dropped** from the safe-block list
  (never treated as safe) — if the tool can't be sure a span is what it looks
  like, the exception doesn't apply and the hit falls back to OWED.
- Every entry in `EXTRA_EDGES` and `PATH_PREFIXES` is hand-written data with
  NO compiler check that it stays accurate — CLAUDE.md's "a guard's DATA
  needs a twin, not just its detection logic" rule (the `SOLVER_LABELS`
  shape: stubbing the array a guard iterates can disable the guard while it
  keeps reporting success). `selftest` pins each entry individually with a
  HARDCODED expected path (never derived from either array) for exactly this
  reason — see "Testing this skill itself" below.

If you need to extend the exception list (a new field, a new file), do it by
adding a new, independently-provable `classify*` function with its own
`selftest` positive/negative/mutation controls — not by widening the
`draftProvenance` pattern's scope. If you need to extend `PATH_PREFIXES` or
`EXTRA_EDGES`, add a new hardcoded `selftest` pin for the new entry in the
same commit — an addition with no pin is exactly the shape that shipped the
Blocker this file records above.

## When the verdict is OWED — restating the constraints it is easy to lose

- Record the **BASE double-run control against the merge-base of the branch
  it will certify** — a moved `develop` does not automatically invalidate a
  prior sweep, but that exemption fails open, so re-run by default.
- **Never run a full sweep as a harness background task** — one was killed
  at ~58 minutes in a prior session (harness-version-dependent ceiling;
  re-check after any Claude Code upgrade). A single arm-set (~31 min
  unloaded) fits under it; the required double-run and a BASE-vs-HEAD
  comparison do not.
- **Detach** with `setsid` + `nohup`, and **report the `SC_SWEEP_OUT` path at
  detach time**, not on completion — an agent that dies mid-sweep takes its
  output path down with it, and a killed run and a finished one are
  otherwise indistinguishable from outside.
- Full rebuild spec and arm definitions: `app/sweep/README.md`.

## Testing this skill itself

`closure.mjs selftest` runs **15** checks with no repo mutation required
(synthetic boats.ts-shaped file pairs are compared under the OS tmpdir via
real `git diff --no-index`, never written into the repo) — count re-derived
from the script's own output, not hand-maintained here:

1. `app/src/types.ts` (holds `DEFAULT_SETTINGS`) is in the closure → default
   OWED — the issue's documented too-narrow-list case.
2. `app/src/data/boats.ts` is in the closure at all (precondition for #3).
3. `app/src/components/AboutDialog.tsx` is **not** in the closure — the
   negative control: without it, a tool that answered OWED to everything
   would pass check 1 and look correct.
4. `app/src/test/setup.ts` is in the closure — pins the `EXTRA_EDGES` datum
   by a HARDCODED path; mutation-checked (`EXTRA_EDGES = {}` reds this one
   check and none other, verified before this fix shipped).
5–12. Eight hardcoded pins, one per input the #729 Blocker review measured
   the import-walk-only version reporting `NOT_IN_CLOSURE` for:
   `app/public/data/mask.bin`, `mask.meta.json`, `harbors.json`,
   `polars/salona-45-genoa.json` (representative `polars/*.json`),
   `app/sweep/arm-marginzero.test.ts` (representative `arm-*.test.ts`),
   `app/sweep/canonicalize.mjs`, `compare.mjs`, and `pipeline/build_mask.py`.
   None of these eight is reachable via the import walk (they import FROM
   the walked closure, never the reverse), so a green run here is evidence
   specifically about `PATH_PREFIXES`, not a restatement of the walk.
   Mutation-checked: `PATH_PREFIXES = []` reds exactly these eight and none
   other.
13. A `draftProvenance`-note-only edit → NOT OWED — the issue's documented
    too-wide-list case.
14. A `draftM` edit in the **same file** → OWED — proves the exception is a
    field-level carve-out, not "the whole file is exempt".
15. A `polarProvenance.note` edit → OWED — proves the exception was not
    silently generalised to a field CLAUDE.md warns has a different blast
    radius.

This script is **not** discovered by `ci.yml`'s `hook-selftests` job — that
job only scans top-level `*.sh` under `.claude/hooks/` and
`.github/scripts/` (`-maxdepth 1`), and this lives under `.claude/skills/`.
Run `selftest` by hand after editing `closure.mjs`, and mutation-check any
NEW hardcoded pin the same way (stub the array it pins, confirm exactly that
row reds) before trusting it.

## Out of scope

This skill decides *whether* a sweep is owed. It never runs one, and it does
not touch `app/sweep/`'s arm definitions or `compare.mjs` — see
`app/sweep/README.md` for actually running the harness once this says OWED.
