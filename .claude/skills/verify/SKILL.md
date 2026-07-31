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
| Production bundle | `npm --prefix app run build`, then `npm --prefix app run preview -- --port <PORT> --strictPort` (background) | `http://localhost:<PORT>/sail_command/` |

Prefer the production-bundle pass for anything that could differ minified
(SW, worker, chunking); it is much faster than running the full e2e suite.

**Pick `<PORT>` explicitly — never 4173.** 4173 is e2e's fixed preview port
(`app/e2e/helpers.ts`); sharing it with a concurrent e2e run means you can't
be sure which process is answering. Always pass `--strictPort`: without it,
a taken port makes vite silently fall back to a different one, which is
exactly the "which server am I looking at" failure this skill exists to
prevent — let it fail loudly and pick a free port instead. Reusing the same
port across two successive walkthroughs also reuses that origin's service-
worker registration scope (origin = protocol + host + port); prefer a fresh
port per pre-release walkthrough, and run the preflight below regardless.

## #240: clean PWA state + build-identity assertion (production bundle only)

A local production preview can show "Update verfügbar" / render stale
content while looking correct, for two same-origin reasons (both reproduced
in #240 — no application-code defect in either; `registerType: 'prompt'`,
the focus-gated update check, and the message-gated `skipWaiting()` below
are all deliberate):

- **A — served bytes changed under a live page.** `ReloadPrompt.tsx` re-checks
  `registration.update()` on every window focus while online
  (`app/src/components/ReloadPrompt.tsx:26-30`). If `dist/` was rebuilt while
  the previewed page stayed open (another agent's build, a `pree2e` rebuild),
  the next focus installs the new worker into `waiting` — while the page
  still correctly shows the build it loaded.
- **B — a stale service worker from an earlier preview on the same
  origin+port survives.** `app/src/sw.ts:54` calls `clientsClaim()`
  unconditionally, but `self.skipWaiting()` (`sw.ts:81`) only fires inside the
  `message` handler, gated on an explicit `SKIP_WAITING` postMessage (sent
  when the Reload button calls `updateServiceWorker(true)`) — never
  automatically on install. An old worker's precache keeps serving
  `index.html` for every navigation until that message arrives, so a plain
  reload can render the OLD build while the banner correctly reports a newer
  one waiting in the background.

A version string alone (`git describe --tags --always`, no `--dirty` flag —
see `appVersion()` in `app/vite.config.ts:112-122`) does not distinguish two
builds of the SAME commit, which is exactly the pre-release case (rebuild
after an uncommitted tweak). Pair it with Vite's content-hashed entry chunk,
which changes whenever any bundled module changes, commit or not.

Do this **every time**, before capturing any screenshot used as pre-release
evidence, right after the preview server is up. **Do not rebuild `dist/` (or
trigger any page reload) mid-walkthrough without re-running steps 3-5** — the
checks below only cover the state at the moment they run; issue #240's own
suggested fix says the same thing, and this skill's own negative-probe dry
run (#240) reproduced exactly this failure by rebuilding in place under a
live server. If a rebuild happens mid-walkthrough, treat every screenshot
captured before re-running the preflight as unverified.

1. Capture the expected commit label right before building (same repo state
   the build will embed):
   ```bash
   EXPECTED_VERSION=$(git describe --tags --always)
   echo "$EXPECTED_VERSION"
   ```
2. Build and record the entry-chunk hash actually on disk:
   ```bash
   npm --prefix app run build
   EXPECTED_CHUNK=$(grep -o 'assets/index-[^"]*\.js' app/dist/index.html)
   echo "$EXPECTED_CHUNK"
   ```
3. Start the preview on `<PORT>` and navigate once (Playwright MCP:
   `browser_navigate` → `http://localhost:<PORT>/sail_command/`).
4. **Preflight — force a clean PWA state** (`browser_evaluate`, no target
   element):
   ```js
   () => Promise.all([
     navigator.serviceWorker.getRegistrations()
       .then((regs) => Promise.all(regs.map((r) => r.unregister()))),
     caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
   ])
   ```
   Then `browser_navigate` to the same URL again — a fresh navigation, not a
   SW-served cache — so the CURRENT `dist/` registers its own worker with
   nothing stale beneath it.
5. **Assert build identity — two checks, each closes a different gap.**
   (`navigator.serviceWorker.controller === null` is NOT one of them —
   dry-run-verified during this skill's own #240 fix: `sw.ts:54` calls
   `clientsClaim()` unconditionally, so a brand-new worker can already be
   `controller` moments after a clean reload with no old registration in
   sight. Controller nullity tests timing, not staleness; don't use it.)
   - Entry chunk on the loaded page matches what's on disk
     (`browser_evaluate`):
     `() => document.querySelector('script[type="module"]').getAttribute('src')`
     → must contain `$EXPECTED_CHUNK` from step 2. This is the check that
     catches mechanism B even when the commit hasn't changed — reproduced
     live: with an old worker left registered, this returned the OLD hash
     while the server already had a new one on disk, correctly failing.
   - About dialog matches the target commit: click the button whose
     accessible name is `Über SailCommand` (German UI default) or
     `About SailCommand` (English), then read the `.about-version` element
     (i18n key `about.version`, renders e.g. `Version v0.5.1-79-gef53156`)
     → must contain `$EXPECTED_VERSION` from step 1. This is the one a
     screenshot actually shows a human reviewer — capture it alongside the
     UI screenshots as corroborating evidence. Note this check alone is
     insufficient: two builds of the same uncommitted commit share the same
     `git describe` output, so it cannot tell them apart — that's what the
     chunk-hash check above is for.
6. Only once both checks pass, proceed with the walkthrough below.

If either check fails: repeat steps 3-5 from a fresh navigation first (rules
out mechanism A, a mid-flight rebuild). If it still fails, something on that
origin+port is holding a stale registration alive past the unregister call
(commonly a second open tab) — close it, or switch to an unused port and
retry from step 3.

**Both-themes pass needs chrome-devtools MCP, not Playwright MCP.**
`page.emulateMedia({ colorScheme })` is a Playwright *test-spec* API with no
Playwright-MCP tool equivalent. The MCP-driven equivalent is
`mcp__chrome-devtools__emulate` with `colorScheme: 'dark' | 'light'`. Run the
dark-mode capture as its own chrome-devtools-MCP pass — do not interleave it
with the Playwright-MCP flow in the next section; the two MCP servers drive
separate browser sessions and neither can change color scheme on the other's
page. Steps 3-6 above translate to chrome-devtools MCP tool names as follows
(the JS `function` bodies are reused as-is, except the click — see below):

| Step | Playwright MCP | chrome-devtools MCP |
|---|---|---|
| 3, navigate | `browser_navigate` | `navigate_page` (`type: 'url'`, `url: …`) |
| 3.5, set theme | — | `emulate` with `colorScheme: 'dark'` (call once, right after the first navigate) |
| 4, preflight eval | `browser_evaluate` | `evaluate_script` (same zero-arg `function`) |
| 5, chunk/version eval | `browser_evaluate` | `evaluate_script` (same zero-arg `function`) |
| 5, take a snapshot | — | `take_snapshot` (required before the click below) |
| 5, click About button | `browser_click` (`target`: ref or selector) | `click` (`uid` ONLY — no selector fallback) |

**The click row is not a name substitution — the parameter contract
differs.** `browser_click`'s `target` accepts either a Playwright snapshot
ref or a plain selector string. chrome-devtools MCP's `click` accepts
**only** a `uid`, and a `uid` exists only by first calling `take_snapshot`
(its accessibility-tree output lists each element's `uid`) and reading the
About button's `uid` off that snapshot. There is no selector-string path on
this tool — do `take_snapshot` → find the About button's `uid` in the
result → `click({ uid })`. Skipping the snapshot leaves nothing to pass as
`uid` and the click cannot be issued.

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
