// Shared preview-server lifecycle for E2E specs. No Playwright `webServer`
// config (see playwright.config.ts's comment) — each spec calls
// startPreview() itself and is responsible for kill()ing it, because
// offline.spec.ts needs to kill the server mid-test while plan.spec.ts
// keeps it alive for the whole run.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const DIST_DIR = resolve(APP_DIR, 'dist');
const DIST_INDEX_HTML = resolve(APP_DIR, 'dist', 'index.html');
const DIST_SW_JS = resolve(APP_DIR, 'dist', 'sw.js');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/sail_command/`;
const SW_JS_URL = `${BASE}sw.js`;
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;
// #803 MINOR 2 (PR #823 review): bounds EACH individual fetch attempt, not
// the overall readiness poll (that's START_TIMEOUT_MS). A real vite preview
// answers in well under a second; 5s is generous against that and short
// against the 30s outer budget, so a responder that accepts a connection
// and then never answers fails in ~5s instead of hanging on undici's own
// ~300s headers timeout (measured pre-fix at 301,364ms / 300,340ms against
// the two fetches below).
const FETCH_TIMEOUT_MS = 5_000;

export interface Viewport {
  width: number;
  height: number;
}

// Named viewport matrix, defined ONCE rather than inlined per spec — this
// repo already paid for the per-file version of that mistake (nine test
// files each hardcoded their own `testTimeout` literal; a fix patched only
// the two that had failed in CI, and the next run failed on a third with the
// identical shape, at ~43 min per round; CLAUDE.md's "enumerate, don't
// patch" lesson). A spec imports whichever set(s) it needs and iterates by
// `Object.entries()` so failures name the KEY, not just raw numbers.
//
// STANDARD_VIEWPORTS: the five device classes product/QA expects every
// layout-sensitive spec to cover at minimum — desktop 4K, desktop HD,
// tablet landscape, tablet portrait, phone portrait. Playwright viewports
// are CSS px, not device px: a real 4K display at the common 150%/200% OS
// scaling presents to the browser as ~2560x1440 or exactly 1920x1080 CSS
// px, so `desktopHd` (1920x1080) already doubles as that scaled-4K case —
// `desktop4k` (3840x2160) is deliberately the UNSCALED, very-wide extreme
// instead of a third near-duplicate entry. An explicit ~2560x1440 entry was
// considered and left out: at this app's single `min-width: 1024px` wide
// breakpoint (`lib/useWideLayout.ts`), 1920 and 2560 exercise the identical
// wide-layout code path — the interesting extremes are the breakpoint
// itself (`tabletPortrait` 820 vs `tabletLandscape` 1180, straddling 1024)
// and how far the wide layout stretches (3840), not a third point on the
// same side of both.
export const STANDARD_VIEWPORTS = {
  desktop4k: { width: 3840, height: 2160 },
  desktopHd: { width: 1920, height: 1080 },
  tabletLandscape: { width: 1180, height: 820 },
  tabletPortrait: { width: 820, height: 1180 },
  phonePortrait: { width: 390, height: 844 },
} as const satisfies Record<string, Viewport>;

// EDGE_VIEWPORTS: the narrow/short stress cases #368's own residuals were
// actually measured against (clamp-floor short landscape, deep portrait with
// stacked banners, and a viewport narrow enough to force a real 2-line
// wrap). `phonePortrait` above (390x844) already covers the widest of these
// — it is deliberately NOT duplicated here; every entry below is a distinct
// value STANDARD_VIEWPORTS does not already exercise. Kept in a SEPARATE
// object (not merged into STANDARD_VIEWPORTS) so a spec can iterate
// STANDARD, EDGE, or both, and it's obvious from the import alone which
// category a given test belongs to.
export const EDGE_VIEWPORTS = {
  narrowPortrait360: { width: 360, height: 740 },
  shortLandscape844: { width: 844, height: 390 },
  shortLandscape740: { width: 740, height: 360 },
  // #231: the third short-landscape case its own issue text cites
  // (alongside 844x390/740x360, both already above) — added for the
  // `.map-stack-tl` compaction fix's own guard, `layout.spec.ts`'s
  // "#231: ScaleBar is not suppressed" test.
  shortLandscape932: { width: 932, height: 430 },
  deepPortrait320: { width: 320, height: 568 },
  partialPushBand375: { width: 375, height: 667 },
  wrapForcing280: { width: 280, height: 568 },
} as const satisfies Record<string, Viewport>;

export interface PreviewServer {
  /** Base URL, e.g. `http://localhost:4173/sail_command/` — pass through `?windFixture=...`. */
  url: string;
  /** SIGKILLs the whole process tree (npm -> vite). Idempotent. */
  kill: () => void;
}

// #803: `startPreview()` used to return as soon as ANY 200 answered
// `fetch(BASE)`, with no check that the responder was the `vite preview`
// process THIS call just spawned, or that it was serving THIS run's own
// `dist/`. A process already bound to port 4173 (a leftover preview server,
// a parallel worktree's run, a stray `vite preview`) makes our own
// `--strictPort` child fail to bind — and WHEN THE FOREIGN RESPONDER
// ANSWERS 200, that bind failure is invisible from here: the foreign
// process just answers our readiness poll with its OWN content, so we
// never see EADDRINUSE and "retry on EADDRINUSE" (the old guidance for
// parallel-worktree contention) cannot reach this hazard at all. This is
// SCOPED to the 200 case: a foreign responder that answers 404/500/302
// does NOT hide the bind failure — `child.exitCode !== null` catches our
// own `--strictPort` child dying, typically within a few hundred ms
// (measured, PR #823 review) — so the false-green risk below is specific
// to a foreign server that happens to answer 200 with different content.
// Because a green e2e run gates merges, this is symmetric: it can
// produce a false RED (testing a stale/foreign build) or a false GREEN (the
// foreign build happens to be the already-fixed one while the branch under
// test is still broken) — nothing downstream can tell the two apart.
//
// The fix is a BUILD-IDENTITY check, not a process-identity (pid) check —
// per the issue, neither a free port nor a pid check closes this, and a pid
// only proves "a process I spawned exists", never "the bytes coming back
// over the socket are its bytes" (a pid check also can't help at all
// against the issue's second, cache-based layer). `assertServingThisBuild`
// compares the served `index.html` byte-for-byte against the
// `dist/index.html` THIS run's own `npm run build` (via the `pree2e` hook)
// just wrote to disk, using the same discovery/verification philosophy
// `deploy.yml` already uses for its #398 same-SHA-no-op smoke probe
// (discover the entry chunk from the built `index.html`'s own `<script
// type="module">` tag, never a hardcoded filename) — ported here as a
// stronger full-document comparison, since we control both sides (the local
// file and the fetch) directly rather than needing to name a URL to probe.
//
// index.html references exactly TWO hashed assets (the JS entry, the CSS
// bundle), so byte-matching it establishes identity of the bundled TS/CSS
// graph and the `git describe` string baked into `__SC_APP_VERSION__` —
// and NOTHING WIDER (measured, PR #823 review: a substantive `src/sw.ts`
// edit, and a `public/data/harbors.json` edit, each left `dist/index.html`
// byte-identical). `assertSwJsMatches` closes that gap by ALSO
// byte-comparing the served `sw.js` against `dist/sw.js`: workbox's
// `injectManifest` bakes a precache manifest of MD5 revisions covering
// every `**/*.{js,css,html,ico,png,svg,json,bin,pbf}` file under `dist/`
// (`vite.config.ts`'s `globPatterns`) — `src/sw.ts` itself, `data/mask.bin`,
// every polar, `harbors.json`, `seamarks.json`, the basemap archive, icons
// and sprites, `index.html` (a second, independent route to the SAME check
// above), and the hashed JS/CSS chunks — so any change to `sw.ts` or to
// that glob's contents changes `sw.js`'s own bytes. One extra fetch, and it
// subsumes the `index.html` check for everything the glob reaches.
//
// #833/#854: a file can ESCAPE workbox's precache manifest for two
// independent reasons — it sits under a `vite.config.ts` `globIgnores`
// subtree (`**/test-fixtures/**`, `**/brand/**`, `**/basemap-assets/fonts/**`,
// #833), or its extension is outside `globPatterns`' token list (`.txt` today
// — `THIRD-PARTY-NOTICES.txt`, `basemap-assets/sprites/LICENSE.txt`, #854).
// Either way a difference confined to such a file changes neither
// `index.html` nor `sw.js`, so the two checks above pass it undetected —
// `dist/test-fixtures/wind-sw12.json` (the exact file every planning spec
// reads via `?windFixture=`) is the sharpest case named in #833.
//
// `assertResidualDistFilesMatch` below closes most of that gap WITHOUT
// copying either filter list (this repo has a standing rule against
// duplicating such member lists, per #854's own text): it derives the
// escaping set STRUCTURALLY, by parsing the precache manifest workbox bakes
// into `sw.js` itself (already byte-verified against `dist/sw.js` above) and
// diffing it against every file actually present under `dist/`. Whatever
// escapes — for either reason, and automatically for any FUTURE filter
// change too, since nothing here re-derives `globPatterns`/`globIgnores` —
// is grouped by directory; `pickResidualRepresentatives` fully checks every
// file in a group at or under `FULL_CHECK_MAX_FILES_PER_DIR` (8) and falls
// back to a single lexicographically-first representative only above that
// (see that function's own comment for why a BARE one-per-directory scheme
// was insufficient — a review-caught SELECTION blind spot, not merely a
// coverage one). Fully checking small groups rather than fetching every
// escaping file everywhere is still a deliberate cost bound: this file has
// 60+ `startPreview()` call sites across the suite, and the escaping set
// today is dominated by ~770 font glyph-range `.pbf` files split across only
// three font-family directories (each far over the threshold) that would
// turn one cheap check into tens of thousands of extra requests if fully
// checked everywhere. `THIRD-PARTY-NOTICES.txt`, `sprites/LICENSE.txt`,
// `brand/social-card.png`, `basemap-assets/fonts/OFL.txt` and
// `test-fixtures/wind-sw12.json` each sit in a directory whose escaping
// count is at or under the threshold (verified against a real build,
// 2026-09-03), so all of them are checked — including when
// `test-fixtures/wind-docs-plan-route.json` (the docs-recapture fixture,
// gitignored, present only on a dev machine that has run
// `gen-docs-wind-fixture.mjs`) sits alongside `wind-sw12.json` in the same
// directory; under the OLD one-per-directory scheme whichever of the two
// sorted first would have silently become the SOLE representative,
// regardless of which one a mutation actually touched.
//
// NAMED RESIDUAL, do not over-claim it away: within a directory whose
// escaping count EXCEEDS the threshold (only the three font-family
// directories do, today — each has hundreds of files, so raising the
// threshold to reach them is not viable per the cost bound above), a
// difference confined to a NON-representative sibling is not caught — this
// is a bounded sample there, not an exhaustive scan of the whole of `dist/`.
//
// This addresses #803's FIRST layer (a foreign server already on the
// port) for everything the two probes together reach — not the whole of
// `dist/` unconditionally; see the residual just above. It structurally
// cannot close the SECOND layer the issue also describes — a stale service
// worker on a REUSED origin serving a cached build to a real browser
// PAGE — because this check runs a plain Node `fetch()` with no
// ServiceWorker in the picture at all; that layer needs a browser-side
// unregister+cache-clear step wired into the specs that navigate a page,
// which is out of scope here (see this PR's own description).

/** Extracted for testability and reused by both the local-file and
 * served-response identity checks; deliberately fails CLOSED (throws)
 * rather than returning an empty/best-effort value on a shape it doesn't
 * recognise — an unvalidated match would make the identity check pass
 * forever with zero signal, the same trap `deploy.yml`'s own #398 comment
 * warns about for its analogous entry-chunk discovery. */
function extractEntryScriptSrc(html: string, source: string): string {
  const tagMatch = /<script[^>]*\stype="module"[^>]*\ssrc="([^"]+)"[^>]*>/.exec(html);
  if (!tagMatch) {
    throw new Error(
      `#803: no <script type="module" src="..."> entry tag found in ${source} — cannot establish build identity`,
    );
  }
  const src = tagMatch[1];
  // Shape-validate as a hashed built asset (…/assets/<name>-<hash>.js) —
  // never trust an unvalidated src, which could otherwise be a permanently-
  // live or malformed URL that makes this check vacuous.
  if (!/\/assets\/[\w.-]+-[\w-]{6,}\.js$/.test(src)) {
    throw new Error(
      `#803: entry script src "${src}" in ${source} doesn't look like a hashed built asset ` +
        `(expected …/assets/<name>-<hash>.js) — cannot establish build identity`,
    );
  }
  return src;
}

function readLocalFileOrThrow(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `#803: could not read ${path} (${(err as Error).message}) — startPreview() needs a build to ` +
        `check the preview server's identity against. Run \`npm run build\` first (the \`pree2e\` ` +
        `hook already does this before Playwright starts).`,
      { cause: err },
    );
  }
}

function readLocalDistIndexHtml(): string {
  return readLocalFileOrThrow(DIST_INDEX_HTML);
}

function readLocalDistSwJs(): string {
  return readLocalFileOrThrow(DIST_SW_JS);
}

/** Throws with a diagnostic naming BOTH the observed and expected entry
 * chunk when the served document doesn't byte-match `localHtml` — see the
 * block comment above `extractEntryScriptSrc` for what this establishes
 * (and does not). No-op (returns) on an exact match. */
function assertServingThisBuild(servedHtml: string, localHtml: string): void {
  if (servedHtml === localHtml) return;
  const expected = extractEntryScriptSrc(localHtml, `local ${DIST_INDEX_HTML}`);
  let observed: string;
  try {
    observed = extractEntryScriptSrc(servedHtml, `served ${BASE}`);
  } catch {
    observed = `(no recognisable entry tag; first 200 chars: ${JSON.stringify(servedHtml.slice(0, 200))})`;
  }
  throw new Error(
    `#803: the server answering at ${BASE} is not serving this run's own build.\n` +
      `  expected entry chunk (from ${DIST_INDEX_HTML}): ${expected}\n` +
      `  observed entry chunk:                            ${observed}\n` +
      `This usually means a process was already bound to port ${PORT} before this run's own ` +
      `\`vite preview --strictPort\` could bind it — so EADDRINUSE was never raised, the foreign ` +
      `responder just answered our readiness poll instead — or a stale dist/ is being served. ` +
      `Refusing to proceed rather than test the wrong build.`,
  );
}

/** #803 MAJOR 1: `index.html` byte-matching alone is blind to `src/sw.ts`
 * and everything under `public/**` (see the block comment above), because
 * neither is referenced by a hashed asset URL inside `index.html`. This
 * closes that gap by byte-comparing the served `sw.js` (workbox's injected
 * precache manifest — see that block comment for exactly what it covers
 * and what it still doesn't) against `dist/sw.js`. No-op on an exact
 * match; throws with lengths (not a diff — `sw.js` is a single minified
 * bundle with no stable "entry" to name) on a mismatch. */
function assertSwJsMatches(servedSwJs: string, localSwJs: string): void {
  if (servedSwJs === localSwJs) return;
  throw new Error(
    `#803: the server answering at ${SW_JS_URL} is not serving this run's own build — its ` +
      `service worker doesn't byte-match ${DIST_SW_JS}.\n` +
      `  expected length: ${localSwJs.length} bytes\n` +
      `  observed length: ${servedSwJs.length} bytes\n` +
      `dist/sw.js carries this build's own workbox precache manifest (index.html, data/mask.bin, ` +
      `every polar, harbors.json, seamarks.json, the basemap archive, icons and sprites) — a ` +
      `mismatch here means public/** or src/sw.ts differs even though index.html matched. ` +
      `Refusing to proceed rather than test the wrong build.`,
  );
}

/** #833/#854: extracts the set of dist-relative URLs workbox's
 * `injectManifest` baked into `sw.js` as the sole argument to its (minified,
 * renamed) `precacheAndRoute` call — e.g. `W([{"revision":"...","url":
 * "index.html"}, ...])`. Located STRUCTURALLY (the array's opening
 * `[{"revision"` token, then its closing `]`) rather than by the call's own
 * name, which minification renames every build. Fails CLOSED (throws) on a
 * shape it doesn't recognise, matching `extractEntryScriptSrc`'s precedent
 * above: an empty or wrongly-prefixed set here would make EVERY dist/ file
 * look like it "escapes" the manifest — including files genuinely covered by
 * it, whose coverage would then be silently DROPPED, not merely widened —
 * so this must not be allowed to pass silently regardless of how expensive
 * the resulting over-check would or wouldn't be (that cost question is
 * `pickResidualRepresentatives`'s concern, below, not this function's: this
 * function's job is only to get the SET right, never to reason about what a
 * wrong set would cost downstream — review MINOR 2 is precisely a prior
 * version of this comment doing that instead, with a specific fetch count
 * that was correct for a since-changed implementation of that other function
 * and would have gone stale again at the next change to it). The
 * `!urls.has('index.html')` check below (review MINOR 1) is what actually
 * catches a wrongly-prefixed manifest (e.g. a `modifyURLPrefix` workbox
 * option this project doesn't use today) before it can reach that other
 * function at all — a missing marker, unlike a missing array, would
 * otherwise parse fine and degrade silently. */
function parsePrecacheManifestUrls(swJs: string, source: string): Set<string> {
  const start = swJs.indexOf('[{"revision"');
  if (start === -1) {
    throw new Error(
      `#833/#854: could not find workbox's precache manifest array in ${source} — cannot ` +
        `determine which dist/ files it covers.`,
    );
  }
  const end = swJs.indexOf(']', start);
  if (end === -1) {
    throw new Error(`#833/#854: precache manifest array in ${source} has no closing ']'.`);
  }
  let entries: Array<{ url?: unknown }>;
  try {
    entries = JSON.parse(swJs.slice(start, end + 1)) as Array<{ url?: unknown }>;
  } catch (err) {
    throw new Error(
      `#833/#854: precache manifest array in ${source} did not parse as JSON: ` +
        `${(err as Error).message}`,
      { cause: err },
    );
  }
  const urls = new Set(
    entries.map((entry, i) => {
      if (typeof entry.url !== 'string') {
        throw new Error(
          `#833/#854: precache manifest entry ${i} in ${source} has no string "url" — cannot ` +
            `determine which dist/ files it covers.`,
        );
      }
      return entry.url;
    }),
  );
  // Review MINOR 1: `index.html` is ALWAYS precached (workbox's own
  // `globPatterns` includes `html`, and this app ships exactly one), so its
  // absence means the parsed URLs carry a prefix or shape this diff doesn't
  // recognise — e.g. a `modifyURLPrefix`/`dontCacheBustURLsMatching`-shaped
  // rewrite. Left unguarded, that would silently treat every real dist/ file
  // as escaping (none of them would match either, not just the ones this PR
  // cares about) — `pickResidualRepresentatives`'s threshold does NOT bound this: with nothing
  // matching, most directories fall UNDER the threshold and are checked one per
  // FILE, so the degraded set includes multi-megabyte assets never meant to be
  // fetched here (the basemap archive alone is ~27 MB) — 60+ call sites x that
  // would be materially expensive, so this must fail LOUD rather than silently widen.
  if (!urls.has('index.html')) {
    throw new Error(
      `#833/#854: workbox's precache manifest in ${source} does not list "index.html" — the ` +
        `parsed URLs likely carry an unexpected prefix this structural diff cannot see. ` +
        `Refusing to guess which dist/ files it covers.`,
    );
  }
  return urls;
}

/** Every file under `dist/`, as POSIX-style paths relative to `dist/` itself
 * (`data/mask.bin`, `test-fixtures/wind-sw12.json`, ...). Used only to diff
 * against `parsePrecacheManifestUrls`'s result — see the block comment above
 * `assertSwJsMatches` for why. */
function walkDistFiles(dir: string, relBase: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkDistFiles(resolve(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// #833/#854 review MAJOR: a bare one-representative-per-directory scheme has
// a SELECTION blind spot, not just a coverage gap — the picked file is
// whichever sorts lexicographically first, so a SECOND escaping file dropped
// into an already-represented directory can silently take over as "the"
// representative while the file that motivated the check goes unchecked.
// Measured concretely: on a dev machine with `gen-docs-wind-fixture.mjs` run
// (CLAUDE.md requires this before every README recapture), `test-fixtures/`
// holds BOTH `wind-docs-plan-route.json` and `wind-sw12.json` — the former
// sorts first, so it silently became the sole representative and a mutation
// confined to `wind-sw12.json` (the file #833 itself names as "the sharpest
// case") passed undetected on that machine, even though the identical
// mutation was caught on a CI-shaped tree with no docs fixture present. Root
// cause is the same for a BARE directory too: `dirname('THIRD-PARTY-
// NOTICES.txt') === '.'`, so a future root-level file (`.nojekyll`,
// `404.html`) would shadow it the same way (no dotfiles sit at dist/ root
// today, so this is latent, not live).
const FULL_CHECK_MAX_FILES_PER_DIR = 8;

/** #833/#854: for each directory holding files NOT covered by workbox's
 * precache manifest, fully checks EVERY escaping file in that directory when
 * there are `FULL_CHECK_MAX_FILES_PER_DIR` or fewer of them, and falls back
 * to ONE lexicographically-first representative only once a directory's
 * escaping count exceeds that — see the block comment above for why a bare
 * one-per-directory scheme is unsound (a selection blind spot, not merely an
 * exhaustiveness one) and the block comment above `assertSwJsMatches` for
 * the cost-bound rationale this fallback still honours (this file has 60+
 * `startPreview()` call sites, and the escaping set today is dominated by
 * ~770 font glyph-range files split across only three-plus directories, so
 * fully checking those specifically would be tens of thousands of extra
 * requests across the suite). At `FULL_CHECK_MAX_FILES_PER_DIR = 8` a build
 * with the docs wind fixture present checks 9 files total (measured against
 * a real build, 2026-09-03) — up from 8 without it — because BOTH
 * `test-fixtures/` files now sit under the threshold and are checked
 * together, closing the selection blind spot above. Deterministic (paths
 * sorted within and across groups) so a failure is reproducible. */
function pickResidualRepresentatives(distFiles: string[], manifestUrls: Set<string>): string[] {
  const escaping = distFiles.filter(
    (f) => !manifestUrls.has(f) && f !== 'index.html' && f !== 'sw.js',
  );
  const byDir = new Map<string, string[]>();
  for (const f of escaping) {
    const dir = dirname(f);
    const group = byDir.get(dir);
    if (group) group.push(f);
    else byDir.set(dir, [f]);
  }
  const picked: string[] = [];
  for (const group of byDir.values()) {
    group.sort();
    if (group.length <= FULL_CHECK_MAX_FILES_PER_DIR) {
      picked.push(...group);
    } else {
      picked.push(group[0]);
    }
  }
  return picked.sort();
}

/** #833/#854: byte-compares each of `relPaths` (already narrowed by
 * `pickResidualRepresentatives` to every escaping file in a small directory,
 * or one representative in a large one) against its served copy. Read as a
 * Buffer, not text — several of these
 * (`.png`, `.pbf`) are binary, and a `utf8` round-trip is not guaranteed to
 * preserve byte equality for them. No-op if `relPaths` is empty (a build
 * with nothing outside the manifest — nothing to check). Throws immediately
 * on the FIRST mismatch or fetch failure, matching `assertSwJsMatches`'s
 * fail-fast style: a real foreign build failing to serve a `.pbf` byte-for-
 * byte is exactly the condition this whole check exists to catch. */
async function assertResidualDistFilesMatch(relPaths: string[]): Promise<void> {
  for (const relPath of relPaths) {
    const localPath = resolve(DIST_DIR, relPath);
    let localBuf: Buffer;
    try {
      localBuf = readFileSync(localPath);
    } catch (err) {
      throw new Error(
        `#833/#854: could not read ${localPath} (${(err as Error).message}) while checking a ` +
          `dist/ file outside workbox's precache manifest.`,
        { cause: err },
      );
    }
    const url = BASE + relPath.split('/').map(encodeURIComponent).join('/');
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (fetchErr) {
      throw new Error(
        `#833/#854: fetching ${url} (a dist/ file outside the precache manifest) failed or ` +
          `timed out after ${FETCH_TIMEOUT_MS}ms — cannot establish build identity for it: ` +
          `${(fetchErr as Error).message}`,
        { cause: fetchErr },
      );
    }
    if (!res.ok) {
      throw new Error(
        `#833/#854: expected ${url} to respond 200, got ${res.status} — cannot establish build ` +
          `identity for it.`,
      );
    }
    const servedBuf = Buffer.from(await res.arrayBuffer());
    if (!localBuf.equals(servedBuf)) {
      throw new Error(
        `#833/#854: the server answering at ${url} is not serving this run's own build — this ` +
          `file sits outside workbox's precache manifest (a globIgnores subtree or an off-` +
          `globPatterns extension), so index.html and sw.js matching did not catch the drift.\n` +
          `  expected length: ${localBuf.length} bytes (${localPath})\n` +
          `  observed length: ${servedBuf.length} bytes\n` +
          `Refusing to proceed rather than test the wrong build.`,
      );
    }
  }
}

/**
 * Spawns `npm run preview -- --port 4173 --strictPort` in app/ and waits
 * until it answers with a 200 SERVING THIS RUN'S OWN BUILD (see the #803
 * block comment above). `START_TIMEOUT_MS` (30s) bounds the OUTER loop —
 * the number of poll iterations. Each individual `fetch` (there are now
 * two per successful iteration: `BASE`, then `SW_JS_URL`) is ALSO bounded,
 * via `FETCH_TIMEOUT_MS`'s `AbortSignal.timeout(...)`: without it, a
 * responder that accepts the connection and then never answers can hold a
 * single `await` for undici's own headers-timeout ceiling — measured (PR
 * #823 review) at 301,364 ms on `fetch(BASE)` and 300,340 ms on
 * `fetch(SW_JS_URL)` once the latter existed — well past `START_TIMEOUT_MS`
 * and material against `ci.yml`'s 30-minute `e2e` cap. `detached: true`
 * makes the child the leader of its own process group so kill() can take
 * out `npm` *and* the `vite preview` process it launches with one SIGKILL
 * to the negated pid — killing only the `npm` pid can leave `vite preview`
 * (and its bound port) running, which would strand port 4173 for the next
 * spec/run.
 */
export async function startPreview(): Promise<PreviewServer> {
  // Read (and shape-validate) THIS run's own built dist BEFORE spawning
  // anything, so a missing/malformed build fails fast with a clear cause
  // rather than racing the poll loop below.
  const localHtml = readLocalDistIndexHtml();
  extractEntryScriptSrc(localHtml, `local ${DIST_INDEX_HTML}`);
  const localSwJs = readLocalDistSwJs();
  // #833/#854: computed from the LOCAL build only, once, up front — see the
  // block comment above `assertSwJsMatches` for what this closes and its
  // named residual. Depends only on `localSwJs` (not the served copy), so
  // it's safe to compute before the server has even answered once.
  const residualRepresentatives = pickResidualRepresentatives(
    walkDistFiles(DIST_DIR, ''),
    parsePrecacheManifestUrls(localSwJs, `local ${DIST_SW_JS}`),
  );

  const child = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
  });

  // Captured rather than thrown immediately: 'error' (e.g. ENOENT if `npm`
  // isn't on PATH) can fire before or after the poll loop starts, and we
  // want it surfaced with useful context either way — see usage below.
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    spawnError = err;
  });

  let killed = false;
  const kill = () => {
    if (killed || !child.pid) return;
    killed = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already dead — fine, kill() is best-effort/idempotent
    }
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(
        `preview server process failed to spawn before answering at ${BASE}: ${spawnError.message}`,
      );
    }
    if (child.exitCode !== null) {
      throw new Error(
        `preview server process exited early (code ${child.exitCode}) before answering at ${BASE}`,
      );
    }
    let res: Response | undefined;
    try {
      // Bounded via AbortSignal.timeout — see this function's own doc
      // comment. A timeout here lands in this catch (retry-worthy, same as
      // ECONNREFUSED) rather than hanging the whole poll loop.
      res = await fetch(BASE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      // server not accepting connections yet, or the fetch timed out — keep polling
    }
    if (res?.ok) {
      // #803: deliberately OUTSIDE the try/catch above — a network-level
      // fetch failure is retry-worthy (server not up yet), but an identity
      // mismatch is not: it means SOMETHING is answering and it is the
      // wrong thing, so this must fail loudly and immediately rather than
      // being swallowed into "keep polling until the deadline" (which would
      // report a misleading generic timeout instead of naming the actual
      // foreign build).
      try {
        const servedHtml = await res.text();
        assertServingThisBuild(servedHtml, localHtml);
        // #803 MAJOR 1: index.html matching alone is blind to src/sw.ts and
        // public/** (see the block comment above extractEntryScriptSrc) —
        // this second fetch closes that gap. A non-200, a timeout, or a
        // throw here is itself evidence of a foreign/broken responder, not
        // a "keep polling" condition: BASE already answered 200 moments
        // ago, so this fetch is bounded (FETCH_TIMEOUT_MS) and its failure
        // reported directly rather than silently retried.
        let swRes: Response;
        try {
          swRes = await fetch(SW_JS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        } catch (fetchErr) {
          throw new Error(
            `#803: fetching ${SW_JS_URL} (this build's service worker) failed or timed out ` +
              `after ${FETCH_TIMEOUT_MS}ms — cannot establish build identity: ` +
              `${(fetchErr as Error).message}`,
            { cause: fetchErr },
          );
        }
        if (!swRes.ok) {
          throw new Error(
            `#803: expected ${SW_JS_URL} (this build's service worker) to respond 200, got ` +
              `${swRes.status} — cannot establish build identity`,
          );
        }
        const servedSwJs = await swRes.text();
        assertSwJsMatches(servedSwJs, localSwJs);
        // #833/#854: closes (most of) the gap named in the block comment
        // above — see `pickResidualRepresentatives`'s own comment for the
        // named residual this does NOT close.
        await assertResidualDistFilesMatch(residualRepresentatives);
      } catch (err) {
        kill();
        throw err;
      }
      return { url: BASE, kill };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  kill();
  // A captured spawn error (e.g. ENOENT) is the real cause of a timeout here —
  // surface it instead of a bare, misleading "didn't respond in 30s".
  const cause = spawnError ? `: ${spawnError.message}` : '';
  throw new Error(`preview server did not respond at ${BASE} within ${START_TIMEOUT_MS}ms${cause}`);
}

// #253 fix-up: readiness gate for a map that has actually rendered. The app
// deliberately exposes no global map handle (there is no reason for
// production code to), so this reads MapView's `map` state through the React
// fiber instead — test-harness only, and asserted to succeed rather than
// silently skipped: a fiber layout change must fail loudly, not quietly
// delete the strongest assertions built on it.
//
// `waitForLoadState('networkidle')` is always the wrong signal for a map app
// that streams tiles forever (CLAUDE.md's verification-lessons record why),
// and maplibre-gl 6 stopped producing a `requestfinished` Playwright counts
// for its module-worker fetch. `mapReady` waits for the map handle AND for
// `map.loaded()`, which is the only signal that actually proves the tile
// pipeline — and therefore the worker — is alive. Keeping the `map.loaded()`
// half is deliberate: during the maplibre-gl 6 upgrade this gate went red for
// a REAL product bug (the worker chunk shipped with an unresolved
// `./maplibre-gl-shared.mjs` import and 404'd on its own dependency, so no
// vector/GeoJSON source ever loaded) — the gate was correctly reporting a
// broken map. That bug is fixed at source (MapView.tsx's `?worker&url`
// import); this gate is what keeps that fix honest, so do not weaken it back
// to "the handle exists" — that would pass against a map rendering nothing
// at all. It reads `map.loaded()` rather than a fiber-existence check for the
// same reason, and returns a descriptive STRING rather than a boolean on
// purpose: a boolean collapsed into `.toBe(true)` can only ever report
// `Expected: true / Received: false` plus a timeout, indistinguishable
// between "slow" and "never" — the string names the pending sources, so a CI
// failure says which part of the pipeline stalled.
//
// Promoted here from THREE independent copies (`datalayers.spec.ts`,
// `compass.spec.ts`, `layout.spec.ts` — each written "duplicated rather than
// imported... worth promoting to helpers.ts in a follow-up" and then never
// promoted) per CLAUDE.md's enumerate-don't-patch rule: a comment pointing at
// a follow-up is not a tracker, and a fourth divergent copy is exactly the
// shape that rule warns against letting recur. Only `mapReady` is exported —
// `installMapHandle`/`mapReadyState` are call-site-internal to it, and no
// spec has ever called them directly.
async function installMapHandle(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.maplibregl-map');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    let f = (el as unknown as Record<string, { memoizedState?: unknown; return?: unknown }>)[key];
    while (f) {
      let h = f.memoizedState as { memoizedState?: unknown; next?: unknown } | undefined;
      let guard = 0;
      while (h && guard++ < 60) {
        const v = h.memoizedState as { getBearing?: unknown; project?: unknown } | undefined;
        if (v && typeof v.getBearing === 'function' && typeof v.project === 'function') {
          (window as unknown as Record<string, unknown>).__scE2eMap = v;
          return true;
        }
        h = h.next as typeof h;
      }
      f = f.return as typeof f;
    }
    return false;
  });
}

type ReadyMap = {
  loaded: () => boolean;
  getStyle: () => { sources: Record<string, unknown> };
  isSourceLoaded: (id: string) => boolean;
};

async function mapReadyState(page: Page): Promise<string> {
  if (!(await installMapHandle(page))) return 'no-map-handle';
  return page.evaluate(() => {
    const map = (window as unknown as { __scE2eMap?: ReadyMap }).__scE2eMap;
    if (!map) return 'handle-lost';
    if (!map.loaded()) {
      const pending = Object.keys(map.getStyle().sources).filter((id) => !map.isSourceLoaded(id));
      return `not-loaded (pending sources: ${pending.join(', ') || 'none — style still parsing'})`;
    }
    return 'loaded';
  });
}

/** Gate a spec on a map that has actually rendered, reporting WHY if it hasn't. */
export async function mapReady(page: Page): Promise<void> {
  await expect.poll(() => mapReadyState(page), { timeout: 60_000 }).toBe('loaded');
}

// #412: the live `--sc-banner-height` custom property on `:root`, published
// by `lib/useBannerHeight.ts`'s ResizeObserver and read by app.css's
// narrow-layout banner-clearance rule (`--sc-banner-clear-top: calc(3.5rem +
// var(--sc-banner-height, 176px))`). Several e2e guards assert geometry that
// only settles into its final position AFTER this property is written — a
// `boundingBox()` read taken before that write observes the pre-push
// position, and a real interception (the defect these guards exist to
// catch) produces the SAME failure signature as that measurement race. This
// helper lets an assertion report the live value alongside the coordinate/
// element it probed, so a CI failure names which signal was stale instead of
// leaving the two causes indistinguishable.
export function bannerHeightVar(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sc-banner-height').trim(),
  );
}
