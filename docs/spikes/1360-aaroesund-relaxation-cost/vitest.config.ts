import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Mirrors app/sweep/vitest.config.ts (jsdom + setup.ts) so the probe runs
// under the same environment the recorded sweep rows came from.
export default defineConfig({
  root: here,
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: [resolve(here, "../src/test/setup.ts")],
    include: ["probe.test.ts"],
    testTimeout: 7_200_000,
  },
});
