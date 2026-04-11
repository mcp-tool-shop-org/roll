import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { computeDistribution } from "../src/analyze/distribution.js";
import { computeStats, probabilityAtLeast } from "../src/analyze/stats.js";

function analyze(expr: string) {
  const ast = parse(expr);
  const dist = computeDistribution(ast);
  return { dist, stats: computeStats(dist) };
}

describe("distribution", () => {
  it("constant has single-point distribution", () => {
    const { dist } = analyze("5");
    expect(dist.size).toBe(1);
    expect(dist.get(5)).toBe(1);
  });

  it("1d6 has uniform distribution", () => {
    const { dist, stats } = analyze("1d6");
    expect(dist.size).toBe(6);
    for (let i = 1; i <= 6; i++) {
      expect(dist.get(i)).toBeCloseTo(1 / 6, 10);
    }
    expect(stats.mean).toBeCloseTo(3.5, 10);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(6);
  });

  it("2d6 has triangular distribution peaking at 7", () => {
    const { dist, stats } = analyze("2d6");
    expect(stats.mean).toBeCloseTo(7, 10);
    expect(stats.mode).toBe(7);
    expect(dist.get(7)).toBeCloseTo(6 / 36, 10);
    expect(dist.get(2)).toBeCloseTo(1 / 36, 10);
    expect(dist.get(12)).toBeCloseTo(1 / 36, 10);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(12);
  });

  it("2d6+3 shifts the distribution", () => {
    const { stats } = analyze("2d6+3");
    expect(stats.mean).toBeCloseTo(10, 10);
    expect(stats.min).toBe(5);
    expect(stats.max).toBe(15);
  });

  it("2d6*2 scales the distribution", () => {
    const { stats } = analyze("2d6*2");
    expect(stats.mean).toBeCloseTo(14, 10);
    expect(stats.min).toBe(4);
    expect(stats.max).toBe(24);
  });

  it("1d6-1d6 can be negative", () => {
    const { stats } = analyze("1d6-1d6");
    expect(stats.mean).toBeCloseTo(0, 10);
    expect(stats.min).toBe(-5);
    expect(stats.max).toBe(5);
  });

  it("4d6dl1 (D&D ability score) has known mean ~12.24", () => {
    const { stats } = analyze("4d6dl1");
    expect(stats.mean).toBeCloseTo(12.2446, 2);
    expect(stats.min).toBe(3);
    expect(stats.max).toBe(18);
  });

  it("4d6kh3 equals 4d6dl1", () => {
    const kh = analyze("4d6kh3");
    const dl = analyze("4d6dl1");
    expect(kh.stats.mean).toBeCloseTo(dl.stats.mean, 10);
    expect(kh.stats.min).toBe(dl.stats.min);
    expect(kh.stats.max).toBe(dl.stats.max);
  });

  it("d% has uniform 1-100", () => {
    const { dist, stats } = analyze("d%");
    expect(dist.size).toBe(100);
    expect(stats.mean).toBeCloseTo(50.5, 10);
  });

  it("4dF has range -4 to +4", () => {
    const { stats } = analyze("4dF");
    expect(stats.mean).toBeCloseTo(0, 10);
    expect(stats.min).toBe(-4);
    expect(stats.max).toBe(4);
  });

  it("exploding 1d6! has mean > 3.5", () => {
    const { stats } = analyze("1d6!");
    expect(stats.mean).toBeGreaterThan(3.5);
    expect(stats.max).toBeGreaterThan(6);
  });
});

describe("stats", () => {
  it("computes correct percentiles for 2d6", () => {
    const { stats } = analyze("2d6");
    expect(stats.percentiles[50]).toBe(7); // median
    expect(stats.percentiles[25]).toBeLessThanOrEqual(5);
    expect(stats.percentiles[75]).toBeGreaterThanOrEqual(9);
  });

  it("entropy of 1d6 equals log2(6)", () => {
    const { stats } = analyze("1d6");
    expect(stats.entropy).toBeCloseTo(Math.log2(6), 5);
  });

  it("entropy of constant is 0", () => {
    const { stats } = analyze("5");
    expect(stats.entropy).toBe(0);
  });
});

describe("probabilityAtLeast", () => {
  it("P(2d6 >= 7) is 58.33%", () => {
    const { dist } = analyze("2d6");
    const p = probabilityAtLeast(dist, 7);
    expect(p).toBeCloseTo(21 / 36, 5);
  });

  it("P(1d20 >= 15) is 30%", () => {
    const { dist } = analyze("1d20");
    const p = probabilityAtLeast(dist, 15);
    expect(p).toBeCloseTo(0.3, 10);
  });

  it("P(2d6 >= 2) is 100%", () => {
    const { dist } = analyze("2d6");
    expect(probabilityAtLeast(dist, 2)).toBeCloseTo(1, 10);
  });

  it("P(2d6 >= 13) is 0%", () => {
    const { dist } = analyze("2d6");
    expect(probabilityAtLeast(dist, 13)).toBeCloseTo(0, 10);
  });
});
