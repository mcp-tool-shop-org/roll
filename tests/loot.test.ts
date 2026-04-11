import { describe, it, expect } from "vitest";
import { rollLootTable, validateLootTables, type LootTable } from "../src/loot/table.js";
import { seededRng } from "../src/engine/random.js";

const basicTable: LootTable[] = [
  {
    table: "Treasure",
    items: [
      { name: "Gold", weight: 50, roll: "2d6*10" },
      { name: "Potion of Healing", weight: 30 },
      { name: "Sword +1", weight: 15 },
      { name: "Rare Item", weight: 5, table: "rare" },
    ],
  },
  {
    table: "rare",
    items: [
      { name: "Dragon Scale Armor", weight: 20 },
      { name: "Ring of Invisibility", weight: 10 },
      { name: "Vorpal Sword", weight: 5 },
    ],
  },
];

describe("loot table", () => {
  it("rolls deterministically with seeded rng", () => {
    const r1 = rollLootTable(basicTable, "Treasure", seededRng(42));
    const r2 = rollLootTable(basicTable, "Treasure", seededRng(42));
    expect(r1).toEqual(r2);
  });

  it("returns a valid drop", () => {
    const drops = rollLootTable(basicTable, "Treasure", seededRng(42));
    expect(drops).toHaveLength(1);
    expect(drops[0].item).toBeTruthy();
    expect(drops[0].quantity).toBeGreaterThanOrEqual(1);
  });

  it("resolves dice expressions in rolls", () => {
    // Find a seed that gives us Gold (which has a roll expression)
    for (let seed = 0; seed < 100; seed++) {
      const drops = rollLootTable(basicTable, "Treasure", seededRng(seed));
      if (drops[0].item === "Gold") {
        expect(drops[0].rollValue).toBeDefined();
        expect(drops[0].rollExpression).toBe("2d6*10");
        expect(drops[0].rollValue!).toBeGreaterThanOrEqual(20);
        expect(drops[0].rollValue!).toBeLessThanOrEqual(120);
        return;
      }
    }
    // Should have found Gold in 100 tries given weight 50/100
    expect.unreachable("Should have found Gold drop");
  });

  it("resolves nested table references", () => {
    // Find a seed that triggers the rare table
    let foundRare = false;
    for (let seed = 0; seed < 500; seed++) {
      const drops = rollLootTable(basicTable, "Treasure", seededRng(seed));
      if (drops[0].fromTable === "rare") {
        foundRare = true;
        expect(["Dragon Scale Armor", "Ring of Invisibility", "Vorpal Sword"]).toContain(drops[0].item);
        break;
      }
    }
    expect(foundRare).toBe(true);
  });

  it("handles quantity dice", () => {
    const tables: LootTable[] = [{
      table: "Arrows",
      items: [{ name: "Arrow", weight: 1, quantity: "2d6" }],
    }];
    const drops = rollLootTable(tables, "Arrows", seededRng(42));
    expect(drops[0].quantity).toBeGreaterThanOrEqual(2);
    expect(drops[0].quantity).toBeLessThanOrEqual(12);
  });

  it("distributes proportionally to weights", () => {
    const counts: Record<string, number> = {};
    const runs = 10000;
    for (let i = 0; i < runs; i++) {
      const drops = rollLootTable(basicTable, "Treasure", seededRng(i * 7919));
      const name = drops[0].fromTable === "rare" ? "Rare Item" : drops[0].item;
      counts[name] = (counts[name] ?? 0) + 1;
    }

    // Gold should be ~50%, Potion ~30%, Sword ~15%, Rare ~5%
    expect(counts["Gold"]! / runs).toBeCloseTo(0.5, 1);
    expect(counts["Potion of Healing"]! / runs).toBeCloseTo(0.3, 1);
  });

  it("throws on circular reference", () => {
    const circular: LootTable[] = [
      { table: "a", items: [{ name: "x", weight: 1, table: "b" }] },
      { table: "b", items: [{ name: "y", weight: 1, table: "a" }] },
    ];
    expect(() => rollLootTable(circular, "a", seededRng(42))).toThrow("recursion");
  });

  it("throws on missing table", () => {
    expect(() => rollLootTable(basicTable, "nonexistent", seededRng(42))).toThrow("not found");
  });
});

describe("validateLootTables", () => {
  it("validates correct tables", () => {
    expect(validateLootTables(basicTable)).toEqual([]);
  });

  it("catches missing table reference", () => {
    const bad: LootTable[] = [{
      table: "test",
      items: [{ name: "x", weight: 1, table: "missing" }],
    }];
    const errors = validateLootTables(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing");
  });

  it("catches invalid dice expression", () => {
    const bad: LootTable[] = [{
      table: "test",
      items: [{ name: "x", weight: 1, roll: "not valid dice" }],
    }];
    const errors = validateLootTables(bad);
    expect(errors.length).toBeGreaterThan(0);
  });
});
