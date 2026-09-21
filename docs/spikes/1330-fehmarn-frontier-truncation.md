# #1330: Fehmarn slowdown after #1322 — frontier truncation, measured

**Verdict: CONFIRMED on the `breeze` arm, and resolved there on `develop` by
#1257.** On the four `breeze` Fehmarn solves, the slowdown #1330 records
against #1322 is `MAX_FRONTIER` truncation. The truncation was already live
before #1322. #1322's finer confined prune grid raised the peak frontier, so
the fixed 30 000 cap cut more rings. On `develop` the derived cap (#1257) no
longer binds on these solves, and the default-cap result equals the uncapped
result. The `no-comfort` and `salona44-breeze` rows of #1330 are not
measured here; see Scope.

## Method

- **Aperture.** Solo `solve()`, tier 1, on the `breeze` arm's inputs: the
  real committed mask and Salona 45 polars, Flensburg origin,
  `DEFAULT_SETTINGS`, uniform 12 kn / 225°, `gate = uniformGate(3.0)` and
  `comfortDepthM = 5.0`. This is not `planRoute()`: there is no merge pass,
  no relaxation and no retry tier.
- **Cases.** Destinations `burgstaaken` and `orth`, rigs genoa and fock.
- **Endpoints.** Origin `FLENSBURG` and destination `harbors.json` `snap`, each passed through `snapToNavigable(…, safetyDepthM)`, as in `realmask.repro.confinedDominance.test.ts`.
- **Trees.** Each tree's `app/src` and data were extracted with `git archive`:
  - `36d86a7`: #1322's base
  - `16c7c6b`: #1322's head, pre-#1257
  - `5b1b29b`: `develop`, post-#1257

  `mask.bin`, `harbors.json` and both polars are byte-identical across the
  three trees (sha256).
- **Counter.** No solver edit was made. `solve()` takes `maxFrontier` and
  reports the POST-cap `frontierSize` via `onProgress`. This holds at all
  three trees: the `next.slice(0, maxFrontier)` statement runs before the
  `onProgress` call. A ring whose `frontierSize === cap` counts as
  truncated. The count cannot separate "sliced to the cap" from "exactly
  equal to the cap". Every uncapped peak exceeds 30 000, so this does not
  affect the result.
- **Runs.** Each case ran twice per tree: at the tree's default cap, and with
  `maxFrontier: Number.MAX_SAFE_INTEGER` to get the true peak.
- **Evidence type.** Deterministic evidence only: ring counts, peaks, ETA,
  `costMs`, legs and distance. No wall-clock figures were taken (maintainer
  ruling, 2026-09-18). `costMs` does not exist at `36d86a7`, so cross-tree
  comparisons use ETA.
- **Harness.** A throwaway harness, not committed.

## Results

ETA and cost are minutes after departure. "Trunc" counts truncated rings.

| Case | Tree | Cap | Peak | Trunc | ETA | Cost | Legs | nm | Motor legs |
|---|---|---|---|---|---|---|---|---|---|
| burgstaaken genoa | `36d86a7` | 30 000 | 30 000 | 29 | 643.3 | — | 49 | 74.85 | 3 |
| | `36d86a7` | ∞ | 58 098 | 0 | 637.6 | — | 36 | 74.22 | 0 |
| | `16c7c6b` | 30 000 | 30 000 | 43 | 694.3 | 699.2 | 50 | 79.48 | 0 |
| | `16c7c6b` | ∞ | 62 482 | 0 | 636.1 | 639.6 | 43 | 74.11 | 0 |
| | `5b1b29b` | 95 333 | 62 482 | 0 | 636.1 | 639.6 | 43 | 74.11 | 0 |
| burgstaaken fock | `36d86a7` | 30 000 | 30 000 | 14 | 644.2 | — | 49 | 74.27 | 2 |
| | `36d86a7` | ∞ | 47 280 | 0 | 637.8 | — | 44 | 73.94 | 0 |
| | `16c7c6b` | 30 000 | 30 000 | 42 | 685.4 | 694.9 | 46 | 77.94 | 1 |
| | `16c7c6b` | ∞ | 57 985 | 0 | 640.1 | 643.1 | 36 | 73.99 | 0 |
| | `5b1b29b` | 95 333 | 57 985 | 0 | 640.1 | 643.1 | 36 | 73.99 | 0 |
| orth genoa | `36d86a7` | 30 000 | 30 000 | 21 | 598.1 | — | 48 | 69.51 | 2 |
| | `36d86a7` | ∞ | 58 050 | 0 | 588.0 | — | 36 | 68.49 | 0 |
| | `16c7c6b` | 30 000 | 30 000 | 36 | 632.0 | 641.1 | 39 | 72.51 | 1 |
| | `16c7c6b` | ∞ | 61 883 | 0 | 586.4 | 590.1 | 33 | 68.06 | 0 |
| | `5b1b29b` | 95 333 | 61 883 | 0 | 586.4 | 590.1 | 33 | 68.06 | 0 |
| orth fock | `36d86a7` | 30 000 | 30 000 | 15 | 596.8 | — | 40 | 68.69 | 1 |
| | `36d86a7` | ∞ | 46 705 | 0 | 590.7 | — | 35 | 68.44 | 0 |
| | `16c7c6b` | 30 000 | 30 000 | 31 | 635.1 | 642.8 | 44 | 72.04 | 1 |
| | `16c7c6b` | ∞ | 57 825 | 0 | 590.2 | 592.4 | 39 | 68.20 | 0 |
| | `5b1b29b` | 95 333 | 57 825 | 0 | 590.2 | 592.4 | 39 | 68.20 | 0 |

What the table shows:

- **Truncation was live at BASE.** `36d86a7` truncates 14-29 rings. The
  capped ETA is 5.7-10.1 min worse than the same tree uncapped, and the
  capped route adds 1-3 motor legs that the uncapped route does not have.
- **#1322 deepened it.** Uncapped peaks rise from 46 705-58 098 to
  57 825-62 482. Truncated rings rise from 14-29 to 31-43. The capped ETA
  is 45.0-58.2 min worse than the same tree uncapped.
- **BASE → HEAD at default caps** costs +33.9 (orth genoa), +38.4 (orth
  fock), +41.2 (burgstaaken fock) and +51.0 min (burgstaaken genoa). All four fall in or at the lower edge of the issue's +34-62 min range (orth genoa +33.9).
  That range was measured through `planRoute()` over several arms, so it is
  a comparable but not identical quantity.
- **The finer grid alone is roughly neutral.** HEAD uncapped vs BASE
  uncapped: −1.6, −1.5, −0.6 and +2.3 min (burgstaaken fock is the one
  worse case). HEAD uncapped beats BASE's capped result in all four cases.
- **`develop` resolves it.** On all four cases, `develop` at its default cap
  gives the same ETA, cost, legs and distance as `16c7c6b` uncapped, with
  0 truncated rings. It beats BASE's capped result by 4.1-11.7 min. The
  highest peak among these four solves is 62 482, against a cap of 95 333
  (1.53x); #1257's derivation records a higher worst case, 64 402
  (rudkoebing, Salona 44 genoa), which leaves 1.48x.
  The 62 482 and 61 883 peaks match `FRONTIER_PER_PRUNE_CELL`'s own derivation
  figures in `isochrone.ts`.

## Controls

- **The counter fires.** On the `develop` tree, burgstaaken genoa at
  `maxFrontier: 20 000` gives 73 truncated rings and ETA 739.8 min.
- **The cap alone accounts for develop's recovery.** The same case at
  `maxFrontier: 30 000` on the `develop` tree reproduces `16c7c6b`'s default
  row exactly: ETA 694.289, cost 699.166, 50 legs, 79.483 nm, and 43
  truncated rings on rings 34-116. On this route the `develop` tree differs
  from `16c7c6b` only by the cap value.
- **Negative control.** At `develop`'s default cap there are 0 truncated
  rings, and the result is byte-identical in every recorded field to the
  uncapped run.

## Scope

Only the `breeze` arm (Salona 45) was measured. #1330's Fehmarn rows also
come from the `no-comfort` arm (no comfort preference, so cost equals ETA)
and the `salona44-breeze` arm (Salona 44 polars); neither is measured here.

## Recommendation

No further action for the Fehmarn rows. The mechanism is confirmed. The
issue asked whether #1257 should land first; that question is moot, because
#1257 has shipped and removes the truncation on these solves.

Two residuals:

- **`salona44-relaxation/aaroesund`** (+16.5 min, the twelfth row) is not
  measured here. It is outside the Fehmarn ask, and it runs a different
  boat and relaxation path.
- **Headroom is not a guarantee.** #1257's derivation comment gives 1.48x
  over the worst family it found (64 402, rudkoebing Salona 44 genoa), and
  says itself that eight samples do not bound the population.

## Considered and rejected

- **Adding a truncation counter to `isochrone.ts`.** Unnecessary, because the
  post-cap `frontierSize` already exposes truncation. It would also move the
  file inside the #282 sweep closure and owe a sweep.
- **Measuring BASE vs HEAD wall-clock time.** Excluded by the 2026-09-18
  ruling. It also cannot name a mechanism.
- **Closing on the direction of #1257's sweep numbers alone.** Consistent
  with the hypothesis, but blind to the mechanism, which is what the issue's
  2026-09-18 comment asked to have measured.
- **Reverting or narrowing #1322's confined prune grid.** Uncapped, the grid
  is within ±2.3 min of BASE and beats BASE's capped result in every case.
  The time was lost to the cap, not to the grid.
- **Raising the cap further, or changing its basis.** Not needed: with
  `develop`'s cap there is no truncation on these solves.
