import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// #1855 spike probe: own root so the app suite never collects it; node env, no setup.
export default defineConfig({
  root: here,
  test: { environment: 'node', include: ['**/*.probe.test.ts'], testTimeout: 0, fileParallelism: false },
});
