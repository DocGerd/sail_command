# SailCommand — Multiple boat types with per-boat foresail inventory (#54)

**Date:** 2026-08-10
**Status:** design approved; all open questions decided except OQ-6 (§J).
**Amended 2026-08-18 — see §N.** OQ-7 is superseded: tier-C estimated polars are authorised for two
Flensburg fleet models. §N states the scope, the estimator, the honesty surface and the accepted
costs, and classifies every §L row. Read §N before acting on §G.3 rule 2, §J OQ-7, §K's "reduces to
today", §L's `[OQ-7]` row, or §M.2 — each is changed or retired by it.
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

**Out of scope.** The settings/planner UI surface (separate workstream — this addendum specifies only what that UI must be able to *express*, plus the safety/honesty rules in §C.6, §C.7 and §G.3). Spinnakers and asymmetrics — white sails only. Motorsailing — still sail XOR motor (#46 scope b). Reef states or sail combinations beyond main + one foresail. Per-boat wave, stability or leeway modelling.

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

### C.4 #53 relaxation makes the *effective* gate the one that matters — and it fires at DEFAULT settings

This is the interaction that most changes the risk picture, and neither #54 nor #452 states it.

The floor is `G_effective − T`, and `G_effective` is **not** the user's `safetyDepthM`. `findRelaxedDepthM` (`app/src/routing/relaxedDepth.ts ~:34`) searches `[BOAT_DRAFT_M, requested)`, and the app's own motivating route exercises it at stock settings: `realmask.repro.test.ts` pins Flensburg → Marstal at `DEFAULT_SETTINGS` to `expect(res.shallow!.requestedDepthM).toBe(3.0)` / `usedDepthM` ≈ 2.3 (`~:248-249`). So **at defaults, on the headline route, the real conservative floor is 2.3 − 0.9 = 1.4 m against a 2.1 m keel**. At relaxation's own floor it is `2.1 − 0.9 = 1.2 m` — the number the shipped disclosure copy states (§C.8 R5).

**(a) The relaxation floor MUST become the selected boat's draft.** Left as the constant `BOAT_DRAFT_M = 2.1` (`relaxedDepth.ts ~:9`), relaxation would relax a **2.30 m** boat to a 2.1 m gate — 0.2 m shallower than its keel before the mask tolerance is even applied, conservative floor 1.2 m, i.e. **1.1 m under the hull** — while the `shallow` banner reports the relaxation as if it were the Salona's. The single most dangerous shortcut available in this feature, and a one-line-looking change that is not a rename.

**(b) The violation is exactly `T` deep at the floor, for every boat, always.** Setting the relaxation floor to the draft makes its conservative floor `d_b − T` by definition — 0.9 m under the hull, invariant across the fleet, neither worse for a deeper boat nor better for a shallower one. It is disclosed today (every such leg is `shallow`-flagged and bannered by #53) and stays disclosed. **It is #452 territory, not #54's to fix** — but #54 must not deepen it, and (a) is what prevents that.

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
- **A harbour dropping out at a deeper boat's gate is CORRECT.** A 2.30 m keel genuinely cannot enter a 2.0 m basin; the failure to prevent is *silently offering* it. `harbors.json`'s snap points are documented as *"guaranteed-navigable"* — guaranteed at the 3.0 m verify gate, an implicit Salona-45 qualifier. The harbour list (or the verify script's output) must carry a **per-harbour minimum navigable gate**, so the picker can mark unreachable harbours per boat instead of failing at plan time with `snap-failed-destination`.
- **No boat ships without a `verify_mask.py` run at its own derived gate**, and any boat deeper than 2.10 m needs that run *before* its catalogue PR is reviewable (§J OQ-6).
- **Worked example, to be confirmed by a real run.** `verify_mask.py`'s `marstal` entry comments *"Reconnects at gate <= 2.3 m"*. A 2.30 m boat's relaxation window is `[2.3, 3.2)`, so it can just barely reach Marstal at 2.3 m — conservative floor 1.4 m against a 2.30 m keel. The First 47.7's 2.8 m racing variant could not reach it at all. Derived from the script's comment, **not** from a run; illustrative until measured (§M.2).

### C.7 Boat switching and a stored safety depth

`Settings` is a single global persisted record, and boat selection changes the valid range of `safetyDepthM`. Rule:

> On boat selection, if the stored `safetyDepthM` is below the new boat's minimum, **clamp it up, persist the clamped value, and tell the user it changed.**

This deliberately differs from `usePersistedNumber`'s contract (#355), where a bounds change alone leaves the raw stored value untouched. That asymmetry is right for a panel width and wrong here: per this repo's guard-asymmetry rule the uncertain path must fail toward the expensive-but-safe direction, and a silently retained below-hull gate is the cheap-and-dangerous one. **Never clamp down on a boat switch.**

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

**N is capped at 2 comparison sails per plan** (§J OQ-3). The boat may carry any number of foresails; the user picks which two to compare.

### E.1 Why 2 is the cap

At a cap of 2, **no existing invariant moves**:

- **The budget arithmetic is untouched.** `PLAN_BUDGET_MS = 120_000` (`app/src/routing/workerClient.ts ~:92`) stays a single plan-level deadline, instantiated once per plan in `protocol.ts`, checked at isochrone ring entry and once before the #53 BFS probes; the client deadline stays `budget + 15 s` grace so the solver wins the race. Up to four tiers still fire (#243 preference on/off × #53 requested/relaxed gate).
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

Keep the model even though release 1 ships no tier-C boat: it is the gate that lets a future boat in.

| Tier | Meaning | Consequence |
|---|---|---|
| **A `certificate`** | derived from a real ORC/IRC certificate for this hull or model | as today |
| **B `modelled`** | derived from a certificate for the same model in a different configuration, or from a published VPP | as today, plus the existing source note |
| **C `estimated`** | scaled from a comparable hull with no certificate at all | see rule 2 — ~~not built in release 1~~ **AUTHORISED 2026-08-18, see §N** |

1. **`polarProvenance` is a required field** on every sail. A boat added without one **fails the pipeline build** — never defaults to a friendlier tier. Built in release 1 even though only tiers A/B are populated, because it is what makes tier C impossible to fall into silently.
2. **~~Requirement on the first tier-C boat's PR, not designed here.~~ NOW DESIGNED — §N.4–N.6.** The maintainer decision was taken 2026-08-18 and §M.4 is discharged by construction (a tier-C boat presents `not-compared`, so there is no `decided` verdict to license) — see §N.7 for the precise scope of that discharge. The rest of this rule stands and is satisfied by §N.5. Shipping a tier-C boat requires an explicit per-boat maintainer decision; its label must be visible **at plan time**, not only in the About dialog — #455 §6 makes exactly this point, that the About dialog is opt-in so a disclosure living only there is *structurally withheld* at the moment of exposure. The recommendation must be presented as *indicative*, never as a measured speed finding, and §M.4's tie-band measurement must be done first. No tier-C UI is specified here because none is being built.
3. **User-supplied polars are the right long-term answer** (§L) — file as a follow-up issue, do not build here.
4. **Ask Skipperteam directly.** As the operator they would hold certificates for any boat that races, and one email may move several models from tier C to tier A. The cheapest available action on OQ-6; it can run now, in parallel with release 1.

---

## H. Pipeline changes

- **`build_polars.mjs` generalises per boat.** Its plausibility bound (`if (!(v > 0 && v < 12))`, `~:28`) and its sanity anchors (`Math.abs(at(90, 16) - 8.86) > 0.6` and `at(52, 12) < 6.5 || at(52, 12) > 8.5`, `~:41-42`) are Salona-45-specific magic numbers and must become per-boat entries. **A boat added without its own anchors must fail the build**, never inherit the Salona's — an anchor that silently validates the wrong hull is worse than no anchor.
- **Output naming must carry the boat id** (§F.1's collision).
- **`polars-source.json` becomes per boat**, each carrying `boat`, its sail keys and a `polarProvenance` tier + source string per sail (§G). **This must fail closed, and today it does not.** The sail set is enumerated *twice* in `build_polars.mjs` and neither list derives from the other: the loop `for (const rig of ['genoa', 'fock'])` (`~:45`) and a separate hardcoded `SOURCE_NOTES` object (`~:9-21`). Read 2026-08-14: a sail present in the loop but missing from `SOURCE_NOTES` ships an asset with **no `source` key at all** — `JSON.stringify` drops an `undefined` value rather than emitting it, so the provenance note is silently ABSENT rather than visibly wrong, with no throw and no warning. Deriving the loop from the data removes the second list entirely; a sail declared with no provenance must then throw and name itself, exactly as the missing-anchors rule above requires.
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
- **OQ-3 — N is capped at 2.** It is the pairwise question a skipper actually asks and the only option that changes no existing invariant (§E.1).
- **OQ-4 — a catalogue entry is one per named vessel** (14 entries), sister ships sharing a polar asset, draft recorded per hull where it belongs. Per-model-with-variant-picker is rejected: a wrong default variant is a silent safety error. Deepest-variant-per-model is the **fallback only if per-hull data cannot be obtained**. *Carve-out:* the Salona 45 is the app's existing reference boat, not a fleet vessel, so its release-1 entry is model-level and carries no vessel name — say so in the catalogue comment; the per-vessel rule governs fleet boats.
- **OQ-5 — lazy read-time normalisation, no IndexedDB version bump** (§I.2).
- **OQ-7 — ~~release 1 ships the machinery only, with the Salona 45 as the sole catalogue entry. No estimated-polar boats.~~ SUPERSEDED 2026-08-18 by §N.** Release 1 did ship exactly that, and the record above describes it accurately. For what ships next, read §N: two fleet models at tier C, with the comparison suppressed. **The unlock condition is only half superseded** — the *tier-A/B provenance* conjunct is overruled; the *per-hull draft* conjunct is **not**, and §N.2 records shipping the standard listed keel instead as an explicit accepted cost with a required disclosure, not as satisfied. "Each further boat lands as its own PR" stands.

### OQ-6 — OPEN: which vessels ship, in what order, and can the operator supply certificates?

The only open question. #54 itself says *"confirm which models are actually stationed in Flensburg and prioritize those."* Three models are explicitly Flensburg-stated (Elan Impression 444, Salona 44, Grand Soleil 46).

**§C.6's constraint attaches to every candidate:** no boat ships without a sourced, per-hull draft, and **any boat deeper than 2.10 m additionally needs a `verify_mask.py` run at its derived gate first** — which is all three of the deepest models, including the Flensburg-stated Grand Soleil 46. §G.3 rule 4 (ask Skipperteam) is the cheapest action that moves this question.

---

## K. Acceptance

- **Reduces to today.** With only the Salona 45 in the catalogue, a plan is byte-identical to a pre-#54 plan: `draftM 2.1` → default gate 3.0 → mask floor 2.1; relaxation window `[2.1, 3.0)`; two sails; same solve order; same budget; same tiers. Verify with `app/sweep/` (BASE double-run control first, six arm files asserted per output directory per #451) — this addendum changes solve *ordering* plumbing even where it changes no value. **State the strength honestly:** at one boat with two sails the sweep proves *no regression*; it cannot exercise the new N-generality at all, because there is no third sail and no second boat to exercise it with.

  **And the sweep is BLIND to the `PlanResultOk` rename specifically — do not accept it as evidence for that step.** `compare.mjs` compares plans as `JSON.stringify(ja[k]) === JSON.stringify(jb[k])` plus a whole-file sha256 (`~:83-107`), with no field awareness, so renaming `genoa`/`fock`/`genoaReason`/`fockReason` to a per-sail list makes **every** `status: 'ok'` row differ whether or not a route moved. Worse, it fails in the reassuring direction: `PlanResultError` (`app/src/types.ts ~:235-238`) carries no sail fields at all, so the all-error `becalmed` and `deep-becalmed` arms — already documented as vacuous safety evidence, 33/33 errors each — stay byte-identical through any such rename and would report **IDENTICAL**, reading as partial green. A byte comparator can certify *no change*; it cannot certify a *deliberate* one. The rename step therefore needs a **canonicalise-then-compare** control — map both BASE and HEAD plans into one shape, then compare — and the sequencing consequence is that §C.4a's per-boat floor and §C.8's guard should land **before** the rename, while the byte comparator is still sound.
- **The safety invariant is guarded, per boat.** §C.8's R0–R8 pass; R1's non-vacuity twin is mutation-checked in both directions; **R4** reds under a mutation that restores a module constant; R6's Salona literals still read 2.1 / 3.0 / 2.1 / 1.2. **Also honest:** with a one-entry catalogue, R2/R3/R8 iterate a single row and cannot fail differently from R6, so R1's hand-written expected list (`['salona-45']`) and its discriminating experiment are what stand between *those* rows and vacuity in release 1 — run that experiment, do not assume it. R5 and R7 do retain independent failure modes even at one boat: R5 reads the two i18n dictionaries, so a copy edit reds it without touching the catalogue, and R7 reads `SAFETY_DEPTH_FIELD.max`, so a range change reds it the same way.
- **`verify_mask.py` exits 0 at every catalogue boat's derived gate**, and its report names each boat's connected / exception / disconnected harbour sets plus each harbour's snap-cell margin.
- **Per-boat polar validation fails closed**: a boat added without its own sanity anchors, or without a `polarProvenance` tier, fails the pipeline build rather than inheriting the Salona's.
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
| **[OQ-3] Generalise `RigRecommendation` to N-way now** | Unnecessary at a cap of 2 and genuinely ambiguous — `tie` among N results has at least two defensible readings and `moot` has three. Required only if the cap is lifted; do not design it speculatively (§E.2). |
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
| **Treat a harbour dropping out at a deeper boat's gate as a defect** | It is correct — a 2.30 m keel cannot enter a 2.0 m basin. The defect would be silently offering it. Fix the *presentation* (per-harbour minimum gate, greyed-out picker entries), not the routing. |
| **Build user-supplied polar import in this addendum** | The strongest honesty story long-term (the user owns the claim), but it needs its own validation and persistence design. File as a follow-up issue (§G.3 rule 3). |

---

## M. What could NOT be determined from the repository

Stated explicitly so a future reader does not mistake silence for a decision.

1. **Every fleet draft in §C.5 comes from outside this repository.** The repo contains exactly one draft (`BOAT_DRAFT_M = 2.1`) and no fleet data of any kind. The figures were cross-checked against a second manufacturer source each, but they are **inputs to be re-verified per hull** — and per keel variant — before any boat ships. §C's arithmetic is correct whatever they turn out to be.
2. ~~**The connectivity ceiling above 3.0 m.**~~ **MEASURED 2026-08-18 — see §N.8.** `verify_mask.py` already reports the deepest gate at which each harbour reaches open water; the run resolves 2.8 / 3.0 / 3.2 / 3.4 m and is what made §N.1's scope selectable. The original text, for the record: `verify_mask.py` has only ever run at 3.0 m (plus two lower per-harbour exceptions); how many harbours survive a 3.2 m gate — the gate all three deepest models need — is unmeasured; §C.6's Marstal worked example is derived from the script's own comment, not from a run.
3. **Whether `app/sweep/` shows any regression from the solve-order plumbing change.** No sweep was run for this document, and per §K it could only show absence of regression at one boat.
4. **Whether polar uncertainty dominates `RIG_TIE_BAND_MS`** (§G.2). The band was sized against solver noise and never against polar error. Unmeasured, and it decides whether an estimated-polar boat may ever present a `decided` recommendation unqualified.
5. **The `VersionError` behaviour in §I.2 is derived** from IndexedDB's origin-scoping and `db()`'s promise caching, not observed in a browser here. It is standard platform behaviour and the code path reads plainly, but the decision against a version bump rests on it.
6. **Whether ORC certificates exist for the fleet.** A targeted database search returned nothing for all nine models — **weak** evidence, a negative search result rather than an absence proof. §G.3 rule 4 recommends asking the operator directly before treating tier C as the only option; this is the substance of the open OQ-6.

---

## N. Amendment 2026-08-18 — tier-C estimated polars authorised (supersedes OQ-7)

**Status:** authorised by the maintainer 2026-08-18. This section **supersedes §J OQ-7** and
**overrules the §L row `[OQ-7] Ship tier-C estimated polars for the Flensburg fleet in release 1`**.
Every other §L row stays in force; §N.6 classifies all 28 so none returns by silence.

The trigger is a product decision, not new evidence: the multi-boat feature must be user-visible in
the v0.12.0 release, and OQ-6 did not move — no certificate was obtained for any fleet model. §A.4
already anticipated this path (the source spec's *"fall back to VPP estimates from comparable 45 ft
cruiser-racers if no ORC certificate data is obtainable"*), so what follows activates a contingency
the source design wrote, at a scale it did not envisage. That distinction is the honest framing and
should not be inflated in either direction.

### N.1 Scope — two models, three vessels, and no harbour lost

| Ship | Model | Vessel(s) | Draft | Derived gate | Basis |
|---|---|---|---|---|---|
| ✅ | Elan Impression 444 | PIRANJA | 1.90 m | **2.8 m** | Flensburg-stated (§C.5). Gate < 3.0, so its reachable-harbour set is a **superset** of today's. |
| ✅ | Salona 44 | SPEEDY GO!, EASY GO! | 2.10 m | **3.0 m** | Flensburg-stated. Gate identical to today's — **no new gate**. Engages §L's "Reuse `BOAT_DRAFT_M` for the Salona 44" row: 2.10 m must be its own literal. |
| ⏸ | Grand Soleil 46 | MARIN | 2.30 m | 3.2 m | **Deferred** — §N.7. |
| ⏸ | the other six models | 10 vessels | — | — | Not Flensburg-stated; #54 asks to prioritise those that are. |

**The property that makes this scope safe:** no catalogue boat's gate exceeds today's 3.0 m, so no
harbour becomes unreachable for any boat and no new connectivity ceiling is crossed.

### N.2 Drafts — an accepted deviation from §M.1, and it must be disclosed

**Decided:** ship the **standard listed keel** for each model (1.90 m, 2.10 m), sourced to the
builder's published specification, **not verified per hull**.

This is a knowing deviation from §M.1 (*"inputs to be re-verified per hull — and per keel variant —
before any boat ships"*) and from OQ-4's per-hull rule. It is recorded as an **accepted cost**, not
as satisfied:

- The Elan 444 also ships a 1.60 m shoal keel. If PIRANJA is that variant the derived gate is
  **over-cautious** — harmless.
- The Salona 44 also ships a ~2.44 m deep keel. If either Salona 44 is that variant the derived
  gate is **optimistic by 0.4 m** — the unsafe direction, and the same class §L rejected the
  variant-picker over (*"a wrong default variant is a silent safety error"*).

**Required mitigation, because the assumption is otherwise invisible to whoever sails the boat:**
each fleet catalogue entry records that its draft is the model's standard keel and unverified for
the individual hull, and that statement is surfaced on the boat picker alongside the provenance
tier — not buried in a JSON field. §L's rejection of the variant-picker stands: this is not a
picker, it is a single sourced default with its uncertainty disclosed.

**Retiring this deviation** needs one confirmed keel per hull (§G.3 rule 4 — ask the operator). The
fallback if a keel is ever contradicted rather than merely unconfirmed is §L row 13, deepest listed
variant.

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
   figures (§N.5).

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

### N.4 Two sails, and the comparison suppressed by type

**Decided:** a tier-C boat ships **two sails**, and its sail comparison is **withheld**.

The second table is the boat's own base table × the Salona 45's documented overlay ramp. The
difference between the two is therefore a function of **the ramp, not the hull** — deterministic,
repeatable, and carrying zero information about that boat. It is not a noisy finding; it is not a
finding. So:

- `RigRecommendation` gains `{ kind: 'not-compared' }`. `assemble` returns it whenever the boat's
  polars are tier C, and whenever fewer than two sails produced a comparable result — which also
  closes the latent N = 1 and N ≥ 3 cases that stamp `decided` today (#553).
- Enforced in `assemble`, **by type, never in the view**.
- No ★ on the tab, no `chip-faster-rig`.

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

### N.5 The honesty surface

§L's row *"Ship estimated polars with only the existing source-note disclosure"* is **not overruled
and becomes binding**. The label appears at: the boat picker; the **planner panel beside the
selected boat, always visible** (§G.3 rule 2b proper); the results card; the plans-list row (read
from the persisted snapshot, so an old plan cannot read as certificate-grade); and the About
dialog — *in addition to*, never instead of. `BoatSnapshot.sails[].polarProvenance` already carries
`{tier, note}` by value, so no new persisted field is required.

Copy requirements, per OQ-2 parameterised by the **selected** boat and never a catalogue-wide worst
case:

- A tier chip per provenance tier.
- A plan-time detail sentence naming: that the table is scaled from a comparable hull, that no
  certificate was obtained, an uncertainty band in words (**"typically within a few percent, up to
  about ten percent in individual conditions"** — no decimal), and the light-air operational
  consequence below.
- **A sentence disclaiming the difference between the two sails** for a tier-C boat — new in this
  amendment, required by §N.4.
- A sentence recording that the draft is the model's standard keel, unverified per hull (§N.2).
- `route.eta.indicative` on the ETA; `route.comparisonIncomplete` for #540's unconsumed
  `comparisonComplete`.
- No chart-authority language: nothing may say *accurate*, *verified*, *reliable* or *safe*.
  *Indicative* / *Anhaltswerte* is the register.

**Label hard: sail-vs-motor classification below 8 kn.** Measured on the shipped genoa table at the
default sail-speed floor, every motoring heading occurs at TWS ≤ 8 (10/15 headings at TWS 4, 4/15
at 6, 2/15 at 8, zero at 10 and above), and the estimator's error is worst in exactly that band. So
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
| E6 | **A tier-C boat must declare its second sail's derivation explicitly** (which base sail, which ramp), and any tier-C sail set must resolve to `not-compared`. *(Replaces the one-sail form of this rule, which §N.4's decision retired.)* |
| E7 | Estimated speeds must be **reproducible**: re-running the estimator from the committed inputs reproduces the committed `speeds` byte-for-byte. Perturb one input and the build reds. |
| E8 | Every existing structural check is retained unchanged. |

### N.7 What is deferred, and why — so it is not read as forgotten

- **Grand Soleil 46 (MARIN).** Its 3.2 m gate loses `aabenraa` and `faldsled`, and `aabenraa`'s
  snap cell reads 3.0 m so at that gate it has no navigable snap cell at all — a harder failure
  than a blocked channel. It additionally needs §C.6's per-harbour picker marking, which does not
  exist (`harbors.json` carries `approachNote, country, id, names, snap` and no gate field) and
  whose greyed-out presentation is **not designed**. §L's *"Treat a harbour dropping out at a
  deeper boat's gate as a defect"* row stands: the fix is presentation, not routing.
- **The other six models.** Not Flensburg-stated; two of them (2.25 m, 2.30 m) also cross 3.2 m.
- **Tier B for any fleet model.** Blocked on three items, none of which is a research question:
  donor-hull identity per keel, a reproducible white-sail downwind correction (the shipped `fock`
  note's 23-boat ratio study coefficients are **not in this repository**), and licence/ToU for
  redistributing certificate-derived tables in a public app.
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
  plus aabenraa, faldsled; **3.4 m** — plus langballigau. Navigability is monotone in the gate, so
  a shallower gate's set is a strict superset. This is what made §N.1's scope selectable rather
  than guessable, and it retires §M.2's "unmeasured" status while leaving §L's mask-refinement row
  untouched.
- **§G.3 rule 2** ("*not designed here*") is now designed, by §N.4–N.6.
- **§K's release-1 acceptance** ("*reduces to today*") no longer describes the catalogue. It
  remains the correct statement for the **Salona 45 row** and must be re-scoped, not deleted:
  with three catalogue boats, R2/R3/R8 stop being vacuous and the sweep can exercise a second gate
  for the first time.
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
a defect* — no boat in scope is deeper than 2.10 m. Both become engaged by §N.7's Grand Soleil
follow-up.

Explicitly **not** breached: *`[OQ-3]` generalise `RigRecommendation` to N-way*. Adding a
`not-compared` variant is not N-way generalisation; the cap stays at 2 and no N-way tie semantics
are defined.

All remaining rows are in force, untouched.
</content>
