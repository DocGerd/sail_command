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
 *
 * #451: `root` MUST be pinned to this directory explicitly. `npm --prefix
 * app run test -- --config sweep/vitest.config.ts` chdirs into `app/`
 * BEFORE vitest ever reads this file (that's what `--prefix app` does), and
 * Vite's `root` defaults to `process.cwd()` when unset — so without this,
 * `include: ['**\/*.test.ts']` resolved against `app/`, not `app/sweep/`,
 * and over-collected the ENTIRE app test suite (MEASURED via `vitest list
 * --config sweep/vitest.config.ts`: it tried to collect
 * `src/lib/changelog.test.ts`, which then hit `server.fs.allow` denying its
 * `CHANGELOG.md?raw` import under this narrower config and exited 1 on a
 * file with nothing to do with the sweep). Pinning `root` here makes the
 * glob resolve against `app/sweep/` regardless of the invoking cwd.
 */
export default defineConfig({
  root: here,
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [resolve(here, '../src/test/setup.ts')],
    include: ['**/*.test.ts'],
    // #452 added three arms (nine total, up from six): serial cost grows to
    // ~90 min (the original six ran ~50 min serial; the three new
    // Marstal-origin arms measured 2401 s = ~40 min of solver time between
    // them, PR #488 review). `fileParallelism: true` runs one worker per
    // arm file, so wall time stays close to the SLOWEST single arm rather
    // than the sum — but that ~20 min figure is a PARALLEL number, not a
    // fixed constant: it holds on a machine with enough cores to run nine
    // workers concurrently and degrades toward the serial figure on a
    // smaller one.
    fileParallelism: true,
  },
});
