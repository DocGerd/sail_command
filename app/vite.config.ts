/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/sail_command/',
  plugins: [
    react(),
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
        // ~44 MB expected (basemap.pmtiles + mask.bin + polars + fonts/
        // sprites + app shell) — see spec §7's first-load budget.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin,pmtiles,pbf}'],
        // brand/social-card.png is an og:image served over HTTP, not part of
        // the offline app — keep it out of the precache so the ~44 MB install
        // budget (#28) doesn't grow.
        globIgnores: ['**/test-fixtures/**', '**/brand/**'],
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
