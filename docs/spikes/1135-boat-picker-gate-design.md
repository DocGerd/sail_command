# #1135 — Boat-picker gate: marking harbours a boat cannot reach

Design document only. No code, pipeline, `harbors.json` or spec change. The
maintainer ruled on every open question on 2026-09-17 (§12); implementation
follows in the §13 issues.

## 0. Recommendation

1. **Boat stays selectable.** Its picker row gains a harbour-access disclosure
   listing the harbours affected for that boat.
2. **Harbours are marked per boat** in the origin/destination pickers and on
   the selected-endpoint row, extending the existing `knownDisconnected`
   marker (#652/#834).
3. **The per-(boat, harbour) state is derived at runtime** from the loaded
   mask, by extending the existing #834 module `app/src/lib/harborReachability.ts`
   (outside the #282 sweep closure) — not stored in `harbors.json`.

Three spec changes, all ruled (§12): §5.2 keeps affected harbour entries
selectable where §L prescribes "greyed-out picker entries" (Q6); C1 replaces
§C.6 bullet 2's per-harbour minimum gate in the harbour list or verify output
(Q6); and a boat switch will raise a stored safety depth to the boat's default
(§C.7, Q4, §13 item 4).

Measured on the committed mask (§3): a stored `verify_mask.py` figure would
mark **11** harbours for a 3.5 m gate, where a derivation shaped like the
router's own snap and relaxation marks **4** (2 routable only with a depth
warning, 2 not at all).

## 1. Problem

Spec `2026-08-10-multi-boat-design.md` §N.7 defers EASY GO! (Salona 44, 2.55 m)
and MARIN (Grand Soleil 46, 2.30 m) because their derived gates drop harbours,
and "the defect would be silently offering it". §L's row *"Treat a harbour
dropping out at a deeper boat's gate as a defect"* rules the routing correct
and the presentation missing. #573 (remaining fleet) and #567 (sister-ship
polar sharing) both cite that missing presentation as their blocker.

§N.7/§N.8's per-gate harbour lists were measured 2026-08-18, before #295 widened
the mask to 40 harbours. §3 re-measures; do not quote the §N.8 sets.

## 2. What "the gate" is, per boat and per harbour

Three quantities, all per boat (`app/src/lib/boatDepth.ts`):

- `defaultSafetyDepthM(b)` = `ceilToDecimetre(draftM + MASK_TOLERANCE_M)` — the
  boat's recommended gate.
- `minSafetyDepthM(b)` = `ceilToDecimetre(draftM + 0.1)` — the clamp floor.
  `clampSettingsToBoat` (`app/src/lib/boatSettings.ts`) raises a stored
  `safetyDepthM` only to THIS on a boat switch today (Q4 changes this, §13 item 4). So the
  gate actually in force is `settings.safetyDepthM`, which can sit below the
  default (a stored 3.0 m survives a switch to EASY GO!, whose default is 3.5 m).
- `relaxationFloorM(b)` = `ceilToDecimetre(draftM)` — how low #53 relaxation
  may go.

What the router does with a destination, in order (`app/src/routing/planRoute.ts`):

1. `mask.snapToNavigable(req.destination, s.safetyDepthM)` — nearest navigable
   cell centre within 300 m at the requested gate. `null` → `snap-failed-destination`.
   Snapping is NOT relaxable (`snapToNavigable`'s own #452 comment).
2. Solve at the requested gate. On `mask-blocked`, `depthRelaxationMayHelp`
   plus `s.safetyDepthM > relaxationFloorM(deps.boat)` admits `findRelaxedGate`
   (`app/src/routing/relaxedDepth.ts`): relaxation inside a 1 nm disc
   (`APPROACH_RADIUS_M`, `app/src/lib/depthGate.ts`) around each snapped
   waypoint, requested gate elsewhere. A relaxed route ships with the `shallow`
   disclosure.

`pipeline/verify_mask.py` answers a different question: its
`DEEPEST_CONNECTING_GATE_DM` sweep floods from `SEED_LAT, SEED_LON` and tests
the harbour's **exact snap cell**, with no 300 m ring and no relaxation.

So the per-(boat, harbour) state has four values:

| State | Definition (at gate `G = settings.safetyDepthM`, floor `F = relaxationFloorM(b)`) | Routes? |
|---|---|---|
| `ok` | snap within 300 m at `G`, snapped cell seed-connected at uniform `G` | yes |
| `shallow-approach` | snaps at `G`; seed-connected only with a 1 nm disc at `F` around it | yes, with `shallow` banner |
| `unreachable` | snap fails at `G`, or not seed-connected even with the disc at `F` | no |
| `known-disconnected` | existing `knownDisconnected` field — no gate helps | no |

Stated limits, so the marking is not read as a router prediction:

- **Pair-dependence.** `findRelaxedGate` relaxes the whole waypoint chain; a
  per-harbour state assumes the OTHER endpoint is seed-connected at `G`. For
  a harbour pair both needing relaxation, `shallow-approach` is an upper bound.
- **Mask only.** `ok` says nothing about wind, horizon or budget failures.
- **Seed component.** Two harbours sharing a pocket not connected to the seed
  would both read `unreachable` while connecting to each other. Not measured
  here.

## 3. Measurement

**Method.** Plain-JS port (scratchpad, not committed) of `verify_mask.py`'s
4-connected seed fill over the committed `mask.bin` (3025 × 3120 = 9,438,000
cells), plus an existence-and-nearest port of `snapToNavigable`'s 300 m search,
plus a one-disc (`APPROACH_RADIUS_M`) approximation of relaxation around the
snapped cell. Five hulls: the three catalogue boats and the two §N.7-deferred
drafts. Node v24.15.0, WSL2, 32 cores, load average 2.66 at start.

**Positive control.** The port's deepest-connecting-gate per harbour equals a
fresh `verify_mask.py` run (exit 0) on **40 of 40** harbours; the five
`KNOWN_DISCONNECTED` harbours read `none` in both (negative control). This
controls the fill port only; the snap and one-disc relaxation ports are
uncontrolled beyond the Marstal row below, so §13 item 1's differential
against the real `snapToNavigable`/`findRelaxedGate` remains the gate.

**Result** (40 harbours; `known-disconnected` = arnis, dyvig, graasten,
kappeln, maasholm for every hull):

| Hull | Draft | `G` (default) | `F` | `ok` | `shallow-approach` | `unreachable` |
|---|---|---|---|---|---|---|
| salona-45 | 2.10 | 3.0 | 2.1 | 34 | marstal | — |
| salona-44-speedy-go | 2.10 | 3.0 | 2.1 | 34 | marstal | — |
| elan-444-piranja | 1.90 | 2.8 | 1.9 | 34 | marstal | — |
| MARIN (deferred) | 2.30 | 3.2 | 2.3 | 33 | faldsled, marstal | — |
| EASY GO! (deferred) | 2.55 | 3.5 | 2.6 | 31 | faldsled, rudkoebing | augustenborg (snap), marstal |

The Salona 45's `marstal` row reproduces the documented Flensburg→Marstal
relaxation at default settings — a third control, from the router side.

**Stored-figure divergence.** At 3.5 m the exact-snap-cell predicate
(`verify_mask.py`'s deepest-gate table) fails 11 harbours: aabenraa,
augustenborg, burgstaaken, faldsled, fynshav, kolding, langballigau, marstal,
nyborg, orth, rudkoebing. Seven of those snap within 300 m to a seed-connected
≥ 3.5 m cell (distances 36–252 m; e.g. burgstaaken 252 m, orth 194 m), so
they are `ok` under §2's definition. A marking built from the stored figure
would warn on seven harbours the snap-aware derivation does not mark.

**Timing** (one uniform fill at 3.0 m, 4,199,166 cells visited, 7 runs):
min 108.5 ms, median 108.8 ms, max 111.6 ms. Full per-hull classification
(one uniform fill plus one disc fill per non-`ok` harbour): 954–979 ms for the
catalogue boats (7 fills), 1,119 ms MARIN (8), 1,244 ms EASY GO! (9). Node, not
a browser worker, and not the Galaxy Tab S7 reference device; CDP throttling
cannot stand in for it on a Worker (#1147). Treat as a relative cost only.

## 4. Options

### 4.1 Boat side

| Option | Verdict |
|---|---|
| **A1. Selectable, with harbour-access disclosure** | **Recommended.** A 2.55 m hull that cannot enter Marstal is still the boat the user is sailing. |
| A2. Greyed-out, unselectable | Rejected — §6. |
| A3. No boat-side change (harbour marking only) | Rejected — §6. |

### 4.2 Harbour side

| Option | Verdict |
|---|---|
| **B1. Per-boat marker in the pickers and selected-endpoint row** | **Recommended.** The decision is made at harbour choice; the marker must be there. |
| B2. Disclosure on the Boat tab only | Rejected — §6. |

### 4.3 Where the gate comes from

| Option | Verdict |
|---|---|
| **C1. Runtime derivation from the loaded mask** | **Recommended.** Follows `settings.safetyDepthM` and mirrors the router's 300 m snap (§3). |
| C2. Stored per-harbour minimum gate in `harbors.json` | Rejected — §6, with the precedent it has in its favour. |

## 5. States and wireframes

### 5.1 `BoatPicker.tsx` option row (`BoatOption`)

The selected boat uses the live `settings.safetyDepthM`, so it matches the
harbour picker; every other boat uses its own `defaultSafetyDepthM(b)`,
labelled as the default (Q7, §12).

```
( ) EASY GO!                         Draft 2.55 m   [Estimated]
    Assumed keel: <keel>. Not checked against this vessel's papers.
    <draft provenance note>
    ▸ Harbour access — 4 harbours affected at 3.5 m (default) <- new Disclosure
        Only with a depth warning: Faldsled, Rudkøbing
        Not reachable: Augustenborg, Marstal
    ▸ Polar data & provenance
```

- Boat with nothing affected beyond `known-disconnected`: one line,
  no disclosure ("Reaches every harbour the reference boat reaches" is NOT
  proposed — it would be a comparative claim the derivation does not make).
- Derivation pending or mask failed to load: "Harbour access not yet checked."
  Never render an empty list while pending: an empty list reads as all-clear
  (the `segmentShallowestBelow` null-vs-zero hazard, in UI form).
- The disclosure's summary id joins the radio's `aria-describedby` list
  (`keelDescribedBy`), so arrowing onto the boat announces the count.

### 5.2 `HarborPicker.tsx` option row

Computed for the SELECTED boat at `settings.safetyDepthM`.

```
Search harbor… [ mars           ]      (EASY GO!, safety depth 3.5 m)
  Marstal
    Not reachable with EASY GO! at 3.5 m safety depth.        <- new, text
    <approachNote>
```

```
  Faldsled
    Only via a shallower approach with EASY GO! — depth warning.
```

- Rendered in the `.harbor-picker-unreachable` slot the `knownDisconnected`
  marker uses; `known-disconnected` keeps its own string and wins over the
  boat-scoped states.
- The option stays a normal `role="option"`: selectable, not `aria-disabled`.
  Planning to it produces the existing typed no-route error.
- No reordering. `rankHarbors` stays search-ranked; demoting affected harbours
  would hide a result the user typed.

### 5.3 `PlannerPanel.tsx` selected-endpoint row

Mirrors the #834 precedent (the `originHarbor?.knownDisconnected` block):
same key, same class as §5.2, so the marker survives the pick.

### 5.4 Boat switch with endpoints already chosen

```
Boat selection
  (•) EASY GO!
  Destination Marstal is not reachable with EASY GO!.            <- new, same role="status"
```

Appended after the existing C.7 clamp notice when both fire. The endpoint
itself is kept, not cleared, and planning stays enabled (Q1, §12).

## 6. Considered and rejected

| Option | Why it lost |
|---|---|
| **Greyed-out, unselectable boat (A2)** | The routing is correct and most harbours work (31–34 of 40 `ok` for every hull measured), so disabling hides a usable boat for a per-harbour fact. |
| **Greyed-out / disabled harbour entries (§L, §N.7)** | The spec's own prescription, so rejecting it is a deviation; the maintainer accepted it (Q6, §12). `shallow-approach` harbours route (§3), so disabling would block routable destinations; an `unreachable` pick already ends in the typed no-route error (§5.2). |
| **Disclosure on the Boat tab only (A1 without B1)** | The #455 §6 argument the spec's §L already applies to the About dialog: a disclosure away from the moment of exposure is structurally withheld. The user picks a harbour in the Plan tab, not the Boat tab. |
| **Harbour marking only (B1 without A1)** | Hides the per-boat comparison until a harbour is typed; a skipper choosing between SPEEDY GO! and EASY GO! for a Marstal trip would have to switch boats to find out. |
| **Stored per-harbour gate in `harbors.json` (C2)** | Has a real precedent — `knownDisconnected` is already a build-generated field from `verify_mask.py` (`HarborPicker.tsx`'s #652 comment) — and costs nothing at runtime. Loses on three counts: (1) the figure `verify_mask.py` computes today is the exact-cell one, which at 3.5 m marks 7 harbours the snap-aware derivation leaves `ok` (§3) — an algorithm difference, not a storage one, since a pipeline could store the snap-aware answer; (2) it is gate-keyed data for a gate that is a user setting, so it would need a full per-decimetre table rather than one number per boat; (3) `harbors.json` and `pipeline/build_harbors.mjs` are IN the #282 closure (§9), so the stored form owes a sweep that the runtime form does not. Keep `knownDisconnected` stored: it is gate-independent, so none of the three applies to it. |
| **Store the gate, derive only relaxation at runtime** | Two sources for one state, and the stored half still carries the snap-ring divergence. |
| **Demote affected harbours in search ranking** | See §5.2. |
| **Clear an endpoint that becomes unreachable on boat switch** | Silent loss of user input on a reversible action (a switch back would not restore it). Marking is enough. |
| **One derivation for every boat at the live `safetyDepthM`** | That setting is the selected boat's; applying it to other rows would under-mark deep boats (a stored 3.0 m makes EASY GO! look like a 3.0 m boat). |

## 7. i18n (de/en, both dicts, `satisfies Record<MsgKey, string>`)

`t()` interpolates `{var}` only, so no plural forms: counts appear only in
number-first phrasing that needs none.

| Key | en | de |
|---|---|---|
| `boat.harbors.summary` | Harbour access — {count} affected at {depth} m | Hafenzugang – {count} betroffen bei {depth} m |
| `boat.harbors.shallow` | Only with a depth warning: {list} | Nur mit Tiefenwarnung: {list} |
| `boat.harbors.unreachable` | Not reachable: {list} | Nicht erreichbar: {list} |
| `boat.harbors.pending` | Harbour access not yet checked. | Hafenzugang noch nicht geprüft. |
| `harborPicker.boatUnreachable` | Not reachable with {boat} at {depth} m safety depth. | Mit {boat} bei {depth} m Sicherheitstiefe nicht erreichbar. |
| `harborPicker.boatShallow` | Only via a shallower approach with {boat} — depth warning. | Mit {boat} nur über eine flachere Zufahrt – Tiefenwarnung. |
| `harborPicker.boatLowerSetting` | May route at {depth} m, below {boat}'s recommended {default} m safety depth (depth data only). | Mit {depth} m eventuell planbar, unter der für {boat} empfohlenen Sicherheitstiefe von {default} m (nur Tiefendaten geprüft). |
| `harborPicker.boatLowerSettingShallow` | May route at {depth} m with a depth warning, below {boat}'s recommended {default} m safety depth (depth data only). | Mit {depth} m eventuell mit Tiefenwarnung planbar, unter der für {boat} empfohlenen Sicherheitstiefe von {default} m (nur Tiefendaten geprüft). |
| `boat.switch.endpointUnreachable` | {endpoint} {harbor} is not reachable with {boat}. | {endpoint} {harbor} ist mit {boat} nicht erreichbar. |

For the two `boatLowerSetting*` keys (Q5): `{default}` is
`defaultSafetyDepthM(b)`, and `{depth}` is the highest decimetre in
`[minSafetyDepthM(b), min(G, {default}))` at which the harbour is `ok` (plain
key) or `shallow-approach` (`…Shallow` key); no decimetre, no hint.

`{list}` is harbour names in the active language (`names[lang]`), joined by the
implementation. `{boat}` is `BoatDef.name`, catalogue data. Before shipping,
check every new visible string in BOTH languages against existing
`getByRole` names: Playwright matches by substring (CLAUDE.md), and German adds
prefix collisions English lacks. "Tiefenwarnung" should be replaced by whatever
term the shipped `ShallowWarning` banner uses, so the two surfaces name one thing.

## 8. Accessibility

- Every state is text, never colour alone — the `.harbor-picker-unreachable`
  marker is already a text span.
- Affected harbours stay operable options; nothing is `aria-disabled`.
- Boat row: disclosure summary referenced from the radio's `aria-describedby`.
- Harbour option: the marker is inside the `role="option"` element, so it is
  part of the option's accessible name as the `knownDisconnected` marker is.
- Boat switch: announced through the existing unconditionally-rendered
  `.boat-picker-notice` `role="status"` region, not a new live region.

## 9. Offline and cost

- **Offline.** Needs only `mask.bin`/`mask.meta.json`/`harbors.json`, already
  precached and loaded by `loadRoutingAssets` (`app/src/services/assets.ts`).
  No network. A failed asset load degrades to the `pending` string (§5.1),
  following `useNavMask`'s rule that a missing mask degrades to an honest
  "could not check", never to a blank readout.
- **Cost.** ~109 ms per uniform fill in Node (§3); a per-hull classification
  is ~1 s. Recommendations for the implementation:
  - cache uniform fills by gate decimetre (today's catalogue has two distinct
    default gates, 2.8 and 3.0 m);
  - skip `known-disconnected` harbours and run disc fills only for the rest
    that fail the uniform fill — 1–3 per hull measured (the §3 timings
    include the five skippable ones);
  - compute off the main thread or in idle slices; a 100 ms+ synchronous fill
    on a tablet is a visible stall;
  - recompute the harbour-side state on `settings.safetyDepthM` or boat
    change only, never per keystroke of the depth field (commit-on-blur).

## 10. Would the implementation owe a #282 sweep?

`node .claude/skills/sweep-closure/closure.mjs files …` on this branch's base:

| Path | Verdict |
|---|---|
| `app/src/components/BoatPicker.tsx`, `HarborPicker.tsx` | NOT_IN_CLOSURE |
| `app/src/lib/harborReachability.ts`, `app/src/state/useNavMask.ts` | NOT_IN_CLOSURE |
| `app/src/i18n/dict.en.ts` | NOT_IN_CLOSURE |
| `app/src/routing/protocol.ts` | NOT_IN_CLOSURE |
| `app/src/lib/mask.ts`, `app/src/lib/depthGate.ts`, `app/src/lib/boatDepth.ts` | IN_CLOSURE (import walk) |
| `app/src/data/boats.ts` | IN_CLOSURE (import walk) |
| `app/public/data/harbors.json`, `pipeline/build_harbors.mjs`, `pipeline/verify_mask.py` | IN_CLOSURE (path prefix) |
| `app/src/test/verifyMaskConnectivity.test.ts` | NOT_IN_CLOSURE |

So:

- **Runtime derivation in `harborReachability.ts`** (#834) that imports `mask.ts`/`depthGate.ts`
  but is imported by nothing in the closure: **NOT owed** (the walk runs
  outward from the sweep's roots).
- **Adding a method to `NavMask`** (e.g. a seed-component fill): **OWED** at
  file granularity, though `PlanResult` would be byte-identical. The seed fill
  therefore belongs in `harborReachability.ts`, over `NavMask`'s public surface or a
  duplicated traversal guarded by a differential test (the `shallowExposureNm`
  precedent). `verifyMaskConnectivity.test.ts` already carries a test-side TS
  seed fill (`reachableSetAtGate`) with its own differential against
  `NavMask.cellsConnected` to start from.
- **Stored field (C2):** OWED.
- **Adding EASY GO!/MARIN to `boats.ts`** (#573's own PRs): OWED regardless of
  this design.

## 11. How #573 and #567 unblock

This design removes the presentation blocker only. Still separately needed:

- **`verify_mask.py` and `app/src/test/verifyMaskConnectivity.test.ts`** fail
  the run for any harbour disconnected at a catalogue boat's derived gate
  (`verify_mask.py`'s `CONNECTIVITY … not reachable` failure branch; the test's
  `it.each(BOATS)` "every harbor reaches open water at its derived gate").
  Both use the exact snap cell (the test's `connectedAtGate(…, h.snap)`), so
  at 3.5 m they would fail on 11 harbours, not the 4 §3 marks (2
  `unreachable`, 2 `shallow-approach`). A deep
  boat therefore cannot land until both accept an explicit per-boat
  expected-drop set — spec §C.6's "a harbour dropping out … is CORRECT", made
  mechanical. That set should be differential-tested against the runtime
  derivation so the pipeline and the UI cannot disagree about which harbours
  a boat loses.
- **#567**: the sister-ship polar decision (its options 1–3) is independent
  of this design and still open.
- **Per-hull draft and polar provenance** for each #573 boat, per that issue's
  definition of done.

## 12. Maintainer rulings (resolved)

Q1–Q6 resolved 2026-09-17 in [#1135 comment 5705456439](https://github.com/DocGerd/sail_command/issues/1135#issuecomment-5705456439).

- **Q1 RESOLVED.** Endpoint unreachable after a boat switch: mark and
  announce (§5.4); planning stays enabled.
- **Q2 RESOLVED.** `shallow-approach` stays its own state (three states:
  `ok`, `shallow-approach`, `unreachable`, plus the existing
  `known-disconnected`).
- **Q3 RESOLVED.** Derive the selected boat at asset load; other boats lazily
  when the Boat tab opens.
- **Q4 RESOLVED.** Keeping a stored depth below the boat's default is not
  intended: a boat switch raises it to `defaultSafetyDepthM(b)`, never lowers
  it. This changes `clampSettingsToBoat` (`app/src/lib/boatSettings.ts`,
  today `minSafetyDepthM`) and spec §C.7's "new boat's minimum" rule, so it is
  its own follow-up (§13 item 4).
- **Q5 RESOLVED.** One `unreachable` state; its disclosure says whether a
  lower allowed setting (down to `minSafetyDepthM(b)`) would reach the harbour.
- **Q6 RESOLVED.** Both deviations accepted: harbour entries stay selectable
  with a marker, and the gate is runtime-derived. Spec §L and §C.6 are
  amended by the main session (§13 item 6).
- **Q7 RESOLVED** ([#1135 comment 5710179550](https://github.com/DocGerd/sail_command/issues/1135#issuecomment-5710179550)).
  The Boat tab's disclosure uses the live safety depth for the selected boat,
  so it matches the harbour picker; other boats use their own default,
  labelled (§5.1).

## 13. Follow-up issues (ready to file, not filed)

Sweep verdicts from `closure.mjs files` on this branch's base (§10):
`boatSettings.ts`, `BoatPicker.tsx`, `HarborPicker.tsx`,
`harborReachability.ts` and the i18n dicts are NOT_IN_CLOSURE; `types.ts`,
`boatDepth.ts`, `mask.ts` and `pipeline/verify_mask.py` are IN_CLOSURE.

1. **Derive per-boat harbour access at runtime** — extend
   `harborReachability.ts` with the three states of §2 (selected boat at load,
   others lazily), caching per §9, differential tests against real
   `snapToNavigable`/`findRelaxedGate` and `verify_mask.py`'s table. Sweep
   owed: **no**, if `mask.ts`/`depthGate.ts` are imported, not edited.
2. **Mark harbour access in the origin/destination pickers** — marker in
   `HarborPicker` options and `PlannerPanel`'s selected-endpoint row, Q5's
   lower-setting hint, de/en keys, jsdom + e2e with a non-default boat.
   Depends on 1. Sweep owed: **no**.
3. **Show harbour access on each boat in the Boat tab** — `BoatOption`
   disclosure, `aria-describedby`, pending state, boat-switch announcement
   (Q1); selected boat at the live setting, others at their labelled default
   (Q7). Depends on 1. Sweep owed: **no**.
4. **Raise safety depth to the boat's default on boat switch** —
   `clampSettingsToBoat` floor `minSafetyDepthM` → `defaultSafetyDepthM`,
   clamp-notice copy, tests (Q4). Sweep owed: **no** while confined to
   `boatSettings.ts`/`BoatPicker.tsx`/dicts; **yes** if it edits `types.ts`
   (`DEFAULT_SETTINGS`) or `boatDepth.ts`.
5. **Accept per-boat expected-unreachable harbours in mask verification** —
   `verify_mask.py` and `verifyMaskConnectivity.test.ts`; prerequisite for any
   #573 deep hull. Sweep owed: **yes** (`pipeline/` path prefix).
6. **Amend the multi-boat spec for the #1135 rulings** (main session only) —
   §L greyed-out row and §C.6 bullet 2 (Q6), §C.7 clamp target (Q4), §N.7/§N.8
   harbour lists to the post-#295 mask. Sweep owed: **no** (docs).
