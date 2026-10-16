# SailCommand — Multiple boat types with per-boat foresail inventory (#54)

**Date:** 2026-08-10
**Status:** design approved; all open questions decided except OQ-6 (§J).
**Amended 2026-08-18 — see §N.** OQ-7 is superseded: tier-C estimated polars are authorised for two
Flensburg fleet models. §N states the scope, the estimator, the honesty surface and the accepted
costs, and classifies every §L row. Read §N before acting on §G.3 rule 2, §J OQ-7, §K's "reduces to
today", §L's `[OQ-7]` row, or §M.2 — each is changed or retired by it.
**Amended 2026-09-30 — see §O.** EASY GO! ships as a fourth catalogue entry at tier C (maintainer ruling, #1575). Read §O before acting on §N's EASY GO! text.
**Amended 2026-10-15 — see §P, §R, §S.** EASY GO! gets its own tables (jib tier B from a sister hull's ORC certificate, genoa tier C); the user picks the aboard headsails, capped at 2; a spinnaker is specified as en-route-only data (phase 2, with §S); en-route sail changes are designed for after the trip, including genoa↔jib swaps decided with a larger margin and labelled as derived. Read them before acting on §B's spinnaker exclusion, §E, §J OQ-3, §M.6, §M.8, §N.2, §N.6, §N.7 or §O.
**Relationship:** addendum to `2026-07-14-sail-command-design.md` (the source-of-truth design). Where the two conflict, this addendum wins. On everything else — the isochrone algorithm, the maneuver penalty, the #53 relaxation *structure*, #243's comfort preference, #254's sail-speed floor, #282's reason decoupling, #432's budget — the source spec and its existing addenda are unchanged.

The source spec fixes one boat — a Salona 45 with exactly two rigs — in six places, and the constants that fall out of that choice (`BOAT_DRAFT_M = 2.1`, `DEFAULT_SETTINGS.safetyDepthM = 3.0`) are load-bearing for a **safety** property established by PR #476 (#455) that #54 does not mention at all. This addendum supersedes those six places and specifies the generalisation: the data model, the safety invariant, the solver run budget, the persistence migration, and the polar-provenance rule that turns out to be the feature's real constraint. It does **not** design the settings/planner UI surface, which is a separate workstream.

Code citations anchor on the symbol or literal string; `~:NNN` line hints decay and are hints only.

## 0. Headline findings

1. **Three of the nine fleet models cannot use today's 3.0 m default safety depth** without breaking the #455 below-hull guarantee, and one of the three is explicitly Flensburg-based (§C.5).
2. **The binding worst case is not the UI minimum — it is #53 relaxation**, which reaches a gate of the boat's own draft and fires at DEFAULT settings with no user input at all. Left on a global constant it would relax a 2.30 m boat to a 2.1 m gate (§C.4).
3. **At default settings on the app's motivating route the real conservative floor is already 1.4 m against a 2.1 m keel** — a disclosed #452 residual that #54 must not deepen (§C.4).
4. **No ORC/IRC certificate and no published VPP polar was found for any of the nine fleet models.** #54 is not blocked by plumbing; it is blocked by not having the physics. This is why release 1 ships the machinery with the Salona 45 alone (§G, §J OQ-7).

---

## A. What this supersedes (quoted)

Every quotation was re-verified character-for-character against `docs/superpowers/specs/2026-07-14-sail-command-design.md` on 2026-08-10.

**A.1 — §1 Purpose** (`~:9-11`):

> Plan the fastest sailable route between two points in the Flensburg Fjord /
> Danish South Sea area for a **Salona 45** (standard main + genoa or fock),
> using real hourly wind forecasts.

→ *"…for a **boat the user selects from a catalogue**, using the foresail inventory that boat carries, and real hourly wind forecasts."*

**A.2 — §2 Decisions, "Obstacles" row** (`~:23`). The row continues `depth beyond the gate is a *preference*, not just a gate — comfort margin default 2.0 m (#243)`, which is **not** superseded:

> Land **and** depth aware; safety depth configurable, default 3.0 m (draft
> 2.1 m);

→ *"…safety depth configurable, **defaulting to the selected boat's draft plus the mask tolerance, quantised up to a decimetre** (3.0 m for a 2.1 m draft — see §C);"*

**A.3 — §2 Decisions, "Sail choice" row** (`~:27`, the complete cell):

> Router evaluates both rigs (main+genoa, main+fock) and recommends the faster; routes with recommendation

→ *"Router evaluates the foresails the user selected from the boat's inventory (**at most two — see §E**) and recommends the faster; routes with recommendation, **qualified by the boat's polar provenance tier (§G)**."*

**A.4 — §3.1 Polars bullet** (`~:58-62`). The bullet's trailing sentence, `A user-facing **performance factor** (default 0.90) scales polar speeds.`, is **not** superseded:

> **Polars** — two JSON speed tables (TWA × TWS → boat speed) for Salona 45:
> main+genoa and main+fock. Derived from ORC VPP data for the class (research
> task at implementation time; fall back to VPP estimates from comparable
> 45 ft cruiser-racers if no ORC certificate data is obtainable).

→ §G's per-boat, per-sail asset scheme **and its provenance tiers**. The superseded text already anticipates the fallback case; §G is that clause made explicit and machine-checked, because for the nine new models the fallback is currently the *only* available path.

**A.5 — §3.2 Routing engine, final sub-bullet** (`~:127`):

> Runs twice (genoa polar, fock polar); recommend faster rig; show both ETAs.

→ §E.

**A.6 — Addendum 2026-07-17 (#53), the draft floor.** Three phrases, quoted exactly. **Two of them wrap a line in the source** — the second across `~:257-258`, the third inside that addendum's **Acceptance** bullet — which defeats a naive single-line grep. Search for a distinctive fragment, not the whole phrase:

> floor = boat draft 2.1 m

(`~:250-251`)

> If requested ≤ 2.1 m, no relaxation is attempted and today's `unreachable` error stands.

(`~:257-258`)

> relaxation never gates below 2.1 m

(`~:297-298`)

In all three, the literal `2.1 m` becomes **the selected boat's draft**. The relaxation mechanism, its gate predicate (`depthRelaxationMayHelp`), its apples-to-apples single-gate property and its "never mutates `safetyDepthM`" contract are unchanged. §C.4 explains why this substitution is a safety fix and not a rename.

**A.7 — Not superseded, but flowing through.** `2026-07-30-motor-decision-rule-design.md` (#254) states the sail-speed floor as `max(motorThresholdKn, motorSpeedKn - sailPreferenceKn)`, computed from `Settings` values. Making `motorSpeedKn` and `maneuverPenaltyS` per-boat *defaults* changes the values fed into that formula and changes **nothing** in the formula or the solver. That spec needs no amendment; nor does #243's comfort preference, anchored to the requested `safetyDepthM` whatever its default came from.

---

## B. Scope

**In scope.** A boat catalogue; per-boat draft, motor-speed default, maneuver-penalty default and safety-depth default; a per-boat foresail inventory replacing the hardcoded `Rig` pair; polar provenance tiers and their user-facing consequence; the solver-run bound; the saved-plan migration; the per-boat generalisation of the #455 mask-tolerance safety invariant and its cross-artifact guard; per-boat pipeline validation and per-boat connectivity verification.

**Out of scope.** The settings/planner UI surface (separate workstream — this addendum specifies only what that UI must be able to *express*, plus the safety/honesty rules in §C.6, §C.7 and §G.3). Spinnakers and asymmetrics — white sails only as whole-route sails. *Amended 2026-10-15:* a downwind sail may exist as data in `BoatDef.downwindSails`, never as a standalone solve, and is planned en route only (§R, §S). Motorsailing — still sail XOR motor (#46 scope b). Reef states or sail combinations beyond main + one foresail. Per-boat wave, stability or leeway modelling.

---

## C. The safety coupling — the part #54 does not mention

### C.1 The bound, restated from the pipeline

`pipeline/build_mask.py` substitutes a bilinear reprojection for the conservative `Resampling.max` one only where the two agree within `TOLERANCE_M`, so **by construction, for every cell**

```
depth_blend  ≤  depth_max + T                 T = TOLERANCE_M = 0.9   (PR #476, #455)
```

The encoder then floors to decimetres, which only ever moves the shipped byte *shallower*, so the bound survives encoding. The app decides navigability at query time as `cellDepth ≥ safetyDepth`. Contrapositively:

```
navigable at gate G   ⟹   depth_max  ≥  depth_blend − T  ≥  G − T
```

**The conservative floor of any routable cell is `G − T`.** A property of the mask alone; it says nothing about any boat.

### C.2 Why today's numbers are an equality, not a coincidence

```
G − T  =  3.0 − 0.9  =  2.1  =  BOAT_DRAFT_M
```

`T = 0.9` was chosen (`docs/spikes/455-depth-mask-optimism.md` §5.1) as the value making that equality hold at the default gate — *"derived from the blend rule and the draft; it is not fitted to an outcome."* Measured effect: cells navigable at 3.0 m whose conservative reading is below the 2.1 m hull fell **924 → 0**. The equality is anchored to **one boat's draft**. That is exactly what multi-boat breaks.

### C.3 The general invariant

Let `d_b` be boat *b*'s draft and `G` any gate that boat may actually route at. The guarantee — *"no cell the router may plan through reads below the hull on the conservative channel"* — holds iff

```
G − T  ≥  d_b        ⟺        G  ≥  d_b + T
```

**`T` cannot be per-boat.** One mask ships, one blend produced it, one constant governs it. **Every per-boat lever is therefore on the `G` side** — the invariant can only be satisfied by moving the *gate*, never the tolerance. Write that into the code comment: a future reader will otherwise reach for `TOLERANCE_M` first.

**Gates must be decimetre-quantised, and quantised UP.** The mask encodes decimetres, so a gate of 3.15 m behaves *identically* to 3.2 m — every cell reading 3.1 fails it, every cell reading 3.2 passes. A non-decimetre gate is silently equal to its own ceiling; make that explicit rather than accidental, and never round down, which breaks the invariant by a decimetre.

```
defaultSafetyDepthM(b)  =  ceilToDecimetre(d_b + T)
```

**Three gates are reachable**, and the invariant must be evaluated at each. Today, for the Salona 45:

| Gate | Source | Value | Floor `G − T` | vs the 2.1 m hull |
|---|---|---|---|---|
| Default | `DEFAULT_SETTINGS.safetyDepthM` | 3.0 | **2.1** | holds, **zero margin** |
| UI minimum | `SAFETY_DEPTH_FIELD.min` (`OptionsPanel.tsx ~:36`) | 2.2 | **1.3** | 0.8 m **below** |
| #53 relaxed | `findRelaxedDepthM` searches `[BOAT_DRAFT_M, requested)` | **2.3 measured** | **1.4** | 0.7 m **below** |

Per §J OQ-1 the UI minimum becomes `d_b + 0.1`, so its floor is `d_b − 0.8` for every boat — a fixed 0.8 m below the hull, unchanged in character from today.

*Amended 2026-09-30 (#1575):* the UI minimum is `ceil₁₀(d_b + 0.1)` (`minSafetyDepthM`), so for a draft off a decimetre its floor is at most 0.8 m under the hull, not exactly 0.8 m. For EASY GO! (2.59 m) that is 2.7 m, a floor of 1.8 m, 0.79 m under the hull. The same applies to §C.5's "Deepest supportable draft" and to §J OQ-1.

### C.4 #53 relaxation makes the *effective* gate the one that matters — and it fires at DEFAULT settings

This is the interaction that most changes the risk picture, and neither #54 nor #452 states it.

The floor is `G_effective − T`, and `G_effective` is **not** the user's `safetyDepthM`. `findRelaxedDepthM` (`app/src/routing/relaxedDepth.ts ~:34`) searches `[BOAT_DRAFT_M, requested)`, and the app's own motivating route exercises it at stock settings: `realmask.repro.test.ts` pins Flensburg → Marstal at `DEFAULT_SETTINGS` to `expect(res.shallow!.requestedDepthM).toBe(3.0)` / `usedDepthM` ≈ 2.3 (`~:248-249`). So **at defaults, on the headline route, the real conservative floor is 2.3 − 0.9 = 1.4 m against a 2.1 m keel**. At relaxation's own floor it is `2.1 − 0.9 = 1.2 m` — the number the shipped disclosure copy states (§C.8 R5).

**(a) The relaxation floor MUST become the selected boat's draft.** Left as the constant `BOAT_DRAFT_M = 2.1` (`relaxedDepth.ts ~:9`), relaxation would relax a **2.30 m** boat to a 2.1 m gate — 0.2 m shallower than its keel before the mask tolerance is even applied, conservative floor 1.2 m, i.e. **1.1 m under the hull** — while the `shallow` banner reports the relaxation as if it were the Salona's. The single most dangerous shortcut available in this feature, and a one-line-looking change that is not a rename.

**(b) The violation is exactly `T` deep at the floor, for every boat, always.** Setting the relaxation floor to the draft makes its conservative floor `d_b − T` by definition — 0.9 m under the hull, invariant across the fleet, neither worse for a deeper boat nor better for a shallower one. It is disclosed today (every such leg is `shallow`-flagged and bannered by #53) and stays disclosed. **It is #452 territory, not #54's to fix** — but #54 must not deepen it, and (a) is what prevents that.

*Amended 2026-09-30 (#1575):* for a draft off a decimetre the relaxation floor is `ceil₁₀(d_b)`, so the violation is at most `T`, not exactly `T`. EASY GO! (2.59 m, floor 2.6 m) reaches a conservative floor of 1.7 m, 0.89 m under the hull (§O). The same applies to §C.5's 'Deepest supportable draft' (relaxation floor `ceil₁₀(d) − 0.9`) and to §C.8's arithmetic-precision paragraph, where Math.round breaks 'at most `T`', not 'exactly `T`'.

**(c) A useful structural consequence — which DEPENDS on §C.8's ceiling rule.** With the relaxation floor quantised as `ceil₁₀(d_b)` and the default gate as `ceil₁₀(d_b + T)`, the window `[ceil₁₀(d_b), ceil₁₀(d_b + T))` is **exactly `T` wide for every boat** — nine decimetre candidates at `T = 0.9`, identical to today's `[2.1, 3.0)` — because `T` is itself a whole number of decimetres. Under `Math.round` it is not: a 1.73 m draft gives a 0.97 m window and **ten** candidates, a 2.25 m draft 0.95 m. Probe counts and #53's progress reporting are unchanged for every boat **only under the ceiling rule**.

### C.5 The fleet, with real numbers

Required gate = `ceil₁₀(draft + 0.9)`. **Two different margins matter here and they are not the same number**, so the table gives both — conflating them understates the Bavaria's shortfall by a third:

- **Floor margin** = `2.1 − draft` — where the keel sits against the 2.1 m conservative floor that today's 3.0 m gate actually delivers.
- **Gate deficit** = `3.0 − required gate` — how far today's default gate falls short of what the boat needs. A **breach** is a negative gate deficit.

They coincide wherever `draft + 0.9` lands exactly on a decimetre and diverge where the ceiling rounds up; 1.73 m and 2.25 m are the two such rows here.

> **Provenance.** Every draft below comes from **outside this repository** — a research pass cross-checking each figure against a second independent manufacturer source. The repo contains exactly one draft (`BOAT_DRAFT_M = 2.1`) and no fleet data of any kind. These are **inputs to be re-verified per hull, and per keel variant, before that boat ships** (§J OQ-6, §M.1). §C's arithmetic is correct whatever they turn out to be.

| Model | Boat(s) | Draft | Required gate | Floor margin | Gate deficit | Flensburg-stated? |
|---|---|---|---|---|---|---|
| Jeanneau Sun Odyssey 519 | RUBIN, TOPAS | 1.73 | 2.7 | +0.37 | +0.30 | mixed |
| Elan Impression 45 | BARRACUDA | 1.90 | 2.8 | +0.20 | +0.20 | mixed |
| Elan Impression 444 | PIRANJA | 1.90 | 2.8 | +0.20 | +0.20 | **yes** |
| Beneteau 50.5 | QUEEN F. | 2.00 | 2.9 | +0.10 | +0.10 | no (Mallorca) |
| Beneteau Oceanis 473 | SPIRIT, ANDROMEDA, SAPHIR | 2.10 | **3.0** | **0.00** | **0.00** | no (Med/Split) |
| Salona 44 | SPEEDY GO!, EASY GO! | 2.10 | **3.0** | **0.00** | **0.00** | **yes** |
| Bavaria Cruiser 51 | KARIBU | 2.25 | **3.2** | −0.15 | **−0.20 breach** | unstated |
| Beneteau First 47.7 | SKIATHOS, SUNRISE | 2.30 | **3.2** | −0.20 | **−0.20 breach** | no (Atlantic/Med) |
| Grand Soleil 46 | MARIN | 2.30 | **3.2** | −0.20 | **−0.20 breach** | **yes** |

*Amended 2026-09-30 (#1575):* the Salona 44 row's 2.10 m is the standard keel. EASY GO! carries the deep keel (found 2026-08-18, §N.2) and ships at 2.59 m, gate 3.5 m (§M.8, §O).

**Three models breach today's default gate**, and **Grand Soleil 46 is explicitly Flensburg-based** — the breach is not confined to boats that would be deprioritised on location grounds anyway. A per-boat default is therefore not a tidiness improvement: without it, three of nine models ship a silent below-hull exposure of exactly the class #455 closed.

**Two models sit at exactly zero margin** (Oceanis 473 and Salona 44, both 2.10 m) — the same *shape* of fragility #245 §2.3 and #455 §3.4 record for `aabenraa` and `augustenborg`: a quantity that passes its test with 0.0 m to spare, so any decimetre anywhere moves it. Different quantities (there a harbour snap cell against its gate, here the mask floor against the hull), same treatment: report the margin, never rely on a binary pass (§C.8 R8).

**Deepest supportable draft.** At the 3.0 m default gate, `d ≤ 3.0 − 0.9 = 2.10 m`. At a `d + 0.1` UI minimum the floor is `d − 0.8` for every `d`, so **no setting the user can select protects any boat** — true today for the Salona 45, and it does not improve for anyone; the relaxation floor at `d − 0.9` is deeper still. Say this plainly in the disclosure copy.

**The Salona 44 trap.** Its 2.10 m draft coincides *numerically* with `BOAT_DRAFT_M = 2.1`, which is the **Salona 45**'s. Different model, different hull, different polar. A catalogue entry must state its own literal draft and never reference the old constant; a reader who sees "Salona" and "2.1" together will otherwise conflate them, and a later change to one will silently move the other.

**Keel variants make a model-keyed record insufficient.** Several models ship in more than one keel: the First 47.7 also at **2.8 m** (racing → a 3.7 m gate), the Oceanis 473 shoal at **1.70 m** (→ 2.6 m), the Elan 444 shoal at **1.60 m** (→ 2.5 m). Draft is the safety-critical field and it is a property of the individual hull, not of the model name — which is what §J OQ-4 decides.

### C.6 The connectivity ceiling — the ceiling that actually binds

Arithmetically the invariant is satisfiable at any draft by raising the gate. Three ceilings bound how far that goes; only the third binds, and it is **not derivable from anything in the repository**.

| Ceiling | Derivation | Deepest draft |
|---|---|---|
| Field range | `SAFETY_DEPTH_FIELD.max = 10`; need `G ≥ d + 0.9` | `d ≤ 9.1 m` |
| Mask encoding | bytes encode 0.1–25.4 m, `255 = "≥ 25.4 m"` (`MaskMeta.encoding`, `depthInfoM().capped`) — a gate above 25.4 m is unsatisfiable in principle | `d ≤ 24.5 m` |
| **Connectivity** | see below | **`d ≤ 2.10 m` on today's evidence** |

`pipeline/verify_mask.py` verifies harbour connectivity at exactly **one** gate — `DEFAULT_GATE_DEPTH_M = 3.0` (`~:75`) — with two per-harbour exceptions *below* it (`CONNECTIVITY_EXCEPTIONS_M ~:90`: `marstal` 2.0 m, `augustenborg` 2.8 m) and five `KNOWN_DISCONNECTED` entries (`~:109`). Navigability is monotone in the gate: the navigable set at a higher gate is a strict subset. So every harbour verified at 3.0 m may drop out at any higher gate, and **nothing in this repository has measured where.** Since `G_b = ceil₁₀(d_b + 0.9)`, the only drafts whose derived default gate has actually been verified are `d ≤ 2.10 m` — and the three deepest fleet models all need a deeper one.

This is not a claim that the mask cannot serve them; it is a claim that it is unmeasured. Therefore:

- **`verify_mask.py` must run its harbour scan at every catalogue boat's derived default gate**, reporting per-boat connected / exception / disconnected sets. `CONNECTIVITY_EXCEPTIONS_M` and `KNOWN_DISCONNECTED` become **per-boat-gate aware**: an exception justified against a 3.0 m gate says nothing about a 3.2 m one. (#455 §3.4 already records these constants as *tolerance*-coupled; this makes them *gate*-coupled too.)
- **A harbour dropping out at a deeper boat's gate is CORRECT.** A 2.30 m keel genuinely cannot enter a 2.0 m basin; the failure to prevent is *silently offering* it. `harbors.json`'s snap points are documented as *"guaranteed-navigable"* — guaranteed at the 3.0 m verify gate, an implicit Salona-45 qualifier. **#1135 Q6 resolved this**: the picker marks unreachable harbours per boat instead of failing at plan time with `snap-failed-destination` — the entry stays selectable and carries a marker, never disabled, and the per-(boat, harbour) state is derived at runtime (`app/src/lib/harborReachability.ts`, #1290), not stored in the harbour list.
- **No boat ships without a `verify_mask.py` run at its own derived gate**, and any boat deeper than 2.10 m needs that run *before* its catalogue PR is reviewable (§J OQ-6).
- **Worked example, to be confirmed by a real run.** `verify_mask.py`'s `marstal` entry comments *"Reconnects at gate <= 2.3 m"*. A 2.30 m boat's relaxation window is `[2.3, 3.2)`, so it can just barely reach Marstal at 2.3 m — conservative floor 1.4 m against a 2.30 m keel. The First 47.7's 2.8 m racing variant could not reach it at all. Derived from the script's comment, **not** from a run; illustrative until measured (§M.2).

### C.7 Boat switching and a stored safety depth

`Settings` is a single global persisted record, and boat selection changes the valid range of `safetyDepthM`. Rule:

> On boat selection, if the stored `safetyDepthM` is below the new boat's **default** gate `defaultSafetyDepthM(b)`, **clamp it up to that default, persist the clamped value, and tell the user it changed.**

**Amended by #1135 Q4** (shipped in `clampSettingsToBoat`, #1293): the target is the boat's DEFAULT, not its minimum. Keeping a stored depth in the minimum-to-default band across a boat switch is not intended — a switch raises it, never lowers it.

This deliberately differs from `usePersistedNumber`'s contract (#355), where a bounds change alone leaves the raw stored value untouched. That asymmetry is right for a panel width and wrong here: per this repo's guard-asymmetry rule the uncertain path must fail toward the expensive-but-safe direction, and a silently retained below-default gate is the cheap-and-dangerous one. **Never clamp down on a boat switch.**

### C.8 Generalising the #455 drift guard

`app/src/test/maskTolerance.test.ts` (PR #481) asserts three values, two of which encode one boat's arithmetic. Quoted exactly, because an earlier revision of this addendum misquoted the third:

```ts
expect(readToleranceM()).toBe(0.9);                                            // ~:83  survives
expect(round1(DEFAULT_SETTINGS.safetyDepthM - toleranceM)).toBe(BOAT_DRAFT_M); // ~:93  one boat
expect(round1(BOAT_DRAFT_M - toleranceM)).toBe(1.2);                           // ~:108 one boat
```

Note what the third is: the **relaxation** floor `draft − T = 1.2`, *not* the UI-minimum floor `2.2 − 0.9 = 1.3`. That test's own comment records the UI-minimum form as *"the earlier, WRONG version of this test and of the disclosure copy"*, because relaxation reaches lower than any value a user can type. Carry that correction forward; do not re-derive the discarded version.

The generalised guard must assert:

- **R0 (unchanged).** Read `TOLERANCE_M` out of `pipeline/build_mask.py` with the existing line-anchored regex and the existing **fail-closed** `expect(match, …).not.toBeNull()` *before* any value comparison. Boat-independent; its rationale (a regex that silently stops matching must red loudly — the #223 `String.replace` class) is unchanged.
- **R1 — the non-vacuity twin.** Every row below iterates the catalogue, so a catalogue stubbed to `[]` leaves the whole guard green (#411's *"a guard's DATA needs a twin"*). Assert the catalogue's boat-id list equals a **hand-written expected list in the test file**, never one derived from the catalogue. Record the discriminating experiment in the header: perturb production alone → 1 row reds; perturb the test's own table → 2 rows red.
- **R2 — pin the METHOD.** For every boat, `defaultSafetyDepthM(b) === ceilToDecimetre(b.draftM + T)`. Asserting the derivation rather than a value is what lets a future reader run it backwards.
- **R3 — the invariant as a corollary.** For every boat, `defaultSafetyDepthM(b) − T ≥ b.draftM`. Reds if anyone hand-types a default.
- **R4 — the relaxation floor is per-boat.** For every boat, the relaxation search floor equals `b.draftM`, not a module constant. This is §C.4(a) and the assertion that would catch a 2.30 m boat relaxing to 2.1 m. **The single highest-value row in this table.**
- **R5 — the disclosure twin.** For the selected boat, the About-dialog copy states that boat's own numbers: `T`, its derived default gate, its draft, and its relaxation floor `b.draftM − T` (today 0.9 / 3.0 / 2.1 / **1.2**). The existing test already checks all four via `containsMeasurement(text, …, 'en'|'de')` in **both** dictionaries (`~:120-132`); keep both languages. Per §J OQ-2 the copy is parameterised by the **selected** boat, never a catalogue-wide worst case.
- *Amended 2026-09-30 (#1575), R4 and R5:* EASY GO!'s 2.59 m is the first catalogue draft off a decimetre. R4's search floor is `ceil₁₀(b.draftM)` = 2.6 m, not `b.draftM`; R5's floor is `relaxationFloorM(b) − T` = 1.7 m, not `b.draftM − T` = 1.69 m. `depthMaskCaveatVars` (`app/src/lib/depthDisclosure.ts`) already uses `relaxationFloorM(b) − T`. §C.4(c).
- **R6 — the reduces-to-today anchor.** The Salona 45 row still reads `draftM 2.1`, `default 3.0`, `floor 2.1`, `relaxation floor 1.2`, as literals. Catches a refactor that generalises the arithmetic *wrongly* even when R2–R5 are self-consistent.
- **R7 — range sanity.** For every boat, `b.draftM + T ≤ SAFETY_DEPTH_FIELD.max`, else the derived default sits outside its own input's range and the setting is silently unreachable.
- **R8 — zero-margin visibility.** Report (not fail) every boat whose `defaultSafetyDepthM(b) − T − b.draftM` is 0.0, so §C.5's Oceanis 473 / Salona 44 cases are visible rather than merely passing.
- **R9 — the gap this guard still cannot close.** The test reads `T` from the pipeline *source*; it never establishes that the committed `mask.bin` was *built* with that value — edit the constant without regenerating and every row stays green. Recommend `build_mask.py` write `toleranceM` into `mask.meta.json` (which already carries optional provenance fields `encoding`, `verticalDatum`, `sources`, declared optional and display-only on `MaskMeta`, `app/src/types.ts ~:288`) and the guard assert `maskMeta.toleranceM === T`, converting a source-level claim into an artifact-level one. Strictly outside #54, but the same cross-artifact class, and multi-boat raises the stakes.

**Arithmetic precision — do not use floating-point equality.** Measured 2026-08-10 in node: `3.0 - 0.9 === 2.1` is exactly `true`, but `2.1 - 0.9` is `1.2000000000000002` and `2.2 - 0.9` is `1.3000000000000003`. PR #481 already handles this — every row above goes through its `round1` helper, and `findRelaxedDepthM` carries a `1e-9` nudge for the same reason. **Do R2–R8 in integer decimetres — but quantise a DRAFT with a CEILING, never `Math.round`.** Use `ceil₁₀(x) = Math.ceil(x * 10 − 1e-9) / 10`. `relaxedDepth.ts`'s existing `Math.round(draftM * 10)` is safe only because today's single draft already sits on a decimetre; it does **not** generalise. Measured: `Math.round(1.73 * 10) === 17`, so a 1.73 m boat's relaxation floor would become a **1.7 m gate under its own 1.73 m keel** — conservative floor 0.8 m, i.e. 0.93 m under the hull, and §C.4(b)'s "exactly `T` deep for every boat" would be false. That is §C.4(a)'s shortcut re-entering through the rounding rule two sections after it is named, which is precisely why §C.3 says quantise **up, never down**. The one exact-equality case is luck that does not generalise across a fleet. The pipeline has the same family of trap on the other side of the boundary: #455 §0 measured that quantising the elevation field in float64 rather than float32 changes 330 of 5,280,000 mask bytes.

### C.9 Mask regeneration is NOT part of this feature

`TOLERANCE_M` does not move, the blend does not move, `mask.bin` does not move. No `app/sweep/` #282 run is required *for the mask*. (One is still recommended for §E's solve-order plumbing — see §K.)

---

## D. What must become per-boat

An index into the sections that specify each row, not a second statement of the rules.

| Thing | Today | Becomes | Spec |
|---|---|---|---|
| `BOAT_DRAFT_M` (`relaxedDepth.ts ~:9`) | `2.1`, doc-commented *"Salona 45 draft"* | `boat.draftM` — **safety-critical** | §C.4(a) |
| `DEFAULT_SETTINGS.safetyDepthM` | `3.0`, hand-typed | derived `ceil₁₀(draftM + T)` | §C.3 |
| `SAFETY_DEPTH_FIELD.min` (`OptionsPanel.tsx ~:36`) | `2.2` | `draftM + 0.1` per boat | §J OQ-1 |
| `Settings.motorSpeedKn` default | `6.5` | per-boat default, still user-tunable | §F.2 |
| `Settings.maneuverPenaltyS` default | `45` | per-boat default, still user-tunable | §F.2 |
| `Rig` / `RIG_ORDER` (`types.ts ~:6,~:19`) | closed `'genoa' \| 'fock'` union | catalogue-derived `SailId` | §F.3 |
| Polar assets | `polar-genoa.json`, `polar-fock.json` | per boat, per sail | §G |
| `build_polars.mjs` sanity anchors | Salona-45 magic numbers | per-boat, fail-closed | §H |
| `verify_mask.py` gate | one gate, `3.0` | per-boat derived gates | §C.6 |
| About-dialog depth disclosure | one static string | parameterised by selected boat | §C.8 R5 |
| **`TOLERANCE_M`** | `0.9` | **stays global — cannot be per-boat** | §C.3 |
| `Settings.motorThresholdKn` | `2.5` | **stays global** — about water, not hull | §F.2 |

---

## E. Bounding the solver run count

**N is capped at 2 comparison sails per plan** (§J OQ-3). The boat may carry any number of foresails; the user picks which two to compare. *Amended 2026-10-15 (§R):* the user picks the aboard headsails, and the aboard set is the compared set, at most `MAX_HEADSAILS = 2` this release. A post-trip sail plan (§S) is not a comparison.

### E.1 Why 2 is the cap

At a cap of 2, **no existing invariant moves**:

- **The budget arithmetic is untouched.** `PLAN_BUDGET_MS` (`app/src/routing/workerClient.ts`; `120_000` when this was written, raised since (#1147, #1331) — read the constant) stays a single plan-level deadline, instantiated once per plan in `protocol.ts`, checked at isochrone ring entry and once before the #53 BFS probes; the client deadline stays `budget + 15 s` grace so the solver wins the race. Up to four tiers still fire (#243 preference on/off × #53 requested/relaxed gate).
- **`RigRecommendation` stays binary.** `compareRigs` and `RigRecommendation = {decided|tie|moot}` (`types.ts ~:157`) need no semantic change — only renaming and a shift from two named fields to a two-element list.
- **#324's second-rig map overlay stays legible.** `sc-route-alt-sail` / `sc-route-alt-motor` is intrinsically binary: "the other rig, dashed at 0.45 opacity" has no N-way reading.
- **The progress readout needs no i18n change.** `'Calculating route… sail {index} of {total} ({rig})'` is already parameterised; only the array it counts over changes.

It is also the pairwise question a skipper actually asks.

### E.2 What raising the cap would require

Recorded so a future N > 2 does not rediscover it. Two things break, neither a performance problem:

1. **Order starvation becomes a correctness problem.** A shared deadline plus a fixed sequential solve order systematically starves the sails last in the order. At N = 2 that asymmetry is invisible; at N = 5 the recommendation could be decided by solve order and presented as a speed finding. Raising `PLAN_BUDGET_MS` with N is rejected (§L); a per-sail sub-budget `PLAN_BUDGET_MS / N` fixes the fairness and risks failing routes that solve today (§L).
2. **`tie` and `moot` stop being well-defined.** `tie` among N results has at least two defensible readings (the best two inside `RIG_TIE_BAND_MS`? all of them?) and `moot` has three.

### E.3 Specification

- **The plan's selected sails are an ordered list on `PlanRequest`**, and that list — not a module constant — is the solve order. `RIG_ORDER` (`types.ts ~:19`) is deleted. Today's order comes from `runBoth` (`planRoute.ts ~:365`), which evaluates `genoa` then `fock` as two **named object-literal properties, not a loop** — synchronous, no interleaving. The #340 guard generalises from *"observed first-seen order equals `RIG_ORDER`"* to *"…equals `request.sailIds`"*, still recorded into an **array** (deliberately not a `Set`, which is order-blind).
- **Keep the readout's documented imprecision.** "sail i of N" numbers *sails within a tier*, not *solves within a plan*, so a four-tier plan legitimately shows "sail 1 of 2" up to four times.
- **Budget exhaustion partway through is a PARTIAL result, not a failure** — today's semantics, generalised. If one sail solves and the other returns `budget-exhausted`, `assemble` is still reached (it needs only *one* non-null result) and returns `status: 'ok'` with the failed sail's `'search-budget-exceeded'`. Each completed sail carries its result; each unstarted or aborted sail carries `search-budget-exceeded`. The recommendation is computed over the completed set only, and the UI must state the comparison was incomplete rather than presenting a one-sail "recommendation" as a comparison.
- **Never re-run to fill the gap.** `comfortRetryMayHelp` and `depthRelaxationMayHelp` both reject `budget-exhausted` precisely because a retry re-solves against a deadline that has already passed.
- **All sails `budget-exhausted` ⇒ plan-level `search-budget-exceeded`**, unchanged from `combineFailureCause`'s existing top precedence — which exists so the app never reports "unreachable" (a claim about the water) when the honest answer is "we ran out of time and do not know".

---

## F. The boat definition

### F.1 Where the catalogue lives

**Catalogue metadata as a TypeScript module constant; polar tables stay JSON assets** — exactly today's split (`Rig` is a code type, `polar-genoa.json` a fetched asset). `erasableSyntaxOnly` forbids enums, so a catalogue declared `as const satisfies readonly BoatDef[]` keeps a **compile-time** sail-id union (`typeof BOATS[number]['sails'][number]['id']`), and exhaustiveness checking, i18n `satisfies Record<MsgKey, string>` parity and `exactOptionalPropertyTypes` all keep working. A JSON catalogue makes every sail id a bare `string` and replaces a compiler with hand-written runtime validation (§L). Adding a boat then becomes a reviewable PR that runs the per-boat polar validation (§H) and the per-boat connectivity scan (§C.6).

**Payload is NOT a constraint and must not be re-opened as one.** Measured 2026-08-10: `polar-genoa.json` **1,426 B** + `polar-fock.json` **1,354 B** = **2,780 B for one boat's two sails**. Fourteen boats cost single-digit kilobytes against a multi-megabyte precache (`basemap.pmtiles.png` alone is ~27 MB). **Fetch every boat's polars eagerly**; no lazy-loading machinery and no per-boat manifest for size reasons, so offline planning stays trivially correct for every boat. A manifest may still be worth having for catalogue clarity — never for bytes.

Suggested layout: `app/src/data/boats.ts` (catalogue); `app/public/data/polars/<boat-id>-<sail-id>.json` (tables, committed, precached).

> **Filename collision, live today.** `build_polars.mjs` writes ``join(outDir, `polar-${rig}.json`)`` (`~:57`) with **no boat identifier** — a second boat's files would overwrite the first's. The output naming must change in the same PR that adds the second boat, not later.

### F.2 The record

```
BoatDef {
  id            // stable; persisted inside the plan's boat snapshot; NEVER renamed
  name          // model / vessel name — a proper noun, not an i18n key
  draftM        // SAFETY-CRITICAL: drives the derived default gate (§C.3) AND the
                // #53 relaxation floor (§C.4a). Per hull, per keel variant (§J OQ-4).
                // State the literal; never reference the old BOAT_DRAFT_M (§C.5 trap).
  motorSpeedKn        // per-boat default for Settings.motorSpeedKn (today 6.5)
  maneuverPenaltyS    // per-boat default for Settings.maneuverPenaltyS (today 45)
  sails: readonly [{
    id, label,
    polarAsset,       // 'data/polars/<boat>-<sail>.json'
    polarProvenance   // tier + source note — REQUIRED, see §G
  }, …]
}
```

*Amended 2026-09-30 (#567, #1575):* a sister ship may borrow its donor's tables through `polarsFrom` in `pipeline/polars-source.json`. A borrower has no table of its own, so its `polarAsset` names the donor's file. EASY GO! borrows SPEEDY GO!'s, and its `polarProvenance.note`s are byte-identical to the donor's (§O). *Superseded 2026-10-15 (§P):* EASY GO! has its own tables; no catalogue boat is a borrower today, and `polarsFrom` stays as a mechanism. This realises §J OQ-4's "sister ships sharing a polar asset".

**Deliberately NOT per-boat, and why** — write this into the type's comment so nobody "completes" it later:

- `motorThresholdKn` (2.5) — a seaworthiness floor, a statement about *water* (steerage in a seaway), not about the hull. Stays global; #254's arithmetic depends on it surviving underneath the `Math.max`.
- `depthComfortMarginM` (2.0), `sailPreferenceKn` (2.8), `performanceFactor` (0.9), `motorEnabled` — user preferences, not boat properties. `performanceFactor` is the closest call (a tired sail wardrobe is boat-specific) and is deliberately left global: it is documented as the user's own honesty dial over an estimated polar, and per-boat defaults for it would read as calibration the polars do not have. §G reinforces this.
- **Displacement** — #54 names it and **nothing in the router consumes it**. Omit rather than store an unused field: present in the type, it invites a future contributor to wire a fake physical model into the solver. Add it only when a UI surface displays it, marked display-only.

### F.3 The type change

`Rig = 'genoa' | 'fock'` (`types.ts ~:6`) → a catalogue-derived `SailId` union. **Naming matters**: today's `Rig` really names a *sail combination* (main+genoa, main+fock) and the polar tables are combination tables. What the user now selects is the **foresail**, with the main implied. Rename to `SailId` and state in its docstring that the polar it keys is a main + foresail table — otherwise the next reader assumes a headsail-only polar.

**This is a breaking type change.** Measured 2026-08-10, scoped to CODE files under `app/src`: **27 files reference `Rig`** (a raw `git grep -lE '\bRig\b' app/src` returns 28; the extra is a comment in `app/src/app.css`); **9 non-test files name `'genoa'` / `'fock'` as literals** — `types.ts`, `routing/planRoute.ts`, `routing/workerClient.ts`, `state/usePlanFlow.ts`, `components/RouteLayer.tsx`, `components/RouteSummary.tsx`, `lib/plan.ts`, `lib/gpx.ts`, `lib/sessionSnapshot.ts`. (`routing/protocol.ts` references the *type* but not the literals.) Structural sites:

- `PlanResultOk.genoa` / `.fock` / `.genoaReason` / `.fockReason` / `.recommended` → a per-sail result list. `recommendedResult()`'s invariant ("status 'ok' guarantees the recommended sail has a non-null result — throw rather than fabricate an ETA") is **preserved verbatim**; it is why `listPlans` needs §I's unreadable-row handling.
- `lib/plan.ts`'s `activeRigResult(plan, rig)` — a two-way ternary today.
- `services/assets.ts` hardcodes `polarGenoa` / `polarFock` on `RoutingAssets` (`~:7-8`) and fetches both unconditionally in `loadRoutingAssets()` (`~:44-48`).
- `protocol.ts`'s `init` message carries `polarGenoa` / `polarFock` and the worker holds them for the session. `init` should carry a **keyed map** of every boat's polars (single-digit KB, structured-cloned once at startup) and `plan` name which keys to run — preserving "init once, plan many" at zero per-plan cost. Polars are plain objects and are **cloned, never transferred**; only the mask buffer is transferred, always as a `.slice(0)` copy (unchanged).
- `lib/sessionSnapshot.ts`'s `isRig` (`~:38`) — see §I.
- **Two independent `RIG_LABEL_KEY: Record<Rig, MsgKey>` tables** — `lib/resultSummary.ts` (`~:13-16`) and `components/PlansList.tsx` (`~:13-16`), with identical entries and neither derived from the other; the declarations differ only in that `resultSummary.ts`'s is `export`ed. Read 2026-08-14. They are **absent from the nine-file count above, and that is a scoping artifact rather than an omission**: there `genoa`/`fock` appear as object *property keys*, so a grep for the quoted literals cannot match them. Both are safe today — `Record<Rig, …>` is compiler-exhaustive, so the rename reds them loudly — but a migrator working from the nine-file list alone will not visit them. Collapse both onto one lookup during the rename.
- `PolarTable` already has `rig: Rig` and `boat: string`, so the asset format needs only the `rig` field renamed and its type widened.
- i18n: sail *labels* live in the catalogue (proper nouns / sizes like "Genoa 135 %"), not in the dicts. Everything **around** them — the picker label, the provenance-tier wording, the "cannot re-plan with this boat" state, the incomplete-comparison notice, the boat-switch clamp notice — goes in **both** dicts with `MsgKey` parity.
- **Provenance NOTE text is catalogue data too, and renders in the citation's original language whatever the UI language is** (#607, maintainer ruling 2026-08-25). `draftProvenance.note` and `polarProvenance.note` are interpolated raw at their `BoatPicker.tsx` render sites, never through `t()` — so English text under a German Boat tab is **expected**, not a defect. The reason is that paraphrasing a source citation per language is how a citation becomes wrong: these notes name certificates, hull variants and modelling assumptions, and a translated one is a different claim about the evidence. Of the provenance data itself, only the polar TIER is i18n'd (`POLAR_TIER_LABEL_KEY`); the sentences around the notes — `boat.draft`, `boat.keel.assumed`, `boat.polarDetail.summary` — are in both dicts as usual, and `draftProvenance.keel` is a third catalogue string interpolated raw into one of them. The enumeration above lists what goes in the dicts; it never covered the note bodies, which is why this was read as an anomaly rather than a convention (#607 itself — one occasion, the `v0.12.1` pre-release walkthrough).

**A structural guard must keep the enumeration from regrowing.** The nine files above enumerate the sail set with **no derivation between any of them**, and the compiler protects that asymmetrically: a `Record<SailId, …>` is exhaustiveness-checked and reds loudly, while a two-way ternary such as `recommended === 'genoa' ? genoa : fock` keeps compiling and silently selects the wrong sail. Add a scanning test in this repo's existing convention (`app/src/test/chipShallowFill.test.ts`, `cameraAnimationCallSites.test.ts`, `timeoutGuard.test.ts`) that fails when a bare catalogue sail-id literal appears outside an allowlist — the catalogue itself, the i18n dicts, tests, and pipeline data. Per #411's *"a guard's DATA needs a twin"*, pin the allowlist against a hand-written expected list and record the discriminating experiment: planting a literal in a non-allowlisted file reds one row, and stubbing the allowlist to `[]` must red too, so a silently disabled guard cannot keep reporting success.

---

## G. Polars and provenance — the constraint that actually gates the fleet

### G.1 The evidence

**The Salona 45's own polars are already estimates**, and `build_polars.mjs`'s `SOURCE_NOTES` (`~:9`) says so outright. `fock` derives from ORC International 2026 certificate **AUT 035/26** (*Miles Ahead*) — the measured ~110 % jib makes it effectively the certificate configuration. `genoa` is a **hand-modelled overlay** on that configuration (+3–5 % light-air upwind/reach, 0 at 14–20 kn, −2 % upwind at 25 kn), with both tables downwind-corrected to white sails via a 23-boat ORC non-spinnaker ratio study. Both notes end *"Flat-water racing VPP — tune with the performance factor. NOT race-calibrated."*

**No ORC / IRC / ORR certificate and no published VPP polar was found for any of the nine fleet models.** A targeted ORC database search returned nothing — **weak** evidence, a negative search result rather than an absence proof (§M.6). The source spec anticipated this ("fall back to VPP estimates from comparable 45 ft cruiser-racers if no ORC certificate data is obtainable") for *one* boat as a contingency, not for *nine* as the default state.

### G.2 Why this is a spec-level question and not a data chore

The app's position is a **passage-planning aid that must not claim chart authority**. Shipping an unlabelled estimated polar for a boat the user is actually sailing is a **stronger claim than the app makes anywhere else** — the seamark overlay, the depth mask and the ETA all carry explicit uncertainty language, and this would not.

Sharper, and feature-specific: **#54's headline capability is the sail comparison**, and a comparison is driven by the *difference* between two polar tables. For the Salona 45 that difference is substantially the hand-modelled overlay, not measured data — the one boat with a certificate still has a modelled genoa. For a boat with no certificate at all, both tables are estimates and the difference between them is an estimate of an estimate.

Related, and deliberately an **open item rather than a finding**: `RIG_TIE_BAND_MS = 60_000` (`planRoute.ts ~:132`) was sized against *solver* noise (23.8× the measured 2.52 s knife-edge) and never against *polar* uncertainty. Whether polar uncertainty dominates that band — which would make a `decided` verdict on an estimated polar noise rather than a finding — is **unmeasured** (§M.4).

### G.3 The three-tier provenance model

Keep the model even though release 1 **shipped** no tier-C boat: it is the gate that lets a future boat in. (v0.12.0 does — §N.)

| Tier | Meaning | Consequence |
|---|---|---|
| **A `certificate`** | derived from a real ORC/IRC certificate for this hull or model | as today |
| **B `modelled`** | derived from a certificate for the same model in a different configuration, or from a published VPP | as today, plus the existing source note. *2026-10-15:* EASY GO!'s `fock` is the first B sail of a fleet vessel (the reference boat's genoa is already `modelled`), from a sister hull's ORC Non-Spinnaker certificate (§P); row A unchanged |
| **C `estimated`** | scaled from a comparable hull with no certificate at all | see rule 2 — ~~not built in release 1~~ **AUTHORISED 2026-08-18, see §N** |

1. **`polarProvenance` is a required field** on every sail. A boat added without one **fails the pipeline build** — never defaults to a friendlier tier. Built in release 1 even though only tiers A/B are populated, because it is what makes tier C impossible to fall into silently.
2. **~~Requirement on the first tier-C boat's PR, not designed here.~~ NOW DESIGNED — §N.4–N.6.** The maintainer decision was taken 2026-08-18 and §M.4 is discharged by construction (a tier-C boat presents `not-compared`, so there is no `decided` verdict to license) — see §N.7 for the precise scope of that discharge. The plan-time-label and *indicative*-framing clauses below stand and are satisfied by §N.5; the two struck clauses do not. Shipping a tier-C boat requires an explicit per-boat maintainer decision; its label must be visible **at plan time**, not only in the About dialog — #455 §6 makes exactly this point, that the About dialog is opt-in so a disclosure living only there is *structurally withheld* at the moment of exposure. The recommendation must be presented as *indicative*, never as a measured speed finding, ~~and §M.4's tie-band measurement must be done first~~ (for §M.4, see §N.7). ~~No tier-C UI is specified here because none is being built.~~ **The tier-C surface is specified in §N.5.**
3. **User-supplied polars are the right long-term answer** (§L) — file as a follow-up issue, do not build here.
4. **Ask Skipperteam directly.** As the operator they would hold certificates for any boat that races, and one email may move several models from tier C to tier A. The cheapest available action on OQ-6; it can run now, in parallel with release 1.

---

## H. Pipeline changes

- **`build_polars.mjs` generalises per boat.** Its plausibility bound (`if (!(v > 0 && v < 12))`, `~:28`) and its sanity anchors (`Math.abs(at(90, 16) - 8.86) > 0.6` and `at(52, 12) < 6.5 || at(52, 12) > 8.5`, `~:41-42`) are Salona-45-specific magic numbers and must become per-boat entries. **A boat added without its own anchors must fail the build**, never inherit the Salona's — an anchor that silently validates the wrong hull is worse than no anchor.

  *Amended 2026-09-30 (#567, #1575):* a `polarsFrom` borrower carries no table and so no anchors. EASY GO! ships on SPEEDY GO!'s table, validated by SPEEDY GO!'s anchors (maintainer ruling). *Superseded 2026-10-15 (§P):* EASY GO! has its own table and anchors (§P.10 row 10). The rule still binds every boat with a table of its own; see §N.6's note.
- **Output naming must carry the boat id** (§F.1's collision).
- **`polars-source.json` becomes per boat**, each carrying `boat`, its sail keys and a `polarProvenance` tier + source string per sail (§G). **This must fail closed, and today it does not.** The sail set is enumerated *twice* in `build_polars.mjs` and neither list derives from the other: the loop `for (const rig of ['genoa', 'fock'])` (`~:45`) and a separate hardcoded `SOURCE_NOTES` object (`~:9-21`). Read 2026-08-14: a sail present in the loop but missing from `SOURCE_NOTES` ships an asset with **no `source` key at all** — `JSON.stringify` drops an `undefined` value rather than emitting it, so the provenance note is silently ABSENT rather than visibly wrong, with no throw and no warning. Deriving the loop from the data removes the second list entirely; a sail declared with no provenance must then throw and name itself, exactly as the missing-anchors rule above requires.
  *Amended 2026-09-30 (#567, #1575):* a `polarsFrom` borrower carries none of these; see §K's note.
- **`verify_mask.py` gains a per-boat connectivity scan** (§C.6) and a **snap-cell margin report**: each harbour's snap-cell depth minus its gate, flagging anything under 0.2 m. Two harbours currently pass at exactly **0.0 m** (`aabenraa` 3.0 vs 3.0, `augustenborg` 2.8 vs 2.8 — #455 §3.4, reviving #245 §2.3's never-built recommendation) and a binary gate cannot see them. With per-boat gates this becomes acute.
- **No mask regeneration** (§C.9).

---

## I. Persisted plan schema migration

### I.1 What is true today

- `services/db.ts` opens `openDB<SailDB>('sailcommand', 1, …)` (`~:12`); the single `upgrade` creates the `plans` store (`keyPath: 'id'`, one index `by-createdAt` on `createdAtMs`) and the `settings` store.
- `getPlan(id)` returns the stored record **with no validation whatsoever** — typed as `Plan` and trusted.
- `listPlans()` already isolates per row: `recommendedResult` throwing is caught, logged, and that plan is **skipped**, so one corrupt record cannot blank the list.
- `Plan` is structured-clone-safe but **not JSON-safe** (`WindGrid` carries three `Float32Array`s). Any migration must stay in the structured-clone domain; a JSON round-trip silently destroys the wind grid.
- `lib/sessionSnapshot.ts`'s `isRig` (`~:38`) already carries the right shape of defensive read: it validates `'genoa' | 'fock'` and the whole snapshot resolves to `null` on an unrecognised value.

### I.2 Why there is no IndexedDB version bump

**Decided (§J OQ-5): lazy read-time normalisation, no version bump.** The reason in one line: IndexedDB is scoped to **origin**, not path, so production (`/sail_command/`) and UAT (`/sail_command/uat/`) share the `'sailcommand'` database on `docgerd.github.io`; UAT necessarily bumps first (`develop` → `/uat/`, `main` → root), and `db()` caches its promise with `dbPromise ??= openDB(…)` with **no rejection reset** (unlike `services/assets.ts`, which nulls its cache in a `.catch`), so a `VersionError` against a stored version 2 would be sticky for the whole session — stranding production's entire database, every saved plan and every settings read and write, until a reload that reproduces it. A data-loss-shaped outcome triggered by a routine UAT visit. (Derived from platform semantics and the code path, not observed in a browser — §M.5.)

### I.3 Specification

- The `plans` store is schemaless as far as IndexedDB is concerned — `value: Plan` is a TypeScript type, and the only index (`by-createdAt` on `createdAtMs`) is on a field this change does not touch. Nothing *forces* a version bump.
- `getPlan()` and `listPlans()` pass every record through one `migratePlan(raw): Plan | null` normaliser; migrated records are written back opportunistically (cheap `put` on an existing key). The normaliser lives forever — the standard cost of lazy migration, and the right trade against §I.2.
- Add **`Plan.schemaVersion: number`** stamped on write. The database version is not the only entry path — a plan can also arrive from a future import (#3) — and an untagged record has no self-description. Cheap, and it makes the normaliser's dispatch explicit rather than shape-sniffing.

**What an old plan's boat becomes.** The catalogue's Salona 45 entry (`salona-45`), with `genoa` → that boat's genoa sail id and `fock` → its jib id. A **pure relabelling with zero recomputation**: never re-plan, never re-derive an ETA, never re-run the solver. The stored wind grid is stale by definition and the result must keep rendering exactly as it was computed — the same rule the source spec already applies to the wind grid itself.

**Denormalise the boat into the plan — the key rule.** `PlanRequest` must carry a **boat snapshot by value**, not a catalogue id reference:

```
PlanRequest.boat: {
  id, name, draftM,
  sails: [{ id, label, polarProvenance }, …]   // the sails this plan compared
}
```

Precedent: `PlanRequest.settings` is already a full settings *snapshot* rather than a pointer to live settings, for exactly this reason. With the snapshot in place, **everything needed to render a saved plan is inside the record** — legs, wind grid, snapped points, shallow info, boat and sail labels, and the provenance tier the recommendation was qualified by. The catalogue is needed only to *re-plan*. Therefore:

> **A saved plan referencing a boat no longer in the catalogue still opens, still renders, still exports GPX, and still shows its original boat and sail names and provenance. Only "plan again with this boat" is unavailable, and it says so.**

Achieved by data placement rather than by error handling.

*Amended 2026-10-15:* `sails[]` in the snapshot lists the aboard headsails only (§R D7); aboard downwind sails sit in a separate snapshot key (S4). Post-trip, a sail-plan record carries `sailChange` and is stamped `schemaVersion: 2` (§S.4).

**Fail-safe on an unmigratable record.**

- **Never delete.** A record the normaliser cannot handle (missing required field; a `schemaVersion` from a newer build) stays in the store untouched.
- `listPlans` must **list it as unreadable**, not skip it. Today's per-row catch-and-skip makes a plan silently *vanish from the user's list* while the bytes survive — from where the user sits, indistinguishable from deletion. Replace the skip with a placeholder row (`name` and `createdAtMs` are readable from any shape; the rest becomes a "cannot open — created by a newer version of the app" state).
- Keep the per-row isolation: one bad record must never blank the list.
- `sessionSnapshot`'s `isRig` becomes *"is this sail id present in the plan's own snapshot"*, not *"is it in the catalogue"* — a snapshot referencing a since-removed boat must still restore.

**Rollback direction.** With lazy migration, an older build reading a newer-shaped record no longer dies at `openDB`; it fails per record in `migratePlan` and lands in the unreadable-placeholder state above. That is the whole reason to prefer lazy: the failure is scoped to one plan instead of the whole database.

---

## J. Decisions, and the one open question

Decided 2026-08-10 by the maintainer. Rejected alternatives are recorded as rows in §L so they cannot quietly return.

- **OQ-1 — `SAFETY_DEPTH_FIELD.min` per boat is `draftM + 0.1`.** It preserves today's semantics literally and keeps the lever that makes Flensburg→Marstal-class passages reachable; raising the minimum to the derived default would close an already-disclosed residual by removing a capability users deliberately have. A visible warning band below `defaultSafetyDepthM(b)` is a possible later **UI-workstream follow-up**, not part of this addendum.
- **OQ-2 — the mask-tolerance disclosure copy is parameterised by the SELECTED boat**, not a catalogue-wide worst case: the user plans for one boat, so that is the number that applies to them. This makes §C.8's R5 per-boat.
- **OQ-3 — N is capped at 2.** It is the pairwise question a skipper actually asks and the only option that changes no existing invariant (§E.1). *Amended 2026-10-15 (§R):* the cap applies to comparisons, i.e. the aboard headsails solved as whole-route plans. `MAX_HEADSAILS = 2` is kept for this release, so this ruling is not reversed. §R.4 records an N-way verdict as design only, for a future lift that needs a real three-headsail boat plus #1350.
- **OQ-4 — a catalogue entry is one per named vessel** (14 entries), sister ships sharing a polar asset, draft recorded per hull where it belongs. Per-model-with-variant-picker is rejected: a wrong default variant is a silent safety error. Deepest-variant-per-model is the **fallback only if per-hull data cannot be obtained**. *Carve-out:* the Salona 45 is the app's existing reference boat, not a fleet vessel, so its release-1 entry is model-level and carries no vessel name — say so in the catalogue comment; the per-vessel rule governs fleet boats.
- **OQ-5 — lazy read-time normalisation, no IndexedDB version bump** (§I.2).
- **OQ-7 — ~~release 1 ships the machinery only, with the Salona 45 as the sole catalogue entry. No estimated-polar boats.~~ SUPERSEDED 2026-08-18 by §N.** Release 1 did ship exactly that, and the record above describes it accurately. For what ships next, read §N: two fleet models at tier C, with the comparison suppressed. **The unlock condition is only half superseded** — the *tier-A/B provenance* conjunct is overruled; the *per-hull draft* conjunct is **not**, and §N.2 records shipping the standard listed keel instead as an explicit accepted cost with a required disclosure, not as satisfied. "Each further boat lands as its own PR" stands.

### OQ-6 — OPEN: which vessels ship, in what order, and can the operator supply certificates?

The only open question. #54 itself says *"confirm which models are actually stationed in Flensburg and prioritize those."* Three models are explicitly Flensburg-stated (Elan Impression 444, Salona 44, Grand Soleil 46).

**§C.6's constraint attaches to every candidate:** no boat ships without a sourced, per-hull draft, and **any boat deeper than 2.10 m additionally needs a `verify_mask.py` run at its derived gate first** — which is all three of the deepest models, including the Flensburg-stated Grand Soleil 46. §G.3 rule 4 (ask Skipperteam) is the cheapest action that moves this question.

---

## K. Acceptance

- **(Release-1 scope — see §N.8; re-scope before the next release.) Reduces to today.** With only the Salona 45 in the catalogue, a plan is byte-identical to a pre-#54 plan: `draftM 2.1` → default gate 3.0 → mask floor 2.1; relaxation window `[2.1, 3.0)`; two sails; same solve order; same budget; same tiers. Verify with `app/sweep/` (BASE double-run control first, six arm files asserted per output directory per #451) — this addendum changes solve *ordering* plumbing even where it changes no value. **State the strength honestly:** at one boat with two sails the sweep proves *no regression*; it cannot exercise the new N-generality at all, because there is no third sail and no second boat to exercise it with.

  **And the sweep is BLIND to the `PlanResultOk` rename specifically — do not accept it as evidence for that step.** `compare.mjs` compares plans as `JSON.stringify(ja[k]) === JSON.stringify(jb[k])` plus a whole-file sha256 (`~:83-107`), with no field awareness, so renaming `genoa`/`fock`/`genoaReason`/`fockReason` to a per-sail list makes **every** `status: 'ok'` row differ whether or not a route moved. Worse, it fails in the reassuring direction: `PlanResultError` (`app/src/types.ts ~:235-238`) carries no sail fields at all, so the all-error `becalmed` and `deep-becalmed` arms — already documented as vacuous safety evidence, 33/33 errors each — stay byte-identical through any such rename and would report **IDENTICAL**, reading as partial green. A byte comparator can certify *no change*; it cannot certify a *deliberate* one. The rename step therefore needs a **canonicalise-then-compare** control — map both BASE and HEAD plans into one shape, then compare — and the sequencing consequence is that §C.4a's per-boat floor and §C.8's guard should land **before** the rename, while the byte comparator is still sound.
- **The safety invariant is guarded, per boat.** §C.8's R0–R8 pass; R1's non-vacuity twin is mutation-checked in both directions; **R4** reds under a mutation that restores a module constant; R6's Salona literals still read 2.1 / 3.0 / 2.1 / 1.2. **Also honest:** with a one-entry catalogue, R2/R3/R8 iterate a single row and cannot fail differently from R6, so R1's hand-written expected list (`['salona-45']`) and its discriminating experiment are what stand between *those* rows and vacuity in release 1 — run that experiment, do not assume it. R5 and R7 do retain independent failure modes even at one boat: R5 reads the two i18n dictionaries, so a copy edit reds it without touching the catalogue, and R7 reads `SAFETY_DEPTH_FIELD.max`, so a range change reds it the same way.
- **`verify_mask.py` exits 0 at every catalogue boat's derived gate**, and its report names each boat's connected / exception / disconnected harbour sets plus each harbour's snap-cell margin.
- **Per-boat polar validation fails closed**: a boat added without its own sanity anchors, or without a `polarProvenance` tier, fails the pipeline build rather than inheriting the Salona's. *Amended 2026-09-30 (#1575):* a `polarsFrom` borrower declares no anchors, no sails and no tier in `polars-source.json`, and still builds; EASY GO! ships so (§N.6's note). *Amended 2026-10-15 (§P):* EASY GO! now has its own record and anchors, so no catalogue boat is a borrower. Its tier is enforced by the catalogue type and by `app/src/test/polarProvenance.test.ts`, which ties it to the donor's source, not by the pipeline build.
- **Saved plans survive.** A pre-#54 plan opens, renders identically, exports GPX identically, and reports the Salona 45. A plan whose boat has left the catalogue still opens and renders; only re-planning is unavailable and the UI says so. An unmigratable record is **listed as unreadable, never skipped and never deleted**.
- **Budget exhaustion mid-comparison yields a partial result**, each incomplete sail carrying `search-budget-exceeded`, with the UI stating the comparison was incomplete — never a one-sail "recommendation" presented as a comparison.
- **de/en `MsgKey` parity** for every new string; sail and boat names are catalogue data, not dictionary keys. The depth disclosure states the selected boat's four numbers in **both** dictionaries (§C.8 R5).
- **No chart-authority language** in any new copy; the polar caveat is stated per boat with its own tier and source note.

---

## L. Considered and rejected

> Recorded so a declined option cannot quietly return as a fresh idea — the convention `docs/spikes/` already follows in this repo. Rows marked **[OQ-n]** were the alternatives to a §J decision.

| Option | Why it lost |
|---|---|
| **Make `TOLERANCE_M` per boat** | Structurally impossible. One mask ships, produced by one blend with one constant; `T` is a property of the artifact, not of the boat reading it. Every per-boat lever is on the gate side (§C.3). Named explicitly because "the deep boat needs a tighter tolerance" is the intuitive first thought. |
| **Keep `BOAT_DRAFT_M` as the global #53 relaxation floor** | Would let a 2.30 m boat relax to a 2.1 m gate — 0.2 m shallower than its keel before the tolerance applies, 1.1 m under the hull after it — while the `shallow` banner reports the relaxation as if it were the Salona's. The single most dangerous shortcut in this feature (§C.4a). |
| **Ship the fleet at today's 3.0 m default** | Three of nine models (drafts 2.25, 2.30, 2.30) require ≥ 3.2 m, and two more sit at exactly zero margin. Silently re-opens the below-hull class the whole of #455 closed, for one Flensburg-based model among others (§C.5). |
| **Hand-type each boat's default safety depth** | Defeats §C.8 R2, which pins the *derivation*. A hand-typed default is exactly the drift the #455 guard exists to catch, relocated from the pipeline into the catalogue. |
| **Use a non-decimetre gate (e.g. 3.15 m)** | The mask encodes decimetres, so 3.15 m behaves identically to 3.2 m — a silent equality. Quantise explicitly, and always up; rounding down breaks the invariant by a decimetre (§C.3). |
| **Reuse `BOAT_DRAFT_M` for the Salona 44** | Its 2.10 m draft coincides numerically with the Salona **45**'s constant. Different model, different hull, different polar; a shared reference means a later change to one silently moves the other (§C.5). |
| **[OQ-1] Raise `SAFETY_DEPTH_FIELD.min` to `defaultSafetyDepthM(b)`** | Would make the §C.3 invariant hold at every *typeable* setting — but it closes an already-disclosed residual by removing a capability users deliberately have, collapsing the field to a single value and leaving #53 relaxation as the only path to a shallow passage. It would not even reach the true worst case, which is that relaxation floor (§C.4). |
| **[OQ-2] A catalogue-wide worst-case tolerance disclosure** | One static string, but it overstates the exposure for shallow-draft boats and understates the relevance of the number the user's own boat actually hits. |
| **[OQ-3] Raise `PLAN_BUDGET_MS` proportionally to N** | It bounds how long a human waits, not a compute quota. Five sails would be a five-minute wait with no actionable progress. Rejected regardless of the cap. |
| **[OQ-3] Per-sail sub-budget `PLAN_BUDGET_MS / N`** | Fixes order-starvation but shrinks every sail's budget, risking failure on routes that solve today — Flensburg→Marstal is documented (#432) as one of the app's most expensive inputs, already near the wall. Alive only if the cap is ever lifted (§E.2). |
| **[OQ-3] Generalise `RigRecommendation` to N-way now** | Unnecessary at a cap of 2 and genuinely ambiguous — `tie` among N results has at least two defensible readings and `moot` has three. Required only if the cap is lifted; do not design it speculatively (§E.2). *Amended 2026-10-15:* §R.4 records N-way semantics as design for a future lift; nothing N-way ships while `MAX_HEADSAILS = 2`. |
| **[OQ-4] One catalogue entry per model, keel variant picked separately** | Fewer entries and one more selection step — but a wrong default variant is a **silent safety error** in the one field everything in §C hangs on. Rejected outright, not merely deprioritised. |
| **[OQ-4] One entry per model at the deepest listed variant** | Fail-safe by construction (over-deep gate = over-cautious routing) at the cost of needlessly excluding harbours for shoal-keel hulls — an Elan 444 shoal (1.60 m, gate 2.5) would be routed as a 1.90 m hull at gate 2.8. Retained as the **fallback** if per-hull data cannot be obtained; never the variant-picker. |
| **[OQ-5] IndexedDB version bump to 2 with a cursor rewrite in `upgrade`** | One deterministic migration point, at the cost of §I.2's shared-origin hazard: UAT bumps first, `db()` caches its rejected promise with no reset, and production's whole database is stranded. If ever revisited, `db()` must first gain the rejection reset `services/assets.ts` already has. |
| **[OQ-5] Version bump plus a deployment-scoped database name** | Orphans every existing production plan into an unreachable database. |
| **[OQ-7] Ship tier-C estimated polars for the Flensburg fleet in release 1** | **OVERRULED 2026-08-18 — see §N.** The reasoning below was correct when written and is not withdrawn: the comparison clause is answered by *suppressing* the comparison (§N.4), and the stronger-claim clause is answered only in part — the residual ETA claim is recorded in §N.4 as an **accepted cost** of the overrule. Original text: an estimated polar for the boat a user is actually sailing is a stronger claim than the app makes anywhere else, and the sail *comparison* would be an estimate of an estimate (§G.2). Deferred until per-hull draft and tier-A/B provenance exist, or until §M.4's tie-band measurement licenses a qualified presentation. |
| **Re-plan old saved plans during migration** | The stored wind grid is stale by definition; recomputation would silently change a saved route's ETA and geometry. A saved plan must always render exactly as computed. Migration is a pure relabelling. |
| **Store the boat as a catalogue ID reference in the plan** | Makes a saved plan un-renderable the moment a boat leaves the catalogue — data-loss-shaped, for a purely cosmetic dependency. Denormalise by value, as `PlanRequest.settings` already does (§I.3). |
| **Delete plans the migration cannot handle** | Data loss. The bytes are intact; only our ability to interpret them is in question, and a newer-version record is expected to become readable again on the next update. Never delete; list as unreadable. |
| **Keep `listPlans`'s skip-on-error for unmigratable records** | Correct as *isolation* (one bad record must not blank the list) and wrong as *presentation*: the plan silently disappears while the bytes survive, indistinguishable from deletion from where the user sits. |
| **A JSON boat catalogue under `app/public/data/`** | Throws away every compile-time guarantee `Rig` currently provides: sail ids degrade to `string`, exhaustiveness checking disappears, i18n parity can no longer be `satisfies`-checked, and runtime validation has to replace a compiler. **Payload is not the reason** (§F.1); type safety is. |
| **Lazy-load or size-optimise polars** | **Measured non-issue — do not re-open.** 1,426 B + 1,354 B = 2,780 B for one boat's two sails; the whole fleet costs single-digit KB against a multi-megabyte precache. Eager loading keeps offline planning trivially correct for every boat. |
| **Model displacement in the boat record** | Nothing in the router consumes it. Present in the type, it invites a future contributor to build a fake physical model on top of an estimated polar. Add it only when a UI surface displays it, marked display-only. |
| **Ship estimated polars with only the existing source-note disclosure** | The About dialog is opt-in, so a disclosure living only there is *structurally withheld* at the moment of exposure — #455 §6 makes exactly this argument about the depth disclosure. Tier C needs a plan-time label (§G.3). |
| **Reuse the Salona 45's polar sanity anchors for other hulls** | Research-verified magnitudes for one 45 ft cruiser-racer. An anchor that silently validates the wrong hull is worse than no anchor: it converts "unvalidated" into "validated against the wrong thing". Fail the build instead. |
| **Refine the mask so deeper boats reach more harbours** | Already decided in `docs/spikes/245-depth-mask-resolution.md`: 0 of 5 `KNOWN_DISCONNECTED` harbours reconnect at 23 m or 12 m, while `aabenraa` disconnects at 23 m and `augustenborg` additionally at 12 m. A finer grid makes the deep-boat case *worse*. Note the scope: #245 measured that at the **3.0 m** gate, and the effect at the 3.2 m gates the deepest models need is unmeasured (§M.2) — this row rejects the option on the evidence that exists, not on a measurement at those gates. Do not re-open without new bathymetry. |
| **Treat a harbour dropping out at a deeper boat's gate as a defect** | It is correct — a 2.30 m keel cannot enter a 2.0 m basin. The defect would be silently offering it. Fix the *presentation* (a runtime-derived per-boat access state, shown as a marker on the still-selectable picker entry), not the routing. **#1135 Q6 rejected greying out**: a `shallow-approach` harbour routes, so disabling it would block a reachable destination, and an `unreachable` pick already ends in a typed no-route error. |
| **Build user-supplied polar import in this addendum** | The strongest honesty story long-term (the user owns the claim), but it needs its own validation and persistence design. File as a follow-up issue (§G.3 rule 3). |

---

## M. What could NOT be determined from the repository

Stated explicitly so a future reader does not mistake silence for a decision.

1. **Every fleet draft in §C.5 comes from outside this repository.** The repo contains exactly one draft (`BOAT_DRAFT_M = 2.1`) and no fleet data of any kind. The figures were cross-checked against a second manufacturer source each, but they are **inputs to be re-verified per hull** — and per keel variant — before any boat ships. §C's arithmetic is correct whatever they turn out to be.
2. ~~**The connectivity ceiling above 3.0 m.**~~ **MEASURED 2026-08-18 — see §N.8, and read §N.8's 2026-09-17 supersession note before quoting any figure from it: that run covered 33 pre-#295 harbours on an exact-snap predicate, and §N.7 carries the snap-aware 40-harbour numbers.** `verify_mask.py` already reports the deepest gate at which each harbour reaches open water; the run resolves 2.8 / 3.0 / 3.2 / 3.4 m and is what made §N.1's scope selectable. The original text, for the record: `verify_mask.py` has only ever run at 3.0 m (plus two lower per-harbour exceptions); how many harbours survive a 3.2 m gate — the gate all three deepest models need — is unmeasured; §C.6's Marstal worked example is derived from the script's own comment, not from a run.
3. **Whether `app/sweep/` shows any regression from the solve-order plumbing change.** No sweep was run for this document, and per §K it could only show absence of regression at one boat.
4. **Whether polar uncertainty dominates `RIG_TIE_BAND_MS`** (§G.2). The band was sized against solver noise and never against polar error. Unmeasured, and it decides whether an estimated-polar boat may ever present a `decided` recommendation unqualified — and, per §N.7, running it must be paired with a check that the two tables are not a deterministic function of one another, or it reports "does not dominate" for a comparison that is vacuous rather than noisy.
5. **The `VersionError` behaviour in §I.2 is derived** from IndexedDB's origin-scoping and `db()`'s promise caching, not observed in a browser here. It is standard platform behaviour and the code path reads plainly, but the decision against a version bump rests on it.
6. **Whether ORC certificates exist for the fleet.** A targeted database search returned nothing for all nine models — **weak** evidence, a negative search result rather than an absence proof. §G.3 rule 4 recommends asking the operator directly before treating tier C as the only option; this is the substance of the open OQ-6. **Re-tested 2026-08-18 and the negative is now better characterised, though still not an absence proof:** ~~ORC's machine-readable endpoint serves CertType 2+3 only, which excludes every Non-Spinnaker certificate — i.e. exactly the white-sail configuration this app needs. So the corpus that was searched could not have contained a usable certificate even if one exists.~~ **Corrected 2026-10-15 (§P.2):** the endpoint does serve Non-Spinnaker certificates: `…WPub.dll?action=DownRMS&CountryId=<NatAuth>&Family=NS&ext=json` returns them (e.g. `CountryId=TUR`: the Salona 44 SANTA ANASTASIA). It serves current-year certificates only. No 2026 ORC, NS or DH certificate for EASY GO! or SPEEDY GO! was found by name under the national authorities scanned; that is still not an absence proof, since older certificates are invisible. Record counts are snapshots, never quoted as exact. `data.orc.org`'s own certificate lookup is form/JS-driven and was not reachable programmatically; a human searching that UI remains the cheapest test.

7. **§N.3's estimator accuracy figures come from outside this repository, and the two sources disagree.** The amendment publishes *"a median RMS around 3 % and a median worst cell around 8–10 %"*, and that band is what licenses the shipped copy *"typically within a few percent, up to about ten percent in individual conditions"*. **Method**, so a successor can re-derive rather than trust: an oracle study — for each target hull, choose the single scalar that best fits its known polar to the reference, then measure the residual. It is therefore a **ceiling on what any uniform scalar can achieve**, not a measurement of this estimator, and not a measurement against a real boat. Two independent passes reported median RMS **2.91 %** (n = 390) and **3.44 %** (n = 644), with median worst-cell **8.12 %** and **10.03 %**; a k-nearest-neighbour alternative's headline **2.55 %** did **not** reproduce and is treated as unverified. **The population behind those `n` values was not recorded** — whether they count hulls, hull-pairs or polar cells is unknown, and neither is the corpus they were drawn from. That is a real hole in this entry's re-derivability and it is stated rather than papered over: the figures license only the wide worded band, and anyone wanting a decimal must redo the corpus work and record its population. The published band is deliberately wide enough to be true under every figure any pass reported — do not narrow it to a decimal without redoing the corpus work and owning it. Both passes agree the residual is polar *shape*, which no scalar corrects.

8. **The Salona 44's deep-keel depth comes from outside this repository, and the sources do not agree.** Brochure-level listings give ~2.44 m; the operator's tech sheet for EASY GO! gives **2.55 m** (sources spread 2.55–2.59 m). §N.2 and §L row 13's worked case use **2.55 m**, the fleet's own figure — the ~2.44 m listing is recorded here only so a future reader meeting it knows it was seen and not chosen. §C.5's keel-variant paragraph lists variants for the First 47.7, Oceanis 473 and Elan 444 only. The related per-vessel keel identifications in §N.2 — PIRANJA standard 1.90 m, SPEEDY GO! standard 2.10 m, EASY GO! deep 2.55 m — come from the operator's published tech sheets, which is stronger than a model-level default and weaker than the hull's own papers. §M.1's re-verification rule applies to all of them. **Amended 2026-09-30 (maintainer ruling, #1575):** EASY GO! ships at **2.59 m**. The operator source for 2.55 m is its per-vessel page (https://skipperteam.de/toerns/yachten/salona-44-easy-go, read 2026-09-30, not archived). 2.59 m is not an operator figure: it is Cruising World's model review (https://www.cruisingworld.com/salona-44/), the racing-keel draft. The deeper figure is taken. Both derive the same gate (3.5 m) and relaxation floor (2.6 m). EASY GO!'s 2.55 m draft figures above and in §N.1, §N.2 and §N.7 are the pre-ruling record. **Amended 2026-10-15 (§P.7):** sources read for EASY GO!: the builder's technical data lists 2.10 / 2.55 m for the two keels; the operator's page 2.55 m; Cruising World 2.59 m, whose own imperial figure (8 ft 4 in) reads 2.54 m; six ORC-measured Salona 44 hulls of the deeper-keel group 2.415–2.441 m, which are measured at the certificate's measurement displacement, so the setting is not lowered toward them. 2.59 m stands. No source read supports a build year for EASY GO! (dropped) or SPEEDY GO! (kept, open: §P.12 Q4).

---

## N. Amendment 2026-08-18 — tier-C estimated polars authorised (supersedes OQ-7)

**Status:** authorised by the maintainer 2026-08-18. This section **supersedes §J OQ-7** and
**overrules the §L row `[OQ-7] Ship tier-C estimated polars for the Flensburg fleet in release 1`**.
Every other §L row stays in force; §N.9 classifies all 28 so none returns by silence.

The trigger is a product decision, not new evidence: the multi-boat feature must be user-visible in
the v0.12.0 release, and OQ-6 did not move — no certificate was obtained for any fleet model. §A.4
already anticipated this path (the source spec's *"fall back to VPP estimates from comparable 45 ft
cruiser-racers if no ORC certificate data is obtainable"*), so what follows activates a contingency
the source design wrote, at a scale it did not envisage. That distinction is the honest framing and
should not be inflated in either direction.

### N.1 Scope — two fleet vessels, three catalogue entries, and no harbour lost

| Ship | Model | Vessel(s) | Draft | Derived gate | Basis |
|---|---|---|---|---|---|
| ✅ | Elan Impression 444 | PIRANJA | 1.90 m | **2.8 m** | Flensburg-stated (§C.5). Gate < 3.0, so its reachable-harbour set is a **superset** of today's. |
| ✅ | Salona 44 | SPEEDY GO! | 2.10 m | **3.0 m** | Flensburg-stated. Gate identical to today's — **no new gate**. Engages §L's "Reuse `BOAT_DRAFT_M` for the Salona 44" row: 2.10 m must be its own literal. |
| ⏸ | Salona 44 | **EASY GO!** | **2.55 m** | 3.5 m | **Deferred** — §N.7. Sister ship of SPEEDY GO! by model, **not by hull**: it is the deep/racing keel. |
| ⏸ | Grand Soleil 46 | MARIN | 2.30 m | 3.2 m | **Deferred** — §N.7. |
| ⏸ | the other six models | 10 vessels | — | — | Not Flensburg-stated; #54 asks to prioritise those that are. |

**OQ-4's per-vessel rule earns itself here.** SPEEDY GO! and EASY GO! are the same model and were
briefed as one 2.10 m pair; they are two different hulls, 0.45 m apart. A per-model catalogue entry
would have carried one draft for both — the "wrong default variant is a silent safety error" §L
rejected the variant-picker over, arriving through the sister-ship door instead. Had they shared one
entry, §N.2's retirement path ("one confirmed keel per hull") would have been structurally
unreachable without a schema change.

**Entry model, stated explicitly because §N.8 counts them.** OQ-4 is unchanged and governs: **one
entry per named vessel**, with the Salona 45 keeping its model-level carve-out as the app's
reference boat. So v0.12.0's catalogue is **three entries** — `salona-45` (model-level),
PIRANJA (vessel), SPEEDY GO! (vessel) — not two models. EASY GO! becomes a fourth when it lands.

**The property that makes this scope safe:** no catalogue boat's gate exceeds today's 3.0 m, so no
harbour becomes unreachable for any boat and no new connectivity ceiling is crossed.

**Amended 2026-09-30 (maintainer ruling, #1575):** EASY GO! ships as the fourth catalogue entry, tier C, at 2.59 m (gate 3.5 m); the ⏸ row and its 2.55 m are the 2026-08-18 record. This paragraph's property no longer holds for the catalogue: at its 3.5 m default EASY GO! reads `augustenborg` and `marstal` unreachable in-app. §O.

### N.2 Drafts — an accepted deviation from §M.1, and it must be disclosed

**Decided 2026-08-18:** ship the keel identified **per vessel** from the operator's published tech
sheets (§M.8), **not verified against the individual hull's own papers**. For PIRANJA and
SPEEDY GO! that identification is the model's standard keel; for EASY GO! it is not, which is why
it is deferred.

**This decision was taken on the assumption that both Salona 44s were the standard hull, and that
assumption was wrong — the check caught it before it shipped.** Recorded in full, because it is the
strongest available evidence that the disclosure requirement below is not ceremony:

- **PIRANJA** — Elan Impression 444, standard fin-and-bulb **1.90 m**. The model also ships a
  1.60 m shoal keel; if PIRANJA were that variant the derived gate would be **over-cautious**,
  which is harmless.
- **SPEEDY GO!** — Salona 44, standard **2.10 m** (built 2014 — no source read supports the year; open, §P.12 Q4).
- **EASY GO!** — Salona 44, **deep/racing keel, 2.55 m**. Sources spread 2.55–2.59 m;
  the ~4 cm is immaterial next to the 0.45 m that matters. At 2.55 m the derived gate is **3.5 m**,
  not 3.0 m. Shipping it at 2.10 m would have **understated a real vessel's draft by 0.45 m** and
  handed it a gate 0.5 m too shallow — the unsafe direction, in the one field everything in §C
  hangs on. **Deferred** (§N.7).

So the residual cost is narrower than first written, and should not be overstated either way: the
keels are now identified **per vessel** from the operator's own published tech sheets, which is
stronger than a model-level default — but weaker than the hull's own papers, and §M.1 asks for the
latter. It remains an **accepted cost**, not a satisfied condition.

**Why not §L row 13's deepest-variant fallback in the interim?** OQ-4 reserves it for the case where
per-hull data *cannot be obtained*, and that case is arguably live now — the operator has not been
asked (§G.3 rule 4). It is declined on measured cost, not overlooked: the deepest Salona 44
keel this fleet is now known to carry is EASY GO!'s **2.55 m**, which derives a **3.5 m** gate.
Re-measured snap-aware over 40 harbours (§N.7, 2026-09-16), that gate leaves `augustenborg` and
`marstal` unreachable and `faldsled` and `rudkoebing` shallow-approach — so the withdrawal from
SPEEDY GO!, whose own tech sheet reads 2.10 m, is **four** harbours marked at that gate against
the one (`marstal`) it carries at 3.0 m — `augustenborg` and
`marstal` unreachable, `faldsled` and `rudkoebing` routable only with a depth warning — against
the **seven** this paragraph previously claimed from §N.8's pre-#295 exact-snap run, whose
predicate is not the same one. The decision is
unchanged and the reasoning is now weaker in degree, not in direction: it still trades real
reachability away to guard against a variant we already have evidence against for that hull. The identified keel plus the
disclosure below is the chosen trade; row 13 remains the fallback the moment a keel is
**contradicted** rather than merely unconfirmed, and remains available if the operator declines to
answer. (EASY GO! is the case where it *was* contradicted — and there the answer was to defer the
vessel, not to route it on an assumed hull.)

**Required mitigation, unchanged and now better justified:** each fleet catalogue entry records the
keel variant it assumes and that the figure is not from the hull's papers, and that statement is
surfaced on the boat picker alongside the provenance tier — not buried in a JSON field. A wrong
keel is invisible in every artifact the app renders; only the disclosure makes it checkable by
someone who can see the boat. §L's rejection of the variant-picker stands: this is not a picker, it
is a single sourced default with its uncertainty disclosed.

**The field is `BoatDef.draftProvenance: { keel, hullVerified, note }`, REQUIRED on every fleet
entry** — named here because it diverged once and the divergence was silent. Found in the PR #565
review, 2026-08-18: the fleet branch wrote `draftProvenance` while the picker branch rendered an
optional `keelAssumption?: string`. Both typechecked, `boats.ts` would have merged cleanly keeping
both fields, and the paragraph would have rendered **nothing** — for exactly the two boats this
section requires it for. Neither branch's tests could see it: the fleet branch asserts the field is
present in the catalogue, the picker branch renders from its own fixture. Make it **required**, not
optional, so a fleet entry without it is a type error rather than a silent omission.

**Retiring this deviation** needs one confirmed keel per hull from the hull's own papers
(§G.3 rule 4 — ask the operator).

**Amended 2026-09-30 (maintainer ruling, #1575):** EASY GO! is no longer deferred. It ships its deep keel at 2.59 m (§M.8). This section's accepted cost covers the operator's per-vessel page (2.55 m, https://skipperteam.de/toerns/yachten/salona-44-easy-go, read 2026-09-30); taking Cruising World's model-review racing-keel figure (2.59 m, https://www.cruisingworld.com/salona-44/) is a conservative step beyond it, accepted by this ruling. EASY GO!'s `draftProvenance.note` carries the sister-ship and deep-keel caveat. "to defer the vessel" above is the 2026-08-18 record. §O. *Amended 2026-10-15 (§P.7):* that note is reworded to the source spread of §M.8 and no longer calls the polars SPEEDY GO!'s (the spec's "built 2011" is dropped by the previous edit; the note never carried it).

### N.3 The estimator — `salona45-uniform-scalar-v1`

Inputs are the **already-shipped Salona 45 tables** and **public brochure dimensions** only. It
downloads nothing and ingests no third-party table, which is what keeps licence exposure, donor
keel-variant ambiguity and corpus completeness out of scope entirely.

1. `SA/D = sailAreaUpwindM2 / (displacementKg / 1025)^(2/3)`, for target and for the Salona 45.
2. `k = sqrt( (SA/D)_target / (SA/D)_salona )`.
3. `speeds[i][j] = round( speeds_salona45_fock[i][j] × k, 2 )` — the **certificate-anchored** table
   is the base, never the modelled genoa overlay.
4. `tws`, `twa`, `beat`, `gybe` are copied from the Salona 45 **unchanged**.
5. `validation.maxSpeedKn` and every sanity anchor are hand-set from that hull's **own** published
   figures (§N.6, rules E3/E4).

Step 2's exponent is **dimensional, not fitted** — speed goes roughly as the square root of driving
force for a given resistance curve — and no measurement in this repository licenses it. What makes
that acceptable is a measured ceiling rather than a claim of accuracy: the *best possible* single
scalar chosen with hindsight still leaves a median RMS around 3 % and a median worst cell around
8–10 %, because the residual is polar **shape**, which no scalar corrects. A more elaborate scalar
cannot buy much. Prefer the simple auditable one and publish a wide band.

`displacementKg` lives in `pipeline/polars-source.json` as an estimator input. §L's *"Model
displacement in the boat record"* row **stays in force and becomes more important**: displacement
must never reach `BoatDef`, precisely because it is now an estimator input and that is the standing
invitation to wire a fake physical model into the solver.

**What the method cannot do**, to be stated in the code and not only here: it cannot measure error
against a real boat (every accuracy figure anywhere in this amendment is one VPP predicted from
others); it cannot move pointing angles, so every estimated boat **inherits the Salona 45's beat
and gybe angles outright** as an inherited claim rather than a derived one; it cannot capture hull
shape; it cannot fix a wrong keel; and it says nothing about waves, current, fouling or reefing.

**Worked instance of the hull-shape limit, recorded because it was nearly mistaken for an estimator
error** (PR #565 review, 2026-08-18). The Elan's only independent report reads *"just over 6 knots
close-hauled in only 8 knots true, and just under 6 in 6-7 knots"*. Comparing that second half
against a TWS-6 cell gives ~26 %, which looks like a second, larger light-air error mode. **It is
not one.** A uniform scalar has identical relative error in *every* cell by construction, so there
cannot be one cell 9 % off and another 26 % off against the same reference; the gap decomposes as
`9.2 % estimator ⊕ 18.3 % base-table falloff`, and that falloff is inherited verbatim from the
donor. The article's own pair is also not a usable probe: it has the boat holding speed while true
wind falls about a fifth, where the certificate-anchored donor drops 18 % over the same span — no
displacement-cruiser polar is that flat, so the two prose observations are not precise enough to
differentiate. **§N.3's published band stands; the only like-for-like discrepancy is 9.2 %.**

The general rule this instance illustrates, worth more than the instance: **any second, larger
percentage measured against a uniform-scalar estimate is measuring something other than the
estimator.** Decompose before widening a band.

### N.4 Two sails, and the comparison suppressed by type

**Decided:** a tier-C boat ships **two sails**, and its sail comparison is **withheld**.

The second table is the boat's own base table × the Salona 45's documented overlay ramp. The
difference between the two is therefore a function of **the ramp, not the hull** — deterministic,
repeatable, and carrying zero information about that boat. It is not a noisy finding; it is not a
finding. So:

- `RigRecommendation` gains `{ kind: 'not-compared' }`. `assemble` returns it whenever **any sail in
  the compared set** is tier C, and whenever the comparison is not **exactly two sails that both
  produced a result** — which also
  closes the latent N = 1 and N ≥ 3 cases that stamp `decided` today (#553).
- Enforced in `assemble`, **by type, never in the view**.
- No ★ on the tab, and **no faster-rig claim**. Corrected 2026-08-18 (PR #564 review): an earlier
  wording said "no `chip-faster-rig`", naming a CSS class where it meant the claim. `tie` and
  `moot` already render their honest strings through that same class, so removing the element for
  `not-compared` would either regress #259's honest-chip behaviour or add a third rendering path
  for no benefit. The class is a styling hook; what must not appear is the assertion that one sail
  is faster.

**Because both ETAs remain visible, absence is not sufficient disclosure.** A reader seeing two
times will infer the comparison the app declines to make. The copy must therefore disclaim **the
difference itself**, not merely omit the ranking (§N.5).

**§L's `[OQ-7]` clause R-b (*"the comparison would be an estimate of an estimate"*) is answered by
suppression, not by removal** — the earlier one-sail option would have removed the claim outright
and was not taken. Clause R-a (*"a stronger claim than the app makes anywhere else"*) is **partly
answered and partly an accepted cost**: labelled at plan time, framed as indicative, banded, and
with the strongest sub-claim withdrawn — but the ETA remains a speed claim about the boat the user
is sailing, derived from a table nobody measured against that hull. No label converts it into a
measurement. That residue is the cost of the overrule.

*Amended 2026-10-15:* post-trip, a sail change between two headsails where one table is derived from the other is planned or hinted only when its gain beats the penalties plus a larger margin (`OVERLAY_BOUND`, §S D4), and it is labelled as derived (§S D13; cross-cutting decision 3). The router runs with an `estimated` sail aboard. The whole-route comparison stays suppressed by tier.

### N.5 The honesty surface

§L's row *"Ship estimated polars with only the existing source-note disclosure"* is **not overruled
and becomes binding**. The label appears at: the boat picker; the **planner panel beside the
selected boat, always visible** (§G.3 rule 2's plan-time clause); the results card; the plans-list
row (read from the persisted snapshot, so an old plan cannot read as certificate-grade); and the
About dialog — *in addition to*, never instead of. `BoatSnapshot.sails[].polarProvenance` already
carries `{tier, note}` by value, so no new persisted field is required **for the polar tier**.

**The draft statement is NOT covered by that, and the difference matters.** `BoatSnapshot` holds
`id`, `name`, `draftM` and `sails[]`, with no draft-provenance field, and it cannot be recovered
from the catalogue because §I.3's whole point is that a boat may have left it. So a re-opened saved
plan would render its draft with no indication that the keel was assumed — the same hazard §N.2
measures at 0.4 m, on the very disclosure written to make it visible. **Decided:** the draft
statement is **plan-time and picker-time only** in this amendment; a saved plan does not carry it.
That is acceptable only because **every fleet draft in the v0.12.0 catalogue is an assumed keel** —
there is no hull-verified draft alongside it for a reader to mistake it for — and because the
picker, not the saved plan, is where a user can act on it. §I.3's denormalise-by-value rule cuts the
other way and is why this is a gap rather than a design: a plan carries `draftM` by value *because*
the catalogue may change, and the same argument applies to the assumption behind the number. It
closes by adding a persisted draft-provenance field the first time a hull-verified draft ships
alongside an assumed one. File it rather than forget it.

Copy requirements, per OQ-2 parameterised by the **selected** boat and never a catalogue-wide worst
case:

- A tier chip per provenance tier.
- A plan-time detail sentence naming: that the table is scaled from a comparable hull, that no
  certificate was obtained, an uncertainty band in words (**"typically within a few percent, up to
  about ten percent in individual conditions"** — no decimal), and the light-air operational
  consequence below.
- **A sentence disclaiming the difference between the two sails** for a tier-C boat — new in this
  amendment, required by §N.4.
- A sentence recording which keel variant the entry assumes and that the figure is not from the
  hull's own papers (§N.2).
- `route.eta.indicative` on the ETA; `route.comparisonIncomplete` for #540's unconsumed
  `comparisonComplete`. *Amended 2026-10-15:* `route.eta.indicative` is absent from both dictionaries today; §S D13 adds it. Post-trip the surface also gains the sail-plan labels (§S D13) and the crossover-advisory note (§S.11).
- No chart-authority language: nothing may say *accurate*, *verified*, *reliable* or *safe*.
  *Indicative* / *Anhaltswerte* is the register.

**Label hard: sail-vs-motor classification below 8 kn.** Measured on the shipped genoa table at the
default sail-speed floor (3.7 kn) **and the default performance factor (0.9)**, every motoring
heading occurs at TWS ≤ 8 (10/15 headings at TWS 4, 4/15 at 6, 2/15 at 8, zero at 10 and above).
`Polar.speedKn` (`app/src/lib/polar.ts`) applies the factor and `isochrone.ts` compares that value
to the floor, so 0.9
is the right basis; the load-bearing half — that every motoring heading sits at TWS ≤ 8 — holds at
factor 1.0 too (8/15, 2/15, 0). The estimator's error is worst in exactly that band. So
a tier-C boat's sail/motor split below 8 kn can flip, and both directions are bad: a leg promised
under sail that ghosts, or a leg motored that would have sailed — in a sailing app. This is the one
place the tier-C caveat has an **operational** rather than epistemic consequence, which is why it
is a clause of the plan-time sentence and not a footnote.

### N.6 Fail-closed pipeline rules

§L's *"Reuse the Salona 45's polar sanity anchors for other hulls"* row is **in force and directly
binding**, and an anchor derived from the boat's own estimated table is the #50 equivalence
tautology. **Decided:** the build **fails closed** — every anchor requires a named independent
source, and a boat with none **does not ship**. That outcome must be surfaced before estimator work
begins, not discovered at build time.

| # | Rule |
|---|---|
| E1 | `provenance.tier === 'estimated'` ⇒ a complete `estimator` block. Tier C is declared, never fallen into. |
| E2 | Every `estimator.inputs.*` carries a non-empty `source`. |
| E3 | Every `validation.anchors[].source` is non-empty and names an independent citable magnitude for **that hull**. |
| E4 | Throw if an anchor's `(minKn, maxKn)` **and** its `source` both equal the base boat's at the same `(twa, tws)` — conjunctive, so near-zero false positives. |
| E5 | `0.80 ≤ scalar ≤ 1.25`; outside that band the donor is not comparable — refuse rather than extrapolate. |
| E6 | **A tier-C boat must declare its second sail's derivation explicitly** (which base sail, which ramp), and a sail set in which **any sail** is tier C must resolve to `not-compared` — the mixed tier-A-plus-tier-C set is the one shape where a `decided` verdict could otherwise slip through. That second clause is **enforced in `assemble` per §N.4, not here**; no build-time check can see a return value. The build's half is the declaration above. *(Replaces the one-sail form of this rule, which §N.4's decision retired.)* |
| E7 | Estimated speeds must be **reproducible**: re-running the estimator from the committed inputs reproduces the committed `speeds` byte-for-byte — **including the second sail's `base × ramp` step**, so both committed tables are reproducible from the committed inputs. Perturb one input and the build reds. |
| E8 | Every existing structural check is retained unchanged. |

**Amended 2026-09-30 (maintainer ruling, #1575):** EASY GO! ships with no anchors of its own. It is a `polarsFrom` borrower (#567) and routes on SPEEDY GO!'s table, validated by SPEEDY GO!'s anchors. None of those names EASY GO!'s deep-keel hull, so E3's "for that hull" is not met for it, and "a boat with none does not ship" does not apply to a borrower. An accepted cost of the ruling; §O. **Withdrawn 2026-10-15 (§P):** EASY GO! has its own anchors (§P.10 row 10) and is no borrower. E3's "for that hull" stays unmet: the anchors are sister-hull data. §P.6 adds rules D1–D8 for the new `derivation` block and widens E1 to admit a ramp derivation.

**A `("marstal", 2.8): 2.0` entry in `verify_mask.py`'s `CONNECTIVITY_EXCEPTIONS_M` is a
prerequisite of the Elan 444's catalogue PR.** MEASURED 2026-08-18, control first: with the
unmodified `polars-source.json` the script exits 0; adding `elan-444` at `draftM 1.90` (derived gate
2.8) exits **1** with `CONNECTIVITY marstal snap … not reachable from open water at gate depth
2.8 m (boat elan-444, derived gate 2.8 m)`. The table is keyed `(harbour, boat gate)` and holds only
3.0 m entries today, so marstal has no exception at 2.8 — the script's own comment says a boat whose
derived gate has no entry "gets no exception at all, which is what forces the evidence at its
catalogue PR", and this is that forcing working as designed. The evidence is satisfied *a fortiori*
by the existing entry: dropping a 2.8 m gate to 2.0 m is a **0.8 m** relaxation against the 1.0 m
already reviewed at 3.0 m, and marstal reconnects at ≤ 2.3 m either way. augustenborg needs no
2.8 m entry (it reaches open water at exactly 2.8 m); the Salona 44's 3.0 m gate uses today's
entries unchanged.

This also bounds what §N.8's run proves: it was made against the **current one-boat catalogue**, so
it establishes the connectivity ceiling but does **not** discharge §C.6's *"no boat ships without a
`verify_mask.py` run at its own derived gate"*. That run is owed per boat at its catalogue PR — and
`verify-mask.yml` is **not a required check** (#550), so it reds silently and someone has to look.

### N.6a MERGE ORDER — a composition hazard that no single branch contains

**Rule: no catalogue entry beyond `salona-45` may reach a release in which
`workerClient.ts` still hardcodes `DEFAULT_BOAT_ID`.**

This is a release gate, not a code change, and it is written here because it cannot be enforced by
reviewing any one branch. Found in the PR #563 review, 2026-08-18.

The three branches delivering §N are individually correct and jointly ordered:

| Branch | Delivers | Safe alone? |
|---|---|---|
| picker | selection, persistence, §C.7 clamp, the honesty chips | yes, at a one-boat catalogue |
| routing | `not-compared`, **the `DEFAULT_BOAT_ID` fix** | yes |
| fleet | the two tier-C catalogue entries and their polars | **only after routing** |

**The hazard, concretely.** Merge picker + fleet WITHOUT routing and every plan is solved on the
wrong hull: `workerClient.ts` still passes `DEFAULT_BOAT_ID`, `protocol.ts` resolves the Salona 45,
and `PlanDeps.boat` supplies **both** the polar tables (`planRoute.ts`'s
`polarKey(deps.boat.id, sailId)`) and the §C.4(a) relaxation floor (`relaxationFloorM(deps.boat)`).

For the two boats §N.1 actually ships, the live consequence is the **polars**, and it is silent:
both fleet entries use the sail ids `genoa` and `fock`, so `polarKey('salona-45', 'genoa')` hits a
real committed table and nothing throws. Every ETA and every leg for PIRANJA or SPEEDY GO! would
come from the Salona 45's speed table while the picker shows that boat's name, its tier-C chip and
its keel sentence — the §N.5 honesty surface describing a table the solver never used.

The **depth** consequence is inert at this scope and becomes severe just past it, which is why the
gate is a rule about the catalogue rather than about these two boats: `relaxationFloorM(salona-45)`
is 2.1 m, which is *deeper* than PIRANJA's 1.90 m keel (over-cautious, harmless) and *identical*
for SPEEDY GO!'s 2.10 m. At the first boat past 2.10 m — the deferred Grand Soleil 46, 2.30 m,
illustrative here and **not in the v0.12.0 catalogue** — #53 relaxation reaches a **2.1 m gate
under a 2.30 m keel** while `SAFETY_DEPTH_FIELD.min` has already moved to that boat's own 2.4 m.
That is §L's *"single most dangerous shortcut in this feature"*, with the interface asserting the
opposite — worse than the pre-#54 state, where nothing claimed anything.

Note what makes it invisible: each branch is correct against its own diff, every gate passes on
each, and the composition appears in none of them. This repo already records that cross-PR
composition bugs survive per-PR review and need a sweep over the cumulative diff; this is that
class, caught before the merge rather than after.

**Consequence for the release runbook's fold step:** if the fleet entries slip out of a release
that ships the picker, `changelog.d/54-2.added.md` describes **every capability it names** — six
clauses, including picking a boat, the clamp, the keel sentence, the withdrawn-boat fallback, the
remembered choice and the safety-depth field's own minimum following the selection — all of which
are **unreachable in a one-boat catalogue**. Changelog prose carries the same evidentiary standard as code here and freezes into a
versioned section at the cut, so the fragment must be re-scoped or held back with the entries.

### N.7 What is deferred, and why — so it is not read as forgotten

- **Grand Soleil 46 (MARIN)** and **EASY GO! (Salona 44, 2.55 m)** — deferred together, but no longer for one
  reason. EASY GO!'s 3.5 m gate leaves two
  harbours unreachable; MARIN's 3.2 m gate leaves none, and adds only `faldsled` to the
  `shallow-approach` `marstal` every catalogue boat already carries. For EASY GO!, §L's *"Treat a harbour dropping out at a deeper boat's gate as a defect"* row
  stands: **the routing is correct — a 2.55 m keel cannot enter a 2.0 m basin —
  and the defect would be silently offering it.**
  **Re-measured 2026-09-16, and both of this bullet's original claims — the per-gate
  harbour counts and the missing presentation — are superseded.** Those counts applied an
  exact-snap-cell predicate to a 33-harbour, pre-#295 mask. The snap-aware measurement — real `snapToNavigable` with its 300 m search
  and one-disc relaxation, over the 40 harbours `app/public/data/harbors.json` carried on 2026-09-16 —
  gives MARIN (2.30 m, gate 3.2 m) **33 ok with `faldsled` and `marstal` shallow-approach and
  none unreachable**, and EASY GO! (2.55 m, gate 3.5 m) **31 ok, `faldsled` and `rudkoebing`
  shallow-approach, `augustenborg` and `marstal` unreachable**. Against the post-#295 mask the
  exact-snap predicate fails eleven harbours at 3.5 m; seven of those eleven snap within 300 m
  to a connected cell and are `ok` under the spike's snap-aware classification (spike §3).
  Source: `docs/spikes/1135-boat-picker-gate-design.md` §3 — a Node port whose flood-fill half
  is controlled against `verify_mask.py` but whose snap and relaxation halves are uncontrolled
  beyond the Salona 45's `marstal` row, which §3 keeps as a router-side control, and neither
  deferred hull is in `BOATS`, so no committed test pins these two rows. Treat them as the
  spike's measurement, not as verified fleet data.
  And the presentation now EXISTS: per-boat access is derived at runtime by
  `app/src/lib/harborReachability.ts` (#1290) and shown as a marker in the pickers (#1291) and
  the Boat tab (#1292). So what still blocks these two hulls is the polar sourcing below, plus
  draft sourcing — §N.2 and §M item 8 for EASY GO!, §M item 1's §C.5 caveat for MARIN — no
  longer the missing presentation.
  **Amended 2026-09-30 (maintainer ruling, #1575):** EASY GO! is no longer deferred. It ships at tier C, 2.59 m, gate 3.5 m, sharing SPEEDY GO!'s tables (§O); MARIN stays deferred. (Tables since 2026-10-15: its own, §P.) Three claims above are now false for EASY GO!: the `shallow-approach` `marstal` "every catalogue boat already carries" (EASY GO! reads it unreachable); "neither deferred hull is in `BOATS`"; and its consequence "no committed test pins these two rows", since `app/src/test/harborReachability.test.ts`'s `EXPECTED_ACCESS` now pins EASY GO!'s row. The eleven exact-snap failures at 3.5 m are listed in `pipeline/verify_mask.py`'s `EXPECTED_UNREACHABLE_BY_BOAT`; a snap-aware check is #1584.
  **Amended 2026-10-01 (#1584):** the per-boat check is now snap-aware, so `EXPECTED_UNREACHABLE_BY_BOAT` lists four harbours for EASY GO! at 3.5 m: `augustenborg`, `faldsled`, `marstal`, `rudkoebing`.
- **The other six models.** Not Flensburg-stated; two of them (2.25 m, 2.30 m) also cross 3.2 m.
- **Tier B for any fleet model.** Blocked on three items, none of which is a research question:
  donor-hull identity per keel, a reproducible white-sail downwind correction (the shipped `fock`
  note's 23-boat ratio study coefficients are **not in this repository**), and licence/ToU for
  redistributing certificate-derived tables in a public app.
  *Amended 2026-10-15 (§P), EASY GO!'s `fock` only:* (1) donor identity: a named hull, ORC-measured draft recorded, deep keel inferred from that draft (the certificate has no keel field); (2) discharged, the donor is a Non-Spinnaker certificate; (3) proceeds for the derived tables on the Salona 45 precedent (ORC certificate AUT 035/26: values plus a note); the committed source records go beyond that precedent and rest on the maintainer's acceptance. Not a release gate; ORC's reply is open (§P.12). The genoa stays tier C (§N.4), so the deterministic-pair check never applies to it.
- **§M.4's tie-band measurement.** **Discharged by construction here, not waived**: it gates
  whether an estimated-polar boat may present a **`decided` verdict**, and a boat presenting
  `not-compared` presents none. It becomes a hard prerequisite again the moment a tier-C `decided`
  verdict is proposed — and must then be paired with a check that the two tables are **not a
  deterministic function of one another**, because perfectly correlated perturbations would make
  §M.4 report *"uncertainty does not dominate"* for a comparison that is vacuous rather than noisy.
  The criterion measures noise; that defect is vacuity.

### N.8 Corrections to earlier sections

- **§M.2 is no longer unmeasured.** `verify_mask.py` already reports the deepest gate at which each
  harbour reaches open water; it was run 2026-08-18 (exit 0, ~2 s, no writes). Harbours failing to
  reach open water, per gate: **2.8 m** — marstal; **3.0 m** — marstal, augustenborg; **3.2 m** —
  plus aabenraa, faldsled; **3.4 m** — plus langballigau; **3.5 m** — plus fynshav and rudkoebing,
  which both reach open water at exactly 3.4 m. Navigability is monotone in the gate, so
  the set of harbours that DO reach open water only grows as the gate falls — each failing set
  above is a subset of the one below it. This is what made §N.1's scope selectable rather than
  guessable, and it retires §M.2's "unmeasured" status while leaving §L's mask-refinement row
  untouched.
  **Superseded as a reachability statement, 2026-09-17.** That run predates #295, so it covers
  **33** harbours against the 40 of 2026-09-16, and its predicate is the exact snap cell rather than what
  the app does. Read the per-gate sets above as a record of what the 2026-08-18 run reported,
  never as today's reachability: §N.7 carries the snap-aware 40-harbour figures, and for the
  three CATALOGUE boats the committed authority is `pipeline/verify_mask.py`'s per-boat
  connectivity loop — `KNOWN_DISCONNECTED` (five, boat-independent), an empty
  `EXPECTED_UNREACHABLE_BY_BOAT`, and the `CONNECTIVITY_EXCEPTIONS_M` rows that give `marstal`
  and `augustenborg` a lowered effective gate. Its Python job (`verify-mask.yml`) is advisory,
  but `app/src/test/verifyMaskConnectivity.test.ts` re-reads all three literals and re-runs the
  same per-boat fill inside the REQUIRED `app` check. No shipped boat reaches its own default
  gate with a harbour unreachable beyond those five — `marstal` at every catalogue gate, and
  `augustenborg` at 3.0 m, only under a documented exception.
  **Amended 2026-09-30 (maintainer ruling, #1575):** four catalogue boats, not three, and `EXPECTED_UNREACHABLE_BY_BOAT` is no longer empty: it lists the eleven harbours EASY GO! fails at its 3.5 m gate under the exact-snap predicate. So one shipped boat now reaches its default gate with harbours unreachable beyond the five — in-app, `augustenborg` and `marstal` for EASY GO!.
  **Amended 2026-10-01 (#1584):** the per-boat loop now judges the cell the app snaps each harbour to, so EASY GO!'s list is four harbours, not eleven. The `(augustenborg, 3.0)` exception is gone: augustenborg's snapped cell reaches open water at 3.0 m unaided. `marstal` is the only harbour a `CONNECTIVITY_EXCEPTIONS_M` row still lowers.
- **§G.3 rule 2** ("*not designed here*") is now designed, by §N.4–N.6.
- **§K's release-1 acceptance** ("*reduces to today*") no longer describes the catalogue. It
  remains the correct statement for the **Salona 45 row** and must be re-scoped, not deleted:
  with three catalogue entries, R2/R3/R8 stop being vacuous. It does **not** follow that the sweep
  exercises a second gate: `app/sweep/sweepArms.ts` builds every arm from
  `boatById(DEFAULT_BOAT_ID)`, so growing the catalogue changes no arm. That needs a per-boat arm,
  which this amendment does not specify. *Amended 2026-09-30 (#1575):* four entries; no EASY GO! sweep arm this cycle (maintainer ruling). Separately, and older: since #653 an arm may name its own `boatId` (`app/sweep/sweepArms.ts`), so "every arm" above is stale.
- **Three code assertions enforce OQ-7 and now contradict it**: `app/src/data/boats.test.ts`'s
  *"release 1 ships exactly the Salona 45"* and *"ships no estimated-tier sail in release 1
  (OQ-7)"*, and `app/src/test/maskTolerance.test.ts` R1's `EXPECTED_BOAT_IDS = ['salona-45']`. All
  three sit in the **required `app` check**. They must be amended deliberately in the same PR, each
  with its own written rationale — **never quietly deleted**.

### N.9 §L rows — status under this amendment

Overruled: **`[OQ-7]` ship tier-C estimated polars in release 1** — the subject of this amendment.

Newly load-bearing, in force: *reuse the Salona 45's anchors* (E3/E4 make it mechanical);
*source-note-only disclosure* (§N.5 satisfies it); *model displacement in the boat record*
(displacement is now an estimator input and must stay out of `BoatDef`); *reuse `BOAT_DRAFT_M` for
the Salona 44* (directly engaged — the Salona 44 is in scope); *ship the fleet at today's 3.0 m
default* (load-bearing: both new gates derive to ≤ 3.0).

Not engaged by this scope: *refine the mask for deeper boats* and *treat a harbour dropping out as
a defect* — no boat in scope is deeper than 2.10 m. Both become engaged by §N.7's Grand Soleil and
EASY GO! follow-up.

Explicitly **not** breached: *`[OQ-3]` generalise `RigRecommendation` to N-way*. Adding a
`not-compared` variant is not N-way generalisation; the cap stays at 2 and no N-way tie semantics
are defined. *Amended 2026-10-15:* §R.4 now defines them as design only; still not breached, because nothing N-way ships while `MAX_HEADSAILS = 2`.

All remaining rows are in force, untouched.

---

## O. Amendment 2026-09-30 — EASY GO! ships at tier C (#1575)

**Status:** maintainer ruling 2026-09-30 (v0.50.0 triage). #1575 splits EASY GO! out of #573, which keeps the certificate work. This supersedes EASY GO!'s deferral in §N.1, §N.2 and §N.7. It also exempts a `polarsFrom` borrower from §N.6's own-anchors rule (the note there) and re-classifies three of §N.9's §L rows (below). It also takes EASY GO!'s draft a conservative step beyond §N.2's operator-sheet source (Entry, below). Every other §N decision stands.

- **Entry.** The fourth catalogue entry, with no certificate of its own. *2026-10-15 (§P):* its `fock` is tier B and its `genoa` tier C; "tier C" in this section's title and below is the 2026-09-30 record. Draft **2.59 m** (§M.8): the operator's per-vessel page lists 2.55 m (https://skipperteam.de/toerns/yachten/salona-44-easy-go, read 2026-09-30); Cruising World's model review gives 2.59 m for the racing keel (https://www.cruisingworld.com/salona-44/); the deeper figure is taken. Neither is from the hull's own papers. §N.2's accepted cost covers the operator figure; 2.59 m is a conservative step beyond it, accepted by this ruling.
- **Depth.** Default gate `ceil₁₀(2.59 + 0.9)` = **3.5 m**, a third distinct default gate beside 2.8 m and 3.0 m. Relaxation floor `ceil₁₀(2.59)` = **2.6 m**. `gate − T` = 2.6 m ≥ 2.59 m, so §C.3's inequality (R3) holds; the equality §C.2 records does not hold for this boat, and §C.4(b), R4 and R5 read the ceiling form (notes there).
- **Polars.** *Superseded 2026-10-15 by §P:* EASY GO! has its own tables — `fock` tier B from a sister hull's ORC Non-Spinnaker certificate, `genoa` tier C (that table × the Salona 45 ramp, clamped at 1), comparison still `not-compared`; the rest of this bullet is the 2026-09-30 record. Shares SPEEDY GO!'s tables and sanity anchors through `polarsFrom` (#567), which realises §J OQ-4's sister-ship sharing. Its `polarProvenance.note`s are byte-identical to the donor's; the sister-ship and deep-keel caveat lives in its own `draftProvenance.note` (§N.5's keel sentence). The shared table carries no keel difference (§N.3: the estimator cannot fix a wrong keel). Tier C, so the comparison is `not-compared` (§N.4). Anchor rules: the notes in §H and §N.6.
- **Defaults.** `Genoa`/`Jib` labels and the 6.5 kn / 45 s motor and manoeuvre defaults, the same literals as SPEEDY GO!'s (6.5/45 are the app's unresearched defaults on every fleet entry). *2026-10-15:* unchanged (§P.1 row 8).
- **Harbours.** Eleven harbours fail `verify_mask.py`'s exact-snap check at 3.5 m and are listed in `EXPECTED_UNREACHABLE_BY_BOAT`; a snap-aware check is #1584. In-app at defaults, `augustenborg` and `marstal` read unreachable — correct routing, disclosed by the per-boat marker (§C.6).
  **Amended 2026-10-01 (#1584):** the check is now snap-aware and lists four harbours; `faldsled` and `rudkoebing` among them read `shallow-approach` in-app (reachable only through a relaxed approach).
- **Sweep.** No EASY GO! arm this cycle. *2026-10-15:* §P adds none either; §S.6 adds EASY GO! router arms post-trip.
- **§L rows.** Engaged by this boat and in force: *treat a harbour dropping out as a defect*, *refine the mask for deeper boats*, *ship the fleet at today's 3.0 m default*. *Reuse the Salona 45's anchors* is not breached by its letter (the shared anchors are SPEEDY GO!'s), but its reasoning — an anchor validating a different hull — is engaged and accepted by this ruling. OQ-6 stays open. This ruling answers only its "which vessels ship" half, and only for EASY GO!, whose certificate half stays with #573.

## Amendment 2026-10-15 — EASY GO!'s own polars, the sail inventory, en-route sail changes (§P, §R, §S)

**Status:** maintainer decisions 2026-10-15. Trip 22–24 Oct. The pre-trip release (~19 Oct) is §P phase 1 plus §R slices S1–S2 only. §S, including the crossover advisory it absorbs (§S.11), is post-trip. §S.11 is the crossover advisory. Reviews of all four drafts ran 2026-10-15; findings are folded in.

**Cross-cutting decisions (bind §P, §R, §S):**

1. **Spinnaker slot.** A downwind sail lives in `BoatDef.downwindSails`, never in `sails[]`, and is never a standalone solve or results tab. Its table is the builder's ORC VPP symmetric-spinnaker table, verbatim, rows TWA ≥ 110° (§P.5).
2. **Lineage field: `derivedFrom`** (§R.3), everywhere; an `origin` union was considered and is not adopted. Pipeline twin: `derivation.fromSailId`. Source-document identity: `derivation.sources` (§P.6).
3. **One derived-pair rule for router and advisory: decide with a larger margin and a label** (user decision 2026-10-15). A change between two headsails where one is `derivedFrom` the other is planned (§S) or hinted (§S.11) only when the estimated gain beats the penalties plus `U` plus `OVERLAY_BOUND` (§S D4). Change points and the ETA are labelled "estimated (genoa derived from jib)" (§S D13). The router runs with the estimated genoa aboard. The whole-route ★ stays tier-keyed (§N.4), so EASY GO!'s ★ stays suppressed. Suppressing derived pairs was considered and rejected (S.9). On the shipped EASY GO! tables no genoa↔jib swap clears that margin (genoa/jib ≤ 1.054, §S D1/D4), so in practice the router plans only spinnaker set and douse until OQ-S1 is decided.
4. **Defaults — user-editable operational values, not polar-derived:** genoa↔fock swap 900 s; spinnaker set 300 s, douse 300 s, pole gybe 120 s, each the same while motoring; spinnaker max TWS 18 kn; genoa change-down limit 18 kn TWS.
5. **Unchanged:** `motorSpeedKn` 6.5 kn, `maneuverPenaltyS` 45 s. Currents stay out (`docs/spikes/18-currents-source-quality-gate.md`).

---

## P. EASY GO! gets its own tables

Supersedes §O's *Polars* bullet, §N.6's EASY GO! anchor exemption, §M.6's endpoint claim and EASY GO!'s build year in §N.2. §N.7's tier-B blockers for EASY GO!'s `fock`: (1) and (2) in §N.7's 2026-10-15 amendment, (3) the licence in P.8. Every other §N/§O decision stands, including §N.4's suppression.

### P.0 Objective

| Table | Tier | Role | Phase |
|---|---|---|---|
| `fock` | B `modelled` (§G.3 row B) | white-sail jib, full grid, anchored on a sister hull's ORC data | 1 — pre-trip |
| `genoa` | C `estimated` (§N.4) | `fock` × Salona 45 genoa/fock ratio, clamped at 1 | 1 — pre-trip |
| `spinnaker` | B `modelled` | symmetric kite with pole, **en route only**, TWA 110–180°, TWS 6–20 kn | 2 — with §S |

The genoa is tier C by the user's ruling and §N.4's definition, so existing suppression, boat chip and §N.5 surface cover EASY GO! with no new code or string. Phase 2 waits for §S, because nothing else reads a spinnaker table. `polarProvenance.test`'s "every declared sail is claimed" row: an unconsumed table would red that row once P.9 extends it to `downwindSails`.

### P.1 Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | EASY GO! leaves `polarsFrom` for a full record in `polars-source.json` (`tws/twa/beat/gybe/validation/sails`). `draftM: 2.59` unchanged (`verifyMaskBoatGate.test`). `validation.maxSpeedKn: 12`, `maxSpeedKnSource`: *"judgement - one knot above the 11 kn reaching figure of a model sea trial (25 kn wind); the ORC certificate peaks at 10.55 kn in the held 24 kn column"*. Labels stay `Genoa`/`Jib`. | `build_polars.mjs` aborts without both fields; `validate()` is strict `<`. Area-bearing labels would dress the donor's 41.66 m² jib as this boat's. |
| 2 | `fock` = the 2026 ORC **Non-Spinnaker** certificate of SANTA ANASTASIA (CRO 1938, RefNo `04590004MKR`), cell by cell. The builder polargraph (VPP 1.11, CRO 2009) is cross-check and anchor source, never blended. | Current VPP, white-sail, TWS 4–24 (polargraph: 6–20). A blend matches neither and kills the cross-check (#50). |
| 3 | `fock` is tier B; row A unamended. | Same model, different configuration: donor ORC draft 2.415 m, main 58.48 m², jib 41.66 m², measured 9,300 kg; EASY GO!'s jib area, loading, trim, keel unknown. Rewording row A would demote the Salona 45 fock. |
| 4 | `genoa` = `fock` × `max(1, S45.genoa/S45.fock)` per cell; `estimated`. | P.4; §N.4. |
| 5 | `spinnaker` = polargraph "Symmetric Spinnaker", rows TWA ≥ 110°, verbatim on its native axes; outside `valid` it is `null`, never `0`. | P.5. |
| 6 | Draft 2.59 m; `draftProvenance.note` reworded (P.7); build year dropped from the spec. | Safe direction; 2.55 m gives the same 3.5 m gate and 2.6 m floor. |
| 7 | SPEEDY GO! and PIRANJA untouched; SPEEDY GO! is no longer a donor. | P.12 Q5. |
| 8 | `motorSpeedKn` 6.5, `maneuverPenaltyS` 45. | A model sea trial (6 kn @ 2,500 rpm, 8.6 kn @ 3,600 rpm) does not contradict 6.5. |

### P.2 Sources, and what is committed

`https://data.orc.org/public/WPub.dll?action=DownRMS&CountryId=<NatAuth>[&Family=NS]&ext=json` serves **current-year certificates only**, so sources are committed with retrieval dates in new `pipeline/orc-sources/` (hand-authored; no script writes it). Records are embedded as parsed JSON (the response has a BOM and is re-serialised); `responseSha256` identifies the capture; D3's `sha256` covers the committed file.

| File | Content |
|---|---|
| `orc-ns-tur-santa-anastasia-2026.json` | `{url (…CountryId=TUR&Family=NS&ext=json), retrievedAt: "2026-10-15", responseSha256: "df23fe3f5300f73f8ff8999e64f7d0924f0505b4ebbb03fe39d00dd5595dcc1f", responseBytes: 204885, record}`. One record: the response holds 15 owners' records, two with a third party's phone number. |
| `orc-club-cro-calanthe-2026.json` | Same envelope, CRO 1914 Calanthe (RefNo `03620004H9R`, CLUB), response sha256 `64a3b85b24bc2b1e4a6e661b90c024ab0b37655bd3c7b28c76bd21c473faa0c3`, 1,343,165 bytes. Phase 2 only: not committed pre-trip (maintainer decision 2026-10-15). Spinnaker anchor evidence; lists `Area_Sym` 142.59 and `Area_Asym` 142.74 m². |
| `orc-vpp111-salona44-cro2009-polargraph.json` | Jib and Symmetric Spinnaker tables, TWS 6/8/10/12/14/16/20, per cell `{twa, btv, vmg, aws, awa, heel, reef, flat}` plus `(b)`/`(r)` rows, parsed via `pdftotext -layout`. Envelope: `https://web.archive.org/web/20110708161459/http://www.salonayachts.com:80/documents/Salona%2044%20polargraph.pdf`, PDF sha256 `06473140eacd5d3271a9a7a3428a775031e1dbf29be99f2481e6071a3c55acf3` (660,970 bytes), headers `Sail No: CRO 2009`, `Issued On: 8.12.2010 - VPP 1.11`. The PDF (© ORC 2010) is not committed. |
| `README.md` | Retrieval and re-fetch protocol, current-year caveat, licence basis (P.8). |

Unknown, recorded: CRO 2009's keel; the polargraph's kite area, and whether its "Jib" is the 61.1 m² genoa; EASY GO!'s headsail areas, trim, charter loading (donor `Dspl_Sailing` 10,578 kg incl. 920 kg crew vs 9,300 kg measured), keel, and any certificate of its own (OQ-6 open; one would replace this at tier A).

### P.3 `fock` — derivation

New `pipeline/derive_orc_polars.mjs` (method `orc-ns-cert-rows-v1`) takes its cell values only from `pipeline/orc-sources/*` (the grid and the genoa ramp come from `polars-source.json`'s Salona 45 entry) and rounds with `estimate_polars.mjs`'s `round2`. Grid = the Salona 45's, TWS `[4,6,8,10,12,14,16,20,25]` × TWA `[35,40,45,52,60,70,80,90,100,110,120,135,150,165,180]`, so the genoa ramp applies cell by cell.

**Allowance families** (s/nm at `WindSpeeds` `[4,6,8,10,12,14,16,20,24]`), not interchangeable:
- `R<twa>` is straight-line only while `BeatAngle ≤ twa ≤ GybeAngle`; beyond `GybeAngle` it is a gybing VMC: `R150 = Run × cos 30°` in **856 of 856** such cells (816 in the Croatian ORC-family response, 40 in the Turkish Non-Spinnaker response; 2,323 of 2,323 if the Turkish all-family response is used).
- `DW<twa>` is straight-line downwind. At SANTA ANASTASIA `DW150` is 1.7/1.5/0.9 % below `R150` at TWS 4/6/8.

**Source cells.** Speed = `3600/allowance` for `R52 R60 R75 R90 R110 R120 R135` and `DW150 DW165 DW180`; the generator **fails closed** if a used `R` row leaves `[BeatAngle, GybeAngle]` in any column. `Beat` is a VMG allowance: `V_b = (3600/Beat)/cos(BeatAngle)`. `BeatAngle`/`GybeAngle` become `beat.angle`/`gybe.angle` verbatim.

| Grid TWA (per column, `θb` = `BeatAngle`) | Value |
|---|---|
| 52, 60, 90, 110, 120, 135 | `R` cell |
| 150, 165, 180 | `DW` cell |
| 70, 80, 100; 35/40/45 at TWA ≥ `θb` | PCHIP (SciPy/MATLAB-style Fritsch–Butland slopes) through `{θb→V_b, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180}` (`R75` a knot only) |
| 35/40/45 at TWA < `θb` | `V_b × TWA/θb`, `Polar.speedKn`'s own below-table shape. `θb` = 47.2° at TWS 4, 37.7° at 20. |
| TWS 25 | the 24 kn column **held**; between 20 and 24 kn the app reads up to 1.76 % below the certificate (largest at R120: 10.36 vs 10.55), the conservative side except R35 (+0.35 %, below the beat angle) |

**Build asserts (P.10):** TWS-monotone in columns 4–20 (the certificate's 24 kn at TWA 35 is below its 20 kn); no grid row below `θb` beats the certificate's `Beat` VMG (grid rows only; runtime beat VMG through `Polar` is 0.989–1.000 × certificate); every cell `< maxSpeedKn`.

**Measured on the prototype, 2026-10-15:**
- vs builder polargraph Jib, 77 shared cells (11 TWA × 7 TWS): −5.2 … +9.0 %, mean −1.4 %, 71/77 within ±5 %, largest at 135°/6 kn. Two sister-hull VPP runs: **not an error bound for EASY GO!**, whose jib area, loading and keel enter neither side.
- vs shipped SPEEDY GO! tier-C fock, TWA ≥ 45°: −3.7 … +5.2 %. Rows 35/40 differ more: +19 % at 35°/4, +8.8 % at 35°/6, +7.0 % at 40°/4, −5.0 % at 35°/25. At defaults (motor on, floor 3.7 kn) the 4 kn cells motor either way; motor off, the floor is `motorThresholdKn` and they sail; 35°/6 (4.09 kn at factor 1.0, 3.68 at 0.9) sits on the floor, so its split can flip.
- No accuracy band is published.

### P.4 `genoa` — method and limits

Method `orc-jib-genoa-ramp-v1`: `genoa[i][j] = round2(fock[i][j] × max(1, S45.genoa[i][j]/S45.fock[i][j]))` on the recomputed `fock`. Ramp, % gain read off the shipped Salona 45 tables:

| TWA | 4 kn | 6 | 8 | 10 | 12 | 14 | 16, 20 | 25 (raw S45) |
|---|---|---|---|---|---|---|---|---|
| 35–100 | +5 | +4 | +3 | +1.5 | +0.5 | 0 | 0 | −2 |
| 110–120 | +4 | +3 | +2 | +1 | +0.5 | 0 | 0 | 0 |
| 135–180 | +4 | +3 | +2 | +1.5 | +1 | +0.5 | 0 | 0 |

**Clamp.** Unclamped, the raw 25 kn −2 % on the held 24 kn column makes the genoa slower than the jib for TWS in (20, 25), TWA 52–90 (−0.4 % at 21 kn … −1.6 % at 24): an artefact. Clamped, no crossover exists and none may be derived. Prototype: 56 of 135 cells equal `fock`, none slower, max gain 5.3 %.

**Limits (in the note):**
1. *Basis mismatch.* Certificate jib 41.66 m² ≈ 97 % of the foretriangle (I·J/2 = 42.78 m²); builder genoa 61.10 m² ≈ 143 %: ratio 1.47 vs the Salona 45's 1.23, bases mixed. The light-air step may be understated; no magnitude is claimed (a seven-certificate regression, R² 0.11–0.20, was dropped).
2. *Other direction.* From 16 kn the genoa gets the jib's speed, assuming optimal depowering; may be too high. No anchor tests the genoa's own uncertainty.
3. *No change-down information.* Genoa ≥ jib everywhere, equal from 16 kn. Change-down is operational (cross-cutting 4).
4. *Deterministic dependence* (§N.4): tier C, `not-compared`.

### P.5 `spinnaker` — derivation and plumbing (phase 2)

**Source** the polargraph Sym table, on its own axes, no inter- or extrapolation. **Lower TWA bound** (judgement, stated rule): the smallest tabulated TWA from which Sym > Jib at every TWS and every higher TWA. Sym − Jib positive at 75°: 1 of 7 TWS; 80°: 3/7; 90°: 5/7; **110°: 7/7 (+0.74 … +0.96 kn)**, and 120–180° likewise ⇒ **110°**, corroborated by the table's AWA (37–52° at 75–80°). TWS window 6–20 kn. `valid` is the VPP's data range, **not a handling range** (handling limits: §R D3).

Axes `twa [110,120,135,150,165,180]` × `tws [6,8,10,12,14,16,20]`; gybe angles `[141.5,145.8,148.7,156.7,163.8,168.8,175.4]` from the `(r)` rows; no `beat`.

**Cross-check:** Calanthe's 2026 CLUB certificate, an envelope over both its kites. Sym vs Calanthe (`DW150` at 150°): within 2 % at 135–180°; +2.6 … +5.7 % at 110°; +0.3 … +1.8 % at 120° to 16 kn, +5.1 % at 20 kn. The 110° row is least certain.

**Asset** `app/public/data/polars/salona-44-easy-go-spinnaker.json`: `{kind: "downwind", rig: "spinnaker", boat, tws, twa, speeds, gybe, valid: {twaDeg: [110,180], twsKn: [6,20]}, source}`; the build asserts `valid` = axis extents.

**Runtime contract:**
- Type `DownwindPolarTable` (`kind: 'downwind'`, `rig: 'spinnaker'` outside `SailId`, `valid`, `gybe`, no `beat`); class `DownwindPolar` with `speedKnOrNull(twaDeg, twsKn)` and `gybeAngleDeg(twsKn)`: `null` outside `valid`, no taper, no clamp, bilinear × `performanceFactor` inside.
- **Never in `PlanDeps.polars`, the init message's polars map or `loadRoutingAssets()`'s polars result** (all `Record<string, PolarTable>`, filled by an unchecked `fetchJson` cast). No `PolarTable.kind?`. Guards: `assets.ts` loads downwind tables via their own spec list with a runtime shape check; `planRoute` throws before `new Polar` on a `deps.polars` table with an own `kind` or no `beat` (worker-fatal; no new `RoutingFailureKind`/`SolveFailureCause`).
- A `null` candidate does not exist; it must never reach `isochrone.ts`'s `sailSpeed >= sailFloorKn → else motor` branch.
- Catalogue `BoatDef.downwindSails?: readonly DownwindSailDef[]` (`{id, label, polarAsset, polarProvenance}` + §R's `limits`). Pipeline: a `downwindSails` section with its own `grid`, `valid`, `validation` (`maxSpeedKn` 12, sourced); headsail anchors do not apply. Declared `?:`, never `undefined`; lookups `Object.hasOwn`. *Aboard* is §R's field; the table ships either way.

### P.6 Pipeline: `derivation` block, rules D1–D8

`requireEstimatorBlock` cannot carry a certificate-derived sail (E1's converse; RAMP needs an estimated base and scalar). New `derivation` block, three methods:

```jsonc
// fock (modelled)
"derivation": { "method": "orc-ns-cert-rows-v1",
  "donor": { "kind": "orc-cert", "relation": "sister-hull", "refNo": "04590004MKR", "yacht": "SANTA ANASTASIA",
             "sailNo": "CRO 1938", "measuredDraftM": 2.415, "areaJibM2": 41.66, "areaMainM2": 58.48 },
  "sources": [ { "path": "orc-sources/orc-ns-tur-santa-anastasia-2026.json", "sha256": "…" } ] }
// genoa (estimated)
"derivation": { "method": "orc-jib-genoa-ramp-v1", "fromSailId": "fock",
  "ramp": { "boatId": "salona-45", "fromSailId": "fock", "toSailId": "genoa", "clampMin": 1 }, "uncertaintyPct": 10 }
// spinnaker, phase 2 (modelled)
"derivation": { "method": "orc-vpp-sym-spinnaker-v1",
  "donor": { "kind": "orc-polargraph", "relation": "sister-hull", "document": "Salona 44 polargraph",
             "sailNo": "CRO 2009", "issued": "8.12.2010 - VPP 1.11", "pdfSha256": "06473140…" },
  "sources": [ { "path": "orc-sources/orc-vpp111-salona44-cro2009-polargraph.json", "sha256": "…" } ] }
```

| # | Rule |
|---|---|
| D1 | Method fixes tier: both sister-hull methods ⇒ exactly `modelled`; the ramp ⇒ exactly `estimated` with `uncertaintyPct` 10 (judgement). E1 forward widens to "an `estimator` block **or** a ramp derivation"; E1's converse stands (`modelled` + ramp, or both blocks, aborts). E5/E6 skip a ramp. Sails with neither block untouched. |
| D2 | `method` is a known id (`Object.hasOwn`). |
| D3 | Every `sources[].path` exists under `pipeline/orc-sources/` with matching sha256; `retrievedAt`, `url` and (certificate) `responseSha256` present. |
| D4 | `orc-cert`: complete, `relation === 'sister-hull'`, record `RefNo/Draft/Area_Jib/Area_Main` = donor block. `orc-polargraph`: `sailNo`, `issued`, PDF hash = envelope. A `ramp` names an existing boat and sails whose tables are not `estimated` (no estimate of an estimate, §N.3); `derivation.fromSailId` is another sail of the same boat. |
| D5 | Reproducibility (E7 analogue): re-running the generator reproduces `speeds`, `beat`, `gybe` (phase 2: `valid`, `twa`, `tws`) byte for byte; the genoa recomputes its `fock`. |
| D6 | Note tokens (case-sensitive): cert method — `SISTER HULL` + `refNo`, and no `modelled` note may contain `own ORC certificate` or `own certificate` (case-insensitive) (PR #1676); spinnaker — `sister hull` + `sailNo`; ramp — `ESTIMATED` + `ramp`. |
| D7 | No anchor `source` cites the same sail's `derivation.sources`; no anchor repeats another boat's `(twa, tws, minKn, maxKn, source)` (E4 generalised; E4 walks only estimated sails today). |
| D8 | Existing structural checks unchanged. |

`polars-source.json` is edited by script, never `Edit`/`Write` (the prettier hook reflows it): `derive_orc_polars.mjs --emit-boat salona-44-easy-go` prints the block, a `python3`/`sed` step replaces the borrower block. `--check` runs inside `build_polars.mjs` (D5). `buildPolars.failClosed.test.ts`'s `run()` must also plant the generator and `orc-sources/` (`PLANTED`).

### P.7 Texts

Each note is identical in `boats.ts`, `polars-source.json` and the asset's `source` (`polarProvenance.test`) and passes `boats.test.ts`'s #595 rows (no internal sail id — `fock` is internal, labels say "Jib" — no `#\d+`, `spec [A-Z]`, `OQ-\d`, catalogue id). ASCII hyphens; none of *accurate/verified/reliable/safe*.

`fock` — *Tier B, MODELLED - this boat's own table, anchored on a SISTER HULL's ORC certificate, not on a certificate of this boat. Source: ORC Non-Spinnaker certificate 2026 for the Salona 44 SANTA ANASTASIA (CRO 1938, RefNo 04590004MKR), issued 2026-04-22, retrieved 2026-10-15; deep keel (inferred from its ORC-measured draft of 2.415 m, the certificate has no keel field). It is that hull's white-sail polar in its 41.66 m2 jib configuration, read onto the app grid; this boat's own jib area, loading and keel are unknown, and the sign of the resulting error is unknown. Against the builder's ORC VPP 1.11 jib polar for another Salona 44 sister hull (2010, CRO 2009) the table differs by -5% to +9% per cell; that compares two sister-hull VPP runs and is not an error bound for this boat. Below about 8 kn the table decides between sailing and motoring, so a leg may be motored that would sail, or the reverse. Flat-water racing VPP - tune with the performance factor. NOT race-calibrated, and never measured against this boat.*

`genoa` — *Tier C, ESTIMATED - this boat's jib table (see the jib note: a sister hull's certificate, not this boat's) multiplied cell-by-cell by the Salona 45's documented genoa overlay ramp, i.e. its genoa table divided by its jib table, never below 1 (about +4-5% at 4 kn, +3-4% at 6, +2-3% at 8, +1-2% at 10, nothing from 16 kn). The ramp was set for a smaller genoa/jib step than the 61.10 m2 furling genoa the builder lists for the Salona 44 (this boat's own headsail areas are not known), so the light-air gain may be understated; from 16 kn the genoa is credited with the jib's speed, which assumes it is depowered optimally and may be too high. The difference between this boat's two tables is therefore a function of THAT RAMP, not of this hull, and carries no information about it - which is why the sail comparison is withheld rather than presented as a finding. Below about 8 kn the table decides between sailing and motoring, so a leg may be motored that would sail, or the reverse. Same grid and angles, and the same uncertainty, as the jib table. Flat-water racing VPP - tune with the performance factor. NOT race-calibrated, and never measured against this boat.*

`spinnaker` (phase 2) — *Tier B, MODELLED - symmetric spinnaker with pole, from the builder-published ORC VPP 1.11 polar of a Salona 44 SISTER HULL (CRO 2009, issued 8.12.2010 as printed), not a certificate of this boat; spinnaker area and keel of that hull are not stated. Valid only for true wind angles 110-180 degrees and 6-20 kn; outside that range there is no value, not zero, and the range is the table's data range, not a handling limit. The 110 degree row is the least certain (a 2026 sister-hull certificate reads 2-6% lower there). Whether this boat carries a spinnaker is not confirmed. For en-route planning only. Flat-water racing VPP - tune with the performance factor. NOT race-calibrated, and never measured against this boat.*

`draftProvenance` (EASY GO!; `keel: 'deep racing keel'`, `hullVerified: false`) — *Deep (racing) keel, 2.59 m. Sources disagree: the builder's technical data lists 2.10 / 2.55 m for the two keels, the operator’s page for this boat gives 2.55 m, and a published review 2.59 m, whose own imperial figure (8 ft 4 in) reads 2.54 m; six ORC-measured Salona 44 hulls of the deeper-keel group read 2.415-2.441 m. ORC drafts are measured at the certificate's measurement displacement (9,300 kg for the donor, against 10,578 kg sailing), so the setting should not be lowered toward them. The deeper figure is used so the derived depth gate is not too shallow; 2.55 m gives the same 3.5 m gate. Not checked against the hull's own papers. The polar tables come from a sister hull measured at 2.415 m, so the speeds carry no keel term for this boat.*

`boats.ts` comments on EASY GO! borrowing SPEEDY GO!'s assets are rewritten; SPEEDY GO!'s `(built 2014)` stays (P.12 Q4).

### P.8 Licence, and doc edits outside the spec

**Licence (§N.7 blocker 3).** The Salona 45 precedent (`a0ba92e`: derived cell values and a citation note, no source record) covers the committed TABLES. The P.2 source records (one ORC record per certificate and the builder-polargraph excerpt) go beyond it; they ship on the maintainer's acceptance of that exposure, and ORC is asked in parallel. Not a release gate. `pipeline/orc-sources/README.md` records the basis.

Same PR, outside the spec:
- Test comments: `boats.test.ts` "// #1575: tier C by sharing SPEEDY GO!'s estimated tables (#567)." and `assets.test.ts` "(six: EASY GO! shares SPEEDY GO!'s two, #567)".
- `README.md`: every sentence saying EASY GO! shares/reuses SPEEDY GO!'s tables or that all three fleet boats are estimated (L16, where "three sets of polar tables" becomes four; L65; ~L177–181; ~L232–238) plus the diagram (~L315). Enumerate at implementation with `grep -n "SPEEDY GO!'s\|reuses\|shares" README.md docs/acceptance.md`; line numbers are hints. The two test comments above are updated in the same PR.
- `docs/acceptance.md` (~L98–102, ~L275): own tables, jib Modelled, genoa Estimated.
- `pipeline/README.md`: derivation block, `orc-sources/`, re-fetch protocol.
- `changelog.d/<n>.changed.md`: one fragment, no decimals; it states that saved EASY GO! plans from before this release keep their old polar notes.
- Root `CLAUDE.md` (main session): "the rest are tier-C estimates (… `polarsFrom` …)" stops being true for EASY GO!.

### P.9 Guards that red, and the sweep

| Guard | Change |
|---|---|
| `polarProvenance.test.ts` borrower row (`toEqual(['salona-44-easy-go'])`) | → `[]` with rationale; the loop goes vacuous, so the `#567` fixtures in `buildPolars.failClosed.test.ts` are the live control. `polarsFrom` stays (OQ-4). |
| `polarProvenance.test.ts` per-sail rows | Read EASY GO!'s own record. New: a `derivation` block on every non-Salona-45 `modelled` and every ramp-derived `estimated` sail; D6 tokens; (phase 2) "every declared sail is claimed" covers `downwindSails`. |
| `boats.test.ts` tier map | `salona-44-easy-go/fock` → `'modelled'`. **"A tier-C boat is tier C in EVERY sail" reds**; amended: a mixed set only where the estimated sail ramps off a same-boat sail (D1). `comparisonSuppressed` is `some`, so it still suppresses. |
| `assets.test.ts` | `EXPECTED_FETCHES` 10 → 12 (unchanged in phase 2: the downwind loader is separate, R.9, and gets its own count row); the two SPEEDY GO! `toBe` identity rows go. |
| `buildPolars.failClosed.test.ts` | Byte-identical control gains the new files; a D1–D8 describe, each with a red mutation; one row for widened E1. |
| `verifyMaskBoatGate.test.ts` | Pins `draftM`/gate parity for the new record. |
| boats.test.ts EASY GO! draft row | its toContain('The operator’s page for this boat gives 2.55 m') pin must match the reworded note; amended deliberately, never deleted |
| `realmaskFixtures.ts` | EASY GO! keys point at its own two assets; comment rewritten (closure file, covered by the owed sweep) |
| Sweep (#282) | `app/public/data/**`, `pipeline/**`, `boats.ts` are in the closure: OWED. Prediction, posted before the run: every arm byte-identical BASE vs HEAD (no arm names EASY GO!; `PlanRequest` untouched). Falsifier: any arm hash moves. No duration quoted. **Fallback:** sweep or CI not green by ~19 Oct ⇒ this does not ship; EASY GO! stays on SPEEDY GO!'s tables. |
| Persisted plans | `recalc`/`replan`/`reroute` reuse the stored snapshot while the worker solves with `boatById` (`protocol.ts`): a recalculated pre-amendment plan uses the new tables with its old notes. **Accepted 2026-10-15:** no snapshot refresh (#538 hazard). Tier and verdict still agree (`not-compared`, estimated label); only note text differs. |

### P.10 Acceptance

1. `derive_orc_polars.mjs --check` exits 0, naming each table.
2. D5: a certificate `Allowances` cell changed in a scratch `orc-sources/` (hash updated) reds naming `salona-44-easy-go/fock`; a committed `speeds` cell changed instead also reds.
3. D3: one byte of the committed record changed without `sha256` reds.
4. D6: `SISTER HULL` deleted from the `boats.ts` fock note alone reds `polarProvenance.test`; from all three, D6.
5. D7: SPEEDY GO!'s anchor pasted onto EASY GO! reds; E4 alone does not.
6. `salona-44-easy-go-{fock,genoa}.json` are 15 × 9; `beat`/`gybe` = certificate (24 kn in column 25); cells > 0 and `< 12`; TWS-monotone in 4–20.
7. Rows 52/60/90/110/120/135 = `round2(3600/R)`, rows 150/165/180 = `round2(3600/DW)`, columns 4–20. Mutation: row 150 on `R150` reds at every TWS column except 10 kn. A planted `GybeAngle` below a used `R` row aborts the generator.
8. Every grid TWA < `BeatAngle`: `speed × cos(TWA) ≤ 3600/Beat`. Through `Polar.speedKn`, the best VMG over a 0.1° sweep is in `[0.98, 1.005] × 3600/Beat`. Mutation: no taper reds.
9. Vs the committed polargraph excerpt (77 Jib cells): each delta within 0.5 pt of the committed delta; envelope in [−10 %, +10 %]. Mutation: +20 % on 90°/10 kn trips the P.3 monotone assert first; with that assert removed, it reds both.
10. Headsail anchors (polargraph Jib about ±10 %, rounded to 0.05 kn): A1 52°/12 `[7.3, 8.9]`; A2 90°/8 `[6.8, 8.35]`; A3 135°/10 `[5.5, 6.8]`; A4 180°/12 `[5.4, 6.6]`. Polargraph 8.10/7.56/6.14/6.00; fock 7.92/7.27/6.60/5.88; genoa 7.96/7.48/6.70/5.94. They catch an index or unit slip, not this boat's error. A3 leaves 0.05 kn over the genoa against the exact bound: a > ~1.5 % genoa rise at 10 kn re-derives A3.
11. Genoa ≥ fock everywhere; equal at 16/20/25 kn (all rows) and 14 kn (rows 35–120); strictly greater at 4–12 kn and at 14 kn rows 135–180; 56 cells identical. Mutation: no clamp puts nine 25 kn cells below the fock.
12. `boatById('salona-44-easy-go').sails` is exactly `genoa` (`estimated`), `fock` (`modelled`); notes pass D6 and #595; no `downwindSails` in phase 1.
13. `planRoute` for EASY GO! is `not-compared`, `weakestPolarTier` reads `estimated`, no UI string added.
14. A pre-amendment-snapshot fixture, recalculated, renders `not-compared` and the estimated label; assert the loaded polar asset path, not the snapshot.
15. The picker renders the new notes at ≥ 820 px without horizontal overflow.
16. Sweep: all arms byte-identical BASE vs HEAD.
17. *Phase 2:* `speedKnOrNull` is `null` at (109°, 10), (90°, 12), (110°, 5.9), (180°, 20.1), (60°, 12), a number at (110°, 6), (180°, 20). Mutation: out-of-window `0` reds the unit row and the router row "a `null` candidate is skipped, not motored".
18. *Phase 2:* `valid` = axis extents; the lower bound = its recomputation from the excerpt (mutation: Jib at 110°/20 above Sym moves it to 120°, reds). Spinnaker anchors, Calanthe ±8 % (derived): 180°/12 `[5.85, 6.87]`; 150°/8 `[5.23, 6.15]`; 135°/16 `[8.58, 10.08]`; 110°/10 `[7.61, 8.93]`.
19. *Phase 2:* a `DownwindPolarTable` cast into `deps.polars` makes `planRoute` throw before `new Polar`; `assets.ts` rejects downwind-shaped JSON in the headsail loader.

### P.11 Considered and rejected

| Option | Why it lost |
|---|---|
| Keep `polarsFrom` SPEEDY GO! | A scalar indefensible for a 0.5 m deeper hull; stays the fallback (P.9). |
| Genoa tier B | A ramp-made ★ (3 % of an hour = 108 s > `RIG_TIE_BAND_MS`); §N.4/§N.7; user ruling. |
| Genoa B + lineage suppression + new label | New field, twin and string pre-trip to reproduce tier C. |
| Polargraph Jib as primary; blend of both | TWS 6–20 only, VPP 1.11, unknown keel; a blend matches neither and kills the cross-check. |
| Seven-certificate regression | n = 7, R² 0.11–0.20, regressor span 0.07 vs a 0.17 step; not even a bound. |
| Other Salona 44 CLUB certificates as donor | Spinnaker configuration, white-sail rows end at the reach; SANTA ANASTASIA is the only NS Salona 44 found. |
| Uniform area-ratio genoa; raw ramp; negative ramp above 18 kn | Over-credits 20+ kn, mixes bases; manufactures a crossover; invents numbers. |
| Rows 35–45 from Salona 45 ratios | Another hull's shape while the donor's beat point exists. |
| `R150` as row 150 | Gybing VMC where `GybeAngle < 150`. |
| Kite lower bound 75° | One +0.02 kn cell at AWA 37–52°. |
| Kite in `sails[]` or on the 15 × 9 grid; `PolarTable.kind?` | Enters `sailIds`/picker/`assemble`; fabricated or zero cells; a valid `solve()` input. |
| Kite below 6 kn by the jib ratio | Unsourced, where wrong advice is cheapest to believe. |
| Refresh snapshots on recalculation | #538 hazard; unneeded while the genoa is tier C. |
| Amend §G.3 row A | Demotes the Salona 45 fock. |
| Commit the whole ORC response or PDF | Third-party records incl. a phone number; ORC copyright. |
| Remove `polarsFrom` | OQ-4's mechanism, with fixture tests. |

### P.12 Open questions

1. **ORC's reply** on redistribution, asked in parallel; not a gate (P.8).
2. **Spinnaker aboard and its area.** The operator's page lists "Rollgenua, Fock, Spinnakerbaum, Spinnaker"; the user is unsure; area unknown.
3. **Donor keel** 2.415 m vs EASY GO!'s 2.55–2.59 m; no keel term. EASY GO!'s own certificate (OQ-6) would supersede.
4. **SPEEDY GO!'s "built 2014"** (`boats.ts`, §N.2) has no source read; a one-word `draftProvenance` edit, maintainer's call.
5. **SPEEDY GO! tier B** via ISTROS (AUT 24, 2.095 m, standard keel, 2026 CLUB) upwind/reach rows. Not proposed.
6. **A plain EASY GO! sweep arm.** Meaningful now; §S.6 adds router arms only.

---

## R. Sail inventory: the aboard set, downwind sails as data

Earlier sections: **§J OQ-3, §E** — the cap applies to comparisons (the aboard headsails); `MAX_HEADSAILS = 2` kept this release. **§L `[OQ-3]`, §N.9** — R.4 is an N-way verdict as design only; §L's other `[OQ-3]` rows stay in force. **§B** — narrowed: a downwind sail is data in `BoatDef.downwindSails`, never a standalone solve.

### R.1 Objective

The user picks the aboard headsails; each gets its own solve and tab. Two: today's verdict; one: "one sail planned". A downwind sail can be recorded aboard for §S, never solved whole-route. At default inventory, through S2, every request and `PlanResult` is byte-identical to today's; S4 adds `derivedFrom` to every snapshot (A3).

### R.2 Decisions

- **D1 — `sailIds` is the aboard-headsail set**, catalogue order, never click order: the #340 guard holds and "all aboard" = `sailIdsOf(boat)`. No second field.
- **D2 — Downwind sails in `BoatDef.downwindSails`** (P.5; confirmed 2026-10-15). `SailId` derives from `sails[]`, so every `boat.sails` consumer (`sailIdsOf`, `weakestPolarTier`, Boat-tab list, `POLAR_SPECS`, `SAIL_IDS`, `RIG_LABEL_KEY`, `lib/plan.ts`, `migratePlan.ts`, `sweepArms.ts`) stays headsail-only by construction.
- **D3 — One copy of "usable."** Coverage lives only in the asset's `valid` (`speedKnOrNull`). Operational limits are a required `limits` on `DownwindSailDef`, owned here, user-editable; defaults max TWS 18 kn, TWA window [110°, 180°]; max-AWS default open (R.15). The genoa change-down limit is a like field on the headsail (default 18 kn TWS). `sailUsableAt` combines both; every consumer calls it.
- **D4 — `PlanRequest.downwindSailIds?`.** Absent = none; a subset of the snapshot's downwind sails; routing ignores it.
- **D5 — `PlanRequest.hoistedSailId?`** ∈ `sailIds`. Absent = unknown, which on the new-plan path means today's "chosen in harbour at no cost"; never so on a Live reroute. The pre-trip solver ignores it.
- **D6 — Omit when default**, never `undefined`.
- **D7 — Snapshot lists the aboard sails only:** `boatSnapshot(boat, aboard?)` filters `sails[]` (§I.3's "the sails this plan compared"); aboard downwind sails in a separate snapshot `downwindSails`, only if non-empty (S4). Without the argument it copies as today.
- **D8 — Per-boat localStorage**, one key per boat (`lib/ownMmsi.ts` pattern), not `Settings`. A saved plan carries its inventory in its request.
- **D9 — Verdict.** N ≤ 2: `assemble`/`compareRigs` unchanged; N = 1 says one sail was planned; N ≥ 3 is design (R.4).
- **D10 — §N.4 stays tier-keyed.** `derivedFrom` is data for §S, not a whole-route suppression rule.
- **D11 — `MAX_HEADSAILS = 2` this release.**

### R.3 Shapes

```ts
// boats.ts
export interface SailDef { /* …unchanged */ readonly derivedFrom?: string; /* S4 */ }
export interface DownwindLimits { readonly maxTwsKn: number; readonly maxAwsKn: number;
  readonly twaDeg: readonly [number, number]; }            // closed, on |normalizeDeg180(twa)|
// DownwindSailDef = P.5's shape + readonly limits: DownwindLimits (required)
export const MAX_HEADSAILS = 2;
// lib/downwind.ts (S4): sailUsableAt(sail, polar, twaDeg, twsKn, awsKn) — a = |normalizeDeg180(twaDeg)|;
//   speedKnOrNull(a, twsKn) !== null && tws ≤ maxTwsKn && aws ≤ maxAwsKn && a ∈ twaDeg
// types.ts (S4): PlanRequest += downwindSailIds?, hoistedSailId?; BoatSnapshot.sails[] += derivedFrom? (copied only when present)
// lib/sailInventory.ts (NEW): key `sc-sail-inventory-${boatId}`, value {"v":1,"aboard":[…],"hoisted":id|null}
export interface SailInventory { readonly headsailIds: readonly SailId[]; readonly hoistedSailId: SailId | null; }
export function readSailInventory(boatId: BoatId): SailInventory;   // never throws
export function usePersistedSailInventory(boatId: BoatId): [SailInventory, { setHeadsails(ids): void /* S4: setDownwind, setHoisted */ }];
```

`derivedFrom` ships in S4 with its consumer: every genoa gains `derivedFrom: 'fock'`. Twin: `estimator.baseSailId` for a same-boat base; else `derivation.fromSailId`; else absent; the Salona 45 genoa (hand overlay, §G.1) is one hand-asserted row. `DownwindSailId` is written in S4.

**Read rule:** tolerant parse (malformed, foreign `v`, non-array → default); membership by array scan over catalogue sails, never object lookup; unknown ids dropped; none left → all headsails; `hoisted` kept only if aboard; default all headsails, no downwind, `hoisted: null`; `storage.ts` safe wrappers and an `ownMmsi.ts` listener registry. `setHeadsails` ignores `[]` and drops a departing hoisted sail **in the same write**.

**Request construction** (`App.tsx` new-plan path, the only live-inventory reader): `sailIds: inv.headsailIds`, `boat: boatSnapshot(boat, inv.headsailIds)`; S4 adds the optional keys. **Copy sites:** `recalc.ts`, `replan.ts`, `useDepartureConfirm.ts` spread `plan.request` (`recalc` copies, never aliases, `downwindSailIds`). `reroute.ts` builds field by field: copy `downwindSailIds`, omit `hoistedSailId` until §S D14. `useDepartureScan.ts`'s candidate builder strips both keys and solves `[GENOA_SAIL_ID]` when the genoa is aboard, else `[base.sailIds[0]]`.

### R.4 The verdict

**Pre-trip: the N ≤ 2 verdict is unchanged; N ≥ 3 changes from today's `not-compared` (#553) to a `worker-fatal` throw.** `planRoute` throws (`worker-fatal`) on `sailIds.length > MAX_HEADSAILS`; empty `sailIds` keeps its typed no-route.

**Design of record for N ≥ 3 (S3, not implemented)**, over `req.sailIds` in solve order:
1. Any sail `estimated`/undeclared ⇒ `not-compared`.
2. `assemble`'s `budgetCut` argument ⇒ `not-compared`, `comparisonComplete: false` (the argument, since `withPass1Causes` masks causes).
3. Any requested sail unrouted ⇒ `not-compared`, as `route.rigOneFailed` at N = 2; a failure can be a false `unreachable` (`docs/spikes/1168-motor-off-prune-instability.md`).
4. Else `compareSails(all)`: all all-motor ⇒ `moot`; `f` = least `etaMs` (solve order on ties); `T` = others within `RIG_TIE_BAND_MS` of `f`; `T` empty ⇒ `decided(f)`, else `tie` with `among = [f, …T]` only if shorter than the full set.

`recommended` = `f`, or for `not-compared` the first routed sail. **N = 2 reduction:** rule 4 equals `compareRigs` and never emits `among`; rules 1–3 select `not-compared` exactly when today's gate fails. S3 also: `tie.among?`; `validRigRecommendation` keeps `among` only as a ≥ 2 string array of routed sails, else degrades to `not-compared` (#578); `renderRigVerdict` never names a failed sail; `sailLabelKey` via `Object.hasOwn`.

### R.5 What EASY GO! shows

Genoa `estimated` (decided 2026-10-15) ⇒ `not-compared`, both ETAs, §N.5 disclaimer, no new UI. `weakestPolarTier` stays headsail-only.

### R.6 Budget and cap

All aboard headsails solve sequentially under **one** `PLAN_BUDGET_MS` deadline; more sails starve the last, and R.4 rule 2 withdraws the comparison. `workerClient.ts`'s comment: Flensburg → Burgstaaken, two solves, 271.9 s = 76 % of 360 s (`workerClient.ts`: two bare `solve()` calls, tier 1, synthetic uniform wind, idle box, machine not recorded); a third does not fit. Enforced twice: `boats.test.ts` (0 or > 2 headsails fails) and `planRoute`'s throw. A lift needs a real three-headsail boat plus #1350, and brings S3, its R.10 rows and its own sweep.

### R.7 UI and persistence

- **Aboard control** (Boat tab beside the MMSI field, #746): `SegmentModeControl` pattern (#885), `aria-pressed` `Button`s, 44 px; "Both" plus one per headsail via `sailLabelKey`; no empty set.
- **Planner line**, always visible beside the boat: "Sails aboard: Genoa, Jib", a ghost `Button` calling `onOpenBoatSettings`.
- **N = 1:** `route.singleSail` ("Planned with {sail} only") replaces the verdict chip; no tablist. `route.comparisonIncomplete` gains a remedy (leave one sail ashore).
- **Hoisted control, downwind toggle:** S4, with a consumer.
- **Dirty state:** an aboard edit after planning sets `planFormDirty` and `routingSettingsDirty` (new inventory term vs `plan.request.sailIds`); `PlannerPanel`'s live region still folds only `formDirty && !settingsDirty`.
- ≥ 820 CSS px both branches; existing primitives and tokens; de/en parity.

### R.8 Persisted plans

No `PLAN_SCHEMA_VERSION` bump; `migratePlan.ts` validates present values only: `hoistedSailId` not a string in `sailIds` → dropped. S4: non-array `downwindSailIds` → dropped; entries not downwind sails of the boat (catalogue, else snapshot) → dropped; empty → omitted; snapshot `derivedFrom` not a string → unreadable (§I.3 placeholder, never deleted). `sailIds` longer than `MAX_HEADSAILS` → existing fallback reconstruction. S3: `tie.among` per R.4.

### R.9 Contracts with §P phase 2 and §S

Downwind assets load **outside** `loadRoutingAssets`'s boot `Promise.all` (one rejection leaves `harbors` permanently `[]`), or that PR adds an offline-reload e2e row. Delivered to §S: slot membership, `sailUsableAt`, `derivedFrom`, limits. Owed: per-table source-document identity (`derivation.sources`) for §S.11's basis; `loadRank` per sail (R.15).

### R.10 Code that asserts two sails — amend deliberately

| Pre-trip site | Change |
|---|---|
| `boats.ts` `sailIdsOf`/`DEFAULT_SAIL_IDS` comments | "every **catalogue** sail"; the aboard set is `App.tsx`'s |
| `App.tsx` new-plan path | `sailIds: inv.headsailIds` |
| `RouteSummary.tsx` `sailTabs`, verdict chip; `resultSummary.ts` `resultVerdictKey` | N = 1 → `route.singleSail` |
| `planForm.ts` `routingSettingsDirty`/`PlanFormSnapshot`; `App.tsx`, `PlannerPanel.tsx` callers | + inventory term |
| `useDepartureScan.ts` | R.3 rule |
| planRoute.notCompared.test.ts 'three sails requested -> not-compared…' | S1's throw reds it: replace with a row asserting the throw, keeping the "no N-way ranking is invented" rationale; the original returns with S3 under a raised cap |

S3 adds: `types.ts` "still BINARY"/"Capped at 2" comments; `planRoute.ts` gate and `compareRigs`/`combineAllCauses` comments; `tiedSailIds`, `partiallyFailedSail`, `rigComparisonSuppressedByTier`, `RouteLayer.tsx` `otherRig`; `dict.en.ts` comment at `route.rigOneFailed`.

### R.11 Merge-order gate

Nothing but a whole-route headsail may enter `sails[]`, in any build. D2's types enforce most of it; A4's scan closes the rest. No downwind sail enters the catalogue before its consumer and the R.9 load path.

### R.12 Sweep

`closure.mjs files` (2026-10-15, `d40fbf8`): `types.ts`, `boats.ts`, `planRoute.ts` IN — **OWED**; run `closure.mjs diff <merge-base> <head>` and `closure.mjs reuse` first. **Prediction:** every arm byte-identical against the branch's base tree (every arm solves two sails, below the throw; pre-trip adds no request key). **Positive control:** `MAX_HEADSAILS = 1` must not be byte-identical and `compare.mjs` must fail closed; without it a green run is not evidence. S3's sweep adds N = 2 reduction controls: `recommended` forced slowest, `among` always emitted, band halved and doubled.

### R.13 Acceptance

- **A1 (S3)** `compareSails([a, b])` = `compareRigs`'s pinned literals; property test against a frozen copy of today's `compareRigs` (#50).
- **A2 (S3)** hand-derived N = 3 table (cap raised in test): decided; strict-subset tie (`among`); all tied (no `among`); moot; one no-route ⇒ `not-compared`; pass-2 budget cut ⇒ `not-compared`, `comparisonComplete: false`; any tier C ⇒ `not-compared`. Renders never name a failed sail; `sailLabelKey` over every `Object.getOwnPropertyNames(Object.prototype)` member → `route.rig.unknown`.
- **A3 Identity.** Per boat at default inventory, request = a fixture from today's path. S4: `derivedFrom` exactly where the catalogue declares it; `boatSnapshot` idempotent; a boat with no downwind sail aboard yields the same request as without the sail.
- **A4 Containment.** Scan rows (S1): `sails[]` assets lack `valid` and `kind: 'downwind'`; `downwindSails` assets have both. Type row (S4): `@ts-expect-error` — a downwind id is not a `SailId`. Mutation at BASE and HEAD: a downwind asset moved into `sails[]` reds exactly the scan row.
- **A5 Catalogue.** `boats.test.ts` fails on 0 or > `MAX_HEADSAILS` headsails (S1), and (S4) on a `derivedFrom` naming no same-boat `sails[]` entry. S4 twin in `polarProvenance.test.ts` per R.3's mapping, each case mutation-checked.
- **A5b (S4)** `sailUsableAt` pinned at both closed edges, one step outside each, and at −150°, 200°, ±180°.
- **A6 Persistence.** Rows: malformed JSON; foreign `v`; unknown id; every `Object.prototype` own name (derived); `setHeadsails([])` ignored; hoisted not aboard; hoist Genoa → "Jib" → "Both" ⇒ `hoisted` null. Two hook instances stay in sync; throwing storage degrades to session-only.
- **A7 UI.** No empty state; 44 px at both branches; planner line opens the Boat tab; N = 1 shows `route.singleSail`, no tablist; de/en parity; no new accessible name is a substring of, or contains, an existing `getByRole` name in `app/e2e`, **in both languages**; `layout.spec.ts`'s #1606 pin green; `capture.mjs` re-run.
- **A8 Migration.** A record without new fields reads byte-identically; one row per R.8 rule; unreadable records listed, never skipped.
- **A9 Sweep.** R.12's prediction met, positive control reported.
- **A10.** An aboard edit sets both dirty terms, announced once. Genoa ashore: the scan solves `sailIds[0]`, `disagreeingRig` is `null`, candidates carry neither key. Reroute copies (not aliases) `downwindSailIds`, omits `hoistedSailId`.

### R.14 Considered and rejected

| Option | Why it lost |
|---|---|
| `kind` discriminant in `sails[]` | Per-consumer filter; review found five consumers it missed. |
| Spinnaker in `sailIds` with a no-solve flag | An opt-out the next consumer forgets. |
| `MAX_HEADSAILS = 3` now | 1.5 × 271.9 s > 360 s; no boat has three headsails. |
| `aboardSailIds` beside `sailIds` | One fact, two fields. |
| Inventory in `Settings` | Snapshotted into every request; moves every arm. |
| One localStorage `Record<BoatId, …>` | Prototype-chain lookup over stored input (#614). |
| Checkboxes, last one `disabled` | Unfocusable: explanation unreachable on touch and to AT. |
| Rank the routed rest after a failure (N ≥ 3) | Disagrees with N = 2; the failure can be an artefact (#1168). |
| Invalid stored `among` ⇒ "all tied" | Plausibly wrong (#578). |
| Suppression keyed on `derivedFrom` | Flips the Salona 45 to `not-compared`, moves its sweep rows; needs its own ruling. |
| Render-time tied set; `among` on every tie; pairwise/chained ties | Duplicates the band; moves every N = 2 tie row; non-transitive. |
| `moot` when any sail is all-motor | That ETA is still an engine fact. |
| `RoutingFailureKind` for > cap | Unreachable by construction. |
| Controls without a consumer | Change nothing. |
| Per-sail sub-budget; budget × N | §L, in force. |

### R.15 Open questions

- **OQ-R2:** a lineage qualifier on the Salona 45's decided ★ (its genoa is derived and compared). Post-trip.
- **OQ-R5:** does the aboard set persist across trips? Recommended yes, per boat; the planner line shows it at plan time.
- **OQ-R6:** Live reroute's hoisted sail; §S D14 answers post-trip.
- **OQ-R7:** spinnaker max-AWS default; until set, §S D5's `REEF1_AWS_KN` term is the only AWS gate.
- **OQ-R8:** `loadRank` ownership (catalogue or advisory-local); needed when §S.11 ships.

### R.16 Slices

| Slice | Content | If it slips |
|---|---|---|
| **S1 — pre-trip** | `MAX_HEADSAILS = 2` guards, A4 scan rows | Nothing visible changes |
| **S2 — pre-trip** | Aboard control, persistence, request wiring, planner line, N = 1 copy, dirty terms, R.8, scan and reroute rules | Aboard set stays all headsails |
| **S3 — built only with the cap lift (R.6)** | N ≥ 3 per R.4 | No effect: no three-headsail boat |
| **S4 — with §S** | `derivedFrom` (catalogue, snapshot, migration, twin), hoisted control, `DownwindSailId`, `downwindSailIds`, downwind toggle, snapshot `downwindSails`, `limits`, `sailUsableAt`, A4 type row | Ships with §S and §P phase 2 |

---

## S. En-route sail changes in the search (post-trip)

Nothing in the ~19 Oct release depends on it. §C untouched. §S.11 is the router-off crossover advisory.

### S.1 Objective

Plan **one route on which the foresail may change en route**, with the changes in the ETA and the change points shown. The set sail is node state; a change is a priced transition.

### S.2 What the code forces

1. **A change cannot be priced like a tack.** `solve()` charges `effS = max(dtS − maneuverPenaltyS, 0)` and drops `distNm <= 0`; `dtS` is 150/300/600 s, so a minutes-long change is unreachable within 2 nm of the destination and on any ring whose `dtS` it reaches.
2. `Polar.speedKn` tapers and clamps, never "unusable": check range before reading speed.
3. The candidate fan is per polar (beat/gybe angles + `EXTRA_TWAS`); a kite has no meaningful beat angle.
4. Motor legs carry no sail claim; whether a state may motor is a modelling decision.
5. Via joints reset manoeuvre state; sail state must not, or every via is a free change.
6. Neither merge pass (`backtrack`, `postprocess.ts`'s `tryMerge`) knows sails.
7. Refining the prune key is not monotone (#1333); a sail suffix refines it.
8. The sweep serialises `{...result, record, pass2}`, not the request; a new result field is omitted, never `undefined`, with the router off.
9. Frontier truncation ranks by `better()` (`costMs` first): a penalty-paying lineage loses wherever the cap bites.

### S.3 Decisions

**D1 — Sail state is node state:** `(foresail, rigged headsail)`; under kite, `rigged` is the headsail it was set from, and a douse returns to the furler. No "nothing set" state. **Dropped at request build:** a non-hoisted headsail `b` (with its kite twins) when no cell where both are usable has `v_b > (1 + U)·v_h`: any path through `b` is then matched at lower cost by the same path in `h`. `S` = kept states. On EASY GO! the genoa/fock ratio never exceeds 1.054 (1.0534, P.4), below `1 + U`, so `S = 2` for either hoisted headsail (it and its kite twin; `S = 1` without the spinnaker). Consequence: on EASY GO!'s current tables no genoa↔fock swap can pay, so none is planned; the swap mechanism is live for any pair whose ratio exceeds `1 + U`.

**D2 — A change is a stationary transition.** From state `i`, for each kept `j ≠ i`, emit a change node at the same position with `tMs` and `costMs` += `P(i→j)`, carrying `change: {from, to, steps}`. It inherits `kind/board/twaSigned/headingDeg` only for the next tack test, moves next ring, emits no change edges, obeys the horizon guard. Exact for any `dtS`; `costMs ≥ tMs` holds (#243).

| From → to | Steps |
|---|---|
| headsail `a` → `b` | `headsail-swap` |
| `a` → kite `(s, a)` | `spinnaker-set` |
| `(s, a)` → `a` | `spinnaker-douse` |
| `(s, a)` → `b` | `spinnaker-douse`, `headsail-swap` |
| `b` → `(s, a)` | `headsail-swap`, `spinnaker-set` |

No swap under the kite (OQ-S4), no `(s, a) → (s, b)`. Step-identical sequences tie exactly; `better()`'s tie-breaks pick one.

**D3 — Penalties.** `lib/sailChangePenalty.ts`: `SailChangeType`, `DEFAULT_SAIL_CHANGE_PENALTY_S = {headsail-swap: 900, spinnaker-set: 300, spinnaker-douse: 300, pole-gybe: 120}`, persisted per type via `usePersistedNumber` (localStorage, `null` = default, #355), edited in minutes with `NumberInput` beside the aboard control; snapshotted by value into the request (§I.3), not `Settings`. Same cost from a motor node. A value may be 0 (ties then broken by D7's fewer-changes rule). A board change under kite charges `pole-gybe` instead of `maneuverPenaltyS` via `effS`, inheriting today's near-destination drop.

**D4 — Margin `U`, ranking-only.**
- *Value:* one per plan: the maximum, over every aboard pair before D1's drop, of the pair's basis value (S.11.3: 0.03 same-document, 0.06 cross-document) plus `OVERLAY_BOUND` if either table is `derivedFrom` the other. `OVERLAY_BOUND` is the derived table's largest cell ratio over its base, minus 1, on the shipped tables (EASY GO!: 1.0534 − 1, P.4). One aboard sail ⇒ `U = 0`. EASY GO! with all three aboard: genoa↔spinnaker is cross-document with a derived table, so `U ≈ 0.11`; with the genoa ashore, `U = 0.06`. `U` is uniform because a per-state value subsidises a change between two away states.
- *Search:* while a thread's foresail differs from the hoisted, `U·Δt` is added to `costMs` only (sail steps, direct-arrival travel term, capture hop; not motor steps). An excursion pays only if its saving exceeds `P_in + P_out + U·T_away`.
- *Assembly, true clock:* present the sail plan iff `sailChangeCount > 0`, `etaHeld − etaPlan ≥ RIG_TIE_BAND_MS`, and its ranking cost (`Σ segments (costMs − segment departureMs)`, carried by `RunOut`) ≤ held's.
- *Outcome (persisted):* `'search'` (presented), `'held-tie'`, `'held-worse'` (#1333), `'search-cut'`, `'search-failed'`.

**D5 — Kite en route only.** Departure state is a headsail except on a mid-kite reroute (D14). **Gate before any speed:** `speedKnOrNull !== null` ∩ §R limits (max TWS default 18 kn, TWA window, max AWS once set) ∩ AWS `< REEF1_AWS_KN`, AWS from `max(speedKn, gustKn)` and the candidate's own speed. A failing candidate is not generated (not 0 kn, motor, calm or blocked). Fan: `gybeAngleDeg`, `EXTRA_TWAS`, 180°, direct TWA, each gated; no beat angle, no `MOTOR_TWAS`. Dropped exactly where D15 would motor (motorsailing stays out, §B). On the final segment only headsail states arrive; the douse node arrives next ring, so the douse is in the ETA. Dropped candidates set neither `sawBlocked` nor `sawCalm`.

**D6 — Vias.** State carries across joints. Greedy per-segment arrival can lose up to `max P` at a non-final via (named v1 limitation). A `forcedKind: 'motor'` segment entered under kite has only the douse edge until it moves.

**D7 — Prune and dominance.** `pruneKey`/`keyOf` gain a state suffix after the board letter (`'O'` for a change node inheriting `'start'`). `B` in state `j` is dropped if `A` in the same cell, kind and board, state `i ≠ j`, has `A.costMs + P(i→j) < B.costMs` (strict, so `A`'s own change nodes survive) and `A.maneuvers ≤ B.maneuvers`. `better()` gains a last tie-break: fewer change steps.

**D8 — Held first.** With the router on, the whole ladder (tiers, #243 retry, #53 relaxation, #1136 pass 2) runs on `[hoistedSailId]` only. On `ok`, one sail-plan solve at that tier's gate and comfort (`salvage` if pass 2 rescued), under the remaining deadline. A cut or failed sail plan returns the held plan with `outcome`; "held null, plan ok" is unrepresentable, so `recommended` and `migrateResult`'s invariant hold. Residual: a request only a non-hoisted headsail routes today becomes a no-route (OQ-S10). `ShallowInfo` from the presented route; `rigRecommendation` `not-compared`; §L `[OQ-3]` not breached.

**D9 — Validation before any solve.** With `sailChange` present, refuse with new pre-solve `NoRouteReason` `'sail-change-invalid'` when: `hoistedSailId` absent; aboard set has duplicates or a sail not on the boat (`Object.hasOwn`/`find`, never `in`); a kite lacks a table or limits; a penalty is negative or non-finite. Precedent `segment-modes-invalid` (#885); no new `SolveFailureCause`, `RoutingFailureKind` untouched. An `estimated` sail is not refused (user decision 2026-10-15); D4's margin and D13's label carry its uncertainty.

**D10 — Death classification, new path only.** Change nodes are not `produced`; gated candidates set no flag. A #282 classification change, covered by S.6.

**D11 — Frontier.** Router on: `maxFrontier = defaultMaxFrontier(meta) × S` (an injected value as given), truncated by `better()` within each state, filled round-robin across states.

**D12 — Merges never cross a change** (`sailId` change or `sailChangeAtStart`); `tryMerge` refuses a kite merge whose joint TWA fails D5.

**D13 — Honesty.** Every sail-plan surface carries the weakest tier among the sails used (`boat.polarTier.*`). A plan whose change points involve a derived table labels those change points and the ETA with new key `route.sailPlan.derived`: "estimated ({sail} derived from {base})", for EASY GO! "estimated (genoa derived from jib)". The plan states that wind-strength change-down is not modelled by the polars; how the genoa's operational limit (§R D3, 18 kn TWS) enters — gate or suggestion line — is OQ-S9. The ETA carries `route.eta.indicative`, a **new** key (§N.5 names it; the dictionaries lack it). §N.5's wording ban applies.

**D14 — Reroutes start in the planned state.** `rerouteFromFix` gains `departureState` (`sailId`, plus `riggedSailId` under kite) from the active leg and copies `sailChange` explicitly. Under kite the held baseline is the rigged headsail from `departureMs + P(douse)`, the douse marked on its first leg.

**D15 — The hoisted sail decides sail or motor.** A candidate motors iff the hoisted sail's speed is below the floor, in every state. No change unlocks the engine and the plan can always replicate held, so `'held-worse'` measures only non-monotonicity. One aboard headsail = today's branch, byte for byte.

### S.4 Interface

```ts
// types.ts — one declaration; lib/sailChangePenalty.ts re-exports
export type SailChangeType = 'headsail-swap' | 'spinnaker-set' | 'spinnaker-douse' | 'pole-gybe';
export type SailChangeStep = Exclude<SailChangeType, 'pole-gybe'>;
export interface SailChangeRequest { readonly penaltiesS: Readonly<Record<SailChangeType, number>>; }
// PlanRequest += sailChange? (absent ⇒ today, byte-identical); departureState?: { sailId; riggedSailId? } (D14)
export interface SailChangeMark { readonly from: SailId; readonly to: SailId;
  readonly steps: readonly [SailChangeStep, ...SailChangeStep[]]; readonly penaltyMs: number; }
// LegCommon += sailId?, riggedSailId? (kite), sailChangeAtStart? — sail-plan legs only, else omitted.
// A marked leg starts at the change; speedKn = distanceNm / (duration − penaltyMs).
export interface SailPlanResult extends Omit<RigResult, 'sailId'> {
  readonly kind: 'sail-plan'; readonly hoistedSailId: SailId; readonly sailChangeCount: number; }
export type SailPlanOutcome = 'search' | 'held-tie' | 'held-worse' | 'search-cut' | 'search-failed';
// PlanResultOk += sailPlan?: { result: SailPlanResult | null /* non-null iff 'search' */; outcome }
// NoRouteReason += 'sail-change-invalid'; RigProgress gains a 'sail-plan' identity (de/en).
```

**Selector** `primaryResult(r) = r.sailPlan?.result ?? recommendedResult(r)` (`RigResult | SailPlanResult`). Every non-test reader of `activeRigResult(`, `recommendedResult(` or `result.sails` moves to it or joins a guard allowlist with a reason — 18 files at `d40fbf8`: `App.tsx`, `types.ts`, `lib/{plan,resultSummary,gpx}.ts`, `components/{PlannerPanel,RouteSummary,DepthProfile,LiveView,DepartureCompare,AisTraffic,RouteLayer}.tsx`, `services/{migratePlan,regionPinning,db}.ts`, `state/{usePlanFlow,useSessionRestore}.ts`, `routing/planRoute.ts`. `regionPinning` adds the sail-plan legs; `legPositionAt` holds position during `penaltyMs`.

**Solver.** `SolveParams.sailStates?: {states, hoisted, finalSegment, u, speed(state, twa, tws): number | null, gybeAngleDeg, penaltyMs, steps}`; absent ⇒ byte-identical. `Node` gains `sail`, `changeSteps`, `change`; the `ok` arm gains `arrivalState`; `backtrack` folds change nodes into the next leg's mark. `PlanDeps` gains a separate `downwindPolars`; `polarKeys` covers `sailIds ∪ downwindSailIds`.

**Persistence.** `migrateResult` must carry and validate `sailPlan` (its annotated literal silently strips unknown optional fields). Plans with `sailPlan` are stamped `schemaVersion: 2` at every write site, others 1; the reader's maximum becomes 2, `PLAN_SCHEMA_VERSION` stays 1 (#538, §I.2); older builds list v2 unreadable. `planExport.ts`: OQ-S5. No IndexedDB bump.

### S.5 Output on deck (≥ 820 CSS px, de/en)

- One plan, no per-sail tabs. A summary line gives the change count and the gain vs holding `{sail}` (`etaHeld − etaPlan`), replacing `route.rigNotCompared`/`comparisonIncomplete`. `held-tie`/`held-worse`: "no change pays on this route"; `search-cut`/`search-failed`: own keys.
- Change points: DOM `Marker`s (`ViaMarkers`, outside the #378 index) with visible labels (#947).
- Legs table: a sail column, `.chip.chip-sail-change` (compound, #504); leg speed is moving speed.
- D13 labels on results card, legs table and plans-list row. No §S.11 hints on a sail plan. The #340 readout names the held sail, then the sail plan.

### S.6 Sweep (owed) and pre-registered predictions

`isochrone.ts`, `planRoute.ts`, `postprocess.ts`, `types.ts` are in the closure. BASE double-run first; baseline = the branch's base tree.

**Harness.** `Arm` gains `sailChange?: {aboard, hoisted, penaltiesS}`; rows keep today's shape. Sidecar `<arm>.nodes.json` records per solve the ring-summed survivors, peak frontier and capped-ring count, and for the sail-plan solve the raw pre-selection result (`costMs`, `etaMs`, change count, legs hash without `sailId`). `merge-shards.mjs` merges it, failing closed on a missing part.

**Arms** (Flensburg origin, `salona-44-easy-go`, hoisted genoa unless stated): `easygo-persail` (router off, `[genoa, fock]`; node baseline); `easygo-sail1` (aboard `[genoa]`; control); `easygo-sailnochange` (all three aboard, penalties beyond the horizon; control); `easygo-sailplan-pos` (all three, penalties 1 s, uniform 12 kn / 225°; positive control); `-breeze` (all three, D3 defaults, 12 kn / 225°); `-light` (as breeze, 8 kn / 225°).

**Break-even.** A set + douse of `P` s pays after `T_b = P/(r − 1 − U)` of kite sailing at ratio `r`. The implementer computes `r` and `T_b` from the shipped tables and posts them before the run. Fixed-TWA ratios overstate VMG gain.

| Arm | Prediction | Falsifier |
|---|---|---|
| all existing | 0 rows differ | any: blocker |
| `sail1` | legs hash, `costMs`, `etaMs` ≡ held; 0 marks; `'held-tie'` | any row differs |
| `sailnochange` | as `sail1`, except listed capped-ring rows | any other |
| `sailplan-pos` | ≥ 1 set on every row whose persail genoa route sails ≥ one ring at \|TWA\| ≥ 120° | a listed row with none |
| breeze | set iff persail genoa route sails ≥ `T_b` at \|TWA\| 120–165° | set where < `T_b/2`, or none where ≥ `2·T_b`, pos green |
| light | same rule at its `T_b`; sets(light) ≥ sets(breeze) | as breeze, or fewer |
| breeze, light, pos | I1–I7 every row | any: blocker |
| breeze, light | `'held-worse'` ≤ 5 % of rows (judgement) | above: investigate |
| breeze, light, pos | 0 genoa↔fock swaps (D1: ratio ≤ 1.054 < 1 + U) | any swap: D1's drop or `U` is wrong |
| node ratio `R` | ≈ 1.5 where no ring capped | `R > 1.8` |

**Invariants** (every sail-plan row and unit tests): **I1** every kite leg passes D5's gate at step-start samples and merge joints (a non-uniform unit case pins that the next step is gated); **I2** no motor leg has a kite `sailId`; **I3** the last leg is a headsail; **I4** consecutive legs differ in `sailId` iff the later is marked; **I5** marked duration ≥ `penaltyMs`; **I6** legs contiguous, ending at `etaMs`; **I7** marked `speedKn = distanceNm/(duration − penaltyMs)`. **Limitation:** uniform wind only, so changes follow course changes, never wind shifts.

### S.7 Budget, by node counts (2026-09-18 ruling: no routine wall time)

Survivors ≈ `S` × one solve's, so `R = (held + sail plan)/(persail genoa + fock) ≈ (1 + S)/2 = 1.5`; ring-summed survivors also bound retained nodes. **G1:** `R ≤ 1.8` on every router row with no capped ring (model + 20 %, judgement). On failure, before merge: the conservative 3-state kite model, then no router for that boat. **Accepted:** 1.5 exceeds the headroom on the worst known route (360/271.9 ≈ 1.32; bare solves, synthetic wind, machine not recorded: `docs/spikes/1350-per-rig-budget-vs-parallel-rigs.md` §1), and the tablet factor shrinks it (`docs/spikes/1147-budget-headroom-reference-device.md`, #1490); Flensburg→Marstal is predicted `'search-cut'`, a missing extra under D8, never a failure. The budget is never raised.

### S.8 Acceptance

1. Router off: sweep byte-identical on every existing arm.
2. `aboard = [hoisted]`: raw sail plan ≡ held without `sailId`.
3. **Threshold**, hand-derived (#50), `solve()` direct at injected `u = 0.03`, B exactly `r ×` A on one stretch, quantum `q = 2·dtS`: taken at `gain ≥ 2P + u·T + q`, not at `≤ 2P + u·T − q`. A `planRoute` row adds the 60 s band.
4. A 900 s douse (> every `dtS`) routes a kite finish with the douse on its last leg; reverting to `effS` reds.
5. Gate replaced by "speed 0 out of range" changes a pinned result (also at BASE). Twin: `sailUsableAt === (speedKnOrNull !== null)` over a grid with both edges. No kite leg gets a reef from `reefSuggestionForLeg`.
6. No motor child under kite; no final-segment kite arrival, douse in the ETA; forced-motor under kite douses first; pole gybe charges `pole-gybe`.
7. Kite before a via continues unmarked; kite to a via then upwind loses ≤ `max P`.
8. Each D9 clause reds alone (incl. absent `hoistedSailId`); an `estimated` aboard sail is accepted; a spy shows refusal precedes `solve()`.
9. A deadline inside the sail-plan solve → `ok`, held legs, `'search-cut'`, held solved first. Sail-plan `mask-blocked` with held routing at tier 1 → zero tier-2 solves. Fixtures produce `held-tie`, `held-worse`, `search`; no consumer throws.
10. A change at `t0`, at a via's segment start and at the first ring each yields one mark. A starved `maxFrontier` keeps the penalty-delayed state (D11) that plain `better()` truncation loses (mutation).
11. D15: genoa 3.75 / fock 3.65 kn, floor 3.7 ⇒ no mark for either hoisted sail.
12. No merge across a mark, a `sailId` change, or out of D5's gate.
13. `save → migratePlan` round-trips `sailPlan`; dropping it from `migrateResult` reds. v2 iff `sailPlan`; a v1 reader lists v2 unreadable.
14. de/en parity; wording ban; a scanning guard (`cameraAnimationCallSites.test.ts` style) fails on a reader outside its allowlist; the #340 guard asserts `[hoisted, sail-plan]`.
15. A derived pair is decided with `U` including `OVERLAY_BOUND`: a fixture where the derived sail beats the hoisted by more than `2P + U·T` swaps, and one under it does not; its change points and ETA carry `route.sailPlan.derived`.

### S.9 Considered and rejected

| Option | Why it lost |
|---|---|
| Penalty via `effS`; debt on `Node`; inside leg speed; as a zero-distance leg | Dropped when ≥ `dtS`; alters every step's geometry; dilutes `speedKn` and reef AWS; a third `Leg` kind. |
| No state suffix in the prune key; change count as a dominance axis | Prunes the better-future sail; already priced. |
| Sail plan first; both runs through the ladder; sail plan rescuing held | Can fail the whole plan; router failures drive retry and cause fold; makes "held null, plan ok" representable. |
| Motor per state, or by best aboard sail | Swaps to unlock the engine; plan cannot replicate held. |
| Free start state without `hoistedSailId` | No single held baseline. |
| Per-state `U`; absolute per-change margin only; margin on the true clock | Subsidises away-state changes; polar error grows with time on the sail; the ETA would lie. |
| Suppressing derived pairs (no change planned or hinted) | Overruled by the 2026-10-15 user decision; derived pairs are decided with `OVERLAY_BOUND` and a label (cross-cutting 3). |
| Per-state arrivals with multi-start at vias | Interface cost; deferred. |
| Motoring under kite; free arrival under kite; reset state at vias | Free set/douse or free changes; understated ETA. |
| Keep every per-headsail held solve | `H + S` solve equivalents. |
| Envelope polar + post-pass reducer | Post-processing that can violate constraints. |
| N × K replans; budget raise | §E.1; §L `[OQ-3]`. |
| Refusing the router when an `estimated` sail is aboard | Overruled by the 2026-10-15 user decision; the derived margin and label carry the uncertainty. |
| Kite standalone; penalties in `Settings` | En route only (user); moves every arm. |
| Native search pre-trip | Post-trip by decision. |

### S.10 Open questions

- **OQ-S1:** on EASY GO!'s current tables D1 drops every genoa↔fock swap (ratio ≤ 1.054 < 1 + U), so the router acts only on spinnaker set and douse there; a gate-form change-down limit (OQ-S9) is the one mechanism that would make a swap pay.
- **OQ-S3:** `U`, the 60 s band and G1's 20 % are judgements.
- **OQ-S4:** swapping the rigged headsail under the kite.
- **OQ-S5:** export — change points as GPX `<wpt>`, `planExport` version.
- **OQ-S6:** Live override of the set sail.
- **OQ-S7:** the router for other boats (Salona 45: its genoa is a derived overlay, so D4's margin applies).
- **OQ-S9:** how the genoa change-down limit enters the plan (gate or suggestion); the kite's AWS ceiling (§R OQ-R7).
- **OQ-S10 (maintainer):** hoisted-only ladder residual (D8). Alternative: on held no-route, run today's per-sail path, router off.

### S.11 Router-off view: crossover advisory

Shows where another aboard sail beats the displayed headsail's route by more than the change cost; no extra solve, `PlanResult` and ETA untouched; it states what it did **not** evaluate, so an empty list never reads "nothing pays". Ships with §S.

**S.11.1 Computation.** Pure `crossoverHints(input) → CrossoverResult` in new `lib/crossoverAdvisory.ts`, computed at render, never persisted, types local (not `types.ts`); precedent `lib/reefSuggestion.ts`.
- *Along the hoisted route* (independent routes share no point). Sail legs slice into ≤ `ADVISORY_STEP_MS` (300 000) with midpoint position/time from `legPositionAt`; wind from `WindField.sample` (mean, `gustKn`); TWA recomputed from `headingDeg`, never a merged leg's `twaDeg`. Motor legs yield no samples.
- *One basis:* `v_h`, `v_a` both `Polar.speedKn` at those inputs with the plan's `performanceFactor`; never `leg.speedKn`. `save_i = dt_i·(1 − v_h/v_a) − U·dt_i`, so the margin grows with span length.
- *Barriers, not zeros*, for alternative `a`: a motor leg; either speed ≤ 0; `a` fails `sailUsableAt`; or `a` adds sail (higher `loadRank`; missing counts as adding) with AWS at `max(mean, gust)` and `max(v_h, v_a)` ≥ `REEF1_AWS_KN` (12 kn). Fewer-sail alternatives get no AWS barrier. Spans end at barriers, motor legs included: no free change under engine.
- *Spans by net:* a linear DP per barrier-free stretch maximises `net = Σ save − G·gybes − P_in − P_out` (D3 penalties). `P_in`/`P_out` = 0 only for a headsail alternative at the first slice of `legs[0]` / last slice of the last leg when that leg sails; route ends count motor legs. The kite always pays set and douse; `G` = `pole-gybe` per `maneuverAtStart === 'gybe'` strictly inside a kite span. Emit if `net ≥ MIN_HINT_NET_S` (120 s) and duration ≥ `MIN_HINT_SPAN_MS` (900 000), then split and repeat. A whole-route headsail span is `wholeRoute`, not a hint; overlapping hints keep the larger net, the loser dropped, not trimmed. The discount does not apply to a plan built by `rerouteFromFix`; until the advisory can tell (OQ-R6) it states the optimistic bias in `route.crossover.note`.
- *Eligibility:* a derived pair is evaluated with `U + OVERLAY_BOUND` and its hint carries the D13 derived label (cross-cutting 3); tier does not block evaluation. The catalogue's current `polarProvenance` must equal the snapshot's for every sail involved, else `boat-data-changed` (a missing snapshot entry counts). The note proxies table bytes, so the advisory's PR adds a `rev N` token to each note and pins each table's content hash beside it in `polarProvenance.test.ts`; residual: hash updated without `rev`. Polars arrive via a new optional `RouteSummary` prop; absent → `assets-not-loaded`, rendering nothing; boat gone → `boat-not-in-catalogue`.
- *Consistency:* an alternative the stored verdict ranks faster (`decided`) reads `wholeRoute`, no hint. Two tabs may each hint the other sail (two routes); not reconciled.

**S.11.2 Interface.** `CrossoverHint {sailId, fromMs, toMs, fromLegIndex, toLegIndex, gainS, netS, changes (non-empty), twsRangeKn, basis, derived, weakestTier}`; `AlternativeCoverage {sailId, status: 'evaluated'|'ineligible', evaluatedFraction, wholeRoute}`; `CrossoverResult` = `{status: 'ok', hints, alternatives}` (empty `hints` is not "nothing pays") or `{status: 'unavailable', reason}`. A kite without limits is `ineligible`.

**S.11.3 Margin `U`** (judgements; D4 uses them):
- **`same-document` 0.03** — both tables from one document. Anchor: hull-to-hull spread over three 2026 Salona 44 CLUB certificates (SANTA ANASTASIA CLUB `04590004MKS`, ALPHA LYRAE, ISTROS), R52–R150 × 9 TWS = 72 cells, `max/min − 1`: median 2.29 %, p90 4.60 %, max 6.25 %; rows R110–R150 (36 cells): median 2.86 %, 17/36 > 3 %. So 0.03 sits at that median, not above its tail. Re-derivable only from the current-year endpoint (GER/AUT records not committed).
- **`cross-document` 0.06** — different documents. Anchor: builder VPP 1.11 Jib ÷ 2026 NS-certificate Jib, TWA 52–150 × TWS 6–20 = 56 cells: ratio 0.918–1.055, 32/56 differ > 3 %; |ratio − 1| median 3.5 %, p90 5.1 %, max 8.2 %. 0.06 sits just above p90. Re-derivable from `pipeline/orc-sources/`.
- **Derived pairs** add `OVERLAY_BOUND` (§S D4).
- §N.5's estimator band is not borrowed.

**S.11.4 Presentation** (de/en, existing primitives, ≥ 820 CSS px):
- One `.chip.chip-crossover` per hint (compound, #504, `chipShallowFill.test.ts`) on the first overlapped leg, `ReefChip` slot: `{sail} from {time}` / `{sail} ab {time}`.
- A plain summary list (not `role="alert"`): per hint "{sail} may pay {from}–{to} (TWS {lo}–{hi} kn): about {net} min net of the change" (whole minutes); `route.crossover.wholeRoute` ("estimated faster … see its result", no minutes); a hint involving a derived table appends `route.sailPlan.derived`; `route.crossover.none` **only if** ≥ 1 alternative is evaluated, no hints, no `wholeRoute`, and every evaluated alternative has `evaluatedFraction ≥ 0.8`, else `route.crossover.partial` with the share. **Never `none` from an empty list alone.** `boat-data-changed` → `route.crossover.stale`.
- `route.crossover.forecastOld` precedes the list when `isForecastStaleNow`. No map marker (#378).
- `route.crossover.note` whenever any line renders: evaluated along this route as planned, not re-planned; the tier; full main, mean wind (gusts only in the barrier); change time is the user's setting. A cross-document hint appends `route.crossover.crossDocument`.
- Wording ban (copy guard, both languages): none of *accurate, verified, reliable, safe, faster rig, recommended, ★*; register *may pay / könnte sich lohnen*, never *should*.
- Not a re-plan (alternatives read at the hoisted sail's headings; gains bias low), ranking, verdict on silence, measurement, seamanship advice, or claim about motor legs.

**S.11.5 Acceptance** (stub speeds, literals by hand, fixtures declare lineage):
1. Three 3600 s legs, alternative 1.2× on the middle leg, `U = 0.03`: Σ save 492 s; penalties 200/200 → `netS = 92`, `changes = ['headsail-swap','headsail-swap']`; 250/250 → no hint, `evaluatedFraction = 1`. `U = 0.06`: Σ 384; 100/100 → 184.
2. Region on the first leg → 292, `['headsail-swap']`; on all legs → no hint, `wholeRoute`; kite on the first leg, set = douse = 200 → 92 (never discounted).
3. `legs[0]` motor → `P_in` paid (92 vs 292); an inner motor leg splits the region; one motor leg of four → `evaluatedFraction = 0.75`.
4. Kite 1.2× on legs 1–2, gybes at both, set = douse = 200, `pole-gybe` 120 → 464, `changes` ending `['spinnaker-set','pole-gybe','spinnaker-douse']`; a headsail alternative pays no gybe.
5. Barriers non-vacuous against twins: `usable() === false` splits a span, and `v_a = 0` instead changes the result; the safety barrier trips once by gust only, once by `v_a > v_h` only; a lower `loadRank` keeps the hint.
6. A lower-Σ run touching the start is emitted by net; a one-slice +8 % run at zero penalties is not.
7. Raising a penalty or `U` never raises the maximum `netS` (count not monotone).
8. A merged leg's stale `twaDeg` is ignored.
9. A derived pair uses `U + OVERLAY_BOUND` (a fixture just above and just below that margin) and carries the derived label; an estimated hoisted sail is evaluated; document identity → basis; one-character note change or missing snapshot entry → `boat-data-changed`; no polars → `assets-not-loaded`.
10. Overlaps keep the larger net; a `decided`-faster alternative reads `wholeRoute`.
11. Deep-frozen inputs → equal results twice, nothing mutated.
12. A `ts.createSourceFile` guard: nothing under `routing/`, `app/sweep/` or `test/setup.ts` imports the advisory.
13. A table edit without its hash/`rev` pin reds `polarProvenance.test.ts`.
14. `RouteSummary`: one chip per hint, none on motor legs or while polars are absent; `none` never under 0.8 coverage or with a `wholeRoute`; note iff a line; stale clause iff stale; key parity, wording guard, no accessible-name substring collision; with `decided` naming B, tab A shows B's `wholeRoute` and no B hint.
15. At every `STANDARD_VIEWPORTS` entry ≥ 820 px the legs container has `scrollWidth <= clientWidth`; legs and ETA DOM unchanged by the advisory.

**Rejected:** comparing independent solves "at the same point"; `leg.speedKn` against a polar; out-of-range as 0 kn; suppressing derived pairs (cross-cutting 3); boolean lineage; a symmetric second-reef AWS barrier; advisory-owned kite limits; crossing a motor leg; zero route-end penalties for the kite; greedy by Σ save; penalties in `Settings` or persisted hints; a map marker; a per-sample dead band instead of `U`.
