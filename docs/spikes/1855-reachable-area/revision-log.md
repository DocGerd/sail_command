# #1855 design: revision log

How the revision disposed of each finding in `critique.json`. Written before the PR's review; `../1855-reachable-area.md` supersedes it where they differ. Section numbers refer to that document.

Verbs: APPLIED (taken as suggested), NARROWED (taken in part, the rest stated), DEFERRED-R0 (decided by the v0.62.0 measurement slice R0), DECLINED.

1. C1 [high] `harborEndpointPocketed` is false for a `shallow-approach` origin. APPLIED (§0, §5.5, §15). Three-way origin posture from `endpointStateAt`: `ok` no disc, `shallow-approach` origin disc at `relaxationFloorM`, `unreachable` handover seed. The predicate is dropped from both graft lists.
2. C2 [high] Relaxed copy quotes the floor as water depth; disc water filled like at-gate water. APPLIED (§5.5, §7.2, §8, §12). Copy states `cautiousDepthLowerBoundM` and the below-draft fact and points to the shallow-water warning; disc-only water is hatched in the reach raster.
3. C3 [high] Grafts change what was ranked. APPLIED (§0). Cost and fit re-estimated in words for the composite; declined grafts named.
4. C4 [medium] No design models the #1721 handover. APPLIED (§5.5, §7.2, §15). Pocketed origin seeds at `findHarborHandoverFor`; pocketed destinations get an ETA to their handover point with `route.handover.*` wording; no "unreachable" wording.
5. C5 [high] Streaming bands promised from ring-12 timings. APPLIED (§0, §5.4, §17). `drainedToMs` is computed but unused by copy until R0 records it per ring; progress shows search time reached; partial label stays "mindestens erreichbar".
6. C6 [medium] Destination discs relax the gate for every path and re-anchor the comfort ramp. APPLIED (§7.2, §15). No destination discs; origin disc only per C1.
7. C7 [medium] Fill paints at-gate water cut off inside a coarse cell. APPLIED (§5.2, §14). Mask-cell edge trace plus a bounded at-gate flood; unit fixture with a mole. Cost DEFERRED-R0.
8. C8 [medium] Tablet cost of the grafts unmeasured; every-child stamping ~34× edges. APPLIED (§5.2, §6, §13, §16 Q7–Q8, §17). Survivor-plus-edge stamping kept; memory costs stated; R0 measures time and heap for one and two rigs; a reach budget is a maintainer question.
9. C9 [medium] Two-rig graft rests on one mark. APPLIED (§5.6, §13 M4, §16 Q1). Gap reported per mark; single rig kept until R0's per-harbour ETA comparison by rig.
10. C10 [medium] Cancel discards the partial; tab leave cancels. APPLIED (§6). Cooperative `stop` returns the partial; leaving Wetter keeps the run.
11. C11 [medium] Own worker still competes with planning. APPLIED (§6). Preemption rule: every planning entry point stops a running reach and keeps its partial; a reach never delays or cancels a plan.
12. C12 [medium] Outline-only or default-hidden fill fails the draft acceptance. APPLIED (§8, §15). Fill on by default with a hide/show control; any outline is a vector layer.
13. C13 [medium] Hour scrubbing stales the result. APPLIED (§2, §4, §8). Departure frozen into the run and shown from the result; scrubbing does not stale. Other input changes hide the fill and grey the rows.
14. C14 [medium] Hiding the depth hatch removes the #455 disclosure. APPLIED (§8, §14). `sc-depth-hatch` stays above `sc-reach-fill`; a `layerOrder` row and a verify check pin it.
15. C15 [medium] Harbour taps before the popup slice undefined. APPLIED (§7.4, §16 Q9). With a result on Wetter a tap selects its row; e2e pin.
16. C16 [medium] Snap-cell ETA drops harbours silently. APPLIED (§7.1, §14). Arrival tests, a connected-cell fallback marked "ca.", and a "Nicht gefunden" list; arrival-test cost DEFERRED-R0.
17. C17 [medium] No contrast target for the fill. APPLIED (§8, §14). ≥ 3:1 measured in the verify pass; vector outline if it fails.
18. C18 [low] Probe drops the final partial step. APPLIED (§5.3, §14).
19. C19 [low] Approach ETA by straight-line proximity. APPLIED (§7.2, §14). Cells inside the disc connected to the snap under an `approachGate` at the floor.
20. C20 [low] Late-lowering magnitude understated. APPLIED (§5.4). 6 525 000, 6 300 000 and 7 350 000 ms cited with config ids.
21. C21 [low] Snapshot basis misstated. APPLIED (§13 M2). "The final ≤ 6 h set exceeds the ring-36 snapshot by …" with per-config figures.
22. C22 [low] Progress fraction runs on the ring clock. APPLIED (§2, §9, §15). Indeterminate bar with search-time text.
23. C23 [low] Disabled buttons give no touch feedback. APPLIED (§6, §9). `aria-disabled` with a visible reason, announced on press.
24. C24 [low] Summary can land under the sticky hour row. APPLIED (§11). `scroll-margin-top` plus a geometry check at 820×1180 with and without a toast.
25. C25 [low] Offline [Als Ziel] lands where planning cannot run; §12's offline sentence. APPLIED (§7.3, §10, §16 Q4). Offline note beside [Als Ziel]; the §12 amendment is a maintainer question.
26. C26 [low] Handoff focus target differs. APPLIED (§7.3). #1854 §11's rule: `#planner-departure` with Ziel set.
27. C27 [low] Sea-state checkbox reads checked while suppressed. APPLIED (§8). The checkbox shows a suppressed state with `reach.suppressed`; [Reichweite ausblenden] is the control.
