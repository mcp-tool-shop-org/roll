import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { ParseError } from "../src/parser/parser.js";
import {
  computeDistribution,
  type Distribution,
} from "../src/analyze/distribution.js";
import { computeStats } from "../src/analyze/stats.js";

// ─── V1-001 / V1-002: the analyze path must be cost-bounded ───────────────────
//
// The parser caps dice count (<=10000) and sides (<=1000000), which protects the
// ROLL path (rolling 10000 dice once is cheap). But the ANALYZE path computes the
// FULL probability distribution by convolution, doing work proportional to
// count x sides. `analyze("10000d1000000")` parses cleanly, then convolveDice
// builds a ~1,000,000-entry Map and convolves it 10000 times -> support grows
// toward ~10^10 distinct sums -> OOM / indefinite hang. Falling back to Monte
// Carlo is NOT automatically safe either: 100000 samples x evaluate(10000 dice)
// = ~10^9 rolls -> a multi-second stall.
//
// INVARIANT: No expression that passes the parser may hang or OOM the analysis
// path. Every computeDistribution call must either return a bounded-cost result
// or throw a clear, structured ParseError ("too complex to analyze") fast.
//
// FAIL VERIFICATION (how these were confirmed red against the pre-fix code):
//   - The pathological cases below could not be run against the unfixed code at
//     all — `computeDistribution(parse("10000d1000000"))` hangs/OOMs (it never
//     returns), so a test asserting it returns is unrunnable and a test asserting
//     it throws would hang on the un-thrown call. Confirmed by reasoning about
//     convolveDice(10000, 1000000): `single` has 1e6 entries and is convolved
//     10000 times, the support strictly growing each step. The pre-fix
//     computeDistribution has NO guard on this path (only enumerateKeepDrop was
//     gated on MAX_EXACT_STATES).
//   - A smaller-but-finite reproducer, "1000d100000", was used to OBSERVE the
//     blow-up empirically before the fix (slow-but-finite: ~1e5 entry Map
//     convolved 1000x). Post-fix, the large cases throw synchronously and fast,
//     and this moderate case is rejected too (1000 > MAX_ANALYZE_DICE? no — it
//     equals it; see the moderate-MC test for where the boundary lands).
//   - The regression-lock tests below (2d6 mean 7, 100d6 mean 350, etc.) PASS on
//     the pre-fix code AND on the post-fix code, proving the cost guard does not
//     over-restrict realistic RPG analysis.

describe("V1-001/V1-002 analyze path is cost-bounded (DoS guard)", () => {
  it("analyze('10000d1000000') throws a clear 'too complex' error FAST, never hangs", () => {
    const ast = parse("10000d1000000"); // parses cleanly (within parser caps)
    const start = Date.now();
    let threw: unknown;
    try {
      computeDistribution(ast);
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - start;
    expect(threw).toBeInstanceOf(ParseError);
    expect((threw as Error).message.toLowerCase()).toContain("too complex");
    // Must reject essentially instantly — no convolution, no MC.
    expect(elapsed).toBeLessThan(500);
  });

  it("analyze('10000d6!') throws — even MC would be 100000 x 10000-die rolls", () => {
    // count alone (10000) far exceeds any real analysis need; reject before MC.
    const ast = parse("10000d6!");
    const start = Date.now();
    let threw: unknown;
    try {
      computeDistribution(ast);
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - start;
    expect(threw).toBeInstanceOf(ParseError);
    expect((threw as Error).message.toLowerCase()).toContain("too complex");
    expect(elapsed).toBeLessThan(500);
  });

  it("analyze('5000d6 + 5000d6') throws — total dice across the AST is bounded, not just per-group", () => {
    // Each group is 5000 (under a per-group view) but together 10000 dice would
    // be rolled per MC sample. The bound must be on TOTAL dice across the AST.
    const ast = parse("5000d6 + 5000d6");
    let threw: unknown;
    try {
      computeDistribution(ast);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ParseError);
    expect((threw as Error).message.toLowerCase()).toContain("too complex");
  });
});

// ─── Regression locks: real RPG analysis still works and stays exact/fast ──────
// These prove the cost guard did NOT over-restrict. Each is a normal expression
// a game designer would analyze; they must return sane distributions quickly.

function analyze(expr: string) {
  const ast = parse(expr);
  const dist = computeDistribution(ast);
  return { dist, stats: computeStats(dist) };
}

function totalMass(dist: Distribution): number {
  let total = 0;
  for (const p of dist.values()) total += p;
  return total;
}

describe("regression locks: realistic analysis still works (no over-restriction)", () => {
  it("2d6 mean is 7 (exact)", () => {
    const { dist, stats } = analyze("2d6");
    expect(stats.mean).toBeCloseTo(7, 10);
    expect(totalMass(dist)).toBeCloseTo(1, 10);
  });

  it("100d6 mean is 350 (exact convolution, well within bounds)", () => {
    const { dist, stats } = analyze("100d6");
    expect(stats.mean).toBeCloseTo(350, 6);
    expect(totalMass(dist)).toBeCloseTo(1, 8);
  });

  it("4d6kh3 analyzes to a sane mean (~12.24) and full mass", () => {
    const { dist, stats } = analyze("4d6kh3");
    expect(stats.mean).toBeCloseTo(12.2446, 2);
    expect(totalMass(dist)).toBeCloseTo(1, 8);
  });

  it("8d6! analyzes with sensible mean above the non-exploding 28", () => {
    const { dist, stats } = analyze("8d6!");
    expect(totalMass(dist)).toBeCloseTo(1, 2); // truncated-explosion mass ~1
    expect(stats.mean).toBeGreaterThan(28); // exploding adds mass over 8*3.5
    expect(Number.isFinite(stats.mean)).toBe(true);
  });

  it("10d10cs>=7 (success pool) analyzes to mean ~4 successes", () => {
    const { dist, stats } = analyze("10d10cs>=7");
    // Each d10 succeeds on 7..10 => p=0.4 => 10*0.4 = 4 expected successes.
    expect(stats.mean).toBeCloseTo(4, 6);
    expect(totalMass(dist)).toBeCloseTo(1, 8);
  });

  it("20d20kh3 (advantage-style pool) analyzes and returns full mass", () => {
    const { dist, stats } = analyze("20d20kh3");
    expect(totalMass(dist)).toBeCloseTo(1, 6);
    expect(Number.isFinite(stats.mean)).toBe(true);
  });

  it("100d100 analyzes fast (exact convolution stays within MAX_EXACT_STATES)", () => {
    const start = Date.now();
    const { dist, stats } = analyze("100d100");
    const elapsed = Date.now() - start;
    expect(stats.mean).toBeCloseTo(100 * 50.5, 4); // 5050
    expect(totalMass(dist)).toBeCloseTo(1, 6);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ─── Moderate case: should FALL BACK to Monte Carlo, not throw, not exact ──────
// A case whose exact support exceeds MAX_EXACT_STATES but whose total dice are
// within the analyze-dice budget must NOT throw — it must return a bounded MC
// estimate. This proves the exact-state guard and the input-dice guard are
// independent: exceeding the state cap falls back; only exceeding the dice cap
// throws.

describe("moderate case falls back to bounded Monte Carlo (not exact, not thrown)", () => {
  it("500d1000 returns a bounded result via MC (exact too expensive, dice within budget)", () => {
    // 500 dice x 1000 sides: the exact convolution's SUPPORT stays ~5e5 (under
    // MAX_EXACT_STATES), but its per-step COMPUTE blows up — late steps iterate
    // ~5e5 x 1000 = 5e8 times. The convolve compute guard (|a|*|b| > cap) trips,
    // so the exact path abandons. 500 dice is within the analyze-dice budget
    // (1000), so MC runs and returns a finite distribution rather than throwing.
    // This is the case that distinguishes the two exact guards (support vs
    // compute) from the input-dice throw.
    const start = Date.now();
    const { dist, stats } = analyze("500d1000");
    const elapsed = Date.now() - start;
    expect(totalMass(dist)).toBeCloseTo(1, 6);
    // Mean of 500d1000 is 500 * 500.5 = 250250; MC should land near it.
    expect(stats.mean).toBeGreaterThan(240000);
    expect(stats.mean).toBeLessThan(260000);
    expect(Number.isFinite(stats.mean)).toBe(true);
    // Bounded cost: 500 dice * 100000 samples = 5e7 rolls — should be a few sec.
    expect(elapsed).toBeLessThan(10000);
  });
});
