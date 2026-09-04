import { test, expect, type Page } from '@playwright/test';
import { startPreview, STANDARD_VIEWPORTS, EDGE_VIEWPORTS } from './helpers';

// Run the full planning flow at a phone viewport so it exercises the
// bottom-sheet layout — the primary on-boat mode (CLAUDE.md). Before the #24
// side-panel work the default 1280x720 viewport WAS the bottom sheet; now it's
// the wide side-panel layout (covered by layout.spec), so this flow pins a
// phone viewport to keep bottom-sheet coverage where the real usage is.
//
// Attribution (#33): MapLibre's compact attribution control used to load
// EXPANDED (a ~600px bar anchored bottom-right) and intercepted clicks aimed
// at the full-width "Route planen" button at any width below the 1024px
// breakpoint. MapView now collapses that auto-expansion before first paint
// (at every viewport width), and this spec asserts the fixed contract instead
// of working around it: collapsed on load (the primary regression guard,
// below), expandable by tap (attribution must stay reachable — CC-BY/ODbL),
// and the plan click landing with no collapse click in between.
test.use({ viewport: { width: 375, height: 667 } });

// End-to-end happy path: harbor search -> plan -> rig comparison -> saved
// under Routen. Deterministic wind via the `?windFixture=` escape hatch
// (E3) — no live Open-Meteo call, no route-dependent flakiness.
//
// Harbor-name note: the combobox matches all three locale name fields
// (HarborPicker.tsx's `matchesQuery`), so searching the Danish/English
// "Sønderborg" finds the harbor even though its *displayed* name in the
// app's default German UI is the exonym "Sonderburg" — the two names are
// intentionally different, so results are selected structurally (the first
// listbox option) rather than by matching display text.
test('plans a route: harbor search -> rig comparison -> saved under Routen', async ({ page }) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // #33 contract, part 1 — collapsed on load: once the basemap's
    // attribution arrives the control enters compact mode, and MapView must
    // have swallowed MapLibre's one-shot auto-expansion (no
    // `maplibregl-compact-show`, which is the class that paints the full-width
    // bar). Generous timeout: compact mode needs the pmtiles source metadata,
    // and CI is measurably slower than dev machines (CLAUDE.md's measured
    // ~2.1x/~2.5x figures are for the vitest unit suite specifically; no
    // equivalent Playwright/e2e ratio has been measured).
    // `(\s|$)` not `\b`: a word boundary alone would also match the
    // "maplibregl-compact" prefix inside "maplibregl-compact-show".
    const attribution = page.locator('details.maplibregl-ctrl-attrib');
    await expect(attribution).toHaveClass(/maplibregl-compact(\s|$)/, { timeout: 30_000 });
    await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);

    // #33 contract, part 2 — still reachable: a tap on the toggle expands the
    // full notice (attribution must never be removed, only collapsed), and a
    // second tap collapses it again so the flow below runs on the load state.
    const attributionToggle = page.locator('.maplibregl-ctrl-attrib-button');
    await attributionToggle.click();
    await expect(attribution).toHaveClass(/maplibregl-compact-show/);
    await expect(attribution.getByRole('link', { name: 'OpenStreetMap' })).toBeVisible();
    await attributionToggle.click();
    await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);

    await page.getByRole('tab', { name: 'Planen' }).click();

    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    // Exactly one match expected — pins the search actually narrowed the
    // listbox rather than clicking whatever happened to render first.
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();
    // Selecting collapses the combobox to the endpoint row; `.endpoint-name`
    // is that row's harbor-name line (the full caveat, if any, is a sibling).
    await expect(originSection.locator('.endpoint-name')).toHaveText('Langballigau');

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();
    // German UI displays the exonym "Sonderburg" for the Danish "Sønderborg".
    await expect(destSection.locator('.endpoint-name')).toHaveText('Sonderburg');

    // Cheap smoke check on the via UI (Phase E gate backlog item): arming
    // tap-to-pick shows the map-tap banner and "Abbrechen" disarms it. A
    // real via add/drag needs a canvas-coordinate map tap, which depends on
    // MapLibre's live projection (center/zoom/bounds) and was judged too
    // fragile for this spec — see task-F2-report.md.
    await page
      .getByRole('region', { name: 'Wegpunkte' })
      .getByRole('button', { name: 'Wegpunkt hinzufügen' })
      .click();
    const tapPickBanner = page.getByText('Auf Karte tippen für Wegpunkte.');
    await expect(tapPickBanner).toBeVisible();
    await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await expect(tapPickBanner).not.toBeVisible();

    // #33 contract, part 3 — no interception, belt-and-suspenders: part 1's
    // load-state class assertion is the primary regression guard (part 2
    // re-collapses the attribution above, so by this point the control is
    // collapsed either way). This click landing without any collapse click
    // before it adds a behavioral backstop via Playwright's actionability
    // check — do not re-add a collapse click above it.
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    // Wait for run() to fully settle (button re-enabled: usePlanFlow.ts's
    // phase back to idle/error) *before* switching tabs. PlansList.tsx only
    // calls listPlans() once, on mount, and it mounts fresh every time the
    // Routen tab is entered (App.tsx renders it only while `tab ===
    // 'routes'`) — switching tabs any earlier mounts PlansList before
    // run()'s `save()` has written the record, and it never re-fetches
    // afterwards, leaving the list stuck empty for the rest of the test.
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    await page.getByRole('tab', { name: 'Routen' }).click();

    const rigTabs = page.getByRole('tablist', { name: 'Riggvergleich' });
    await expect(rigTabs).toBeVisible({ timeout: 60_000 });
    const genoaTab = rigTabs.getByRole('tab', { name: /Genua/ });
    const fockTab = rigTabs.getByRole('tab', { name: /Fock/ });
    await expect(genoaTab).toBeVisible();
    await expect(fockTab).toBeVisible();
    // The rig comparison must be SELF-CONSISTENT: the ★ badge and the chip
    // are two renderings of one `rigRecommendation` (RouteSummary.tsx), so
    // whatever the router decides, they have to agree. That is the invariant
    // this end-to-end path exists to check.
    //
    // #455 REPLACED A SNAPSHOT WITH THAT INVARIANT. This assertion used to
    // pin the TIE specifically: #259/#275 measured this demo route
    // (Langballigau -> Sønderborg, uniform 12 kn / 225° fixture wind) at a
    // genoa/fock gap of ~13.6 s against the 60 s `RIG_TIE_BAND_MS`
    // (planRoute.ts) and asserted no ★ on either tab. But a 13.6 s margin
    // inside a 60 s band was always one perturbation away from flipping —
    // and #455's mask correction flipped it. MEASURED on this exact route
    // and wind, DEFAULT_SETTINGS:
    //     pre-#455 mask:  gap  13.57 s -> tie      (0.28% of an 81.1 min passage)
    //     corrected mask: gap 108.84 s -> decided  (2.17% of an 83.6 min passage)
    // Fock genuinely wins now, and not marginally: 108.8 s is 1.81x the band,
    // both rigs are all-sail, and both got slower under the corrected mask —
    // genoa by 149 s and fock by only 27 s, which is what opened the gap.
    // Those figures are MASK-DERIVED and will legitimately move again on any
    // regeneration; check the DIRECTION before concluding anything from a
    // change here.
    //
    // So the verdict is no longer pinned — the AGREEMENT is. A tie must show
    // no ★ and the tie sentence; a decision must show exactly one ★, on the
    // tab of the rig the chip names. The regression the old comment feared —
    // "a silent single-rig badge" — still fails loudly, because a ★ appearing
    // beside the tie sentence satisfies neither branch.
    const fasterRigChip = page.locator('.route-summary .chip-faster-rig');
    await expect(fasterRigChip).toBeVisible();
    const chipText = ((await fasterRigChip.textContent()) ?? '').trim();
    const stars = rigTabs.getByLabel('Empfohlen');
    const decided = /^Schneller: (Genua|Fock)$/.exec(chipText);
    if (decided) {
      const winner = decided[1];
      await expect(
        stars,
        `chip reads "${chipText}", so exactly one rig tab must carry the Empfohlen badge`,
      ).toHaveCount(1);
      await expect(
        (winner === 'Genua' ? genoaTab : fockTab).getByLabel('Empfohlen'),
        `chip names ${winner}, so the Empfohlen badge must sit on the ${winner} tab`,
      ).toHaveCount(1);
    } else {
      expect(
        [
          'Genua und Fock liegen für diese Passage praktisch gleichauf',
          'Riggwahl spielt hier keine Rolle — die Passage läuft durchgehend unter Motor',
        ],
        `chip must read the tie or moot sentence when no rig is recommended, got "${chipText}"`,
      ).toContain(chipText);
      await expect(
        stars,
        `chip reads "${chipText}", so neither rig tab may carry the Empfohlen badge`,
      ).toHaveCount(0);
    }

    // Both rigs must have actually found a route (an ETA, not a no-route
    // alert) — a broad reach in 12 kn should always be sailable for either
    // sail plan on this short leg.
    for (const tab of [genoaTab, fockTab]) {
      await tab.click();
      // #64 phase 3: totals became a stat grid — the Ankunft (ETA) stat proves
      // a route was found (an ETA, not a no-route alert).
      await expect(
        page.locator('.route-summary .ergebnis-stat', { hasText: 'Ankunft' }),
      ).toBeVisible();
      await expect(page.locator('.route-summary [role="alert"]')).toHaveCount(0);
    }

    // #64 phase 3: the legs table moved behind a disclosure — open it to reveal
    // the rows.
    await page.locator('.route-legs-disclosure > summary').click();
    const legRows = page.locator('.route-legs tbody tr');
    await expect(legRows.first()).toBeVisible();
    expect(await legRows.count()).toBeGreaterThan(0);

    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();

    // #46a: the collapsed route legend mounts in the route-layer controls once
    // a plan renders. RouteLayer has no unit test (MapLibre-bound) and no other
    // spec references the legend, so this pins the <RouteLegend /> mount through
    // the #35/36/37 RouteLayer rewrite — dropping the mount line would fail here
    // rather than passing silently. German UI, so the summary reads "Legende".
    await expect(page.locator('details.route-legend > summary')).toHaveText('Legende');
    // #813: DataLayers.tsx's own free-floating `.depth-legend` must be gone
    // the instant a plan exists — RouteLegend's own `.route-legend` above
    // (which now ALSO folds in the #598 depth-hatch content, see that
    // component's own #813 comment; DataLayers.test.tsx and
    // RouteLegend.test.tsx pin the copy itself unit-side) is the SOLE
    // "Legende" surface at that point. Before #813 BOTH disclosures existed
    // simultaneously here, sharing the identical accessible name — this
    // count is the regression guard against that coming back.
    await expect(page.locator('details.depth-legend')).toHaveCount(0);

    await expect(page.locator('.plans-list-row')).toHaveCount(1);

    // #31 with-plan wide coverage: the `.app-panel-live .live-view`
    // neutralization (position:static, in-panel) — the feature's primary
    // with-plan state — has no other coverage. layout.spec only exercises the
    // fresh-context `.live-view-no-plan` branch, and jsdom can't see CSS. Here a
    // real plan is active, so resizing into the side-panel layout and opening
    // Live renders the full `.live-view` readout; assert it sits INSIDE the
    // panel column, not the absolute full-width-bottom fallback a regressed
    // neutralization would produce (position:absolute against .app-shell,
    // spanning the viewport bottom over the map).
    await page.setViewportSize({ width: 1280, height: 800 });
    const panel = page.locator('.app-bottom-sheet');
    // Poll the panel into its side-column geometry before reading positions.
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThan(1280 * 0.5);
    await page.getByRole('tab', { name: 'Live' }).click();
    const readout = page.locator('.app-bottom-sheet .live-view');
    await expect(readout).toBeVisible();
    // Not also rendered inline over the map (no dual render).
    await expect(page.locator('.map-area .live-view')).toHaveCount(0);
    const panelBox = await panel.boundingBox();
    const readoutBox = await readout.boundingBox();
    if (!panelBox || !readoutBox) throw new Error('expected panel + readout bounding boxes');
    expect(readoutBox.x).toBeGreaterThanOrEqual(panelBox.x - 2);
    expect(readoutBox.x + readoutBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 2);
  } finally {
    server.kill();
  }
});

// #301: re-plan from the Plan view. Loading/planning prefills the form from
// the active plan; editing an input afterward (here: departure) marks the
// displayed route stale (a second Chip in the Ergebnis card); re-running
// produces a NEW plan (never replaces the original) using LIVE settings.
// Reuses the SAME Langballigau -> Sønderborg pair and wind fixture as the
// happy-path test above for deterministic routing, but stays narrowly scoped
// to the #301 flow rather than re-covering attribution/via/live-view.
test('re-plan from the Plan view: editing after a completed plan shows the stale chip, and re-running adds a second saved plan', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await page.getByRole('tab', { name: 'Planen' }).click();

    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    await originSection.getByRole('option').first().click();

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    await destSection.getByRole('option').first().click();

    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    // Ergebnis card present, and NOT stale immediately after a completed run
    // — the form still matches the plan it just produced.
    const resultCard = page.locator('.planner-result');
    await expect(resultCard).toBeVisible();
    const staleChip = resultCard.getByText('Zeigt die zuvor berechnete Route', { exact: false });
    await expect(staleChip).toHaveCount(0);

    // Edit the departure — the ONE form input this flow touches — to a value
    // a few hours after whatever the form currently shows (still comfortably
    // inside the datetime-local's [now, now + forecast horizon] bounds).
    const departureInput = page.getByLabel('Abfahrt');
    const originalValue = await departureInput.inputValue();
    const [datePart, timePart] = originalValue.split('T');
    const original = new Date(`${datePart}T${timePart}:00`);
    const edited = new Date(original.getTime() + 3 * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const editedValue = `${edited.getFullYear()}-${pad(edited.getMonth() + 1)}-${pad(edited.getDate())}T${pad(edited.getHours())}:${pad(edited.getMinutes())}`;
    await departureInput.fill(editedValue);

    // The chip appears (folded into the SAME Ergebnis card the faster-rig
    // chip already lives in) once the form has drifted from the displayed
    // route — state signal, not a fixed wait.
    await expect(staleChip).toBeVisible();
    await expect(resultCard.locator('.chip-faster-rig')).toBeVisible();

    // Re-run: a NEW plan, not a replacement (#301 decision (a)) — using LIVE
    // settings, which is what "Route planen" always did (#301 decision (b)).
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    // Freshly completed: no longer stale against the form that produced it.
    await expect(staleChip).toHaveCount(0);

    // Two distinct saved plans now exist — the original stayed, untouched.
    await page.getByRole('tab', { name: 'Routen' }).click();
    await expect(page.locator('.plans-list-row')).toHaveCount(2);
  } finally {
    server.kill();
  }
});

// #771 — LICENCE COMPLIANCE (ODbL/CC-BY). The map's OpenStreetMap credit must
// stay reachable at every viewport, INCLUDING once the planner panel has been
// scrolled down to its "Route planen" CTA, which is exactly where it stopped
// being reachable.
//
// The defect was a stacking context nobody meant to create. `.planner-actions`
// carried `z-index: 2` in its base rule on the premise that the value is inert
// while the bar is `position: static`, as it then was at narrow. It is not:
// `.planner-panel` is `display: flex`, so `.planner-actions` is a FLEX ITEM,
// and per css-flexbox-1's "Painting Flex Items" rule a flex item's `z-index`
// other than `auto` creates a stacking context EVEN WHILE `position: static`.
// That tied `.maplibregl-ctrl-bottom-right`'s own `z-index: 2` and won on DOM
// order, so the CTA's own `p.planner-guidance` painted over the attribution
// toggle and swallowed its clicks. app.css's `.planner-actions` rule carries
// the mechanism and the measurement; the fix scoped `z-index` to the wide-only
// rule. #702 has since made the bar sticky at narrow too — with `bottom`, but
// deliberately WITHOUT `z-index`, which is what keeps this test green there;
// the narrow rule's own comment carries that reasoning, and the #702 tests at
// the end of this file guard the at-rest position this one does not reach.
//
// Why this guard is shaped the way it is — each point is a failure mode this
// repo has already paid for (CLAUDE.md's verification lessons):
//   - `toBeVisible()` CANNOT detect a covered element: it checks a non-empty
//     box and `visibility`, both of which are true of an element painted
//     underneath something else. The #33 contract above asserts exactly that
//     on this very link and passed straight through this defect. So the
//     subject here is a real topmost hit-test (`document.elementsFromPoint`),
//     backed by `click({ trial: true })` for the behavioural half.
//   - Persisted state is cleared FIRST, and the CTA is then asserted PRESENT
//     before anything is asserted about the attribution. With saved plans or a
//     non-Planen tab in the profile, `.planner-actions` is absent entirely and
//     every assertion below would measure an app state in which the defect is
//     structurally unreachable — a false negative indistinguishable from a
//     clean pass. A null subject must FAIL this test, never skip it.
//   - Geometry (and the scroll that produces it) is re-established INSIDE the
//     poll callback, never captured once before settle: a stale coordinate and
//     a real interception produce byte-identical failures (#412/#422).
//   - The probe returns a descriptive STRING naming whatever is actually on
//     top, not a boolean — a boolean collapses every cause into
//     `Expected: true / Received: false` plus a timeout.
//
// Iterates the shared matrix rather than inlining literals. The wide rows
// (the entries at or above the 1024px breakpoint — currently
// desktop4k/desktopHd/tabletLandscape) cannot reproduce this defect — there
// the panel is its own grid column and `z-index: 2` is still deliberately in
// force — so they ride along as a negative control: they must stay green in
// both the fixed and the unfixed state, which is what distinguishes "this
// guard detects the defect" from "this guard fails at everything".
//
// German only, like the rest of this spec. The mechanism is a stacking-context
// tie resolved by DOM order over `.planner-actions`' box; no string length
// participates in it, so a language axis would double the runtime without
// adding discriminating power.
const ATTRIBUTION_VIEWPORTS = { ...STANDARD_VIEWPORTS, ...EDGE_VIEWPORTS };

type AttributionSubject = 'attribution-toggle' | 'openstreetmap-link';

/**
 * Scrolls the planner to its CTA and reports what is genuinely topmost over
 * the requested attribution element, as a descriptive string: the subject's
 * own name when it wins the hit-test, `covered-by:<tag>.<classes>` when it
 * does not, and a named diagnostic when the subject or the hit-test itself is
 * missing. Everything — the scroll, the box, the hit-test — is redone on every
 * call, so an `expect.poll` over it can never assert against geometry sampled
 * before the layout settled.
 *
 * Since #702 that scroll is a measured NO-OP at every row of this test's
 * matrix (scrollTop stayed 0 at all twelve rows of `ATTRIBUTION_VIEWPORTS`,
 * 2026-09-01 — including `tabletLandscape`, which has 120px of overflow; the
 * three wide rows were already no-ops before #702, where the bar was already
 * sticky): the bar is sticky at both layouts now, so it is already fully in
 * view and `scrollIntoView` has nothing to do. The call stays because it is what makes
 * this helper honest about the scrolled state should the bar ever stop
 * fitting, but it means these rows no longer exercise a scrolled panel — and
 * they never sampled the at-rest sticky position either, which sits ~12px
 * higher. The #702 tests at the end of this file cover that position; do not
 * treat these rows as standing in for them.
 */
async function topmostOverAttribution(page: Page, subject: AttributionSubject): Promise<string> {
  return page.evaluate((which) => {
    document.querySelector('.planner-actions')?.scrollIntoView({ block: 'end' });
    const target =
      which === 'attribution-toggle'
        ? document.querySelector('.maplibregl-ctrl-attrib-button')
        : Array.from(document.querySelectorAll('.maplibregl-ctrl-attrib a')).find((a) =>
            /openstreetmap/i.test(a.textContent ?? ''),
          );
    if (!target) return `missing:${which}`;
    const box = target.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return `zero-box:${which}`;
    const top = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)[0];
    if (!top) return `nothing-hit-tested-over:${which}`;
    if (top === target || target.contains(top)) return which;
    const classes =
      typeof top.className === 'string' && top.className.trim()
        ? `.${top.className.trim().split(/\s+/).join('.')}`
        : '';
    return `covered-by:${top.tagName.toLowerCase()}${classes}`;
  }, subject);
}

test('#771: the OpenStreetMap attribution stays clickable at every viewport, with the planner scrolled to its CTA', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // Clear anything a shared profile may carry (saved plans put the app on a
    // different tab, which removes the CTA and with it the whole defect).
    await page.evaluate(async () => {
      localStorage.clear();
      const databases = (await indexedDB.databases?.()) ?? [];
      await Promise.all(
        databases.map((info) => {
          const name = info.name;
          if (name === undefined) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          });
        }),
      );
    });
    await page.reload();

    await page.getByRole('tab', { name: 'Planen' }).click();

    // Compact mode needs the pmtiles source metadata — same generous budget as
    // the #33 contract above, for the same reason.
    const attribution = page.locator('details.maplibregl-ctrl-attrib');
    await expect(attribution).toHaveClass(/maplibregl-compact(\s|$)/, {
      timeout: 30_000,
    });

    const toggle = page.locator('.maplibregl-ctrl-attrib-button');
    const osmLink = attribution.getByRole('link', { name: 'OpenStreetMap' });
    const planButton = page.getByRole('button', { name: 'Route planen' });
    const plannerActions = page.locator('.planner-actions');

    for (const [name, viewport] of Object.entries(ATTRIBUTION_VIEWPORTS)) {
      await page.setViewportSize(viewport);

      // Subject first: if the CTA bar the defect needs is not on screen, this
      // row proves nothing about the attribution and must fail loudly rather
      // than pass vacuously.
      await expect(
        plannerActions,
        `${name}: no .planner-actions — the planner is not showing its CTA, so this row cannot test the #771 overlap`,
      ).toHaveCount(1);
      await expect(planButton, `${name}: no "Route planen" button inside the CTA bar`).toHaveCount(
        1,
      );

      // Collapsed: the toggle is the only way to the notice, so it must win
      // the hit-test at the point a user taps.
      await expect
        .poll(() => topmostOverAttribution(page, 'attribution-toggle'), {
          timeout: 15_000,
        })
        .toBe('attribution-toggle');
      await toggle.click({ trial: true, timeout: 10_000 });

      // Expanded: the credit LINK itself — the object the ODbL/CC-BY
      // obligation actually attaches to, and a strictly larger target than the
      // toggle, so it can be covered while the toggle is not.
      await toggle.click();
      await expect(attribution).toHaveClass(/maplibregl-compact-show/);
      await expect
        .poll(() => topmostOverAttribution(page, 'openstreetmap-link'), {
          timeout: 15_000,
        })
        .toBe('openstreetmap-link');
      await osmLink.click({ trial: true, timeout: 10_000 });

      // Back to the load state so the next viewport starts where this one did.
      await toggle.click();
      await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);
    }
  } finally {
    server.kill();
  }
});

// ---------------------------------------------------------------------------
// #702 — §3.3's sticky CTA, now at NARROW as well.
//
// The UI-modernization addendum's §3.3 guarantees that "Route planen" stays
// reachable at the panel bottom (sticky) so it is never below a long scroll.
// `position: sticky` used to be scoped to the wide side-panel, so the narrow
// bottom sheet was the one layout where that guarantee was unmet: measured
// 2026-09-01 against a real build, the EMPTY German planner already overflowed
// `.app-panel`'s scrollport at every narrow viewport of the shared matrix, by
// 178px (tabletPortrait) to 653px (wrapForcing280) — so the CTA sat below the
// fold on arrival, before the user opened or added anything.
//
// WHY THIS IS SAFE NOW. An earlier, reverted attempt made the bar sticky while
// `z-index: 2` was still in its BASE rule; as a flex item that created a
// stacking context which tied `.maplibregl-ctrl-bottom-right` and buried the
// ODbL/CC-BY attribution (#771 — the test above is that defect's keeper).
// PR #800 moved `z-index` into the wide-only rule, and the narrow rule this
// test guards adds NO `z-index`, so the bar paints at step 8 of CSS 2.1
// Appendix E's order while the attribution's own `z-index: 2` holds it at
// step 9 of the same root stacking context: the attribution keeps both the
// paint and the hit test.
//
// THIS GUARD CARRIES THE FULL LOAD — the #771 test does NOT cover the at-rest
// sticky state, and establishing that was a precondition of writing a single
// assertion here. `topmostOverAttribution` positions the bar with
// `scrollIntoView({ block: 'end' })`, which aligns the element's bottom margin
// edge with the scrollport's PADDING-box bottom edge, whereas
// `position: sticky; bottom: 0` resolves its offset against the scroll
// container's CONTENT box, so `.app-panel`'s 0.75rem bottom padding pins the
// bar 12px HIGHER. Measured 2026-09-01 across ten narrow rows: -11.50px to
// -12.36px. Those are two different positions, and the gap is larger than the
// whole CTA/toggle overlap the horizontal separation below exists to remove —
// so nothing about the at-rest state may be inferred from the #771 rows.
//
// Every probe re-samples geometry INSIDE its poll callback (#412/#422): a
// stale coordinate and a real interception produce byte-identical failures.
// Every probe returns a descriptive STRING carrying its own numbers rather
// than a boolean, so a CI failure names the value instead of `Expected: true`.
//
// `topmostOverAttributionAtRest` below duplicates part of
// `topmostOverAttribution` deliberately rather than sharing it: that helper
// must keep scrolling to keep proving what it proves, and this one must not
// scroll AT ALL, because the at-rest position is the entire subject here.
const NARROW_CTA_VIEWPORTS = Object.entries(ATTRIBUTION_VIEWPORTS).filter(
  ([, vp]) => vp.width < 1024,
);
const WIDE_CTA_VIEWPORTS = Object.entries(ATTRIBUTION_VIEWPORTS).filter(
  ([, vp]) => vp.width >= 1024,
);

// `.sc-btn`'s `border-radius: 8px` clips hit-testing at the corner, so a
// 1-2px inset lands OUTSIDE the button's painted area and resolves to its
// parent in the fixed state — a probe that can never say "the CTA is
// topmost". 10px is the radius plus the same 2px headroom the 24px
// separation uses. MEASURED 2026-09-01 in the endpoints-selected state, at
// every narrow row: with the separation present the CTA wins from inset 4
// upward; with `padding-right` deleted the attribution toggle wins at insets
// 1, 4, 8, 10 and 12 and only loses from 16 — so 10 sits inside the band
// that discriminates, at both ends.
const CTA_CORNER_INSET_PX = 10;

// The map's attribution carries exactly four credit links: OpenStreetMap,
// Protomaps, EMODnet Bathymetry, and "Weather data by Open-Meteo.com".
// MEASURED 2026-09-01: four at every narrow row, in both planner states.
// Pinned as an exact count, not a non-vacuity floor: attribution reachability
// is an ODbL/CC-BY obligation, so a credit silently disappearing from the
// string must red rather than pass. Adding a legitimate fifth credit reds this
// too — deliberate, and the cheaper direction to be wrong in.
const EXPECTED_CREDIT_LINKS = 4;

/**
 * Reports whether the CTA is reachable WITHOUT scrolling, as a descriptive
 * string carrying the overflow margin and both rectangles. Fails CLOSED on a
 * scrollport that does not overflow: sticky is a no-op when the content fits,
 * so such a row could not tell the fixed state from the unfixed one and must
 * red loudly rather than pass vacuously.
 */
async function ctaReachableAtRest(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector('.app-panel');
    const cta = document.querySelector('.planner-actions .sc-btn-primary');
    if (!panel) return 'missing:.app-panel';
    if (!cta) return 'missing:.planner-actions .sc-btn-primary';
    const n = (x: number) => x.toFixed(2);
    const overflow = panel.scrollHeight - panel.clientHeight;
    const p = panel.getBoundingClientRect();
    const portTop = p.bottom - panel.clientHeight;
    const c = cta.getBoundingClientRect();
    const where =
      `overflowPx=${overflow} ctaTop=${n(c.top)} ctaBottom=${n(c.bottom)} ` +
      `scrollport=[${n(portTop)},${n(p.bottom)}] scrollTop=${n(panel.scrollTop)}`;
    if (overflow <= 0) return `no-overflow-cannot-discriminate ${where}`;
    if (Math.round(panel.scrollTop) !== 0) return `not-at-rest ${where}`;
    // 1px tolerance for sub-pixel layout only; the unfixed state misses by
    // hundreds of px (measured 365px at phonePortrait), not by fractions.
    if (c.bottom > p.bottom + 1) return `below-fold ${where}`;
    if (c.top < portTop - 1) return `above-scrollport ${where}`;
    return `ok ${where}`;
  });
}

/**
 * Intersection of the CTA BUTTON's box with the collapsed attribution
 * toggle's. The BUTTON, not `.planner-actions`: the 24px separation is
 * padding, which lives inside the container's border box, so the container
 * still overlaps the toggle by 484px2 in the fixed state (measured) and a
 * container-based assertion would red on unmutated HEAD.
 */
async function ctaVsAttributionToggleArea(page: Page): Promise<string> {
  return page.evaluate(() => {
    const cta = document.querySelector('.planner-actions .sc-btn-primary');
    const toggle = document.querySelector('.maplibregl-ctrl-attrib-button');
    if (!cta) return 'missing:.planner-actions .sc-btn-primary';
    if (!toggle) return 'missing:.maplibregl-ctrl-attrib-button';
    const n = (x: number) => x.toFixed(2);
    const c = cta.getBoundingClientRect();
    const t = toggle.getBoundingClientRect();
    const w = Math.max(0, Math.min(c.right, t.right) - Math.max(c.left, t.left));
    const h = Math.max(0, Math.min(c.bottom, t.bottom) - Math.max(c.top, t.top));
    return (
      `overlapPx2=${+(w * h).toFixed(2)} ctaRight=${n(c.right)} toggleLeft=${n(t.left)} ` +
      `horizontalGapPx=${n(t.left - c.right)} ctaBottom=${n(c.bottom)} toggleTop=${n(t.top)}`
    );
  });
}

/**
 * Topmost element at the CTA's bottom-RIGHT corner, inset by
 * CTA_CORNER_INSET_PX. The bottom-right corner specifically: the attribution
 * toggle sits at the viewport's bottom-right, so any encroachment is on that
 * corner and a centre probe resolves to the button in both states — a
 * provably equivalent mutant.
 */
async function ctaCornerTopmost(page: Page, insetPx: number): Promise<string> {
  return page.evaluate((inset) => {
    const cta = document.querySelector('.planner-actions .sc-btn-primary');
    if (!cta) return 'missing:.planner-actions .sc-btn-primary';
    const c = cta.getBoundingClientRect();
    if (c.width <= inset || c.height <= inset)
      return `cta-smaller-than-inset ${c.width}x${c.height}`;
    const x = c.right - inset;
    const y = c.bottom - inset;
    const top = document.elementsFromPoint(x, y)[0];
    if (!top) return `nothing-hit-tested-at (${x.toFixed(2)},${y.toFixed(2)})`;
    if (top === cta || cta.contains(top)) return 'cta';
    const classes =
      typeof top.className === 'string' && top.className.trim()
        ? `.${top.className.trim().split(/\s+/).join('.')}`
        : '';
    return `covered-by:${top.tagName.toLowerCase()}${classes} at=(${x.toFixed(2)},${y.toFixed(2)})`;
  }, insetPx);
}

/**
 * The #771 licence probe WITHOUT the scroll — see the block comment above for
 * why the scrolling version cannot stand in for this one. `all-links` walks
 * EVERY anchor in the expanded control rather than the OpenStreetMap one
 * alone (they all ride on the same z-order mechanism), and fails CLOSED on an
 * empty list: "every link is topmost" is vacuously true of no links.
 *
 * It hit-tests the centre of each of the target's CLIENT RECTS, not of its
 * bounding box. An anchor is INLINE, so an anchor that wraps has one client
 * rect per line box while its bounding box spans both lines PLUS the gap
 * between them — and that gap belongs to the parent. MEASURED 2026-09-01 with
 * this control expanded: every anchor with two client rects
 * ("Weather data by Open-Meteo.com" at six of the nine narrow rows and
 * "EMODnet Bathymetry" additionally at deepPortrait320 and wrapForcing280 —
 * the set is deterministic but NOT monotonic in viewport width) hit-tested its
 * bounding-box centre to `div.maplibregl-ctrl-attrib-inner`, its own parent,
 * while BOTH of its line-box centres hit-tested to the anchor. That is a
 * geometry artefact of centre-probing an inline box, not occlusion, and a
 * bounding-box probe would have reported a licence failure that is not real.
 */
async function topmostOverAttributionAtRest(
  page: Page,
  subject: 'attribution-toggle' | 'all-links',
): Promise<string> {
  return page.evaluate((which) => {
    const describe = (el: Element | null | undefined): string => {
      if (!el) return 'none';
      const classes =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${classes}`;
    };
    const check = (target: Element): string | null => {
      const rects = Array.from(target.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) return 'zero-box';
      for (const box of rects) {
        const top = document.elementsFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        )[0];
        if (!top) return 'nothing-hit-tested';
        if (top !== target && !target.contains(top)) return `covered-by:${describe(top)}`;
      }
      return null;
    };
    if (which === 'attribution-toggle') {
      const toggle = document.querySelector('.maplibregl-ctrl-attrib-button');
      if (!toggle) return 'missing:attribution-toggle';
      const bad = check(toggle);
      return bad === null ? 'attribution-toggle' : bad;
    }
    const links = Array.from(document.querySelectorAll('.maplibregl-ctrl-attrib a'));
    if (links.length === 0) return 'missing:no-attribution-links';
    for (const link of links) {
      const bad = check(link);
      if (bad !== null) return `${bad} link="${(link.textContent ?? '').trim()}"`;
    }
    return `all-links topmost n=${links.length}`;
  }, subject);
}

/** #771's prologue, verbatim: a shared profile's saved plans put the app on a
 *  different tab, which removes the CTA and with it the whole subject. */
async function clearPersistedProfile(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.clear();
    const databases = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      databases.map((info) => {
        const name = info.name;
        if (name === undefined) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
      }),
    );
  });
}

test('#702: the "Route planen" CTA stays reachable at the panel bottom at every narrow viewport, empty and with endpoints selected', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await clearPersistedProfile(page);
    await page.reload();
    await page.getByRole('tab', { name: 'Planen' }).click();

    // Same generous budget as the #33 contract: compact mode needs the
    // pmtiles source metadata.
    const attribution = page.locator('details.maplibregl-ctrl-attrib');
    await expect(attribution).toHaveClass(/maplibregl-compact(\s|$)/, { timeout: 30_000 });

    const toggle = page.locator('.maplibregl-ctrl-attrib-button');
    const plannerActions = page.locator('.planner-actions');
    const planButton = page.getByRole('button', { name: 'Route planen' });

    // The subject must exist before ANY geometry is probed — a null subject
    // fails this test, it never skips it.
    await expect(
      plannerActions,
      'no .planner-actions — the planner is not showing its CTA',
    ).toHaveCount(1);
    await expect(planButton, 'no "Route planen" button inside the CTA bar').toHaveCount(1);

    const sweep = async (state: string) => {
      for (const [name, viewport] of NARROW_CTA_VIEWPORTS) {
        await page.setViewportSize(viewport);
        const label = `${name} (${viewport.width}x${viewport.height}) / ${state}`;

        // Return the scrollport to the top: under sticky every scroll offset
        // is equivalent, but with the fix absent the top is where the CTA is
        // furthest below the fold, so this is the strongest position for the
        // reachability assertion rather than a concession to it. It is SETUP,
        // outside the poll — the probes themselves never scroll.
        await page.evaluate(() => {
          const panel = document.querySelector('.app-panel');
          if (panel) panel.scrollTop = 0;
        });

        await expect
          .poll(() => ctaReachableAtRest(page), { timeout: 15_000, message: label })
          .toMatch(/^ok /);
        await expect
          .poll(() => ctaVsAttributionToggleArea(page), { timeout: 15_000, message: label })
          .toMatch(/^overlapPx2=0 /);
        await expect
          .poll(() => ctaCornerTopmost(page, CTA_CORNER_INSET_PX), {
            timeout: 15_000,
            message: label,
          })
          .toBe('cta');

        // Licence obligation, at rest. Collapsed first: the toggle is the
        // only route to the notice, so it must win the hit-test where a user
        // taps it.
        await expect
          .poll(() => topmostOverAttributionAtRest(page, 'attribution-toggle'), {
            timeout: 15_000,
            message: label,
          })
          .toBe('attribution-toggle');
        await toggle.click({ trial: true, timeout: 10_000 });

        // Expanded: every credit link, not the OpenStreetMap anchor alone —
        // they all ride on the same z-order mechanism, so asserting one and
        // not the others would leave the rest silently unguarded.
        await toggle.click();
        await expect(attribution).toHaveClass(/maplibregl-compact-show/);
        await expect
          .poll(() => topmostOverAttributionAtRest(page, 'all-links'), {
            timeout: 15_000,
            message: label,
          })
          .toBe(`all-links topmost n=${EXPECTED_CREDIT_LINKS}`);
        await attribution
          .getByRole('link', { name: 'OpenStreetMap' })
          .click({ trial: true, timeout: 10_000 });

        await toggle.click();
        await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);
      }
    };

    // EMPTY planner: the bar carries the CTA plus the onboarding guidance.
    await sweep('empty');

    // ENDPOINTS SELECTED: the guidance disappears and the bar becomes
    // button-only and 24px shorter (84px -> 60px, measured), which moves the
    // CTA's bottom edge DOWN to 14px past the attribution toggle's top edge.
    // #771 never covered this composition, and it is where the horizontal
    // separation actually earns its keep: with `padding-right` deleted the
    // overlap is 308px2 at EVERY narrow row here, against 0 in the empty
    // state at every one of them.
    await page.setViewportSize(STANDARD_VIEWPORTS.phonePortrait);
    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();
    await expect(originSection.locator('.endpoint-name')).toHaveText('Langballigau');

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();
    await expect(destSection.locator('.endpoint-name')).toHaveText('Sonderburg');

    // The onboarding guidance is what distinguishes the two states, so pin
    // that the state actually changed rather than sweeping the same DOM twice.
    await expect(plannerActions.locator('.planner-guidance')).toHaveCount(0);

    await sweep('endpoints');
  } finally {
    server.kill();
  }
});

test('#702: the sticky CTA also clears the attribution in ENGLISH, where the guidance wraps differently', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await clearPersistedProfile(page);
    // Set the language AFTER clearing, or the clear would wipe it again.
    await page.evaluate(() => window.localStorage.setItem('sc-lang', 'en'));
    await page.reload();
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();

    const attribution = page.locator('details.maplibregl-ctrl-attrib');
    await expect(attribution).toHaveClass(/maplibregl-compact(\s|$)/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Plan route' })).toHaveCount(1);
    await expect(page.locator('.planner-actions')).toHaveCount(1);

    // The bar's height depends on whether `.planner-guidance` wraps, which is
    // string-length dependent and therefore language dependent — measured
    // 2026-09-01 in German, the guidance wraps to two lines (bar 84px -> 100px)
    // at exactly these two widths and at narrowPortrait360. These are the
    // narrowest rows in the shared matrix, so they are where a longer English
    // string could wrap to a THIRD line and change the bar's height again.
    for (const name of ['wrapForcing280', 'deepPortrait320'] as const) {
      const viewport = EDGE_VIEWPORTS[name];
      await page.setViewportSize(viewport);
      const label = `${name} (${viewport.width}x${viewport.height}) / en`;
      await page.evaluate(() => {
        const panel = document.querySelector('.app-panel');
        if (panel) panel.scrollTop = 0;
      });
      await expect
        .poll(() => ctaReachableAtRest(page), { timeout: 15_000, message: label })
        .toMatch(/^ok /);
      await expect
        .poll(() => ctaVsAttributionToggleArea(page), { timeout: 15_000, message: label })
        .toMatch(/^overlapPx2=0 /);
      await expect
        .poll(() => ctaCornerTopmost(page, CTA_CORNER_INSET_PX), {
          timeout: 15_000,
          message: label,
        })
        .toBe('cta');
      await expect
        .poll(() => topmostOverAttributionAtRest(page, 'attribution-toggle'), {
          timeout: 15_000,
          message: label,
        })
        .toBe('attribution-toggle');
    }
  } finally {
    server.kill();
  }
});

test('#702: the WIDE sticky rule is untouched — negative control', async ({ page }) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await clearPersistedProfile(page);
    await page.reload();
    await page.getByRole('tab', { name: 'Planen' }).click();
    await expect(page.locator('.planner-actions')).toHaveCount(1);

    // Deliberately NOT the overflow/reachability predicate the narrow rows
    // use: `.app-panel` measured ZERO overflow at desktopHd and desktop4k, so
    // an overflow precondition would red on unmutated HEAD here. These rows
    // exist to prove the narrow-only rule changed nothing at wide, which is
    // what makes them an uncontaminated control for that rule's own mutation.
    //
    // It is also the keeper for the decision NOT to de-duplicate the two
    // width-scoped blocks: hoisting `padding-right` into the base rule reds
    // this immediately.
    for (const [name, viewport] of WIDE_CTA_VIEWPORTS) {
      await page.setViewportSize(viewport);
      const label = `${name} (${viewport.width}x${viewport.height})`;
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const bar = document.querySelector('.planner-actions');
              if (!bar) return 'missing:.planner-actions';
              const cs = getComputedStyle(bar);
              return `position=${cs.position} zIndex=${cs.zIndex} paddingRight=${cs.paddingRight} bottom=${cs.bottom}`;
            }),
          { timeout: 15_000, message: label },
        )
        .toBe('position=sticky zIndex=2 paddingRight=0px bottom=0px');
    }
  } finally {
    server.kill();
  }
});

// #829: keyboard-reachable via-point coordinate entry (spike
// docs/spikes/714-keyboard-map-equivalents.md §3.1/§5.1) — via-point
// placement was previously reachable ONLY through a MapView canvas click
// (`onRequestMapTap('via')` resolved by `instance.on('click', handleClick)`),
// a WCAG 2.1.1 (Keyboard) failure of a core function.
//
// #863 review MAJOR: an earlier revision of this test's own header claimed
// "purely via page.keyboard" while calling `.click()` on the reposition
// trigger button — the actual WCAG 2.1.1 deliverable for spike row 2
// (repositioning). Stating PRECISELY what is keyboard and what is not,
// rather than repeating that overstatement:
// - The map canvas is NEVER touched anywhere in this test (a MapLibre-
//   rendered feature has no DOM node to click anyway — CLAUDE.md).
// - Every ADD/UPDATE/reposition-trigger BUTTON is activated with
//   `.press('Enter')` (focuses the element, then dispatches a real Enter
//   keydown — never a mouse click), including the reposition trigger below.
// - The lat/lon NumberInputs are focused with `.click()` before typing —
//   an ordinary way to move focus into a text field, not a map interaction,
//   and not the control this test exists to prove is keyboard-operable.
// - The initial tab switch (`Planen`) also uses `.click()` — reaching the
//   Plan tab is not part of this issue's scope; only the via-point controls
//   inside it are.
test('#829: adds, repositions and rejects a via point by typing coordinates — never a map-tap/canvas interaction', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await page.getByRole('tab', { name: 'Planen' }).click();

    const viaSection = page.getByRole('region', { name: 'Wegpunkte' });
    const latInput = viaSection.getByLabel('Breitengrad');
    const lonInput = viaSection.getByLabel('Längengrad');
    const items = viaSection.getByRole('listitem');

    // Add: type a valid coordinate pair and activate "Koordinaten
    // hinzufügen" purely via the keyboard (Locator.press focuses the
    // element and dispatches a real Enter keydown — never a mouse click on
    // the button, and nothing here ever touches the map).
    await latInput.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('54.85');
    await lonInput.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('10.1');
    await viaSection.getByRole('button', { name: 'Koordinaten hinzufügen' }).press('Enter');

    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('54.850°N 10.100°E');

    // Reposition: activating the placed point's own coordinate button enters
    // "update" mode and moves focus to the latitude field (#695: driven from
    // the click callback, verified here in a real browser, not jsdom).
    // `.press('Enter')` — same method the Add/Update button uses above —
    // focuses the element and dispatches a real Enter keydown; this is the
    // WCAG 2.1.1 deliverable for spike row 2 (repositioning), so it must be
    // activated by keyboard, never `.click()` (#863 review MAJOR).
    await viaSection
      .getByRole('button', { name: /Koordinaten bearbeiten \(Punkt 1\)/ })
      .press('Enter');
    await expect(latInput).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('54.9');
    await lonInput.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('10');
    await viaSection.getByRole('button', { name: 'Koordinaten aktualisieren' }).press('Enter');

    // Still exactly one point — repositioned, never appended.
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('54.900°N 10.000°E');

    // Reject: a value north of DATA_AREA's 55.3°N bound is refused, with the
    // new message shown, and the placed point is left untouched.
    await latInput.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('60');
    await viaSection.getByRole('button', { name: 'Koordinaten hinzufügen' }).press('Enter');

    await expect(
      page.getByText(
        'Die Koordinaten liegen außerhalb des abgedeckten Seegebiets (Flensburger Förde / Dänische Südsee).',
      ),
    ).toBeVisible();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('54.900°N 10.000°E');
  } finally {
    server.kill();
  }
});
