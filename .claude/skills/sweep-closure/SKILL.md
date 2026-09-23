---
name: sweep-closure
description: Use when deciding whether a SailCommand diff owes an `app/sweep/` #282 acceptance sweep. Mechanically derives the sweep's real input closure — its transitive import graph, UNIONED with the runtime harness/data/pipeline inputs an import walk cannot see — and intersects it with the diff, instead of consulting the hand-maintained prose path list in CLAUDE.md. Use before running (or skipping) a sweep, and whenever a change touches routing, `app/src/types.ts`, `app/src/data/boats.ts`, anything under `app/src/lib`/`app/src/routing`/`app/src/test`, `app/sweep/**`, `app/public/data/**`, or `pipeline/**`.
---

# Sweep closure: does this diff owe a #282 sweep?

`app/sweep/` is SailCommand's #282 acceptance harness — every settings arm in
`app/sweep/armNames.ts` across every harbour in `harbors.json`, run against the real committed mask and polars, whose
whole point is that a change meant to be presentational moves **no** route.
A single arm-set cost ~31 minutes unloaded on the pre-#295 33-harbour set; the required BASE double-run
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

# Reuse a recorded run as BASE instead of re-running it? (#1337)
node .claude/skills/sweep-closure/closure.mjs reuse <recorded-sha-or-prefix> <base>

# Verify the tool itself (positive/negative controls + mutation checks).
node .claude/skills/sweep-closure/closure.mjs selftest
```

`diff` exits non-zero when a sweep is owed, zero otherwise, so it can gate a
script; either way it prints the verdict, the reason, and (for an import-walk
hit) the **import chain** from `app/sweep/sweepArms.ts`/`vitest.config.ts`
down to the hit, so the answer is auditable rather than asserted. `diff`
internally uses `git diff --merge-base --no-renames`, fixing two separate
Minors (#729): passing a moving branch name (`origin/develop`, the first
line above) is safe — it diffs against the ancestor the two refs actually
share, not a raw two-dot tree comparison that would widen as `develop` moves
ahead — and a renamed in-closure file (`git mv
app/sweep/canonicalize.mjs tools-canonicalize.mjs`) is reported as an add +
a delete rather than collapsed to just the destination, which would
otherwise drop the in-closure source path from `--name-only`'s output
entirely (see "Failure direction" below for what each flag does and does
not fix).

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
   vitest's real entry points (the `app/sweep/arm-*.test.ts` files — current
   set in `app/sweep/armNames.ts` and `app/sweep/README.md`'s opening line,
   never restated here — arm count went stale twice, see CLAUDE.md,
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
   `git diff --merge-base --no-renames --name-only <base> [<head>]`.

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
costs an arm-set of unnecessary solver time; a false "not owed" ships an
unverified routing change — those costs are not symmetric, so the tool is
built to fail toward the expensive-but-safe side.

**A prior revision of this file claimed the stronger, unconditional "never
under-reports" — that was FALSIFIED in review (#729, Blocker).** The
import walk alone missed the `arm-*.test.ts` files (current set in
`app/sweep/armNames.ts`) and every runtime
data/pipeline input (see Method step 2), so a diff confined to those
reported NOT OWED, exit 0 — for example changing which arm a file runs
(each `arm-*.test.ts` is one `runArm('<name>')` call — `arm-marginzero.test.ts`
carries no harbour of its own) plus `canonicalize.mjs`, or a full
`npm --prefix pipeline run mask` rebuild. The
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

## Reusing a stored BASE instead of re-running it (#1337)

A sweep is BASE x2 + HEAD — the BASE double-run is a determinism control, and
it recomputes artifacts already on disk whenever no merge since the last
recorded run touched the closure. `reuse <recorded> <base>` asks the SAME
closure tool that question, instead of a hand-checked path list: look up
`<recorded>` in the ledger below, diff it against `<base>` with the identical
`diff` logic above (same `--merge-base --no-renames`, same `PATH_PREFIXES`
union, same `draftProvenance` exception), and only report `REUSE` if that diff
is clean.

**Fails CLOSED, the opposite direction from `diff`.** `diff` over-reports
OWED (safe: costs solver time). `reuse` under-reporting would be unsafe — a
stale artifact standing in for a base that moved — so it reports `RUN BASE`
on ANY of: a closure-tool error, an unknown recorded run, an AMBIGUOUS SHA
prefix (matches more than one ledger entry) or one shorter than 7 characters,
a ledger entry with no artifact hashes recorded, `<recorded>` not an ancestor
of (or equal to) `<base>`, or an actual closure member changed between them.
`REUSE` is returned only when every check positively confirms the closure is
untouched.

`REUSE` is only as good as `PATH_PREFIXES`/`EXTRA_EDGES`: a runtime input
outside both, which the import walk cannot see, still gets `REUSE`. Apply
the same NOT-OWED scrutiny.

**Reuse replaces BOTH BASE arm-sets, never just one** — the recorded run's
artifacts stand in for the double-run control itself, licensed by the
STRONGER cross-machine/day/merge-base control CLAUDE.md's `app/sweep/`
section already documents (arm prefixes reproducing on a different machine,
day and merge-base beats a self double-run, which only proves a run
deterministic against itself). The HEAD run is still required — `reuse` never
substitutes for it.

**An OWED-but-waived merge may only be reused through with its byte-identity
argument recorded on the PR.** `reuse`'s own diff has no way to see a waiver
recorded in PR prose — a human call, not something this tool decides.

### The ledger: `.claude/skills/sweep-closure/recorded-runs.json`

**Maintainer ruling 2026-09-21: the ledger lives here, deliberately OUTSIDE
the sweep closure** (`.claude/skills/**` is not under `PATH_PREFIXES`), so
recording a table here never itself owes a sweep — unlike the pre-#1337
convention of recording it in `app/sweep/README.md`.

Schema — an object with one key, `runs`, an array of entries:

```json
{
  "runs": [
    {
      "sha": "<full 40-char commit SHA the recorded run was taken at>",
      "date": "YYYY-MM-DD",
      "arms": { "<arm-name>": "<sha256 prefix>", "...": "..." },
      "path": "<where the stored artifacts live>",
      "note": "<free text — e.g. which PR/session recorded this>"
    }
  ]
}
```

`sha` and `arms` are read by `reuse`; `date`/`path`/`note` are for a human
finding the actual stored files and are not validated. `reuse <key> <base>`
matches `<key>` against `sha` by exact value or case-insensitive prefix — a
bare prefix works like `git rev-parse`'s own abbreviated-SHA convenience, but
the failure mode differs: `git` errors on an ambiguous short hash, while a
prefix under 7 characters or one matching more than one ledger entry here
fails closed to `RUN BASE` rather than throwing — never the first/nearest
entry. #1361 (issue item 3): a too-short prefix, an ambiguous prefix, and a
prefix matching nothing each get their OWN reason string ("too short to
disambiguate", "ambiguous recorded run", "unknown recorded run") — they used
to collapse to one shared "unknown recorded run" message, which read a
genuine ambiguity as a plain no-match.

**The ledger is no longer empty.** PR #1363 recorded the first real entry
(sha `68a89342c5…`, 2026-09-21) from a sharded-vs-unsharded verification run.
The example in the schema above is still just an illustration — don't copy
its literal values — and a NEW entry still must not be fabricated; follow
"Recording an anchor" below. Read the ledger file directly for its current
contents rather than trusting a count or SHA prefix restated here — it
changes at every anchor recording.

### Recording an anchor

1. Record the exact commit SHA the arms actually ran on, and pick one that
   lands on `develop` — `reuse`'s own ancestor check (`git merge-base
   --is-ancestor <recorded> <base>`) requires the recorded `sha` to be an
   ancestor of (or equal to) any later `<base>` it is asked about.
2. Take each arm's hash from `run-sharded.mjs`'s `manifest.json` `arms`
   field (or the unsharded equivalent, `compare.mjs`'s own
   `sha256(raw).slice(0,16)` convention — both are the same 16-hex-char
   prefix) and cross-check the sharded and unsharded arm-sets agree before
   trusting either as the anchor, per PR #1363's own note field.
3. Never write an absolute or home-directory path into
   `recorded-runs.json`. The schema's `path` field is optional and
   unvalidated by `reuse`, but `.github/scripts/check-no-home-paths.sh` runs
   ungated in `ci.yml`'s `changes` job over every tracked file, and since
   #1286 both required fan-ins `app` and `e2e` need that job — a
   machine-specific path here reds both (happened at PR #1363, caught before
   merge). Omit `path` rather than filling it with a local output
   directory.
4. Any later `app/sweep/` edit — README included, since `app/sweep/**` sits
   inside `PATH_PREFIXES` — makes `reuse` answer `RUN BASE` again from that
   commit forward. Recording an anchor is not a one-time setup step; a
   fresh one is only worth recording when the sweep was just run for real
   and its result is worth another session reusing before the next
   `app/sweep/` edit lands.

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

`closure.mjs selftest` runs checks with no PERSISTENT repo mutation
(synthetic boats.ts-shaped file pairs are compared under the OS tmpdir via
real `git diff --no-index`; the rename check below spins up a REAL,
throwaway two-commit git repo under the OS tmpdir; nothing is ever written
into this repo):

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
16. A rename (`git mv app/sweep/canonicalize.mjs tools-canonicalize.mjs` in
    a real, disposable git repo) still lists the in-closure SOURCE path —
    the second #729 Minor: git's default rename detection would otherwise
    make `--name-only` print only the destination, silently dropping an
    in-closure file from the diff. Mutation-checked: removing `--no-renames`
    from `changedFiles`'s args reds exactly this row and none other.
17–25. `reuse`'s nine fail-closed/happy-path rows (#1337), against a real,
    disposable three-commit git repo (a base plus two divergent children)
    plus a synthetic ledger file written to disk (never this repo's own
    ledger): closure untouched → `REUSE`; a real closure member
    (`sweepArms.ts`, a ROOT) changed → `RUN_BASE`; a ledger with no `"runs"`
    array → `RUN_BASE`; a recorded SHA with no matching ledger entry →
    `RUN_BASE`; a matching entry with empty `arms` → `RUN_BASE`; `recorded`
    on a divergent side branch (not an ancestor of `base`) → `RUN_BASE`;
    `recorded` a DESCENDANT of `base` (misordered call) → `RUN_BASE`; an
    AMBIGUOUS SHA prefix matching two entries → `RUN_BASE`; a prefix under 7
    characters → `RUN_BASE`.
26. A TENTH row, against a separate disposable repo: the verdict is
    independent of whatever tree the CALLER has checked out — a closure
    member (outside every `PATH_PREFIXES` directory, so its membership is
    genuinely import-walk-dependent) changes only visibly from the
    `recorded`/`base` trees themselves, while the repo's own working tree is
    checked out on a THIRD, divergent commit that would give the wrong
    answer if the closure were read from disk instead of from those two
    commits → `RUN_BASE`.
    Each of the ten rows is mutation-checked individually (the guard on that
    row alone disabled, e.g. `owed.length > 999`, `if (false)` in place of
    the real validation, or reverting the ancestor check / the ref-checkout
    closure computation) and reds exactly the row(s) targeting that guard
    (the ancestor-check mutant reds both the side-branch and descendant rows).
27. `reuse` M9 pin: `computeReuseVerdict`'s own `unionClosures` call —
    unpinned by every row above. `base` deletes an EXTRA_EDGES target
    (`setup.ts`) present at `recorded` → `RUN_BASE`, never a false `REUSE`
    from `base`'s missing entry "winning" on argument order over
    `recorded`'s real one. M9 alone pins only the `closureAtBase` half of
    the union — `closureAtRecorded` alone passes every row up to and
    including M9 (#1361: measured empirically by stubbing the union to each
    half in turn).
27a. #1361 mirror of row 27: `base` (a child of `recorded`) ADDS an
    EXTRA_EDGES target absent at `recorded` → `RUN_BASE`, never a false
    `REUSE` from a `closureAtRecorded`-only walk. This pins the OTHER half
    of the union — together with row 27 it shows BOTH halves are
    load-bearing, not just one (mutation-checked: stubbing the union to
    `closureAtRecorded` alone reds only this row; stubbing it to
    `closureAtBase` alone reds only row 27).
27b. #1361: `withRefCheckout`'s add-failure path leaves no leaked
    `sweep-closure-ref-*` temp directory when `git worktree add` itself
    fails (a bad ref) — `mkdtempSync` runs before the `add` call, so a
    failure there must clean up the directory nothing ever registered with
    git. Mutation-checked: reverting the fix (an unguarded `add` call with
    no surrounding try/catch) reds only this row.
28. `diff`'s own checkout-independence (#1359/PR #1384), mirroring row 26
    for `reuse` (a closure member visible only from `base`/`head`, with a
    THIRD, divergent commit checked out) — built over its own disposable
    repo, not `initClosureRepo`.
29–33. Five more `diff`-side rows (#1359/PR #1384), all against
    `computeDiffVerdict` over disposable repos sharing one `initClosureRepo`
    helper: an EXTRA_EDGES deletion (`setup.ts`) on
    `head`, `base` independently deleting it too → `OWED` via the true
    merge-base's precedence, never via argument order; a head-ONLY member
    (imported and created only on `head`); a merge-base-ONLY member (`base`
    and `head` both independently drop the import) — one fixture
    discriminates BOTH dropping the merge-base term outright and computing
    it from `base` instead of the real `git merge-base`, since `base`'s own
    closure lacks the import either way; `base` adding an import after the
    fork point that `head` (forked earlier) only edits → `OWED` via
    `base`'s own third unioned term; and `head` omitted reading the
    WORKING TREE rather than the committed `HEAD` ref.

**Neither `npm --prefix app run typecheck` nor `npm --prefix app run
lint` cover this file at all** — the tsconfigs and `eslint src e2e sweep`
are scoped to `app/src`/`app/e2e`/`app/sweep`, and this skill lives under
the repo-root `.claude/skills/`. A green `app` CI job carries NO signal
about `closure.mjs`; treat `node --check` (syntax only) plus `selftest`
(behaviour) as the real gates for this file, and re-run both by hand after
any edit — this script is also **not** discovered by `ci.yml`'s
`hook-selftests` job, which only scans top-level `*.sh` under
`.claude/hooks/` and `.github/scripts/` (`-maxdepth 1`). Mutation-check any
NEW hardcoded pin the same way (stub the array/behaviour it pins, confirm
exactly that row reds) before trusting it.

## Out of scope

This skill decides *whether* a sweep is owed. It never runs one, and it does
not touch `app/sweep/`'s arm definitions or `compare.mjs` — see
`app/sweep/README.md` for actually running the harness once this says OWED.
The one-line pointer from `app/sweep/README.md` to the reuse rule above is
NOT added by this PR (#1337) — `app/sweep/**` is inside the sweep closure
itself, so editing it owes a sweep.
