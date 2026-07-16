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

For every checkbox, record a result — don't leave it blank. If a check
fails or looks wrong, don't silently work around it: file a GitHub issue
against DocGerd/sail_command describing the deviation, link it in the
results table at the bottom, and note it in the box below the check.

---

## 1. Setup

- [ ] Open the live app in a normal (non-airplane-mode) browser session.
- [ ] Confirm the wind forecast is current: plan any route and note the
      "fetched at" implied by the absence of the stale-forecast banner (see
      §2.5) — if the banner appears immediately for a near-term departure,
      stop and re-check network/API status before continuing.

## 2. Route A — Flensburg → Marstal

Plan a route from a Flensburg-area harbor to Marstal with a departure time
within the next 6-day forecast horizon (e.g. next full hour).

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
- [ ] **2.5 Both rigs shown, distinct ETAs, faster one starred.** The result
      shows main+genoa and main+fock each with their own ETA, and the ★
      "Recommended" marker is on the one with the earlier ETA.
- [ ] **2.6 Motor legs (if any) are gray-dashed and listed.** If sailing
      speed would be too low anywhere on the route, that leg is rendered
      dashed/gray on the map and appears explicitly as a motor leg in the
      leg list — not silently folded into a sailing leg.
- [ ] **2.7 ETA is plausible.** Average speed over the whole route works out
      to roughly 5–7 kn (sanity check: distance ÷ (ETA − departure); wildly
      outside this range for a normal wind day warrants investigation, not
      an automatic fail — note the wind conditions if it's an outlier).
- [ ] **2.8 Stale-forecast banner.** Re-plan (or edit) the same route with a
      departure time more than 12 hours after the forecast was fetched;
      confirm the stale-forecast banner/alert appears on the route summary.

**Result:** Pass / Fail / Partial — notes: ___________________________

## 3. Route B — Flensburg → Sønderborg

Repeat the same route/rig/motor/ETA checks as §2 for Flensburg → Sønderborg.

- [ ] **3.1** Route stays in water.
- [ ] **3.2** Rounds Broager Land / Kegnæs sanely.
- [ ] **3.3** Tack pattern plausible (bounded, no zig-zag spam).
- [ ] **3.4** Both rigs shown with distinct ETAs, faster one starred.
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

| # | Check | Result | Issue filed (if any) |
|---|---|---|---|
| 1 | Setup / forecast currency | | |
| 2 | Route A (Flensburg → Marstal) | | |
| 3 | Route B (Flensburg → Sønderborg) | | |
| 4 | PWA install/offline/live view | | |

**Run date:** ___________  **Run by:** ___________  **Build/commit:** ___________

**Overall gate:** Pass / Fail — SailCommand's Phase F gate (= project gate)
requires CI green, the deploy live, and this runbook executed against a real
forecast with the two named routes reviewed visually, either by the user
directly or via an explicit sign-off note referencing this run.
