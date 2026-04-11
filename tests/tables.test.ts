import { describe, it, expect } from "vitest";
import { seededRng } from "../src/engine/random.js";
import { rollGameTable, rollMultiple, convertLootToGameTable } from "../src/tables/engine.js";
import { validateGameTables } from "../src/tables/validate.js";
import { evaluateCondition, filterEligibleEntries } from "../src/tables/conditions.js";
import type { GameTableCollection, TableContext, TableEntry } from "../src/tables/schema.js";
import type { LootTable } from "../src/loot/table.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

const basicCollection: GameTableCollection = {
  version: "2.0",
  tables: [
    {
      table: "treasure",
      kind: "loot",
      entries: [
        { name: "Gold Coins", weight: 5, roll: "2d6*10", quantity: "1d4" },
        { name: "Silver Ring", weight: 3, rarity: "uncommon" },
        { name: "Diamond", weight: 1, rarity: "rare", tags: ["gem"] },
        { name: "Nothing", weight: 1 },
      ],
    },
  ],
};

const nestedCollection: GameTableCollection = {
  version: "2.0",
  tables: [
    {
      table: "encounter",
      kind: "encounter",
      entries: [
        { name: "Goblin Pack", weight: 5, table: "goblin_loot" },
        { name: "Dragon", weight: 1, table: "dragon_loot" },
      ],
    },
    {
      table: "goblin_loot",
      kind: "loot",
      entries: [
        { name: "Rusty Sword", weight: 3 },
        { name: "Goblin Ear", weight: 7, quantity: "1d3" },
      ],
    },
    {
      table: "dragon_loot",
      kind: "loot",
      entries: [
        { name: "Dragon Scale", weight: 5, rarity: "epic" },
        { name: "Hoard Gold", weight: 5, roll: "10d6*100" },
      ],
    },
  ],
};

const levelCollection: GameTableCollection = {
  version: "2.0",
  tables: [
    {
      table: "rewards",
      kind: "reward",
      entries: [
        { name: "Wooden Shield", weight: 5, minLevel: 1, maxLevel: 5 },
        { name: "Steel Shield", weight: 3, minLevel: 5, maxLevel: 10 },
        { name: "Mythril Shield", weight: 1, minLevel: 10 },
      ],
    },
  ],
};

const conditionCollection: GameTableCollection = {
  version: "2.0",
  tables: [
    {
      table: "critical",
      kind: "critical",
      entries: [
        {
          name: "Devastating Blow",
          weight: 1,
          conditions: [{ type: "nat", operator: "=", value: 20 }],
          roll: "2d6",
        },
        {
          name: "Solid Hit",
          weight: 3,
          conditions: [{ type: "compare", operator: ">=", value: 15 }],
        },
        { name: "Glancing Blow", weight: 5 },
      ],
    },
  ],
};

const chainCollection: GameTableCollection = {
  version: "2.0",
  tables: [
    {
      table: "crit_effect",
      kind: "critical",
      entries: [
        {
          name: "Critical Strike",
          weight: 1,
          chain: ["bonus_damage"],
        },
      ],
    },
    {
      table: "bonus_damage",
      kind: "custom",
      entries: [
        { name: "Extra Fire Damage", weight: 3, roll: "1d6" },
        { name: "Extra Ice Damage", weight: 3, roll: "1d8" },
      ],
    },
  ],
};

const statusCollection: GameTableCollection = {
  version: "2.0",
  tables: [
    {
      table: "status_effects",
      kind: "status",
      entries: [
        { name: "Poisoned", weight: 3, duration: "1d4+1", tags: ["debuff"] },
        { name: "Stunned", weight: 1, duration: "1", tags: ["debuff", "severe"] },
        { name: "Blessed", weight: 2, duration: "2d4", tags: ["buff"] },
      ],
    },
  ],
};

// ─── Condition evaluation ────────────────────────────────────────────────────

describe("conditions", () => {
  it("evaluates compare condition", () => {
    expect(evaluateCondition(
      { type: "compare", operator: ">=", value: 15 },
      { triggerRoll: 18 },
    )).toBe(true);
    expect(evaluateCondition(
      { type: "compare", operator: ">=", value: 15 },
      { triggerRoll: 10 },
    )).toBe(false);
  });

  it("evaluates nat condition", () => {
    expect(evaluateCondition(
      { type: "nat", operator: "=", value: 20 },
      { triggerNat: 20 },
    )).toBe(true);
    expect(evaluateCondition(
      { type: "nat", operator: "=", value: 20 },
      { triggerNat: 19 },
    )).toBe(false);
  });

  it("evaluates tag condition", () => {
    expect(evaluateCondition(
      { type: "tag", tag: "fire" },
      { tags: ["fire", "magic"] },
    )).toBe(true);
    expect(evaluateCondition(
      { type: "tag", tag: "ice" },
      { tags: ["fire"] },
    )).toBe(false);
  });

  it("evaluates context variable condition", () => {
    expect(evaluateCondition(
      { type: "context", variable: "strength", operator: ">=", value: 15 },
      { variables: { strength: 18 } },
    )).toBe(true);
  });

  it("filters entries by level range", () => {
    const entries = levelCollection.tables[0].entries;
    const level3 = filterEligibleEntries(entries, { level: 3 });
    expect(level3.map((e) => e.name)).toEqual(["Wooden Shield"]);

    const level7 = filterEligibleEntries(entries, { level: 7 });
    expect(level7.map((e) => e.name)).toEqual(["Steel Shield"]);

    const level15 = filterEligibleEntries(entries, { level: 15 });
    expect(level15.map((e) => e.name)).toEqual(["Mythril Shield"]);
  });

  it("filters entries by conditions", () => {
    const entries = conditionCollection.tables[0].entries;
    const nat20 = filterEligibleEntries(entries, { triggerNat: 20, triggerRoll: 25 });
    expect(nat20.map((e) => e.name)).toContain("Devastating Blow");

    const roll12 = filterEligibleEntries(entries, { triggerRoll: 12 });
    expect(roll12.map((e) => e.name)).not.toContain("Solid Hit");
    expect(roll12.map((e) => e.name)).toContain("Glancing Blow");
  });
});

// ─── Table rolling ───────────────────────────────────────────────────────────

describe("rollGameTable", () => {
  it("rolls on a basic table deterministically", () => {
    const rng = seededRng(42);
    const results = rollGameTable(basicCollection, "treasure", {}, rng);
    expect(results).toHaveLength(1);
    expect(results[0].fromTable).toBe("treasure");
    expect(typeof results[0].entry).toBe("string");
  });

  it("resolves dice quantity and roll value", () => {
    // Run many seeds to find Gold Coins which has roll + quantity
    let found = false;
    for (let seed = 0; seed < 100; seed++) {
      const results = rollGameTable(basicCollection, "treasure", {}, seededRng(seed));
      if (results[0].entry === "Gold Coins") {
        found = true;
        expect(results[0].quantity).toBeGreaterThanOrEqual(1);
        expect(results[0].quantity).toBeLessThanOrEqual(4);
        expect(results[0].rollValue).toBeDefined();
        expect(results[0].rollExpression).toBe("2d6*10");
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("follows nested table references", () => {
    const rng = seededRng(42);
    const results = rollGameTable(nestedCollection, "encounter", {}, rng);
    expect(results).toHaveLength(1);
    // Should resolve to an entry from goblin_loot or dragon_loot
    const validNames = ["Rusty Sword", "Goblin Ear", "Dragon Scale", "Hoard Gold"];
    expect(validNames).toContain(results[0].entry);
  });

  it("handles table chains", () => {
    const rng = seededRng(42);
    const results = rollGameTable(chainCollection, "crit_effect", {}, rng);
    expect(results[0].entry).toBe("Critical Strike");
    expect(results[0].chainResults).toBeDefined();
    expect(results[0].chainResults!.length).toBeGreaterThan(0);
    const chainEntry = results[0].chainResults![0].entry;
    expect(["Extra Fire Damage", "Extra Ice Damage"]).toContain(chainEntry);
  });

  it("resolves duration dice", () => {
    let foundDuration = false;
    for (let seed = 0; seed < 100; seed++) {
      const results = rollGameTable(statusCollection, "status_effects", {}, seededRng(seed));
      if (results[0].entry === "Poisoned") {
        foundDuration = true;
        expect(results[0].duration).toBeGreaterThanOrEqual(2); // 1d4+1 min
        expect(results[0].duration).toBeLessThanOrEqual(5);    // 1d4+1 max
        expect(results[0].durationExpression).toBe("1d4+1");
        break;
      }
    }
    expect(foundDuration).toBe(true);
  });

  it("throws on missing table", () => {
    expect(() => rollGameTable(basicCollection, "nonexistent")).toThrow("Table not found");
  });

  it("filters by level context", () => {
    // At level 3, only "Wooden Shield" is eligible
    for (let seed = 0; seed < 20; seed++) {
      const results = rollGameTable(levelCollection, "rewards", { level: 3 }, seededRng(seed));
      expect(results[0].entry).toBe("Wooden Shield");
    }
  });

  it("preserves rarity and tags", () => {
    let foundRare = false;
    for (let seed = 0; seed < 200; seed++) {
      const results = rollGameTable(basicCollection, "treasure", {}, seededRng(seed));
      if (results[0].entry === "Diamond") {
        foundRare = true;
        expect(results[0].rarity).toBe("rare");
        expect(results[0].tags).toEqual(["gem"]);
        break;
      }
    }
    expect(foundRare).toBe(true);
  });
});

// ─── Multi-roll ──────────────────────────────────────────────────────────────

describe("rollMultiple", () => {
  it("returns correct count", () => {
    const results = rollMultiple(basicCollection, "treasure", 3, {}, seededRng(42));
    expect(results).toHaveLength(3);
  });

  it("deduplicates when allowDuplicates is false", () => {
    // basicCollection defaults to no allowDuplicates
    const results = rollMultiple(basicCollection, "treasure", 4, {}, seededRng(42));
    const names = results.map((r) => r.entry);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

// ─── V1 Bridge ───────────────────────────────────────────────────────────────

describe("convertLootToGameTable", () => {
  it("converts V1 LootTable to V2 GameTable", () => {
    const v1: LootTable = {
      table: "old_treasure",
      items: [
        { name: "Gold", weight: 5, roll: "2d6*10" },
        { name: "Silver", weight: 3, quantity: "1d4" },
        { name: "Gems", weight: 2, table: "gem_table" },
      ],
    };

    const v2 = convertLootToGameTable(v1);
    expect(v2.table).toBe("old_treasure");
    expect(v2.kind).toBe("loot");
    expect(v2.entries).toHaveLength(3);
    expect(v2.entries[0].name).toBe("Gold");
    expect(v2.entries[0].roll).toBe("2d6*10");
    expect(v2.entries[1].quantity).toBe("1d4");
    expect(v2.entries[2].table).toBe("gem_table");
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("validateGameTables", () => {
  it("passes valid collection", () => {
    expect(validateGameTables(basicCollection)).toEqual([]);
  });

  it("catches missing table references", () => {
    const bad: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "test",
          kind: "loot",
          entries: [{ name: "Item", weight: 1, table: "nonexistent" }],
        },
      ],
    };
    const errors = validateGameTables(bad);
    expect(errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  it("catches invalid dice expressions", () => {
    const bad: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "test",
          kind: "loot",
          entries: [{ name: "Item", weight: 1, roll: "not a dice expression!!!" }],
        },
      ],
    };
    const errors = validateGameTables(bad);
    expect(errors.some((e) => e.includes("Invalid dice expression"))).toBe(true);
  });

  it("catches circular references", () => {
    const circular: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "a",
          kind: "loot",
          entries: [{ name: "Go to B", weight: 1, table: "b" }],
        },
        {
          table: "b",
          kind: "loot",
          entries: [{ name: "Go to A", weight: 1, table: "a" }],
        },
      ],
    };
    const errors = validateGameTables(circular);
    expect(errors.some((e) => e.includes("Circular"))).toBe(true);
  });

  it("catches invalid level ranges", () => {
    const bad: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "test",
          kind: "loot",
          entries: [{ name: "Item", weight: 1, minLevel: 10, maxLevel: 5 }],
        },
      ],
    };
    const errors = validateGameTables(bad);
    expect(errors.some((e) => e.includes("minLevel"))).toBe(true);
  });

  it("catches missing chain references", () => {
    const bad: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "test",
          kind: "critical",
          entries: [{ name: "Crit", weight: 1, chain: ["missing_table"] }],
        },
      ],
    };
    const errors = validateGameTables(bad);
    expect(errors.some((e) => e.includes("missing_table"))).toBe(true);
  });
});
