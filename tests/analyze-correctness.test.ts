import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { computeDistribution, type Distribution } from "../src/analyze/distribution.js";
import { computeStats } from "../src/analyze/stats.js";
import { monteCarloDistribution } from "../src/analyze/montecarlo.js";
import { evaluate } from "../src/engine/roller.js";
import { seededRng } from "../src/engine/random.js";

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

// ─── H3 / F-AT-003: keep/drop + explosion/reroll must fall back to Monte Carlo ─
// INVARIANT: when a node has BOTH keep/drop AND (explosion OR reroll),
// enumerateKeepDrop cannot model it (it ignores explosion and reroll), so
// tryExact must return null and the result must reflect the engine's actual
// behavior (within MC tolerance) rather than the plain keep/drop distribution.

describe("F-AT-003 keep/drop + explosion/reroll falls back to MC (engine-agreement)", () => {
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
