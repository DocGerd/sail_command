---
name: sweep-closure
description: Use when deciding whether a SailCommand diff owes an `app/sweep/` #282 acceptance sweep. Mechanically derives the sweep's transitive import closure from its real roots and intersects it with the diff, instead of consulting the hand-maintained prose path list in CLAUDE.md. Use before running (or skipping) a sweep, and whenever a change touches routing, `app/src/types.ts`, `app/src/data/boats.ts`, or anything under `app/src/lib`/`app/src/routing`/`app/src/test`.
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
the closure from the sweep's actual import graph and checks a diff against
it mechanically.

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
script; either way it prints the verdict, the reason, and the **import
chain** from `app/sweep/sweepArms.ts`/`vitest.config.ts` down to the hit, so
the answer is auditable rather than asserted.

## Method

1. **Walk the import graph** from the sweep's two real roots —
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

2. **Intersect with the diff.** `git diff --name-only <base> [<head>]`,
   filtered to files the closure walk actually reached.

3. **Classify each hit.** The default is **OWED** — full stop. The one
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

**This tool over-reports. It never under-reports, with exactly one modelled
exception.** A false "owed" costs ~31 minutes of unnecessary solver time; a
false "not owed" ships an unverified routing change — those costs are not
symmetric, so the tool is built to fail toward the expensive-but-safe side.

Concretely:

- Any closure hit **outside** `app/src/data/boats.ts` is always OWED. No
  field-level modelling is attempted for `app/src/types.ts`,
  `app/src/routing/**`, `app/src/lib/**`, etc. — an edit anywhere in those
  files reports OWED even if, in a specific case, it happens to touch
  nothing that could move a route. That is deliberate: building real
  data-flow analysis for every closure file is out of scope for a NUDGE tool,
  and over-firing there is the safe direction.
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

If you need to extend the exception list (a new field, a new file), do it by
adding a new, independently-provable `classify*` function with its own
`selftest` positive/negative/mutation controls — not by widening the
`draftProvenance` pattern's scope.

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

`closure.mjs selftest` runs six checks with no repo mutation required
(synthetic boats.ts-shaped file pairs are compared under the OS tmpdir via
real `git diff --no-index`, never written into the repo):

1. `app/src/types.ts` (holds `DEFAULT_SETTINGS`) is in the closure → default
   OWED — the issue's documented too-narrow-list case.
2. `app/src/data/boats.ts` is in the closure at all (precondition for #3).
3. `app/src/components/AboutDialog.tsx` is **not** in the closure — the
   negative control: without it, a tool that answered OWED to everything
   would pass check 1 and look correct.
4. A `draftProvenance`-note-only edit → NOT OWED — the issue's documented
   too-wide-list case.
5. A `draftM` edit in the **same file** → OWED — proves the exception is a
   field-level carve-out, not "the whole file is exempt".
6. A `polarProvenance.note` edit → OWED — proves the exception was not
   silently generalised to a field CLAUDE.md warns has a different blast
   radius.

This script is **not** discovered by `ci.yml`'s `hook-selftests` job — that
job only scans top-level `*.sh` under `.claude/hooks/` and
`.github/scripts/` (`-maxdepth 1`), and this lives under `.claude/skills/`.
Run `selftest` by hand after editing `closure.mjs`.

## Out of scope

This skill decides *whether* a sweep is owed. It never runs one, and it does
not touch `app/sweep/`'s arm definitions or `compare.mjs` — see
`app/sweep/README.md` for actually running the harness once this says OWED.
