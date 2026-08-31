# SailCommand — manual acceptance runbook

This is the project's manual acceptance gate (design spec §5 ("Testing"),
Manual acceptance item). Automated CI (unit + property tests, Playwright E2E) covers
correctness in isolation; this runbook exercises the whole system — a real
wind forecast, a real deployed build, a real phone — the way a sailor
actually would.

Run this once against the live deployment after each phase gate that touches
routing, rig comparison, motor legs, or the PWA/offline path, and again
before any release considered "done." Two people are enough: one on a
desktop/laptop for the routing checks, one on an Android phone for the PWA
checks (or one person doing both in sequence).

**Live app:** https://docgerd.github.io/sail_command/

For a pre-release acceptance pass, this runbook can instead be run against
the UAT preview (https://docgerd.github.io/sail_command/uat/), which serves
the current `develop` state. It is not the productive version and may break
at any time — use the live app above for the pre-release "done" gate once
UAT looks clean.

For every checkbox, record a result — don't leave it blank. If a check
fails or looks wrong, don't silently work around it: file a GitHub issue
against DocGerd/sail_command describing the deviation, link it in the
results table at the bottom, and note it in the box below the check.

---

## 1. Setup

- [ ] Open the live app in a normal (non-airplane-mode) browser session.
- [ ] Confirm the wind forecast is current: plan any route for a near-term
      departure (e.g. the next full hour) and confirm the stale-forecast
      notice (§2.8) does NOT appear — if it does, stop and re-check
      network/API status before continuing. The app shows no "fetched at"
      timestamp anywhere; the notice's own hour count (§2.8) is the only
      fetch-to-departure figure it ever prints.
- [ ] **Boat selection.** Open the **Boat** tab → "Boat selection" and confirm the
      catalogue offers all three boats — Salona 45, Salona 44 (SPEEDY GO!),
      Elan Impression 444 (PIRANJA) — each showing its draft (2.1 / 2.1 /
      1.9 m: the first two genuinely share a draft, it is not a duplicated
      entry) and a "Polar data & provenance" disclosure whose tier chip reads
      Certificate or Modelled for the Salona 45 and Estimated for both fleet
      boats. Every boat — the Salona 45 included — also shows a note saying
      where its stated draft comes from, set off by its own left border;
      only the two fleet boats carry the assumed-keel caveat above it, and
      on those two the border is what keeps the two notes from reading as
      one run-on paragraph (#701). Pick the boat for this run and record it
      in §5.
- [ ] **At least one fleet boat is exercised.** Run §2 or §3 under SPEEDY GO!
      or PIRANJA, so the suppressed rig comparison in §2.5 is actually
      reached; a pass made entirely on the Salona 45 never exercises it.
- [ ] **Depth-hatch legend.** On the map, below the "Water depths" /
      "Seamarks" toggles and the compass, open the collapsed **Legend**
      disclosure and confirm it explains the cautious-reading hatch and
      states that unsurveyed/drying water carries no hatching (#598/#597).
      In short landscape, and in any narrow layout with too little height
      left below the compass, the legend is deliberately not rendered at
      all — by design, not a missing control.
- [ ] **Cable/pipeline seamarks visible at Standard.** Turn the **Seamarks**
      map overlay on — it is OFF by default, unlike "Water depths" — and
      leave the Seamarks display-tier control at its default "Standard"
      setting (not "All"). Zoom to about z12 or closer on a stretch of coast
      known to carry submarine cable or pipeline marks (e.g. the Flensburg
      Fjord approaches); they render at Standard,
      not only at "All" (#521).
- [ ] **"Display options" collapses the overlay cluster.** The route-overlay
      toggles, forecast-time slider, and route legend now live behind one
      "Display options" control instead of always covering part of the
      chart. On a narrow/mobile-width screen it starts collapsed; on a wide
      screen it starts open. Toggling the control shows/hides the whole
      cluster together (#628).

## 2. Route A — Flensburg → Marstal

Plan a route from a Flensburg-area harbor to Marstal with a departure time
within the next 6-day forecast horizon (e.g. next full hour), using the boat
selected in §1.

- [ ] **2.1 Route stays in water.** The plotted route never crosses land and
      never visibly cuts a corner that would ground the boat.
- [ ] **2.2 Rounds Holnis sanely.** No leg passes over the Holnis peninsula;
      the route rounds it with a plausible offing, not hugging the shore
      inside the mask's resolution.
- [ ] **2.3 Rounds Broager Land / Kegnæs sanely (if the route passes them).**
      Same check as 2.2 for these headlands on the way south/east.
- [ ] **2.4 Tack pattern is plausible.** Where the leg is upwind, the number
      of tacks is bounded and sensible for the distance/angle (not a
      zig-zag spam of many short tacks).
- [ ] **2.5 Both sails shown with their own ETAs, and the rig verdict matches
      the boat's polar tier.** Both of the boat's sails appear as tabs
      ("Genoa" / "Fock"), each with its own ETA. Which verdict sits below them
      depends on the selected boat, and every outcome listed here is correct
      behaviour — record it as a PASS:

  - **Salona 45** — its sails are tier Certificate and Modelled, so the
    comparison runs: the ★ "Recommended" marker is on the tab with the earlier
    ETA and the chip reads "Faster: …". No ★ is shown when the two ETAs fall
    within 60 s ("… effectively tied …") or the passage runs entirely under
    engine ("Rig does not matter here …").
  - **SPEEDY GO! or PIRANJA** — both their sails are tier Estimated, so the
    comparison is withheld: **no ★ on either tab**, and the chip reads "The
    sails were not compared for this passage, so no faster rig is claimed". A
    missing ★ on these two boats is the designed outcome, not a defect — their
    two tables differ by the Salona 45's overlay ramp, which carries no
    information about the hull.
  - **Any boat, if the chip reads "The search ran out of time before
    comparing both sails, so no faster rig is claimed"** — the plan's search
    hit its wall-clock budget before both sails finished. No ★ is shown, and
    one sail tab may carry a no-route reason instead of an ETA. Correct
    behaviour (#540) — record the route and departure in §5 and pass.
- [ ] **2.6 Motor legs (if any) are gray-dashed and listed.** If sailing
      speed would be too low anywhere on the route, that leg is rendered
      dashed/gray on the map and appears explicitly as a motor leg in the
      leg list (expand the collapsed "Legs (…)" disclosure; the "Type"
      column names it) — not silently folded into a sailing leg.
- [ ] **2.7 ETA is plausible.** Average speed over the whole route works out
      to roughly 5–7 kn (sanity check: distance ÷ (ETA − departure); wildly
      outside this range for a normal wind day warrants investigation, not
      an automatic fail — note the wind conditions if it's an outlier).
- [ ] **2.8 Stale-forecast notice.** Re-plan (or edit) the same route with a
      departure time more than 12 hours after the forecast was fetched;
      confirm the stale-forecast notice appears both as a banner at the top
      of the app and as a coloured, left-bordered line on the route summary
      (#703). It is a short label naming the real fetch-to-departure gap in
      whole hours — "Forecast 14 h old at departure" — no longer a full
      sentence and no longer the static "> 12 h" threshold label, so check
      the number tracks the departure you chose (#748). It is rounded to
      whole hours, so a departure only just past the threshold legitimately
      reads "12 h": that is a PASS, not a stuck label.
- [ ] **2.9 Depth hazard hatching is expected, not a rendering fault.** With
      the water-depths overlay on (it is on by default), water whose
      cautious, worst-case reading falls below your safety depth is drawn
      with sparse hatching over the depth colors — including water the
      absolute depth colors alone show as clear. This is correct behaviour
      (#492); do not file it as an artifact. Two further expected effects:
      the stripes can change width when you cross a whole zoom level — only
      some crossings change them — repainting roughly a third of a second
      after the gesture settles (#599), and unsurveyed or drying water
      carries **no** hatching and no other cue at all, so absence of
      hatching is never a "the water is clear" signal (#597).
- [ ] **2.10 Marginal-depth line on a route that did NOT relax.** If the
      results panel shows "… of this route crosses water that a more
      cautious reading of the charted depth data puts below your safety
      depth of … m", that is the new #612 disclosure for an ordinary route —
      correct behaviour, not a sign the router ignored your setting. It
      tripped on 61.5 % of non-relaxed plans at shipped defaults in the #455
      measurement. It never appears together with the relaxed-route shallow
      banner. If you lower the safety depth below the boat's own default
      gate (draft + 0.9 m: 3.0 m for either Salona, 2.8 m for the Elan) and
      re-plan, the same line renders in a stronger, assertive form — it
      opens with "Caution:" and closes with "— at this setting that reading
      can fall below this boat's … m draft". Also correct behaviour, and
      not reachable at default settings.
      Route A commonly relaxes at default settings, so expect the
      banner there and the plain (non-"Caution:") marginal-depth line more
      often on route B; that line's absence is fine either way.
- [ ] **2.11 Depth profile is pinned to the plan.** Note the profile's
      "Safety depth" line, then change the safety depth on the Boat tab. The
      line must NOT move: the chart reads the depth the open plan was
      requested at, not the current setting (#551). It moves only after a
      re-plan.
- [ ] **2.12 Per-leg cautious marker doesn't require a relaxed route.**
      Independent of whether this route relaxed (§2.10): once the map has
      finished loading, expand the collapsed "Legs (…)" disclosure. Its
      FIRST column is now "Shallow" — #698 moved it there from last of ten,
      where it sat off-screen behind the table's horizontal scroll at phone
      width. Any leg whose cautious depth reading falls below your safety
      depth shows a "Shallow …" or "Marginal …" chip with a "cautious: as
      low as … m" sub-chip stacked directly BENEATH it, not beside it —
      #698 stacks the pair vertically so the populated cell fits inside the
      table on a phone. The map's shallow-water highlight (the wide casing
      under the route line) covers that same leg — that highlight and the
      leg's "Shallow …"/"Marginal …" chip both now appear on an ordinary,
      non-relaxed route too, not only inside a route the relaxation banner
      already flagged (#651). Whenever the panel is too
      narrow for all ten columns — the default width on a laptop — the
      table still scrolls sideways by design, and a soft shadow at its
      left/right edge marks that there is more to scroll in that direction.
      Both the scroll and the shadow disappear once the table fits (a very
      wide screen, or a panel dragged out); that is the same design, not a
      different one (#698), and neither state is a rendering fault.
- [ ] **2.13 Shallow-water warning keeps the hazard, collapses the
      explanation.** On a route that relaxed (Route A commonly does at
      default settings — §2.10), the warning shows these WITHOUT any
      interaction: the cautious-floor sentence, "Planned at a safety depth
      of … m", and the exposure distance when one is measured. The "what
      happened" explanation — why the router lowered the gate, where the
      shallow legs are, and the advice to lower the setting yourself — now
      sits behind a disclosure you open (#747). The closing caveat ("Chart
      data can both understate and overstate real depths …") stays visible
      outside the disclosure either way.
      At every catalogue boat's DEFAULT safety depth two things follow from
      arithmetic rather than from a broken control, and BOTH are a PASS:
      the cautious-floor sentence is the longer, below-draft wording
      ("Caution: a more cautious reading of the charted depth data could
      run as low as … m, below this boat's … m draft."), and the disclosure
      starts EXPANDED. The default gate is exactly draft + 0.9 m and a
      relaxed route's used depth is at least a decimetre below the gate, so
      the cautious reading is always below the draft. To see the shorter
      sentence and the collapsed state, raise the safety depth well above
      the boat's default (e.g. 3.5 m on a Salona) and re-plan; if the
      router then relaxes only part-way — to a used depth still at or above
      the boat's own default gate — it starts collapsed.
      NOTE — on PIRANJA, §1's boat pick does NOT leave you at that boat's
      own default. Selecting a boat never lowers a safety depth already set
      (the switch clamps UP only, never down), so picking PIRANJA keeps the
      Salona-derived 3.0 m instead of dropping to the Elan's own 2.8 m gate;
      SPEEDY GO! shares the Salona's 2.1 m draft, so its default IS 3.0 m
      and it is unaffected. At 3.0 m on PIRANJA the router may stop relaxing
      at a used depth of 2.8 m or deeper, and the shorter sentence with the
      COLLAPSED disclosure is then the expected result — either form is a
      PASS there, neither is a failure to file. To reach the longer
      below-draft wording and the expanded state on PIRANJA, type its own
      default 2.8 m into the safety depth field on the Boat tab and
      re-plan.

**Result:** Pass / Fail / Partial — notes: ___________________________

## 3. Route B — Flensburg → Sønderborg

Repeat the same route/rig/motor/ETA checks as §2 for Flensburg → Sønderborg.
Checks 2.9–2.13 (depth hatching, marginal-depth line, depth profile,
per-leg cautious marker, shallow-water warning) apply here too, with the
same expected outcomes.

- [ ] **3.1** Route stays in water.
- [ ] **3.2** Rounds Broager Land / Kegnæs sanely.
- [ ] **3.3** Tack pattern plausible (bounded, no zig-zag spam).
- [ ] **3.4** Both sails shown with their own ETAs, and the rig verdict
      matches the boat's polar tier (expected outcomes per boat in §2.5).
- [ ] **3.5** Motor legs (if any) gray-dashed and listed.
- [ ] **3.6** ETA plausible (~5–7 kn average).

**Result:** Pass / Fail / Partial — notes: ___________________________

## 4. PWA — install & offline (Android)

Do this part on an actual Android phone with Chrome.

- [ ] **4.1 Install.** Open the live URL, use "Add to Home screen"; confirm
      an app icon appears and launches standalone (no browser chrome).
- [ ] **4.2 Airplane mode + cold start.** With the app already opened once
      (so it has precached), fully close it, enable airplane mode, then
      launch it fresh from the home screen icon. It must load the app shell
      and map with no network at all.
- [ ] **4.3 Saved plan renders offline, incl. basemap.** Still in airplane
      mode, open a previously-saved plan. The route, both rig ETAs, and the
      map basemap tiles must all render — nothing should show a broken/blank
      map tile or a "failed to load" state.
- [ ] **4.4 Live view on a short walk.** With a loaded plan active and
      location permission granted, use Live view and walk a short distance
      outside. Confirm the position marker moves, heading-to-steer (HTS)
      updates, and it behaves sensibly relative to the actual direction of
      travel. (Airplane mode may need to be off for GPS depending on device
      — note which mode this was run in.)

**Result:** Pass / Fail / Partial — notes: ___________________________

## 5. Results summary

| # | Check | Boat | Result | Issue filed (if any) |
|---|---|---|---|---|
| 1 | Setup / forecast currency / boat selection | — | | |
| 2 | Route A (Flensburg → Marstal) | | | |
| 3 | Route B (Flensburg → Sønderborg) | | | |
| 4 | PWA install/offline/live view | | | |

**Run date:** ___________  **Run by:** ___________  **Build/commit:** ___________

**Overall gate:** Pass / Fail — SailCommand's Phase F gate (= project gate)
requires CI green, the deploy live, and this runbook executed against a real
forecast with the two named routes reviewed visually, either by the user
directly or via an explicit sign-off note referencing this run.
