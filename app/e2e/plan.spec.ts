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
  const server = await startPreview();
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
    await page.getByRole('button', { name: 'Abbrechen' }).click();
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
  const server = await startPreview();
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
// while the bar is `position: static` (narrow layout). It is not:
// `.planner-panel` is `display: flex`, so `.planner-actions` is a FLEX ITEM,
// and per css-flexbox-1's "Painting Flex Items" rule a flex item's `z-index`
// other than `auto` creates a stacking context EVEN WHILE `position: static`.
// That tied `.maplibregl-ctrl-bottom-right`'s own `z-index: 2` and won on DOM
// order, so the CTA's own `p.planner-guidance` painted over the attribution
// toggle and swallowed its clicks. app.css's `.planner-actions` rule carries
// the mechanism and the measurement; the fix scopes `bottom`/`z-index` to the
// wide-only rule, where `position: sticky` actually applies.
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
// Iterates the shared matrix rather than inlining literals. The wide entries
// (desktop4k/desktopHd/tabletLandscape) cannot reproduce this defect — there
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
  const server = await startPreview();
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
