# Spike #744 — safety-depth field row: orphaned unit wrap and label baseline mismatch

- **Issue:** #744
- **Fix PR:** #764 (`fix/744-safety-depth-field-row` → `develop`, merged
  2026-08-28T13:09:49Z, merge commit `f556149`, closing #744 — shipped in
  v0.16.0)
- **Date filed:** 2026-08-27
- **Date measured / decided:** 2026-08-28
- **Status:** Decision — accepted fix, one residual carried forward
- **Verdict:** Adopt **option 1 (`align-items: start`) plus option 4 (a
  non-breaking space in the help string)** together. Reject options 2, 3 and
  5 — reasons in §4. One residual is accepted, not closed: after the fix, the
  safety-depth field's INPUT still sits **~19.81px** lower than the departure
  field's own input at the two narrowest two-column viewports (112.8px
  column). The two field LABELS are aligned to 0px delta everywhere
  two-column layout applies.

---

## 0. Provenance

Everything below is drawn from the #744 issue thread (`gh api
repos/DocGerd/sail_command/issues/744` plus its two comments, both posted by
`DocGerd`) and from PR #764's body (`gh api
repos/DocGerd/sail_command/pulls/764`), read 2026-08-28. Quotations are
reproduced as posted; nothing here is this document's own re-analysis of the
layout beyond what those artifacts already state. Where the source states a
number, that number is carried verbatim with its basis; no figure below has
been independently re-derived for this write-up.

---

## 1. The measured defect (both halves)

Filed 2026-08-27 against a v0.15.0 release-candidate build
(`http://localhost:4174/sail_command/`, Playwright, 1280x1000 viewport,
`getBoundingClientRect()`), then re-measured 2026-08-28 against
`develop`@`88c13af` across the full `STANDARD_VIEWPORTS` + `EDGE_VIEWPORTS`
matrix (`app/e2e/helpers.ts`).

### (a) Orphaned "m" in the safety-depth help text

The paragraph `#planner-safety-depth-help` ("Allowed range: 2.2–10.0 m")
wraps at 160px width into two lines, with the unit alone on the second line:

```
line 1: "Allowed range: 2.2–10.0 "
line 2: "m"
```

The 2026-08-28 measurement pass found this **narrower than filed**: it
reproduces only where the safety-depth grid column is capped at its 160px
width (6 of the 12 two-column viewports tested: desktop4k, desktopHd,
tabletPortrait, shortLandscape844/740/932). At the 112.8px column width the
text wraps into two clean words ("range:" / "2.2-10.0 m") rather than
orphaning the unit, and below 380px the row goes single-column and does not
wrap at all.

### (b) Label baseline mismatch

In the Departure / Safety-depth (m) field row, the two field labels do not
share a baseline. As originally filed (1280x1000 viewport):

- "Departure" label: `top: 632.4px`
- "Safety depth (m)" label: `top: 597.6px`
- delta: **~34.8px** (Safety-depth sits higher)

The 2026-08-28 pass confirmed this across viewports and found the delta is
**not constant** — it depends on the safety-depth column width:

| Viewport | unit "m" orphaned? | sd label `top` | dep label `top` | delta |
|---|---|---|---|---|
| desktop4k 3840x2160 | yes | 653.59 | 688.41 | 34.81 |
| desktopHd 1920x1080 | yes | 660.19 | 695.00 | 34.81 |
| tabletLandscape 1180x820 | no (clean word wrap) | 690.19 | 744.00 | 53.81 |
| tabletPortrait 820x1180 | yes | 1124.19 | 1159.00 | 34.81 |
| phonePortrait 390x844 | no (clean word wrap) | 1003.00 | 1056.81 | 53.81 |
| shortLandscape 844/740/932 | yes | — | — | 34.81 |
| narrowPortrait360 / deepPortrait320 / partialPushBand375 / wrapForcing280 | no wrap (single column) | n/a — stacked | n/a | not same-row |

34.81px is the 160px-column figure (matching the originally filed 34.8px
exactly); 53.81px is the 112.8px-column figure. Light and dark theme were
byte-identical throughout — theme has no effect on either defect.

Both defects were confirmed present on unmodified `develop`, not caused by
any prior change in flight: the issue text itself notes PR #741's taller
`start-view.png` crop (1280x800 → 1280x1000) simply brought this row into
frame for the first time — "Neither is caused by #741, and neither is a
reason to revert its framing fix."

---

## 2. The mechanism

Established from computed geometry, not assumed (per the maintainer's
2026-08-28 comment, which named the hypothesis to confirm before proposing
anything): `.planner-compact-row` (`app.css`) sets `align-items: end`,
bottom-aligning the row. This was correct when the row was added at #64,
when both columns' content ended at their input. #699 later added a visible
help paragraph below only the safety-depth column, so `.planner-safety-depth`
became taller than `.planner-departure`, and bottom-alignment pushes the
now-taller column's whole content — including its label — upward relative to
its shorter row partner.

Measured directly: `.planner-departure` (label + `datetime-local` input,
no help paragraph) is a fixed 62.19px tall. `.planner-safety-depth` (through
`Field.tsx`, with its `.sc-field-help` paragraph visible) is 97px at the
160px column or 116px at the 112.8px column, depending on how many lines the
help text wraps to. `97 − 62.19 = 34.81` and `116 − 62.19 = 53.81` — exact,
both cases. The help paragraph's extra height is the single cause of the
baseline mismatch; bottom-alignment (`align-items: end`) is what transfers
that height difference onto the label position.

A positive control validated the wrap-detection method used for defect (a)
before trusting its "no wrap" readings: forcing the help element to
`width: 40px` at runtime took the detected line count from 2 to 5, proving
the method can see additional wraps rather than always reporting a fixed
number.

---

## 3. The five candidate fixes

Recorded in the 2026-08-28 measurement comment on #744, none implemented at
the time of that comment:

1. **`align-items: start`** — trivial for defect (b); un-flushes the two
   inputs' bottom edges from each other and from the button below.
2. **`align-items: baseline`** — aligns the labels precisely; the inputs
   then sit at different vertical positions.
3. **Drop the visible help paragraph** in this compact row (keep it
   `sr-only` + `aria-describedby`; the full text still renders on the Boat
   tab). Closes (a) and (b) together — cost is losing the always-visible
   range hint in this row.
4. **Non-breaking space** gluing "10.0 m" (the `{max}` interpolation and the
   unit) in `options.safetyDepth.help` — cheap, closes (a) only, does
   nothing for (b).
5. **Make `.planner-compact-row` a grid with shared rows** (label row /
   input row / help row), so labels align by construction and each field's
   help occupies the same track. Structurally the most correct option, and
   it keeps the visible hint — but the largest change, and it needs its own
   viewport sweep.

---

## 4. The decision: option 1 + option 4, and why the other three were rejected

PR #764's body states the design was "decided by a three-agent design team
after real-browser measurement of the control; adopted verbatim" and
implements **option 1 (`align-items: start`) together with option 4 (a
non-breaking space)**:

> - `.planner-compact-row`'s `align-items: end` was correct at #64 when both
>   columns ended at the input; #699 added a help paragraph below only the
>   safety-depth column, so ending both columns pushed the departure-date
>   input down to match. Switch to `align-items: start`.
> - Insert a non-breaking space (explicit `\u00A0` escape sequence in the
>   source, not a raw invisible character) between `{max}` and the unit in
>   `options.safetyDepth.help` (both `dict.en.ts` and `dict.de.ts`), so
>   "10.0 m" / "10,0 m" cannot wrap with the unit orphaned on its own line.

### Considered and rejected

**Option 2 (`align-items: baseline`) — rejected.** No stated reason beyond
its own description in §3: it aligns the labels but leaves the two fields'
inputs at different vertical positions, which is the same class of visual
mismatch the fix set out to remove, only relocated from the labels to the
inputs. Nothing in the record suggests option 2 was measured before being
set aside — it appears to have been rejected on inspection of what it would
necessarily do, in favour of the option (1) that keeps the misalignment
localized to a smaller, explicitly-accepted residual (§5).

**Option 3 (drop the visible help paragraph, keep `sr-only`) — rejected.**
Closes both defects at once, and was recorded as such, but "the cost is
losing the always-visible range hint here." The always-visible hint —
telling the user the allowed safety-depth range without requiring a switch
to the Boat tab or a screen reader — was judged worth keeping over the
layout defects it causes. No fix that removes user-visible information was
adopted in place of one that does not.

**Option 5 (shared-track grid) — rejected as too large for this fix.**
Described in the record as "structurally the most correct" of the five, and
the only one that aligns labels BY CONSTRUCTION rather than by choosing a
flex alignment keyword. Explicitly declined because "it is the largest
change and needs its own viewport sweep" — this is a scope decision, not a
correctness objection. A shared-track grid for `.planner-compact-row` is a
real candidate for closing the accepted residual (§5) or the German label
overflow found alongside this fix (§6), but nothing in the record proposes
building it now, and nothing here should be read as reopening it as a fresh
idea without a new, explicit measurement pass.

---

## 5. The measured control table (both languages)

From PR #764's body: measured live at `develop@88c13af` (merge-base, BASE)
vs the fix branch (HEAD), full `STANDARD_VIEWPORTS` + `EDGE_VIEWPORTS`
matrix, both `de` and `en`. `labelDelta`/`inputDelta` = safety-depth field's
label/input `top` minus the departure field's own `top` (0 = perfectly
aligned). Single-column viewports are listed separately since `align-items`
cannot affect a one-column grid.

### Two-column viewports (`align-items` is live here)

| Column width | Lang | BASE labelDelta / inputDelta | HEAD labelDelta / inputDelta |
|---|---|---|---|
| 160px (desktopHd, desktop4k, tabletPortrait, shortLandscape844/740/932) | en | -34.81 / -34.00 | 0 / +0.81 |
| 160px (same set) | de | -34.81 / -34.00 | 0 / +0.81 |
| 112.8px (phonePortrait, tabletLandscape) | en | -53.81 / -34.00 | 0 / **+19.81** |
| 112.8px (same set) | de | -68.81 / -49.00 | 0 / **+19.81** |

"`align-items: start` shrinks the magnitude in EVERY two-column cell on
BOTH axes" — measured independently by the PR's author against the design
team's own figures, not copied from the brief.

### Single-column viewports (narrowPortrait360, deepPortrait320,
partialPushBand375, wrapForcing280) — unaffected, as expected

BASE and HEAD are byte-identical: `labelDelta=74.19`, `inputDelta=75.00` in
both `en` and `de`, at every one of these four viewports. Fields stack as
separate grid rows here, so `align-items` has no effect — this is the
control that shows the fix touches only the rows it is meant to touch.

### Orphan-wrap positive control (`Range.getClientRects()` over the text
node, not `label.getClientRects()`, "which is always 1 for a block box and
reveals nothing")

| Regime | Lang | BASE last-line width | HEAD last-line width | Verdict |
|---|---|---|---|---|
| EN, 160px column | en | **12.47px** (orphan "m" alone) | 45.03px ("10.0 m" together) | FIXED |
| DE, 112.8px column | de | **12.47px** (orphan "m" alone) | 45.03px ("10,0 m" together) | FIXED |
| EN, 112.8px column | en | 71.78px (already together) | 71.78px | unchanged (no defect there) |
| DE, 160px column | de | 45.03px (already together) | 45.03px | unchanged (no defect there) |

The 12.47px BASE line-box width is a positive control: it is exactly the
width of a single "m" glyph on its own line, confirming a real orphan
existed only in the two cells above and nowhere else, and that the nbsp fix
closes it there without introducing a new orphan anywhere else in the
matrix. `help.scrollWidth <= help.clientWidth` held in every cell, both
BASE and HEAD — the help paragraph itself never overflows its column.

---

## 6. The accepted residual: ~19.81px input offset at the 112.8px-column viewports

After the fix, at the 112.8px column (`phonePortrait`, `tabletLandscape`),
the safety-depth field's INPUT still sits **+19.81px** lower than the
departure field's own input, in both `en` and `de` — see the HEAD column of
§5's two-column table. The LABEL delta is 0 at every two-column viewport
(both column widths); only the residual on the input, and only at the
narrower 112.8px column, is left standing.

This is accepted, not closed: `align-items: start` fixes the label baseline
by construction (both labels now start their row from the same top edge),
but the help paragraph still occupies vertical space below the safety-depth
input that the departure field's input does not have a counterpart for, so
the two inputs cannot land on the same line by this fix alone. Closing it
would need either shrinking/hiding the help paragraph (option 3, rejected
in §4 for removing user-visible information) or a shared-track grid
(option 5, rejected in §4 as out of scope for this fix).

### The accepted failure direction

The sign of the residual is consistent across both languages and matches
the direction already present at BASE (a negative `inputDelta`, i.e.
safety-depth's input started HIGHER than departure's — moved to positive
19.81, i.e. now LOWER — rather than flipping to some unrelated direction).
The magnitude also shrank at every cell relative to BASE (§5's own
observation), including at 160px where the residual is now a mere +0.81
rather than the much larger -34.00. The accepted direction is: whatever
residual misalignment remains, it is smaller in magnitude than what shipped
before, it never trades the label mismatch for a WORSE input mismatch, and
it is confined to the narrower of the two two-column regimes rather than
appearing everywhere. No cell in the control table shows the fix making
either axis worse than BASE.

---

## 7. A separately-filed, pre-existing defect found during this measurement

While measuring #744, a German-only column-overflow defect on the same
safety-depth label was found and filed separately as **#762**, deliberately
NOT folded into #764: "#744's accepted fix (`align-items: start` + a
non-breaking space) does not touch label wrapping, and folding an
unmeasured second change into it would have made that PR's before/after
control table ambiguous." PR #764's own body confirms this defect is
identical in BASE and HEAD (`scrollWidth: 125` vs `clientWidth: 113` for
"Sicherheitstiefe (m)" at the 112.8px column, in both cases) — #764 touches
neither the label element nor its CSS. #762 is out of scope for this spike
and is not itself decided here; it is noted only because it surfaced from
the same measurement pass and because a reader of the control table above
should not mistake its absence from the fix for an oversight.

---

## 8. Status as of this writing

PR #764 (`fix/744-safety-depth-field-row` → `develop`) implemented the
decision in §4 and carries the control table in §5. It merged
2026-08-28T13:09:49Z (merge commit `f556149`), closing #744. The fix
shipped in the v0.16.0 release.
