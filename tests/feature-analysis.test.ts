import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { computeDistribution } from "../src/analyze/distribution.js";
import {
  probabilityAtLeast,
  probabilityAtMost,
  probabilityExactly,
  probabilityInRange,
  cumulativeDistribution,
  survivalDistribution,
  targetForProbability,
} from "../src/analyze/stats.js";
import { compareDistributions, negateDistribution } from "../src/analyze/distribution.js";
import { analyzeTable, analyzeCollection } from "../src/tables/analyze.js";
import { analyze } from "../src/index.js";
import type {
  GameTable,
  GameTableCollection,
  TableContext,
} from "../src/tables/schema.js";

function distOf(expr: string) {
  return computeDistribution(parse(expr));
}

// ─── 1. Point/range query family (FT-ANA-003) ────────────────────────────────

describe("query family (FT-ANA-003)", () => {
  it("probabilityExactly(2d6, 7) = 6/36", () => {
    const d = distOf("2d6");
    expect(probabilityExactly(d, 7)).toBeCloseTo(6 / 36, 12);
    expect(probabilityExactly(d, 2)).toBeCloseTo(1 / 36, 12);
    expect(probabilityExactly(d, 13)).toBe(0); // outside support
  });

  it("probabilityAtMost(2d6, 7) = 21/36", () => {
    const d = distOf("2d6");
    // 1+2+3+4+5+6 = 21 ways to roll <= 7
    expect(probabilityAtMost(d, 7)).toBeCloseTo(21 / 36, 12);
    expect(probabilityAtMost(d, 12)).toBeCloseTo(1, 12);
    expect(probabilityAtMost(d, 1)).toBe(0);
  });

  it("probabilityInRange(2d6, 6, 8) is inclusive and correct", () => {
    const d = distOf("2d6");
    // P(6)+P(7)+P(8) = (5+6+5)/36 = 16/36
    expect(probabilityInRange(d, 6, 8)).toBeCloseTo(16 / 36, 12);
    // single-value range == exactly
    expect(probabilityInRange(d, 7, 7)).toBeCloseTo(probabilityExactly(d, 7), 12);
    // whole range == 1
    expect(probabilityInRange(d, 2, 12)).toBeCloseTo(1, 12);
  });

  it("query family is consistent with probabilityAtLeast", () => {
    const d = distOf("2d6");
    for (let x = 2; x <= 12; x++) {
      // P(X <= x) + P(X >= x) - P(X = x) = 1
      const consistency =
        probabilityAtMost(d, x) + probabilityAtLeast(d, x) - probabilityExactly(d, x);
      expect(consistency).toBeCloseTo(1, 12);
      // P(X >= x) = 1 - P(X <= x-1)
      expect(probabilityAtLeast(d, x)).toBeCloseTo(1 - probabilityAtMost(d, x - 1), 12);
    }
  });
});

// ─── 2. CDF (FT-ANA-004) ──────────────────────────────────────────────────────

describe("cumulativeDistribution (FT-ANA-004)", () => {
  it("is monotonic non-decreasing and ends at ~1", () => {
    const cdf = cumulativeDistribution(distOf("2d6"));
    const values = [...cdf.entries()].sort((a, b) => a[0] - b[0]);
    let prev = 0;
    for (const [, p] of values) {
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
    const last = values[values.length - 1]![1];
    expect(last).toBeCloseTo(1, 10);
  });

  it("CDF value at v equals probabilityAtMost(v)", () => {
    const d = distOf("2d6");
    const cdf = cumulativeDistribution(d);
    for (const [v, p] of cdf) {
      expect(p).toBeCloseTo(probabilityAtMost(d, v), 12);
    }
  });

  it("survivalDistribution at v equals probabilityAtLeast(v)", () => {
    const d = distOf("2d6");
    const surv = survivalDistribution(d);
    for (const [v, p] of surv) {
      expect(p).toBeCloseTo(probabilityAtLeast(d, v), 12);
    }
  });
});

// ─── 3. Break-even / target solver (FT-ANA-005) ──────────────────────────────

describe("targetForProbability (FT-ANA-005)", () => {
  it("1d20+5 (range 6..25 uniform): atLeast 0.5 round-trips", () => {
    const d = distOf("1d20+5");
    const t = targetForProbability(d, 0.5, "atLeast");
    // The returned T must actually satisfy P(X >= T) >= 0.5 ...
    expect(probabilityAtLeast(d, t)).toBeGreaterThanOrEqual(0.5 - 1e-12);
    // ... and be the SMALLEST such T: T+1 must drop below 0.5.
    expect(probabilityAtLeast(d, t + 1)).toBeLessThan(0.5);
    // sane range
    expect(t).toBeGreaterThanOrEqual(6);
    expect(t).toBeLessThanOrEqual(25);
  });

  it("atMost direction returns smallest T with P(X<=T) >= p", () => {
    const d = distOf("1d20+5");
    const t = targetForProbability(d, 0.5, "atMost");
    expect(probabilityAtMost(d, t)).toBeGreaterThanOrEqual(0.5 - 1e-12);
    if (t - 1 >= 6) {
      expect(probabilityAtMost(d, t - 1)).toBeLessThan(0.5);
    }
  });

  it("default direction is atLeast", () => {
    const d = distOf("1d20+5");
    expect(targetForProbability(d, 0.5)).toBe(targetForProbability(d, 0.5, "atLeast"));
  });

  it("p=0 returns the max value (atLeast) — any target satisfied, smallest is min, but p=1 forces min", () => {
    const d = distOf("1d20+5");
    // p=1 atLeast: need P(X>=T) >= 1 → only the minimum value qualifies.
    expect(targetForProbability(d, 1, "atLeast")).toBe(6);
    // p=1 atMost: need P(X<=T) >= 1 → only the maximum value qualifies.
    expect(targetForProbability(d, 1, "atMost")).toBe(25);
  });
});

// ─── 4. Comparison as probability (FT-ANA-002) ───────────────────────────────

describe("compareDistributions (FT-ANA-002)", () => {
  it("negateDistribution flips keys", () => {
    const neg = negateDistribution(distOf("1d6"));
    expect(neg.get(-1)).toBeCloseTo(1 / 6, 12);
    expect(neg.get(-6)).toBeCloseTo(1 / 6, 12);
    expect(neg.has(1)).toBe(false);
  });

  it("identical A=B: pAGreater ≈ pBGreater, pEqual is the tie mass, sum ~1", () => {
    const a = distOf("1d20");
    const b = distOf("1d20");
    const r = compareDistributions(a, b);
    expect(r.pAGreater).toBeCloseTo(r.pBGreater, 10);
    // For two independent 1d20, P(tie) = 20/400 = 1/20.
    expect(r.pEqual).toBeCloseTo(1 / 20, 10);
    expect(r.pAGreater + r.pEqual + r.pBGreater).toBeCloseTo(1, 10);
    // margin distribution is symmetric around 0
    expect(r.margin.get(0)).toBeCloseTo(1 / 20, 10);
  });

  it("A clearly stronger (2d6+10 vs 1d4): pAGreater ≈ 1", () => {
    const a = distOf("2d6+10"); // range 12..22
    const b = distOf("1d4"); // range 1..4
    const r = compareDistributions(a, b);
    expect(r.pAGreater).toBeCloseTo(1, 10);
    expect(r.pBGreater).toBeCloseTo(0, 10);
    expect(r.pEqual).toBeCloseTo(0, 10);
    expect(r.pAGreater + r.pEqual + r.pBGreater).toBeCloseTo(1, 10);
  });

  it("three probabilities always sum to ~1", () => {
    const r = compareDistributions(distOf("1d6"), distOf("1d8"));
    expect(r.pAGreater + r.pEqual + r.pBGreater).toBeCloseTo(1, 10);
  });
});

// ─── 5. Table analysis (FT-ANA-001 / FT-TBL-001) ─────────────────────────────

const lootTable: GameTable = {
  table: "treasure",
  kind: "loot",
  entries: [
    { name: "Gold Coins", weight: 5, roll: "2d6*10", quantity: "1d4" },
    { name: "Silver Ring", weight: 3 },
    { name: "Dragon", weight: 2, minLevel: 12 },
    {
      name: "Blessed Relic",
      weight: 4,
      conditions: [{ type: "tag", tag: "holy" }],
    },
  ],
};

const collection: GameTableCollection = {
  version: "2.0",
  tables: [lootTable],
};

describe("analyzeTable (FT-ANA-001 / FT-TBL-001)", () => {
  it("eligible probabilities normalize to 1", () => {
    const ctx: TableContext = { level: 1, tags: ["holy"] };
    const a = analyzeTable(lootTable, ctx);
    const sum = a.entries.reduce((s, e) => s + e.probability, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(a.entries.length).toBe(3); // Gold, Silver, Blessed (Dragon excluded by level)
  });

  it("level-excluded entry shows in excluded with a level reason", () => {
    const ctx: TableContext = { level: 1, tags: ["holy"] };
    const a = analyzeTable(lootTable, ctx);
    const dragon = a.excluded.find((x) => x.entry.name === "Dragon");
    expect(dragon).toBeDefined();
    expect(dragon!.reason).toMatch(/level/i);
  });

  it("condition-excluded entry shows in excluded with a condition reason", () => {
    const ctx: TableContext = { level: 1 }; // no 'holy' tag
    const a = analyzeTable(lootTable, ctx);
    const relic = a.excluded.find((x) => x.entry.name === "Blessed Relic");
    expect(relic).toBeDefined();
    expect(relic!.reason).toMatch(/condition/i);
  });

  it("an entry with a roll dice field reports a valueMean", () => {
    const ctx: TableContext = { level: 12, tags: ["holy"] };
    const a = analyzeTable(lootTable, ctx);
    const gold = a.entries.find((e) => e.entry.name === "Gold Coins");
    expect(gold).toBeDefined();
    // 2d6*10 has mean 70.
    expect(gold!.valueMean).toBeCloseTo(70, 6);
    expect(gold!.valueDistribution).toBeDefined();
  });

  it("probabilities match weight proportions (using same scaling as weightedSelect)", () => {
    // level 12 + holy: all 4 entries eligible, weights 5/3/2/4 → total 14
    const ctx: TableContext = { level: 12, tags: ["holy"] };
    const a = analyzeTable(lootTable, ctx);
    const gold = a.entries.find((e) => e.entry.name === "Gold Coins")!;
    expect(gold.probability).toBeCloseTo(5 / 14, 10);
    const dragon = a.entries.find((e) => e.entry.name === "Dragon")!;
    expect(dragon.probability).toBeCloseTo(2 / 14, 10);
  });

  it("analyzeCollection resolves a table by name", () => {
    const ctx: TableContext = { level: 12, tags: ["holy"] };
    const a = analyzeCollection(collection, "treasure", ctx);
    const sum = a.entries.reduce((s, e) => s + e.probability, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("nested table ref multiplies child probabilities (best-effort single level)", () => {
    const nested: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "top",
          kind: "encounter",
          entries: [
            { name: "Direct", weight: 1 },
            { name: "GoTo Sub", weight: 1, table: "sub" },
          ],
        },
        {
          table: "sub",
          kind: "loot",
          entries: [
            { name: "Sub A", weight: 1 },
            { name: "Sub B", weight: 1 },
          ],
        },
      ],
    };
    const a = analyzeCollection(nested, "top", {});
    const sum = a.entries.reduce((s, e) => s + e.probability, 0);
    expect(sum).toBeCloseTo(1, 10);
    // Top: Direct 0.5, sub 0.5. Sub splits 0.5 across A/B → 0.25 each.
    const subA = a.entries.find((e) => e.entry.name === "Sub A");
    expect(subA).toBeDefined();
    expect(subA!.probability).toBeCloseTo(0.25, 10);
  });
});

// ─── 6. Public API surface (index.ts) ────────────────────────────────────────

describe("analyze() public surface (FT-ANA-003/004/005)", () => {
  it("exposes the query family + cdf + targetForProbability additively", () => {
    const r = analyze("2d6");
    // existing fields preserved
    expect(r.distribution).toBeInstanceOf(Map);
    expect(r.stats).toBeDefined();
    expect(typeof r.probabilityAtLeast).toBe("function");
    expect(r.method).toBe("exact");
    // new fields
    expect(r.probabilityExactly(7)).toBeCloseTo(6 / 36, 12);
    expect(r.probabilityAtMost(7)).toBeCloseTo(21 / 36, 12);
    expect(r.probabilityInRange(6, 8)).toBeCloseTo(16 / 36, 12);
    expect(r.cdf).toBeInstanceOf(Map);
    expect(typeof r.targetForProbability).toBe("function");
    expect(r.probabilityAtLeast(r.targetForProbability(0.5))).toBeGreaterThanOrEqual(0.5 - 1e-12);
  });
});
