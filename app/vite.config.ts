/// <reference types="vitest/config" />
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// #28: emits dist/glyph-manifest.json — the complete, sorted list of font
// glyph-range files under public/basemap-assets/fonts/, as BASE_URL-relative
// paths. Fonts are excluded from the SW precache (globIgnores below) and
// served from a runtime cache instead; src/services/glyphWarmup.ts consumes
// this manifest after activation to backfill the ranges the map hasn't
// requested yet, so offline coverage converges without blocking the install.
// The emitted JSON itself IS picked up by the precache glob (**/*.json) —
// tiny, and it keeps the warm-up's source of truth available offline.
// Build-only (apply: 'build'): `vite dev` neither emits it nor registers a
// SW, and the warm-up treats the resulting 404 as a silent skip.
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
      this.emitFile({
        type: 'asset',
        fileName: 'glyph-manifest.json',
        source: JSON.stringify(paths),
      });
    },
  };
}

export default defineConfig({
  base: '/sail_command/',
  plugins: [
    react(),
    glyphManifest(),
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
        // ~30 MB expected (basemap.pmtiles + mask.bin + polars + sprites +
        // app shell) — see spec §7's first-load budget. The ~14 MB of font
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
        name: 'SailCommand',
        short_name: 'SailCommand',
        description:
          'Offline-Törnplaner für zeitoptimale Segelrouten in Flensburger Förde und Dänischer Südsee. Kein Navigationsgerät.',
        lang: 'de',
        theme_color: '#10243D',
        background_color: '#10243D',
        display: 'standalone',
        start_url: '.',
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
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
