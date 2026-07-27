import { defineConfig } from "vitest/config";

// The root vitest config only picks up `src/**/*.test.{ts,tsx}` (jsdom). The SDK tests are plain
// Node tests over the generator and the builders, so they run with their own config:
//   npx vitest run --config sdk/vitest.config.ts
// `npm run verify:sdk` does this alongside the sdk typecheck and the catalog drift check.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    root: import.meta.dirname,
  },
});
