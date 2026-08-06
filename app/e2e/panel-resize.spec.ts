import { test, expect, type Locator, type Page } from '@playwright/test';
import { startPreview, mapReady, STANDARD_VIEWPORTS, EDGE_VIEWPORTS } from './helpers';

// #355: the resizable desktop left panel. Wide-only (>=1024px, see
// useWideLayout.ts) — layout.spec.ts already covers the base wide/narrow
// grid geometry; this spec is scoped to the NEW resize affordance itself.
//
// Blind spots stated explicitly (CLAUDE.md framing rule) rather than left
// implicit:
//   - Nothing here asserts anything DURING a drag. Every gate in this suite
//     polls a post-settle state signal (CLAUDE.md's E2E determinism rule),
//     and "the map renders correctly during a drag" has no Playwright
//     observable in this suite at all — see the PR description for the
//     source-level argument (MapLibre's own container ResizeObserver,
//     confirmed still present in the installed maplibre-gl@6.1.0, plus the
//     static grep-checkable guarantee that this change adds no second
//     resize path). Demanding a mid-drag assertion here would reproduce the
//     #368 shape: a test "proving" a window this suite cannot observe,
//     passing even against a broken implementation.
//   - Discoverability/feel of the handle (is an invisible 1px strip enough
//     to notice?) is a design judgement, not something a bounding-box
//     assertion can verify.
//   - Table LEGIBILITY at a wide setting (below) is pure geometry —
//     `scrollWidth <= clientWidth` says nothing about whether the columns
//     are readable, only that they fit.
//
// Bounds below (320 floor, `min(70vw, viewport-480)` ceiling) are the
// maintainer's own numbers (lib/panelWidth.ts) restated as literals — e2e
// specs in this repo already do this for other layout ratios (layout.spec's
// `1280 * 0.5`, `800 * 0.9`, etc.); panelWidth.test.ts is the one place that
// exercises the formula independently.
const MIN_PANEL_PX = 320;
const MAP_RESERVE_PX = 480;
const MAX_VIEWPORT_FRACTION = 0.7;
function expectedMaxPanelPx(viewportWidth: number): number {
  return Math.max(
    MIN_PANEL_PX,
    Math.min(viewportWidth * MAX_VIEWPORT_FRACTION, viewportWidth - MAP_RESERVE_PX),
  );
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('expected element to have a bounding box (is it visible?)');
  return b;
}

/** Drags the separator by `dx` px via real mouse events (dispatches genuine
    pointer events in Chromium — this is a real browser, not jsdom). */
async function dragSeparatorBy(page: Page, separator: Locator, dx: number) {
  const b = await box(separator);
  const startX = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  // A few intermediate steps, not one jump — closer to a real drag and
  // exercises more than a single pointermove.
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, y);
  }
  await page.mouse.up();
}

/** Drags the separator OUT to an intermediate position and back to its exact
    starting x — a net-zero-movement drag. Real pointermoves are dispatched
    along the way (unlike a plain click), so `writeLive` genuinely writes an
    intermediate, never-committed `--sc-panel-w` before the release. */
async function dragSeparatorOutAndBack(page: Page, separator: Locator, outDx: number) {
  const b = await box(separator);
  const startX = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + outDx / 2, y);
  await page.mouse.move(startX + outDx, y);
  await page.mouse.move(startX + outDx / 2, y);
  await page.mouse.move(startX, y);
  await page.mouse.up();
}

async function panelCssVar(page: Page): Promise<string> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    return shell ? shell.style.getPropertyValue('--sc-panel-w') : '(no shell)';
  });
}

test.describe('#355 resizable panel', () => {
  test('drag resizes and persists across reload; keyboard steps too', async ({ page }) => {
    const server = await startPreview();
    try {
      await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
      await page.goto(server.url);
      await mapReady(page);

      const panel = page.locator('.app-bottom-sheet');
      const canvas = page.locator('canvas.maplibregl-canvas');
      const separator = page.getByRole('separator', { name: 'Panelbreite anpassen' });
      await expect(separator).toBeVisible();

      const defaultWidth = (await box(panel)).width;
      const defaultCanvasWidth = (await box(canvas)).width;

      // Drag right by 200px and commit (mouseup).
      await dragSeparatorBy(page, separator, 200);
      // The panel's OWN width is safe to read immediately: it is driven by
      // OUR `--sc-panel-w` write (App.tsx's useLayoutEffect, synchronous
      // with the React commit that follows `onCommit`), not by any
      // externally-throttled observer. The map CANVAS below is the one
      // that genuinely lags (see its own comment).
      const draggedWidth = (await box(panel)).width;
      // Must have actually moved, and moved in the dragged direction — the
      // vacuity trap this design explicitly calls out: without a contrast
      // against the untouched default, a no-op drag would pass too.
      expect(draggedWidth).toBeGreaterThan(defaultWidth + 100);
      // `aria-valuenow` is driven by PanelResizer's OWN `ResizeObserver` on
      // the panel element — a REAL (unthrottled by us, but still async)
      // browser ResizeObserver callback, which lags the DOM commit by at
      // least one frame. Poll, don't read once (#412-shaped: a bare
      // one-shot read right after the action samples pre-settle geometry).
      // Playwright's own "Expected/Received" diagnostic already names the
      // exact px string here, so no custom message is needed.
      await expect
        .poll(() => separator.getAttribute('aria-valuenow'))
        .toBe(String(Math.round(draggedWidth)));

      // #355 acceptance: "the map renders correctly ... after a drag" — the
      // testable half (see this file's header comment for why "during" is
      // not). MapLibre's own container ResizeObserver (source-level
      // argument, PanelResizer.tsx's comment) must have shrunk the canvas
      // by roughly the same amount the panel grew — not just "some smaller
      // number", a real reflow proportional to the actual panel growth.
      //
      // #412-shaped defect, fixed here: MapLibre throttles its own
      // resize+redraw to one call per 50ms (installed maplibre-gl@6.1.0,
      // `ui/map.ts:3977-3994`, `_setupResizeObserver`'s `throttle(..., 50)`)
      // — reading the canvas box in the SAME TICK as `mouse.up()` can
      // sample PRE-resize geometry and pass or fail for reasons unrelated
      // to the behaviour under test. Poll until settled instead.
      const panelGrowth = draggedWidth - defaultWidth;
      let lastCanvasWidth = defaultCanvasWidth;
      let lastDeltaAbs = Math.abs(defaultCanvasWidth - defaultCanvasWidth - panelGrowth);
      try {
        await expect
          .poll(async () => {
            lastCanvasWidth = (await box(canvas)).width;
            const canvasShrink = defaultCanvasWidth - lastCanvasWidth;
            lastDeltaAbs = Math.abs(canvasShrink - panelGrowth);
            return lastDeltaAbs;
          })
          .toBeLessThan(5);
      } catch (e) {
        // `expect.poll`'s `message` option must be a static string
        // (Playwright's own type: `string | {message?: string, ...}` — no
        // function form), so the ACTUAL observed values (not just the last
        // polled number) are attached here instead, on top of Playwright's
        // own diagnostic, for a 3am CI failure to be diagnosable without a
        // local re-run.
        throw new Error(
          `canvas did not reflow to match the panel drag: ` +
            `defaultCanvasWidth=${defaultCanvasWidth}px, canvasWidth=${lastCanvasWidth}px, ` +
            `panelWidth=${draggedWidth}px, panelGrowth=${panelGrowth}px, ` +
            `|canvasShrink-panelGrowth|=${lastDeltaAbs}px (want <5px)\n${(e as Error).message}`,
        );
      }

      // Reload: the committed width, not the default, must come back.
      await page.reload();
      await mapReady(page);
      const reloadedWidth = (await box(page.locator('.app-bottom-sheet'))).width;
      expect(Math.abs(reloadedWidth - draggedWidth)).toBeLessThan(3);

      // Keyboard: focus + 5x ArrowRight steps the width up by exactly
      // 5*16=80px. Five rapid presses, not one, and an EXACT expected delta
      // rather than a loose ">" bound: PanelResizer.tsx's own comment
      // documents a real race this pins — OS key-repeat can fire the next
      // ArrowRight before React has committed the previous step's
      // re-render, and a naive handler reading React state directly
      // collapses N rapid presses into one net step (measured live: two
      // fast presses moved the panel by one 16px increment, not two, before
      // the `committedRef` fix). A loose bound would not have caught that.
      const separatorAfterReload = page.getByRole('separator', { name: 'Panelbreite anpassen' });
      await separatorAfterReload.focus();
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight');
      }
      const expectedAfterKeyboard = Math.round(reloadedWidth) + 5 * 16;
      await expect
        .poll(() => separatorAfterReload.getAttribute('aria-valuenow'))
        .toBe(String(expectedAfterKeyboard));
      // Panel width itself is our own synchronous write (see the comment on
      // `draggedWidth` above), but poll it too — uniform `expect.poll`
      // throughout this file rather than mixing one-shot and polled reads
      // of related state.
      await expect
        .poll(async () =>
          Math.abs((await box(page.locator('.app-bottom-sheet'))).width - expectedAfterKeyboard),
        )
        .toBeLessThan(3);

      // Enter resets to the CSS default — back to (approximately) the
      // original unresized width, not merely "some smaller number".
      await page.keyboard.press('Enter');
      await expect
        .poll(async () =>
          Math.abs((await box(page.locator('.app-bottom-sheet'))).width - defaultWidth),
        )
        .toBeLessThan(3);
    } finally {
      server.kill();
    }
  });

  test('an extreme drag clamps to the min/max bounds rather than overshooting', async ({
    page,
  }) => {
    const server = await startPreview();
    try {
      await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
      await page.goto(server.url);
      await mapReady(page);

      const panel = page.locator('.app-bottom-sheet');
      const separator = page.getByRole('separator', { name: 'Panelbreite anpassen' });

      // Drag far left, past the floor. Panel width is our own synchronous
      // write (safe to read once, see the first test's comment on
      // `draggedWidth`); `aria-valuenow` is PanelResizer's OWN
      // `ResizeObserver` on the panel — a real async browser callback that
      // lags the commit by at least a frame, so it needs `expect.poll`
      // (#412-shaped, same fix as the first test).
      await dragSeparatorBy(page, separator, -5000);
      const minWidth = (await box(panel)).width;
      expect(Math.abs(minWidth - MIN_PANEL_PX)).toBeLessThan(3);
      await expect.poll(() => separator.getAttribute('aria-valuenow')).toBe(String(MIN_PANEL_PX));

      // Drag far right, past the ceiling.
      await dragSeparatorBy(page, separator, 8000);
      const maxWidth = (await box(panel)).width;
      const expectedMax = expectedMaxPanelPx(STANDARD_VIEWPORTS.desktopHd.width);
      expect(Math.abs(maxWidth - expectedMax)).toBeLessThan(5);
      await expect
        .poll(() => separator.getAttribute('aria-valuenow'))
        .toBe(String(Math.round(expectedMax)));

      // Home/End reach the same bounds via keyboard. `aria-valuenow` polled
      // for the same async-ResizeObserver reason as above; panel width read
      // once since it is our own synchronous commit.
      await separator.focus();
      await page.keyboard.press('Home');
      await expect.poll(() => separator.getAttribute('aria-valuenow')).toBe(String(MIN_PANEL_PX));
      expect(Math.abs((await box(panel)).width - MIN_PANEL_PX)).toBeLessThan(3);
      await page.keyboard.press('End');
      await expect
        .poll(() => separator.getAttribute('aria-valuenow'))
        .toBe(String(Math.round(expectedMax)));
      expect(Math.abs((await box(panel)).width - expectedMax)).toBeLessThan(3);
    } finally {
      server.kill();
    }
  });

  // PR #414 review, Minor 4 (MEASURED, user-facing): a drag that moves the
  // pointer and returns to its exact starting x must NOT pin the panel to
  // an explicit px width. `handlePointerMove` writes an INTERMEDIATE,
  // never-committed `--sc-panel-w` via `writeLive` as the pointer moves;
  // `endDrag`'s zero-net-movement guard used to `return` without cleaning
  // that write up, leaving it on `.app-shell` even though nothing was ever
  // persisted — silently converting the responsive `1fr` default into a
  // fixed width that stops reflowing with the window.
  test('a net-zero-movement drag does not pin the panel to a fixed width', async ({ page }) => {
    const server = await startPreview();
    try {
      await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
      await page.goto(server.url);
      await mapReady(page);

      const panel = page.locator('.app-bottom-sheet');
      const separator = page.getByRole('separator', { name: 'Panelbreite anpassen' });
      await expect(separator).toBeVisible();

      expect(await panelCssVar(page)).toBe(''); // no override yet — CSS `1fr` governs
      const defaultWidth = (await box(panel)).width;

      await dragSeparatorOutAndBack(page, separator, 250);

      // The property must be back to unset — not merely "close to the old
      // width", which a leftover inline write would also satisfy.
      await expect.poll(() => panelCssVar(page)).toBe('');
      // #412-shaped, caught in review (this file's OWN ninth+ instance of the
      // fix it introduced): `panelCssVar` above reads a value WE write
      // synchronously in `endDrag` (a direct `.style` mutation), so that
      // poll settles on its very first check and grants no real wait time.
      // `aria-valuenow` is a DIFFERENT signal — PanelResizer's own
      // `ResizeObserver` on the panel, a real async browser callback that
      // lags the commit by at least a frame — so it needs its OWN poll, not
      // a free ride on the settle above.
      await expect
        .poll(() => separator.getAttribute('aria-valuenow'))
        .toBe(String(Math.round(defaultWidth)));

      // The real behavioural check: the panel must still be RESPONSIVE
      // (`1fr`-driven) after the no-op drag, not pinned at the old absolute
      // px. Shrink the viewport and confirm the panel width tracks the new
      // 1/3-ish share rather than staying frozen near `defaultWidth`.
      const narrower = { width: 1400, height: 900 };
      await page.setViewportSize(narrower);
      await expect.poll(async () => (await box(panel)).width).toBeLessThan(defaultWidth - 50);
    } finally {
      server.kill();
    }
  });

  test('the nine-column legs table fits at a wide setting, and does not at the default width', async ({
    page,
  }) => {
    const server = await startPreview();
    try {
      await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
      await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
      await mapReady(page);

      const originSection = page.getByRole('region', { name: 'Start' });
      await originSection.getByRole('combobox').fill('Langballigau');
      await expect(originSection.getByRole('option')).toHaveCount(1);
      await originSection.getByRole('option').first().click();

      const destSection = page.getByRole('region', { name: 'Ziel' });
      await destSection.getByRole('combobox').fill('Sønderborg');
      await expect(destSection.getByRole('option')).toHaveCount(1);
      await destSection.getByRole('option').first().click();

      const planButton = page.getByRole('button', { name: 'Route planen' });
      await planButton.click();
      await expect(planButton).toBeEnabled({ timeout: 60_000 });

      await page.getByRole('tab', { name: 'Routen' }).click();
      // Expand the disclosure — it is collapsed by default, and a check
      // that forgets this measures a `<details>` with no rows in the
      // layout at all and would pass trivially.
      await page.locator('.route-legs-disclosure > summary').click();
      const legRows = page.locator('.route-legs tbody tr');
      await expect(legRows.first()).toBeVisible({ timeout: 60_000 });
      expect(await legRows.count()).toBeGreaterThan(0);

      // Nine headers, in order — the #379 final column count this table
      // reached before #355 could be built against it (PR #410).
      const headers = page.locator('.route-legs thead th');
      await expect(headers).toHaveText([
        'Zeit',
        'Dauer',
        'Art',
        'COG',
        'TWA',
        'TWS',
        'Geschwindigkeit',
        'Distanz',
        'Manöver',
      ]);

      const table = page.locator('.route-legs');
      // scrollWidth - clientWidth: positive means overflowing (scrollable),
      // <=0 means it fits. Poll THIS number, never a collapsed boolean — a
      // bare `.toBe(true)` here would report only pass/timeout on a CI
      // failure, discarding the actual pixel deltas (CLAUDE.md's #243
      // lesson: poll the value, assert the condition on it).
      const overflowPx = () => table.evaluate((el) => el.scrollWidth - el.clientWidth);

      // At the default (unresized) width: the contract is lossless
      // horizontal SCROLL, not a fit — assert the overflow the design
      // explicitly keeps, so a future column-drop "fix" would fail here
      // instead of silently changing the table's contract.
      await expect.poll(overflowPx).toBeGreaterThan(0);

      // Drag to max width: now it must fit with no horizontal overflow.
      const separator = page.getByRole('separator', { name: 'Panelbreite anpassen' });
      await dragSeparatorBy(page, separator, 8000);
      await expect.poll(overflowPx).toBeLessThanOrEqual(0);
    } finally {
      server.kill();
    }
  });

  const NARROW_VIEWPORTS = {
    tabletPortrait: STANDARD_VIEWPORTS.tabletPortrait,
    phonePortrait: STANDARD_VIEWPORTS.phonePortrait,
    narrowPortrait360: EDGE_VIEWPORTS.narrowPortrait360,
  };
  for (const [label, viewport] of Object.entries(NARROW_VIEWPORTS)) {
    test(`narrow layout (${label}, ${viewport.width}x${viewport.height}) has no resize affordance`, async ({
      page,
    }) => {
      const server = await startPreview();
      try {
        await page.setViewportSize(viewport);
        await page.goto(server.url);
        await mapReady(page);

        // Not merely hidden — ABSENT. A hidden-but-mounted separator would
        // still sit in the a11y tree and the tab order (design doc §3.5).
        await expect(page.locator('[role="separator"]')).toHaveCount(0);

        // The bottom-sheet overlay keeps its normal narrow geometry —
        // docked low, not stretched into some intermediate state by a
        // stale `--sc-panel-w` (app.css only reads that property inside
        // the wide `@media` block, so this is mostly a static guarantee,
        // but pin the geometry too rather than trust that alone).
        const panel = page.locator('.app-bottom-sheet');
        await expect.poll(async () => (await panel.boundingBox())?.y ?? 0).toBeGreaterThan(50);
      } finally {
        server.kill();
      }
    });
  }
});
