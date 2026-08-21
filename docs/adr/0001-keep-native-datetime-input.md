# ADR-0001: Keep the native `datetime-local` input for departure entry

## Status

Accepted — 2026-08-20.

## Context

SailCommand has two date/time inputs, both plain native
`<input type="datetime-local">` with no wrapping library or custom
segmented-field implementation: `#planner-departure` in
`app/src/components/PlannerPanel.tsx`, and the per-plan recalculate editor
input in `app/src/components/PlansList.tsx`. No `type="date"`, `type="time"`,
`type="month"` or `type="week"` input exists anywhere in the app. Both inputs
are `onChange`-only — a grep for `onKeyDown`, `onWheel`, `onInput`, `onBlur`
and `addEventListener` across both files returns zero lines — and both
handlers are a single guarded parse of the browser's own complete value
string (`if (!e.target.value) return; onDepartureChange(new
Date(e.target.value).getTime());`). There is no per-segment logic and no
arithmetic anywhere in this app's code.

Issue #642 reported a minute→hour carry when stepping the departure field,
and the original report described this alongside a suspected hour→day carry.
Investigation this session found:

- **The hour→day carry does not exist**, and the reporter has confirmed
  this. Measured directly in Chromium 151.0.7922.34: hour `00:30` +
  ArrowDown → `23:30` with the date unchanged; minute `09:59` + ArrowUp →
  `09:00` with the hour unchanged; day `Aug 31` + ArrowUp → `Aug 01` with the
  month unchanged. The mouse wheel does not step the control at all in that
  build.
- The reporter's surface is **Edge on Android**, where Chromium does not use
  the inline segmented field at all: `InputDialogContainer.java` maps
  `TextInputType.DATE_TIME_LOCAL` to a `DateTimePickerDialog` holding an
  independent `android.widget.DatePicker` and `android.widget.TimePicker`,
  read via separate `getYear()/getMonth()/getDayOfMonth()` and
  `getHour()/getMinute()` calls. An hour→date carry is **structurally
  impossible** on that surface — the two widgets don't share state.
- The remaining minute→hour carry is **the Android platform's own
  behaviour**, not anything this app or Chromium's page-rendered control
  introduces. AOSP's `TimePickerSpinnerDelegate` carries explicitly in its
  minute-value listener (`if (oldVal == maxValue && newVal == minValue) { int
  newHour = mHourSpinner.getValue() + 1; … }`, and the symmetric case going
  down), and it applies here because Chromium's
  `date_time_picker_dialog.xml` sets `android:timePickerMode="spinner"`. This
  is the same carry every other spinner-style time control on that device
  exhibits.
- The HTML Living Standard is **silent** on per-segment carry for
  `datetime-local` — the words *carry*, *rollover* and *segment* do not
  appear on its spec page. The only stepping behaviour the standard defines
  is `stepUp()`/`stepDown()`, which operates on the whole value and crosses
  midnight by construction. Per-segment carry (or its absence) is entirely
  implementation-defined, browser by browser and platform by platform.
- **Decisive constraint for any interception-based fix:** on a
  `datetime-local` input, `input.shadowRoot` is `null` and
  `input.selectionStart` is `null`. Page JavaScript has no handle on which
  segment currently has focus, so a `keydown` handler cannot tell whether an
  ArrowUp hit the Hours segment or the Minutes segment.
- A separately reported rendering issue — the departure display showing as
  `08/20/2026, 09:00 PM` (en-US, 12-hour) — was observed only in the headless
  test environment, where the browser locale could not be forced, and did
  **not** reproduce on the reporter's real device, which renders correctly
  localised. Native date/time inputs take their format from the browser/OS
  locale rather than the page's `lang`, which is correct behaviour for this
  control. This is recorded here as a non-issue so it is not re-filed.

## Decision

SailCommand keeps the native `<input type="datetime-local">` for departure
entry, in both `PlannerPanel.tsx` and `PlansList.tsx`. The minute→hour carry
reported in #642 is accepted as-is, and #642 is resolved **won't fix**.

## Consequences

**Accepted:** the minute→hour carry on the Android spinner control persists
for users on that surface. This is not purely a cost — it makes the field
behave identically to every other time input on that device, which was the
reporter's own stated baseline for what "correct" looks like.

**Kept for free by staying native**, none of which SailCommand has to build
or maintain itself: keyboard interaction, screen-reader and spinbutton ARIA
semantics with roving focus, platform locale and date ordering, the Android
platform picker dialog, `min`/`max` clamping, DST-invalid and
DST-ambiguous local-time handling (this app pins `Europe/Berlin` at the
2026-10-25 fold in `PlannerPanel.dst.test.tsx`), digit typeahead, and paste.

**Not resolved by this decision, and explicitly still open:** **#643** —
stepping the month segment to a nonexistent date (for example, landing on
September 31) blanks the field's value, and the shared handler's
`if (!e.target.value) return;` guard then silently swallows that blank,
leaving a stale `departureMs` behind a visibly empty required input. Keeping
the native control does not oblige keeping that specific guard's behaviour;
#643 is unaffected by this ADR and remains open.

## Considered and rejected

**(a) Keep the native input and intercept keys/wheel to prevent the carry.**
Rejected as measured-infeasible: `shadowRoot === null` and
`selectionStart === null` on this input, so there is no way for page code to
know which segment is being edited when a key event arrives. There is also
nothing to intercept for the wheel, since it does not step the control in
the tested build. The only workable variant would be a post-hoc `input`-event
diff that detects a carry pattern and rewrites the value after the fact —
heuristic, liable to fight legitimate date edits, and would land after
assistive technology has already announced the (momentarily) wrong value.

**(b) Build a custom segmented date/time picker on the `--sc-*` primitive
layer.** Rejected on cost and risk: it would mean re-owning segment order,
12/24-hour formatting, digit typeahead, paste handling, AM/PM, `min`/`max`
clamping, DST-invalid and DST-ambiguous time handling, mobile `inputmode`,
and the full spinbutton ARIA contract that the browser currently provides
for free — and it would lose the native Android platform dialog entirely,
which is the worst thing to give up on a phone, on deck.

**(c) Split into separate `<input type="date">` and `<input type="time">`
fields.** The strongest alternative considered, and rejected only because
the defect it would structurally fix — an hour→date carry — **does not
exist**. It would not address the minute→hour carry #642 actually reports,
and it would coarsen the `min`/`max` guardrail from a single moment down to
day granularity. If this decision is ever revisited, this is the obvious
first candidate to re-evaluate.

## Revisiting this

Reopen this decision if any of the following become true: a genuine
hour→date (or coarser) carry is measured on a real user surface, not merely
suspected from a report; a browser/platform combination is found where the
carry crosses a date boundary rather than staying within the time; or a
custom date/time picker is being built for some unrelated product reason —
at which point the marginal cost of adding correct per-segment semantics to
that picker drops sharply and option (b) above should be re-costed.
