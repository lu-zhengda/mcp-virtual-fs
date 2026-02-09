import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000, // testcontainers can be slow on first pull
    hookTimeout: 120_000,
  },
});
