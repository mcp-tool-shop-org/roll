import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { evaluate } from "../src/engine/roller.js";
import { seededRng } from "../src/engine/random.js";

function roll(expr: string, seed = 42) {
  const ast = parse(expr);
  const rng = seededRng(seed);
  return evaluate(ast, rng);
}

describe("roller", () => {
  it("rolls a constant", () => {
    const result = roll("5");
    expect(result.total).toBe(5);
    expect(result.groups).toEqual([]);
  });

  it("rolls basic dice deterministically", () => {
    const r1 = roll("2d6", 42);
    const r2 = roll("2d6", 42);
    expect(r1.total).toBe(r2.total);
  });

  it("rolls dice in correct range", () => {
    // Run many rolls with different seeds to check range
    for (let seed = 0; seed < 100; seed++) {
      const result = roll("1d6", seed);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeLessThanOrEqual(6);
    }
  });

  it("rolls d20 in correct range", () => {
    for (let seed = 0; seed < 100; seed++) {
      const result = roll("1d20", seed);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeLessThanOrEqual(20);
    }
  });

  it("adds constant correctly", () => {
    const base = roll("1d6", 42);
    const withAdd = roll("1d6+5", 42);
    expect(withAdd.total).toBe(base.total + 5);
  });

  it("multiplies correctly", () => {
    const base = roll("2d6", 42);
    const multiplied = roll("2d6*10", 42);
    expect(multiplied.total).toBe(base.total * 10);
  });

  it("handles parenthesized expressions", () => {
    const result = roll("(1d6+2)*3", 42);
    const base = roll("1d6", 42);
    expect(result.total).toBe((base.total + 2) * 3);
  });

  it("handles keep highest", () => {
    const result = roll("4d6kh3", 42);
    const group = result.groups[0];
    const keptCount = group.dice.filter((d) => d.kept).length;
    expect(keptCount).toBe(3);
    // Kept dice should be the highest 3
    const keptValues = group.dice.filter((d) => d.kept).map((d) => d.value);
    const droppedValues = group.dice
      .filter((d) => !d.kept)
      .map((d) => d.value);
    expect(Math.min(...keptValues)).toBeGreaterThanOrEqual(
      Math.max(...droppedValues),
    );
  });

  it("handles drop lowest", () => {
    const result = roll("4d6dl1", 42);
    const group = result.groups[0];
    const droppedCount = group.dice.filter((d) => !d.kept).length;
    expect(droppedCount).toBe(1);
    // Dropped die should be the lowest
    const keptValues = group.dice.filter((d) => d.kept).map((d) => d.value);
    const droppedValues = group.dice
      .filter((d) => !d.kept)
      .map((d) => d.value);
    expect(droppedValues[0]).toBeLessThanOrEqual(Math.min(...keptValues));
  });

  it("kh3 and dl1 on 4d6 produce same total", () => {
    const kh = roll("4d6kh3", 42);
    const dl = roll("4d6dl1", 42);
    expect(kh.total).toBe(dl.total);
  });

  it("handles percentile dice", () => {
    for (let seed = 0; seed < 50; seed++) {
      const result = roll("d%", seed);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeLessThanOrEqual(100);
    }
  });

  it("handles fate dice range", () => {
    for (let seed = 0; seed < 100; seed++) {
      const result = roll("4dF", seed);
      expect(result.total).toBeGreaterThanOrEqual(-4);
      expect(result.total).toBeLessThanOrEqual(4);
    }
  });

  it("handles exploding dice — total can exceed max face", () => {
    // With enough seeds, some should explode
    let foundExplosion = false;
    for (let seed = 0; seed < 200; seed++) {
      const result = roll("1d6!", seed);
      if (result.total > 6) {
        foundExplosion = true;
        break;
      }
    }
    expect(foundExplosion).toBe(true);
  });

  it("handles chained expressions", () => {
    const result = roll("1d6+1d4+3", 42);
    expect(result.groups).toHaveLength(2);
    expect(result.total).toBe(result.groups[0].total + result.groups[1].total + 3);
  });

  it("handles unary minus", () => {
    const result = roll("-5");
    expect(result.total).toBe(-5);
  });

  it("handles subtraction", () => {
    const base = roll("1d6", 42);
    const sub = roll("1d6-2", 42);
    expect(sub.total).toBe(base.total - 2);
  });

  it("handles floor division", () => {
    const result = roll("7/2");
    expect(result.total).toBe(3);
  });

  it("division by zero throws instead of silently returning 0", () => {
    expect(() => roll("5/0")).toThrow(/division by zero/i);
  });

  it("records dice group details", () => {
    const result = roll("2d6+3", 42);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].dice).toHaveLength(2);
    expect(result.groups[0].dice.every((d) => d.kept)).toBe(true);
  });

  // ─── V2 Features ──────────────────────────────────────────────────────────

  it("handles reroll — no 1s remain with r=1", () => {
    for (let seed = 0; seed < 50; seed++) {
      const result = roll("4d6r=1", seed);
      const keptValues = result.groups[0].dice
        .filter((d) => d.kept)
        .map((d) => d.value);
      keptValues.forEach((v) => expect(v).toBeGreaterThanOrEqual(2));
    }
  });

  it("handles reroll with less-than", () => {
    for (let seed = 0; seed < 50; seed++) {
      const result = roll("4d6r<3", seed);
      const keptValues = result.groups[0].dice
        .filter((d) => d.kept)
        .map((d) => d.value);
      keptValues.forEach((v) => expect(v).toBeGreaterThanOrEqual(3));
    }
  });

  it("handles reroll once — may still have 1s", () => {
    let found1 = false;
    for (let seed = 0; seed < 500; seed++) {
      const result = roll("10d6ro=1", seed);
      if (result.groups[0].dice.some((d) => d.kept && d.value === 1)) {
        found1 = true;
        break;
      }
    }
    expect(found1).toBe(true);
  });

  it("handles min floor", () => {
    for (let seed = 0; seed < 50; seed++) {
      const result = roll("4d6min3", seed);
      const values = result.groups[0].dice.map((d) => d.value);
      values.forEach((v) => expect(v).toBeGreaterThanOrEqual(3));
    }
  });

  it("handles max ceiling", () => {
    for (let seed = 0; seed < 50; seed++) {
      const result = roll("4d6max4", seed);
      const values = result.groups[0].dice.map((d) => d.value);
      values.forEach((v) => expect(v).toBeLessThanOrEqual(4));
    }
  });

  it("handles compounding dice — total can exceed max but only 1 die", () => {
    let foundCompound = false;
    for (let seed = 0; seed < 200; seed++) {
      const result = roll("1d6!!", seed);
      if (result.total > 6) {
        foundCompound = true;
        // Compounding: only 1 die in the group (value summed into it)
        expect(result.groups[0].dice).toHaveLength(1);
        break;
      }
    }
    expect(foundCompound).toBe(true);
  });

  it("handles penetrating dice — explosions have reduced values", () => {
    let foundPenetrate = false;
    for (let seed = 0; seed < 200; seed++) {
      const result = roll("1d6!p", seed);
      const dice = result.groups[0].dice;
      if (dice.length > 1) {
        foundPenetrate = true;
        // Penetrating: extra dice max value is 5 (d6-1)
        for (let i = 1; i < dice.length; i++) {
          expect(dice[i].value).toBeLessThanOrEqual(5);
        }
        break;
      }
    }
    expect(foundPenetrate).toBe(true);
  });

  it("handles success counting: 8d6cs>=5", () => {
    const result = roll("8d6cs>=5", 42);
    const group = result.groups[0];
    expect(group.resultMode).toBe("success_count");
    // Total = count of dice >= 5
    const manualCount = group.dice.filter((d) => d.kept && d.value >= 5).length;
    expect(group.total).toBe(manualCount);
    expect(result.total).toBe(manualCount);
  });

  it("handles success+failure counting: 8d6cs>=5cf<=1", () => {
    const result = roll("8d6cs>=5cf<=1", 42);
    const group = result.groups[0];
    const successes = group.dice.filter((d) => d.kept && d.value >= 5).length;
    const failures = group.dice.filter((d) => d.kept && d.value <= 1).length;
    expect(group.total).toBe(successes - failures);
  });

  it("success counting with arithmetic: 8d6cs>=5+2", () => {
    const result = roll("8d6cs>=5+2", 42);
    const group = result.groups[0];
    const successes = group.dice.filter((d) => d.kept && d.value >= 5).length;
    expect(result.total).toBe(successes + 2);
  });

  it("handles sort ascending", () => {
    const result = roll("6d6sa", 42);
    const kept = result.groups[0].dice.filter((d) => d.kept);
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].value).toBeGreaterThanOrEqual(kept[i - 1].value);
    }
  });

  it("handles sort descending", () => {
    const result = roll("6d6sd", 42);
    const kept = result.groups[0].dice.filter((d) => d.kept);
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].value).toBeLessThanOrEqual(kept[i - 1].value);
    }
  });

  it("handles complex V2 chain: 4d6r<2min2kh3", () => {
    for (let seed = 0; seed < 50; seed++) {
      const result = roll("4d6r<2min2kh3", seed);
      const kept = result.groups[0].dice.filter((d) => d.kept);
      expect(kept).toHaveLength(3);
      kept.forEach((d) => expect(d.value).toBeGreaterThanOrEqual(2));
    }
  });

  it("handles exploding with >= threshold", () => {
    let foundExplosion = false;
    for (let seed = 0; seed < 200; seed++) {
      const result = roll("1d6!>=5", seed);
      if (result.total > 6) {
        foundExplosion = true;
        break;
      }
    }
    expect(foundExplosion).toBe(true);
  });

  it("resultMode defaults to sum for V1 expressions", () => {
    const result = roll("4d6kh3", 42);
    expect(result.groups[0].resultMode).toBe("sum");
  });

  it("WoD pool: 8d10cs>=8", () => {
    const result = roll("8d10cs>=8", 42);
    expect(result.groups[0].resultMode).toBe("success_count");
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(8);
  });

  it("Shadowrun pool: 12d6cs>=5cf<=1", () => {
    const result = roll("12d6cs>=5cf<=1", 42);
    expect(result.groups[0].resultMode).toBe("success_count");
  });
});
