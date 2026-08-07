import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * #282 acceptance sweep — its own vitest config, so the harness is reachable
 * on demand without ever being collected by `npm --prefix app run test`.
 *
 * A dedicated config rather than a CLI flag because there is no CLI flag that
 * does this: vitest 4 has no `--include` (it exits `CACError: Unknown option`,
 * MEASURED), and `--dir` only narrows the scan — it cannot widen the root
 * config's `include: ['src/**\/*.test.{ts,tsx}']`, which by construction
 * excludes everything in this directory.
 *
 * `environment` and `setupFiles` deliberately MIRROR `app/vite.config.ts`
 * rather than being trimmed to what the solver strictly needs (it touches no
 * DOM, so `node` would run fine). The recorded baseline in README.md was
 * produced under jsdom with that setup file; keeping them identical means a
 * future run is comparing like with like. That is the same
 * "baseline parameters are load-bearing" rule the arm definitions follow.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [resolve(here, '../src/test/setup.ts')],
    include: ['**/*.test.ts'],
    // Six arms in six parallel workers: ~20 min wall instead of ~50 serial.
    fileParallelism: true,
  },
});
