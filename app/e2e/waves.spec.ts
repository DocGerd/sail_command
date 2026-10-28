import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  STANDARD_VIEWPORTS,
  localDatetimeValue,
  nextFullHourPlus,
  startPreview,
  type PreviewServer,
} from './helpers';

// #1699: the plan-bound sea-state overlay (WaveLayer.tsx) on a real map, fed
// by the gitignored `wave-bands.json` fixture (scripts/wave-fixture.mjs, built
// by `pree2e`): Hs cycles through all five WMO bands by latitude row, five
// points are all-null, and every series is constant over time. Waits on map
// state poll VALUES (feature counts, band sets, layer ids, raster pixels) and
// re-sample the map on every call. #1854: the fill is a canvas raster, which
// queryRenderedFeatures cannot see, so shading is read off the source canvas
// and the composited map; bands come from the markers.

const WIND = 'test-fixtures/wind-sw12.json';
const WAVE = 'test-fixtures/wave-bands.json';
const FILL = 'sc-waves-fill';
const ARROWS = 'sc-waves-arrows';
const RASTER = 'sc-waves-raster';
// wave-fixture.mjs's E2E_NULL_POINT [1, 20]: an all-null point that, with its
// four neighbours, is water in the mask (waveFixtureMask.test.ts), so land
// culling cannot stand in for its null-ness.
const NULL_CELL = { lng: 11.4, lat: 54.4 };
const STEP_DEG = 0.1;

test.use({ viewport: STANDARD_VIEWPORTS.desktopHd });

interface ScTestMap {
  queryRenderedFeatures(
    geometry: unknown,
    opts: { layers: string[] },
  ): Array<{ properties: Record<string, unknown> }>;
  project(lngLat: [number, number]): { x: number; y: number };
  jumpTo(opts: { center: [number, number]; zoom: number }): void;
  getLayer(id: string): unknown;
  getLayoutProperty(id: string, name: string): unknown;
  getStyle(): { layers: Array<{ id: string }> };
  getSource(id: string): unknown;
}
type MapWindow = { __scMap?: ScTestMap };

async function planRoute(page: Page, server: PreviewServer, query: string): Promise<void> {
  await page.goto(`${server.url}?${query}`);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const origin = page.getByRole('region', { name: 'Start' });
  await origin.getByRole('combobox').fill('Langballigau');
  await expect(origin.getByRole('option')).toHaveCount(1);
  await origin.getByRole('option').first().click();
  const dest = page.getByRole('region', { name: 'Ziel' });
  await dest.getByRole('combobox').fill('Sønderborg');
  await expect(dest.getByRole('option')).toHaveCount(1);
  await dest.getByRole('option').first().click();
  // Explicit departure (#1731): the form default can fall into the past.
  await page.getByLabel('Abfahrt').fill(localDatetimeValue(nextFullHourPlus(2)));
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 120_000 });
  await page.waitForFunction(() =>
    Boolean((window as MapWindow).__scMap?.getLayer('sc-route-shallow')),
  );
}

async function openControls(page: Page): Promise<void> {
  const disclosure = page.locator('details.route-layer-controls-disclosure');
  // IDL `open`, never getAttribute (boolean attribute, CLAUDE.md).
  if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await disclosure.locator('> summary').click();
  }
}

// The route fit holds no in-mask water lattice point, so no marker: markers
// are counted on the open water around the null point instead.
function showOpenWater(page: Page): Promise<void> {
  return page.evaluate(
    ({ lng, lat }) => (window as MapWindow).__scMap?.jumpTo({ center: [lng, lat], zoom: 8 }),
    NULL_CELL,
  );
}

function waveToggle(page: Page) {
  return page.getByRole('checkbox', { name: 'Seegang anzeigen', exact: true });
}

function layerVisibility(page: Page, id: string): Promise<unknown> {
  return page.evaluate(
    (layer) => (window as MapWindow).__scMap?.getLayoutProperty(layer, 'visibility') ?? 'no-layer',
    id,
  );
}

function featureCount(page: Page, layer: string): Promise<number> {
  return page.evaluate((id) => {
    const map = (window as MapWindow).__scMap;
    return map ? map.queryRenderedFeatures(undefined, { layers: [id] }).length : -1;
  }, layer);
}

/** Distinct `band` values of the sea-state markers currently rendered. */
function renderedBands(page: Page): Promise<string[]> {
  return page.evaluate((id) => {
    const map = (window as MapWindow).__scMap;
    if (!map) return ['no-map'];
    const bands = map.queryRenderedFeatures(undefined, { layers: [id] }).map((f) => {
      const b = f.properties.band;
      return typeof b === 'string' ? b : '?';
    });
    return [...new Set(bands)].sort();
  }, ARROWS);
}

/** Markers within a few pixels of each lng/lat, and the raster's alpha there. */
function cellsAt(page: Page, points: Record<string, [number, number]>) {
  return page.evaluate(
    ([arrows, raster, pts]) => {
      const map = (window as MapWindow).__scMap;
      const src = map?.getSource(raster) as
        { getCanvas(): HTMLCanvasElement; coordinates: [number, number][] } | undefined;
      const out: Record<string, { markers: number; alpha: number }> = {};
      if (!map || !src) return out;
      const canvas = src.getCanvas();
      const ctx = canvas.getContext('2d')!;
      const [[west, north], [east], , [, south]] = src.coordinates;
      const my = (lat: number) => {
        const s = Math.sin((lat * Math.PI) / 180);
        return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      };
      for (const [name, [lng, lat]] of Object.entries(pts)) {
        const { x, y } = map.project([lng, lat]);
        const markers = map.queryRenderedFeatures(
          [
            [x - 4, y - 4],
            [x + 4, y + 4],
          ],
          { layers: [arrows] },
        ).length;
        const px = Math.floor(((lng - west!) / (east! - west!)) * canvas.width);
        // A lattice point on the mask's south edge is drawn by the row inside it.
        const py = Math.min(
          canvas.height - 1,
          Math.floor(((my(lat) - my(north!)) / (my(south!) - my(north!))) * canvas.height),
        );
        out[name] = { markers, alpha: ctx.getImageData(px, py, 1, 1).data[3]! };
      }
      return out;
    },
    [ARROWS, RASTER, points] as const,
  );
}

// Polls until two consecutive map-canvas screenshots are byte-equal.
async function settledCanvas(page: Page, canvas: Locator): Promise<Buffer> {
  let prev = await canvas.screenshot();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

/** RGBA at each screen point of a PNG screenshot, decoded in-page (img-src allows data:). */
function pixelsAt(page: Page, shot: Buffer, points: Array<{ x: number; y: number }>) {
  return page.evaluate(
    async ([b64, pts]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return pts.map(({ x, y }) => Array.from(g.getImageData(x, y, 1, 1).data).join());
    },
    [shot.toString('base64'), points] as const,
  );
}

test.describe('sea-state overlay (#1699)', () => {
  test('the wave fixture is actually served', async ({ page }) => {
    const server = await startPreview(page);
    try {
      // The preview server answers a missing file with the SPA shell (200), and
      // the app swallows a failed wave fetch into "no sea state", so reachability
      // alone proves nothing: parse the body.
      const res = await page.request.get(new URL(WAVE, server.url).toString());
      expect(res.status()).toBe(200);
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`wave fixture is not JSON (run pree2e): ${text.slice(0, 80)}`);
      }
      expect(Array.isArray(parsed) ? parsed.length : -1, 'one entry per lattice point').toBe(
        14 * 23,
      );
    } finally {
      server.kill();
    }
  });

  test('renders shading and arrows; a null point is no data, never calm', async ({ page }) => {
    const server = await startPreview(page);
    const openMeteoRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
    });
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);

      await expect.poll(() => layerVisibility(page, FILL), { timeout: 30_000 }).toBe('visible');
      await expect.poll(() => layerVisibility(page, ARROWS)).toBe('visible');

      // Centre the map on the null point: its four water neighbours (S is a
      // real calm cell) are shaded and carry a marker; the null point has neither.
      await page.evaluate(
        ({ lng, lat }) => (window as MapWindow).__scMap?.jumpTo({ center: [lng, lat], zoom: 9 }),
        NULL_CELL,
      );
      const cells = () =>
        cellsAt(page, {
          nullCell: [NULL_CELL.lng, NULL_CELL.lat],
          north: [NULL_CELL.lng, NULL_CELL.lat + STEP_DEG],
          south: [NULL_CELL.lng, NULL_CELL.lat - STEP_DEG],
          east: [NULL_CELL.lng + STEP_DEG, NULL_CELL.lat],
          west: [NULL_CELL.lng - STEP_DEG, NULL_CELL.lat],
        });
      const shaded = { markers: 1, alpha: 255 };
      await expect.poll(cells, { timeout: 30_000 }).toEqual({
        nullCell: { markers: 0, alpha: 0 },
        north: shaded,
        south: shaded,
        east: shaded,
        west: shaded,
      });
      await expect.poll(() => featureCount(page, ARROWS), { timeout: 30_000 }).toBeGreaterThan(0);

      expect(openMeteoRequests, 'fixtures must keep the run off the live APIs').toEqual([]);
    } finally {
      server.kill();
    }
  });

  test('the toggle hides the overlay layers and persists across a reload', async ({ page }) => {
    const server = await startPreview(page);
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      await openControls(page);
      const toggle = waveToggle(page);
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await showOpenWater(page);
      await expect.poll(() => featureCount(page, ARROWS), { timeout: 30_000 }).toBeGreaterThan(0);

      await toggle.uncheck();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('none');
      await expect.poll(() => layerVisibility(page, ARROWS)).toBe('none');
      await expect.poll(() => featureCount(page, ARROWS)).toBe(0);

      // The reload restores the saved plan (with its stored wave grid), so
      // the preference is read back without planning again.
      await page.reload();
      await page.waitForFunction(
        (id) => Boolean((window as MapWindow).__scMap?.getLayer(id)),
        FILL,
      );
      await openControls(page);
      await expect(waveToggle(page)).not.toBeChecked();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('none');
      await expect.poll(() => layerVisibility(page, ARROWS)).toBe('none');

      await waveToggle(page).check();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('visible');
      await showOpenWater(page);
      await expect.poll(() => featureCount(page, ARROWS), { timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      server.kill();
    }
  });

  // #1854 AC-3: in-cell pixel pairs where a shaded raster pixel sits beside a
  // pixel whose mask cells are all land, in the SAME lattice cell (so the old
  // cell rectangle tinted it). Toggling sea state must change the water pixel
  // on screen and leave the land pixel byte-identical.
  test('shades water only: a toggle changes coastal water, never the land beside it', async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      await openControls(page);
      await page.getByRole('checkbox', { name: 'Windpfeile anzeigen', exact: true }).uncheck();
      await expect.poll(() => layerVisibility(page, FILL), { timeout: 30_000 }).toBe('visible');

      const findPairs = () =>
        page.evaluate(async (raster) => {
          const map = (window as MapWindow).__scMap!;
          const src = map.getSource(raster) as {
            getCanvas(): HTMLCanvasElement;
            coordinates: [number, number][];
          };
          const canvas = src.getCanvas();
          const { width: W, height: H } = canvas;
          const alpha = canvas.getContext('2d')!.getImageData(0, 0, W, H).data;
          const meta = (await (await fetch('data/mask.meta.json')).json()) as {
            south: number;
            north: number;
            west: number;
            east: number;
            rows: number;
            cols: number;
          };
          const bytes = new Uint8Array(await (await fetch('data/mask.bin')).arrayBuffer());
          const [[west, north], [east], , [, south]] = src.coordinates;
          const my = (lat: number) => {
            const s = Math.sin((lat * Math.PI) / 180);
            return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
          };
          const yN = my(north!);
          const span = my(south!) - yN;
          const latAt = (y: number) =>
            (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;
          const centre = (i: number, j: number) => ({
            lat: latAt(yN + ((i + 0.5) / H) * span),
            lon: west! + ((j + 0.5) / W) * (east! - west!),
          });
          // Whether every mask cell under raster pixel (i, j), bar the column it
          // shares with its pair, has this byte class;
          // read from the mask alone, never from the raster under test.
          const rowOf = (lat: number) =>
            Math.floor(((lat - meta.south) / (meta.north - meta.south)) * meta.rows);
          const colOf = (lon: number) =>
            Math.floor(((lon - meta.west) / (meta.east - meta.west)) * meta.cols);
          const footprint = (i: number, j: number, wantLand: boolean, shared: number) => {
            const r0 = rowOf(latAt(yN + ((i + 1) / H) * span));
            const r1 = rowOf(latAt(yN + (i / H) * span) - 1e-9);
            const c0 = colOf(west! + (j / W) * (east! - west!));
            const c1 = colOf(west! + ((j + 1) / W) * (east! - west!) - 1e-9);
            for (let r = Math.max(0, r0); r <= Math.min(meta.rows - 1, r1); r++)
              for (let c = Math.max(0, c0); c <= Math.min(meta.cols - 1, c1); c++)
                if (c !== shared && (bytes[r * meta.cols + c] === 0) !== wantLand) return false;
            return true;
          };
          const cell = (p: { lat: number; lon: number }) =>
            `${Math.round((p.lat - 54.3) * 10)},${Math.round((p.lon - 9.4) * 10)}`;
          const out: Array<{
            water: { lat: number; lon: number };
            land: { lat: number; lon: number };
          }> = [];
          for (let i = 0; i < H; i++)
            for (let j = 1; j < W - 1; j++) {
              if (alpha[(i * W + j) * 4 + 3] !== 255) continue;
              for (const dj of [-1, 1]) {
                const w = centre(i, j);
                const l = centre(i, j + dj);
                if (cell(l) !== cell(w)) continue;
                const shared = colOf(west! + (Math.max(j, j + dj) / W) * (east! - west!));
                if (footprint(i, j + dj, true, shared) && footprint(i, j, false, shared))
                  out.push({ water: w, land: l });
              }
            }
          return out;
        }, RASTER);
      await expect
        .poll(async () => (await findPairs()).length, {
          message: 'coastal pairs on the real mask',
          timeout: 30_000,
        })
        .toBeGreaterThan(5);
      const pairs = await findPairs();

      // Zoom in on one pair so a raster pixel spans many screen pixels.
      const anchor = pairs[Math.floor(pairs.length / 2)]!;
      await page.evaluate(
        ({ lon, lat }) => (window as MapWindow).__scMap?.jumpTo({ center: [lon, lat], zoom: 12 }),
        anchor.water,
      );
      const canvas = page.locator('.maplibregl-canvas');
      const box = (await canvas.boundingBox())!;
      const on = await settledCanvas(page, canvas);
      // Map coordinates, kept only where the map canvas itself is topmost: the
      // screenshot includes any panel over it, whose contents the toggle changes.
      const inView = await page.evaluate(
        ([ps, origin]) => {
          const map = (window as MapWindow).__scMap!;
          const at = (p: { lat: number; lon: number }) => {
            const { x, y } = map.project([p.lon, p.lat]);
            return { x: Math.round(x), y: Math.round(y) };
          };
          const bare = (q: { x: number; y: number }) =>
            document
              .elementFromPoint(origin.x + q.x, origin.y + q.y)
              ?.classList.contains('maplibregl-canvas') ?? false;
          return ps
            .map((p) => ({ water: at(p.water), land: at(p.land) }))
            .filter((s) => bare(s.water) && bare(s.land));
        },
        [pairs, { x: box.x, y: box.y }] as const,
      );
      expect(inView.length, `pairs in the zoomed view, of ${pairs.length}`).toBeGreaterThan(0);

      await waveToggle(page).uncheck();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('none');
      const off = await settledCanvas(page, canvas);

      const water = inView.map((s) => s.water);
      const landPts = inView.map((s) => s.land);
      const [wOn, wOff, lOn, lOff] = await Promise.all([
        pixelsAt(page, on, water),
        pixelsAt(page, off, water),
        pixelsAt(page, on, landPts),
        pixelsAt(page, off, landPts),
      ]);
      const landChanged = landPts.filter((_, i) => lOn[i] !== lOff[i]);
      const waterChanged = water.filter((_, i) => wOn[i] !== wOff[i]).length;
      expect(landChanged, 'land pixels tinted by sea state').toEqual([]);
      expect(
        waterChanged * 2,
        `water pixels shaded: ${waterChanged} of ${water.length}`,
      ).toBeGreaterThanOrEqual(water.length);
    } finally {
      server.kill();
    }
  });

  test('layer order: above the depth ramp, below points and the route', async ({ page }) => {
    const server = await startPreview(page);
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      const below = ['sc-depth', 'sc-depth-hatch'];
      const above = [
        'sc-saved-waypoints',
        'sc-harbor-points',
        'sc-seamarks',
        'sc-seamarks-hazard',
        'sc-ais-vessels',
        'sc-route-shallow',
        'sc-route-sail',
      ];
      // Layers a fresh profile always has; the rest are checked when present.
      const required = ['sc-depth', 'sc-harbor-points', 'sc-seamarks', 'sc-route-shallow'];
      await expect
        .poll(
          async () => {
            const ids = await page.evaluate(
              () => (window as MapWindow).__scMap?.getStyle().layers.map((l) => l.id) ?? [],
            );
            const at = (id: string) => ids.indexOf(id);
            const problems: string[] = [];
            for (const id of [FILL, ARROWS, ...required]) {
              if (at(id) < 0) problems.push(`missing ${id}`);
            }
            if (at('sc-waves-edge') >= 0) problems.push('sc-waves-edge still present');
            if (at(FILL) >= at(ARROWS)) problems.push(`${FILL} not below ${ARROWS}`);
            for (const id of below) {
              if (at(id) >= 0 && at(id) > at(FILL)) problems.push(`${id} above ${FILL}`);
            }
            for (const id of above) {
              if (at(id) >= 0 && at(id) < at(ARROWS)) problems.push(`${id} below ${ARROWS}`);
            }
            return problems;
          },
          { timeout: 30_000 },
        )
        .toEqual([]);
    } finally {
      server.kill();
    }
  });

  test('without a wave fixture: toggle disabled, muted note, no banner, no live request', async ({
    page,
  }) => {
    const server = await startPreview(page);
    const openMeteoRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
    });
    try {
      await planRoute(page, server, `windFixture=${WIND}`);
      await openControls(page);

      const toggle = waveToggle(page);
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toBeChecked();
      await expect(page.locator('#route-waves-note')).toHaveText(
        'Für diesen Plan sind keine Seegangsdaten verfügbar.',
      );
      await expect(toggle).toHaveAttribute('aria-describedby', 'route-waves-note');

      // No wave layers at all: the stack is exactly the no-overlay stack.
      const waveLayerIds = await page.evaluate(
        () =>
          (window as MapWindow).__scMap
            ?.getStyle()
            .layers.map((l) => l.id)
            .filter((id) => id.startsWith('sc-waves')) ?? ['no-map'],
      );
      expect(waveLayerIds).toEqual([]);

      // Display-only data must not raise a banner: no banner mentions sea state.
      // Positive control: arming a map pick raises a banner the locator matches.
      await page
        .getByRole('region', { name: 'Start' })
        .getByRole('button', { name: 'Auf Karte wählen' })
        .click();
      const banners = page.locator('.banner-area .banner');
      await expect(banners.filter({ hasText: 'Auf Karte tippen für Start.' })).toHaveCount(1);
      await expect(banners.filter({ hasText: /Seegang|Wellen/i })).toHaveCount(0);
      expect(openMeteoRequests, 'wind fixture alone must not reach any live API').toEqual([]);
    } finally {
      server.kill();
    }
  });
});

// The fixture is time-invariant, so the slider cannot change anything by
// itself. This describe serves a variant instead (odd hours all rough, even
// hours the stock bands) through page.route, with the service worker blocked.
test.describe('sea-state overlay follows the slider (#1699)', () => {
  test.use({ serviceWorkers: 'block' });

  test('moving the time slider re-samples the wave grid', async ({ page }) => {
    const server = await startPreview(page);
    let served = 0;
    await page.route('**/test-fixtures/wave-bands.json', async (route) => {
      served += 1;
      const res = await route.fetch();
      const points = (await res.json()) as Array<{ hourly: { wave_height: Array<number | null> } }>;
      for (const p of points) {
        p.hourly.wave_height = p.hourly.wave_height.map((h, i) =>
          h !== null && i % 2 === 1 ? 3.2 : h,
        );
      }
      await route.fulfill({ response: res, json: points });
    });
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      expect(served, 'the variant fixture was served').toBeGreaterThan(0);
      await page.evaluate(
        ({ lng, lat }) => (window as MapWindow).__scMap?.jumpTo({ center: [lng, lat], zoom: 8 }),
        NULL_CELL,
      );
      await expect.poll(() => featureCount(page, ARROWS), { timeout: 30_000 }).toBeGreaterThan(0);

      const slider = page.getByRole('slider', { name: 'Vorhersagezeitpunkt' });
      await expect(slider).toBeVisible();
      await slider.focus();
      await page.keyboard.press('Home');
      await expect(slider).toHaveValue('0');
      await expect
        .poll(async () => (await renderedBands(page)).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const first = await renderedBands(page);

      await page.keyboard.press('ArrowRight');
      await expect(slider).toHaveValue('1');
      await expect.poll(() => renderedBands(page), { timeout: 30_000 }).not.toEqual(first);
      const second = await renderedBands(page);

      // Adjacent hours have opposite parity: one is all rough, the other the
      // stock mix of bands.
      const [uniform, mixed] = first.length < second.length ? [first, second] : [second, first];
      expect(uniform).toEqual(['rough']);
      expect(mixed.length).toBeGreaterThan(1);

      await page.keyboard.press('ArrowLeft');
      await expect(slider).toHaveValue('0');
      await expect.poll(() => renderedBands(page), { timeout: 30_000 }).toEqual(first);
    } finally {
      server.kill();
    }
  });
});
