import { describe, it, expect } from "vitest";
import { seededRng } from "../src/engine/random.js";
import {
  stageRoll,
  stageReroll,
  stageMinMax,
  stageExplode,
  stageKeepDrop,
  stageSort,
  stageCriticalMark,
  stageTotal,
  runPipeline,
  matchesCompare,
  countMatchingFaces,
  estimateDiceNodeRolls,
  estimateAstAnalyzeRolls,
  MAX_EXPLOSIONS,
  MAX_EXPLOSION_ROLLS,
  MAX_REROLLS,
  type PipelineDie,
} from "../src/engine/pipeline.js";
import { parse, ParseError } from "../src/parser/parser.js";
import { roll } from "../src/index.js";
import type { ComparePoint, DiceModifier, DiceNode, DiceSides } from "../src/parser/ast.js";

// ─── matchesCompare ──────────────────────────────────────────────────────────

describe("matchesCompare", () => {
  it("tests equality", () => {
    expect(matchesCompare(5, { operator: "=", value: 5 })).toBe(true);
    expect(matchesCompare(4, { operator: "=", value: 5 })).toBe(false);
  });

  it("tests greater than", () => {
    expect(matchesCompare(6, { operator: ">", value: 5 })).toBe(true);
    expect(matchesCompare(5, { operator: ">", value: 5 })).toBe(false);
  });

  it("tests greater than or equal", () => {
    expect(matchesCompare(5, { operator: ">=", value: 5 })).toBe(true);
    expect(matchesCompare(4, { operator: ">=", value: 5 })).toBe(false);
  });

  it("tests less than", () => {
    expect(matchesCompare(4, { operator: "<", value: 5 })).toBe(true);
    expect(matchesCompare(5, { operator: "<", value: 5 })).toBe(false);
  });

  it("tests less than or equal", () => {
    expect(matchesCompare(5, { operator: "<=", value: 5 })).toBe(true);
    expect(matchesCompare(6, { operator: "<=", value: 5 })).toBe(false);
  });
});

// ─── Stage 1: Roll ───────────────────────────────────────────────────────────

describe("stageRoll", () => {
  it("produces correct count of dice", () => {
    const dice = stageRoll(4, 6, seededRng(42));
    expect(dice).toHaveLength(4);
    dice.forEach((d) => {
      expect(d.kept).toBe(true);
      expect(d.exploded).toBe(false);
      expect(d.value).toBeGreaterThanOrEqual(1);
      expect(d.value).toBeLessThanOrEqual(6);
    });
  });

  it("handles Fate dice", () => {
    const dice = stageRoll(4, "F", seededRng(42));
    expect(dice).toHaveLength(4);
    dice.forEach((d) => {
      expect(d.value).toBeGreaterThanOrEqual(-1);
      expect(d.value).toBeLessThanOrEqual(1);
    });
  });
});

// ─── Stage 2: Reroll ─────────────────────────────────────────────────────────

describe("stageReroll", () => {
  it("reroll unlimited removes matching values", () => {
    const rng = seededRng(42);
    const dice = stageRoll(10, 6, rng);
    const mods: DiceModifier[] = [
      { kind: "reroll", compare: { operator: "<", value: 3 } },
    ];
    stageReroll(dice, mods, 6, rng);
    // After unlimited reroll of <3, no kept die should be 1 or 2
    dice.filter((d) => d.kept).forEach((d) => {
      expect(d.value).toBeGreaterThanOrEqual(3);
    });
  });

  it("reroll once may still have matching values", () => {
    // With enough dice and seeds, reroll-once can still end on a match
    let foundMatch = false;
    for (let seed = 0; seed < 200; seed++) {
      const rng = seededRng(seed);
      const dice = stageRoll(20, 6, rng);
      const mods: DiceModifier[] = [
        { kind: "reroll_once", compare: { operator: "=", value: 1 } },
      ];
      stageReroll(dice, mods, 6, rng);
      if (dice.some((d) => d.kept && d.value === 1)) {
        foundMatch = true;
        break;
      }
    }
    expect(foundMatch).toBe(true);
  });

  it("tracks rerolledFrom", () => {
    // Force a die that will need rerolling
    const rng = seededRng(42);
    const dice = stageRoll(20, 6, rng);
    const mods: DiceModifier[] = [
      { kind: "reroll", compare: { operator: "<=", value: 3 } },
    ];
    stageReroll(dice, mods, 6, rng);
    // At least some dice should have rerolledFrom set
    const rerolled = dice.filter((d) => d.rerolledFrom !== undefined);
    expect(rerolled.length).toBeGreaterThan(0);
  });
});

// ─── Stage 3: Min/Max ────────────────────────────────────────────────────────

describe("stageMinMax", () => {
  it("applies minimum floor", () => {
    const dice: PipelineDie[] = [
      { value: 1, kept: true, exploded: false },
      { value: 2, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
    ];
    stageMinMax(dice, [{ kind: "min", value: 3 }]);
    expect(dice.map((d) => d.value)).toEqual([3, 3, 5]);
  });

  it("applies maximum ceiling", () => {
    const dice: PipelineDie[] = [
      { value: 1, kept: true, exploded: false },
      { value: 4, kept: true, exploded: false },
      { value: 6, kept: true, exploded: false },
    ];
    stageMinMax(dice, [{ kind: "max", value: 4 }]);
    expect(dice.map((d) => d.value)).toEqual([1, 4, 4]);
  });

  it("skips dropped dice", () => {
    const dice: PipelineDie[] = [
      { value: 1, kept: false, exploded: false },
      { value: 5, kept: true, exploded: false },
    ];
    stageMinMax(dice, [{ kind: "min", value: 3 }]);
    expect(dice[0].value).toBe(1); // dropped, not modified
    expect(dice[1].value).toBe(5);
  });
});

// ─── Stage 4: Explode ────────────────────────────────────────────────────────

describe("stageExplode", () => {
  it("standard exploding adds dice", () => {
    let foundExplosion = false;
    for (let seed = 0; seed < 200; seed++) {
      const rng = seededRng(seed);
      const dice = stageRoll(1, 6, rng);
      stageExplode(dice, [{ kind: "explode" }], 6, rng);
      if (dice.length > 1) {
        foundExplosion = true;
        expect(dice.slice(1).every((d) => d.exploded)).toBe(true);
        break;
      }
    }
    expect(foundExplosion).toBe(true);
  });

  it("compounding sums into same die", () => {
    let foundCompound = false;
    for (let seed = 0; seed < 200; seed++) {
      const rng = seededRng(seed);
      const dice = stageRoll(1, 6, rng);
      const originalValue = dice[0].value;
      stageExplode(dice, [{ kind: "compound" }], 6, rng);
      if (dice[0].value > originalValue) {
        foundCompound = true;
        expect(dice).toHaveLength(1); // No extra dice added
        expect(dice[0].exploded).toBe(true);
        break;
      }
    }
    expect(foundCompound).toBe(true);
  });

  it("penetrating adds dice with reduced values", () => {
    let foundPenetration = false;
    for (let seed = 0; seed < 200; seed++) {
      const rng = seededRng(seed);
      const dice = stageRoll(1, 6, rng);
      stageExplode(dice, [{ kind: "penetrate" }], 6, rng);
      if (dice.length > 1) {
        foundPenetration = true;
        // Penetrating dice values should be reduced (max d6-1 = 5)
        for (let i = 1; i < dice.length; i++) {
          expect(dice[i].value).toBeLessThanOrEqual(5);
          expect(dice[i].value).toBeGreaterThanOrEqual(1);
        }
        break;
      }
    }
    expect(foundPenetration).toBe(true);
  });

  it("does not explode Fate dice", () => {
    const rng = seededRng(42);
    const dice = stageRoll(4, "F", rng);
    stageExplode(dice, [{ kind: "explode" }], "F", rng);
    expect(dice).toHaveLength(4);
  });

  it("respects custom threshold", () => {
    let foundExplosion = false;
    for (let seed = 0; seed < 200; seed++) {
      const rng = seededRng(seed);
      const dice = stageRoll(1, 6, rng);
      stageExplode(
        dice,
        [{ kind: "explode", compare: { operator: ">=", value: 4 } }],
        6,
        rng,
      );
      if (dice.length > 1) {
        foundExplosion = true;
        break;
      }
    }
    expect(foundExplosion).toBe(true);
  });
});

// ─── Stage 5: Keep/Drop ──────────────────────────────────────────────────────

describe("stageKeepDrop", () => {
  it("keep highest", () => {
    const dice: PipelineDie[] = [
      { value: 2, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
      { value: 3, kept: true, exploded: false },
      { value: 6, kept: true, exploded: false },
    ];
    stageKeepDrop(dice, [{ kind: "kh", value: 2 }]);
    const kept = dice.filter((d) => d.kept).map((d) => d.value);
    expect(kept.sort()).toEqual([5, 6]);
  });

  it("drop lowest", () => {
    const dice: PipelineDie[] = [
      { value: 2, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
      { value: 3, kept: true, exploded: false },
    ];
    stageKeepDrop(dice, [{ kind: "dl", value: 1 }]);
    const dropped = dice.filter((d) => !d.kept).map((d) => d.value);
    expect(dropped).toEqual([2]);
  });
});

// ─── Stage 6: Sort ───────────────────────────────────────────────────────────

describe("stageSort", () => {
  it("sorts ascending", () => {
    const dice: PipelineDie[] = [
      { value: 5, kept: true, exploded: false },
      { value: 2, kept: true, exploded: false },
      { value: 4, kept: true, exploded: false },
    ];
    stageSort(dice, [{ kind: "sort_asc" }]);
    expect(dice.map((d) => d.value)).toEqual([2, 4, 5]);
  });

  it("sorts descending", () => {
    const dice: PipelineDie[] = [
      { value: 2, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
      { value: 4, kept: true, exploded: false },
    ];
    stageSort(dice, [{ kind: "sort_desc" }]);
    expect(dice.map((d) => d.value)).toEqual([5, 4, 2]);
  });
});

// ─── Stage 7: Critical Mark ──────────────────────────────────────────────────

describe("stageCriticalMark", () => {
  it("marks successes", () => {
    const dice: PipelineDie[] = [
      { value: 6, kept: true, exploded: false },
      { value: 3, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
    ];
    stageCriticalMark(dice, [
      { kind: "cs_count", compare: { operator: ">=", value: 5 } },
    ]);
    expect(dice[0].critical).toBe("success");
    expect(dice[1].critical).toBeUndefined();
    expect(dice[2].critical).toBe("success");
  });

  it("marks failures", () => {
    const dice: PipelineDie[] = [
      { value: 1, kept: true, exploded: false },
      { value: 3, kept: true, exploded: false },
    ];
    stageCriticalMark(dice, [
      { kind: "cf_count", compare: { operator: "<=", value: 1 } },
    ]);
    expect(dice[0].critical).toBe("failure");
    expect(dice[1].critical).toBeUndefined();
  });
});

// ─── Stage 8: Total ──────────────────────────────────────────────────────────

describe("stageTotal", () => {
  it("sums kept dice in sum mode", () => {
    const dice: PipelineDie[] = [
      { value: 3, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
      { value: 2, kept: false, exploded: false },
    ];
    expect(stageTotal(dice, "sum", [])).toBe(8);
  });

  it("counts successes in success_count mode", () => {
    const dice: PipelineDie[] = [
      { value: 6, kept: true, exploded: false },
      { value: 3, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
      { value: 1, kept: true, exploded: false },
    ];
    const mods: DiceModifier[] = [
      { kind: "cs_count", compare: { operator: ">=", value: 5 } },
    ];
    expect(stageTotal(dice, "success_count", mods)).toBe(2);
  });

  it("subtracts failures from success count", () => {
    const dice: PipelineDie[] = [
      { value: 6, kept: true, exploded: false },
      { value: 5, kept: true, exploded: false },
      { value: 1, kept: true, exploded: false },
      { value: 2, kept: true, exploded: false },
    ];
    const mods: DiceModifier[] = [
      { kind: "cs_count", compare: { operator: ">=", value: 5 } },
      { kind: "cf_count", compare: { operator: "<=", value: 1 } },
    ];
    // 2 successes (6, 5) - 1 failure (1) = net 1
    expect(stageTotal(dice, "success_count", mods)).toBe(1);
  });
});

// ─── Full Pipeline ───────────────────────────────────────────────────────────

describe("runPipeline", () => {
  it("basic roll produces correct count and range", () => {
    const result = runPipeline(3, 6, [], seededRng(42));
    expect(result.dice).toHaveLength(3);
    expect(result.resultMode).toBe("sum");
    result.dice.forEach((d) => {
      expect(d.value).toBeGreaterThanOrEqual(1);
      expect(d.value).toBeLessThanOrEqual(6);
    });
  });

  it("complex modifier chain works end-to-end", () => {
    // 8d6r<2min2kh5sa — reroll 1s, floor at 2, keep highest 5, sort ascending
    const mods: DiceModifier[] = [
      { kind: "reroll", compare: { operator: "<", value: 2 } },
      { kind: "min", value: 2 },
      { kind: "kh", value: 5 },
      { kind: "sort_asc" },
    ];
    const result = runPipeline(8, 6, mods, seededRng(42));
    const kept = result.dice.filter((d) => d.kept);
    expect(kept).toHaveLength(5);
    // All kept values >= 2 (min floor)
    kept.forEach((d) => expect(d.value).toBeGreaterThanOrEqual(2));
    // Sorted ascending
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].value).toBeGreaterThanOrEqual(kept[i - 1].value);
    }
  });

  it("success counting pipeline", () => {
    const mods: DiceModifier[] = [
      { kind: "cs_count", compare: { operator: ">=", value: 5 } },
    ];
    const result = runPipeline(8, 6, mods, seededRng(42), "success_count");
    expect(result.resultMode).toBe("success_count");
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(8);
    // Total should match manually counted successes
    const manualCount = result.dice.filter(
      (d) => d.kept && d.value >= 5,
    ).length;
    expect(result.total).toBe(manualCount);
  });
});

// ─── countMatchingFaces & Roll Cost Estimation ──────────────────────────────

function bruteForceMatchingFaces(sides: DiceSides, cp: ComparePoint): number {
  const faces =
    sides === "F"
      ? [-1, 0, 1]
      : Array.from({ length: sides === "%" ? 100 : sides }, (_, i) => i + 1);
  return faces.filter((f) => matchesCompare(f, cp)).length;
}

describe("countMatchingFaces", () => {
  it("matches exact face counts across Fate ('F'), percentile ('%'), and standard 1..s dice for every operator", () => {
    const sidesCases: DiceSides[] = ["F", "%", 6];
    const ops: ComparePoint["operator"][] = ["=", ">", ">=", "<", "<="];
    const values = [-2, -1, 0, 1, 3, 6, 7, 50, 100, 101];

    for (const sides of sidesCases) {
      for (const operator of ops) {
        for (const value of values) {
          const cp: ComparePoint = { operator, value };
          expect(countMatchingFaces(sides, cp)).toBe(
            bruteForceMatchingFaces(sides, cp),
          );
        }
      }
    }

    expect(countMatchingFaces("F", { operator: "=", value: 0 })).toBe(1);
    expect(countMatchingFaces("F", { operator: ">=", value: 0 })).toBe(2);
    expect(countMatchingFaces("F", { operator: ">", value: 1 })).toBe(0);
    expect(countMatchingFaces("%", { operator: ">", value: 95 })).toBe(5);
    expect(countMatchingFaces(6, { operator: "=", value: 0 })).toBe(0);
    expect(countMatchingFaces(6, { operator: "=", value: 7 })).toBe(0);
  });
});

describe("estimateDiceNodeRolls & estimateAstAnalyzeRolls", () => {
  it("handles zero-dice and Fate dice (rerolls counted, explosions ignored on Fate)", () => {
    expect(estimateDiceNodeRolls(parse("0d6!") as DiceNode)).toEqual({
      expectedRolls: 0,
      maxRolls: 0,
      explosionModCount: 0,
    });

    const fate = estimateDiceNodeRolls(parse("4dFr=0!") as DiceNode);
    expect(fate.explosionModCount).toBe(0);
    expect(fate.maxRolls).toBe(4 + 4 * MAX_REROLLS);
    expect(fate.expectedRolls).toBeCloseTo(6, 8);
    // Engine agreement: Fate dice reroll 0s and never explode
    const rolled = roll("4dFr=0!", seededRng(11));
    expect(rolled.groups[0]!.dice).toHaveLength(4);
    expect(rolled.groups[0]!.dice.every((d) => d.value !== 0)).toBe(true);
  });

  it("models reroll and reroll_once (inactive, all-faces, standalone, and stacked)", () => {
    // Inactive reroll & reroll_once add 0 extra rolls:
    expect(estimateDiceNodeRolls(parse("2d6r>6ro<1") as DiceNode)).toEqual({
      expectedRolls: 2,
      maxRolls: 2,
      explosionModCount: 0,
    });

    // All-faces unlimited reroll hits MAX_REROLLS on every die:
    expect(estimateDiceNodeRolls(parse("2d6r>=1") as DiceNode)).toEqual({
      expectedRolls: 2 + 2 * MAX_REROLLS,
      maxRolls: 2 + 2 * MAX_REROLLS,
      explosionModCount: 0,
    });

    // Standalone reroll_once uses exact face probability q = 1/6:
    const roOnly = estimateDiceNodeRolls(parse("6d6ro=1") as DiceNode);
    expect(roOnly.expectedRolls).toBeCloseTo(7, 10);
    expect(roOnly.maxRolls).toBe(12);

    // Stacked rerolls + reroll_once upper-bound subsequent entry probability by 1:
    const stacked = estimateDiceNodeRolls(parse("2d6r=1r=2ro=3") as DiceNode);
    expect(stacked.maxRolls).toBe(2 + 2 * MAX_REROLLS + 2 * MAX_REROLLS + 2);
    expect(stacked.expectedRolls).toBeGreaterThan(4);
  });

  it("models out-of-range thresholds triggered by Stage 3 min/max clamping and compounding", () => {
    // Below-1 thresholds via `max0`: `<`, `<=`, and `=0` each trigger one guaranteed explosion per die,
    // matching actual `roll()` behaviour when bonus rolls land in 1..6.
    for (const expr of ["2d6max0!<1", "2d6max0!<=0", "2d6max0!=0"]) {
      const est = estimateDiceNodeRolls(parse(expr) as DiceNode);
      expect(est).toEqual({
        expectedRolls: 4,
        maxRolls: 4,
        explosionModCount: 1,
      });
      const res = roll(expr, () => 3);
      expect(res.groups[0]!.dice).toHaveLength(4); // 2 initial (clamped to 0) + 2 exploded (3)
      expect(res.total).toBe(6);
    }

    // `max0` with unreachable `!=7` does not trigger out-of-range match:
    expect(estimateDiceNodeRolls(parse("2d6max0!=7") as DiceNode)).toEqual({
      expectedRolls: 2,
      maxRolls: 2,
      explosionModCount: 1,
    });
    expect(roll("2d6max0!=7", () => 3).total).toBe(0);

    // Above-maxSide thresholds via `min10`: `>`, `>=`, and `=10` across explode and compound:
    for (const expr of ["2d6min10!>6", "2d6min10!=10"]) {
      const est = estimateDiceNodeRolls(parse(expr) as DiceNode);
      expect(est).toEqual({
        expectedRolls: 4,
        maxRolls: 4,
        explosionModCount: 1,
      });
      const res = roll(expr, () => 4);
      expect(res.groups[0]!.dice).toHaveLength(4);
      expect(res.total).toBe(28); // 10 + 10 + 4 + 4
    }

    const compOut = estimateDiceNodeRolls(parse("2d6min10!!>=7") as DiceNode);
    expect(compOut).toEqual({
      expectedRolls: 4,
      maxRolls: 4,
      explosionModCount: 1,
    });
    expect(roll("2d6min10!!>=7", () => 4).total).toBe(28); // (10+4) + (10+4)

    // Compounding raises die values above maxSide so a subsequent `penetrate` (`!p>6`) can fire once:
    const compThenPen = estimateDiceNodeRolls(parse("1d6!!=6!p>6") as DiceNode);
    expect(compThenPen.explosionModCount).toBe(2);
    expect(compThenPen.maxRolls).toBe(1 + MAX_EXPLOSIONS + 1); // 102
    const seq = [6, 3, 4];
    let idx = 0;
    const seqRes = roll("1d6!!=6!p>6", () => seq[idx++] ?? 1);
    expect(seqRes.groups[0]!.dice.map((d) => d.value)).toEqual([9, 3]); // 6+3=9 (>6), then raw 4 -> pen 3
    expect(seqRes.total).toBe(12);

    // Unreachable thresholds without min/max or active compounding add 0 bonus rolls:
    expect(estimateDiceNodeRolls(parse("1d6!>6!!>6!p>6") as DiceNode)).toEqual({
      expectedRolls: 1,
      maxRolls: 1,
      explosionModCount: 3,
    });
    expect(roll("1d6!>6!!>6!p>6", () => 6).total).toBe(6);
  });

  it("models penetrate (partial and all-faces) and scores explosionModCount >= 2 with maxRolls in estimateAstAnalyzeRolls", () => {
    const penPartial = estimateDiceNodeRolls(parse("1d6!p") as DiceNode);
    expect(penPartial.expectedRolls).toBeCloseTo(1.2, 8);
    expect(penPartial.maxRolls).toBe(1 + MAX_EXPLOSIONS);
    expect(penPartial.explosionModCount).toBe(1);

    const penAll = estimateDiceNodeRolls(parse("1d6min6!p>=1") as DiceNode);
    expect(penAll).toEqual({
      expectedRolls: 1 + MAX_EXPLOSIONS,
      maxRolls: 1 + MAX_EXPLOSIONS,
      explosionModCount: 1,
    });

    // Single explosion modifier uses Math.ceil(expectedRolls), whereas >= 2 uses worst-case maxRolls:
    expect(estimateAstAnalyzeRolls(parse("42"))).toBe(0);
    expect(estimateAstAnalyzeRolls(parse("1d6!"))).toBe(2);
    expect(estimateAstAnalyzeRolls(parse("1d6!>5!>5"))).toBe(
      1 + MAX_EXPLOSIONS + (1 + MAX_EXPLOSIONS) * MAX_EXPLOSIONS,
    ); // 10,201
    expect(estimateAstAnalyzeRolls(parse("-2d6!>=1!>=1"))).toBe(20_402);
    expect(estimateAstAnalyzeRolls(parse("2d6 + 3d6"))).toBe(5);
  });
});

describe("stageExplode pre-check and MAX_EXPLOSION_ROLLS caps across explode, compound, and penetrate", () => {
  it("enforces guaranteed-blow-up pre-check on explode, compound, and penetrate while allowing bounded pools", () => {
    // Single modifier with >100 all-matching dice exceeds MAX_EXPLOSION_ROLLS = 10,000 immediately:
    expect(() => roll("101d6!>=1")).toThrow(ParseError);
    expect(() => roll("101d6!!>=1")).toThrow(ParseError);
    expect(() => roll("101d6!p>=1")).toThrow(ParseError);

    // Stacked penetrate + penetrate (`1d6!p>=1!p>=1` -> 10,200 bonus rolls) trips pre-check on mod 2:
    expect(() => roll("1d6!p>=1!p>=1")).toThrow(/explosion roll limit/i);

    // Bounded all-faces compound (`2d6!!>=1` -> 200 bonus rolls <= 10,000) succeeds and sums 101 rolls per die:
    const boundedComp = roll("2d6!!>=1", () => 1);
    expect(boundedComp.total).toBe(202);
    expect(boundedComp.groups[0]!.dice).toHaveLength(2);

    // Stage 3 `max0` clamps dice below 1..3 so `!>=1` never fires even when stacked (`guaranteedBonus = 0`):
    expect(roll("1d3max0!>=1!p>=1", () => 2).total).toBe(0);
    expect(roll("1d3max0!>=1!!>=1", () => 2).total).toBe(0);
  });

  it("enforces live MAX_EXPLOSION_ROLLS cap in compound and penetrate loops and skips unkept dice", () => {
    // 11 compound modifiers on 10 dice (59 chars): pre-check breaks after first compound
    // (10 * 100 = 1,000 <= 10,000), then live compound loop caps at MAX_EXPLOSION_ROLLS = 10,000:
    expect(() => roll("10d2" + "!!>=1".repeat(11), () => 2)).toThrow(ParseError);
    expect(() => roll("10d2" + "!!>=1".repeat(11), () => 2)).toThrow(
      new RegExp(`Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`),
    );

    // Stochastic penetrate chain (`1d3!p>=2!p>=2`: countMatchingFaces = 2 < 3 so pre-check skips;
    // raw 3 penetrates to 2 which still matches `>=2`, expanding 1 -> 101 -> 10,201 rolls):
    expect(() => roll("1d3!p>=2!p>=2", () => 3)).toThrow(ParseError);
    expect(() => roll("1d3!p>=2!p>=2", () => 3)).toThrow(
      new RegExp(`Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`),
    );

    // Dropped dice (`kept: false`) are ignored by pre-check and all three explosion loops:
    const dice: PipelineDie[] = [
      { value: 6, kept: false, exploded: false },
      { value: 1, kept: true, exploded: false },
    ];
    stageExplode(
      dice,
      [
        { kind: "explode", compare: { operator: ">=", value: 1 } },
        { kind: "compound" },
        { kind: "penetrate" },
      ],
      6,
      () => 1,
    );
    expect(dice[0]).toEqual({ value: 6, kept: false, exploded: false });
    expect(dice.filter((d) => d.kept)).toHaveLength(1 + MAX_EXPLOSIONS);
  });
});
