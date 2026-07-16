---
name: verify
description: Use when a SailCommand change needs real-browser confirmation — before claiming any UI, routing, or PWA change complete, when asked to run or screenshot the app, or when a change touches components, map rendering, the service worker, or routing results.
---

# Verify a SailCommand change in a real browser

Synthetic tests alone missed a product-blocking solver bug that the first
real-browser run found in minutes (#20). UI and routing tasks end with this
pass, not with green unit tests.

## Serving — the two sharp edges

The app MUST be served at base `/sail_command/` (vite.config.ts) **with HTTP
Range support** — pmtiles' FetchSource throws on full-body 200 responses.
`vite dev` and `vite preview` both satisfy this. A plain static server
(`python3 -m http.server`, `npx serve`) satisfies neither. Never substitute one.

| Pass | Command | URL |
|---|---|---|
| Fast visual (dev) | `npm --prefix app run dev` (background) | `http://localhost:5173/sail_command/` |
| Production bundle | `npm --prefix app run build`, then `npm --prefix app run preview -- --port 4173 --strictPort` (background) | `http://localhost:4173/sail_command/` |

Prefer the production-bundle pass for anything that could differ minified
(SW, worker, chunking); it is much faster than running the full e2e suite.

## Deterministic wind (no live Open-Meteo)

1. `node app/scripts/gen-wind-fixture.mjs` — regenerates
   `app/public/test-fixtures/wind-sw12.json` with fresh timestamps (stale
   timestamps trigger the staleForecast alert and you verify the wrong state).
2. Append `?windFixture=test-fixtures/wind-sw12.json` to the URL.

## Drive the flow (Playwright MCP, mirrors plan.spec.ts)

Tab "Planen" → Start searchbox `Langballigau`, click result → Ziel searchbox
`Sønderborg`, click result → "Route planen" → wait until the button re-enables
(≤60 s) → tab "Routen". UI defaults to German.

Checks: `browser_console_messages` must show no errors (i18n-key, React,
MapLibre, worker); for PWA-relevant changes also confirm SW registration
logging and no map-error banner. Screenshot the changed UI as evidence;
re-check at ~390 px width (wide content must scroll in its own container).
Routing changes additionally require
`npm --prefix app run test -- realmask.repro` green (real committed
mask/polars).

## Cleanup — process group, not the npm pid

Kill the server's whole process group (`kill -- -<pid>` on the backgrounded
job); killing only `npm` strands `vite` on the port (documented in
app/e2e/helpers.ts). Then restore the fixture churn — the regenerated
timestamp diff must never be committed:
`git restore app/public/test-fixtures/wind-sw12.json`. Finish with
`git status` showing only the intended change.
