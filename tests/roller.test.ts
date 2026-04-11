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

  it("division by zero returns 0", () => {
    const result = roll("5/0");
    expect(result.total).toBe(0);
  });

  it("records dice group details", () => {
    const result = roll("2d6+3", 42);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].dice).toHaveLength(2);
    expect(result.groups[0].dice.every((d) => d.kept)).toBe(true);
  });
});
