# Spike #702 — sticky "Route planen" CTA on narrow viewports

- **Issue:** #702
- **Status:** SUPERSEDED as of 2026-09-01 — attempt 4 was implemented and
  the blocker this document called unsolved had been dissolved in the
  meantime by PR #800. Everything below §0 is preserved verbatim as the
  record of attempts 1-3; read §0.1 first for what changed, then treat §4
  and §7's first bullet as superseded (each carries its own note). Re-check
  `gh api repos/DocGerd/sail_command/issues/702` before trusting any
  milestone number quoted below: it decays at every cut.
- **Attempt count:** THREE rounds recorded here (round 1 in PR #735, per the
  2026-08-26 comment's "three measured rounds"; round 2 the narrow-only
  horizontal inset that was reverted; the 2026-08-28 re-triage names any
  future work "attempt 4"). Attempt 4 is the fix, recorded in §0.1.
- **Verdict (as written, attempts 1-3):** No fix is recommended by this
  document. The ORIGINAL premise the issue was filed on is REFUTED (§1). A
  partial fix (the narrow-only horizontal inset, §3) was measured, works for
  one sub-problem, and was correctly reverted for being insufficient against
  the real blocker (§4). The real blocker — an expanded ~370px attribution
  panel occluding the CTA — remains unsolved. This document exists because
  this issue "keeps losing its own history" (orchestrator's framing) and a
  fresh implementer must not re-derive a false premise from the issue title
  alone.

---

## 0.1 What changed — PR #800 dissolved the blocker, and attempt 4 shipped

**The blocker in §4 was never about the overlap AREA; it was about who won
the hit test, and PR #800 (for #771) inverted that.** At the time §4 was
measured, `.planner-actions` still carried `z-index: 2` in its BASE rule.
`.planner-panel` is `display: flex`, so per css-flexbox-1's "Painting Flex
Items" a flex item with a `z-index` other than `auto` creates a stacking
context EVEN WHILE `position: static` — which is why the bar painted over
the expanded attribution panel and swallowed clicks on all four credit
links. PR #800 moved `z-index` into the wide-only rule. With `z-index: auto`
at narrow the bar paints at step 8 of CSS 2.1 Appendix E's order while
`.maplibregl-ctrl-bottom-right`'s own `z-index: 2` holds the attribution at
step 9 of the same root stacking context, so the attribution now wins both
the paint and the hit test whether or not the bar is sticky.

Attempt 4 therefore consists of one narrow-only rule adding
`position: sticky; bottom: 0; padding-right: 24px` and **no `z-index`** —
§2's constraint is met, not worked around.

Measured 2026-09-01 against real builds (Chromium via Playwright,
deviceScaleFactor 1), at every narrow viewport of `app/e2e/helpers.ts`'s
matrix:

- **The guarantee was genuinely unmet.** The EMPTY German planner already
  overflowed `.app-panel`'s scrollport by 178px (`tabletPortrait`) to 653px
  (`wrapForcing280`), putting the CTA below the fold on arrival — no
  disclosure to open, no via points to add. (The "Erweitert" disclosure the
  issue's own scenario named no longer exists in `PlannerPanel.tsx`; #299
  moved those controls to the Boat tab.)
- **Every credit link is topmost and clickable at rest**, collapsed and
  expanded, in both the empty and the endpoints-selected planner. Note what
  is NOT claimed: the expanded panel still geometrically overlaps the bar.
  Only the stacking outcome changed, and that is what the licence obligation
  turns on.
- **The 34.00px collapsed-toggle offset in §3 reproduces**, re-verified at
  14 widths from 280 to 3840. The shipped separation is `padding-right`,
  NOT the `margin-right` §3 measured: a margin would pull the bar's opaque
  `background: var(--sc-bg)` off the panel's content edge and let content
  scrolling underneath the pinned bar show through the gap.

**One correction to a premise a future reader would otherwise inherit.**
`scrollIntoView({ block: 'end' })` — which `plan.spec.ts`'s #771 helper uses
to reach the CTA — is NOT equivalent to `position: sticky; bottom: 0`. It
aligns the element's bottom margin edge with the scrollport's PADDING-box
bottom, whereas a sticky offset resolves against the scroll container's
CONTENT box, so `.app-panel`'s 0.75rem bottom padding pins the bar 12px
HIGHER (measured -11.50px to -12.36px across ten narrow rows). The #771 rows
therefore say nothing about the at-rest sticky position, and the #702 guards
in `app/e2e/plan.spec.ts` carry that load themselves.

**Accepted costs, stated rather than discovered later.** `padding-right`
narrows the bar's content box, so at 360px the German onboarding guidance
wraps to a second line and the bar grows 84px -> 100px (`deepPortrait320`
and `wrapForcing280` already wrapped before the change). And at
`shortLandscape740` (740x360) the sheet is ~198px, of which `.app-panel`'s
scrollport is 152px and the pinned bar 84px in the empty state, 60px with
endpoints selected. That is the trade §3.3 asks for; sticky is a no-op
whenever the content fits.

---

## 0. Provenance

Everything below is drawn from the #702 issue body and its two comments
(`gh api repos/DocGerd/sail_command/issues/702` and
`.../issues/702/comments`, both posted by `DocGerd`, dated 2026-08-26 and
2026-08-28), read 2026-08-28. Quoted passages are reproduced verbatim from
those comments. No new measurement was taken to produce this document —
it is a transcription and organisation of the existing record, not a fourth
investigation.

---

## 1. The original premise — REFUTED

The issue as filed (2026-08-26 or earlier) proposed:

> Flipping `position: sticky` back on for narrow reproduces the exact
> regression the current code exists to avoid [i.e. #64].

This was measured and found FALSE on 2026-08-26 (PR #735 investigation):

> **#64 is already reachable in the shipped build.** On unmodified
> `develop`, scrolling `.app-panel` to the bottom — which a user must do,
> since at `scrollTop 0` the CTA is below the fold (`Route planen` top=1112,
> panel ends 844) — already produces **488.1px² / 495px²** of overlap with
> the attribution control AND the identical click interception
> (`locator.click` timeout, stack `["P.planner-guidance",
> "DIV.planner-actions", "SUMMARY.maplibregl-ctrl-attrib-button"]`).

So the shipped, `position: static` behaviour — reached by ordinary
scrolling, with no code change at all — already has the #64 defect the
issue's proposed fix was supposedly at risk of reintroducing. This makes the
original framing backwards: making the CTA sticky was never a
trade-off against a clean baseline, because the baseline was never clean.

The 2026-08-28 re-triage restates this explicitly for a fresh implementer:

> **"Making the CTA sticky would reproduce #64" is false.** #64 already
> reproduces on unmodified `develop`, reached by ordinary scrolling —
> measured 488.1px² of overlap against a 495px² control, with the click
> genuinely intercepted. So this was never a sticky-versus-static
> trade-off; the attribution control is occluded at rest today, which makes
> it a live ODbL/CC-BY compliance problem independent of this issue's fix.

**The record is explicit that a first investigation compared the sticky
variant against a baseline that was never measured, and that this
invalidated its conclusion**, quoted directly:

> The first investigation measured the sticky variant at 484px² and
> concluded "cannot be done safely" — comparing against a baseline it had
> not measured and that is not clean. **Do not amend spec §3.3 on that
> reasoning.** The guarantee is unachieved, not unachievable.

---

## 2. What the issue's own constraint requires

From the issue body: no new `z-index` value may be given to
`.planner-actions` — `app.css` documents it (~214-218 at filing time) as a
LOCAL sticky offset deliberately OUTSIDE the Tier 0-3 map-chrome ordering,
and it must stay that way. This constraint is reaffirmed unchanged in both
comments and in the restated attempt-4 definition of done (§6).

---

## 3. The collapsed-toggle fix — measured, reusable, insufficient alone

The 2026-08-26 comment records a real, working fix for one sub-problem — the
**collapsed** attribution toggle:

> `innerWidth − attribButton.left` = **34.00 at every width from 280 to
> 3840**, and at deviceScaleFactor 1, 2 and 3. A narrow-only
> `margin-right: 24px` on `.planner-actions` gives exactly **2.0px**
> clearance, zero overlap and real click-through at `phonePortrait`,
> `narrowPortrait360`, `shortLandscape844`, `shortLandscape740`,
> `deepPortrait320`. Wide layout stayed identical to the existing rule pair
> to the decimal at 1024/1920/3840, breakpoint clean at 1023/1024. That
> part works and is reusable.

This is recorded as measured and reusable — a future attempt does not need
to re-derive the 34.00px collapsed-toggle offset or re-measure that a
narrow-only 24px margin clears it.

---

## 4. Why it was reverted — the real blocker

> **SUPERSEDED (2026-09-01, see §0.1).** Everything measured in this section
> was correct when measured. It has since been dissolved — not by a fix to
> the CTA, but by PR #800 removing `z-index: 2` from `.planner-actions`'
> base rule, which inverted who wins the hit test over the expanded panel.
> The overlap AREAS quoted below are not claimed to have changed. Kept
> verbatim: this section is why the horizontal inset alone was correctly
> reverted, and that reasoning was sound.

The collapsed-toggle fix does not address the control once a user expands
it (tapping the attribution toggle reveals the OSM/PMTiles/other credit
links). The 2026-08-26 comment measured this directly:

> That inset clears the **24px collapsed toggle**, not the **~370px panel it
> opens**. With the attribution expanded, at rest: overlap **21204px²**
> (phonePortrait), **29064** (shortLandscape740), **22304**
> (deepPortrait320). All four credit links hit-test to `.planner-actions`,
> its primary button, or `.planner-guidance`, and `click({trial: true})` on
> the OpenStreetMap link times out at all three.
>
> Same-element control at phonePortrait: HEAD `sticky` → topmost
> `BUTTON.sc-btn-primary`, **blocked**; BASE `static` → topmost `A.`,
> **clickable**. So it is a regression, and a permanent one where BASE's
> needed a scroll to maximum.
>
> **This is a licence obligation, not a cosmetic one** — attribution
> reachability is required by ODbL/CC-BY and is `plan.spec.ts`'s own "#33
> contract part 2".

The 2026-08-28 re-triage restates this as the second point a fresh
implementer must not miss:

> **The blocker is the EXPANDED attribution panel (~370px), not the 24px
> collapsed toggle.** The narrow-only horizontal inset that addressed the
> collapsed state was measured, is reusable, and was correctly reverted as
> insufficient — it does not address the expanded state at all.

So the horizontal-inset fix is CORRECTLY reverted, not abandoned in error:
it solves a real sub-problem (the collapsed toggle) completely, and fails
completely against the sub-problem that actually blocks the issue (the
expanded panel). Both facts are true at once; neither supersedes the other.

---

## 5. The stacking mechanism (measured, and a related but separate defect)

> Every ancestor (`.planner-panel`, `.app-panel`, `.app-bottom-sheet`,
> `.app-shell`, the wrapper, `body`) is `z-index: auto` with no
> `transform`/`opacity`/`contain`/`isolation`. So `.planner-actions` (z2)
> and `.maplibregl-ctrl-bottom-right` (z2) tie in the **root** stacking
> context and DOM order decides — the sheet comes after the map, so the bar
> wins. (`app.css`'s claim that these are in different stacking contexts is
> false and is being corrected in PR #735 independently of this issue.)

The stacking-context correction referenced here (`app.css`'s comment being
wrong about separate stacking contexts) is recorded as being fixed
independently, in PR #735, and is not part of what #702 itself needs to
solve — it is background mechanism, included here because it explains WHY
DOM order (not z-index) decides the tie, which is also why no new
`z-index` value would help even if the constraint in §2 were relaxed.

---

## 6. Why no guard caught this — and the restated definition of done

> `plan.spec.ts`'s attribution contract asserts with `toBeVisible()`, which
> **cannot see occlusion**; the #702 e2e sweep expanded the control only
> *after* every assertion. Two guards, one structural blind spot. **Any
> future #702 attempt must assert on the EXPANDED attribution state**, with
> a real `click({trial: true})`, or it will pass while shipping this exact
> regression.

The 2026-08-28 re-triage restates the definition of done for a future
attempt (labelled "attempt 4") in full, and it is reproduced here verbatim
because it is the binding scope for any future work on this issue:

> **Restated definition of done for attempt 4:**
> - Assert against the **expanded** attribution, not the collapsed toggle.
> - Use a real `click({trial: true})` or a topmost hit-test. `toBeVisible()`
>   **cannot** see occlusion — it passes for an element that is rendered
>   but fully covered, and two separate guards on this surface both passed
>   while the credit link was unclickable.
> - Re-sample geometry inside the poll callback; do not freeze a
>   `boundingBox()` and assert against it (#412).
> - Measure the baseline before reporting any negative result.
> - No new `z-index` value: map-chrome stacking is a declared tier order,
>   and a same-tier overlap is fixed by moving an element, not by bumping
>   it.

---

## 7. Considered and rejected (or not yet attempted)

- **Narrow-only horizontal inset alone (`margin-right: 24px` on
  `.planner-actions`)** — considered and REJECTED as a complete fix.
  Measured to work perfectly against the collapsed attribution toggle
  (§3), and measured to fail completely against the expanded panel (§4,
  21204-29064px² of overlap, all four credit links blocked). Reverted for
  that reason. It remains a REUSABLE partial building block — the 34.00px
  collapsed-toggle offset and the exact 2.0px-clearance margin value do not
  need to be re-derived by a future attempt — but it must not be reproposed
  as sufficient on its own.
  **SUPERSEDED (2026-09-01, see §0.1):** it IS sufficient on its own now,
  and shipped as part of attempt 4 — because the sub-problem it failed
  against (the expanded panel) was closed separately by PR #800, not
  because this judgement was wrong. It shipped as `padding-right`, not
  `margin-right`; §0.1 records why.
- **Amending spec §3.3 to declare the guarantee unachievable** — considered
  and explicitly REJECTED, twice. The 2026-08-26 comment: "Do not amend
  spec §3.3 on that reasoning. The guarantee is unachieved, not
  unachievable." The issue has failed twice on APERTURE — narrow
  investigations that didn't reach the real blocker, or a fix that solved
  only part of it — not on the underlying problem being unsolvable. No
  round of this issue has produced a structural argument that the expanded
  attribution panel and the sticky CTA cannot coexist on a narrow viewport;
  only that the specific shapes tried so far do not achieve it.
- **A new `z-index` value for `.planner-actions`** — never proposed, and
  explicitly ruled out by the issue's own constraint (§2), restated
  unchanged in the 2026-08-28 attempt-4 definition of done. Any future fix
  must find another mechanism (moving an element, restructuring the
  stacking, or something not yet tried) rather than winning the tie by
  raising the CTA's z-index.
- **A fix for the expanded-panel occlusion** — NOT YET ATTEMPTED. The
  2026-08-26 comment records: "Several shapes remain open and none were
  tried." This is the actual open work, not a rejected option — it is
  listed here to make clear that the absence of a considered-and-rejected
  entry for it does not mean it was overlooked; it means no round has
  reached the point of proposing a concrete mechanism for it yet.

---

## 8. Status as of this writing

> **SUPERSEDED (2026-09-01, see §0.1): attempt 4 is implemented.** The
> paragraph below is the state as of 2026-08-31 and is kept as the record.

Moved off v0.16.0 to v0.17.0 on 2026-08-31, per the issue's milestone
history. Not scheduled for implementation in the 2026-08-28
session: "it needs a design pass first, and it has failed twice on aperture
rather than on effort." Issue #702 remains open. No PR closes it. This
document is written specifically so that a future "attempt 4" starts from
the state recorded here rather than re-deriving (and possibly
re-refuting) the same premise from the issue title alone.

## 9. How attempt 4 met §6's definition of done

Each bullet of §6's restated definition of done, and where it is discharged:

- *Assert against the expanded attribution, not the collapsed toggle* — the
  #702 guard expands the control and walks EVERY `.maplibregl-ctrl-attrib a`,
  not the OpenStreetMap anchor alone, at every narrow viewport in both
  planner states.
- *Use a real `click({trial: true})` or a topmost hit-test* — both: a
  topmost hit-test per link plus `click({ trial: true })` on the toggle and
  on the OpenStreetMap anchor.
- *Re-sample geometry inside the poll callback* — every probe re-reads its
  boxes on each tick; no `boundingBox()` survives across a tick.
- *Measure the baseline before reporting any negative result* — the BASE
  geometry was measured on a real build before a single assertion was
  written, and it is what refuted the `scrollIntoView`/sticky equivalence
  recorded in §0.1.
- *No new `z-index` value* — none is added at any width; the fix works
  BECAUSE `z-index` stays `auto` at narrow.

One methodological note worth carrying forward, because it nearly filed a
false licence failure: an inline `<a>` that wraps has one client rect per
line box while its BOUNDING BOX spans both lines plus the gap between them,
and that gap belongs to the parent. Centre-probing the bounding box reported
`covered-by:div.maplibregl-ctrl-attrib-inner` — the link's own parent — for
every two-line anchor, while both line-box centres hit-tested to the link.
Hit-test `getClientRects()`, not `getBoundingClientRect()`, on inline
content.
