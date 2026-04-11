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
  type PipelineDie,
} from "../src/engine/pipeline.js";
import type { DiceModifier } from "../src/parser/ast.js";

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
