import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The suite binds local test servers (ports 4770-4789 only), so keep the number of parallel workers small.
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
