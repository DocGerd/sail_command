/// <reference types="vitest/config" />
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// #96: UAT deploy of `develop` to the Pages sub-path /sail_command/uat/,
// alongside production's unchanged /sail_command/ root. deploy.yml sets
// SC_DEPLOY_ENV=uat only for the develop build; the production build never
// sets it, so `isUat` is false and `basePath` matches the pre-#96 constant
// exactly — production's build output is unaffected by this addition.
const isUat = process.env.SC_DEPLOY_ENV === 'uat';
const basePath = isUat ? '/sail_command/uat/' : '/sail_command/';

// #96: rewrites the two absolute og: URLs to the actual deploy sub-path and,
// for the UAT build only, marks the page noindex and retitles it — so the
// staging deploy is never confused with (or indexed as) production. Regex
// on the exact production strings rather than templating index.html, so a
// production build's html output is byte-for-byte identical to before #96.
function subPathMeta(base: string, uat: boolean): Plugin {
  const origin = 'https://docgerd.github.io';
  return {
    name: 'sailcommand:sub-path-meta',
    transformIndexHtml(html) {
      let out = html
        .replace(
          '<meta property="og:url" content="https://docgerd.github.io/sail_command/" />',
          `<meta property="og:url" content="${origin}${base}" />`,
        )
        .replace(
          '<meta property="og:image" content="https://docgerd.github.io/sail_command/brand/social-card.png" />',
          `<meta property="og:image" content="${origin}${base}brand/social-card.png" />`,
        );
      if (uat) {
        out = out
          .replace('<title>SailCommand</title>', '<title>SailCommand UAT</title>')
          .replace(
            '<meta name="theme-color" content="#10243D" />',
            '<meta name="theme-color" content="#10243D" />\n    <meta name="robots" content="noindex, nofollow" />',
          );
      }
      return out;
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

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    glyphManifest(),
    subPathMeta(basePath, isUat),
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
        // ~33 MB expected (basemap.pmtiles + mask.bin + polars + sprites +
        // app shell) — see spec §7's first-load budget. The ~11 MB of font
        // glyph ranges are runtime-cached, not precached (#28, below).
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin,pmtiles,pbf}'],
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
  define: { __SC_UAT__: JSON.stringify(isUat) },
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
