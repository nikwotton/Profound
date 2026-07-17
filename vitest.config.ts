import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/property/**/*.property.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
