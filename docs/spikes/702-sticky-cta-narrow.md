# Spike #702 — sticky "Route planen" CTA on narrow viewports

- **Issue:** #702
- **Status:** Open, deferred to v0.16.0, not fixed as of this writing
- **Attempt count:** THREE rounds recorded (round 1 in PR #735, per the
  2026-08-26 comment's "three measured rounds"; round 2 the narrow-only
  horizontal inset that was reverted; the 2026-08-28 re-triage names any
  future work "attempt 4")
- **Verdict:** No fix is recommended by this document. The ORIGINAL premise
  the issue was filed on is REFUTED (§1). A partial fix (the narrow-only
  horizontal inset, §3) was measured, works for one sub-problem, and was
  correctly reverted for being insufficient against the real blocker (§4).
  The real blocker — an expanded ~370px attribution panel occluding the CTA
  — remains unsolved. This document exists because this issue "keeps losing
  its own history" (orchestrator's framing) and a fresh implementer must not
  re-derive a false premise from the issue title alone.

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

Deferred to v0.16.0. Not scheduled for implementation in the 2026-08-28
session: "it needs a design pass first, and it has failed twice on aperture
rather than on effort." Issue #702 remains open. No PR closes it. This
document is written specifically so that a future "attempt 4" starts from
the state recorded here rather than re-deriving (and possibly
re-refuting) the same premise from the issue title alone.
