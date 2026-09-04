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
- [ ] **Depth-hatch legend (before a route is planned).** With no route
      showing yet, below the "Water depths" / "Seamarks" toggles and the
      compass, open the collapsed **Legend** ("Legende") disclosure and
      confirm it explains the cautious-reading hatch, states that
      unsurveyed/drying water carries no hatching (#598/#597), and offers a
      "Show hatch overlay" / "Schraffur anzeigen" checkbox that switches the
      hatch off independently of the "Water depths" toggle itself, without
      touching the depth-colour ramp (#681). Untick that checkbox: the
      "Cautious-reading hatch" swatch row and the basis sentence leave the
      legend while the checkbox itself and the unsurveyed-water caveat stay
      — and the same two rows leave it while the "Water depths" toggle is
      off, since the hatch is absent from the map in either case; in that
      state the hatch checkbox is still shown but disabled (#839). Tick
      both back on before continuing. In short landscape, and in any
      narrow layout with too little height left below the compass, this
      legend is deliberately not rendered at all here — by design, not a
      missing control (in that specific combination, short landscape with no
      route planned, neither this legend nor the plan-active one below
      is shown; that is expected, not a "never neither" violation).
      **If a route is already showing** — this browser restores the last
      session's plan on load (#113), so opening the app is not guaranteed to
      start with none — clear it with **Export GPX** (route summary)
      followed by **Import GPX** (Plan tab) on the file you just exported:
      import always clears the active route *when the file parses*, and a
      file the app exported from a route in this area always does. A GPX
      from elsewhere is rejected with "A point lies outside the covered
      area" and the route is **not** cleared. Then repeat this check. Once
      a route IS planned (the normal state for the rest of this runbook,
      starting with the very next check), this legend disappears and its
      content moves into "Display options" → "Legend" ("Legende") instead —
      the two never render at once (#813); see the "Display options" check
      below.
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
- [ ] **Known-disconnected harbors flagged in search.** In the harbor
      search, look up Arnis, Kappeln, Maasholm, Dyvig, or Gråsten — each
      result shows a note that it is not reachable by the router at any
      depth setting, before you try planning to it, instead of only after a
      full solve returns the generic "cannot be reached" message (#652).
      Then pick one of them as the destination, with any ordinary harbour
      (e.g. Flensburg) as the origin: the same note stays on the
      selected-destination row in the planner (it used to vanish on
      selection), and pressing "Plan route" against it fails with a banner
      carrying that same sentence in place of the generic "No route found —
      the destination cannot be reached …" message (#834). Clear the
      destination again before continuing.
- [ ] **Cable/pipeline seamarks visible at Standard.** Turn the **Seamarks**
      map overlay on — it is OFF by default, unlike "Water depths" — and
      leave the Seamarks display-tier control at its default "Standard"
      setting (not "All"). Zoom to about z12 or closer on a stretch of coast
      known to carry submarine cable or pipeline marks (e.g. the Flensburg
      Fjord approaches); they render at Standard,
      not only at "All" (#521).
- [ ] **Seamarks in view, without a pointer.** With the Seamarks overlay
      still on, open the collapsed "Seamarks in view" / "Schifffahrtszeichen
      im Kartenausschnitt" disclosure that sits on the Plan tab below the
      planner: its summary carries the count of marks inside the current
      map view, the rows are sorted by distance from the map centre, and
      each row is a button that reads as the mark's own map popover would.
      Activate one with Enter or Space (or a click) and that mark's popup
      opens on the map at the mark. Pan the map and the list follows the
      new view once the map settles. Two designed states are not defects:
      with the Seamarks overlay OFF the list shows a hint that the seamark
      layer is hidden instead of any rows, and with more than 50 marks in
      view only the 50 nearest the centre are listed under a sentence saying
      so — zoom in to see all of them (#830).
- [ ] **"Display options" collapses the overlay cluster.** The route-overlay
      toggles, forecast-time slider, and route legend now live behind one
      "Display options" control instead of always covering part of the
      chart. On a narrow/mobile-width screen it starts collapsed; on a wide
      screen it starts open. Toggling the control shows/hides the whole
      cluster together (#628). Once a route is planned, its own nested
      "Legend" ("Legende") disclosure also carries the depth-hatch section —
      the hatch swatch, the basis sentence, the #597 unsurveyed-water
      caveat, and the "Show hatch overlay" toggle — that lived in the
      separate pre-plan Legend above before a route existed (#813). Check
      this nested disclosure's OWN resting state before opening it
      yourself: on narrow layouts it now starts OPEN by default (a
      different default from "Display options" itself, above), while on
      wide layouts it starts closed, unchanged from before #813. Confirm
      the default for **the width you are testing at**, and that toggling
      it by hand still works. The "Show hatch overlay" toggle behaves here
      as in the pre-plan legend: unticked, the hatch swatch row and the
      basis sentence leave this nested legend too, while the toggle and the
      #597 caveat stay (#839). (To see the other default you must resize
      *and reload* — the default is seeded once when the route overlay
      mounts, and once you have toggled "Display options" by hand a
      resize alone will not re-seed it.)

- [ ] **AIS vessels in view, without a pointer.** Requires a personal
      aisstream.io key (Boat tab → "Live & AIS") and an internet connection
      to show any vessels; without a key the list is still present and reads
      "No AIS vessels currently in view", so only the activation half needs a
      key. On the Live tab, the panel carries an "AIS vessels
      in view" / "AIS-Schiffe in Sicht" list — in the PANEL column, not
      beside the AIS status chip, which is separate map chrome. Its summary
      carries the count of vessels inside the current map view, and each
      row is a button that reads the vessel's name and details. Activate
      one with Enter or Space (or a click) and the same identification
      popup a map-symbol click opens appears. With no vessels in view the
      list shows a note saying so rather than any rows; before the map view
      has settled it reads "Waiting for the map view …"; and with more than
      50 vessels in view only the 50 nearest are listed under a sentence
      saying so. All three are designed states, not defects (#831).

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
- [ ] **2.12b Per-leg reef suggestion sits inside the Type cell.** In the
      same expanded "Legs (…)" table, every SAIL leg's "Type" cell carries a
      SECOND chip after the rig/board chip, reading "Full main" / "1st reef"
      / "2nd reef" / "3rd reef" (DE: "Volles Groß" / "1. Reff" / …). It is a
      sibling chip in the existing cell, NOT a new column — the table still
      has ten columns and the "Type" column still names the rig and board.
      MOTOR legs carry no reef chip at all; that is deliberate, not a
      missing value. The band may change along the route as the wind
      does; a single band across the whole route is not a defect when the
      wind is steady. A band change is now damped leg to leg (#946): a
      marginal apparent-wind crossing that would flip the band and flip
      right back does not change what is shown, while a genuine, sustained
      shift still moves it, including across more than one band in a
      single step. This is display-only — it changes what the chip says,
      never the route: the ETA, distance, and rig verdict are unaffected,
      and the router still does not price a reef change as a manoeuvre.
      Expect the suggestion to be advisory only: it is computed from
      apparent wind at display time and the route itself is unchanged, so
      it never alters the ETA, the distance, or which rig is starred. The
      caveat text under the table says the thresholds are seamanship
      guidance and that gusts are not accounted for (#325).
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
      The disclosure starts COLLAPSED on every route (#788). It used to
      start expanded whenever the cautious reading fell below the boat's
      draft, which at a default safety depth is always true — so the
      COLLAPSED state was unreachable there, and the expanded one told a
      tester nothing. An EXPANDED disclosure on first render is now a FAIL
      to file.
      At every catalogue boat's DEFAULT safety depth the cautious-floor
      sentence is the longer, below-draft wording ("Caution: a more
      cautious reading of the charted depth data could run as low as … m,
      below this boat's … m draft."). That follows from arithmetic rather
      than from a broken control, and is a PASS: the default gate is
      exactly draft + 0.9 m and a relaxed route's used depth is at least a
      decimetre below the gate, so the cautious reading is always below the
      draft. To see the shorter sentence, raise the safety depth well
      above the boat's default
      (e.g. 3.5 m on a Salona) and re-plan; if the router then relaxes only
      part-way — to a used depth still at or above the boat's own default
      gate — the shorter wording is what you get.
      NOTE — on PIRANJA, §1's boat pick does NOT leave you at that boat's
      own default. Selecting a boat never lowers a safety depth already set
      (the switch clamps UP only, never down), so picking PIRANJA keeps the
      Salona-derived 3.0 m instead of dropping to the Elan's own 2.8 m gate;
      SPEEDY GO! shares the Salona's 2.1 m draft, so its default IS 3.0 m
      and it is unaffected. At 3.0 m on PIRANJA the router may stop relaxing
      at a used depth of 2.8 m or deeper, and the shorter sentence is then
      the expected result — either wording is a PASS there, neither is a
      failure to file. To reach the longer below-draft wording on PIRANJA,
      type its own default 2.8 m into the safety depth field on the Boat
      tab and re-plan.
- [ ] **2.14 Seamark-proximity line.** If the route summary shows "This
      route passes closer than 300 m to a cardinal or isolated-danger mark
      …" — or the plural form naming how many — that is the #615 advisory:
      a plain line beside the marginal-depth line, never a banner. The
      router did not use the mark, and the sentence deliberately names no
      side to pass; both are correct. The line is wind-dependent — the #615
      spike measured this route firing with three marks and Route B with
      one, at a single uniform wind field — so a different count, or no line
      at all on a route the day's wind took elsewhere, is not a defect to
      file. When it is present, confirm the count is plausible against the
      cardinal marks the Seamarks overlay shows near the route.
- [ ] **2.15 Waypoint by typed coordinates.** In the planner's via section,
      type a latitude and longitude on water inside the covered area into
      the "Latitude" / "Longitude" fields and press "Add coordinates"
      ("Koordinaten hinzufügen"): the point appears in the via list and as a
      marker on the map immediately, but the route line does not move until
      you press "Plan route" again — a via edit is applied on the next plan,
      never automatically. Press that point's own "Edit coordinates (point
      N): …" button: the fields fill with its coordinates, the button reads
      "Update coordinates", and focus lands in the latitude field; change a
      value, update, and the marker moves. Coordinates outside the covered
      area are refused with "The coordinates lie outside the covered area
      (Flensburg Fjord / Danish South Sea)." and nothing is added. Re-plan
      through the point and confirm 2.1 still holds, then remove it
      ("Remove waypoint N") and re-plan before §3 (#829).

**Result:** Pass / Fail / Partial — notes: ___________________________

## 3. Route B — Flensburg → Sønderborg

Repeat the same route/rig/motor/ETA checks as §2 for Flensburg → Sønderborg.
Checks 2.9–2.14 (depth hatching, marginal-depth line, depth profile,
per-leg cautious marker, shallow-water warning, seamark-proximity line)
apply here too, with the same expected outcomes.

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
