import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../src/parser/parser.js";
import type { DiceNode } from "../src/parser/ast.js";
import {
  computeDistribution,
  computeDistributionWithMethod,
  type Distribution,
} from "../src/analyze/distribution.js";
import { computeStats } from "../src/analyze/stats.js";
import { monteCarloDistribution } from "../src/analyze/montecarlo.js";
import { evaluate } from "../src/engine/roller.js";
import { runPipeline } from "../src/engine/pipeline.js";
import { seededRng, type RngFn } from "../src/engine/random.js";
import { roll, analyze as analyzePublic, MAX_EXPLOSIONS, MAX_REROLLS } from "../src/index.js";
import { run as runCli } from "../src/bin.js";
import { BridgeHandler } from "../src/bridge/handler.js";
import { handleRequest as handleMcpRequest } from "../src/mcp/server.js";

// Correctness tests for the exact/Monte-Carlo probability analyzer. Every bug
// here is a SILENT-WRONG-PROBABILITY bug: the "exact" analyzer disagrees with
// what the engine actually rolls. Each block asserts engine-agreement or the
// specific corrected behavior, with the invariant named in a comment.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function analyze(expr: string) {
  const ast = parse(expr);
  const dist = computeDistribution(ast);
  return { dist, stats: computeStats(dist) };
}

/** Empirical mean of an expression rolled `n` times through the REAL engine. */
function engineMean(expr: string, n = 80_000): number {
  const ast = parse(expr);
  const rng = seededRng(123456789);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += evaluate(ast, rng).total;
  return sum / n;
}

function totalMass(dist: Distribution): number {
  let total = 0;
  for (const p of dist.values()) total += p;
  return total;
}

function distMean(dist: Distribution): number {
  let m = 0;
  for (const [v, p] of dist) m += v * p;
  return m;
}

function distVariance(dist: Distribution): number {
  const mean = distMean(dist);
  let v = 0;
  for (const [val, p] of dist) v += p * (val - mean) ** 2;
  return v;
}

// ─── H2 / F-AT-001: explosion compare operator must be honored ────────────────
// INVARIANT: the analyzer's explosion decision must use the FULL ComparePoint
// (operator + value), mirroring the engine's getExplosionThreshold. Collapsing
// to `face < value` (a hardcoded >=) gives the wrong mass for !>N and !=N, so
// the analyzer's mean must equal the real engine's mean.

describe("F-AT-001 explosion compare operator honored", () => {
  it("1d10!>5 explodes on 6-10 only (not 5-10) — analyzer mean == engine mean", () => {
    // Engine: explode when value > 5 (faces 6..10). The bug used threshold=5
    // with `face < 5` => exploded on 5..10 (one extra face), inflating the mean.
    const { stats } = analyze("1d10!>5");
    const emean = engineMean("1d10!>5");
    expect(stats.mean).toBeCloseTo(emean, 1);
  });

  it("1d10!>5 mean reflects explode-on-6..10, distinct from a >=5 reading", () => {
    const gt5 = analyze("1d10!>5").stats.mean;
    const emeanGt5 = engineMean("1d10!>5");
    expect(gt5).toBeCloseTo(emeanGt5, 1);
    // The old bug used `face < 5` => exploded on 5..10 (6 faces) and gave ~13.7.
    // The corrected >5 reading explodes on 6..10 (5 faces) and gives ~11.0 —
    // strictly below the buggy 13.7, proving the extra exploding face is gone.
    expect(gt5).toBeLessThan(12);
    expect(gt5).toBeGreaterThan(9);
  });

  it("1d6!=3 explodes only on a literal 3 (not 3-6) — analyzer mean == engine mean", () => {
    // Engine: explode only when value === 3 (1 of 6 faces). The bug used
    // threshold=3 with `face < 3` => exploded on faces 3,4,5,6, badly inflating
    // the mean (~10 vs the true ~4.2).
    const { stats } = analyze("1d6!=3");
    const emean = engineMean("1d6!=3");
    expect(stats.mean).toBeCloseTo(emean, 1);
    // Only 1/6 of rolls get (on average) one extra roll, so the mean is modest.
    expect(stats.mean).toBeLessThan(4.5);
  });

  it("default 1d6! still explodes on max — regression guard (no drift from engine)", () => {
    const { stats } = analyze("1d6!");
    const emean = engineMean("1d6!");
    expect(stats.mean).toBeCloseTo(emean, 1);
    expect(stats.mean).toBeGreaterThan(3.5);
  });

  it("1d6!<2 explodes only on a literal 1 — analyzer mean == engine mean", () => {
    // Operator "<" with value 2 => explode when face < 2, i.e. only face 1.
    // The bug ignored the operator entirely.
    const { stats } = analyze("1d6!<2");
    const emean = engineMean("1d6!<2");
    expect(stats.mean).toBeCloseTo(emean, 1);
  });
});

// ─── H3 / F-AT-003: keep/drop + explosion/reroll must agree with engine ──────
// INVARIANT: keep/drop + explosion (`4d6!kh3`) adds a variable number of dice
// before keep/drop and must fall back to Monte Carlo; keep/drop + reroll
// (`4d6r=1kh3`) composes Stage 2 reroll into `enumerateKeepDrop` exactly. In
// both cases neither modifier may be silently dropped.

describe("F-AT-003 keep/drop + explosion (MC) and keep/drop + reroll (exact) agree with engine", () => {
  it("4d6!kh3 analyzer mean == engine mean (explosion NOT silently dropped)", () => {
    // The bug routed this to enumerateKeepDrop, which ignores `!`, returning the
    // distribution of plain 4d6kh3 (no explosion) labeled exact. The engine
    // actually explodes, so its mean is higher.
    const { stats } = analyze("4d6!kh3");
    const emean = engineMean("4d6!kh3");
    expect(stats.mean).toBeCloseTo(emean, 0); // MC fallback ~ engine
    const plain = analyze("4d6kh3").stats.mean;
    expect(stats.mean).toBeGreaterThan(plain + 0.3); // explosion adds real mass
  });

  it("4d6r=1kh3 analyzer mean == engine mean (reroll NOT silently dropped)", () => {
    // r=1 (reroll 1s) combined with kh3. The bug routed 4d6r=1kh3 to
    // enumerateKeepDrop, which ignores reroll, returning plain 4d6kh3. The
    // engine rerolls 1s, raising the mean.
    const { stats } = analyze("4d6r=1kh3");
    const emean = engineMean("4d6r=1kh3");
    expect(stats.mean).toBeCloseTo(emean, 0);
    const plain = analyze("4d6kh3").stats.mean;
    expect(stats.mean).toBeGreaterThan(plain + 0.05);
  });

  it("plain 4d6kh3 (no explode/reroll) stays exact — regression guard", () => {
    // No explosion/reroll => enumerateKeepDrop is still valid and exact.
    const { dist, stats } = analyze("4d6kh3");
    expect(totalMass(dist)).toBeCloseTo(1, 10);
    expect(stats.mean).toBeCloseTo(12.2446, 2);
  });
});

// ─── M1 / F-AT-005: Monte Carlo must use one continuous independent stream ─────
// INVARIANT: MC samples must be drawn from ONE continuous RNG stream, not a
// fresh per-sample seeded generator (which yields a correlated low-discrepancy
// lattice rather than independent draws). The observable guarantees are correct
// mean, variance, and full mass. NOTE: the prior buggy seeding (Knuth-hash
// multiplier) happened to mask the defect for low-order aggregate statistics on
// this particular mulberry32, so these are uniformity REGRESSION GUARDS on the
// corrected single-stream sampler rather than red→green discriminators.

describe("F-AT-005 Monte Carlo uniformity (single continuous stream)", () => {
  it("MC 1d20 mean is within tolerance of 10.5 and variance ~33.25", () => {
    const dist = monteCarloDistribution(parse("1d20"), 100_000);
    expect(totalMass(dist)).toBeCloseTo(1, 8);
    expect(distMean(dist)).toBeCloseTo(10.5, 1);
    expect(distVariance(dist)).toBeCloseTo(33.25, 0); // (20^2-1)/12
    // Every face appears with mass near 1/20; a degenerate sampler would not.
    for (let f = 1; f <= 20; f++) {
      const p = dist.get(f) ?? 0;
      expect(p).toBeGreaterThan(0.03);
      expect(p).toBeLessThan(0.07);
    }
  });

  it("MC 2d6 mean is ~7 with the triangular peak at 7", () => {
    const dist = monteCarloDistribution(parse("2d6"), 100_000);
    expect(distMean(dist)).toBeCloseTo(7, 1);
    const stats = computeStats(dist);
    expect(stats.mode).toBe(7);
    // Peak mass near 6/36 ≈ 0.1667.
    expect(dist.get(7) ?? 0).toBeCloseTo(6 / 36, 1);
  });

  it("MC determinism: two runs with the fixed internal seed agree exactly", () => {
    // The fixed sampler seeds one generator with a constant, so the whole run is
    // reproducible — a property a per-sample-reseed lattice does not cleanly own.
    const a = monteCarloDistribution(parse("3d6"), 20_000);
    const b = monteCarloDistribution(parse("3d6"), 20_000);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

// ─── M10 / F-AT-007: degenerate reroll must fall back, not claim base dist ─────
// INVARIANT: when EVERY face matches the reroll compare (e.g. r>=1, r<7), the
// exact reroll path cannot terminate; it must return null so MC reflects the
// engine's real capped behavior — NOT return the unmodified base distribution
// labeled exact (each face an exact 1/s).

describe("F-AT-007 degenerate reroll falls back to MC (engine-agreement)", () => {
  it("1d6r>=1 (all faces match) is sampled, not returned as the exact 1/6 base", () => {
    // Pre-fix: returns plain 1d6 with each face EXACTLY 1/6 (the base dist) and
    // mass exactly 1, labeled exact. Post-fix: falls back to MC, which yields
    // the engine's capped behavior with noisy (non-exact-1/6) frequencies.
    const { dist, stats } = analyze("1d6r>=1");
    expect(totalMass(dist)).toBeCloseTo(1, 6);
    expect(Number.isFinite(stats.mean)).toBe(true);
    // Discriminator: a real MC fallback does NOT produce a perfectly-exact 1/6
    // on every face; at least one face must deviate from 1/6.
    let allExactlyUniform = true;
    for (const p of dist.values()) {
      if (Math.abs(p - 1 / 6) > 1e-9) allExactlyUniform = false;
    }
    expect(allExactlyUniform).toBe(false);
    // And it must still agree with the engine's empirical mean (~3.5).
    const emean = engineMean("1d6r>=1");
    expect(stats.mean).toBeCloseTo(emean, 1);
  });

  it("1d6r<7 (all faces match) does not crash and is sampled, not exact base", () => {
    const { dist, stats } = analyze("1d6r<7");
    expect(totalMass(dist)).toBeCloseTo(1, 6);
    expect(Number.isFinite(stats.mean)).toBe(true);
    let allExactlyUniform = true;
    for (const p of dist.values()) {
      if (Math.abs(p - 1 / 6) > 1e-9) allExactlyUniform = false;
    }
    expect(allExactlyUniform).toBe(false);
    const emean = engineMean("1d6r<7");
    expect(stats.mean).toBeCloseTo(emean, 1);
  });

  it("non-degenerate 1d6r=1 stays exact — regression guard", () => {
    // Only face 1 matches; the exact path is valid and must remain exact (face 1
    // has zero mass exactly, mean exactly 4).
    const { dist, stats } = analyze("1d6r=1");
    expect(dist.get(1) ?? 0).toBeCloseTo(0, 10);
    expect(stats.mean).toBeCloseTo(4, 5);
    expect(totalMass(dist)).toBeCloseTo(1, 10);
    // Exactness: every present face is exactly 1/5.
    for (const [v, p] of dist) {
      if (v !== 1) expect(p).toBeCloseTo(1 / 5, 10);
    }
  });
});

// ─── M9 / F-AT-006: percentiles/median must be computed on normalized mass ────
// INVARIANT: stats must normalize the distribution to sum to 1 before computing
// percentiles, so truncated exploding-dice mass (< 1) does not leave high
// percentiles unset and silently fall the median back to the MODE (a wrong
// central value). The median fallback must be the last value reached (max with
// mass), never the mode.

describe("F-AT-006 percentile/median robust to truncated mass", () => {
  it("truncated mass: median is a real central value, NOT the mode", () => {
    // Mass sums to 0.48 < 1. Mode (highest single prob) is value 1, but the true
    // normalized 50% crossing sits at value 50. Pre-fix: cumulative never
    // reaches 0.50, so percentiles[50] is unset and median = mode = 1 (WRONG).
    // Post-fix: normalize first => median lands at ~50.
    const dist: Distribution = new Map([
      [1, 0.2], // mode by probability, but a LOW value
      [50, 0.04], [51, 0.04], [52, 0.04], [53, 0.04],
      [54, 0.04], [55, 0.04], [56, 0.04],
    ]); // total mass = 0.48
    const stats = computeStats(dist);
    expect(stats.mode).toBe(1);
    // The median must be one of the high values, not the mode.
    expect(stats.median).toBeGreaterThanOrEqual(50);
    expect(stats.median).not.toBe(stats.mode);
    // High percentiles must be filled despite truncated total mass.
    expect(stats.percentiles[50]).toBeDefined();
    expect(stats.percentiles[95]).toBeDefined();
    expect(stats.percentiles[95]).toBeGreaterThanOrEqual(55);
  });

  it("median fallback is the last value with mass (max), never the mode", () => {
    // Mass sums to 0.40 and the 50% crossing (normalized) lands at the top.
    // value 2 holds 0.25/0.40 = 0.625 of mass, so 2 IS the true median here —
    // but the point is the median must be derived from NORMALIZED cumulative,
    // not silently fall to mode via an unset percentile. We assert it equals the
    // value where normalized cumulative first reaches 0.50 (which is 2).
    const dist: Distribution = new Map([
      [2, 0.25], // mode AND true median (0.625 of normalized mass)
      [9, 0.15],
    ]); // total mass = 0.40
    const stats = computeStats(dist);
    expect(stats.percentiles[50]).toBeDefined();
    expect(stats.median).toBe(2);
    expect(Number.isFinite(stats.median)).toBe(true);
    // 95th percentile must be set and reach the top value.
    expect(stats.percentiles[95]).toBe(9);
  });

  it("exploding 1d6! median/percentiles are well-defined (real expression)", () => {
    const { stats } = analyze("1d6!");
    expect(stats.percentiles[50]).toBeDefined();
    expect(stats.percentiles[95]).toBeDefined();
    expect(Number.isFinite(stats.median)).toBe(true);
    expect(stats.median).toBeGreaterThanOrEqual(3);
  });

  it("normal full-mass distribution: median == 50th percentile — regression guard", () => {
    const { stats } = analyze("2d6");
    expect(stats.median).toBe(7);
    expect(stats.percentiles[50]).toBe(7);
  });
});

// ─── Combined modifiers, engine-cap exactness, & divide-by-zero parity tests ──
//
// Independent black-box prefix-tape oracle:
//   Drives `runPipeline(node.count, node.sides, node.modifiers, rng, mode)`
//   (or `evaluate(ast, rng)` for multi-node arithmetic expressions) as an
//   opaque black box with the FULL `node.modifiers` array on an adaptive prefix
//   tree of uniform RNG draws.
//
//   - NEVER splits `node.modifiers` into per-stage subsets (Stage 2 / 3 / 4).
//   - NEVER branches on `hasUnlimitedReroll` or `hasKeepDrop` (so `keep-drop` +
//     `reroll` such as `3d4r=1kh2` runs the exact same unified `runPipeline`
//     invocation as every other dice expression).
//   - Whenever the execution finishes after `k` draws, that leaf contributes
//     exact probability `prod_{i=1..k} 1 / span_i` to `res.total`. Only paths
//     requesting another draw branch further up to `maxDraws`, accumulating any
//     unexpanded probability mass in `tailMass`.

interface PrefixOracleResult {
  distribution: Distribution;
  tailMass: number;
  leaves: number;
}

const TAPE_EXHAUSTED = Symbol("TAPE_EXHAUSTED");

function runAdaptivePrefixOracle(
  execWithRng: (rng: RngFn) => number,
  maxDraws: number,
): PrefixOracleResult {
  const distribution: Distribution = new Map();
  const tape: number[] = [];
  let tailMass = 0;
  let leaves = 0;

  function walk(prob: number): void {
    let idx = 0;
    let requestedMin = 1;
    let requestedMax = 1;
    const rng: RngFn = (min: number, max: number): number => {
      if (idx >= tape.length) {
        requestedMin = min;
        requestedMax = max;
        throw TAPE_EXHAUSTED;
      }
      return tape[idx++]!;
    };

    try {
      const total = execWithRng(rng);
      distribution.set(total, (distribution.get(total) ?? 0) + prob);
      leaves++;
    } catch (e) {
      if (e !== TAPE_EXHAUSTED) throw e;
      if (tape.length >= maxDraws) {
        tailMass += prob;
        return;
      }
      const span = requestedMax - requestedMin + 1;
      const stepProb = prob / span;
      for (let face = requestedMin; face <= requestedMax; face++) {
        tape.push(face);
        walk(stepProb);
        tape.pop();
      }
    }
  }

  walk(1);
  return { distribution, tailMass, leaves };
}

/**
 * Unified black-box oracle for a single `DiceNode` driving `runPipeline` with
 * the FULL `node.modifiers` list on adaptive prefix tapes (never splitting
 * stages, never special-casing `hasUnlimitedReroll`).
 */
function oracleDistributionFromPipeline(
  expr: string,
  maxDraws = 14,
): PrefixOracleResult {
  const ast = parse(expr);
  if (ast.type !== "dice") {
    throw new Error(`Oracle expects a single dice node, got ${ast.type}`);
  }
  const node: DiceNode = ast;
  const mode = node.resultMode ?? "sum";
  return runAdaptivePrefixOracle(
    (rng) => runPipeline(node.count, node.sides, node.modifiers, rng, mode).total,
    maxDraws,
  );
}

/**
 * Black-box adaptive prefix-tape oracle over `evaluate(ast, rng)` for compound
 * binary/arithmetic expressions (such as `1d6/(1d2!-22)`).
 */
function oracleDistributionFromEvaluate(
  expr: string,
  maxDraws: number,
): PrefixOracleResult {
  const ast = parse(expr);
  return runAdaptivePrefixOracle((rng) => evaluate(ast, rng).total, maxDraws);
}

/** Empirical distribution from `n` full `runPipeline` / `evaluate` executions. */
function empiricalEngineDistribution(expr: string, n = 100_000): Distribution {
  const ast = parse(expr);
  const rng = seededRng(987654321);
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const total = evaluate(ast, rng).total;
    counts.set(total, (counts.get(total) ?? 0) + 1);
  }
  const dist: Distribution = new Map();
  for (const [k, c] of counts) dist.set(k, c / n);
  return dist;
}

/** Kolmogorov–Smirnov distance `max_x |F_a(x) - F_b(x)|` between two distributions. */
function maxCdfDiff(a: Distribution, b: Distribution): number {
  const keys = [...new Set<number>([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
  let ca = 0;
  let cb = 0;
  let maxDiff = 0;
  for (const k of keys) {
    ca += a.get(k) ?? 0;
    cb += b.get(k) ?? 0;
    const d = Math.abs(ca - cb);
    if (d > maxDiff) maxDiff = d;
  }
  return maxDiff;
}

/**
 * Exact full-modifier `runPipeline` oracle for `1d100r<=99...` without
 * post-reroll branching: because all 99 faces `1..99` behave identically with
 * respect to `r<=99`, any chain that escapes on draw `k + 1` (`0 <= k < 100`)
 * is represented by `[1, ..., 1, 100]` with exact mass `0.99^k * 0.01`, and any
 * chain that hits `MAX_REROLLS = 100` with final draw `f in 1..100` is
 * represented by `[1, ..., 1 (100x), f]` with exact mass `0.99^100 * 0.01`.
 * Every tape is executed through `runPipeline` with the FULL `node.modifiers`.
 */
function oracleD100Reroll99FromPipeline(expr: string): Distribution {
  const ast = parse(expr);
  if (ast.type !== "dice") throw new Error("Expected dice node");
  const node: DiceNode = ast;
  const mode = node.resultMode ?? "sum";
  const dist: Distribution = new Map();

  function runFullModifiersTape(tape: number[]): number {
    let idx = 0;
    const rng: RngFn = () => {
      const v = tape[idx++];
      if (v === undefined) throw new Error("Unexpected extra RNG draw");
      return v;
    };
    return runPipeline(node.count, node.sides, node.modifiers, rng, mode).total;
  }

  // Escapes before cap: k failed rolls in 1..99 followed by 100.
  for (let k = 0; k < MAX_REROLLS; k++) {
    const tape = [...new Array<number>(k).fill(1), 100];
    const total = runFullModifiersTape(tape);
    const p = Math.pow(0.99, k) * 0.01;
    dist.set(total, (dist.get(total) ?? 0) + p);
  }

  // Reaches MAX_REROLLS = 100: 100 failed rolls in 1..99, then final roll f in 1..100.
  const prefix100 = new Array<number>(MAX_REROLLS).fill(1);
  const pCapEach = Math.pow(0.99, MAX_REROLLS) * 0.01;
  for (let f = 1; f <= 100; f++) {
    const total = runFullModifiersTape([...prefix100, f]);
    dist.set(total, (dist.get(total) ?? 0) + pCapEach);
  }

  return dist;
}

/**
 * Assert every outcome probability in `actual` matches `oracle`:
 * since `oracle` only omits non-negative `tailMass`, `actual(k)` and `oracle(k)`
 * cannot differ by more than `tailMass + slack`.
 */
function expectDistributionMatchesOracle(
  actual: Distribution,
  oracle: PrefixOracleResult,
  slack = 1e-12,
): void {
  const tol = oracle.tailMass + slack;
  const allKeys = new Set<number>([...actual.keys(), ...oracle.distribution.keys()]);
  for (const k of allKeys) {
    const pa = actual.get(k) ?? 0;
    const po = oracle.distribution.get(k) ?? 0;
    // Exact probability is >= truncated tree probability (up to FP rounding).
    expect(pa + slack).toBeGreaterThanOrEqual(po);
    expect(Math.abs(pa - po)).toBeLessThanOrEqual(tol);
  }
}

describe("Combined modifiers exact analysis vs unified prefix-tape runPipeline oracle", () => {
  it("2d6r=1! matches full-modifier runPipeline oracle and reports method: 'exact'", () => {
    const res = computeDistributionWithMethod(parse("2d6r=1!"));
    const oracle = oracleDistributionFromPipeline("2d6r=1!", 14);
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxRerolls: 100, maxExplosions: 100 });
    expect(oracle.tailMass).toBeLessThan(1e-7);
    // Pre-fix bug returned plain 2d6! where P(2) = 1/36; with r=1 capped at
    // MAX_REROLLS = 100, P(2) = (6^-101)^2 = 6^-202 (~6.5e-158), matching
    // `roll("2d6r=1!", () => 1).total === 2`.
    expect(roll("2d6r=1!", () => 1).total).toBe(2);
    expect(res.distribution.get(2)).toBeCloseTo(Math.pow(1 / 6, 202), 160);
    expect(res.distribution.get(2)!).toBeLessThan(1e-150);
    expectDistributionMatchesOracle(res.distribution, oracle);
    expect(computeStats(res.distribution).mean).toBeCloseTo(
      computeStats(oracle.distribution).mean,
      5,
    );
  });

  it("2d6min2! matches full-modifier runPipeline oracle and reports method: 'exact'", () => {
    const res = computeDistributionWithMethod(parse("2d6min2!"));
    const oracle = oracleDistributionFromPipeline("2d6min2!", 14);
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxExplosions: 100 });
    expect(oracle.tailMass).toBeLessThan(1e-8);
    expect(res.distribution.get(2) ?? 0).toBe(0);
    expect(res.distribution.get(3) ?? 0).toBe(0);
    expect(res.distribution.get(4)).toBeCloseTo(4 / 36, 12);
    expectDistributionMatchesOracle(res.distribution, oracle);
    expect(computeStats(res.distribution).mean).toBeCloseTo(
      computeStats(oracle.distribution).mean,
      6,
    );
  });

  it("2d6r=1min3 matches full-modifier runPipeline oracle and reports method: 'exact'", () => {
    const res = computeDistributionWithMethod(parse("2d6r=1min3"));
    const oracle = oracleDistributionFromPipeline("2d6r=1min3", 14);
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxRerolls: 100 });
    expect(oracle.tailMass).toBeLessThan(1e-8);
    expect(res.distribution.get(4) ?? 0).toBe(0);
    expect(res.distribution.get(5) ?? 0).toBe(0);
    // Even the 6^-101 cap residual on face 1 is clamped to 3 by Stage 3 `min3`,
    // so min is strictly 6 and P(6) = (2/5 + 4/5 * 6^-101)^2.
    expect(computeStats(res.distribution).min).toBe(6);
    expect(res.distribution.get(6)).toBeCloseTo(4 / 25, 12);
    expectDistributionMatchesOracle(res.distribution, oracle);
    expect(computeStats(res.distribution).mean).toBeCloseTo(
      computeStats(oracle.distribution).mean,
      7,
    );
  });

  it("2d4ro=1min2! (3-stage combined: reroll_once + min + explode) matches full-modifier runPipeline oracle", () => {
    const res = computeDistributionWithMethod(parse("2d4ro=1min2!"));
    const oracle = oracleDistributionFromPipeline("2d4ro=1min2!", 14);
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxExplosions: 100 });
    expect(oracle.tailMass).toBeLessThan(2e-6);
    expect(res.distribution.get(2) ?? 0).toBe(0);
    expect(res.distribution.get(3) ?? 0).toBe(0);
    expect(res.distribution.get(4)).toBeCloseTo(36 / 256, 12);
    expectDistributionMatchesOracle(res.distribution, oracle);
    expect(computeStats(res.distribution).mean).toBeCloseTo(
      computeStats(oracle.distribution).mean,
      4,
    );
  });

  it("3d4ro=1kh2 (reroll_once + keep-highest) matches zero-tail full-modifier runPipeline oracle", () => {
    const res = computeDistributionWithMethod(parse("3d4ro=1kh2"));
    const oracle = oracleDistributionFromPipeline("3d4ro=1kh2", 6);
    expect(res.method).toBe("exact");
    expect(res.caps).toBeUndefined();
    expect(oracle.tailMass).toBe(0);
    expectDistributionMatchesOracle(res.distribution, oracle);
  });

  it("3d4r=1kh2 (unlimited reroll + keep-highest) matches full-modifier runPipeline oracle without dropping kh2", () => {
    // Regression for Item 4: the previous oracle guarded Case A with
    // `!hasUnlimitedReroll`, causing `3d4r=1kh2` to fall through to Case B and
    // drop `kh2` (summing all 3 dice, mean ~9 instead of ~6.48). The unified
    // prefix-tape oracle runs `runPipeline` with `[r=1, kh2]` together.
    const res = computeDistributionWithMethod(parse("3d4r=1kh2"));
    const oracle = oracleDistributionFromPipeline("3d4r=1kh2", 16);
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxRerolls: 100 });
    expect(oracle.tailMass).toBeLessThan(5e-7);
    expect(computeStats(oracle.distribution).max).toBe(8); // kh2 of d4 <= 8 (never 12!)
    expect(computeStats(res.distribution).max).toBe(8);
    expectDistributionMatchesOracle(res.distribution, oracle);
  });
});

// ─── Item 1 & Publisher cap contract: MAX_EXPLOSIONS = 100 exactness ──────────

describe("Item 1 — explosion cap (MAX_EXPLOSIONS = 100) exactness & degenerate explosions", () => {
  it("1d2! pins MAX_EXPLOSIONS = 100 exactly against zero-tail runPipeline oracle (P(22) === 0, P(202) = 2^-101)", () => {
    // Every chain stopping before 100 explosions ends on 1 -> odd sums 1,3,...,201;
    // hitting MAX_EXPLOSIONS = 100 on all-2s yields 101 * 2 = 202. Even sums < 202
    // (such as 22 from depth-10 truncation) are impossible in the engine.
    const res = analyzePublic("1d2!");
    const oracle = oracleDistributionFromPipeline("1d2!", MAX_EXPLOSIONS + 1);
    expect(oracle.tailMass).toBe(0);
    expect(oracle.leaves).toBe(MAX_EXPLOSIONS + 2); // 102 leaves
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxExplosions: MAX_EXPLOSIONS });
    expect(res.distribution.get(22)).toBeUndefined();
    expect(roll("1d2!", () => 2).total).toBe(202);
    expect(res.distribution.get(202)).toBe(Math.pow(0.5, 101));
    expect(res.distribution.get(201)).toBe(Math.pow(0.5, 101));
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-15);
  });

  it("1d6/(1d2!-22) does NOT false-positive throw Division by zero and matches zero-tail evaluate oracle", () => {
    // 1d2! only produces {1, 3, ..., 201, 202}, so 1d2! - 22 is NEVER 0.
    const res = analyzePublic("1d6/(1d2!-22)");
    const oracle = oracleDistributionFromEvaluate("1d6/(1d2!-22)", MAX_EXPLOSIONS + 2);
    expect(oracle.tailMass).toBe(0);
    expect(oracle.leaves).toBe(6 * (MAX_EXPLOSIONS + 2)); // 612 leaves
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxExplosions: MAX_EXPLOSIONS });
    expect(roll("1d6/(1d2!-22)", () => 2).total).toBe(0); // floor(2 / (202 - 22)) = 0
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-15);
  });

  it("1d6!>=1 (all-faces explode) models MAX_EXPLOSIONS = 100 (101d6, mean 353.5) and agrees with engine", () => {
    const res = analyzePublic("1d6!>=1");
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxExplosions: MAX_EXPLOSIONS });
    expect(roll("1d6!>=1", () => 1).total).toBe(101);
    expect(roll("1d6!>=1", () => 6).total).toBe(606);
    expect(res.stats.min).toBe(101);
    expect(res.stats.max).toBe(606);
    expect(res.stats.mean).toBeCloseTo(101 * 3.5, 10); // 353.5
    const emp = empiricalEngineDistribution("1d6!>=1", 40_000);
    expect(maxCdfDiff(res.distribution, emp)).toBeLessThan(0.012);
  });

  it("1d6r=1!>=1 (reroll + all-faces explode) models both caps (mean 354) and agrees with engine", () => {
    // Stage 2 `r=1` gives mean 4 on initial die (up to 6^-101 residual); Stage 4
    // `!>=1` adds 100 raw d6 bonus rolls (mean 350) -> total mean 354 (not 39!).
    const res = analyzePublic("1d6r=1!>=1");
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({
      maxRerolls: MAX_REROLLS,
      maxExplosions: MAX_EXPLOSIONS,
    });
    expect(roll("1d6r=1!>=1", () => 1).total).toBe(101);
    expect(roll("1d6r=1!>=1", () => 6).total).toBe(606);
    expect(res.stats.min).toBe(101);
    expect(res.stats.max).toBe(606);
    expect(res.stats.mean).toBeCloseTo(354, 10);
    const emp = empiricalEngineDistribution("1d6r=1!>=1", 40_000);
    expect(maxCdfDiff(res.distribution, emp)).toBeLessThan(0.012);
  });

  it("1d6!>=2 (high-rate 5/6 explosion) models MAX_EXPLOSIONS = 100 (mean ~21, not 18.17) and agrees with engine", () => {
    const res = analyzePublic("1d6!>=2");
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxExplosions: MAX_EXPLOSIONS });
    // Exact mean for geometric chain capped at 100 bonus rolls:
    // E = 3.5 * (1 - (5/6)^101) / (1 - 5/6) = 21 * (1 - (5/6)^101).
    const expectedMean = 21 * (1 - Math.pow(5 / 6, MAX_EXPLOSIONS + 1));
    expect(res.stats.mean).toBeCloseTo(expectedMean, 9);
    // Low outcomes (<= 6) terminate in <= 5 draws and match prefix-tape oracle with zero error.
    const prefixOracle = oracleDistributionFromPipeline("1d6!>=2", 6);
    for (let k = 1; k <= 6; k++) {
      expect(res.distribution.get(k) ?? 0).toBeCloseTo(
        prefixOracle.distribution.get(k) ?? 0,
        12,
      );
    }
    const emp = empiricalEngineDistribution("1d6!>=2", 60_000);
    expect(maxCdfDiff(res.distribution, emp)).toBeLessThan(0.01);
  });

  it("1d1000!>=1 abandons to monte-carlo when MAX_EXPLOSIONS expansion exceeds MAX_EXACT_STATES", () => {
    const res = analyzePublic("1d1000!>=1");
    expect(res.method).toBe("monte-carlo");
    expect(res.samples).toBe(100_000);
    expect(res.caps).toBeUndefined();
    expect(res.stats.mean).toBeCloseTo(101 * 500.5, -2); // ~50,550.5
  });
});

// ─── Item 2 & Publisher cap contract: MAX_REROLLS = 100 exactness ─────────────

describe("Item 2 — unlimited reroll cap (MAX_REROLLS = 100) exactness & residual mass", () => {
  it("1d2r=1 pins MAX_REROLLS = 100 exactly against zero-tail runPipeline oracle (P(1) = 2^-101)", () => {
    const res = analyzePublic("1d2r=1");
    const oracle = oracleDistributionFromPipeline("1d2r=1", MAX_REROLLS + 1);
    expect(oracle.tailMass).toBe(0);
    expect(oracle.leaves).toBe(MAX_REROLLS + 2); // 102 leaves
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxRerolls: MAX_REROLLS });
    expect(roll("1d2r=1", () => 1).total).toBe(1);
    expect(res.distribution.get(1)).toBe(Math.pow(0.5, 101));
    expect(res.distribution.get(2)).toBe(1 - Math.pow(0.5, 101));
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-15);
  });

  it("1d100r<=99 models MAX_REROLLS = 100 residual (mean ~81.88, not 100) and matches full-modifier runPipeline oracle", () => {
    const res = analyzePublic("1d100r<=99");
    const oracle = oracleD100Reroll99FromPipeline("1d100r<=99");
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxRerolls: MAX_REROLLS });
    const q101 = Math.pow(0.99, 101);
    const expectedMean = (1 - q101) * 100 + q101 * 50; // ~81.8805
    expect(res.stats.mean).toBeCloseTo(expectedMean, 10);
    expectDistributionMatchesOracle(
      res.distribution,
      { distribution: oracle, tailMass: 0, leaves: 200 },
      1e-14,
    );
    const emp = empiricalEngineDistribution("1d100r<=99", 60_000);
    expect(maxCdfDiff(res.distribution, emp)).toBeLessThan(0.01);
  });

  it("1d100r<=99min50 models MAX_REROLLS = 100 + Stage 3 min50 (mean ~86.42, not 100) and matches runPipeline oracle", () => {
    const res = analyzePublic("1d100r<=99min50");
    const oracle = oracleD100Reroll99FromPipeline("1d100r<=99min50");
    expect(res.method).toBe("exact");
    expect(res.caps).toEqual({ maxRerolls: MAX_REROLLS });
    expect(res.stats.min).toBe(50);
    expectDistributionMatchesOracle(
      res.distribution,
      { distribution: oracle, tailMass: 0, leaves: 200 },
      1e-14,
    );
    const emp = empiricalEngineDistribution("1d100r<=99min50", 60_000);
    expect(maxCdfDiff(res.distribution, emp)).toBeLessThan(0.01);
  });

  it("1d6/(1d100r<=99-50) throws ParseError('Division by zero') in both analyze() and roll()", () => {
    // After 100 failed rerolls, 1d100r<=99 lands on 50 with p = 0.99^100 * 0.01 ≈ 1/273.
    expect(() => roll("1d6/(1d100r<=99-50)", () => 50)).toThrow(ParseError);
    expect(() => roll("1d6/(1d100r<=99-50)", () => 50)).toThrow(/division by zero/i);
    expect(() => analyzePublic("1d6/(1d100r<=99-50)")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/(1d100r<=99-50)")).toThrow(/division by zero/i);
  });
});

// ─── Item 3: Division-by-zero check order & non-exact divisor contract ────────

describe("Division by zero agreement between roll() and analyze() (including Item 3)", () => {
  it("1d6/0 throws ParseError('Division by zero') in both roll() and analyze()", () => {
    expect(() => roll("1d6/0")).toThrow(ParseError);
    expect(() => roll("1d6/0")).toThrow(/division by zero/i);
    expect(() => analyzePublic("1d6/0")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/0")).toThrow(/division by zero/i);
    expect(() => computeDistribution(parse("1d6/0"))).toThrow(ParseError);
  });

  it("divisor distribution that can roll 0 (1d6/(1d2-1) and 1d6/(4d20-4)) throws ParseError('Division by zero')", () => {
    expect(() => analyzePublic("1d6/(1d2-1)")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/(1d2-1)")).toThrow(/division by zero/i);
    expect(() => analyzePublic("1d6/(4d20-4)")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/(4d20-4)")).toThrow(/division by zero/i);
    expect(() => computeDistribution(parse("1d6/(4d20-4)"))).toThrow(ParseError);

    let threwDivZero = false;
    for (let seed = 1; seed <= 50; seed++) {
      try {
        evaluate(parse("1d6/(1d2-1)"), seededRng(seed));
      } catch (e) {
        expect(e).toBeInstanceOf(ParseError);
        expect((e as Error).message).toMatch(/division by zero/i);
        threwDivZero = true;
        break;
      }
    }
    expect(threwDivZero).toBe(true);
  });

  it("500d1000/(5d20-5) checks the exact divisor BEFORE left ExactTooLargeError and throws Division by zero", () => {
    // `500d1000` exceeds MAX_EXACT_STATES on the left, while `5d20-5` is exact
    // with P(0) = 20^-5 > 0 on the right. Checking right before left ensures
    // analyze() deterministically throws ParseError("Division by zero").
    expect(() => roll("500d1000/(5d20-5)", () => 1)).toThrow(ParseError);
    expect(() => roll("500d1000/(5d20-5)", () => 1)).toThrow(/division by zero/i);
    expect(() => analyzePublic("500d1000/(5d20-5)")).toThrow(ParseError);
    expect(() => analyzePublic("500d1000/(5d20-5)")).toThrow(/division by zero/i);
    // And a division-by-zero nested in `left` still throws when `right` exceeds MAX_EXACT_STATES:
    expect(() => analyzePublic("(1d6/(5d20-5))+500d1000")).toThrow(ParseError);
    expect(() => analyzePublic("(1d6/(5d20-5))+500d1000")).toThrow(/division by zero/i);
  });

  it("non-exact divisor contract: 1d6/(5d20!kh4-4) is sampled (never 'exact'), and 1d6/(4d6!kh3-12) throws when MC hits 0", () => {
    // Documented decision for non-exact divisors (`tryExact(right) === null`,
    // here because `5d20!kh4` / `4d6!kh3` combine explosion + keep/drop):
    //   - `analyze()` falls back to `monteCarloDistribution` (100,000 trials via
    //     `evaluate()`).
    //   - If any sampled trial hits a 0 divisor (`1d6/(4d6!kh3-12)`, P(0) = 6^-4),
    //     `evaluate()` throws `ParseError("Division by zero")`.
    //   - If a rare 0 divisor (`1d6/(5d20!kh4-4)`, P(0) = 20^-5) is missed within
    //     100,000 samples, `analyze()` labels the result `method: "monte-carlo"`
    //     with `samples: 100_000` — NEVER `"exact"`.
    expect(() => roll("1d6/(5d20!kh4-4)", () => 1)).toThrow(ParseError);
    expect(() => roll("1d6/(5d20!kh4-4)", () => 1)).toThrow(/division by zero/i);

    const rareMc = analyzePublic("1d6/(5d20!kh4-4)");
    expect(rareMc.method).toBe("monte-carlo");
    expect(rareMc.samples).toBe(100_000);
    expect(rareMc.caps).toBeUndefined();

    expect(() => analyzePublic("1d6/(4d6!kh3-12)")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/(4d6!kh3-12)")).toThrow(/division by zero/i);
  });
});

// ─── Publisher ruling: cap metadata surfaced in CLI, JSON, Bridge, and MCP ────

describe("Engine-cap metadata surfaced across analyze(), CLI, Bridge, and MCP", () => {
  it("omits caps when no engine loop cap is exercised, and names caps when exercised", () => {
    const plain = analyzePublic("2d6");
    expect(plain.method).toBe("exact");
    expect("caps" in plain).toBe(false);

    const outLines: string[] = [];
    const codeText = runCli(["--analyze", "--no-color", "2d6r=1!"], {
      out: (l = "") => outLines.push(l),
      err: () => {},
    });
    expect(codeText).toBe(0);
    expect(outLines.join("\n")).toContain(
      "exact probabilities (engine caps: MAX_EXPLOSIONS=100, MAX_REROLLS=100)",
    );

    const jsonLines: string[] = [];
    const codeJson = runCli(["--analyze", "--json", "1d2!"], {
      out: (l = "") => jsonLines.push(l),
      err: () => {},
    });
    expect(codeJson).toBe(0);
    const cliParsed = JSON.parse(jsonLines.join("\n")) as {
      method: string;
      caps?: { maxExplosions?: number; maxRerolls?: number };
    };
    expect(cliParsed.method).toBe("exact");
    expect(cliParsed.caps).toEqual({ maxExplosions: 100 });

    const bridge = new BridgeHandler({ info: () => {}, error: () => {} });
    const bridgeRes = bridge.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "analyze",
      params: { expression: "1d100r<=99" },
    });
    expect((bridgeRes.result as { caps?: unknown }).caps).toEqual({
      maxRerolls: 100,
    });

    const mcpRes = handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "analyze_dice", arguments: { expression: "1d2!" } },
    });
    const mcpPayload = JSON.parse(
      (mcpRes.result as { content: { text: string }[] }).content[0]!.text,
    ) as { method: string; caps?: unknown };
    expect(mcpPayload.method).toBe("exact");
    expect(mcpPayload.caps).toEqual({ maxExplosions: 100 });
  });
});


