import { test, expect, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

// #629 depth contours — reachable pre-plan (a row of DataLayers' "Anzeigeoptionen"
// disclosure since #1541, open by default at this spec's wide viewport),
// default OFF, fetched on first enable, and drawn/labelled at a real zoom. Self-contained
// per this file's own convention (every page.evaluate() callback is
// re-parsed in the browser realm, sharing no closure with any other spec —
// see datalayers.spec.ts's #682 test comment for the same statement).

interface Sc629TestMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  queryRenderedFeatures(options: { layers: string[] }): Array<{ properties: { name?: unknown } }>;
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

// Sorted `name` array — the SAME identity-comparison basis labels.spec.ts's
// own settledPlacedLabels uses, so a same-count SWAP (a contour label
// displacing one basemap label while another takes its place) is caught,
// not just a count.
async function renderedFeatureNames(page: Page, layer: string): Promise<string[]> {
  return page.evaluate(
    (l) =>
      (window as unknown as { __scE2eMap: Sc629TestMap }).__scE2eMap
        .queryRenderedFeatures({ layers: [l] })
        .map((f) => f.properties.name)
        .filter((name): name is string => typeof name === 'string')
        .sort(),
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

// Same settle shape as settledFeatureCount above, over the sorted NAME array
// instead of a count — a same-count swap (labels.spec.ts's own identity-
// comparison rationale) would pass a count-only settle but not this one.
async function settledFeatureNames(page: Page, layer: string, label: string): Promise<string[]> {
  const history: string[][] = [];
  const recent: string[][] = [];
  const first = await renderedFeatureNames(page, layer);
  history.push(first);
  recent.push(first);
  for (let extra = 1; extra <= SETTLE_MAX_READS; extra++) {
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    const next = await renderedFeatureNames(page, layer);
    history.push(next);
    recent.push(next);
    if (recent.length > SETTLE_STABLE_READS_REQUIRED) recent.shift();
    if (
      recent.length === SETTLE_STABLE_READS_REQUIRED &&
      recent.every((r) => JSON.stringify(r) === JSON.stringify(recent[0]))
    ) {
      return next;
    }
  }
  throw new Error(
    `[${label}] ${layer} label set never stabilized across ${history.length} reads ` +
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

    // Settled BEFORE toggling contours on — the basemap-label identity this
    // test compares against once contours are on. `not.toBeChecked()` above
    // already pins default-off; the ex-toggle absence read this replaced
    // was unsettled (read right after jumpTo, before anything had rendered)
    // and reads 0 whether contours are on or off, so it proved nothing.
    const namesBeforeContours = await settledFeatureNames(
      page,
      'places_locality',
      'places_locality (before contours)',
    );
    // Non-vacuity: the identity comparison below proves nothing over two
    // empty reads.
    expect(namesBeforeContours.length).toBeGreaterThan(0);

    await contoursToggle.check();
    await expect(contoursToggle).toBeChecked();

    await expect
      .poll(() => renderedFeatureCount(page, 'sc-contour-lines'), {
        timeout: 30_000,
        message: 'sc-contour-lines rendered feature count after toggle-on',
      })
      .toBeGreaterThan(0);
    const lineCount = await settledFeatureCount(page, 'sc-contour-lines', 'sc-contour-lines');
    expect(lineCount).toBeGreaterThan(0);
    await expect
      .poll(() => renderedFeatureCount(page, 'sc-contour-labels'), {
        timeout: 30_000,
        message: 'sc-contour-labels rendered feature count after toggle-on',
      })
      .toBeGreaterThan(0);
    const labelCount = await settledFeatureCount(page, 'sc-contour-labels', 'sc-contour-labels');
    expect(labelCount).toBeGreaterThan(0);

    // #629 maintainer ruling: contour labels must yield to basemap labels,
    // never displace them — the placed places_locality NAME SET is
    // unchanged by turning contours on (an identity comparison, the same
    // basis labels.spec.ts's own #320 guard uses, catches a same-count
    // swap a bare `> 0` cannot).
    const namesAfterContours = await settledFeatureNames(
      page,
      'places_locality',
      'places_locality (after contours)',
    );
    expect(namesAfterContours).toEqual(namesBeforeContours);

    // Positive control for the toggle-off half: unchecking removes the
    // rendered contour features again (the pair of ends `settledFeatureCount`
    // alone, from the ON side, could not show).
    await contoursToggle.uncheck();
    await expect(contoursToggle).not.toBeChecked();
    await expect
      .poll(() => renderedFeatureCount(page, 'sc-contour-lines'), {
        timeout: 30_000,
        message: 'sc-contour-lines rendered feature count after toggle-off',
      })
      .toBe(0);
  } finally {
    server.kill();
  }
});
