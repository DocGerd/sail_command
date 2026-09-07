# Spike #1022 — the whole client journey, as a design exercise

- **Issue:** [#1022](https://github.com/DocGerd/sail_command/issues/1022) — "a
  deliberate UX revision, run as a design exercise… scoped to the entire
  client journey, not a checklist of individual screens or features." Open,
  milestone `v0.25.0`, `type: feature` / `priority: medium`.
- **Date:** 2026-09-07.
- **Status:** Decision / Recommendation. This document does not touch
  `app/src/**`, `CLAUDE.md`, or `docs/superpowers/specs/**` — every claim
  below is read-only evidence, and every proposed change is listed as a
  ranked, unfiled slice in §8, per the brief.
- **Method:** every claim about current behaviour cites a file (and, for
  code, a symbol or line) it was read from, or a screenshot taken this
  session against a real `npm run dev` build (Vite 8.2.2, `origin/develop`
  @ `c6b7cdd`) at `tabletLandscape` (1180×820, this issue's design floor per
  its own maintainer ruling), with `?windFixture=` for a deterministic wind
  field. Screenshots referenced below live beside this file under
  `docs/spikes/1022-whole-journey-ux/`. Where a claim could not be
  substantiated this way, it is not made.
- **Verdict, one paragraph:** the issue's own thesis holds up under
  measurement — every individual screen this session touched is internally
  competent, and the damage is genuinely in the seams. Two seams recur at
  almost every step and are worth fixing as their own slices rather than
  patching each site separately: (1) **there is no shared visual language for
  "this point is now selected/confirmed/safe,"** so four different journey
  steps (endpoint pick, via-point placement before a plan exists, tier-C rig
  suppression, and the depth-safety verdict) each fall back to text-only
  confirmation buried in a scrolling panel while the map stays visually
  neutral or, worse, shows an unrelated marker that a user could easily read
  as the missing confirmation; and (2) **the app's visual weight is spent in
  the wrong place** — a first-time, boat-less, plan-less user gets full
  hazard-hatch density and six live form controls on the very first screen,
  while `ShallowWarning` — the more severe of this app's two per-route depth
  disclosures — mounts only on relaxed routes and, even then, competes with
  a chip and a stale-notice for the same "top of card" space as a collapsed
  disclosure. Neither of
  these is a new discovery — #1020 already names (1) for one of its four
  paths, and CLAUDE.md's own #455/#612 entries already document (2)'s
  gating condition as an accepted-but-unclosed gap — but walking the journey
  end to end is what shows they are the SAME two problems recurring, not
  four or five independent ones.

> Companion evidence: `docs/spikes/1022-whole-journey-ux/*.jpg` (four
> screenshots, captured this session, referenced by number below).
> This spike does not redesign #1020 (in flight) or re-litigate #744
> (shipped) or the #298/#455/#612 depth-disclosure history (already
> recorded in CLAUDE.md) — it cites them where the journey view sharpens
> what to do about them.

---

## 0. What "the whole journey" means here, and what it doesn't

The issue asks for a design pass, not a bug hunt, and structures the walk as
twelve numbered stages. This document follows that numbering. Two scoping
decisions carried through the whole exercise:

- **Every finding below is either a screenshot from a real running build, or
  a file:line citation.** Three research passes (read-only, parallel) and one
  live browser session produced the raw evidence; this document is the
  synthesis, not a transcription of either.
- **Nothing here proposes reopening a settled ruling.** Dark mode stays
  chrome-only; the app makes no chart-authority claim anywhere in this
  review's recommendations; there is no proposal for a backend; the
  `>=820px` tablet floor governs every layout judgement below, and nothing
  here is scoped below it — the app already has a large, separately-tracked
  body of narrow-viewport (`<820px`) work that this review deliberately does
  not re-rank.

---

## 1. First arrival — cold load, nothing stored

**What a new user sees:** the full planner UI, immediately. `App.tsx`
renders `AppShell` unconditionally — map, header, banner area, the "Reise"
(Trip) card with GPX import / harbour search / map-pick / an **already
expanded** waypoint coordinate-entry form, departure + safety-depth fields,
and a disabled "Route planen" button — on every load, plan or no plan, boat
or no boat. There is no onboarding screen, no tour, no empty state. The only
concession to a first-time user is one gray line, `planner.onboarding`
("Pick a start and destination to plan a route."), and it competes for
attention with six other live controls on the same card (screenshot
`01-cold-load.jpg`).

**What a new user is told about what this app is and isn't:** nothing, on
this screen. The load-bearing disclaimer —
`'SailCommand is a passage-planning aid, not a navigation device. Chart data
is simplified; official charts and your plotter remain authoritative.'`
(`app.disclaimer`, `dict.en.ts`) — exists, and is worded exactly right, but
it renders only inside the `AboutDialog` modal, reachable by one extra click
on a small ⓘ icon in the header. Same for the offline-capability line
(`about.dataSize`) and the download-size note. A user who never opens the ⓘ
icon never sees any of it.

**What's visually loud instead:** the map. `Wassertiefen` (depth hatch) is
checked by default, so the very first pixel this app ever shows a new user
is dense amber/black hazard hatching across the whole visible chart —
before any boat is chosen, any point is picked, or any route exists. That's
not wrong (depth awareness is the product), but it means the app's loudest
visual statement on arrival is a warning about a route that doesn't exist
yet, while the one paragraph that would set real expectations (aid, not
authority) is one click away and silent by default.

**Finding:** the disclaimer and the offline promise are correctly worded but
wrongly placed — gated behind a click a new user has no reason to make, on a
screen that is otherwise not trying to orient them at all.

---

## 2. Installing / going offline

**What's proactive:** nothing. There is no in-app install prompt
(`beforeinstallprompt` is not handled anywhere in `app/src`), and the one
"offline ready" signal that exists — `pwa.offlineReady`, rendered by
`ReloadPrompt.tsx` as a transient toast — fires only AFTER the service
worker's precache install has already completed, i.e. after the promise has
already been kept, not before. Install instructions exist only in
`README.md`, outside the app.

**What's reactive:** a real one. `App.tsx` renders a `Banner` reading
`'Offline — planning disabled. Saved routes remain available.'` whenever the
browser's own `online`/`offline` events fire. This is honest and correctly
wired, but it is the ONLY offline-related signal a user encounters without
opening the About dialog, and it necessarily only appears once they are
already offline — never as reassurance beforehand.

**Finding:** the PWA promise this app is genuinely good at (§10's forecast
persistence, real offline planning of saved routes) is completely invisible
until either (a) the user goes looking in the About dialog, or (b) their
connection actually drops. For a boat about to lose signal, that's
backwards — the reassurance is needed BEFORE departure, not during it.

---

## 3. Choosing a boat, and the tier-C ★-suppression

**Screenshot `02-boat-picker.jpg`** (live, tablet-landscape, German UI):
`BoatPicker` shows each boat's draft, a `Chip` naming its polar tier
(`Zertifikat`/`Modelliert`/`Geschätzt`), and — for the two non-hull-verified
boats — a `keel.assumed` caveat plus the boat's own `draftProvenance.note`,
rendered **verbatim, in raw English prose**, inside the German UI, per the
spec-sanctioned exception documented in CLAUDE.md ("catalogue data … not an
i18n key"). That exception is deliberate and correct on its own terms —
but seen for the first time, in context, it reads exactly like the mixed-
language bug this repo has previously had to explicitly re-file as "not an
anomaly" (#607). The spec decision is right; the presentation gives no
visual cue that the switch to English prose is intentional rather than a
translation gap. A one-line `lang="en"` visual treatment (a small "source
note" label, or a hairline border distinguishing catalogue prose from app
copy) would cost nothing and remove the "is this broken" read without
touching the spec's substance.

**The ★-suppression itself:** for PIRANJA or SPEEDY GO!, the star and its
`route.fasterRig` chip are replaced in `RouteSummary` by a generic
`route.rigNotCompared` chip: *"The sails were not compared for this
passage, so no faster rig is claimed."* This is correct behaviour — the
suppression fires exactly when `comparisonSuppressed` is true
(`planRoute.ts`'s `assemble()`) — but the reason is never named to the user.
The actual explanation ("tier-C/estimated polars") exists only as a code
comment and, separately, inside each sail's collapsed catalogue note in the
Boat tab — two clicks and a different tab away from the chip that needs it.
A user who never visits Boat/Polardaten reads "not compared" with no
visible cause, and the issue's own framing (does the user "understand WHY
the recommendation … is simply absent") is answered here: no, not from the
results panel.

**Finding:** the suppression logic and its underlying reasons are both
correctly implemented and separately documented — they've just never been
connected to each other at the one place (`route.rigNotCompared`) a
PIRANJA/SPEEDY GO! user actually reads.

---

## 4. Setting origin and destination

Confirmed directly, in code and in a live screenshot: **there is no
origin/destination marker layer anywhere in this app.** `RouteLayer.tsx`
defines only route-line layers (gated behind `if (!plan) return null`);
`DataLayers.tsx`'s `sc-harbor-points` paints all 33 curated harbours with
one static, unconditional colour; a raw map-tap pick produces no map
artefact at all. The only confirmation any of the four paths (harbour
search, map-tap, GPX import, saved-waypoint reuse) gives is a text row in
the scrolling panel — a coloured dot glyph (`endpoint-pin`) that is
`aria-hidden` and, per its own code comment, was deliberately colour-matched
to nothing on the map because nothing on the map exists to match. This is
exactly issue #1020, independently reproduced this session
(screenshot `03-gybe-marker.jpg`, discussed below), and it is currently in
flight — this document does not redesign it, but §8 states what this
journey review implies for its fix shape.

**A fourth path that isn't one.** The brief lists "saved waypoints" as a
fourth origin/destination entry path. It is not: `SavedWaypoints.tsx`'s
`onSelect` always inserts a **via point** — the same nearest-point-on-chain
insertion #845's seamark-add action uses — and there is no UI path from a
saved waypoint to origin or destination at all. So the actual count is
**three** endpoint-setting paths (harbour search, map-tap, GPX) plus one
unrelated via-point-reuse mechanism that merely lives in the same panel.
That's worth stating precisely, because "four entry paths to one concept"
(the issue's own framing) undersells the real defect — the count is smaller,
but the THREE real paths still produce zero, zero, and zero map feedback
respectively, which is the sharper and more useful fact.

**The screenshot that makes this concrete.** Planning Flensburg→Marstal at
tablet-landscape produced a route whose start point renders a circled
letter marker that looks, at a glance, exactly like an endpoint pin
(`03-gybe-marker.jpg`). It is not one. `RouteLayer.tsx`'s own comment names
it: *"Maneuver letter labels are language-dependent: W/H (de), T/G (en)"* —
the German abbreviation for a gybe is "H" (Halse), and this route happens to
gybe immediately at departure. A user glancing at this map has no way to
tell a coincidental gybe marker from a deliberate origin marker, because the
app has never drawn the latter to compare it against. This is not a second
bug — it's the SAME bug (#1020) demonstrating, in a real screenshot, exactly
the ambiguity its own "worth deciding as part of the fix" section predicts:
*"Origin and destination need to be distinguishable from each other, and
from via-points, which already have their own marker style."* A maneuver
marker is a third thing this needs to be distinguishable from, that
#1020's text doesn't yet name.

---

## 5. Waypoints — add / edit / cancel / drag / save / reuse, and coordinate entry

The interaction model itself (map-tap add, coordinate-form add/edit sharing
one form via a `viaCoordMode` switch, per-row reorder/remove, map-marker
drag with snap-back on rejection) is coherent and already correctly
described by the recently-shipped #886 sub-asks — the add/edit mode label
and the visible hemisphere hint both render and are tested.

**Two things #886 already knows are missing, confirmed independently by this
review, not proposed fresh here:** (1) the hemisphere letter is *displayed*
but cannot be *typed* — the field is a bare `<input type="number">`, which
the WHATWG spec makes structurally incapable of accepting `N`/`S`/`E`/`W`
characters at all; and (2) the lat/lon/name trio is linked only by
`aria-describedby` on each field individually, with no `fieldset`/
`aria-labelledby` naming the group as "New waypoint" vs "Editing waypoint
N" (`planner.via.coord.modeAdd`/`.modeUpdate`) — so
a screen-reader user tabbing in hears the hemisphere but never which
waypoint is about to be overwritten. Both are #886's own residual 1 and 2,
rescoped 2026-09-07, with acceptance criteria already correctly scoped. This
review's independent read of `PlannerPanel.tsx` reaches the identical
conclusion from the code side; no new issue is proposed for either — #886
already covers it and should not be duplicated.

**Genuinely new observation from walking the *whole card*, not just the
form:** the coordinate-entry form (`Neuer Wegpunkt` / "New waypoint") is
**always visible and pre-filled** with the data-area midpoint (54.8, 10.2),
even before any via point exists and even for a user who will never add one.
On the cold-load screenshot (`01-cold-load.jpg`) it is the single largest
element in the Trip card, competing directly with the actual first decision
(pick a start) for visual weight. Every other secondary surface in this
panel — saved waypoints, GPX errors, the depth-comfort link — is already a
`Disclosure` or collapsed by default; this one form is not, for no
stated reason found in the code.

**DMS/DDM input (#1005, Backlog, correctly deferred):** confirmed the app
gives **zero UI signal** that only decimal degrees are accepted. There is no
"decimal degrees only" hint anywhere near the field; a user typing `54°30'N`
simply finds most of those characters refused by the browser's own
number-input filtering, with no explanation offered. #1005's own full DMS
support is correctly scoped as its own design pass — but a one-line hint
naming the accepted format is a much smaller, immediately shippable
mitigation that doesn't need to wait for it (see §8).

**Bulk-abandon (#938, Backlog):** confirmed absent by code, exactly as
filed — no clear-all control exists anywhere in the via-point UI.

---

## 6. Departure and safety depth

Both fields are correctly range-validated (`Erlaubter Bereich: 2,2–10,0 m`)
but carry **zero "why this matters" framing**. The departure field has no
help text at all; the safety-depth field's help is purely numeric. Nothing
near either field tells a user that departure time selects the forecast
window, or that safety depth decides which routes exist at all — both true,
consequential, and currently invisible facts about this pair of ordinary-
looking form fields. (The already-fixed layout defect in this exact row,
per `docs/spikes/744-safety-depth-field-row.md`, is not re-litigated here —
this is a framing gap, not a geometry one, and it survived that fix
untouched.)

---

## 7. Solving

This stage is already well-designed and needed no changes recommended. The
phase readout (`Route wird berechnet… Segel N von 2 (…)`, live-region,
`role="status"`) is honest about what's happening and is a documented,
deliberate design decision (CLAUDE.md's #340 rule: phase-based, never a
percentage, because there is genuinely no reliable ETA to show). The one
visual accompaniment, a decorative result-shaped skeleton, is correctly
`aria-hidden` and doesn't pretend to be a progress bar. No finding here.

---

## 8. Reading the result — the disclosure hierarchy

**This is the sharpest finding in the whole walk, and it is a safety
finding, not a cosmetic one.** Screenshot `04-disclosure-hierarchy.jpg`,
captured live for the Flensburg→Marstal case CLAUDE.md's own
`realmask.repro.*` suite already exercises, shows the actual rendered
hierarchy: a "Schneller: Genua" chip, a stale-input notice, THEN the
`ShallowWarning` banner (bold, red-bordered, background-washed,
`role="alert"`, but rendered as a collapsed `▸`-disclosure with only its
lead sentence visible), and only below all three of those does the
ETA/Duration/Distance/Speed stat grid appear — in plain, uncoloured,
unbordered text.

That hierarchy is right when the banner fires. `RouteSummary.tsx` mounts
`ShallowWarning` only when `plan.result.shallow` is set, which — confirmed
by grep against `planRoute.ts:713`'s unchanged `if (relaxed !== null)`
gate — is true only for RELAXED routes. That much is exactly the gap
CLAUDE.md's own Domain Rules section documents under #455/#612: *"the
banner, the cautious chip and the exposure sentence… render for NO ordinary
route, while ~10,746 gate-crossing cells produce no per-route signal…
#612 did NOT close this."* This review's first draft quoted that sentence
and stopped there — which was its own version of the mistake it goes on to
name: the CLAUDE.md bullet's very next clause names the mechanism that
DOES close part of the gap for the majority of cases, and quoting only up
to "did NOT close this" reproduced the omission rather than reporting it.

**The correction, read from `RouteSummary.tsx:97` directly, not from
memory:** for a non-relaxed route, `RouteSummary` also renders
`MarginalDepthNotice` whenever the mask-derived exposure past the safety
gate is greater than zero (`exposureDist !== null`) — the #612 fix, gated
(per its own comment) as the EXACT COMPLEMENT of `ShallowWarning`'s
condition, "provably never both shown and never both hidden." Its own
JSDoc carries a measured trip rate on non-relaxed plans: **61.5% on shipped
defaults (`breeze`, 16/26), 82.1% pooled (55/67)**. So for the MAJORITY of
ordinary, non-relaxed plans, this card already renders a real, quiet,
per-route depth signal — this review's original claim that "the absence of
a red banner is currently the only signal" was empirically backwards for
that majority, and naming only `ShallowWarning` here understated what #612
shipped.

**What survives, correctly scoped:** `MarginalDepthNotice` is a caution,
never a reassurance — it fires only when there IS exposure to report and
renders nothing (not an empty container, not a "0.0 nm" sentence) when
exposure is exactly zero, by explicit design ("a zero renders NOTHING at
all… which would be a notice about the absence of the thing it is a notice
about"). So the real, narrower gap is this: for the MINORITY of plans with
genuinely zero shallow exposure, there is still no positive "no charted
shallow water flagged on this route" statement anywhere in the card — a
user answers "is this route fine?" only by checking that NEITHER
disclosure fired, never by reading an affirmative one. Per this repo's own
"guard the rendering, not the data" lesson, that residual absence-as-signal
is still real; it is just the minority case, not the majority one this
review first described.

Three further hierarchy problems, all smaller, all real:

- **The banner competes with a chip and a stale-notice for the same visual
  slot** — three different messages, three different severities, one
  location, no visual separation beyond source order.
- **The banner's own headline is a collapsed disclosure.** The lead
  sentence is visible without a click (good — this was the deliberate #747
  fix), but the map's own per-cell hazard hatch, which covers the same
  population at higher resolution, requires switching mental context
  entirely (map vs. panel) to cross-check.
- **Even the legs-table per-leg shallow chips are behind a second, separate
  collapsed disclosure** ("N Etappen"), so the finest-grained safety signal
  this app has is the hardest one to reach.

---

## 9. Reading the chart

Layer density is genuinely high (route lines split by rig/propulsion,
maneuver markers, ETA/speed labels, wind barbs, an alt-rig overlay, depth
hatch, seamarks, harbours, scale bar, compass), but — confirmed against
`app.css`'s own declared z-tier system and `DataLayers.tsx`'s and
`RouteLayer.tsx`'s control markup — it is NOT all always-visible. Two
`<details>` disclosures (`route-layer-controls-disclosure` for the
barb/annotation/alt-rig toggles, and a `depth-legend`/`route-legend` pair
that swap depending on plan state) already collapse most of the optional
surface; only the depth/seamark checkboxes and the compass/scale-bar chrome
stay permanently visible. This stage's design is already reasonably
disciplined and is not where this review's findings concentrate — the map
is dense because the domain is dense, not because nobody organised it.

---

## 10. Saving, reloading, recalculating

`PlansList` shows absolute, correctly-formatted timestamps
(created/departure/ETA) for every saved plan — there is no vague "3 days
ago" phrasing, which is the right call for a planning aid (a passage plan's
departure time is a fact, not a relative distance from now). The one gap:
`isStaleForecast` compares the plan's OWN departure time against its OWN
forecast-fetch time, both frozen at save time — so a plan reloaded a month
later shows the identical "stale forecast" status it had the day it was
created. There is genuinely no UI signal for "this forecast is now old
relative to TODAY," only "this forecast was old relative to the departure
it was planned for." For a tool whose entire safety case rests on wind data
being current, that's a real gap, though a narrow and cheap one to close
(a plain "planned N days ago — replan for current conditions?" prompt keyed
off `createdAtMs` vs. `Date.now()` at render time, not a new stored field).

---

## 11. Comparing departures

`DepartureCompare` is well-designed and needed no changes recommended: a
chronological, ranked, badge-annotated list, an explicit "Confirm" action
per candidate that re-solves with the real two-rig plan (never trusting the
cheaper genoa-only scan as final), and an honest disagreement notice if the
two-rig confirm disagrees with the scan's own ranking. No finding here.

---

## 12. On the water — the Live tab

`LiveView`'s own controls (tracking toggle, GPS-hint dismiss, reroute
button) meet the app's global `min-height: 44px` / `min-width: 44px`
"cockpit-use, boat-glove-friendly" button rule by construction, since they
render through the shared `Button` primitive rather than a local override.
That's the opposite finding from #860's already-measured MAP-GLYPH taps
(18–26px) — the gap there is glyphs, not this tab's own controls, and this
review found nothing to add for Live-view control sizing specifically.
What IS worth naming: `LiveView.tsx` defines no distinct high-contrast or
larger-text treatment of its own — its readouts (HTS value, COG/SOG, next
event, ETA/drift) inherit the same body-copy sizing as the planning UI, for
a screen whose entire premise (per the issue's own step 12 framing:
"narrow viewport, one hand, gloves, daylight") is the app's least
desk-like context. No specific defect is claimed here beyond that
observation — it's flagged as a candidate for a future, dedicated
Live-tab typography pass, not sized or ranked as a slice in §8, because
this review did not measure glare/daylight contrast and would be
fabricating a claim it can't support if it tried.

---

## Considered and rejected

**A permanent overview mini-map (#297).** Rejected as an answer to this
review's findings, though #297 remains open on its own separate merits.
The disorientation this journey walk actually found (§4's "what's
selected?", §8's "is this safe?") is a MARKER-LANGUAGE and HIERARCHY
problem, not #297's own stated problem ("I lose track of where I am when
zoomed in") — #297's own filing already raises this exact caution
("challenge whether this is the right instrument") for that different
symptom, and
this review's findings don't add a second reason to build it. A mini-map
would introduce a fourth surface (after panel text, the main map, and the
results card) that would ALSO need to agree with the shared endpoint-marker
language recommended in §8 — adding a place for the inconsistency to
recur, not removing one. If #1020's marker fix and the results-hierarchy
fix ship and users still report losing context while zoomed in, #297
should be re-measured on its own terms at that point, not folded into this
recommendation now.

**Widening the raw `ShallowWarning` mount condition to fire on false
positives "just to be safe," or folding `MarginalDepthNotice` into it.**
Rejected as imprecise. The fix recommended in slice 2 is not "show the
banner more often" or "merge the two disclosures" — it's "add the one
affirmative state this card is still missing, for the narrower minority of
non-relaxed plans where NEITHER existing disclosure fires," leaving both
existing mount conditions untouched. No new depth computation, no new
`PlanResult` field, and critically no `app/sweep/` baseline change — this
keeps the #493/#612 "presentation-only" property intact, and preserves the
#612 exact-complement relationship between `ShallowWarning` and
`MarginalDepthNotice` rather than adding a third message that would compete
with them. A blanket "always show the banner" would either desensitise it
(if it always fires) or require a new severity threshold invented for this
review alone, neither of which is warranted when the data to do it
precisely already exists.

**A first-run interactive tour/wizard.** Considered for §1 and rejected as
disproportionate. The issue itself asks for reachable honesty ("does the
first screen carry that honestly"), not a guided walkthrough — a
dismissible, one-time banner plus collapsing the always-expanded waypoint
form (§8's slices 3–4) delivers the same orientation at a fraction of the
implementation and maintenance cost, and doesn't add a new UI pattern this
app has never needed before.

**Renaming or restructuring the tab set (Planen/Routen/Live/Boot).**
Considered because §3 found that boat choice — which gates both the depth
gate and the ★ comparison — happens on a separate tab a user can skip
entirely before planning. Rejected as out of scope for this pass: the tab
structure itself works, and the fix that actually matters (§8/4, naming the
tier-C reason where the chip already renders) closes the specific harm
(silent, unexplained suppression) without moving any tab or forcing boat
selection earlier in the flow, which would be a larger and separately-
reviewable change.

---

## Ranked implementation slices

Each is scoped to be one issue. Not filed here — filing is the
orchestrator's job per the brief.

1. **Shared endpoint/via marker component, applied to all three real
   entry paths (harbour search, map-tap, GPX) plus selected-harbour
   highlighting.** Directly closes #1020's root cause rather than its
   narrower "map-tap only" framing — see §13 below for exactly what this
   implies for that in-flight PR. Highest priority: it's a correctness gap
   in the core planning loop, not a polish item.
2. **Add the one AFFIRMATIVE state this card is missing** — a positive "no
   charted shallow water flagged on this route" statement for the specific,
   narrower case §8 corrects this review's own earlier claim down to:
   non-relaxed plans where NEITHER `ShallowWarning` nor `MarginalDepthNotice`
   fires (zero mask-derived exposure). This must be a THIRD, mutually
   exclusive state gated on the same two conditions those two already use
   (`relaxed`/`exposureDist`) being both false/null — never a fourth message
   rendered alongside either existing one, and never a change to when
   `ShallowWarning` or `MarginalDepthNotice` themselves mount, which would
   break the #612 "provably never both shown and never both hidden"
   property CLAUDE.md records for that pair. Presentation-only, no
   `PlanResult`/sweep-baseline change. Highest priority: this is the
   safety-hierarchy gap named in §8, already documented as open in
   CLAUDE.md's #455/#612 history.
3. **Collapse the always-expanded waypoint coordinate-entry form on the
   Trip card behind the same `Disclosure` pattern used elsewhere in this
   panel**, and surface the `app.disclaimer` + offline-capability lines as
   a small, dismissible, once-only banner on first arrival rather than only
   inside the About dialog. Two related but independently shippable UI
   changes; grouped because both are §1/§5 cold-load decluttering.
4. **Name the tier-C reason in `route.rigNotCompared`'s own copy** (reuse
   the existing catalogue-note wording through `t()` rather than inventing
   new prose). Small, high-value for two of the fleet's three boats.
5. **One-line "decimal degrees only" hint near the via-coordinate fields**,
   distinct from and not blocking #1005's full DMS/DDM support — closes the
   "silently rejected" read named in §5 immediately.
6. **One sentence of context above the departure/safety-depth compact
   row** ("Departure time picks the forecast; safety depth decides which
   water counts as too shallow" or equivalent, i18n'd), per §6.
7. **A visual "source note" treatment for the raw-English catalogue prose**
   in `BoatPicker`, per §3 — cheap, keeps the #607-settled spec exception,
   removes the "looks like broken i18n" read.
8. **Reloaded-plan currency prompt** — a render-time (not stored) comparison
   of `createdAtMs` against `Date.now()`, offering a replan when a saved
   plan is old relative to today, per §10.
9. **Bulk "remove all waypoints" action (#938)** — sequence this AFTER
   slice 1, since a shared marker component changes what "remove all" needs
   to clean up on the map.
10. **Name-aware via-point dedupe (#939)** — this review's independent read
    of §5's waypoint model agrees with the premise #939 itself records,
    verbatim: *"a name is a stronger, user-assigned identity signal."*
    #939 has not decided among its own three listed options; this finding
    supports its option 3 (skip dedup when the two points carry different
    non-empty names) without deciding that for #939.

Not a slice: **#886's own residuals (hemisphere-letter entry, coordinate-
group a11y naming)** are already correctly scoped by that issue and are not
duplicated here — this review's independent read of the code reaches the
same two gaps and confirms #886's acceptance criteria are aimed at the
right thing.

---

## 13. What this implies for #1020 specifically

Not a redesign — #1020 is in flight and may merge before this lands. But
this journey walk found two things worth relaying to whoever implements it:

- **The fix should be a single marker COMPONENT reused by all three real
  entry paths**, not a map-tap-specific patch. #1020's own "worth deciding"
  section already gestures at this ("whatever renders a map-picked
  endpoint should probably also distinguish a selected harbour"); §4/§5 of
  this review confirm harbour search and GPX import have exactly the same
  gap, for the exact same underlying reason (no endpoint layer exists at
  all), and the "four paths" framing over-counts by one (saved waypoints
  is via-only, never an endpoint path).
- **The new marker needs to be visually distinguishable from a maneuver
  marker, not just from a via-point marker.** §4's screenshot
  (`03-gybe-marker.jpg`) is a real, reproduced case of a gybe-letter marker
  sitting close enough to the origin point to read, at a glance, as
  plausibly the missing endpoint marker — #1020's text names via-points as
  the marker style to differentiate from; maneuver markers are a second,
  independently-confirmed collision risk worth adding to that same design
  decision before implementation, not after.

---

## Screenshot index

- `01-cold-load.jpg` — cold load, tablet-landscape, German UI: full planner
  form visible before any boat/plan exists, hazard hatch on by default.
- `02-boat-picker.jpg` — Boat tab: tier chips plus raw-English catalogue
  prose for the two non-hull-verified boats.
- `03-gybe-marker.jpg` — cropped zoom on the Flensburg endpoint of a real
  planned route: a gybe-maneuver "H" marker sitting where a user would
  expect (and currently gets no) origin marker.
- `04-disclosure-hierarchy.jpg` — the results panel for the same route,
  scrolled to the "Ergebnis" card: rig chip, stale notice, collapsed
  `ShallowWarning` banner, THEN the plain ETA/Duration/Distance/Speed grid.
