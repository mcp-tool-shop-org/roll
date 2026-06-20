import { describe, it, expect } from "vitest";
import { roll, analyze, ParseError, seededRng, MAX_DICE_COUNT } from "../src/index.js";

// Smoke tests for the PUBLIC library surface (src/index.ts). The deep modules
// are covered by their own suites; this file proves the documented
// convenience API — roll() / analyze() — and the re-exports actually work as
// the README advertises, so an importer of @mcptoolshop/roll never hits a
// broken/missing export.

describe("public API: roll()", () => {
  it("returns the documented RollResult shape", () => {
    const result = roll("2d6+3");
    // Invariant: result carries total, groups, and the original expression string.
    expect(typeof result.total).toBe("number");
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.expression).toBe("2d6+3");
    expect(result.total).toBeGreaterThanOrEqual(5); // 2*1 + 3
    expect(result.total).toBeLessThanOrEqual(15); // 2*6 + 3
  });

  it("is deterministic when given a seeded RNG", () => {
    // Invariant: same expression + same seeded rng => same total.
    const a = roll("3d20+1d6", seededRng(12345));
    const b = roll("3d20+1d6", seededRng(12345));
    expect(a.total).toBe(b.total);
  });

  it("throws the exported ParseError on a malformed expression", () => {
    expect(() => roll("not a roll")).toThrow();
    // Invariant: the engine's caps are reachable through the public API.
    expect(() => roll(`${MAX_DICE_COUNT + 1}d6`)).toThrow(ParseError);
  });
});

describe("public API: analyze()", () => {
  it("returns distribution + stats + probabilityAtLeast()", () => {
    const a = analyze("2d6");
    // Invariant: distribution is a Map whose probabilities sum to ~1.
    expect(a.distribution instanceof Map).toBe(true);
    const mass = [...a.distribution.values()].reduce((s, p) => s + p, 0);
    expect(mass).toBeCloseTo(1, 6);
    // Invariant: 2d6 mean is 7.
    expect(a.stats.mean).toBeCloseTo(7, 6);
    // Invariant: probabilityAtLeast is a closure returning a probability in [0,1].
    const p = a.probabilityAtLeast(7);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
    // P(>= min) is 1; P(> max) is 0.
    expect(a.probabilityAtLeast(2)).toBeCloseTo(1, 6);
    expect(a.probabilityAtLeast(13)).toBeCloseTo(0, 6);
  });
});
