import { defineConfig } from "vitest/config";

// ci.yml sets COVERAGE_LEG to 'true' on the one leg whose reports go to
// Codecov. That leg collects coverage, adds an lcov report, and writes JUnit
// test results; CI runs Vitest through npm run verify, where no flag on the
// step reaches it. Every other run is unchanged.
const coverageLeg = process.env.COVERAGE_LEG === "true";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The heaviest analyze tests (e.g. 500d1000 Monte Carlo) run a few seconds
    // and slow further under v8 coverage instrumentation. Give a generous global
    // timeout so coverage runs stay reliable; the tests keep their own internal
    // wall-clock budget assertions, which remain the binding performance check.
    testTimeout: 30000,
    ...(coverageLeg ? { reporters: ["default", "junit"], outputFile: { junit: "junit.xml" } } : {}),
    coverage: {
      enabled: coverageLeg,
      provider: "v8",
      reporter: coverageLeg ? ["text", "html", "lcovonly"] : ["text", "html"],
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
