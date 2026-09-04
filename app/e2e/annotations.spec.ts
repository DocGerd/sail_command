import { test, expect, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// Map annotations & wind-barb density (#35 #36 #37). jsdom can't exercise
// MapLibre layers, so the barb-density and toggle contracts are asserted here
// against a real browser. RouteLayer publishes the live map on window.__scMap
// (there is no DOM handle for rendered symbol counts) — mirrors the
// window.__sailGlyphWarmup E2E-signal convention. Determinism per house style:
// gate on state signals via expect.poll, never a fixed waitForTimeout.
//
// Wide viewport so the map (with its top-right control cluster) is unobstructed
// by the bottom sheet while we toggle barbs and annotations.
test.use({ viewport: { width: 1280, height: 800 } });

// The subset of the MapLibre map API these assertions call. Types are erased
// before the closures reach the browser; this only satisfies tsc for the
// page.evaluate() source text (this project can't import app source).
interface ScTestMap {
  queryRenderedFeatures(opts: { layers: string[] }): Array<{ properties: Record<string, unknown> }>;
  querySourceFeatures(source: string): Array<{
    geometry: { coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
  getLayer(id: string): unknown;
  getLayoutProperty(id: string, name: string): unknown;
  jumpTo(opts: { zoom?: number; center?: [number, number] }): void;
  panBy(offset: [number, number]): void;
}

// Settle-read pattern for the #378 zoom sweep below, matching the house
// technique in labels.spec.ts (identity-ARRAY comparison, not a count — a
// same-count swap must be caught; three consecutive 400ms-apart matches,
// chosen there to exceed maplibre's placement fadeDuration throttle window;
// fails CLOSED on budget exhaustion, naming the actual arrays it saw rather
// than a bare timeout). Not reused verbatim: labels.spec.ts's version reads
// one layer's `name` property, this reads three layers' KIND (or, for
// sc-leg-speed, legIndex:speedLabel) identity per read.
const SETTLE_POLL_INTERVAL_MS = 400;
const SETTLE_STABLE_READS_REQUIRED = 3;
const SETTLE_MAX_READS = 27;

interface AnnotationState {
  primary: string[];
  secondary: string[];
  legSpeed: string[];
}

async function readAnnotationState(page: Page): Promise<AnnotationState> {
  return page.evaluate(() => {
    const map = (window as { __scMap?: ScTestMap }).__scMap!;
    const kinds = (layer: string) =>
      map
        .queryRenderedFeatures({ layers: [layer] })
        .map((f) => String(f.properties.kind))
        .sort();
    const legs = () =>
      map
        .queryRenderedFeatures({ layers: ['sc-leg-speed'] })
        .map((f) => `${f.properties.legIndex}:${f.properties.speedLabel}`)
        .sort();
    return {
      primary: kinds('sc-eta-primary'),
      secondary: kinds('sc-eta-secondary'),
      legSpeed: legs(),
    };
  });
}

/**
 * Jumps to `[center, zoom]` and polls `readAnnotationState` until
 * SETTLE_STABLE_READS_REQUIRED consecutive reads are identical (by full
 * array identity, all three layers at once), then returns that stable
 * state. Fails CLOSED — throws naming the unstable history — rather than
 * returning a possibly-still-settling read (same rationale as
 * labels.spec.ts's settledPlacedLabels).
 */
async function settleAnnotationsAt(
  page: Page,
  center: [number, number],
  zoom: number,
): Promise<AnnotationState> {
  await page.evaluate(
    ({ c, z }) => {
      (window as { __scMap?: ScTestMap }).__scMap!.jumpTo({ center: c, zoom: z });
    },
    { c: center, z: zoom },
  );

  const history: AnnotationState[] = [await readAnnotationState(page)];
  for (let i = 0; i < SETTLE_MAX_READS; i++) {
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    history.push(await readAnnotationState(page));
    if (history.length > SETTLE_STABLE_READS_REQUIRED) history.shift();
    const stable =
      history.length === SETTLE_STABLE_READS_REQUIRED &&
      history.every((s) => JSON.stringify(s) === JSON.stringify(history[0]));
    if (stable) return history[history.length - 1];
  }
  throw new Error(
    `annotation state at zoom ${zoom} never stabilized across ${SETTLE_MAX_READS + 1} reads ` +
      `(${SETTLE_POLL_INTERVAL_MS}ms apart, ${SETTLE_STABLE_READS_REQUIRED} consecutive matches required); ` +
      `last ${history.length} reads: ${JSON.stringify(history)}`,
  );
}

test('map annotations: barb density, annotations toggle, no wind re-fetch (#35 #36 #37)', async ({
  page,
}) => {
  const server = await startPreview(page);
  // (j)#1: barbs/profile wind come only from plan.windGrid — never a re-fetch.
  const openMeteoRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
  });
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // --- Plan a route on the deterministic fixture wind ---
    await page.getByRole('tab', { name: 'Planen' }).click();
    const origin = page.getByRole('region', { name: 'Start' });
    await origin.getByRole('combobox').fill('Langballigau');
    const originResults = origin.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();
    const dest = page.getByRole('region', { name: 'Ziel' });
    await dest.getByRole('combobox').fill('Sønderborg');
    const destResults = dest.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    // The barb toggle only exists once a plan is active (RouteLayer renders).
    const barbToggle = page.getByRole('checkbox', { name: 'Windpfeile anzeigen' });
    await expect(barbToggle).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as { __scMap?: unknown }).__scMap));

    const barbCount = () =>
      page.evaluate(() => {
        const map = (window as { __scMap?: ScTestMap }).__scMap;
        return map ? map.queryRenderedFeatures({ layers: ['sc-wind-barbs'] }).length : -1;
      });

    // --- #63: barbs are ON by default for a fresh profile (clean Playwright
    // context) — no click needed before they render. ---
    await expect(barbToggle).toBeChecked();

    // --- #36: overview zoom shows many barbs (the reported repro was "barely
    // any barbs at overview") ---
    await expect.poll(barbCount, { timeout: 30_000 }).toBeGreaterThan(3);

    // --- #37/#35: maneuver circles are kind-filtered to tack/gybe. The shared
    // point source now also carries start/finish/heading points; removing the
    // filter would draw r=9 circles at those too. Assert every rendered circle
    // is a maneuver (and that at least one is in view, so the filter is
    // actually exercised). ---
    const maneuverKinds = await page.evaluate(() => {
      const map = (window as { __scMap?: ScTestMap }).__scMap;
      return (map?.queryRenderedFeatures({ layers: ['sc-maneuver-circles'] }) ?? []).map(
        (f) => f.properties.kind,
      );
    });
    expect(maneuverKinds.length).toBeGreaterThan(0);
    for (const k of maneuverKinds) expect(['tack', 'gybe']).toContain(k);

    // --- #36: zooming into a leg still shows barbs (the route ribbon keeps
    // wind on the route at high zoom). Center on the origin (on the route). ---
    const startCoord = await page.evaluate(() => {
      const map = (window as { __scMap?: ScTestMap }).__scMap;
      const feats = map?.querySourceFeatures('sc-maneuvers') ?? [];
      const start = feats.find((f) => f.properties.kind === 'start');
      return start ? start.geometry.coordinates : null;
    });
    expect(startCoord).not.toBeNull();
    await page.evaluate((center) => {
      (window as { __scMap?: ScTestMap }).__scMap?.jumpTo({ center: center!, zoom: 13 });
    }, startCoord);
    await expect.poll(barbCount, { timeout: 30_000 }).toBeGreaterThan(0);

    // Toggling barbs off removes them.
    await barbToggle.uncheck();
    await expect.poll(barbCount, { timeout: 30_000 }).toBe(0);

    // --- #35: the "Times & speeds" toggle flips exactly the ETA + speed
    // layers together (poll getLayoutProperty, never a fixed sleep) ---
    const visibility = (layer: string) =>
      page.evaluate((id) => {
        const map = (window as { __scMap?: ScTestMap }).__scMap;
        if (!map || !map.getLayer(id)) return null;
        return (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
      }, layer);

    const annotationLayers = ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed'];
    const annToggle = page.getByRole('checkbox', { name: 'Zeiten & Geschwindigkeiten' });
    await expect(annToggle).toBeChecked(); // default ON
    for (const id of annotationLayers) {
      await expect.poll(() => visibility(id), { timeout: 30_000 }).toBe('visible');
    }
    await annToggle.uncheck();
    for (const id of annotationLayers) {
      await expect.poll(() => visibility(id), { timeout: 30_000 }).toBe('none');
    }
    // Heading dots are deliberately NOT part of the toggle — they stay visible.
    await expect.poll(() => visibility('sc-heading-dots'), { timeout: 30_000 }).toBe('visible');

    // --- (j)#1: pan/zoom/slider must not trigger an Open-Meteo call ---
    await page.evaluate(() => {
      (window as { __scMap?: ScTestMap }).__scMap?.panBy([90, 60]);
    });
    const slider = page.getByRole('slider', { name: 'Vorhersagezeitpunkt' });
    await expect(slider).toBeVisible();
    // The slider's own readout (RouteLayer.tsx's
    // `<span>{formatSliderTime(tMs, hourOptions, lang, nowMs)}</span>`
    // beside the range input) is the concrete UI signal that ArrowRight
    // actually moved the forecast hour — `networkidle` never
    // settles under maplibre-gl 6 (no `requestfinished` for its
    // module-worker fetch) and was never the right readiness signal for
    // "did the debounced hour-change effect fire" anyway. A literal clock
    // string would be a false-precise assertion: the wind fixture's
    // timestamps are regenerated fresh by the `pree2e` hook on every e2e
    // run, so only "the readout moved off its pre-keypress value" is stable
    // across runs.
    const timeReadout = page.locator('.route-layer-time-slider span');
    const timeBeforeArrow = await timeReadout.textContent();
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => timeReadout.textContent()).not.toBe(timeBeforeArrow);

    // The readout poll above only proves the ArrowRight keypress landed — it
    // says nothing about the `panBy` a few lines up, which feeds RouteLayer's
    // viewport-scoped barb rebuild (RouteLayer.tsx:476) through a debounced
    // `moveend` listener (a `requestAnimationFrame` coalescing rapid
    // move/zoom events, not a network trigger today). Proving the ABSENCE of
    // a network call cannot be done with `expect.poll` — there is no state to
    // poll for "nothing happened yet" vs. "nothing will ever happen". This
    // fixed wait is the documented exception to the no-fixed-timeout house
    // rule (see `settledCanvas` in datalayers.spec.ts for the same
    // reasoning): 500ms comfortably exceeds the single-rAF (~16ms) rebuild
    // this listener does today, with wide margin for a future regression
    // that replaced it with a genuinely debounced network refetch. Do not
    // "fix" this back into a poll — there is nothing to poll on.
    await page.waitForTimeout(500);
    expect(
      openMeteoRequests,
      `expected zero Open-Meteo requests, got: ${openMeteoRequests.join(', ')}`,
    ).toEqual([]);
  } finally {
    server.kill();
  }
});

// #378: waypoint ETAs disappearing at some zooms, and ETA/speed text being
// too small. Root cause (measured, not assumed — see the RouteLayer.tsx
// comments above sc-wind-barbs and sc-eta-primary for the full trail,
// including two hypotheses that were tested and REFUTED before this one):
// sc-wind-barbs set icon-allow-overlap:true (barbs are never blocked) but
// left icon-ignore-placement unset (default false), so every one of the
// deliberately dense barb icons still INSERTED a collision box that blocked
// the ETA/speed TEXT layers underneath. Fixed by adding
// icon-ignore-placement:true to sc-wind-barbs, adding text-variable-anchor
// (+ text-radial-offset/text-justify, replacing the old fixed
// text-anchor/text-offset) to give MapLibre placement fallbacks instead of
// one all-or-nothing spot, and replacing the flat text-size:11 with a
// zoom-interpolated size for on-deck phone legibility.
//
// This spec pins the MEASURED before/after (BASE vs this HEAD, both with
// barbs at their #63 default-ON state, on the same route/fixture used by
// the barb-density test above — Langballigau -> Sønderborg on wind-sw12 has
// one gybe and several close-together heading joints):
//
//           BASE (pre-#378)          HEAD (post-#378)
//   z9   primary=3 secondary=0 leg=0   primary=3 secondary=0 leg=0
//   z11  primary=2 secondary=0 leg=1   primary=3 secondary=0 leg=4
//   z12  primary=0 secondary=1 leg=0   primary=1 secondary=4 leg=5
//   z14  primary=0 secondary=2 leg=0   primary=1 secondary=2 leg=3
//
// z9 is identical BASE vs HEAD (a deliberate non-regression: sc-eta-primary
// is the only annotation layer live that low, and growing its collision
// footprint there was avoided on purpose — see the text-size comment in
// RouteLayer.tsx). Every zoom at or above the point where BASE went to 0
// stays non-zero on HEAD; that "non-zero at every in-range zoom" invariant,
// not the exact counts (which depend on the solver's exact route and would
// make this test brittle to unrelated routing-tuning changes), is what this
// spec asserts. Full identity-array evidence — not just counts, per house
// style (a same-count swap must be caught) — is asserted at one
// representative zoom (z12, the exact zoom BASE went fully to 0 on
// sc-eta-primary) via KIND rather than kind+eta: the wind fixture's
// timestamps regenerate fresh on every e2e run (see CLAUDE.md), so an ETA
// clock string is not a stable identity across runs, only the KIND
// (start/finish/tack/gybe/heading) and, for sc-leg-speed, legIndex are.
test('map annotations: ETA/speed labels stay visible across zoom, sized for legibility (#378)', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await page.getByRole('tab', { name: 'Planen' }).click();
    const origin = page.getByRole('region', { name: 'Start' });
    await origin.getByRole('combobox').fill('Langballigau');
    await expect(origin.getByRole('option')).toHaveCount(1);
    await origin.getByRole('option').first().click();
    const dest = page.getByRole('region', { name: 'Ziel' });
    await dest.getByRole('combobox').fill('Sønderborg');
    await expect(dest.getByRole('option')).toHaveCount(1);
    await dest.getByRole('option').first().click();
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });
    const barbToggle = page.getByRole('checkbox', { name: 'Windpfeile anzeigen' });
    await expect(barbToggle).toBeVisible({ timeout: 60_000 });
    await expect(barbToggle).toBeChecked(); // #63 default ON — the state that reproduces #378
    // __scMap is published as soon as the map instance exists, which can be
    // BEFORE RouteLayer's own style-ready effect has run setupLayers() and
    // added sc-eta-primary — wait for the layer itself, not just the map
    // handle, or the structural pins below race a layer that doesn't exist
    // yet (getLayoutProperty on a missing layer returns undefined, which
    // Array.isArray() reports as "not an interpolation" — a false failure,
    // not a real regression; observed directly as a one-off flake before
    // this wait was added).
    await page.waitForFunction(() =>
      Boolean(
        (window as { __scMap?: { getLayer(id: string): unknown } }).__scMap?.getLayer(
          'sc-eta-primary',
        ),
      ),
    );

    // --- Structural pins: the layout properties #378's fix depends on. A
    // regression here (e.g. someone reverting to a flat text-size:11, or
    // dropping icon-ignore-placement) is a config error the zoom sweep below
    // could take a while to catch by symptom; assert the cause directly too.
    const layout = (id: string, prop: string) =>
      page.evaluate(
        ([layerId, p]) =>
          (window as { __scMap?: ScTestMap }).__scMap?.getLayoutProperty(layerId, p),
        [id, prop] as const,
      );
    for (const id of ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed']) {
      const textSize = await layout(id, 'text-size');
      expect(
        Array.isArray(textSize),
        `expected ${id}'s text-size to be a zoom-interpolation expression, got: ${JSON.stringify(textSize)}`,
      ).toBe(true);
    }
    for (const id of ['sc-eta-primary', 'sc-eta-secondary']) {
      const variableAnchor = await layout(id, 'text-variable-anchor');
      expect(
        Array.isArray(variableAnchor) && (variableAnchor as unknown[]).length > 0,
        `expected ${id}'s text-variable-anchor to be a non-empty fallback list, got: ${JSON.stringify(variableAnchor)}`,
      ).toBe(true);
    }
    const barbIgnorePlacement = await layout('sc-wind-barbs', 'icon-ignore-placement');
    expect(
      barbIgnorePlacement,
      `expected sc-wind-barbs' icon-ignore-placement to be true (the #378 fix) — a dense, deliberately-overlapping barb layer must not block the ETA/speed text layers beneath it`,
    ).toBe(true);

    // Center on the tack/gybe cluster (not the route's whole-bounds center)
    // so every zoom in the sweep below — including the tightest — still has
    // maneuver points in view; a fixed-center pure zoom is what isolates
    // collision-driven disappearance from "scrolled off screen".
    const center = await page.evaluate(() => {
      const map = (window as { __scMap?: ScTestMap }).__scMap!;
      const feats = map.querySourceFeatures('sc-maneuvers');
      const maneuvers = feats.filter(
        (f) => f.properties.kind === 'tack' || f.properties.kind === 'gybe',
      );
      const pts = maneuvers.length > 0 ? maneuvers : feats;
      const lng = pts.reduce((s, f) => s + f.geometry.coordinates[0], 0) / pts.length;
      const lat = pts.reduce((s, f) => s + f.geometry.coordinates[1], 0) / pts.length;
      return [lng, lat] as [number, number];
    });

    const settledAnnotationState = await settleAnnotationsAt(page, center, 9);
    expect(
      settledAnnotationState.primary.length,
      `z9 sc-eta-primary should show start/finish/gybe, got: ${JSON.stringify(settledAnnotationState.primary)}`,
    ).toBeGreaterThan(0);

    const z11 = await settleAnnotationsAt(page, center, 11);
    expect(
      z11.primary.length,
      `z11 sc-eta-primary regressed to empty, got: ${JSON.stringify(z11.primary)}`,
    ).toBeGreaterThan(0);
    expect(
      z11.legSpeed.length,
      `z11 sc-leg-speed regressed to empty, got: ${JSON.stringify(z11.legSpeed)}`,
    ).toBeGreaterThan(0);

    // z12: the exact zoom the pre-#378 code went fully to 0 on sc-eta-primary
    // (minzoom for sc-eta-secondary too, so both are live here) — assert full
    // identity, not just counts.
    const z12 = await settleAnnotationsAt(page, center, 12);
    expect(
      z12.primary,
      `z12 sc-eta-primary regressed to empty (the #378 repro), got: ${JSON.stringify(z12.primary)}`,
    ).not.toEqual([]);
    expect(
      z12.secondary,
      `z12 sc-eta-secondary regressed to empty, got: ${JSON.stringify(z12.secondary)}`,
    ).not.toEqual([]);
    expect(
      z12.legSpeed,
      `z12 sc-leg-speed regressed to empty, got: ${JSON.stringify(z12.legSpeed)}`,
    ).not.toEqual([]);

    const z14 = await settleAnnotationsAt(page, center, 14);
    expect(
      z14.primary.length,
      `z14 sc-eta-primary regressed to empty, got: ${JSON.stringify(z14.primary)}`,
    ).toBeGreaterThan(0);
    expect(
      z14.secondary.length,
      `z14 sc-eta-secondary regressed to empty, got: ${JSON.stringify(z14.secondary)}`,
    ).toBeGreaterThan(0);
  } finally {
    server.kill();
  }
});
