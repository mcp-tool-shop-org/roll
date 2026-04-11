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

// ─── V2 Distribution Strategies ──────────────────────────────────────────────

describe("reroll distribution", () => {
  it("1d6r=1 has no probability on face 1", () => {
    const { dist, stats } = analyze("1d6r=1");
    expect(dist.get(1) ?? 0).toBeCloseTo(0, 10);
    // Mean shifts up: faces 2-6 each have p=1/5
    expect(stats.mean).toBeCloseTo(4, 5);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(6);
  });

  it("1d6r<3 has no probability on faces 1 and 2", () => {
    const { dist, stats } = analyze("1d6r<3");
    expect(dist.get(1) ?? 0).toBeCloseTo(0, 10);
    expect(dist.get(2) ?? 0).toBeCloseTo(0, 10);
    // Remaining 4 faces each have p=1/4
    expect(dist.get(3)).toBeCloseTo(0.25, 5);
    expect(stats.mean).toBeCloseTo(4.5, 5);
  });

  it("2d6r=1 has higher mean than 2d6", () => {
    const plain = analyze("2d6");
    const rerolled = analyze("2d6r=1");
    expect(rerolled.stats.mean).toBeGreaterThan(plain.stats.mean);
    expect(rerolled.stats.min).toBe(4); // each die min is 2, so 2+2=4
  });

  it("1d6ro=1 still has probability on face 1 (reroll once)", () => {
    const { dist } = analyze("1d6ro=1");
    // P(end on 1) = P(roll 1) * P(reroll to 1) = 1/6 * 1/6 = 1/36
    expect(dist.get(1)).toBeCloseTo(1 / 36, 5);
    // P(end on 2) = P(roll 2) + P(roll 1) * P(reroll to 2) = 1/6 + 1/36 = 7/36
    expect(dist.get(2)).toBeCloseTo(7 / 36, 5);
  });
});

describe("min/max distribution", () => {
  it("1d6min3 has min 3 and piled mass", () => {
    const { dist, stats } = analyze("1d6min3");
    expect(stats.min).toBe(3);
    expect(stats.max).toBe(6);
    // P(3) = P(1) + P(2) + P(3) = 3/6 = 0.5
    expect(dist.get(3)).toBeCloseTo(0.5, 5);
    expect(dist.get(4)).toBeCloseTo(1 / 6, 5);
  });

  it("1d6max4 has max 4 and piled mass", () => {
    const { dist, stats } = analyze("1d6max4");
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
    // P(4) = P(4) + P(5) + P(6) = 3/6 = 0.5
    expect(dist.get(4)).toBeCloseTo(0.5, 5);
    expect(dist.get(1)).toBeCloseTo(1 / 6, 5);
  });

  it("2d6min3 has correct range", () => {
    const { stats } = analyze("2d6min3");
    expect(stats.min).toBe(6);   // 3+3
    expect(stats.max).toBe(12);  // 6+6
    expect(stats.mean).toBeGreaterThan(7); // higher than plain 2d6
  });
});

describe("compound/penetrate distribution", () => {
  it("1d6!! has same mean as 1d6! (compound vs explode)", () => {
    const explode = analyze("1d6!");
    const compound = analyze("1d6!!");
    // Same expected value — compound just sums differently in engine
    expect(compound.stats.mean).toBeCloseTo(explode.stats.mean, 2);
  });

  it("1d6!p has lower mean than 1d6! (penetrating penalty)", () => {
    const explode = analyze("1d6!");
    const penetrate = analyze("1d6!p");
    expect(penetrate.stats.mean).toBeLessThan(explode.stats.mean);
    expect(penetrate.stats.mean).toBeGreaterThan(3.5); // still > non-exploding
  });

  it("1d6!! max is greater than 6", () => {
    const { stats } = analyze("1d6!!");
    expect(stats.max).toBeGreaterThan(6);
  });
});

describe("success count distribution", () => {
  it("8d6cs>=5 has range 0-8", () => {
    const { stats } = analyze("8d6cs>=5");
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(8);
    // P(success per die) = 2/6, so mean = 8 * 2/6 ≈ 2.667
    expect(stats.mean).toBeCloseTo(8 * (2 / 6), 2);
  });

  it("8d6cs>=5cf<=1 can go negative", () => {
    const { stats } = analyze("8d6cs>=5cf<=1");
    // Each die: +1 if >=5, -1 if <=1, 0 otherwise
    // P(+1) = 2/6, P(-1) = 1/6, P(0) = 3/6
    // Mean = 8 * (2/6 - 1/6) = 8/6 ≈ 1.333
    expect(stats.mean).toBeCloseTo(8 * (1 / 6), 2);
    expect(stats.min).toBe(-8); // all failures
    expect(stats.max).toBe(8);  // all successes
  });

  it("10d10cs>=8 (WoD pool) has known distribution", () => {
    const { stats } = analyze("10d10cs>=8");
    // P(success) = 3/10, mean = 10 * 0.3 = 3
    expect(stats.mean).toBeCloseTo(3, 2);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(10);
  });

  it("12d6cs>=5 (Shadowrun pool) has correct mean", () => {
    const { stats } = analyze("12d6cs>=5");
    // P(hit) = 2/6, mean = 12 * 1/3 = 4
    expect(stats.mean).toBeCloseTo(4, 2);
  });

  it("probabilities sum to 1", () => {
    const { dist } = analyze("8d6cs>=5");
    let total = 0;
    for (const p of dist.values()) total += p;
    expect(total).toBeCloseTo(1, 8);
  });
});
