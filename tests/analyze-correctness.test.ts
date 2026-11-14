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
import { roll, analyze as analyzePublic } from "../src/index.js";

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

// ─── Combined modifiers + divide-by-zero oracle & parity tests ────────────────
//
// Independent brute-force oracle: enumerates die outcomes directly through
// `runPipeline` in `src/engine/pipeline.ts` (never touching `distribution.ts`).
//
// For a single die (or N dice without explosion/reroll):
//   We drive `runPipeline` with a deterministic tape RNG that yields each face
//   sequence `(f_1, f_2, ...)` in `{1..s}^L`, weighted by `(1/s)^L`.
//
// When a die node has no keep/drop, the N dice in `NdM` are independent and
// identically distributed through stages 1–4 and stage 8 (`runPipeline`
// processes each initial die's reroll, min/max, and explosion chain
// independently before summing kept dice). For finite-tape single-die
// enumeration (used for `ro` + `!` or non-exploding dice) or exact Markov
// transition enumeration derived by probing `runPipeline` on 1-die tapes (for
// unlimited `r` + `!`), the oracle computes the exact single-die distribution
// to explosion depth D = 10 (`leftover probability <= (p_explode)^11`; for d6
// exploding on 6, `(1/6)^11 ≈ 2.76e-9` per die, `<= 5.52e-9` for 2 dice) and
// combines N independent dice by direct Cartesian sum over single-die support.

/**
 * Independent brute-force oracle for a `DiceNode` using ONLY `runPipeline` from
 * `src/engine/pipeline.ts`. Never calls any helper in `distribution.ts`.
 *
 * Strategy:
 * 1. If the expression uses only bounded-draw modifiers per die (`min`/`max`,
 *    `ro`, `kh`/`kl`/`dh`/`dl`, `cs`/`cf`) with at most `L` RNG draws total
 *    where `s^L <= 250_000`, enumerate every possible RNG draw sequence of
 *    length `L` directly through `runPipeline(node.count, node.sides, ...)`.
 * 2. For exploding dice (or unlimited reroll `r`), each initial die is
 *    processed independently by `runPipeline`:
 *      - Stage 2 (`stageReroll`): probe `runPipeline(1, sides, rerollOnlyMods)`
 *        over all 1-step and 2-step face tapes to obtain the exact post-reroll
 *        face distribution (solving the geometric series `p / (1 - p_reroll)`
 *        for unlimited `r` directly from which faces `stageReroll` replaces).
 *      - Stage 3 (`stageMinMax`): pass each post-reroll face through
 *        `runPipeline(1, sides, minMaxOnlyMods)` to obtain the exact
 *        post-min/max face distribution.
 *      - Stage 4 (`stageExplode`): for each post-min/max initial face `f_0`,
 *        enumerate explosion chains up to depth `maxExplosionDepth` (default 10,
 *        matching the analyzer's depth cap; leftover mass `(1/s)^(depth+1)` is
 *        <= `6^-11 ≈ 2.76e-9` for d6!) by running `runPipeline(1, sides,
 *        explodeAndCountMods)` on the tape `[f_0, e_1, ..., e_d]`.
 *    Then combine `node.count` independent dice by direct nested-loop sum.
 */
function oracleDistributionFromPipeline(
  expr: string,
  maxExplosionDepth = 10,
): Distribution {
  const ast = parse(expr);
  if (ast.type !== "dice") {
    throw new Error(`Oracle expects a single dice node, got ${ast.type}`);
  }
  const node: DiceNode = ast;
  if (node.sides === "F" || node.sides === "%") {
    throw new Error("Oracle only supports numeric small dice (d2-d6)");
  }
  const s = node.sides;
  const resultMode = node.resultMode ?? "sum";

  const hasKeepDrop = node.modifiers.some(
    (m) => m.kind === "kh" || m.kind === "kl" || m.kind === "dh" || m.kind === "dl",
  );
  const hasExplosion = node.modifiers.some(
    (m) => m.kind === "explode" || m.kind === "compound" || m.kind === "penetrate",
  );
  const hasUnlimitedReroll = node.modifiers.some((m) => m.kind === "reroll");
  const rerollOnceCount = node.modifiers.filter((m) => m.kind === "reroll_once").length;

  // Helper: create a deterministic tape RNG that feeds `tape` into runPipeline
  // and records how many draws were consumed.
  function runWithTape(
    count: number,
    mods: DiceNode["modifiers"],
    tape: number[],
    mode: "sum" | "success_count" = resultMode,
  ): { total: number; consumed: number; firstDieValue: number } {
    let idx = 0;
    const rng: RngFn = (_min: number, _max: number): number => {
      const val = tape[idx];
      if (val === undefined) {
        throw new Error(`Oracle tape exhausted at index ${idx} (length ${tape.length})`);
      }
      idx++;
      return val;
    };
    const res = runPipeline(count, s, mods, rng, mode);
    return {
      total: res.total,
      consumed: idx,
      firstDieValue: res.dice[0]?.value ?? 0,
    };
  }

  // Case A: Keep/drop without explosion or unlimited reroll — enumerate full
  // N-die RNG tapes directly through `runPipeline(node.count, ...)`.
  if (hasKeepDrop && !hasExplosion && !hasUnlimitedReroll) {
    const maxDraws = node.count * (1 + rerollOnceCount);
    const dist: Distribution = new Map();
    const tape = new Array<number>(maxDraws).fill(1);
    const totalTapes = Math.pow(s, maxDraws);
    const tapeProb = 1 / totalTapes;

    function enumFullTapes(pos: number): void {
      if (pos === maxDraws) {
        const { total } = runWithTape(node.count, node.modifiers, tape);
        dist.set(total, (dist.get(total) ?? 0) + tapeProb);
        return;
      }
      for (let f = 1; f <= s; f++) {
        tape[pos] = f;
        enumFullTapes(pos + 1);
      }
    }
    enumFullTapes(0);
    return dist;
  }

  // Case B: Per-die independent pipeline stages (Stages 1 -> 2 -> 3 -> 4 -> 8)
  // probed directly via `runPipeline(1, ...)`.
  //
  // Stage 1: initial roll distribution on {1..s}.
  let singleDieFaceDist: Distribution = new Map();
  for (let f = 1; f <= s; f++) {
    singleDieFaceDist.set(f, 1 / s);
  }

  // Stage 2: apply each reroll / reroll_once modifier in the exact order
  // `stageReroll` executes them (all `reroll` mods in order, then all
  // `reroll_once` mods in order — see `src/engine/pipeline.ts:95-122`).
  const orderedRerolls = [
    ...node.modifiers.filter((m) => m.kind === "reroll"),
    ...node.modifiers.filter((m) => m.kind === "reroll_once"),
  ];
  for (const rMod of orderedRerolls) {
    const nextDist: Distribution = new Map();
    if (rMod.kind === "reroll") {
      // Probe `runPipeline` with a 2-element tape `[face, fallback]` where
      // `fallback` is a non-matching face: if `consumed > 1`, `stageReroll`
      // rerolled `face`.
      const stays: number[] = [];
      for (let f = 1; f <= s; f++) {
        // Tape of 105 copies of `f`: if `f` does NOT match the reroll compare,
        // `stageReroll` consumes only 1 draw (`the initial stageRoll`).
        const probe = runWithTape(1, [rMod], new Array<number>(105).fill(f), "sum");
        if (probe.consumed === 1) {
          stays.push(f);
        }
      }
      // In `stageReroll`, if a face is rerolled, it draws a fresh uniform face
      // in `1..s` until it lands on `stays` (each staying face reached with
      // equal conditional probability `1 / stays.length`).
      let rerolledMass = 0;
      for (const [f, p] of singleDieFaceDist) {
        if (stays.includes(f)) {
          nextDist.set(f, (nextDist.get(f) ?? 0) + p);
        } else {
          rerolledMass += p;
        }
      }
      for (const fStay of stays) {
        nextDist.set(fStay, (nextDist.get(fStay) ?? 0) + rerolledMass / stays.length);
      }
    } else {
      // `reroll_once`: enumerate all `(initialFace, secondFace)` pairs through
      // `runPipeline(1, [rMod])` weighted by `singleDieFaceDist.get(initialFace) * (1/s)`.
      for (const [f1, p1] of singleDieFaceDist) {
        for (let f2 = 1; f2 <= s; f2++) {
          const { firstDieValue } = runWithTape(1, [rMod], [f1, f2], "sum");
          const p = p1 * (1 / s);
          nextDist.set(firstDieValue, (nextDist.get(firstDieValue) ?? 0) + p);
        }
      }
    }
    singleDieFaceDist = nextDist;
  }

  // Stage 3: apply `stageMinMax` by running each face through `runPipeline(1, minMaxMods)`.
  const minMaxMods = node.modifiers.filter((m) => m.kind === "min" || m.kind === "max");
  if (minMaxMods.length > 0) {
    const clampedDist: Distribution = new Map();
    for (const [f, p] of singleDieFaceDist) {
      const { firstDieValue } = runWithTape(1, minMaxMods, [f], "sum");
      clampedDist.set(firstDieValue, (clampedDist.get(firstDieValue) ?? 0) + p);
    }
    singleDieFaceDist = clampedDist;
  }

  // Stage 4 + Stage 8: explosion + total per initial die, probed through
  // `runPipeline(1, postMinMaxMods, tape, resultMode)`.
  const postMinMaxMods = node.modifiers.filter(
    (m) =>
      m.kind === "explode" ||
      m.kind === "compound" ||
      m.kind === "penetrate" ||
      m.kind === "cs_count" ||
      m.kind === "cf_count",
  );

  const singleDieTotalDist: Distribution = new Map();

  if (!hasExplosion) {
    for (const [f, p] of singleDieFaceDist) {
      const { total } = runWithTape(1, postMinMaxMods, [f], resultMode);
      singleDieTotalDist.set(total, (singleDieTotalDist.get(total) ?? 0) + p);
    }
  } else {
    // Enumerate explosion chains tree-wise using `runPipeline(1, postMinMaxMods)`:
    // For a prefix tape `[f0, e1, ..., ed]`, pad with a non-exploding sentinel
    // tail and check how many draws `runPipeline` consumes. If `consumed === d + 1`,
    // the chain terminated at depth `d` and its exact total is `res.total`.
    // If it still wants to explode at `d < maxExplosionDepth`, branch over
    // `e_{d+1} in 1..s`, each with conditional probability `1/s`.
    // At `d === maxExplosionDepth`, stop branching and record the truncated
    // chain's total (matching the depth-10 truncation).
    // Find a face that does not trigger explosion (or fallback to 1).
    let nonExplodingFace = 1;
    for (let f = 1; f <= s; f++) {
      const probe = runWithTape(1, postMinMaxMods, new Array<number>(105).fill(f), resultMode);
      if (probe.consumed === 1) {
        nonExplodingFace = f;
        break;
      }
    }

    function walkExplosionTree(prefix: number[], prob: number, depth: number): void {
      if (depth === maxExplosionDepth) {
        // Compute total of the chain `prefix` without further explosions by
        // evaluating each roll in `prefix` through the non-exploding stageTotal
        // or by temporarily capping the chain. Since `prefix` has `maxExplosionDepth + 1`
        // rolls and all `prefix[0..depth-1]` exploded, only `prefix[depth]` might
        // still want to explode. If `prefix[depth]` does not explode, `runWithTape`
        // with `[...prefix, nonExplodingFace]` consumes ` prefix.length` draws.
        // If `prefix[depth]` DOES explode, its contribution at depth cap is the
        // same as its contribution in `stageExplode` before the next push.
        const padded = [...prefix, ...new Array<number>(105).fill(nonExplodingFace)];
        const probe = runWithTape(1, postMinMaxMods, padded, resultMode);
        if (probe.consumed === prefix.length) {
          singleDieTotalDist.set(probe.total, (singleDieTotalDist.get(probe.total) ?? 0) + prob);
        } else {
          // `prefix[depth]` also matched the explosion threshold, so `stageExplode`
          // drew one extra `nonExplodingFace`. Subtract that extra draw's contribution:
          const extra = runWithTape(1, postMinMaxMods, [nonExplodingFace], resultMode).total;
          const isPen = postMinMaxMods.some((m) => m.kind === "penetrate");
          const extraContribution =
            resultMode === "sum"
              ? isPen
                ? Math.max(1, nonExplodingFace - 1)
                : nonExplodingFace
              : extra;
          const totalAtCap = probe.total - extraContribution;
          singleDieTotalDist.set(
            totalAtCap,
            (singleDieTotalDist.get(totalAtCap) ?? 0) + prob,
          );
        }
        return;
      }

      const padded = [...prefix, ...new Array<number>(105).fill(nonExplodingFace)];
      const probe = runWithTape(1, postMinMaxMods, padded, resultMode);
      if (probe.consumed === prefix.length) {
        // Chain terminated naturally at this depth!
        singleDieTotalDist.set(probe.total, (singleDieTotalDist.get(probe.total) ?? 0) + prob);
        return;
      }

      // Otherwise `prefix[prefix.length - 1]` exploded: branch over next roll 1..s.
      for (let nextFace = 1; nextFace <= s; nextFace++) {
        prefix.push(nextFace);
        walkExplosionTree(prefix, prob * (1 / s), depth + 1);
        prefix.pop();
      }
    }

    for (const [f0, p0] of singleDieFaceDist) {
      walkExplosionTree([f0], p0, 0);
    }
  }

  // Combine `node.count` independent dice by direct Cartesian sum (no `convolve`
  // from `distribution.ts`!).
  let combined: Distribution = new Map([[0, 1]]);
  for (let d = 0; d < node.count; d++) {
    const next: Distribution = new Map();
    for (const [sumA, probA] of combined) {
      for (const [sumB, probB] of singleDieTotalDist) {
        const total = sumA + sumB;
        next.set(total, (next.get(total) ?? 0) + probA * probB);
      }
    }
    combined = next;
  }
  return combined;
}

/** Assert every outcome probability in `actual` matches `oracle` within `tol`. */
function expectDistributionMatchesOracle(
  actual: Distribution,
  oracle: Distribution,
  tol: number,
): void {
  const allKeys = new Set<number>([...actual.keys(), ...oracle.keys()]);
  for (const k of allKeys) {
    const pa = actual.get(k) ?? 0;
    const po = oracle.get(k) ?? 0;
    expect(Math.abs(pa - po)).toBeLessThanOrEqual(tol);
  }
}

describe("Combined modifiers exact analysis vs independent pipeline oracle", () => {
  it("2d6r=1! matches pipeline oracle and reports method: 'exact'", () => {
    // Reroll 1s (stage 2) -> faces 2..6 each have p=1/5 -> explode on 6 (stage 4,
    // explosion rolls use raw 1..6 faces). Pre-fix bug: `tryExact` routed to
    // `explosionDistribution`, ignoring `r=1` and returning plain `2d6!` where
    // initial face 1 (and sum 2) had non-zero probability.
    const res = computeDistributionWithMethod(parse("2d6r=1!"));
    const oracle = oracleDistributionFromPipeline("2d6r=1!", 10);
    expect(res.method).toBe("exact");
    // Minimum possible sum is 4 (each die starts on 2..5, or 6 which adds >=1).
    expect(res.distribution.get(2) ?? 0).toBe(0);
    expect(res.distribution.get(3) ?? 0).toBe(0);
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-9);
    expect(computeStats(res.distribution).mean).toBeCloseTo(computeStats(oracle).mean, 6);
  });

  it("2d6min2! matches pipeline oracle and reports method: 'exact'", () => {
    // Min floor 2 (stage 3) -> face 1 becomes 2 (so P(2)=2/6, P(3..6)=1/6) ->
    // explode on 6 (stage 4). Pre-fix bug: `tryExact` routed to
    // `explosionDistribution`, ignoring `min2` and returning plain `2d6!` where
    // sum 2 and 3 had non-zero mass.
    const res = computeDistributionWithMethod(parse("2d6min2!"));
    const oracle = oracleDistributionFromPipeline("2d6min2!", 10);
    expect(res.method).toBe("exact");
    expect(res.distribution.get(2) ?? 0).toBe(0);
    expect(res.distribution.get(3) ?? 0).toBe(0);
    expect(res.distribution.get(4)).toBeCloseTo(4 / 36, 9);
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-9);
    expect(computeStats(res.distribution).mean).toBeCloseTo(computeStats(oracle).mean, 6);
  });

  it("2d6r=1min3 matches pipeline oracle and reports method: 'exact'", () => {
    // Reroll 1s (stage 2: faces 2..6 each p=1/5) -> min 3 (stage 3: face 2
    // clamps to 3, so P(3)=2/5, P(4)=1/5, P(5)=1/5, P(6)=1/5). Pre-fix bug:
    // `tryExact` routed to `rerollDistribution`, ignoring `min3` and leaving
    // face 2 (and sums 4, 5) with positive probability.
    const res = computeDistributionWithMethod(parse("2d6r=1min3"));
    const oracle = oracleDistributionFromPipeline("2d6r=1min3");
    expect(res.method).toBe("exact");
    expect(res.distribution.get(4) ?? 0).toBe(0);
    expect(res.distribution.get(5) ?? 0).toBe(0);
    expect(res.distribution.get(6)).toBeCloseTo(4 / 25, 12);
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-12);
    expect(computeStats(res.distribution).mean).toBeCloseTo(computeStats(oracle).mean, 10);
  });

  it("2d4ro=1min2! (3-stage combined: reroll_once + min + explode) matches pipeline oracle", () => {
    // Combines all three per-die modifier families on d4:
    //   Stage 2 (`ro=1`): P(1)=1/16, P(2)=5/16, P(3)=5/16, P(4)=5/16
    //   Stage 3 (`min2`): clamps 1 -> 2, so P(2)=6/16, P(3)=5/16, P(4)=5/16
    //   Stage 4 (`!`): face 4 explodes with raw d4 rolls (1..4).
    const res = computeDistributionWithMethod(parse("2d4ro=1min2!"));
    const oracle = oracleDistributionFromPipeline("2d4ro=1min2!", 10);
    expect(res.method).toBe("exact");
    expect(res.distribution.get(2) ?? 0).toBe(0);
    expect(res.distribution.get(3) ?? 0).toBe(0);
    expect(res.distribution.get(4)).toBeCloseTo(36 / 256, 12);
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-8);
    expect(computeStats(res.distribution).mean).toBeCloseTo(computeStats(oracle).mean, 5);
  });

  it("3d4ro=1kh2 (reroll_once + keep-highest) matches pipeline oracle", () => {
    // Combines reroll + keep/drop: `enumerateKeepDrop` previously ignored
    // rerolls and `tryExact` fell back to noisy Monte Carlo.
    const res = computeDistributionWithMethod(parse("3d4ro=1kh2"));
    const oracle = oracleDistributionFromPipeline("3d4ro=1kh2");
    expect(res.method).toBe("exact");
    expectDistributionMatchesOracle(res.distribution, oracle, 1e-12);
  });
});

describe("Division by zero agreement between roll() and analyze()", () => {
  it("1d6/0 throws ParseError('Division by zero') in both roll() and analyze()", () => {
    expect(() => roll("1d6/0")).toThrow(ParseError);
    expect(() => roll("1d6/0")).toThrow(/division by zero/i);
    expect(() => analyzePublic("1d6/0")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/0")).toThrow(/division by zero/i);
    expect(() => computeDistribution(parse("1d6/0"))).toThrow(ParseError);
  });

  it("divisor distribution that can roll 0 (1d6/(1d2-1) and 1d6/(4d20-4)) throws ParseError('Division by zero')", () => {
    // Any divisor with P(divisor = 0) > 0 must deterministically throw
    // ParseError("Division by zero") in analyze() / computeDistribution(),
    // even when P(0) is small enough (e.g. 4d20-4 where P(0) = 1/160000) that
    // 10,000 Monte Carlo samples miss it.
    expect(() => analyzePublic("1d6/(1d2-1)")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/(1d2-1)")).toThrow(/division by zero/i);
    expect(() => analyzePublic("1d6/(4d20-4)")).toThrow(ParseError);
    expect(() => analyzePublic("1d6/(4d20-4)")).toThrow(/division by zero/i);
    expect(() => computeDistribution(parse("1d6/(4d20-4)"))).toThrow(ParseError);

    // And rolling with a seed that lands on 1d2 = 1 (so divisor = 0) throws the
    // exact same ParseError("Division by zero").
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
});

