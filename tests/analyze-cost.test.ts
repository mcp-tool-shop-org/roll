import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { ParseError } from "../src/parser/parser.js";
import {
  computeDistribution,
  computeDistributionWithMethod,
  type Distribution,
} from "../src/analyze/distribution.js";
import { MAX_ANALYZE_DICE, monteCarloDistribution } from "../src/analyze/montecarlo.js";
import { computeStats } from "../src/analyze/stats.js";
import { estimateAstAnalyzeRolls, MAX_EXPLOSION_ROLLS } from "../src/engine/pipeline.js";
import { analyze as analyzePublic, roll } from "../src/index.js";
import { run as runCli } from "../src/bin.js";
import { handleRequest as handleMcpRequest } from "../src/mcp/server.js";

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

  it("stacked explosions ('2d3!<=4!!>=1', '1d6!>=1!>=1!>=1') refuse with ParseError within 2000ms in analyze() and monteCarloDistribution()", () => {
    // 2d3!<=4!!>=1: Stage 4 `!<=4` expands 2 -> 202 dice (200 bonus rolls), then
    // `!!>=1` compounds 100 times on each of 202 dice (20,200 rolls) -> 20,402
    // rolls per sample (> MAX_ANALYZE_DICE = 1,000). Without stacked-explosion
    // accounting, 100,000 MC samples ran 2.04e9 rolls (>8s stall); 1d6!>=1!>=1!>=1
    // attempted ~1.03e11 rolls. Both must refuse immediately with ParseError.
    const crafted = [
      "2d3!<=4!!>=1",
      "2d3!<=4!!>=1cf<=2min3",
      "1d6!>=1!>=1!>=1",
      "1d6" + "!>=1".repeat(20),
    ];

    const start = performance.now();
    for (const expr of crafted) {
      let analyzeErr: unknown;
      try {
        analyzePublic(expr);
      } catch (e) {
        analyzeErr = e;
      }
      expect(analyzeErr).toBeInstanceOf(ParseError);
      expect((analyzeErr as Error).message).toMatch(/too complex to analyze/i);

      const ast = parse(expr);
      expect(estimateAstAnalyzeRolls(ast)).toBeGreaterThan(MAX_ANALYZE_DICE);
      let mcErr: unknown;
      try {
        monteCarloDistribution(ast, 100_000);
      } catch (e) {
        mcErr = e;
      }
      expect(mcErr).toBeInstanceOf(ParseError);
      expect((mcErr as Error).message).toMatch(/too complex to analyze/i);
    }
    const elapsedMs = performance.now() - start;
    // 2,000ms gives shared CI runners + v8 coverage instrumentation ample headroom while still catching runaways (v2.1.2 stalled >8s on 2d3!<=4!!>=1 and hung unboundedly on 101^20).
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("roll() and roll()-in-a-loop refuse crafted stacked explosions within 2000ms with ParseError", () => {
    // `stageExplode` caps per-group bonus rolls at MAX_EXPLOSION_ROLLS (10,000)
    // and pre-checks guaranteed all-face blow-ups so neither a single `roll()`
    // nor `roll()` in a loop (nor CLI `--times` / MCP `roll_dice`) can run 101^k work.
    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      expect(() => roll("2d3!<=4!!>=1")).toThrow(ParseError);
      expect(() => roll("1d6!>=1!>=1!>=1")).toThrow(ParseError);
      expect(() => roll("1d6" + "!>=1".repeat(20))).toThrow(ParseError);
    }
    expect(() => roll("2d3!<=4!!>=1")).toThrow(/explosion roll limit/i);
    // Stochastic stacked chain (`!=2` explode, not `!!` compound) driven by worst-case RNG hits the 10,000 cap cleanly:
    expect(() => roll("1d2" + "!=2".repeat(20), () => 2)).toThrow(ParseError);
    expect(() => roll("1d2" + "!=2".repeat(20), () => 2)).toThrow(/explosion roll limit/i);

    // Clock-independent RNG-draw bounds: pre-check throws after initial Stage 1 rolls (0 bonus draws),
    // and stochastic chains throw after at most 1 + MAX_EXPLOSION_ROLLS draws.
    for (const [expr, expectedInitialDraws] of [
      ["2d3!<=4!!>=1", 2],
      ["1d6!>=1!>=1!>=1", 1],
      ["1d6" + "!>=1".repeat(20), 1],
    ] as const) {
      let draws = 0;
      expect(() =>
        roll(expr, (_min, max) => {
          draws++;
          return max;
        }),
      ).toThrow(ParseError);
      expect(draws).toBe(expectedInitialDraws);
    }
    let stochasticDraws = 0;
    expect(() =>
      roll("1d2" + "!=2".repeat(20), () => {
        stochasticDraws++;
        return 2;
      }),
    ).toThrow(ParseError);
    expect(stochasticDraws).toBe(1 + MAX_EXPLOSION_ROLLS);

    const errLines: string[] = [];
    const cliCode = runCli(["2d3!<=4!!>=1", "--times", "100", "--no-color"], {
      out: () => {},
      err: (l = "") => errLines.push(l),
    });
    expect(cliCode).toBe(1);
    expect(errLines.join("\n")).toContain("Error:");

    const mcpRes = handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "roll_dice",
        arguments: { expression: "2d3!<=4!!>=1", times: 100 },
      },
    });
    expect((mcpRes.result as { isError?: boolean }).isError).toBe(true);

    const elapsedMs = performance.now() - start;
    // 2,000ms avoids CI runner + v8 coverage flake (310ms observed on CI) while separating bounded rejection from v2.1.2's multi-second 1.03e8-roll stall and unbounded 101^20 hang.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("monteCarloDistribution enforces live RNG draw budget (samples * MAX_ANALYZE_DICE) when empirical draws exceed static expectedRolls", () => {
    // `15d100r<=99+43d6` has static expectedRolls = 957 + 43 = 1,000 (right at
    // MAX_ANALYZE_DICE = 1,000), but high reroll variance causes 3 deterministic
    // samples on seed 0x9e3779b9 to exceed `3 * 1,000 = 3,000` RNG draws, hitting
    // the live RNG draw guard in `src/analyze/montecarlo.ts`.
    const ast = parse("15d100r<=99+43d6");
    expect(() => monteCarloDistribution(ast, 3)).toThrow(ParseError);
    expect(() => monteCarloDistribution(ast, 3)).toThrow(
      /monte carlo roll budget \(3000\) exceeded/i,
    );
    // Unary-minus AST wrapper also forwards stacked-explosion cost:
    expect(() => analyzePublic("-2d3!<=4!!>=1")).toThrow(ParseError);
  });

  it("explosionDistribution falls back to Monte Carlo when node.count * MAX_EXPLOSIONS > MAX_EXPLOSION_ROLLS on an active threshold, and stays exact when threshold matches 0 faces", () => {
    // 101d6!>6: 101 * 100 > 10,000, but `!>6` matches 0 faces on d6 so no explosions
    // can ever occur -> stays exact with mean 353.5 and no caps.
    const inactive = analyzePublic("101d6!>6");
    expect(inactive.method).toBe("exact");
    expect(inactive.caps).toBeUndefined();
    expect(inactive.stats.mean).toBeCloseTo(101 * 3.5, 8);

    // 101d100!: 101 * 100 = 10,100 > MAX_EXPLOSION_ROLLS (10,000) with active `>=100`
    // threshold (expectedRolls = 103 <= 1,000) -> abandons exact single-die convolution
    // and falls back to bounded Monte Carlo rather than ignoring the group cap.
    const active = analyzePublic("101d100!");
    expect(active.method).toBe("monte-carlo");
    expect(active.samples).toBe(100_000);
    expect(active.stats.mean).toBeGreaterThan(5000);
    expect(active.stats.mean).toBeLessThan(5300);
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

  it("100d100 stays on the exact path (within MAX_EXACT_STATES)", () => {
    // This asserted `elapsed < 2000` on a Date.now() stopwatch. Wall clock on a
    // shared CI runner is not a property of this code: it went red at 2176ms
    // with 508/509 green, and nothing had changed. A timing bound also does not
    // say what the test name says -- it is a PROXY for "we did not fall back to
    // sampling", so it fails when the runner is busy and passes when a genuine
    // fallback happens to be quick.
    //
    // computeDistributionWithMethod labels the path it took, so assert that
    // directly. Deterministic, and it is the actual claim: exact, not sampled.
    const { distribution, method } = computeDistributionWithMethod(parse("100d100"));
    expect(method).toBe("exact");
    const stats = computeStats(distribution);
    expect(stats.mean).toBeCloseTo(100 * 50.5, 4); // 5050
    expect(totalMass(distribution)).toBeCloseTo(1, 6);
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
    // Not on the run that collects coverage for Codecov (COVERAGE_LEG, set by
    // ci.yml): V8 instrumentation doubled this to 20s on a CI runner, which
    // measures the instrumentation, not the guard. Every other run holds it.
    if (process.env.COVERAGE_LEG !== "true") expect(elapsed).toBeLessThan(10000);
  });
});
