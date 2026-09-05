import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit and API tests run everywhere. The simulation suite under sim/test is
 * only collected when RUN_SIM=1 because it needs the Docker compose network.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: process.env["RUN_SIM"] === "1" ? ["sim/test/**/*.test.ts"] : ["test/**/*.test.ts"],
    exclude: ["node_modules", ".next", "agent"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
