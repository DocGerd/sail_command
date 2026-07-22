# SailCommand Sea-State (Waves) in Routing — Design Addendum (#18)

**Status:** DRAFT for review (2026-07-22); design-only, implementation deferred to a
future session. **Relationship:** addendum to `2026-07-14-sail-command-design.md`, whose
§6 lists *"Currents/tides, wave data"* as out of scope (v1). This addendum brings **wave
(sea-state) effects** into scope and specifies them; **currents/tides remain out of scope**
(see §2). Where this document and the source spec conflict on wave/sea-state behavior, this
addendum wins; on all other domain behavior the source spec wins.

## 1. Goal

Make routes reflect the sea state. A boat's real speed in a seaway is lower than its
flat-water polar predicts (added resistance in waves), and crews have a comfort/safety
threshold above which they would rather not sail. This addendum adds, waves-only:

1. a **wave map overlay** (advisory display),
2. an optional **wave comfort limit** (a transparent, user-controlled routing constraint), and
3. a **wave speed-attenuation factor** in the isochrone cost (an honest, conservative,
   *labeled-estimate* performance correction).

## 2. Spike outcome — currents/tides are OUT (do not revisit under this issue)

A data-quality spike (2026-07-22, findings archived) evaluated the Open-Meteo Marine API for
the app's area (54.3–55.3°N, 9.4–11.0°E):

- **Currents dropped.** `ocean_current_velocity`/`_direction` are served, but at MeteoFrance
  SMOC **0.08° (~8 km)** resolution with the vendor's own documented caveat *"not suitable
  for coastal navigation."* Als Sound / the Little & Great Belt are narrower than one grid
  cell yet carry real 1–3 kn tidal streams; the near-zero readings there are a **resolution
  artifact**, not calm water. Importing them would be silently wrong exactly where currents
  matter most — a violation of this project's "never overstate" principle (the same principle
  that rejected bilinear depth resampling). Tides are cm-range and negligible here per the
  issue. **No current term is added.**
- **Waves are usable.** `wave_height`/`_period`/`_direction` (+ `wind_wave_*`, `swell_wave_*`)
  return non-null, plausible values (0.02–1.06 m across sample points) at ~5 km resolution.
- **No horizon-degradation contract needed.** The marine forecast horizon is 16 days (384 h),
  which **exceeds** wind's ~7 days (168 h). Wind remains the binding forecast horizon, so a
  wave grid always covers the whole routed passage.

## 3. Data model (`WaveGrid`, mirrors `WindGrid`)

Add a structured-clone-safe `WaveGrid` paralleling `WindGrid` (`app/src/types.ts`):

```
interface WaveGrid {
  lats: number[]; lons: number[]; timesMs: number[]; // ascending; hourly UTC
  waveHeightM: Float32Array;      // significant wave height Hs, metres
  wavePeriodS: Float32Array;      // mean/peak wave period, seconds
  waveDirFromDeg: Float32Array;   // meteorological: coming FROM, degrees true
  fetchedAtMs: number; model: string;
}
```

`Plan` gains an **optional** `waveGrid?: WaveGrid` (stored with the plan, exactly like
`windGrid` — a saved route must always render against the sea state it was computed from,
never a re-fetched one). Optional so **old saved plans without it still render** (waves simply
absent → attenuation off for that plan). Like `windGrid`, its buffers are **never transferred**
to the worker — cloned, so the saved plan's data stays intact.

## 4. Marine fetch (`openMeteo.ts`)

Add a marine fetch (`https://marine-api.open-meteo.com/v1/marine`, keyless, CORS-open,
browser-direct — no backend) that requests `wave_height,wave_period,wave_direction` for the
plan's bbox/time window, alongside the existing wind fetch, and assembles a `WaveGrid`.
Unit note: wave fields are already m / s / deg (no conversion) — the km/h pitfall applies only
to the dropped current field. If the marine fetch fails, the plan proceeds **wind-only** (wave
features gracefully absent), never blocking a route.

## 5. Speed-attenuation model (the crux — honest by construction)

**A per-leg multiplicative factor on the polar boat speed, applied at cost time — the base
polars are NEVER mutated.** Research finding: no public, validated, boat-specific
(Salona 45) added-resistance-in-waves curve exists; ORC's term (Gerritsma-Beukelman → Delft
Systematic Yacht Hull Series) is methodology-public but coefficient-proprietary, and
ship-scale methods (Kwon/Townsin-Kwon, STAWAVE-2) give only the shape and a rough magnitude.
So we use a **conservative, transparent, generic** factor, explicitly labeled an estimate —
not an invented boat-specific curve.

```
factor(Hs, μ) = max( 1 − k · (Hs / Lwl)² · g(μ),  floor )
appliedSpeed  = polarSpeed × factor
```

- `Hs` — significant wave height at the leg (m), sampled from the `WaveGrid`.
- `Lwl` — boat waterline length (per-boat constant; Salona 45 ≈ 12 m — **confirm exact value
  from builder specs at implementation**). Non-dimensionalising by `Lwl` encodes that
  resistance peaks near wave-length ≈ hull-length resonance (Delft-series convention).
- `μ` — wave **encounter angle** off the bow (0° = head seas, 180° = following).
- `g(μ)` — directional weight: **`g(μ) = 0` for `μ` abaft ~100° off the bow** (following /
  stern-quarter seas → *zero* penalty and **never a speed bonus** — no source supports a
  bonus), rising to `1` at head seas (`μ = 0`). Matches the ORC/Delft-tool angle-cutoff
  convention.
- `k` — small **conservative** coefficient (documented tunable constant; no tank data to
  justify an aggressive value).
- `floor` — caps the maximum penalty (≈ 0.70–0.75, i.e. ≤ 25–30% loss) so pathological sea
  states can't drive nonsensical routes.

**Anti-double-counting.** Open-Meteo wind-waves correlate with the same synoptic wind already
driving the TWA/TWS polar lookup, so a full penalty over-compounds at high wind. Mitigation:
keep `k` conservative and treat the exact coefficient as a **validation-gated** constant (§8);
the addendum deliberately errs toward *under*-penalising.

**Honesty measures (mandatory):**
- The applied factor is **exposed per leg** (a `waveFactor`/`waveHs` field on the leg, like
  the `shallow` flag and the motor-leg flag), so the UI can show it and the user can see the
  correction, never a hidden fudge.
- When attenuation is on, results are **labeled "wave-adjusted (estimated)"** (i18n).
- `k`, `floor`, and the `g(μ)` cutoff are **documented constants**, not magic numbers.
- **Default OFF until validated (§8) — decided.** Ship the toggle + per-leg exposure +
  validation harness first; flipping the default ON (still labeled "estimated") is a follow-up
  gated on a passing back-test.

## 6. Wave comfort limit (transparent constraint)

An optional `maxWaveHeightM` in `Settings`. Legs whose sampled `Hs` exceeds it are **flagged**
(reusing the #53 graceful-degradation pattern: a per-leg marker + a plan-level notice + map/
profile highlight), and the isochrone applies a **heavy cost penalty** to traversing them —
a *soft* avoid, not a hard forbid, so the router still returns a (flagged) route rather than
`no-route` when rough water is unavoidable. This is honest because it is user-set and fully
visible, independent of the estimated speed model in §5. **Decided (2026-07-22): soft
heavy-penalty, not a hard forbid** — the router must never strand the user at `no-route` when
rough water is unavoidable.

## 7. Map overlay & IndexedDB migration (shared infrastructure)

- **Overlay.** A wave layer (height shading + direction arrows) on the map, sampled at the
  **slider hour** (like wind barbs — the map is a moment; the two-sampling-clocks rule
  holds). This is the first of three backlog features adding MapLibre overlay layers (#7
  seamarks, #25 AIS) — introduce a **shared overlay-layer registry** (z-order + legend +
  i18n toggle) here so they compose rather than clobber.
- **Migration.** Storing `waveGrid` on `Plan` requires the IndexedDB schema to grow; `db.ts`
  is still v1 with no `upgrade()` path. Establish the **one reusable, non-destructive
  additive migration** here (also unblocks #54 per-boat and #19 trips): bump the DB version,
  add the optional field, and leave existing records intact (old plans keep rendering with
  their original data — a CLAUDE.md hard rule).

## 8. Testing & the validation gate (before default-on)

- **Unit** (`waves` factor): hand-derived literals (repo lesson #50) asserting: monotonic
  decrease in `Hs`; `factor = 1` when `Hs = 0`; `g(μ) = 0` (factor = 1) abaft the cutoff angle
  — **no speed bonus downwind**; `floor` respected at extreme `Hs`; factor ∈ `[floor, 1]`
  always (property test).
- **Integration:** a plan with a `WaveGrid` produces per-leg `waveFactor` and a wave-adjusted
  ETA; a plan without one is byte-identical to today.
- **VALIDATION GATE (blocks flipping default-on):** back-test against **≥ 1 real logged
  Flensburg-fjord passage** (GPS elapsed time vs. Open-Meteo Marine *archive* Hs for that
  window) to confirm the estimate is directionally right and conservative; **plus** a
  real-browser routing pass at extremes (calm vs. rough; head vs. following seas) confirming
  no nonsensical route or rig flips. This mirrors the hard-won lesson (#20) that synthetic-only
  tests missed a product-blocking solver bug that real data found in minutes.

## 9. Files (impl-time estimate)

`app/src/types.ts` (`WaveGrid`, `Plan.waveGrid?`, `Settings.maxWaveHeightM?`, leg
`waveFactor?`/`waveHs?`), `app/src/services/openMeteo.ts` (marine fetch), `app/src/lib/`
(new `waves.ts` factor + sampling), `app/src/routing/isochrone.ts` (apply factor + comfort
penalty in cost — **coordinate with the solver core; land after any other `solve()` change**),
`app/src/services/db.ts` (v1→v2 migration framework), map overlay components + shared layer
registry, `app/src/i18n/dict.de.ts`/`dict.en.ts` (both, parity).

## 10. Decisions (resolved 2026-07-22 review)

1. **Attenuation default — OFF until validated.** Ship the toggle, per-leg factor exposure,
   and the validation harness; flip the default on (still labeled "estimated") only after the
   §8 real-passage back-test passes.
2. **Comfort limit — soft heavy-penalty**, not a hard forbid (never strands the user at
   `no-route`).
3. **`Lwl` value** for the Salona 45 — confirm from builder specs at implementation (still open,
   an impl-time data fill, not a design fork).

## 11. Non-goals

Currents, tides (§2). Boat-specific tank-validated polars-in-waves (none public — the generic
factor is the honest substitute). This addendum is **design-only**; implementation (XL,
sharing the solver core with #67-landed and #54, and the migration/overlay infrastructure with
#54/#19/#7/#25) is a separate future session with its own plan.
