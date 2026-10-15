# En-route sail-change routing

Status: decided 2026-10-15. Design of record: `docs/superpowers/specs/2026-08-10-multi-boat-design.md` §P, §R, §S.

## Problem statement

How might we plan EASY GO!'s passage with the sails actually aboard, choosing when to change sail en route, so the ETA is honest and the crew sees where a change pays?

## Direction

**Pre-trip release (~19 Oct): data and inventory only.**
- **EASY GO!'s own tables (§P).** The jib is tier B, from a sister hull's ORC Non-Spinnaker certificate. The genoa is tier C (the jib × the Salona 45 ramp), so the ★ stays suppressed and no new UI is needed.
- **Licence.** The derived tables follow the Salona 45 precedent (AUT 035/26); the committed ORC source records go beyond it and rest on the maintainer's acceptance. ORC is asked in parallel. It is not a gate.
- **Sail inventory (§R).** The user picks the aboard headsails, at most 2 (`MAX_HEADSAILS`). One aboard gives a one-sail plan.

**Post-trip.**
- **Native sail-state search (§S).** The set sail is node state. A change is a stationary transition priced by a fixed penalty per change type. It is not a tack-style step shortening, which cannot represent a change longer than a ring step.
- **Held plan first.** The hoisted sail's plan always comes first, and the sail plan is shown only when it beats it by more than the 60 s band.
- **Spinnaker.** The spinnaker lives in `BoatDef.downwindSails`, en route only, at TWA ≥ 110°, from the builder's ORC VPP table.
- **Derived pairs (genoa↔jib).** Swaps are planned, and hinted, only when the gain beats the penalties plus `U` plus a larger derived-pair margin (`OVERLAY_BOUND`). Change points and the ETA read "estimated (genoa derived from jib)". The router runs with the estimated genoa aboard. On EASY GO!'s current tables no swap clears that margin.
- **Crossover advisory (§S.11).** It ships with §S as the router-off view, under the same derived-pair rule.

**Defaults** (user-editable, not polar-derived):
- genoa↔jib swap 15 min;
- spinnaker set 5 min, douse 5 min;
- pole gybe 2 min;
- the same while motoring;
- spinnaker max 18 kn TWS;
- genoa change-down limit 18 kn TWS.

## Key assumptions, and what settled them

- **Estimated-sail crossovers are noise.** Settled: the whole-route ★ stays suppressed for tier-C pairs (§N.4); a change between derived pairs needs the larger `OVERLAY_BOUND` margin and carries a derived label (the amendment's cross-cutting decision 3).
- **A penalty as lost time models a change.** Kept, with the crew's minutes as defaults.
- **N× state fits the budget.** To be measured by node counts on the sweep arms, not wall time. The node ratio is predicted at ≈ 1.5. The worst routes are predicted to end `search-cut`, which shows the held plan.
- **A spinnaker reads "unusable" outside its range, never 0 kn.** Settled by `DownwindPolar.speedKnOrNull` returning `null`, and by gating candidates before any speed is read.
- **An advisory from independent per-sail solves is meaningless**, because the routes diverge. Settled: the advisory samples the hoisted route and evaluates the other polars there.

## Not doing (and why)

- **Wind- or sea-dependent change costs.** Fixed per-type penalties are what the crew asked for.
- **A post-hoc sail reducer on an envelope polar.** CLAUDE.md forbids post-processing that can violate constraints.
- **Bounded-change replans (N×K solves), or a budget raise.** Either blows the single plan budget.
- **Lifting the 2-headsail cap.** No boat has three headsails, and a third solve does not fit the budget.
- **Currents** (`docs/spikes/18-currents-source-quality-gate.md`), and any change to the 6.5 kn motor speed.
- **Calibration logging on the trip.**

## Open questions

- On EASY GO!'s current tables no genoa↔jib swap pays (§S OQ-1); would a gate-form change-down limit be the intended trigger?
- Does the genoa change-down limit act as a gate or as a suggestion (§S OQ-9)? What is the spinnaker's AWS ceiling (§R OQ-R7)?
- Is the spinnaker actually aboard EASY GO!, and what is its area (§P.12)?
- What will ORC reply on redistribution (§P.12)?
- SPEEDY GO!'s "built 2014" has no supporting source (§P.12).
