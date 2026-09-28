import { test, expect, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

// #629 depth contours — reachable pre-plan (same always-mounted
// `.depth-legend` cluster the hatch toggle uses, #598/#681), default OFF,
// fetched on first enable, and drawn/labelled at a real zoom. Self-contained
// per this file's own convention (every page.evaluate() callback is
// re-parsed in the browser realm, sharing no closure with any other spec —
// see datalayers.spec.ts's #682 test comment for the same statement).

interface Sc629TestMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  queryRenderedFeatures(options: { layers: string[] }): Array<{ properties: unknown }>;
}

// Wackerballig's own approach — reused from datalayers.spec.ts's #599/#648
// hatch test, a known marginal/shallow area with committed contour data
// nearby.
const CONTOUR_VIEW: { center: [number, number]; zoom: number } = {
  center: [9.872, 54.7604],
  zoom: 13,
};

async function jumpToContourView(page: Page): Promise<void> {
  await page.evaluate((view) => {
    (window as unknown as { __scE2eMap: Sc629TestMap }).__scE2eMap.jumpTo(view);
  }, CONTOUR_VIEW);
}

async function renderedFeatureCount(page: Page, layer: string): Promise<number> {
  return page.evaluate(
    (l) =>
      (window as unknown as { __scE2eMap: Sc629TestMap }).__scE2eMap.queryRenderedFeatures({
        layers: [l],
      }).length,
    layer,
  );
}

// Same settle shape as labels.spec.ts's settledPlacedLabels / datalayers.spec.ts's
// settledOrderedHazardFlags — three consecutive matching reads at 400ms,
// exceeding maplibre's placement throttle (CLAUDE.md's `Placement.stillRecent`
// derivation), failing CLOSED with the read history rather than a bare
// boolean.
const SETTLE_POLL_INTERVAL_MS = 400;
const SETTLE_STABLE_READS_REQUIRED = 3;
const SETTLE_MAX_READS = 27;

async function settledFeatureCount(page: Page, layer: string, label: string): Promise<number> {
  const history: number[] = [];
  const recent: number[] = [];
  const first = await renderedFeatureCount(page, layer);
  history.push(first);
  recent.push(first);
  for (let extra = 1; extra <= SETTLE_MAX_READS; extra++) {
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    const next = await renderedFeatureCount(page, layer);
    history.push(next);
    recent.push(next);
    if (recent.length > SETTLE_STABLE_READS_REQUIRED) recent.shift();
    if (recent.length === SETTLE_STABLE_READS_REQUIRED && recent.every((r) => r === recent[0])) {
      return next;
    }
  }
  throw new Error(
    `[${label}] ${layer} feature count never stabilized across ${history.length} reads ` +
      `(${SETTLE_POLL_INTERVAL_MS}ms apart, ${SETTLE_STABLE_READS_REQUIRED} consecutive matches required); ` +
      `reads seen: ${JSON.stringify(history)}`,
  );
}

test('depth contours (#629): fresh profile has them off, toggling on draws lines/labels and never breaks the base depth toggle or basemap labels', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);

    // #629 Q7: default OFF for a fresh profile.
    const summary = page.getByText('Legende', { exact: true });
    await summary.click();
    const contoursToggle = page.getByRole('checkbox', { name: 'Tiefenlinien' });
    await expect(contoursToggle).toBeVisible();
    await expect(contoursToggle).not.toBeChecked();

    // "Wassertiefen" and "Tiefenlinien" are both live checkbox names on this
    // page at once — Playwright's getByRole matches by SUBSTRING unless
    // `exact`, so this line is itself the CLAUDE.md #681-style regression
    // guard: it would fail with a strict-mode violation if either label
    // collided with the other's accessible name.
    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await expect(depthToggle).toBeChecked();

    await mapReady(page);
    await jumpToContourView(page);

    // No contour features rendered while the toggle is off — the source was
    // never even fetched (fresh profile).
    expect(await renderedFeatureCount(page, 'sc-contour-lines')).toBe(0);

    await contoursToggle.check();
    await expect(contoursToggle).toBeChecked();

    const lineCount = await settledFeatureCount(page, 'sc-contour-lines', 'sc-contour-lines');
    expect(lineCount).toBeGreaterThan(0);
    const labelCount = await settledFeatureCount(page, 'sc-contour-labels', 'sc-contour-labels');
    expect(labelCount).toBeGreaterThan(0);

    // #629 maintainer ruling: contour labels must yield to basemap labels,
    // never displace them — places_locality still places at least one label
    // at this view (the same signal labels.spec.ts's own #320 guard reads).
    const localityCount = await settledFeatureCount(page, 'places_locality', 'places_locality');
    expect(localityCount).toBeGreaterThan(0);
  } finally {
    server.kill();
  }
});
