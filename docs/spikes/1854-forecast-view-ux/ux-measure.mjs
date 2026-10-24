// UX grounding measurements for #1854: chrome rects and whole-area fit, cold load, no plan.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:4500/sail_command/';
const OUT = './ux-shots/measure.json';
const VIEWPORTS = [
  [820, 1180],
  [1180, 820],
  [1920, 1080],
  [390, 844],
];
const results = {};
const browser = await chromium.launch();
try {
  for (const [w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'de-DE' });
    await ctx.addInitScript(() => {
      try {
        window.localStorage.setItem('sc-caveat-banner-dismissed', '1');
      } catch {
        /* ignore */
      }
    });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForFunction(() => Boolean(window.__scMap?.loaded()), undefined, {
      timeout: 45_000,
      polling: 250,
    });
    const r = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const m = window.__scMap;
      const bbox = [
        [9.4, 54.3],
        [11.6, 55.6],
      ];
      const fit = m.cameraForBounds(bbox, { padding: 0 });
      const startZoom = m.getZoom();
      // Smallest zoom maxBounds allows for this canvas.
      m.jumpTo({ center: [10.5, 54.95], zoom: 0 });
      const minAllowedZoom = m.getZoom();
      const b = m.getBounds();
      return {
        canvas: rect('.maplibregl-canvas'),
        mapArea: rect('.map-area'),
        header: rect('.app-header'),
        bannerArea: rect('.banner-area'),
        sheet: rect('.app-bottom-sheet'),
        tabs: rect('.app-tabs'),
        mapStackTl: rect('.map-stack-tl'),
        dataLayerControls: rect('.data-layer-controls'),
        dataLayerSummary: rect('.data-layer-controls-disclosure > summary'),
        compass: rect('.compass-control'),
        depthLegend: rect('.depth-legend'),
        depthLegendSummary: rect('.depth-legend > summary'),
        scaleBar: rect('.scale-bar'),
        attribution: rect('.maplibregl-ctrl-bottom-right'),
        plannerActions: rect('.planner-actions'),
        startZoom: Number(startZoom.toFixed(2)),
        zoomToFitWholeArea: fit ? Number(fit.zoom.toFixed(2)) : null,
        minAllowedZoomByMaxBounds: Number(minAllowedZoom.toFixed(2)),
        boundsAtMinZoom: {
          w: Number(b.getWest().toFixed(2)),
          s: Number(b.getSouth().toFixed(2)),
          e: Number(b.getEast().toFixed(2)),
          n: Number(b.getNorth().toFixed(2)),
        },
      };
    });
    results[`${w}x${h}`] = r;
    console.log(`${w}x${h}`, JSON.stringify(r));
    await ctx.close();
  }
} finally {
  await browser.close();
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}
