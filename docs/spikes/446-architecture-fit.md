# Spike: does the architecture still fit? — layering, `App.tsx` concentration, prose-only invariants, and the MapLibre call-site surface

- Issue: [#446](https://github.com/DocGerd/sail_command/issues/446)
- Date: 2026-08-09
- Status: Recommendation (no implementation in this change)
- **Verdict: THE ARCHITECTURE FITS. Change nothing structural.** Stated
  per candidate, because the four do **not** share one answer and an
  earlier revision of this line said they did:
  - **C2** (MapLibre facade / narrowed `MapInstanceCtx`) — **DECLINED.**
    One attributable defect (#160), and it is a runtime insertion-order
    race using `addLayer`, which every candidate interface still
    exposes; already owned by `components/layerOrder.test.tsx`.
  - **C3** (reduce `PlannerPanel`'s props) — **DECLINED.** Zero
    attributable defects; +1 prop in five releases.
  - **C4** (re-layer `lib/`) — **DECLINED.** Zero attributable defects;
    zero cycles; linear growth.
  - **C1** (`AppShell` extraction) — **NOT declined.** Its verdict is
    **PROCEED INCREMENTALLY.** Three attributable defects sit in its
    9-cell cluster (`e736aef`/#38, `46e3e93`/#134 review,
    `2c8dd0d`/#301 MAJOR) and **two of the three** would have been made
    unrepresentable by a hook owning those cells. What caps it is not
    an absence of defects but a mismatch: the five spans that separate
    cleanly are 137 of 960 lines and carry **zero** defects between
    them, while the cluster carrying all three does **not** separate.
    All three were caught in review and **none shipped**, which is what
    makes it incremental rather than urgent.

  What the evidence supports is three cheap, local, non-architectural
  changes — one real **bug** in `PanelResizer`'s interrupted-drag
  handling (measured, four failure endings), two **stale comments** at
  the `activeLegIndex` declaration site that still carry the pre-#158
  reading that licensed a real bug, and one **unasserted component**
  (`ViaMarkers`, whose marker-creation path no test executes) — plus
  three **offers** that are deliberately not recommendations (§R4 and
  the two items below the recommendation table). The finding that
  argues for restraint rather than action is the tooling budget: the
  `area: tooling` share of *newly created* issues has risen across all
  four weeks measured, 2.5% → 49.2%, on the four-point series and
  base-rate caveat stated in Q15.

This document answers all fifteen questions in #446's "Questions the
spike must answer", under its own five headings (A–E). It changes no
code under `app/src/`, `app/vite.config.ts`, `pipeline/`, `CLAUDE.md`,
`.claude/` or `docs/superpowers/`.

**Base: `develop`@`7195787`.** Every `file:line`, count and percentage
below was measured against that commit.

---

## Provenance — which figures were measured by whom, and where the inputs ran out

#446 is a five-section survey and was answered by five section owners.
This document is the synthesis. Being precise about that split matters,
because #446's own house rule is per-site re-derivation and a synthesis
is exactly where a delegated number gets laundered into a verified one.

| Part | Source |
|---|---|
| A (Q1–3), B (Q4–6), C (Q7–9) | Section owners' measurement, re-derived at `7195787`. A representative sample re-verified independently in this run — see below. |
| D (Q10–11) | Section owner's measurement. **Arrived truncated mid-Q11**; Q11's closing recommendation is reconstructed below from facts this run re-verified directly, and labelled where that is the case. |
| D (Q12) | **Not supplied.** Measured in this run. |
| E (Q13–15) | **Not supplied at all.** All three measured in this run. |

**Independently re-derived in this run** (not taken on the section
owners' word): `App.tsx` = 1120 lines and `AppShell` = `App.tsx:153-1112`
(960 lines); `PlannerPanelProps` = 24 named fields;
`useMapInstance()` = 8 non-test invocation sites; `routing/`'s complete
non-test import set; `RouteLayer.tsx`'s `setupLayers` span, its
`installStyleSetup` call site and `[map]` dependency array, and its
`addLayer`/`addSource` distribution; `PanelResizer.tsx`'s cleanup and
`onPointerCancel` wiring; `useSessionRestore.ts`'s `:66`/`:72` ordering
and `AppState.tsx`'s `setPlan`; `CLAUDE.md` and `.claude/hooks/` sizes;
test-file counts; the whole `area: tooling` backlog measurement.

**One correction to the section evidence, found by that re-derivation.**
Section B states "all 4 `addSource` and all 16 `addLayer` calls in the
file". Measured here: `grep -c 'map\.addLayer(' app/src/components/RouteLayer.tsx`
returns **13**, and `map\.addSource(` returns **4**. (A bare
`grep -c addLayer` returns 17 and `addSource` 5 — the extra hits are
comments at `:40`, `:45`, `:342`, `:547` and the import-adjacent lines.)
Section B's conclusion is unaffected and stands: the 13 `addLayer` sites
span `:120`–`:424`, entirely inside `setupLayers` (`:105-466`), and
nothing creates or removes a layer or source elsewhere in the file. The
number is wrong; the property it was cited for is right. Recorded rather
than silently fixed, because #446's deliverable will be read as verified.

---

## §0. Re-verification of #446's measured snapshot — six premise errors

#446's snapshot was measured on 2026-08-07. Re-derived at `7195787`
(2026-08-09), most of it reproduces. Six things do not, and four of them
are load-bearing for the questions themselves.

### Reproduced

| Claim | Result |
|---|---|
| Zero import cycles; `routing/` UI-free | `routing/`'s complete non-test import set is `../lib/{geo,mask,polar,wind}`, `../types`, and siblings (`./isochrone`, `./maneuver`, `./planRoute`, `./postprocess`, `./protocol`, `./relaxedDepth`, `./workerClient`). Zero react, maplibre, `components/`, `state/`, `services/`. The only other specifiers are test-only (`fast-check`, `node:fs`/`node:path`/`node:url`, two `?raw` imports) |
| No barrels | one `index` file, `i18n/index.tsx`, a real implementation |
| `seamarkGlyphs.ts` 868 lines | 868 |
| `RouteLayer.tsx` 835 lines, `setupLayers` `:105-466` | both exact |
| One Context, five state fields, no store library | `state/AppState.tsx`, 203 lines |
| 12 runtime dependencies | `app/package.json` `dependencies` block |
| 12 Playwright specs | `ls app/e2e/*.spec.ts` |
| Seven structural guards | seven, enumerated in Q14 below |
| `workbox-strategies` is the notices delta | `app/package.json` lists it; `gen-third-party-notices.mjs`'s `PACKAGES` array lists 11 and omits it |

### PREMISE ERROR 1 — `AppShell` has grown, and the growth is the point

#446: *"`App.tsx` is 975 lines; one function, `AppShell` (`App.tsx:125-967`),
is 843 of them. 11 `useState`, 5 `useRef`, 5 `useEffect`, 1
`useLayoutEffect`, 18 `useCallback`."*

Measured at `7195787`: **`App.tsx` is 1120 lines; `AppShell` spans
`App.tsx:153-1112`, 960 lines** (`grep -n 'function AppShell'` → `:153`;
first column-0 `}` at or after `:153` → `:1112`). Section B measured the
hook census at 12 `useState`, 6 `useRef`, 6 `useEffect`, 1
`useLayoutEffect`, 18 `useCallback`.

This is not pedantry about a two-day-old number. `+145` lines of `App.tsx`
and `+117` lines of `AppShell` landed in the two days between #446's
snapshot and this document, and section B's per-cell analysis places
**every** added cell inside the entangled cluster rather than in the
cleanly-extractable spans. The snapshot decayed in the direction the
strain point predicts, which is itself evidence for A3.

### PREMISE ERROR 2 — `PlannerPanel` takes 24 props, and did not take 22 when the survey ran

#446: *"`PlannerPanel` takes 22 named props and is itself a 485-line
single function."*

Measured at `7195787` by counting top-level members of
`export interface PlannerPanelProps`: **24**. Section B measured the same
interface at #446's own snapshot commit `e5eb389` and got **23** — so the
figure was already wrong when written, not merely stale. The file is
616 lines and its default export spans `:137-616` (480 lines), against
the quoted 485.

The load-bearing correction is independent of the ±1 counting method:
section B measured **23 props at `v0.4.0` and 24 at HEAD**. That is +1
across five releases. **There is no prop-explosion trend**, which is most
of Q5's answer.

### PREMISE ERROR 3 — 8 components call `useMapInstance()`, not 9

#446: *"9 non-test components call `useMapInstance()`."*

Measured: **8 invocation sites**, all of the form `const map = useMapInstance();`
— `AisLayer.tsx:176`, `AisTraffic.tsx:80`, `BoatMarker.tsx:90`,
`CompassControl.tsx:44`, `DataLayers.tsx:210`, `RouteLayer.tsx:475`,
`ScaleBar.tsx:28`, `ViaMarkers.tsx:56`. The remaining name matches are
`MapView.tsx:99` (the **definition**) plus comment mentions at
`App.tsx:792`, `AisTraffic.tsx:61`, `OwnshipMarker.tsx:14` and
`test/fakeMaplibre.ts:7`.

Section C reports that the aggregate "46 distinct `map.*` call shapes"
reproduces exactly, while two of the per-component splits do not
(`BoatMarker` 6 not 7; `ScaleBar` 4 not 3). It also establishes that 46
is the **sum of per-component member sets**, whereas the union a single
narrowed interface would need is **19** — so 46 overstates the type
authoring cost, which is the number Q9 was framed around.

### PREMISE ERROR 4 — "three documented incident classes trace to exactly this shape" is false; one does

#446 strain point 3 attributes #160, #378 and the glyph-fallback class to
the cross-component MapLibre call-site distribution. Section C's
attribution, re-checked here against the file:

- **#160** (closed, "Seamark/harbor layers can insert above AIS vessels
  for a whole session") — genuinely cross-component. It is the one that
  fits.
- **#378** (closed) — all four layers involved are declared in **one
  file**: `RouteLayer.tsx` declares `sc-eta-primary` (`:371`),
  `sc-eta-secondary` (`:394`), `sc-leg-speed` (`:192`) and
  `sc-wind-barbs` (`:424`), all inside `setupLayers`. A distribution
  across components cannot be the cause of a defect confined to one
  function.
- **Glyph fallback (#288, open)** — also intra-file, and upstream-caused:
  the silent TinySDF fallback is MapLibre `GlyphManager` behaviour, not a
  call-site-distribution effect.

So the "largest one-more-feature-makes-it-worse surface" claim rests on
**one** incident, and that incident already has a dedicated
cross-component regression guard: `app/src/components/layerOrder.test.tsx`
(188 lines, per section A), which asserts the bottom→top stack for both
setup interleavings and both `styledata` re-add orders.

### PREMISE ERROR 5 — the "gaps the survey did not cover" list contains one gap that is closed

#446: *"path-alias or dynamic `import()` edges (the scan resolved only
`./` and `../`, so a dependency-direction violation reachable that way is
unchecked)."*

Section A closed it: `grep -n paths app/tsconfig*.json` and
`grep -n alias app/vite.config.ts` both return nothing, and a scan of all
non-test files for `import(` finds **0** dynamic import sites. The
zero-cycle result therefore holds over the **whole** import graph, not
merely the relative subset. This strengthens A1's endorsement rather than
weakening it, and the gap should be struck from the issue.

### PREMISE ERROR 6 — the governance and backlog figures have all moved

All three are shared with #444 and are reconciled in the cross-check
section at the end rather than here, so that the two documents cannot
quote different numbers. Summary: `CLAUDE.md` is **2,522 lines /
26,281 words / 160 distinct / 365 total issue refs** (not 2,395 / 24,891
/ 154); `.claude/hooks/` is **2,755 lines** with `artifact-guard.sh` at
**1,438** (not 2,593 / 1,276); the `area: tooling` backlog share is
**18 of 45 open non-PR issues = 40.0%**, not "13 of 44 (~30%)"; and
there are **116** vitest files under the config's own include glob, not
114.

**Correction to the preceding sentence, kept visible rather than
silently applied, because it is this document's own instance of the
class it audits: the backlog share is 18 of 46 = 39.1 %, not 18 of 45 =
40.0 %.** The denominator moved between the two measurements — #463 was
opened during the same session. Q15 carries both commands, the
enumerated numerator, and the decay note; treat the figure there as
authoritative and this line as the record of how a "cross-check" figure
went stale inside its own document.

---

# Part A — Scope and justification

## A1. What should NOT change?

**All four are ENDORSED as load-bearing. None is rejected.**

**(a) Zero-cycle downward layering with `routing/` UI-free — ENDORSED,
and the payoff is measured rather than aesthetic.** Section A's own DFS
over resolved relative imports (107 non-test files, 329 resolved edges)
finds 0 cycles, and premise error 5 above extends that to the whole graph.
`routing/`'s import set is quoted in §0. The concrete payoff:
`app/sweep/sweepArms.ts:32` imports `planRoute` **directly under Node with
no DOM**, which is what makes the #282 acceptance harness possible at all;
and `isochrone.ts` keeps its deadline parameter optional (section A cites
`:47`/`:104`) precisely so an unbudgeted solve stays reachable from there.
Break the UI-freedom and the harness stops existing.

**(b) The single five-field Context with no store library — ENDORSED.**
`AppStateValue` (`state/AppState.tsx:15-41`) is 5 state fields plus 5
mutators. Non-test importers are **4**, not 6: `App.tsx:9`,
`components/PlansList.tsx:3`, `components/LiveView.tsx:5`,
`components/AisTraffic.tsx:4` — the other two hits #446 counted are
`LiveView.test.tsx:5` and `PlansList.test.tsx:4`. Those three non-`App`
importers matter beyond bookkeeping: they are the live precedent that
makes Q5's five movable props movable at all.

**(c) The absence of barrels — ENDORSED.** One `index` file,
`i18n/index.tsx` (45 lines), with zero `export * from` / `export {…} from`
lines and three real implementations (`I18nProvider` `:14`, `useLang`
`:32`, `useT` `:38`).

**(d) `seamarkGlyphs.ts`'s size — ENDORSED.** 868 lines, 22 top-level
functions, 3 non-test importers (`components/AisLayer.tsx`,
`components/DataLayers.tsx`, `lib/seamarkGeoJson.ts`). Its size tracks the
number of IALA symbol families, not feature count. This is the codebase's
own counter-example to "large file is bad" and #446 is right to name it.

## A2. Does any refactor's cost exceed its benefit?

**Yes for three of the four; not for C1.** C2, C3 and C4 are declined
outright — C3 and C4 for zero attributable defects, C2 because its one
defect (#160) is not of a kind a type surface prevents. **C1 is not
declined**: it proceeds as continued increments of a mechanism that
already exists, and the choice of *how far* to take it is a maintainer
taste call rather than an evidence-driven one.

| Candidate | Attributable past defects | Verdict |
|---|---|---|
| **C1** `AppShell` extraction | **Three live in the cluster; TWO are extraction-preventable.** This column counts the two the instrument would have made unrepresentable — the third, `e736aef` (2026-07-16, #38), sits in the same cluster but was fixed **outside `AppShell` entirely** (a `MapView` `interactiveLayerIds` gate), so it does not attribute to extraction. Q4 and the strain table both say "three" because they count cluster residency; this cell counts preventability. Both cross-concern-in-one-closure, both caught in review, **neither shipped**: `46e3e93` (2026-07-23, "#134 review" — session restore called raw `setTab`, bypassing `handleTabChange`'s tap-pick disarm, so a stray map tap could overwrite origin/destination) and `2c8dd0d` (2026-08-07, labelled MAJOR — `syncedPlanIdRef` at `App.tsx:372` was never reset by `handleImportRoute` at `:541`, so re-loading the same plan id after a GPX import silently skipped the form prefill; the fix is the reset at `:549`) | **PROCEED INCREMENTALLY, never as a big-bang split** — and see Q4, which finds the extraction that *would* have prevented these is the one that does not separate cleanly |
| **C2** MapLibre facade / narrowed `MapInstanceCtx` | **One relevant** (#160), and it is already owned by `components/layerOrder.test.tsx`. Q9 establishes the facade would not have prevented #160 anyway | **DECLINE** |
| **C3** Reduce `PlannerPanel`'s props | **Zero**. Section B checked the file's commit history (`cf726a9`, `c65231c`, `f18c44c`, `79ef507`, `553bb7d`, `c4a25cb`, `2f81668`, `88b0003`) and found no prop-drilling or stale-prop defect; every fix in it is a routing, i18n or GPX-parsing fix | **DECLINE** |
| **C4** Re-layer `lib/` | **Zero**. #446 itself marks this unassessed; section A searched and found none | **DECLINE — NO-ATTRIBUTABLE-DEFECT** |

**C1's cost is bounded, which is the only reason it is not a flat
decline.** Blast radius: `App.tsx` (1120 lines) plus `App.test.tsx`
(1890 lines, 53 top-level `it()`/`test()` lines), which is `App.tsx`'s
**only** importer. And the mechanism is proven rather than speculative —
`state/` already holds 8 non-test modules (1519 lines) with 3256 lines of
dedicated tests. Two or three more extractions of that same shape are
cheap. A rewrite is not on the table.

**The honest counterweight, and it should be stated in the same breath:
both C1 defects were caught before merge. The shipped-bug rate
attributable to this strain is zero.** That cuts directly against urgency.

## A3. Which strain points are growth-coupled?

**Exactly ONE of #446's two hypothesised growth-coupled strains actually
is.** Section A measured each per release tag — historical facts that do
not decay, deliberately chosen over an ahead/behind-style snapshot:

| Metric | v0.4.0 | v0.6.0 | v0.8.0 | v0.10.0 | v0.11.0 / HEAD | Reading |
|---|---|---|---|---|---|---|
| `AppShell` function body (lines) | 710 | 741 | 741 | 843 | **960** | **GROWTH-COUPLED and ACCELERATING** (+102 then +117) |
| Files calling `useMapInstance()` | 10 | 12 | 12 | 12 | 12 | **NOT growth-coupled** — flat for five releases |
| Total `map.*` calls under `components/` | 116 | 144 | 145 | 153 | 153 | **NOT growth-coupled** — flat for three releases |
| `PlannerPanel` props | 23 | — | — | 23 | 24 | **STABLE** (+1 in five releases) |
| `lib/` non-test files | 34 | 37 | 39 | 42 | 43 | **STABLE** — linear ~+2/release, no compounding |
| Files touching local/sessionStorage | 5 | 5 | 5 | 6 | 6 | **STABLE** |

Two consequences worth stating separately, because they point opposite
ways:

1. **Only `AppShell` is growth-coupled, and it is the one candidate with
   real attributable defects.** Those two facts agreeing is not a
   coincidence — it is the strongest signal in the whole survey, and it
   is why C1 survives as "proceed incrementally" while the other three do
   not survive at all.
2. **The persistence-mechanism count is stable for a *structural*
   reason, not by luck.** New persisted values are absorbed by
   `lib/usePersistedToggle.ts` and `lib/usePersistedNumber.ts` (section A
   cites call sites at `RouteLayer.tsx:481,482,488`, `DataLayers.tsx:215,218`,
   `App.tsx:239`) rather than by new mechanisms. A real abstraction is
   taking the growth. #446's "five persistence mechanisms" reads as a
   smell; measured over five releases it is a success.

---

# Part B — `App.tsx` / `AppShell`

## Q4. How many concerns extract without sharing mutable state?

**Five of six extract cleanly — and those five are exactly the ones with
zero attributable defects. VERDICT: DECLINE the extraction.**

First, #446's framing is wrong on two counts and both matter. **"All nine
share one closure scope" is false**: two of the nine are already extracted
hooks called in one line each — `useBannerHeight()` (`App.tsx:163`) and
`useSessionRestore(tab, handleTabChange)` (`App.tsx:599`). And the list
**double-counts**: "replace-recalculation (`:288`)" resolves, at #446's
own snapshot commit, to a **comment line** inside the `planIdRef`
clobber-guard docstring — the fragment *"or, for a #114
replace-recalculation, reuses the id the user explicitly confirmed
overwriting"*, now `App.tsx:330` — not a concern site. The actual concern
is `handleRecalculate` (`App.tsx:663-671`), which #446 already lists
separately. **Distinct concerns genuinely sharing `AppShell`'s closure: 6,
not 9.**

Per-site, at `7195787`:

| Concern | Span | Extracts cleanly? |
|---|---|---|
| Resizable panel | `:202-269` + JSX `:1016-1025` | **CLEAN** — no cell written from outside the seam |
| Live-view slot | `:270-275`, `:814`, `:1105` | **CLEAN** |
| Recalculate | `:657-671` | **CLEAN** |
| Live reroute | `:673-690` | **CLEAN** |
| View-details focus | `:601-620` | **CLEAN via read-only parameters** — needs `tab` and `handleTabChange` in, writes neither |
| Harbour-marker tap-pick | `:571-580` | **NOT CLEAN** |

The five clean spans total **137 of `AppShell`'s 960 lines (~14%)**, and
they are comment-heavy.

**The one that does not separate is the one that matters.** It sits in a
9-cell mutually-writing cluster — `origin` (`:295`), `destination`
(`:296`), `departureMs` (`:297`), `draftViaPoints` (`:305`), `tapTarget`
(`:315`), `planIdRef` (`:338`), `syncedPlanIdRef` (`:372`), `tab`
(`:187`), `aboutOpen` (`:188`, read at `:629`) — with 16 handler/effect
sites. Measured multi-writer counts: `setTapTarget` at `:414`, `:452`,
`:512`, `:523`, `:528`, `:588`, `:631` (**7 sites across 5 nominal
concerns**); `setOrigin` at `:382`, `:465`, `:522`; `setDestination` at
`:383`, `:466`, `:527`.

**All three attributable past defects live in this cluster** — `e736aef`
(2026-07-16, #38), `46e3e93` (2026-07-23, #134 review), `2c8dd0d`
(2026-08-07, MAJOR). So the extraction that would have prevented a real
bug is a **single ~9-cell hook**, not nine hooks — and the nine hooks that
are easy buy nothing measured.

One honesty note that weakens even that: of the three, only the latter two
would have been made unrepresentable by a hook owning the cluster's cells.
`e736aef` was fixed **outside `AppShell` entirely** (a `MapView`
`interactiveLayerIds` gate), so it does not attribute to extraction at all.

### Q4's sub-question: does `viaReplan.state.replanning` force two extractions to stay coupled?

**No — the premise is false.** `replanning` is **read-only at all three
consumers**: `App.tsx:705` (`runBusy`), `:781` (`RouteLayer`'s
`viaReplanning`), `:1068` (`PlannerPanel`'s `viaReplanning`). Its only
writer is inside `useViaReplan` (`state/replan.ts:303ff`), which is
already an extracted hook with a single instance created at `App.tsx:173`.
A fan-out of one hook's read-only output to two children is prop-passing,
not shared mutable state.

**The real cross-concern value in that neighbourhood is `runBusy`**
(`App.tsx:703-706`), which ORs three independent in-flight flags
(`planning.phase`, `viaReplan.state.replanning`,
`liveReroute.state.rerouting`) and is consumed at `:707` (`canPlan`),
`:816` (`LiveView`'s `reroute.busy`), `:1097` (`PlansList`'s `busy`). That
is the mutual-exclusion invariant any split of the three run paths would
have to preserve, and **it is enforced by nothing but this one
expression.** If #446 wants one sentence carried forward from Q4, it is
that one — not the `replanning` question it asked.

## Q5. Are `PlannerPanel`'s props a symptom of `AppShell`'s size, or independently reducible?

**Mostly INDEPENDENT. Five of 24 are already reachable at the child;
removing them leaves 19. VERDICT: DECLINE — no attributable defect (A2 C3).**

Reachable today via an existing Context hook, with live in-repo precedent
(`PlansList.tsx:3`, `LiveView.tsx:5`, `AisTraffic.tsx:4` all call these
directly instead of taking props):

- `settings` + `onSettingsChange` via `useSettings()` (`AppState.tsx:163`)
  — signature-compatible: `setSettings` takes `Partial<Settings>` and the
  child's only call sites pass a full `Settings` (`PlannerPanel.tsx:494`,
  `:510`).
- `plan` + `rig` via `useActivePlan()` (`AppState.tsx:169`).
- `online` via `useOnline()` (`AppState.tsx:201`).

**NOT reachable, and the reason is structural rather than stylistic:**
`planning` and `viaReplanning`. `usePlanFlow` (`usePlanFlow.ts:66`) and
`useViaReplan` (`replan.ts:303`) contain **no `createContext`**, so a
child-side call would mint a **second instance** with its own
`RoutingClient` / `busyRef` — the panel would observe a different machine.

The remaining 17 are `AppShell`-local by construction: 13 form
cells + handlers, 3 derived (`canPlan` `:707`, `planDisabledReason`
`:711-715`, `formDirty` `:731-734`), 1 cross-tab callback
(`onViewDetails` `:611`).

**Blast radius if done anyway:** 13 `<PlannerPanel` render sites in
`PlannerPanel.test.tsx` behind one `baseProps` factory (`:125`) and two
helpers (`:155`, `:168`) — all would need an `AppStateProvider` wrapper.

**And the growth runs in the group Context cannot absorb.** The one prop
added between #446's snapshot and HEAD is `formDirty`
(`PlannerPanel.tsx:82-88`, added by `cf726a9` for #301), which is
category *derived in `AppShell`* — not one of the five context-reachable
ones. Over the same window `AppShell` gained one `useState`, one `useRef`
and one `useEffect`, all in the entangled cluster. **If anything here is
growth-coupled it is the cluster, not the prop count.**

## Q6. Does `setupLayers` run once per style load or per plan change?

**ONCE PER STYLE LOAD. Never per plan change.** Re-derived directly in
this run, per site:

- The only caller of `setupLayers` is the `setup` closure at
  `RouteLayer.tsx:554-558`, installed by `installStyleSetup(map, setup)`
  at `:559`, in an effect whose dependency array is `[map]` (`:560`).
  **`plan` is not a dependency.**
- Inside `setup`, `setupLayers(map)` runs only when
  `!map.getSource(ROUTE_SOURCE)` (`:555-556`).
- `installStyleSetup` (`lib/styleReload.ts:43-56`) fires it on immediate
  `isStyleLoaded` (`:44-45`), else `once('load')` + `once('idle')`
  (`:47-48`), plus `on('styledata')` (`:50`).
- `setupLayers` itself carries four independent presence guards (`:106`,
  `:212`, `:284`, `:418`).
- All 4 `map.addSource(` and all 13 `map.addLayer(` calls lie between
  `:120` and `:424`, i.e. inside `setupLayers` (`:105-466`). There are
  **zero** `addLayer`/`addSource`/`removeLayer`/`removeSource` calls
  anywhere else in the file.
- Plan changes reach the map only through `setData` (`:604`, `:605`,
  `:617`), `setLayoutProperty` (`:623`, `:731`, `:740`, `:757`),
  `setFilter` (`:766`) and `fitBounds` (`:656`), each gated on
  `styleEpoch !== 0`.

**Consequence — splitting the file is behaviour-neutral ONLY if three
measured couplings survive, and no attributable defect motivates the
split. VERDICT: DECLINE.**

1. **Intra-pass ordering.** `sc-route-alt-sail` (`:251-266`) and
   `sc-route-alt-motor` (`:267-282`) pass `HIGHLIGHT_LAYER` as `beforeId`,
   and `HIGHLIGHT_LAYER` is added **earlier in the same pass** at
   `:138-150`. Two separate `installStyleSetup` registrations have no
   guaranteed relative order — and a missing-but-truthy `beforeId` **drops
   layers silently**, which is exactly why this repo's `fakeMaplibre` is
   deliberately strict about it.
2. **The epoch probe at `:555` tests `ROUTE_SOURCE` alone** as a proxy for
   all four sources; a per-source split needs a per-source probe.
3. **Cross-component anchors.** `DataLayers.tsx:95-98` and
   `AisLayer.tsx:101` both key off the exported `ROUTE_STACK_BOTTOM_LAYER`
   (`RouteLayer.tsx:94`, added first at `:120-131`), so any split must
   keep that id exported and still bottom-most.

**And #446's two cited incidents attribute elsewhere**, so the split's
benefit column is empty: #378's cause was a single missing
`'icon-ignore-placement'` on `sc-wind-barbs` (now `RouteLayer.tsx:458`) —
a split would not have surfaced it; #160's cause is the cross-component
`beforeId` negotiation, which is strain point 3, not file size.

**Cheapest honest hardening, if anything is wanted here** (and it is one
assertion, not a refactor): `RouteLayer.test.tsx:558-568` pins the
once-per-style-load property only against the **`styledata`** path — it
fires `'styledata'` and asserts `addSource`/`setData` call counts are
unchanged. The file's only rerender (`:511-521`) changes `activeLegIndex`
0→2 and asserts the highlight filter. **Nothing pins that a PLAN change
does not re-run `setupLayers`** — the exact invariant Q6 was asked to
establish, and the one any future split would need to preserve.

---

# Part C — Boundaries and invariants

## Q7. Can the `maskBuffer` detach contract be made type-level?

**DECLINE a branded type or ownership wrapper. Zero attributable past
defects, the single choke-point already exists, and the proposed
instrument would not cover the one silent failure mode.**

**The choke-point is already singular.** There is exactly **one** transfer
in the whole app — `workerClient.ts:232`,
`postMessage({type:'init',...}, [assets.maskBuffer])`; the app's only
other `postMessage` (`workerClient.ts:287`, `plan`) passes no transfer
list. The producer is one module-cached promise (`services/assets.ts:19`,
`:36-51`), and the only copy site is `usePlanFlow.ts:144`
(`assets.maskBuffer.slice(0)`), reachable only through the single
`ensureClient()` at `usePlanFlow.ts:122-168`. **A brand would decorate
that choke point, not create it.**

**Attribution: none.** `git log -S "maskBuffer.slice(0)" -- app/src`
returns only commits that ADD the line — it is present from
`usePlanFlow.ts`'s introduction and never fixed a shipped bug — and a
GitHub issue/PR search for `maskBuffer` returns only #446 itself. Purely
prospective, therefore declined by #446's own rule.

**#446's framing of the strain is also wrong in two ways.** It says the
rule is *"enforced only by comment"* and cites `usePlanFlow.ts:124-126` /
`workerClient.ts:102`. In fact it **is** behaviourally asserted —
`usePlanFlow.test.tsx:172`, `expect(initMsg.maskBuffer).not.toBe(ASSETS_FIXTURE.maskBuffer)`,
an identity assertion that reds if `.slice(0)` is dropped — and **both
cited line numbers have moved** (the copy is `:144`, the transfer `:232`).

**The failure this contract guards is already LOUD everywhere except one
temporal case no type can reach.** Measured (node v24.15.0):
`new Uint8Array(detachedBuffer)` throws
`TypeError: Cannot perform Construct on a detached ArrayBuffer`. Every
consumer that constructs a view **after** a transfer therefore throws
immediately — `protocol.ts:54`, `state/useNavMask.ts:17`,
`components/RouteLayer.tsx:585`, `components/DepthProfile.tsx:175`,
`components/DataLayers.tsx:88` — with two independent fail-closed length
guards behind them anyway (`lib/mask.ts:14-15`, `lib/depthColor.ts:84-85`).

The **one** silent path is temporal: a `NavMask` built **before** the
transfer keeps a view that becomes length 0 (measured: pre-existing
`view.length === 0`, `view[0] === undefined`), so `mask.ts:30` yields
`undefined`, `mask.ts:34` computes `undefined/10 = NaN`, and `isNavigable`
(`mask.ts:60-64`) returns `false` for every point — degradation toward
"nothing is navigable", the **fail-closed** direction. **No branded type
or ownership wrapper can catch "a view captured earlier is detached
later."** Only the existing single copy site can.

**Cheapest honest alternative, if anything is wanted:** one cross-reference
comment on `protocol.ts:9` naming `usePlanFlow.ts:144`. Cost strictly
below any type.

**One NEW defect found while answering this, opposite in direction to
#446's.** The sibling assertion at `usePlanFlow.test.tsx:449-450` — whose
stated role is to prove *"the cached `assets.ts` original wasn't detached
by the first (failed) client's transfer"* — **cannot red on a missing
`.slice(0)`**. The test's `fakeWorker.postMessage`
(`usePlanFlow.test.tsx:50-56`) takes one argument and ignores the transfer
list, so nothing detaches under jsdom and `byteLength` is intact either
way. Only the identity assertion at `:172` has teeth. (Derived by reading
the fake, not by running a mutation — this tree is shared with two live
implementer agents and was not edited.) This is this repo's own documented
mutation-vacuity class recurring: an assertion whose stated role and
actual discriminating power differ.

## Q8. Is the `SKIP_WAITING` path live end-to-end, and tested in either direction?

**LIVE — and the middle link is now TRACED, retiring #446's "inferred, not
traced". TESTED — asymmetrically and narrowly; the `sw.ts` half is
untested in both directions.**

Chain, each link read at HEAD:

1. `ReloadPrompt.tsx:41` — `onClick` → `updateServiceWorker(true)`
2. vite-plugin-pwa 1.3.0 (installed == lockfile),
   `dist/client/build/react.js:114-130` — `useRegisterSW` → `registerSW`
   (`:9-99`)
3. `:22-27` — `updateServiceWorker` → `sendSkipWaitingMessage?.()`, gated
   on `!auto`, where `auto = ('__SW_AUTO_UPDATE__' === 'true')`; the
   placeholder is substituted at `dist/index.js:169` from
   `registerType === 'autoUpdate'`, and `app/vite.config.ts:382` sets
   `registerType: 'prompt'` → `auto` false
4. `:38-40` → `wb.messageSkipWaiting()`
5. workbox-window 7.4.1, `src/Workbox.ts:32`, `:325-328` →
   `messageSW(registration.waiting, {type:'SKIP_WAITING'})`
6. `app/src/sw.ts:80-81` → `self.skipWaiting()`

Confirmed in built output: `dist/assets/index-CbpoBdzB.js` has ``AV=`false` ``
with ``MV = AV===`true` `` (auto off) and ``u=()=>{c?.messageSkipWaiting()}``;
`dist/assets/workbox-window.prod.es5-Bd17z0YL.js` carries
`v={type:"SKIP_WAITING"}`; `dist/sw.js` carries
``SKIP_WAITING`&&self.skipWaiting(``. **Caveat, stated rather than
glossed:** that `app/dist` is dated 2026-08-08 15:10 — a prior local e2e
build — so it is evidence about **that** build. The source-level trace is
HEAD-accurate. It was deliberately not rebuilt: two implementer agents are
active in this working tree.

**Tested — the asymmetry, per site:**

- **FORWARD**: `ReloadPrompt.test.tsx:55-65` asserts the button calls
  `updateServiceWorker(true)` — but `:24-33` mocks the entire
  `virtual:pwa-register/react` module, so the assertion **stops at the
  app/plugin boundary**. It cannot observe `messageSkipWaiting`, the
  payload, or delivery.
- **REVERSE** (`sw.ts:80-81`): **ZERO.** No vitest file imports `sw.ts`.
  The only e2e service-worker references are `offline.spec.ts:29`
  (`navigator.serviceWorker.ready`, first install only) and
  `basemap-fallback.spec.ts:12`, `:49`, `:140`, which **block** service
  workers outright. **Nothing in the suite ever produces a waiting
  worker.**

Two per-site facts worth recording because both invert the natural
reading:

- The `true` at `ReloadPrompt.tsx:41` is **inert in this plugin version**
  — `build/react.js:22` names it `_reloadPage` and never reads it; the
  reload comes from the `controlling` listener at `build/react.js:57-67`.
  So the forward test pins an argument the runtime ignores.
- `messageSW` posts over a `MessageChannel` awaiting a port reply that
  `sw.ts:81` never sends (voided at `Workbox.ts:327`), so **"the SW
  acknowledged" is unobservable by construction**.

**VERDICT: DECLINED as a refactor.** No attributable past defect surfaced
— no issue about a non-working update prompt in the searches run. The
literal `'SKIP_WAITING'` does live in two artifacts (`sw.ts:81` and
workbox-window's `SKIP_WAITING_MESSAGE`) with no twin check, in a repo
whose stated doctrine is twin search, so **if** the maintainer wants
prospective cover, the only defensible add is ~5 lines: a vitest importing
`sw.ts` under a fake `ServiceWorkerGlobalScope`, asserting `skipWaiting()`
fires on `{type:'SKIP_WAITING'}` and does **not** fire on a wrong or
absent type. Blast radius one new file, no product code touched.

**Say plainly what that test would and would not prove.** It would pin the
`sw.ts` side of the string contract and would be the **first test to
execute `sw.ts` at all**. It **cannot** prove browser delivery, and it
must not be mistaken for offline-behaviour cover — that is precisely the
jsdom-mocked-service-worker tautology this repo has already ruled out for
the #96/#118 bug class.

## Q9. Would narrowing `MapInstanceCtx` be mechanically feasible — and was it ever considered?

**Mechanically possible but half-blocked; and DECLINED regardless, because
zero of the three cited incident classes is a type-surface defect.**

**Feasibility.** The interface itself would need only the **19-member
union** — `addImage`, `addLayer`, `addSource`, `easeTo`, `fitBounds`,
`getBearing`, `getBounds`, `getCanvas`, `getLayer`, `getSource`,
`hasImage`, `off`, `on`, `project`, `removeLayer`, `removeSource`,
`setFilter`, `setLayoutProperty`, `unproject` — not 46. (46 is the **sum**
of per-component member sets: `RouteLayer` 12, `AisLayer` 9,
`DataLayers` 8, `BoatMarker` 6, `CompassControl` 4, `ScaleBar` 4,
`AisTraffic` 3, `ViaMarkers` 0, after stripping comments and four i18n-key
false positives at `DataLayers.tsx:424`, `:432`, `ScaleBar.tsx:82`,
`CompassControl.tsx:381`. The aggregate reproduces exactly; two of #446's
per-component splits do not.)

**HARD BLOCKER.** Four sites hand the map to a maplibre constructor that
demands the **concrete `Map` class**: `BoatMarker.tsx:112` and
`ViaMarkers.tsx:91` (`Marker.addTo`), `AisLayer.tsx:257` and
`DataLayers.tsx:365` (`Popup.addTo`). So **4 of 8 consumers** would need
the full type back or a cast, plus three `lib/` helpers already typed on
`MaplibreMap` (`styleReload.ts:43`, `seamarkGlyphs.ts:851`,
`windBarbs.ts:156`). And `on`/`off` alone drag in MapLibre's full
event-map generics, so "role-scoped" is not a small type either.

**Attribution — the decisive column, all three empty:**

- **#160** (closed) is a runtime **insertion-order** race. Every call
  involved is `addLayer`, which any narrowed interface still exposes. It
  is already owned by `app/src/components/layerOrder.test.tsx`.
- **#378** (closed) was a style-**property** side effect between layers
  (`icon-ignore-placement` on `sc-wind-barbs`) — invisible to any
  TypeScript surface.
- **#288** (open) is upstream `GlyphManager` silent-fallback behaviour.

**The strain is real and #446 is right that it exists. The proposed
instrument does not touch it.** What has actually worked here is a
cross-component **behavioural** guard plus explicit `beforeId` anchoring.

**Was it ever considered?** No record: `git log --grep` for
facade/`MapInstanceCtx` and GitHub issue searches for `facade` and
`MapInstanceCtx` return only #302 and #446, and `MapView.tsx:96-101`
carries no rationale beyond an eslint-disable. That is an **absence of
record**, not evidence of a decision — worth one line in the code if the
maintainer wants the decline to stick.

### Citation caveat this section owns, and it is live in this checkout

The two maplibre signatures above (`src/ui/marker.ts:392` `addTo(map: Map)`,
`src/ui/popup.ts:244` `addTo(map: Map)`) were read against the **installed
`maplibre-gl` 6.0.0**, while `app/package-lock.json` pins **6.1.0** — the
documented stale-`node_modules` trap, live here right now. `npm ci` was
**not** run to close it: two implementer agents are working in this same
tree and wiping `node_modules` mid-run would break them. **Treat those two
line numbers as 6.0.0 citations to be re-derived after the next clean
install.** The conclusion (Marker/Popup `addTo` require the concrete
`Map`) is API-stable enough to carry the argument; the line numbers are
not, and must not be restated as 6.1.0.

---

# Part D — State

## Q10. Is the `--sc-panel-w` two-writer arrangement airtight for an interrupted drag?

**NOT AIRTIGHT. Four interrupted-drag endings, all reproduced** by
rendering the real `app/src/components/PanelResizer.tsx` in an isolated
copy of `app/src` (repo untouched; jsdom plus a manual rAF queue).

1. **Unmount mid-drag — no race needed.** `pointerdown@100` →
   `pointermove@250` → flush frame (`--sc-panel-w` = `'550px'`, correct
   mid-drag) → unmount. Measured after unmount: **`--sc-panel-w` still
   `'550px'`, `onCommit` calls 0.** `endDrag` never runs (no `pointerup`
   reaches an unmounted element) and `PanelResizer.tsx` has **no unmount
   cleanup** — re-verified in this run: its only `return () =>` is
   `ro.disconnect()` at `:141`, and the two `cancelAnimationFrame` sites
   are `:175` (inside `writeLive`) and `:220` (inside `endDrag`), both
   mounted-only.
2. **Pending-frame variant.** `pointerdown` → `pointermove` → unmount →
   flush. Measured: `'550px'`, `onCommit` 0. The rAF scheduled at `:176`
   is never cancelled, and `targetRef` (`.app-shell`, passed as `shellRef`
   at `App.tsx:1019`) outlives the resizer.
3. **Nothing cleans it up afterwards.** `App.tsx:259-269` is the only
   React-side writer and its dep array is `[panelWidthPx]` (`:269`);
   `onCommit` never fired, so `panelWidthPx` is unchanged, the effect does
   not re-run, and the `removeProperty` branch at `:267` never executes.
   The orphan **survives the return to wide**: `app.css:2442` (inside the
   `@media (min-width: 1024px)` opened at `:2439`) then resolves to
   `minmax(320px, 550px)` instead of the responsive `1fr` — a width nobody
   committed and localStorage does not hold. Cleared only by reload, a
   real drag, or a reset.
4. **`pointercancel` COMMITS; it does not revert.**
   `onPointerCancel={endDrag}` at `PanelResizer.tsx:296` is the **only**
   `pointercancel` reference in all of `app/src` + `app/e2e`
   (case-insensitive grep: 1 hit, the wiring itself — re-verified in this
   run). Measured with a synthesized cancel carrying `clientX` 0:
   **`onCommit(320)`** — min width, persisted via `usePersistedNumber`'s
   `set` (`lib/usePersistedNumber.ts:50-52`). **Split the claim:**
   commit-on-cancel is MEASURED and certain; what `clientX` a real browser
   puts on `pointercancel` is **UNMEASURED**, so whether the committed
   number is the last sane position or a snap-to-min is not established.
5. **Zero-net-movement restore can clobber a newer write.** Set
   `--sc-panel-w` `'500px'` at `pointerdown` (captured as
   `drag.startCssVar`, `:195`) → `pointermove` → `App.tsx`'s layout effect
   writes `'400px'` mid-drag (a viewport shrink re-clamping the stored
   width through `usePersistedNumber`'s read-time clamp, `:57`) →
   `pointerup` at net `dx` 0. Measured: `'500px'`, `onCommit` 0 — `:244`
   restored the pre-drag value over the newer one, and React will not
   rewrite because `panelWidthPx` has already settled.

**Reachability is narrow but not exotic.** The unmount trigger is `isWide`
(mount gate `App.tsx:1016`) flipping through
`lib/useWideLayout.ts`'s `matchMedia('(min-width: 1024px)')` change
listener; a tablet rotation across that breakpoint mid-touch-drag —
`tabletLandscape` 1180×820 → `tabletPortrait` 820×1180, **both in this
repo's own `STANDARD_VIEWPORTS`** — is the concrete path.

**Coverage is zero.** `PanelResizer.test.tsx` covers the a11y/keyboard
contract only and says so in its own header (`:6-27`); no test in `src/`
or `e2e/` unmounts mid-drag or fires `pointercancel`;
`panel-resize.spec.ts`'s cross-breakpoint tests either start narrow
(`:397`) or narrow to 1400px, still wide (`:309`).

**ATTRIBUTION — and this is what keeps Q10 out of the architecture
column.** The two-writer arrangement has exactly **one** attributable past
defect and it is already fixed: the zero-net-movement pin, measured in PR
#414 review (Minor 4), fixed in `3bba82f` (2026-08-06) — a product fix,
not only a test one (`git show --stat 3bba82f`: `PanelResizer.tsx` +50,
`App.tsx` +38, `app.css`, `panel-resize.spec.ts` +154) — and pinned by
`e2e/panel-resize.spec.ts:273`, *"a net-zero-movement drag does not pin
the panel to a fixed width"*. `PanelResizer.tsx` has only two commits in
total (`957bbc4` for #355, `3bba82f`) — both re-verified in this run.

**Finding 5 is a DIFFERENT variant of the same shape, not a claim that
the fix failed** — stated explicitly because the two read as
contradictory otherwise. The fixed defect is the **no-override** case:
`--sc-panel-w` starts unset (`panelCssVar` `''`, CSS `1fr` governing) and
a net-zero drag leaves a fixed width pinned where nothing was persisted.
Finding 5 is the **override-already-present** case: the property starts
at `'500px'`, a concurrent `App.tsx` layout write moves it to `'400px'`
mid-drag, and `PanelResizer.tsx:244`'s restore puts the **pre-drag** value
back over the newer one. The e2e pin at `:273` starts from no override,
so it cannot reach this. All four findings above are **newly measured
here with no past defect behind them**; finding 5 is adjacent to a fixed
one, which is why it is spelled out rather than counted as covered.

**VERDICT: DECLINE any architectural restructuring of the two-writer
arrangement. These are ordinary bug reports.** File one issue; the fix is
local — an unmount cleanup effect, plus a maintainer ruling on
`pointercancel` semantics (commit-last-sane-position vs revert). No
architecture is involved, and #446 should not be read as licensing one.

## Q11. Should derived state be type-distinguishable from authoritative state — and has the undifferentiated shape ever produced a bug?

**YES, it has produced a bug — #158, a genuine attributable defect and the
only one in Part D. But NO type-level brand: the absorption that works
already exists, and the real residual is two stale comments.**

`AppStateValue.activeLegIndex: number | null` (`state/AppState.tsx:29`) is
shape-identical to the authoritative fields beside it (`plan`, `rig`,
`settings`), and nothing at type level marks it as a per-fix argmin. #157
keyed the AIS corridor recompute on it, producing an unconditional
`sendSubscription` at ~1 Hz near a leg boundary. #158's own text names the
asymmetry — `RouteLayer` absorbs the flips with a cheap `setFilter`, #157
wired the same signal into a **network** effect — and adds *"Per-PR review
could not see this; it is a cross-PR interaction."*

Live consumers today are exactly two, both prop-drilled from `App.tsx`:
`RouteLayer` (`App.tsx:780`; raw, `setFilter` at `RouteLayer.tsx:766`) and
`AisTraffic` (`App.tsx:811`; through the settle gate at
`AisTraffic.tsx:127-131`).

**The prose that licensed #158 is STILL LIVE at the declaration site.**
Re-read directly in this run:

- `state/AppState.tsx:26-28` — *"Changes only on leg transitions, not on
  every fix, so sharing it here doesn't reintroduce the 1 Hz re-render
  this field's neighbor deliberately avoids."*
- `components/LiveView.tsx:87-88` (the producer) — *"Only the
  much-lower-frequency derived `activeLegIndex` is pushed up, for
  RouteLayer's highlight."*

Both are the **pre-#158 reading**. The corrected reading exists only at
the consumer site that got burned — `AisTraffic.tsx:117-118`: *"#158:
activeLegIndex is a hysteresis-free per-fix argmin — near a leg boundary
GPS noise flips it between adjacent indices at fix rate"* — and at
`state/useAisTraffic.ts:24-26`. **A third consumer reads the declaration
first.**

**Recommendation: no brand.** A brand forces an unwrap, which is a nudge
and not a guard — #157's author would have unwrapped and proceeded. The
absorption that actually works, `useSettledValue`, already exists; its
per-site cost is **discoverability**, because it lives inside the AIS
module (section D locates it at `state/useAisTraffic.ts:38`; not
re-derived here) and a future non-AIS consumer has no path to it from the
declaration.

**Cheapest hardening — and this is derived here, not inherited, because
the section evidence was truncated at exactly this sentence: correct the
two stale comments** at `AppState.tsx:26-28` and `LiveView.tsx:87-88` to
the `AisTraffic.tsx:117-118` reading, and point the declaration at
`useSettledValue`. Two comment edits. It is the highest
value-per-character item in this entire document: the false statement sits
at the one site every future consumer reads first, and it is the statement
that licensed the only Part D bug that ever shipped.

## Q12. Does the `rig` two-home handoff have a test that fails if `useSessionRestore.ts:66` and `:72` are swapped?

**YES — and #446's premise ("If not, that is the cheapest available
hardening") is therefore false. The hardening is already done.** Measured
in this run; no section evidence was supplied for Q12.

The ordering: `useSessionRestore.ts:66` is `setPlan(restoredPlan)`; `:72`
is `if (snapshot.rig !== null) setRig(snapshot.rig);`. `setPlan`
(`AppState.tsx`) is
`setPlanState(p); setRig(p ? p.result.recommended : null); setActiveLegIndex(null);`
— so it **resets the rig to the plan's recommended one**, and `setRig`
must run after it.

The pinning test is `app/src/state/useSessionRestore.test.tsx:113-124`,
*"restores plan, rig, and tab from the snapshot by pure local replay —
zero fetch calls"*. Its discriminating power is deliberate and documented
in its own fixture comment at `:13-15`: the fixture plan has results for
**both** rigs with `recommended: 'genoa'` (`:43-47`), and the snapshot
stores `"rig":"fock"` (`:115`). The assertion is
`expect(screen.getByTestId('rig').textContent).toBe('fock')` (`:124`),
with the comment at `:122-123` stating the mechanism outright: *"'fock' is
NOT the plan's recommended rig ('genoa') — this pins that the persisted
rig choice is re-applied after setPlan's reset-to-recommended."*

Swap `:66` and `:72` and `setPlan`'s reset runs **last**, leaving `rig` at
`'genoa'`; `:124` reds. **The guard exists and its needle and haystack are
independent** (fixture-authored `recommended`, snapshot-authored `rig`) —
it is not the equivalence tautology this repo has been bitten by.

**VERDICT: no action. Record that Q12 is closed** so it is not re-proposed
as cheap hardening; the cost comparison against Q7 that #446 asks for does
not arise, because the item costs nothing — it is already paid for.

### Addendum to Part D: does Cache Storage count as a sixth persistence mechanism?

**RULING: NO.** #446 asks the spike to rule on this and an earlier
revision of this document declined to, recording only a "suggested
ruling" in *What remains open* — which is the deferral shape this
document criticises elsewhere, so it is settled here instead.

The measured inventory, at `7195787`. Five mechanisms, by the storage API
each uses:

| # | Mechanism | Non-test sites |
|---|---|---|
| 1 | `localStorage` via `lib/storage.ts`'s safe wrappers | `lib/usePersistedToggle.ts`, `lib/usePersistedNumber.ts` |
| 2 | `sessionStorage` | `lib/sessionSnapshot.ts`, `state/useSessionRestore.ts` |
| 3 | `localStorage` outside the wrapper | `services/swRecovery.ts` |
| 4 | IndexedDB (`idb`) | `services/db.ts` — the only one |
| 5 | In-memory module cache | `services/assets.ts` |

Cache Storage appears at exactly three non-test sites — `sw.ts:74`
(`caches.delete` in the activate cleanup), `services/glyphWarmup.ts:123`
(`caches.open(GLYPH_CACHE_NAME)`), and `lib/glyphs.ts` (the name prefix).
**Three reasons it is not a sixth, each independently sufficient:**

1. **Nothing in it is authored.** Every entry is a copy of a network
   response — precached build assets and glyph `.pbf` ranges. The five
   above all hold values a user or a solve produced (settings, toggles,
   panel width, the session snapshot, saved plans with their wind grids),
   which are unrecoverable if lost. Cache Storage is recoverable by
   definition: refetch.
2. **Losing it costs latency, never correctness.** An emptied glyph cache
   is a cold fetch; an emptied IndexedDB loses saved plans *and the
   forecasts they must render against* — the invariant under "Wind grids
   are stored with each plan".
3. **No `AppState` field is backed by it**, and no app-side read path
   consults it for state. `glyphWarmup.ts` writes it and never reads it
   back for a decision.

**Consequence for the strain ranking:** rank 11 stays at five mechanisms
and stays NOT growth-coupled. **Reopening trigger, so this is narrowed
rather than closed:** if any app-authored value (as opposed to a cached
network response) is ever written through `caches.*`, or if an
`AppState` field is ever backed by it, it becomes a sixth mechanism and
this ruling is void. Its *deployment-scoped naming* discipline (#96) is
governed under the PWA rules and is unaffected either way.

---

# Part E — Tests and the tooling budget

*No section evidence was supplied for Part E. All three answers below were
measured in this run.*

## Q13. Is `ViaMarkers` behaviourally asserted anywhere?

**NO — and it is worse than #446's "UNVERIFIED": the component is
executed but its marker-creation path never runs.**

Per site:

- `app/src/components/ViaMarkers.tsx` is 113 lines. **No
  `ViaMarkers.test.tsx` exists** (`ls app/src/components/ViaMarkers*` →
  the source file only).
- Its only importer is `RouteLayer.tsx:19`, rendered at `:827`.
- `grep -c 'ViaMarkers' app/src/components/RouteLayer.test.tsx` → **0**.
  Not one assertion, not one mention.
- The only `viaPoints` in that file is **`viaPoints: []` at `:92`** — an
  empty array. So `ViaMarkers` mounts and creates **zero markers**. The
  code path that matters is never entered.
- Even if it were, there is no observation surface: `RouteLayer.test.tsx`
  mocks `maplibre-gl` at `:25-38` with a `Marker` stub whose
  `setLngLat`/`addTo`/`on` return `this` and whose `remove()` is empty. It
  **records nothing** — unlike the `test/fakeMaplibre.ts` /
  `BoatMarker.test.tsx` pattern the file's own comments at `:19` and
  `:209` point at.
- e2e touches only the **arm/disarm** of tap-pick, never a marker:
  `plan.spec.ts:86-89` and `layout.spec.ts:165-168` both drive the
  `Wegpunkte` region's "Wegpunkt hinzufügen" button and the
  *"Auf Karte tippen für Wegpunkte."* banner.

**Cheapest honest coverage: a `ViaMarkers.test.tsx` in jsdom, NOT an
e2e.** Render the component directly with a non-empty `viaPoints` array
against a **recording** Marker fake (the `fakeMaplibre.ts` /
`BoatMarker.test.tsx` pattern this file already names), and assert
marker-per-via-point creation, `setLngLat` coordinates, and removal on
unmount. Roughly one new ~60-line file; zero product code touched; no
canvas coordinates involved.

**Does the "canvas-coordinate map tap is too fragile" judgement still hold
given `live.spec.ts`'s geolocation precedent? YES — the precedent does not
transfer,** and this is a reasoned distinction rather than a measurement,
so it is labelled as one. `plan.spec.ts:80-84` names its own reason: a
real via add/drag *"depends on MapLibre's live projection (center/zoom/
bounds)"*. `context.setGeolocation` injects a **position into the
geolocation API** — a data path that never computes a screen coordinate
from the projection. The two mechanisms have nothing in common, so
`live.spec.ts`'s success is not evidence about canvas taps. `grep` over
all 12 specs finds only two `canvas` mentions and neither is a tap
(`panel-resize.spec.ts:138` is a comment about reading the canvas box;
`plan.spec.ts:82` is the declining comment itself). **The judgement
stands, and the jsdom test above is the right instrument precisely because
it sidesteps it.**

## Q14. What is the empirical hit rate of the seven structural guards?

**The seven reproduce exactly. Their COST is measurable and high. Their
HIT RATE is structurally unmeasurable from the tree — and saying so is the
answer, not a dodge.**

The seven, enumerated (source-text-scanning, as distinct from
data-reading or behavioural):

| Guard | Lines | Reads | Commits |
|---|---|---|---|
| `test/timeoutGuard.test.ts` | 263 | `?raw` glob over test files | 3 |
| `test/cameraAnimationCallSites.test.ts` | 240 | `?raw` glob over `src` | 3 |
| `routing/planRoute.reasonDecoupling.test.ts` | 381 | `?raw` on routing source | 6 |
| `lib/useBannerHeight.test.ts` | 163 | `readFileSync` on `app.css` | 2 |
| `test/timeoutBudgetVsJobCap.test.ts` | 104 | `?raw` on `coverage.yml` | 4 |
| `test/glyphFallbackWarningGuard.test.ts` | 71 | `readFileSync` on maplibre source | 2 |
| `lib/panelWidth.test.ts` | 45 | `readFileSync` on `app.css` | 1 |

Total **1,267 lines**. (Deliberately excluded, and the exclusions are why
the count is seven and not nine: `lib/seamarkPopover.coverage.test.ts`
reads `public/data/seamarks.json` — a **data asset**, not source;
`lib/changelogFragmentsFs.test.ts` builds a temp directory and exercises
real fs behaviour — **behavioural**; `test/subPathMeta.test.ts` imports
`vite.config` and calls the function — behavioural;
`lib/changelog.test.ts` reads `CHANGELOG.md`, a document.)

**The cost side, measured from `git log` and quoted verbatim because the
commit subjects are the evidence:**

- `timeoutBudgetVsJobCap.test.ts` — **all four** of its commits are PR
  #351 review rounds 2–5: *"round-2 review — N1 (blocking) + N2/N3/N4"*,
  *"round-3 review N5 (blocking) — guard fails open on second
  timeout-minutes key"*, *"round-4 review N8 (blocking) — guard silently
  drops unparseable keys"*, *"round-5 orchestrator decision — simplify
  job-cap guard (option C)"*. **#446's claim that it fail-opened four
  times and was downgraded reproduces exactly.**
- `planRoute.reasonDecoupling.test.ts` — three of six commits are
  guard-hardening: *"close two fail-open holes in the #282 structural
  guard"*, *"give SOLVER_LABELS a twin so an emptied list cannot pass"*,
  *"document the #282 guard's excision-ratio headroom"*.
- `glyphFallbackWarningGuard.test.ts` — both commits are #320 review
  fixes: *"close a third fail-open glyph path, add a structural
  warning-string guard"*, *"correct a fabricated citation…"*.
- `timeoutGuard.test.ts` — two of three are review fix-waves.
- `cameraAnimationCallSites.test.ts` — two of three are PR #302 review
  work.
- `useBannerHeight.test.ts` — one of two is a PR #382 review fix.
- `panelWidth.test.ts` — **one commit, clean.** The only one.

**Six of seven required at least one post-creation fix, and those fixes
are overwhelmingly review-found fail-open holes in the guard itself.**

**Why the hit rate cannot be measured, stated precisely so nobody reads
this as "the guards are useless": a guard that fires in CI produces no
commit.** The red run lives in Actions logs and PR review threads, not in
the tree, and a guard that deters a regression by existing produces no
artifact at all. What the tree records is **cost**, and it is one-sided
evidence by construction. The one guard whose hit rate #446 already
documents — `timeoutBudgetVsJobCap`, zero real defects — is confirmed
here, but one data point is not a rate.

**Does that justify adding more? NO — but not for the reason the framing
suggests.** The discriminator that emerges from the seven is not
guard-versus-type; it is **whether the invariant spans two languages**:

- `panelWidth.test.ts` and `useBannerHeight.test.ts` guard a CSS literal
  against a TypeScript constant. **No compiler spans CSS and TypeScript**,
  so there is no type that could replace them. They are also the two
  cleanest by commit history. **Keep; this class is justified.**
- `timeoutBudgetVsJobCap.test.ts` guards a YAML value against a TS
  constant — same class, but it is the one that fail-opened four times,
  which suggests the *parsing* is where this class gets expensive, not the
  concept.
- `cameraAnimationCallSites.test.ts`, `timeoutGuard.test.ts`,
  `planRoute.reasonDecoupling.test.ts` all scan **TypeScript from
  TypeScript** — the one place where a type or a lint rule is a candidate
  replacement, and the three with the heaviest hardening histories.

**Recommendation: add no new source-scanning guard for a single-language
invariant without first showing a type or lint rule cannot express it;
keep the cross-language ones, which have no alternative. Delete none** —
deletion has its own cost and no guard here has been shown harmful.

## Q15. Is the ~30% `area: tooling` share transient or steady state?

**STEADY STATE and RISING — it is not a snapshot artifact, and the answer
inverts the framing.** #446 notes no survey gathered issue dates; this run
did.

First the snapshot, corrected — **and this figure decays; re-run it
rather than quoting it.** Measured **2026-08-09**, both halves, so the
denominator is auditable and not merely asserted:

```
# denominator — every open non-PR issue
gh api --paginate 'repos/DocGerd/sail_command/issues?state=open&per_page=100' \
  --jq '[.[] | select(.pull_request==null)] | length'
→ 46

# numerator — those carrying either spelling of the tooling label
gh api --paginate 'repos/DocGerd/sail_command/issues?state=open&per_page=100' \
  --jq '[.[] | select(.pull_request==null)
         | select(any(.labels[].name; test("area: ?tooling")))] | length'
→ 18
```

**18 of 46 open non-PR issues = 39.1 %** — not "13 of 44 (~30%)". The 18
are #72, #143, #346, #357, #359, #401, #406, #417, #420, #424, #428,
#444, #446, #447, #448, #449, #451, #459; enumerating them is what makes
the ratio checkable rather than trusted.

**An earlier revision of this section said 18 of 45 = 40.0 %, and the way
it went wrong is the reason the composition is now spelled out.** The
numerator was right; the **denominator moved under it** — issue
[#463](https://github.com/DocGerd/sail_command/issues/463) (`type: chore`,
`priority: low`, *no* `area:` label) was opened **during this same
session**, on 2026-08-09, after the figure was written. It lands in the
denominator and not in the numerator, so it *lowered* the share. A bare
ratio reads as timeless and is not: this one has a half-life of about one
issue.

**It then decayed a SECOND time, the same day, in the other term.**
Re-measured at review time with the identical two commands: **17 of 45 =
37.8 %**. The cause is
[#459](https://github.com/DocGerd/sail_command/issues/459), closed
`2026-08-09T11:45:09Z` carrying `area: tooling` — so unlike #463 it left
**both** terms, and the share fell again. The enumerated 18 above is a
snapshot of the same instant as the headline; #459 has since left it.
**Three readings of one ratio inside one day — 40.0 %, 39.1 %, 37.8 % —
is the argument for quoting the commands rather than the number**, and
#444 §G3(d) carries the same three-reading table so the two documents
cannot drift apart on it. The headline is deliberately **not** overwritten
with 37.8 %: that would mint a third timeless-looking figure with the same
half-life. Nothing downstream moves — all three readings sit between 37 %
and 40 %, all three are far above the "~30 %" both issue bodies assert,
and the verdicts below rest on the creation-rate series, not on the
snapshot.

Three further qualifications, all load-bearing:

- The label taxonomy carries space/no-space duplicates, so a
  single-spelling filter undercounts. `test("area: ?tooling")` spans
  both. The unspaced `area:tooling` label exists but carries **zero**
  open issues today (measured: `test("^area:tooling$")` → 0) — the two
  spellings agree **today** and need not tomorrow.
- **Both spikes are themselves in the 18** (#444 and #446 each carry
  `area: tooling`), so the de-inflated figure is **16 of 44 = 36.4 %**.
  Stated because a reader who removes them will otherwise recompute and
  disagree with the headline.
- Three of the 18 (#447, #448, #449) are the follow-ups #437 spawned when
  it closed. They are real work, but they are *one* investigation's
  fan-out, not three independent arrivals — a caution against reading the
  count as a count of problems.

**But a snapshot of open issues is survivorship-biased toward the recent,
so it cannot answer "transient or steady state" at all.** The measurement
that can is creation rate. Over all **211** non-PR issues ever opened,
bucketed by ISO week of `created_at` (method: the `state=all` paginated
issue list, `select(.pull_request==null)`, `area: ?tooling` as above,
re-measured 2026-08-09):

| Week | Tooling created | Product created | Total | Tooling share |
|---|---|---|---|---|
| 2026-W29 | 1 | 39 | 40 | **2.5 %** |
| 2026-W30 | 20 | 39 | 59 | **33.9 %** |
| 2026-W31 | 21 | 32 | 53 | **39.6 %** |
| 2026-W32 | 29 | 30 | 59 | **49.2 %** |

The share rises at every step. **But the series is four points long and
the trend claim must be weakened accordingly — an earlier revision of
this section read "risen every single week of the project's life, from
2.5% to 50%", which overclaims in three separate ways:**

1. **W29 is the project's INCEPTION week and its 2.5 % is a base-rate
   artifact, not an observation about restraint.** In week one there is
   no tooling *to* maintain, and the product backlog is enumerated in a
   single founding burst — 39 product issues in seven days, a rate never
   reached again. Including it roughly doubles the apparent rise. **The
   honest series is the three post-inception points: 33.9 % → 39.6 % →
   49.2 %.** Still monotonic, still rising, but three points, and a
   three-point monotone run is weak evidence of a trend.
2. **W32 is the current week**, and 2026-08-09 is its final day
   (`date.isocalendar()` → weekday 7), so it is complete only as of the
   moment of measurement; an issue opened later the same day moves it.
   That already happened once during this session — see the #463 note
   above, which is why W32 reads 29/30 = 49.2 % here and 29/29 = 50.0 %
   in the revision written a few hours earlier.
3. **"50 %" was never measured**; 49.2 % was, and it rounds to 49 %.
   Reporting the round number made the series look like it had crossed a
   threshold it has not crossed.

**What survives is the weaker and still-decisive claim:** tooling's share
of newly created issues is *higher than the open-backlog share* in every
post-inception week, so the 39.1 % backlog figure is a **lagging**
indicator rather than a transient bulge. That does not require a trend at
all — it is true point-by-point.

Two facts that argue the other way and belong in the same answer:

- **Tooling closes well.** Of 71 tooling issues ever created, **53 are
  closed (74.6 %)** and 18 open. Product: **140** created, **112** closed
  (**80.0 %**), 28 open. (Method: the same `state=all` pass, bucketed by
  label and `.state`; 53 + 18 + 112 + 28 = 211, which reconciles with the
  series total above.) The close rates are comparable — tooling is being
  *worked*, not merely accumulated.
- **The absolute product rate has not collapsed** (39 → 39 → 32 → 30 per
  week). Tooling is growing on top rather than displacing. Stated as a
  level, not a trend: 39 → 30 across four points is a decline of the same
  evidential weight as the rise above, i.e. not much.

**VERDICT: steady state, rising** — on the narrowed reading above, and it
is the strongest constraint in the whole document.

**This document rules on the half it owns, and does not defer the whole
question.** An earlier revision handed the entire verdict to #444 while
#444 carried no tooling-budget row at all, so the named shared metric of
the exercise was answered by neither. Split explicitly:

- **The code-side verdict is issued here, and it is the one this document
  is competent to issue:** the three declined refactors stay declined
  *partly on this evidence*. Each would generate exactly the kind of work
  the curve is made of — new guards, new test scaffolding, new
  conventions to document — against candidates with zero attributable
  defects. Where the tooling budget changes a code decision, that
  decision is made in this document, not referred onward.
- **The automation-surface verdict is issued in #444**, which owns the
  hooks, skills, agents and `CLAUDE.md`. It is answered there under
  *"The tooling-budget verdict (Q14's shared metric)"*, and it cites this
  section's series rather than re-measuring it. That is a
  cross-reference to a written answer, not a deferral: if that section is
  ever removed from #444, this one is left over-claiming and must be
  re-opened.

This document's contribution to the *shared* question is the measurement
and the code-side consequence. It does not rule on whether the automation
surface should shrink, because it did not audit the automation surface.

---

## Questions whose premise was false — consolidated

| # | #446's premise | Measured |
|---|---|---|
| §0 | `App.tsx` 975 lines, `AppShell` `:125-967` (843) | 1120; `:153-1112` (960) |
| §0 | `PlannerPanel` takes 22 props, 485-line function | **24** at HEAD, **23** at #446's own snapshot — wrong when written; function is 480 lines |
| §0 | 9 components call `useMapInstance()` | **8**; the 9th is the definition + comment mentions |
| §0 | Three incident classes trace to the MapLibre call-site shape | **One** (#160). #378 and #288 are intra-file |
| §0 | `AppState` imported by 6 files | **4** non-test; the other 2 are test files |
| §0 | Path-alias / dynamic `import()` edges unchecked (listed as a gap) | **Closed** — no aliases configured, **0** dynamic imports |
| Q4 | "All nine concerns share one closure scope" | **6** — two are already extracted hooks; one entry is a comment line, double-counting `handleRecalculate` |
| Q4 | `viaReplan.state.replanning` forces two extractions to stay coupled | **False** — read-only at all three consumers, single writer inside the hook |
| Q7 | The mask-buffer rule is "enforced only by comment" | **False** — `usePlanFlow.test.tsx:172` is an identity assertion with teeth; both cited line numbers have also moved |
| Q8 | The middle link is "inferred, not traced" | **Traced**, six links, source and built output |
| Q9 | 46 distinct `map.*` call shapes as the type-authoring cost | 46 is the **sum**; the union a narrowed interface needs is **19**. Two per-component splits also do not reproduce |
| Q12 | "If not, that is the cheapest available hardening" | The test **exists** — `useSessionRestore.test.tsx:113-124`, mechanism documented in its own comments |
| Q13 | Whether `RouteLayer.test.tsx` asserts anything about `ViaMarkers` is UNVERIFIED | **Zero mentions**, and `viaPoints: []` means the marker path never executes |
| Q15 | ~30% tooling share; transience unassessed | **39.1 %** open, 2026-08-09 (36.4 % excluding the two spikes); creation share rose at all four measured points, 2.5 % → 49.2 %, on a four-point series whose first point is the inception week — see Q15 for why the trend claim is narrowed to the three post-inception points |

---

## Strain points, re-ranked by growth-coupling

#446 ranked by severity. Ranking by **growth-coupling** — the thing that
decides whether pre-emptive work is justified — reorders them, and empties
most of the attribution column.

| Rank | Strain | Growth-coupled? | Attributable past defect |
|---|---|---|---|
| **1** | `AppShell`'s tap-pick / planner-form / via cluster — 9 mutually-writing cells, 16 handler/effect sites, no compiler-enforced boundary | **YES, accelerating** (710→960 lines over five tags; every new cell lands in the cluster) | **THREE**: `e736aef` (#38), `46e3e93` (#134 review), `2c8dd0d` (#301, MAJOR). All caught in review; **none shipped**. Only the latter two would have been prevented by extraction |
| **2** | Cross-component MapLibre layer ordering, coordinated by convention | **NO** — 12 consumers since v0.6.0, 153 `map.*` calls since v0.10.0 | **ONE**: #160 (closed) — and already owned by `components/layerOrder.test.tsx` (188 lines, both interleavings, both re-add orders) |
| **3** | Intra-file symbol-layer coupling inside `RouteLayer.tsx` (835 lines, 5 of the app's 9 symbol layers) | Step, not trend (`RouteLayer` depth 37→38→38→45, flat since v0.10.0) | **TWO**: #378 (closed), #288 (open). **A facade would have prevented neither** — both are one-file defects |
| **4** | Derived-vs-authoritative state undifferentiated in `AppStateValue` | NO — two consumers, stable | **ONE**: #158 (closed). The **prose that licensed it is still live** at `AppState.tsx:26-28` and `LiveView.tsx:87-88` |
| **5** | `--sc-panel-w` two-writer arrangement | NO — two commits total on `PanelResizer.tsx` | **ONE, already fixed** (`3bba82f`, pinned at `panel-resize.spec.ts:273-314`). The four Q10 findings are **new**, with no past defect behind them |
| **6** | Process/tooling share of the maintained surface | **YES, and it is the only other rising curve** — tooling share of newly created issues 2.5 % → 49.2 % across four weeks, or 33.9 % → 49.2 % across the three post-inception weeks (Q15). "Accelerating" is **not** claimed: the step sizes are +31.4, +5.7, +9.6 points, which is not an acceleration | Not a code defect. **Automation-surface verdict: #444** (written up there, cross-checked). **Code-side consequence: ruled here**, in Q15 |
| **7** | Prose-only invariants at the worker boundary (`maskBuffer`, wind-grid clone, `fatal` fan-out) | **NO** — exactly one transfer site and one copy site; features do not add transfers | **NO-ATTRIBUTABLE-DEFECT** — `git log -S` on the copy site shows only additions; issue search returns only #446 |
| **8** | The `SKIP_WAITING` boundary | **NO** — one message type since `sw.ts` existed | **NO-ATTRIBUTABLE-DEFECT.** The finding is coverage shape: **nothing in 116 vitest files or 12 specs ever creates a waiting worker** |
| **9** | `PlannerPanel`'s 24-prop interface | **NO** — +1 in five releases | **NO-ATTRIBUTABLE-DEFECT** (commit history checked; every fix in the file is routing/i18n/GPX) |
| **10** | `lib/` mixes utility and react/maplibre-bound modules (10 of 43 non-test files) | **NO** — linear ~+2 files/release, zero cycles | **NO-ATTRIBUTABLE-DEFECT** |
| **11** | Five persistence mechanisms | **NO** — mechanism count stable 5→5→5→6→6, because `usePersistedToggle`/`usePersistedNumber` absorb new keys | **NO-ATTRIBUTABLE-DEFECT** |
| **12** | `ViaMarkers` untested | NO | **NO-ATTRIBUTABLE-DEFECT** — but its marker path is executed by **nothing** |

**Read the table as a whole and the recommendation writes itself.** The
only accelerating code strain (rank 1) is the one whose easy extractions
buy nothing and whose valuable extraction does not separate. Ranks 2–3 are
flat and already instrumented. Ranks 7–11 have no defects at all. The only
other accelerating curve is rank 6, which is not code.

---

## RECOMMENDATION

**Change nothing structural** — with C1 the one candidate that is capped
rather than refused (A2: PROCEED INCREMENTALLY). Then do **three** cheap,
local things — none of which is a refactor, and all three of which are
smaller than any single declined candidate — and consider three offers
that are deliberately not recommendations.

### Prioritised table

**The bar, and its SCOPE — stated because R1/R3 would otherwise look like
violations of this document's own rule.** #446 A2's bar ("a candidate
with zero attributable past defects should be recorded as declined")
governs **structural instruments** — refactors, facades, branded types,
new abstractions, new source-scanning guards — because their whole
justification is defect *prevention*, and prevention with nothing to
prevent is cost without benefit. It does **not** govern (a) fixing a
defect the spike itself measured, (b) covering code no test executes, or
(c) correcting a false statement. Each of those has its own bar, named
per row below. R1, R2 and R3 clear theirs; **R4 does not clear any**,
which is why it moved out of the table.

| # | Change | Bar it must clear | Cost | Blast radius | Risk if wrong |
|---|---|---|---|---|---|
| **R1** | Fix `PanelResizer`'s interrupted-drag endings: add an unmount cleanup effect (cancel the pending rAF, restore or commit), and rule on `pointercancel` semantics | **A defect measured here** — four endings reproduced in Q10. Not a prevention instrument, so A2's bar does not apply | Small — one effect, one decision | `PanelResizer.tsx`, `PanelResizer.test.tsx`, possibly `panel-resize.spec.ts` | Low. Worst case an orphaned CSS custom property persists as today |
| **R2** | Correct the two stale `activeLegIndex` comments (`AppState.tsx:26-28`, `LiveView.tsx:87-88`) to the `AisTraffic.tsx:117-118` reading, and point the declaration at `useSettledValue` | **A false statement, and #158 is the defect it licensed** | **Two comment edits** | 2 files, comments only | Very low. Highest value-per-character item in this document |
| **R3** | Add a `ViaMarkers.test.tsx` (jsdom, recording Marker fake, non-empty `viaPoints`) | **Code no test executes** (Q13: `viaPoints: []` is the only fixture, so the marker path never runs) | ~60 lines, one new file | 1 new file, no product code | Low. Do **not** reach for an e2e canvas tap; Q13 shows the geolocation precedent does not transfer |

Three things deliberately **not** in the table, and the reasons differ:

- **R4 — one assertion in `RouteLayer.test.tsx` that a plan-prop change
  does not re-call `addSource`/`addLayer`.** An earlier revision
  recommended this, with the benefit "the invariant any future file
  split would need, so it is cheap insurance against a decision this
  document declines" — **circular**: its only stated value was insurance
  for a refactor the same document rejects. The non-circular part is
  real but smaller, and the counterweight is decisive:
  - *Real:* Q6 establishes the once-per-style-load property, three
    separate couplings depend on it (intra-pass `beforeId` ordering, the
    single-`ROUTE_SOURCE` epoch probe standing in for four sources, and
    the cross-component `ROUTE_STACK_BOTTOM_LAYER` anchor), and
    `RouteLayer.test.tsx:558-568` pins it only against the `styledata`
    path. The plan-change path — the one the app exercises constantly —
    is unpinned.
  - *Counterweight, measured:* the property is **doubly held today**, so
    no reachable single edit breaks it. The effect's dependency array is
    `[map]` (`RouteLayer.tsx:560`), **and** `setup` re-probes
    `!map.getSource(ROUTE_SOURCE)` (`:555-556`) before calling
    `setupLayers`, **and** `installStyleSetup` returns a disposer that
    removes all three listeners (`lib/styleReload.ts:50-55`), so even
    adding `plan` to the dep array re-registers cleanly and no-ops:
    `missing` is false, `setupLayers` is not called, and `setStyleEpoch`
    returns the same value. This is the mutation-vacuity test this repo
    documents — *would any change the code could actually make violate
    the assertion?* — and today the answer is no.
  - **Verdict: OFFER, do not recommend.** It becomes a recommendation
    the moment either mechanism is weakened — specifically if the
    single-source probe at `:555` is replaced by a per-source one, which
    is exactly what a `RouteLayer` split would require. That is a
    reopening trigger, not a present benefit.

- **A `sw.ts` `SKIP_WAITING` unit test** (Q8) is defensible and would be
  the first test ever to execute `sw.ts` — but it has no attributable
  defect and it carries a real misreading risk (being mistaken for
  offline-behaviour cover). **Offer it; do not recommend it.**
- **A cross-reference comment on `protocol.ts:9`** naming
  `usePlanFlow.ts:144` (Q7) is nearly free, but the contract is already
  behaviourally asserted at `usePlanFlow.test.tsx:172`. **Optional.**

---

## Considered and rejected

Recorded so none of these can return as a fresh idea.

1. **Extracting `AppShell` into hooks (the general form).** REJECTED as a
   project. Measured: the five concerns that extract cleanly are 137 of
   960 lines (~14%), comment-heavy, and have **zero** attributable
   defects between them; the one concern carrying all three defects sits
   in a 9-cell mutually-writing cluster and does **not** separate. So the
   easy 14% buys nothing measured and the valuable part is not easy.
   **Not fully closed:** continued *incremental* extraction of the clean
   spans is fine if the maintainer values readability independently of
   defect history — the mechanism is proven (`state/`: 8 modules, 1519
   non-test lines, 3256 test lines). What is rejected is a planned
   extraction project justified by defect evidence, because the evidence
   does not support one. **Reopening trigger:** a cross-concern defect in
   this cluster that **ships** (all three so far were caught in review).

2. **A MapLibre facade / narrowing `MapInstanceCtx` to a role-scoped
   interface.** REJECTED, and it is the most seductive candidate in the
   survey. Three independent reasons, each sufficient: (a) **zero of the
   three cited incidents is a type-surface defect** — #160 is a runtime
   insertion-order race using `addLayer`, which every candidate interface
   still exposes; #378 is a style-property side effect; #288 is upstream.
   (b) It is **half-blocked** — four sites (`BoatMarker.tsx:112`,
   `ViaMarkers.tsx:91`, `AisLayer.tsx:257`, `DataLayers.tsx:365`) hand the
   map to maplibre constructors demanding the concrete `Map`, so 4 of 8
   consumers would need the full type back or a cast. (c) The surface is
   **not growth-coupled** — 12 consumers since v0.6.0, 153 `map.*` calls
   since v0.10.0. **Reopening trigger:** a new map-consuming component
   (none since v0.6.0), or a defect that a *type* would have caught.

3. **Splitting `RouteLayer.tsx`.** REJECTED. Zero attributable defects for
   the split specifically, against a measured hazard: the alt-rig layers'
   `beforeId` anchor (`:265`, `:281` → `HIGHLIGHT_LAYER` added at `:138`)
   depends on single-pass ordering that two `installStyleSetup`
   registrations would not guarantee, and a missing-but-truthy `beforeId`
   drops layers **silently**. R4 is the cheap insurance instead.

4. **Reducing `PlannerPanel`'s props.** REJECTED. Only 5 of 24 are
   reachable at the child; two more (`planning`, `viaReplanning`) are
   structurally unreachable without promoting `usePlanFlow`/`useViaReplan`
   to Contexts; the remaining 17 are `AppShell`-local by construction. And
   there is no trend to head off: 23 props at v0.4.0, 24 at HEAD.

5. **Re-layering `lib/`.** REJECTED — NO-ATTRIBUTABLE-DEFECT, zero cycles,
   linear growth. #446 itself marks the "has this ever caused a problem"
   question unassessed; it was assessed here and the answer is no.

6. **A branded type or ownership wrapper for `maskBuffer`.** REJECTED. The
   single choke-point already exists (one transfer at
   `workerClient.ts:232`, one copy at `usePlanFlow.ts:144`); the contract
   is already behaviourally asserted (`usePlanFlow.test.tsx:172`); and the
   brand would **not cover the one silent failure mode** — a view captured
   before the transfer, which degrades in the fail-closed direction
   anyway. Purely prospective.

7. **Promoting `usePlanFlow` / `useViaReplan` to React Contexts.**
   REJECTED **as an evidence-driven change**, and explicitly flagged as a
   maintainer taste call rather than a settled one. It is the only lever
   that would push Q5's reducible count past 5 of 24, and there is no
   defect evidence in **either** direction: nothing traces to `planning`
   being a prop, and nothing traces to the hooks not being contexts.

8. **A React error boundary / global error capture, a store library, a
   router, a component library, a backend.** OUT OF SCOPE by #446's own
   non-goals, and nothing in the evidence argues for any of them. Logging
   and diagnostics are #435's decision document, already written.

9. **Adding more source-scanning structural guards for single-language
   invariants.** REJECTED on the Q14 measurement: six of seven required
   post-creation fail-open fixes, and the three heaviest histories are
   exactly the three that scan TypeScript from TypeScript — the one class
   where a type or lint rule is a candidate. **The cross-language guards
   are explicitly NOT rejected**: no compiler spans CSS and TypeScript, so
   `panelWidth.test.ts` and `useBannerHeight.test.ts` have no alternative,
   and they are the two cleanest by history.

---

## What remains open

1. **Is a ~14% reduction of `AppShell` worth it for a single-maintainer
   hobby project?** The measurement is settled (spans `App.tsx:202-269`,
   `:270-275`, `:601-620`, `:657-671`, `:673-690`, plus JSX `:1016-1025`);
   the value judgement is not, and by #446's own rule the recommendation
   is DECLINE. If readability is weighted independently of defect history,
   that overrides this document.
2. **`pointercancel` semantics** (Q10 finding 4): should an interrupted
   drag commit the last sane position or revert? Commit-on-cancel is
   measured; what `clientX` a real browser attaches is **unmeasured**.
   This is a product decision, not a measurement.
3. *(Moved — #446 asked the spike to RULE on Cache Storage, and an earlier
   revision left it here as a "suggested ruling", i.e. unruled. It is now
   ruled in Part D as Q11's addendum, below.)*
4. **Whether the `SKIP_WAITING` path works end-to-end in a real browser.**
   The trace is complete; proving delivery needs two deployed SW versions
   to produce a waiting worker, which nothing in the suite does.
5. **This checkout's `node_modules` is stale** — installed `maplibre-gl`
   6.0.0 against a lockfile pinning 6.1.0. `npm ci` was declined because
   two implementer agents are live in this tree. It taints any maplibre
   line-number citation made anywhere in this spike (Q9's two are labelled
   at the site). **Whoever reinstalls should re-derive them.**
6. **`ViaMarkers`'s e2e gap stays open even after R3.** A jsdom test
   covers marker creation; it does not cover drag-to-replan through a real
   projection, which remains judged too fragile (Q13). That is narrowed,
   not closed.
7. **The tooling-budget verdict is NOT on this list any more.** An
   earlier revision listed it here as open while simultaneously assigning
   it to #444, which carried no such section — so the exercise's named
   shared metric was measured by one document and ruled on by neither.
   It is now split and both halves are written: the **code-side**
   consequence is ruled in Q15 of this document (the three declines stand
   partly on this evidence); the **automation-surface** verdict is ruled
   in #444 under *"The tooling-budget verdict (Q14's shared metric)"*,
   citing this document's series. What genuinely remains open is narrower
   and belongs to the maintainer: whether the *rate* is acceptable, which
   is a resourcing judgement no measurement settles.

---

## Cross-check with #444 — shared metrics and who owns what

#444 (the sibling spike on `CLAUDE.md` and the automation surface) and
this document overlap on several figures. Where they overlap, **these are
the authoritative values**, all measured at `7195787` on 2026-08-09, so
the two documents cannot quote different numbers.

| Metric | #446's issue body (2026-08-07) | **Authoritative, 2026-08-09 @ `7195787`** |
|---|---|---|
| `CLAUDE.md` | 2,395 lines / 24,891 words / 154 distinct / 354 total issue refs | **2,522 lines / 26,281 words / 160 distinct / 365 total.** `wc -l -w CLAUDE.md`; `grep -oE '#[0-9]+' CLAUDE.md \| sort -u \| wc -l`. The 9 top-level sections do still reproduce |
| `.claude/hooks/` | 4 scripts / 2,593 lines; `artifact-guard.sh` 1,276 | **2,755 lines**; `artifact-guard.sh` **1,438**. The other three are unchanged — `notices-nudge.sh` 604, `wind-fixture-guard.sh` 560, `premerge-verify.sh` 153 |
| `area: tooling` backlog share | 13 of 44 open (~30%) | **18 of 46 open non-PR issues = 39.1 %** (2026-08-09); **16 of 44 = 36.4 %** excluding #444 and #446 themselves. Both commands, the enumerated 18, and the denominator's composition are in Q15 — **and this row is the one that decays fastest in the table**: three readings inside one day — 18/45 = 40.0 %, then 18/46 = 39.1 % when #463 was opened, then **17/45 = 37.8 %** when #459 closed carrying the label. Re-run, do not quote |
| Test file counts | 114 vitest, 12 Playwright | **116** under `vite.config.ts`'s own `src/**/*.test.{ts,tsx}` include glob; **12** Playwright. The six `app/sweep/arm-*.test.ts` are **outside** that glob by design and must not be added in |
| Structural guards | seven | **seven** — reproduces exactly; enumerated with line counts in Q14 |

**Division of labour, so nothing is filed twice — and, more importantly,
so nothing is filed by NOBODY.** An earlier revision of this section and
#444's filing table each pointed at the other for the same two items.
Mutual deferral reads as coverage and is absence; every row below now
names exactly one owner, and each was checked against the other document
rather than assumed.

| Shared item | Owner | Verified present there? |
|---|---|---|
| `workbox-strategies` missing from the notices `PACKAGES` array | **#444** | **Yes** — it is #444's §G1 (the full measurement) and its **R3** (the recommendation). #446 only reproduces the one-line delta in §0 |
| Stale `CLAUDE.md` `file:line` citations | **#444** | **Yes** — §A3.1, all 17 checked exhaustively; **R1** |
| `CLAUDE.md` describes **#282** as REOPENED; the issue is **closed** | **#444** | **Yes**, now — §A3.2. It was **not** when this row was first written, and that is the finding below |
| The tooling-budget **verdict** | **#444** for the automation surface; **#446** for the code-side consequence | **Yes** — #444 §*"The tooling-budget verdict (Q14's shared metric)"*, which cites Q15's series; #446 rules on the code side in Q15 itself |
| Stale-`node_modules` hazard (6.0.0 installed vs 6.1.0 pinned) | **Shared, both carry it** | **Yes** — #444 §0 Hazard 1; #446 Q9's citation caveat. `test/glyphFallbackWarningGuard.test.ts` reads maplibre source out of `node_modules`, so the guard inventory inherits it too |

**The #282 row is the one that had actually gone wrong, and it is worth
recording as a third instance rather than a footnote.** This document
routed the finding to #444 (*"#444 owns `CLAUDE.md`"*), and #444 contained
**zero** mentions of #282 — so a false claim in `CLAUDE.md` (`:1922`:
*"REOPENED … do not let it be closed again on this evidence"*, against
`state: closed`, `closed_at 2026-08-07T17:26:29Z`) was owned by neither
spike. It is now written up in #444 §A3.2, and the mechanism by which
#444's own exhaustive-sounding search missed it is recorded there too.

**Rule this produced, applicable to any pair of documents:** a sentence
of the form *"the other document owns this"* is a claim about that other
document, and it is falsifiable — so check it the same way any other
claim is checked. Three of the five rows above were true when written;
two were not.

**Both documents must apply the same decision rule.** #446 A2 (*"a
candidate with zero attributable past defects should be recorded as
declined"*) and #444 Q14 (*"'this is fine as it is' is an acceptable and
valuable verdict"*) are the **same rule**. If the two spikes word it
differently a reader will conclude two different bars were applied. It is
one bar: **attributable defect, or declined.**

---

## Claim-strength note

**Eight** things are deliberately **not** claimed. (An earlier revision
opened this section with "Five" while listing eight — a count claim
falsified by the list directly beneath it, which is the most falsifiable
kind and therefore the least excusable. Corrected rather than dropped,
because a document that audits count claims must survive its own audit.)

1. **Hit rate of the structural guards is UNMEASURED, not zero** (Q14). A
   guard that fires in CI leaves no commit; the tree records only cost.
   The one documented zero (`timeoutBudgetVsJobCap`) is confirmed here but
   is one data point, not a rate. Do not cite Q14 as evidence the guards
   do nothing.
2. **Two maplibre line numbers (`marker.ts:392`, `popup.ts:244`) were read
   against 6.0.0, not the pinned 6.1.0** (Q9). The conclusion is
   API-stable; the numbers are not, and must not be restated as 6.1.0.
3. **The Q8 built-output confirmation describes `app/dist` dated
   2026-08-08 15:10, not provably HEAD.** The source-level trace is
   HEAD-accurate.
4. **Q13's "the geolocation precedent does not transfer" is a reasoned
   distinction, not a measurement.** What is measured is that
   `plan.spec.ts:82` cites live-projection dependence and that no spec in
   the suite performs a canvas-coordinate tap.
5. **No claim is made that any declined refactor would be harmful** —
   only that no measured evidence justifies it today, and that the cost
   lands in a budget line (Q15) that is rising. "Narrowed, not closed"
   applies to every decline: each carries a named reopening trigger
   above.
6. **The Q15 trend is a THREE-point monotone run after the inception
   week is excluded, and no rate of change is claimed.** The step sizes
   (+31.4, +5.7, +9.6 points) do not support "accelerating"; the earlier
   "risen every single week of the project's life, from 2.5% to 50%"
   overclaimed on all three counts corrected in Q15.
7. **The tooling-share ratio DECAYS and both documents say so.** It read
   18/45 = 40.0 %, then 18/46 = 39.1 % once #463 was opened, then 17/45 =
   37.8 % once #459 closed carrying the label — **three readings in one
   day, moving in both terms**; the commands are quoted so it can be
   re-run rather than trusted. Only the SNAPSHOT decays this way: the
   creation-rate series is bucketed by historical week and does not.
8. **R4 is an OFFER, not a recommendation, and the reason is that the
   property it would pin is doubly held today** — no reachable single
   edit violates it, so the assertion cannot presently catch a defect.
   Do not cite R4 as evidence that `RouteLayer` needs work.

Two provenance limits repeated here because they bound the whole document:
**Part D's evidence arrived truncated mid-Q11** (its closing
recommendation is reconstructed from directly re-verified facts and
labelled as such), and **Part E had no evidence at all** — Q13, Q14 and
Q15 were measured in this run and are the only sections with a single
measurer.
