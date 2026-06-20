import { describe, it, expect } from "vitest";
import { cryptoRng, seededRng } from "../src/engine/random.js";
import { rollGameTable, rollMultiple } from "../src/tables/engine.js";
import { evaluateCondition } from "../src/tables/conditions.js";
import { validateGameTables } from "../src/tables/validate.js";
import { rollLootTable, type LootTable } from "../src/loot/table.js";
import type { GameTableCollection } from "../src/tables/schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Consistency suite: bring the V2 game-table engine and the V1 loot table into
// alignment. Each test names the invariant it protects.
// ─────────────────────────────────────────────────────────────────────────────

// ─── F-AT-008: weightedSelect zero/fractional-weight guard ───────────────────
describe("F-AT-008 weightedSelect weight guards", () => {
  // Invariant: a table whose eligible weights sum to <= 0 throws a clear,
  // engine-authored error — never a leaked low-level RangeError from cryptoRng.
  it("throws a clear error (not a leaked RangeError) when total weight is zero", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "empty_weight",
          kind: "loot",
          // weight 0 entries are legal per the `number` schema even though
          // validate flags them; the engine must not crash on them.
          entries: [
            { name: "A", weight: 0 },
            { name: "B", weight: 0 },
          ],
        },
      ],
    };
    // cryptoRng is the path that throws RangeError on randomInt(1, 1).
    let caught: unknown;
    try {
      rollGameTable(collection, "empty_weight", {}, cryptoRng);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // The error must be the engine's domain message, not node's
    // "The value of \"max\" is out of range" RangeError.
    expect(msg).not.toMatch(/out of range/i);
    expect(msg).toMatch(/weight/i);
  });

  // Invariant: fractional weights are handled without crashing cryptoRng
  // (randomInt requires safe integers) and selection stays statistically valid.
  it("handles fractional weights without crashing and selects a real entry", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "frac",
          kind: "loot",
          entries: [
            { name: "Common", weight: 2.5 },
            { name: "Rare", weight: 0.5 },
          ],
        },
      ],
    };
    // Run many times across both rng kinds; none should throw and every
    // result must be one of the declared entries.
    for (let seed = 0; seed < 50; seed++) {
      const out = rollGameTable(collection, "frac", {}, seededRng(seed));
      expect(["Common", "Rare"]).toContain(out[0].entry);
    }
    for (let i = 0; i < 50; i++) {
      const out = rollGameTable(collection, "frac", {}, cryptoRng);
      expect(["Common", "Rare"]).toContain(out[0].entry);
    }
  });

  // Invariant: fractional weights still bias selection toward the heavier
  // entry (proportional correctness preserved after the integerization fix).
  it("preserves proportional bias with fractional weights", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "frac_bias",
          kind: "loot",
          entries: [
            { name: "Heavy", weight: 9.0 },
            { name: "Light", weight: 1.0 },
          ],
        },
      ],
    };
    let heavy = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i++) {
      const out = rollGameTable(collection, "frac_bias", {}, seededRng(i * 7919));
      if (out[0].entry === "Heavy") heavy++;
    }
    // ~90% Heavy. Allow generous slack; just confirm it is clearly biased.
    expect(heavy / runs).toBeGreaterThan(0.8);
  });
});

// ─── F-AT-011: V1 loot quantity Math.max(1, …) clamp ─────────────────────────
describe("F-AT-011 loot quantity clamp", () => {
  // Invariant: the V1 loot path clamps quantity to >= 1, matching the V2 engine,
  // so "1d4-2" (which can roll 0 or -1) never yields a non-positive count.
  it("clamps loot quantity to at least 1 for 1d4-2", () => {
    const tables: LootTable[] = [
      { table: "Junk", items: [{ name: "Pebble", weight: 1, quantity: "1d4-2" }] },
    ];
    // Sweep seeds; some 1d4-2 rolls are <= 0 pre-clamp. Every drop must be >= 1.
    for (let seed = 0; seed < 200; seed++) {
      const drops = rollLootTable(tables, "Junk", seededRng(seed));
      expect(drops[0].quantity).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── F-AT-010: context condition NaN misfilter ───────────────────────────────
describe("F-AT-010 context condition NaN handling", () => {
  // Invariant: a numeric condition applied to a non-numeric context variable
  // resolves to an explicit non-match (false) rather than silently coercing to
  // NaN — behaviour stays sane and does not throw.
  it("returns false (no throw) for numeric condition on a string context var", () => {
    const result = evaluateCondition(
      { type: "context", variable: "tier", operator: ">=", value: 3 },
      { variables: { tier: "high" } },
    );
    expect(result).toBe(false);
  });

  // Invariant: genuinely numeric context variables still compare correctly.
  it("still compares real numeric context variables correctly", () => {
    expect(
      evaluateCondition(
        { type: "context", variable: "strength", operator: ">=", value: 15 },
        { variables: { strength: 18 } },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { type: "context", variable: "strength", operator: ">=", value: 15 },
        { variables: { strength: 10 } },
      ),
    ).toBe(false);
  });

  // Invariant: numeric strings (e.g. "18") still compare numerically — the
  // guard only rejects values that are genuinely non-numeric.
  it("compares numeric-string context variables numerically", () => {
    expect(
      evaluateCondition(
        { type: "context", variable: "strength", operator: ">=", value: 15 },
        { variables: { strength: "18" } },
      ),
    ).toBe(true);
  });
});

// ─── F-AT-009: rollMultiple allowDuplicates contract ─────────────────────────
describe("F-AT-009 rollMultiple unique exhaustion", () => {
  // Invariant: when allowDuplicates is false and count exceeds the number of
  // distinct eligible entries, rollMultiple returns at most that many distinct
  // results — it never silently appends duplicates to pad to `count`.
  it("returns <= distinct-eligible count without silent duplicates", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "small",
          kind: "loot",
          // Only 2 distinct entries, allowDuplicates omitted (=> false).
          entries: [
            { name: "Alpha", weight: 1 },
            { name: "Beta", weight: 1 },
          ],
        },
      ],
    };
    const results = rollMultiple(collection, "small", 5, {}, seededRng(7));
    const names = results.map((r) => r.entry);
    const unique = new Set(names);
    // No duplicates appended.
    expect(unique.size).toBe(names.length);
    // Capped at the distinct-eligible count.
    expect(results.length).toBeLessThanOrEqual(2);
    expect(unique).toEqual(new Set(["Alpha", "Beta"]));
  });

  // Invariant: the normal case (count <= distinct) still returns exactly count.
  it("still returns exactly count when enough distinct entries exist", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        {
          table: "wide",
          kind: "loot",
          entries: [
            { name: "A", weight: 1 },
            { name: "B", weight: 1 },
            { name: "C", weight: 1 },
            { name: "D", weight: 1 },
          ],
        },
      ],
    };
    const results = rollMultiple(collection, "wide", 3, {}, seededRng(42));
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.entry)).size).toBe(3);
  });
});

// ─── F-AT-012: circular-ref duplicate reporting ──────────────────────────────
describe("F-AT-012 circular reference dedup", () => {
  // Invariant: a cycle reachable from multiple tables is reported exactly once,
  // canonicalized by its member set — not once per table that reaches it.
  it("reports a cycle reachable from two tables only once", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        // Both `a` and `b` form a 2-cycle; entry `seed` also points into it,
        // so a fresh DFS from `seed`, `a`, and `b` would each rediscover the
        // same a<->b cycle.
        {
          table: "seed",
          kind: "loot",
          entries: [{ name: "into A", weight: 1, table: "a" }],
        },
        {
          table: "a",
          kind: "loot",
          entries: [{ name: "to B", weight: 1, table: "b" }],
        },
        {
          table: "b",
          kind: "loot",
          entries: [{ name: "to A", weight: 1, table: "a" }],
        },
      ],
    };
    const errors = validateGameTables(collection);
    const circular = errors.filter((e) => e.includes("Circular"));
    expect(circular).toHaveLength(1);
  });

  // Invariant: two genuinely distinct cycles are still reported separately.
  it("reports two distinct cycles separately", () => {
    const collection: GameTableCollection = {
      version: "2.0",
      tables: [
        { table: "a", kind: "loot", entries: [{ name: "x", weight: 1, table: "b" }] },
        { table: "b", kind: "loot", entries: [{ name: "y", weight: 1, table: "a" }] },
        { table: "c", kind: "loot", entries: [{ name: "z", weight: 1, table: "d" }] },
        { table: "d", kind: "loot", entries: [{ name: "w", weight: 1, table: "c" }] },
      ],
    };
    const errors = validateGameTables(collection);
    const circular = errors.filter((e) => e.includes("Circular"));
    expect(circular).toHaveLength(2);
  });
});
