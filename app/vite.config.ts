/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';
import { readFragmentsFromDir } from './src/lib/changelogFragmentsFs.ts';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// #96: UAT deploy of `develop` to the Pages sub-path /sail_command/uat/,
// alongside production's unchanged /sail_command/ root. deploy.yml sets
// SC_DEPLOY_ENV=uat only for the develop build; the production build never
// sets it, so `isUat` is false and `basePath` matches the pre-#96 constant
// exactly — production's build output is unaffected by this addition.
const isUat = process.env.SC_DEPLOY_ENV === 'uat';
const basePath = isUat ? '/sail_command/uat/' : '/sail_command/';

// #131: the one out-of-root file the dev server may serve (see `server` below).
const changelogPath = resolve(APP_DIR, '..', 'CHANGELOG.md');

// #189: reads changelog.d/*.md fragments Node-side via `fs` at build time and
// exposes them through the `virtual:changelog-fragments` module —
// AboutDialog.tsx folds them into a synthetic 'Unreleased' preview (see
// src/lib/changelogFragments.ts's module comment for the full mechanism).
// Deliberately NOT a `?raw` glob import: `server.fs.allow` (set below, right
// above `server:`) REPLACES the default workspace root, so an out-of-root
// `?raw` import needs an exact allowlist entry per file (#131's own trap,
// documented in CLAUDE.md) — a *directory* of files named by contributors
// would need that allowlist widened on every PR. A plugin's own
// `fs.readdirSync`/`readFileSync` calls run in the plugin's Node process and
// never reach the dev-server transform middleware that allowlist gates, so
// this sidesteps the trap entirely rather than working around it.
const changelogFragmentsDir = resolve(APP_DIR, '..', 'changelog.d');

function changelogFragmentsPlugin(): Plugin {
  const virtualModuleId = 'virtual:changelog-fragments';
  const resolvedVirtualModuleId = '\0' + virtualModuleId;

  // All the actual `fs` I/O (directory scan, symlink/directory rejection,
  // per-file read-with-fallback) plus fragment parsing lives in
  // `readFragmentsFromDir` (`src/lib/changelogFragmentsFs.ts`) — pulled out
  // to be unit-testable against a real temp directory (#189 review round 2:
  // the plugin previously read every directory ENTRY unconditionally,
  // inlining a symlink's TARGET content into the shipped bundle and
  // hard-crashing the build on a directory or an unreadable file).
  const readFragments = (): ReturnType<typeof readFragmentsFromDir> =>
    readFragmentsFromDir(changelogFragmentsDir, (message) => console.warn(message));

  return {
    name: 'sailcommand:changelog-fragments',
    resolveId(id) {
      return id === virtualModuleId ? resolvedVirtualModuleId : undefined;
    },
    load(id) {
      if (id !== resolvedVirtualModuleId) return undefined;
      return `export default ${JSON.stringify(readFragments())};`;
    },
    configureServer(server) {
      // Fragments aren't real ES module dependencies of anything, so Vite's
      // default dependency graph never notices a changelog.d/*.md edit —
      // watch the directory explicitly and invalidate + reload on change.
      server.watcher.add(changelogFragmentsDir);
      server.watcher.on('all', (_event, changedPath) => {
        // `+ sep`, not a bare prefix match: a bare `startsWith` would also
        // match an unrelated SIBLING path that merely shares the prefix
        // (`changelog.d-old/x.md`, `changelog.dump`), firing a spurious
        // full-page reload in dev.
        if (!changedPath.startsWith(changelogFragmentsDir + sep)) return;
        const mod = server.moduleGraph.getModuleById(resolvedVirtualModuleId);
        if (mod !== undefined) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}

// #96: rewrites the two absolute og: URLs to the actual deploy sub-path and,
// for the UAT build only, marks the page noindex and retitles it — so the
// staging deploy is never confused with (or indexed as) production. Regex
// on the exact production strings rather than templating index.html, so a
// production build's html output is byte-for-byte identical to before #96.
// Exported (only public function in this file, #318) so
// src/test/subPathMeta.test.ts can pin the fail-closed guard directly rather
// than only empirically, the way #223's sibling cspMeta() guard was verified.
export function subPathMeta(base: string, uat: boolean): Plugin {
  const origin = 'https://docgerd.github.io';
  const OG_URL_MARKER =
    '<meta property="og:url" content="https://docgerd.github.io/sail_command/" />';
  const OG_IMAGE_MARKER =
    '<meta property="og:image" content="https://docgerd.github.io/sail_command/brand/social-card.png" />';
  const TITLE_MARKER = '<title>SailCommand</title>';
  const THEME_COLOR_MARKER = '<meta name="theme-color" content="#10243D" />';
  // #318: mirrors cspMeta()'s fail-closed guard (#223 review m4) — String.replace
  // with a STRING pattern silently returns the input UNCHANGED when the
  // pattern is absent, no throw, no warning. Measured on this exact plugin
  // shape (PR #316 review): reformatting a meta tag made `vite build` exit 0
  // with the injection silently skipped. The `robots` noindex meta is what
  // makes this a BLOCKING guard rather than a nudge — a silent no-op here
  // would let the unreleased UAT deploy become indexable (guard-asymmetry
  // rule in CLAUDE.md: an absent security/indexing control is the expensive
  // failure direction, so it must fail closed).
  const requireMarker = (html: string, marker: string, label: string): void => {
    if (!html.includes(marker)) {
      throw new Error(
        `sailcommand:sub-path-meta — ${label} marker not found in index.html; ` +
          'its replacement would be silently omitted from the build',
      );
    }
  };
  return {
    name: 'sailcommand:sub-path-meta',
    transformIndexHtml(html) {
      requireMarker(html, OG_URL_MARKER, 'og:url');
      requireMarker(html, OG_IMAGE_MARKER, 'og:image');
      let out = html
        .replace(OG_URL_MARKER, `<meta property="og:url" content="${origin}${base}" />`)
        .replace(
          OG_IMAGE_MARKER,
          `<meta property="og:image" content="${origin}${base}brand/social-card.png" />`,
        );
      if (uat) {
        requireMarker(html, TITLE_MARKER, 'title');
        requireMarker(html, THEME_COLOR_MARKER, 'theme-color (robots noindex insertion point)');
        out = out
          .replace(TITLE_MARKER, '<title>SailCommand UAT</title>')
          .replace(
            THEME_COLOR_MARKER,
            `${THEME_COLOR_MARKER}\n    <meta name="robots" content="noindex, nofollow" />`,
          );
      }
      return out;
    },
  };
}

// #223: injects the Content-Security-Policy <meta http-equiv> at BUILD time
// only (apply: 'build') — deliberately absent from index.html's source and
// from `vite dev`'s served HTML. Vite's dev client injects CSS as `<style>`
// elements with `textContent`, which a `style-src 'self'` policy blocks
// outright (measured, PR #316 review B2: dev renders fully unstyled — 0
// stylesheets, 0 CSS rules — with only a console `style-src-elem`/`inline`
// violation, no visible error). Injected right after <meta charset>, the
// same position the meta held when it was static, so build output is
// otherwise unchanged; referrer/viewport/etc. stay static in index.html
// since they don't gate resource loading and are harmless in dev.
function cspMeta(): Plugin {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    // worker-src: 'self' only — see the comment below for why `blob:` was
    // investigated and rejected (PR #316 review B1/M3), not merely unused.
    "worker-src 'self'",
    "connect-src 'self' https://api.open-meteo.com wss://stream.aisstream.io",
    // img-src keeps blob: — unlike the worker case this path is genuinely
    // reachable (browser-dependent createImageBitmap fallback in maplibre's
    // util/util.ts arrayBufferToImage, and the PMTiles raster path).
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
  const comment =
    `<!-- #223: GitHub Pages cannot set response headers, so this ` +
    `<meta http-equiv> form is the only CSP mechanism available to a
         static-hosted PWA. Known, accepted limitation of that form: it
         cannot express \`frame-ancestors\` or \`report-uri\` — neither matters
         here (static host, no framing threat model in play, no collector to
         report to). Directives, and why each is present (verified against a
         fresh maplibre-gl 6 build, #253):
         - worker-src 'self' — the routing engine's own worker
           (workerClient.ts) and MapView.tsx's \`setWorkerUrl\` (a Vite
           \`?worker&url\` same-origin asset) are both 'self'. maplibre-gl 6's
           own blob-URL worker fallback (util/web_worker.ts's
           \`workerFactory()\`) was investigated and REJECTED, not merely
           unused: it short-circuits to the same-origin path whenever the URL
           is same-origin (\`if (!isCrossOrigin(url)) return
           createWorker(url, asModule)\`), which is always true here, so the
           blob branch can never execute — and adding \`blob:\` anyway was
           measured (PR #316 review B1) to defeat \`script-src 'self'\`
           outright: \`new Worker(URL.createObjectURL(new
           Blob(['self.postMessage(...)'])))\` ran arbitrary code under this
           exact policy. Deliberately omitted, not merely unused.
         - img-src 'self' data: blob: — maplibre creates object URLs for
           raster images/glyphs (util.ts) and the PMTiles basemap source does
           the same; \`data:\` covers inline icons. Unlike the worker case this
           path IS reachable (browser-dependent \`createImageBitmap\`
           fallback), so \`blob:\` stays here.
         - connect-src 'self' https://api.open-meteo.com
           wss://stream.aisstream.io — the two outbound third-party feeds
           (Open-Meteo forecasts over HTTPS, optional BYOK AIS over WSS) plus
           same-origin XHR/fetch (PMTiles range reads, SW, IndexedDB-adjacent
           fetches). Restricts background requests only (fetch/XHR/WebSocket/
           beacon) — top-level navigation, \`window.open\`, DNS-prefetch/
           preconnect, and WebRTC are a separate, accepted residual (see
           docs/security-assurance-case.md's known-gaps table).
         - script-src 'self', style-src 'self' — no inline script or injected
           \`<style>\` anywhere in the app or its maplibre-gl/pmtiles
           dependencies (grepped); React's \`style\` prop sets CSSOM properties
           individually, which CSP style-src does not gate. This meta is
           build-only (see the function comment above) precisely because
           Vite's OWN dev-mode CSS injection would otherwise violate it.
         - 'wasm-unsafe-eval' is deliberately OMITTED: no WebAssembly and no
           \`new Function(\`/\`eval(\` in the built bundle or the maplibre-gl
           worker chunk (re-verified against this build, not assumed from an
           older one).
         - base-uri 'none', object-src 'none', form-action 'none' — the app
           has no <base>, no plugins/embeds, and no forms that submit
           anywhere. -->`;
  const MARKER = '<meta charset="UTF-8" />';
  return {
    name: 'sailcommand:csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      // #223 review m4: String.replace with a STRING pattern silently
      // returns the input UNCHANGED when the pattern is absent — no throw,
      // no warning. A routine edit to index.html (e.g. a formatter lowering
      // `UTF-8` to `utf-8`, still valid HTML) would then ship a green build
      // with ZERO CSP metas and no signal anywhere. This is a BLOCKING guard
      // (an absent security control is the expensive failure direction), so
      // it must fail closed — see the guard-asymmetry rule in CLAUDE.md.
      if (!html.includes(MARKER)) {
        throw new Error(
          'sailcommand:csp-meta — charset marker not found in index.html; ' +
            'the Content-Security-Policy <meta> would be silently omitted from the build',
        );
      }
      return html.replace(
        MARKER,
        `${MARKER}\n    ${comment}\n    <meta\n      ` +
          `http-equiv="Content-Security-Policy"\n      content="${directives}"\n    />`,
      );
    },
  };
}

// #28: emits dist/glyph-manifest.json — the complete, sorted list of font
// glyph-range files under public/basemap-assets/fonts/, as BASE_URL-relative
// paths. Fonts are excluded from the SW precache (globIgnores below) and
// served from a runtime cache instead; src/services/glyphWarmup.ts consumes
// this manifest after activation to backfill the ranges the map hasn't
// requested yet, so offline coverage converges without blocking the install.
// The emitted JSON itself IS picked up by the precache glob (**/*.json) —
// tiny, and it keeps the warm-up's source of truth available offline.
// Build-only (apply: 'build'): fine for `vite dev`, where the warm-up never
// runs at all — no SW ever registers, so it parks waiting for a controller
// and never reaches the manifest fetch; the 404→warn+skip path only occurs
// under a stale controlling SW from an older deploy.
function glyphManifest(): Plugin {
  return {
    name: 'sailcommand:glyph-manifest',
    apply: 'build',
    generateBundle() {
      const fontsDir = resolve(APP_DIR, 'public/basemap-assets/fonts');
      const paths = readdirSync(fontsDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.pbf'))
        .map((entry) =>
          ['basemap-assets/fonts', relative(fontsDir, entry.parentPath), entry.name]
            .join('/')
            // POSIX-normalize in case relative() produced platform separators.
            .split(sep)
            .join('/'),
        )
        .sort();
      // Deploy is gated on the build alone — an empty manifest would ship a
      // fontless offline experience with nothing else failing, so a missing
      // or empty fonts directory must fail the build loudly.
      if (paths.length === 0) {
        this.error('glyph-manifest: no .pbf files found under public/basemap-assets/fonts');
      }
      this.emitFile({
        type: 'asset',
        fileName: 'glyph-manifest.json',
        source: JSON.stringify(paths),
      });
    },
  };
}

// #125: build-time app version shown in the About dialog — baked into the
// bundle by the `define` below, NEVER runtime-fetched: the whole point is
// diagnosing stale-service-worker installs, so the string must identify the
// bundle it ships in. The dev server always shows the literal 'dev' (a baked
// describe string would go stale between config loads); a build embeds `git
// describe --tags --always` (e.g. v0.3.0-2-gabc1234) — `--always` degrades
// shallow/tagless checkouts to a bare short SHA instead of throwing, and
// deliberately NO `--dirty`: the always-dirty .claude/settings.json would
// otherwise poison the prod double-build byte-identity verification (#107).
// If git itself is unavailable (tarball build), fall back to the app's
// package.json version.
function appVersion(command: 'build' | 'serve'): string {
  if (command === 'serve') return 'dev';
  try {
    return execFileSync('git', ['describe', '--tags', '--always'], { encoding: 'utf8' }).trim();
  } catch {
    const pkg = JSON.parse(readFileSync(resolve(APP_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    return pkg.version;
  }
}

// #214: with no cache (every CI run — `npm ci` wipes node_modules, so
// vitest's own results cache never survives to the next run), vitest's
// BaseSequencer.sort falls back to ordering files by size, descending. The
// suite's single slowest file, invariants.property.test.ts, is also its
// smallest (~4.4 KB against a ~66 KB largest file), so it sorts near the
// BACK of ~97 files and starts ~109s late — becoming the tail of the whole
// test step even though other workers are free the entire time (measured:
// https://github.com/DocGerd/sail_command/issues/214). Pinning it (and the
// next-slowest file) to the FRONT lets their ~680s combined CPU run
// concurrently with the other ~95 files' ~230s instead of serially after
// them. Order here is the desired START order (slowest first); add a file
// to this list if a future addition shows the same
// small-file/disproportionately-slow-run mismatch.
const SLOW_TEST_FILES_FIRST = [
  'src/routing/invariants.property.test.ts',
  'src/routing/realmask.repro.test.ts',
];

// Extends BaseSequencer rather than reimplementing it: only `sort` changes
// (the two known-slow files move to the front, everything else keeps
// BaseSequencer's default order); `shard` is inherited untouched so sharded
// runs still work.
class SlowFileFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const priorityRank = (spec: TestSpecification): number => {
      const path = spec.moduleId.replace(/\\/g, '/');
      return SLOW_TEST_FILES_FIRST.findIndex((suffix) => path.endsWith(suffix));
    };
    const priority = files
      .filter((spec) => priorityRank(spec) !== -1)
      .sort((a, b) => priorityRank(a) - priorityRank(b));
    const rest = files.filter((spec) => priorityRank(spec) === -1);
    return [...priority, ...(await super.sort(rest))];
  }
}

export default defineConfig(({ command }) => ({
  base: basePath,
  plugins: [
    react(),
    glyphManifest(),
    changelogFragmentsPlugin(),
    subPathMeta(basePath, isUat),
    cspMeta(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // 'prompt': autoUpdate reloading mid-passage-planning is unacceptable.
      // Precache installs are atomic (see sw.ts), so a connection lost
      // mid-update just leaves the currently-installed version fully
      // working until the user opts into ReloadPrompt's reload.
      registerType: 'prompt',
      injectManifest: {
        // ~33 MB expected (basemap.pmtiles.png + mask.bin + polars + sprites
        // + app shell) — see spec §7's first-load budget. The ~11 MB of font
        // glyph ranges are runtime-cached, not precached (#28, below).
        // #118: the basemap archive ships as `.pmtiles.png` (CDN gzip-of-
        // range workaround, see src/lib/basemap.ts) — it is matched by the
        // `png` token below, so no dedicated `pmtiles` token remains.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        // #253: the maplibre-gl worker chunk MUST be precached — without it
        // the vector basemap works online but breaks OFFLINE, since
        // `setWorkerUrl`'s hashed asset URL has no runtime-cache route. The
        // `js` token below already covers it: MapView.tsx's `?worker&url`
        // import runs the worker through Vite's worker pipeline, which emits
        // `assets/maplibre-gl-worker-<hash>.js` (Vite names ES-format worker
        // chunks `.js` regardless of the `.mjs` source extension). No `mjs`
        // token is needed — the build emits no `.mjs` file at all.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin,pbf}'],
        // brand/social-card.png is an og:image served over HTTP, not part of
        // the offline app — keep it out of the precache so the install
        // budget (#28) doesn't grow.
        // basemap-assets/fonts/: 768 glyph-range .pbf files dominated the
        // precache (791 entries / ~44 MB) and could blow the browser's
        // install-event budget on slow connections (#28). They're served by
        // a dedicated runtime CacheFirst route in src/sw.ts and warmed by
        // src/services/glyphWarmup.ts; offline.spec.ts's built-output guard
        // fails loudly if a glob change re-adds them here.
        globIgnores: ['**/test-fixtures/**', '**/brand/**', '**/basemap-assets/fonts/**'],
      },
      // devOptions.enabled defaults to false, so `vite dev`/Vitest (both
      // resolve this config with command 'serve') never register a real SW
      // — only `vite build`'s output does. That's what keeps ReloadPrompt's
      // tests safe in jsdom (see ReloadPrompt.test.tsx's own comment): they
      // mock `virtual:pwa-register/react` directly rather than relying on
      // this, but even unmocked the dev-mode stub would no-op registration.
      manifest: {
        // #96: distinct name + id for the UAT build so it installs as a
        // SEPARATE PWA from production rather than colliding with it (scope
        // already differs automatically — vite-plugin-pwa defaults
        // `manifest.scope` to the build's `base`). Production keeps exactly
        // the previous name/short_name and omits `id` (unset before #96).
        name: isUat ? 'SailCommand UAT' : 'SailCommand',
        short_name: isUat ? 'SailCommand UAT' : 'SailCommand',
        description:
          'Offline-Törnplaner für zeitoptimale Segelrouten in Flensburger Förde und Dänischer Südsee. Kein Navigationsgerät.',
        lang: 'de',
        theme_color: '#10243D',
        background_color: '#10243D',
        display: 'standalone',
        start_url: '.',
        ...(isUat ? { id: basePath } : {}),
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  // #107: build-time flag for UAT-only UI (the header badge). JSON.stringify
  // keeps the replacement an exact `true`/`false` literal. Production
  // (SC_DEPLOY_ENV unset) gets `false`, and the badge's import-site gate
  // (the fold-exact `__SC_UAT__ ?` ternary in App.tsx's title slot) then
  // dead-code-eliminates the whole
  // UatBadge module graph — the prod bundle stays byte-identical (verified
  // like #96). Vitest inherits this config, so tests see the constant too.
  // #125: __SC_APP_VERSION__ — see appVersion() above. JSON.stringify makes
  // the replacement an exact string literal.
  define: {
    __SC_UAT__: JSON.stringify(isUat),
    __SC_APP_VERSION__: JSON.stringify(appVersion(command)),
  },
  build: { target: 'es2022' },
  // #131: AboutDialog bakes the repo-root CHANGELOG.md in via a `?raw` static
  // import. Builds inline it, but the DEV server (and Vitest's module fetch)
  // gates served files on server.fs.allow. Setting `allow` replaces the
  // default [workspaceRoot] (= app/, no workspace markers above), and Vite 8
  // checks even in-root files (index.html itself 403s without APP_DIR here),
  // so the narrowed list is the default-equivalent root plus exactly one
  // out-of-root file. That file needs two entries: Vite 8's
  // isServerAccessDeniedForTransform checks BOTH cleanUrl(id) and the raw id
  // including its `?raw` query (query-bypass hardening), and a bare file
  // path matches by isSameFilePath — it can never prefix-match its own
  // `?raw` variant the way a directory entry would.
  server: { fs: { allow: [APP_DIR, changelogPath, `${changelogPath}?raw`] } },
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // #214: see SlowFileFirstSequencer above.
    sequence: { sequencer: SlowFileFirstSequencer },
    // #342 fix-wave (PR #351 review m5): `SC_COVERAGE` (read by
    // `app/src/test/timeouts.ts` to scale solver-heavy test budgets) used to
    // be set by a POSIX `SC_COVERAGE=1 ` shell prefix on package.json's
    // `test:coverage` script — silently broken on Windows cmd/PowerShell (no
    // such syntax there), which would run the full v8-instrumented suite
    // against the UNSCALED plain-run budgets, the exact failure #342 exists
    // to close. Also convention-only: `npx vitest run --coverage.enabled`
    // bypassing the npm script entirely got the unscaled budget too, even on
    // a POSIX shell. Derived here instead from the CLI's own
    // `--coverage`/`--coverage.enabled*` argv entry — present identically
    // regardless of shell, since it's a literal process argument, not a
    // shell-expanded variable — so the multiplier now follows coverage
    // actually being requested, not which command happened to set an env
    // var. `package.json`'s `test:coverage` script no longer needs the
    // prefix at all.
    //
    // PR #351 review N3: `--coverage.enabled*` alone (no value check) also
    // matched the EXPLICIT DISABLE `--coverage.enabled=false` — the harmful
    // direction, since it turned the multiplier ON for a run that asked for
    // coverage to be OFF (a genuine hang then gets 16 minutes of
    // hang-detection budget instead of 2). Excluded below (verified: `vitest
    // run --coverage.provider=v8` alone — no `--coverage`/`--coverage.enabled`
    // flag at all — does NOT actually enable coverage either, confirmed by
    // the absence of a coverage summary in that run's output, so that
    // invocation correctly gets the unscaled budget too). The real residual
    // is a `coverage: { enabled: true, ... }` set directly on the `test`
    // block's coverage OBJECT below (not via any CLI flag) — argv sniffing
    // cannot see that, and this repo does not do it today (there is no
    // `enabled` key in the block below), but closing it for real needs the
    // resolved coverage config, not argv. This detection is a pragmatic
    // argv PROXY for "coverage is on", strictly better than the
    // shell prefix it replaces, not a true reading of the resolved coverage
    // config — it moved the convention from "which npm script you typed" to
    // "which CLI flag you passed", not eliminated convention entirely.
    env: process.argv.some(
      (a) => a === '--coverage' || (a.startsWith('--coverage.enabled') && !/=(?:false|0)$/.test(a)),
    )
      ? { SC_COVERAGE: '1' }
      : {},
    // #221 measured a 93.92% statement baseline; #319 adds this threshold on
    // top of it. `.github/workflows/coverage.yml` (#342) evaluates it, but
    // only NIGHTLY (`schedule` + `workflow_dispatch`) — `app`'s required CI
    // job still runs plain `npm run test` (no coverage), so a PR never pays
    // the v8-instrumented run's cost. Getting the nightly job to a passing
    // run needed a durable timeout fix first: an earlier per-PR-shaped
    // dispatch attempt in #319's own PR (#335) was reverted after three runs
    // found TWO distinct timeout surfaces, not one — run 30807548075 hit the
    // job-level `timeout-minutes: 20` cap at 20.22 min; runs 30810112565 and
    // 30815617721 each ran ~42.6 min and failed on the solver-heavy tests'
    // OWN per-test `vi.setConfig`/`timeout` budgets under v8 instrumentation,
    // which raising the job cap could never have fixed. `app/src/test/
    // timeouts.ts` (#342) is now the single coverage-aware timeout constant
    // every solver-heavy test file imports instead of hardcoding its own,
    // with `app/src/test/timeoutGuard.test.ts` failing loudly if
    // `app/src/**/*.test.{ts,tsx}` reintroduces a hardcoded `testTimeout`/
    // `timeout` literal, keyed OR positional-argument form (PR #351 review
    // M1/M4 — the guard's scope is exactly that glob, not e2e specs or
    // `playwright.config.ts`, which have their own unrelated budget). `thresholds.
    // statements: 80` matches the OpenSSF `test_statement_coverage80`
    // criterion and is a FLOOR, not a ratchet — it leaves ~14 points of
    // headroom below the measured 93.92%, in which a regression would still
    // pass silently between nightly runs. Deliberate and revisitable at the
    // next release cut, not an oversight. `include` is intentionally the
    // same glob as `app`'s source tree (not scoped to what tests happen to
    // exercise), so an untested file reports 0% rather than silently
    // dropping out of the denominator — `src/sw.ts` and
    // `src/routing/worker.ts` are two such files, decided (#319, 2026-08-03)
    // to STAY IN scope at ~0% BY DESIGN rather than be excluded: jsdom has
    // no real ServiceWorker or dedicated-Worker execution model, so their
    // functional assurance comes from `app/e2e/offline.spec.ts`,
    // `csp.spec.ts`, `basemap-fallback.spec.ts`, `plan.spec.ts`,
    // `live.spec.ts` and `deploy.yml`'s post-deploy CDN smoke probe instead —
    // do NOT "fix" the 0% with a jsdom-mocked service-worker test, which
    // would be the #50 equivalence-test tautology (statements execute
    // without modeling real CacheStorage/Range/CDN semantics, the bug class
    // that actually bit in #96 and #118).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      thresholds: { statements: 80 },
    },
  },
}));
