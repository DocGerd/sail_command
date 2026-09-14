import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [process.env.SC_TEST ?? "probe.test.ts"],
    environment: "node",
    testTimeout: 5_400_000,
  },
});
