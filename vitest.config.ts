import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Count every source file, tested or not — vitest only reports files the
      // tests import, which silently hides untested modules from the number.
      include: ["src/**"],
      // The transport entry point auto-connects on import; it's exercised by
      // running the server (npm run dev / the published bin), not unit tests.
      exclude: ["src/mcp.ts"],
      reporter: ["text-summary", "cobertura", "json-summary"],
    },
  },
});
