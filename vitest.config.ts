import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The heaviest analyze tests (e.g. 500d1000 Monte Carlo) run a few seconds
    // and slow further under v8 coverage instrumentation. Give a generous global
    // timeout so coverage runs stay reliable; the tests keep their own internal
    // wall-clock budget assertions, which remain the binding performance check.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts"],
      // Coverage ratchet: floors set ~5 points below the current measured
      // numbers (stmts 84.3 / branch 81.71 / funcs 88.74 / lines 84.3 as of
      // this pass) so coverage can never silently regress, while leaving
      // headroom so normal work never trips the gate. Raise these as coverage
      // climbs.
      thresholds: {
        lines: 79,
        functions: 83,
        branches: 76,
        statements: 79,
      },
    },
  },
});
