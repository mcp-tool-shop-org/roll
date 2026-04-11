import { describe, it, expect, beforeEach } from "vitest";
import { BridgeHandler } from "../src/bridge/handler.js";
import type { JsonRpcRequest } from "../src/bridge/protocol.js";

let handler: BridgeHandler;

beforeEach(() => {
  handler = new BridgeHandler();
});

function req(method: string, params?: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

// ─── Protocol basics ─────────────────────────────────────────────────────────

describe("bridge protocol", () => {
  it("responds to ping", () => {
    const res = handler.handle(req("ping"));
    expect(res.result).toEqual({ ok: true });
    expect(res.error).toBeUndefined();
  });

  it("returns error for unknown method", () => {
    const res = handler.handle(req("nonexistent"));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601); // METHOD_NOT_FOUND
  });

  it("returns error for invalid JSON via handleRaw", () => {
    const res = handler.handleRaw("not json");
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32700); // PARSE_ERROR
  });

  it("preserves request id in response", () => {
    const res = handler.handle(req("ping", undefined, 42));
    expect(res.id).toBe(42);
  });

  it("handles string ids", () => {
    const res = handler.handle(req("ping", undefined, "abc-123"));
    expect(res.id).toBe("abc-123");
  });
});

// ─── Roll methods ────────────────────────────────────────────────────────────

describe("bridge roll", () => {
  it("rolls a dice expression", () => {
    const res = handler.handle(req("roll", { expression: "2d6+3", seed: 42 }));
    expect(res.error).toBeUndefined();
    const result = res.result as { total: number; groups: unknown[] };
    expect(typeof result.total).toBe("number");
    expect(result.groups.length).toBeGreaterThan(0);
  });

  it("rolls deterministically with seed", () => {
    const r1 = handler.handle(req("roll", { expression: "4d6kh3", seed: 42 }));
    const r2 = handler.handle(req("roll", { expression: "4d6kh3", seed: 42 }));
    expect((r1.result as { total: number }).total).toBe((r2.result as { total: number }).total);
  });

  it("returns error for missing expression", () => {
    const res = handler.handle(req("roll", {}));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602); // INVALID_PARAMS
  });

  it("returns error for invalid expression", () => {
    const res = handler.handle(req("roll", { expression: "not a roll" }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32603); // INTERNAL_ERROR
  });

  it("handles roll_batch", () => {
    const res = handler.handle(req("roll_batch", {
      expressions: ["1d20+5", "2d6+3", "1d8"],
      seed: 42,
    }));
    expect(res.error).toBeUndefined();
    const results = res.result as { total: number }[];
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(typeof r.total).toBe("number"));
  });
});

// ─── Analyze methods ─────────────────────────────────────────────────────────

describe("bridge analyze", () => {
  it("analyzes a dice expression", () => {
    const res = handler.handle(req("analyze", { expression: "2d6" }));
    expect(res.error).toBeUndefined();
    const result = res.result as { stats: { mean: number }; distribution: [number, number][] };
    expect(result.stats.mean).toBeCloseTo(7, 1);
    expect(result.distribution.length).toBeGreaterThan(0);
  });

  it("computes at_least probability", () => {
    const res = handler.handle(req("at_least", { expression: "2d6", target: 7 }));
    expect(res.error).toBeUndefined();
    const result = res.result as { probability: number; target: number };
    expect(result.target).toBe(7);
    expect(result.probability).toBeCloseTo(21 / 36, 3);
  });

  it("compares two expressions", () => {
    const res = handler.handle(req("compare", {
      expressions: ["4d6kh3", "3d6"],
    }));
    expect(res.error).toBeUndefined();
    const results = res.result as { expression: string; stats: { mean: number } }[];
    expect(results).toHaveLength(2);
    expect(results[0].stats.mean).toBeGreaterThan(results[1].stats.mean);
  });
});

// ─── Seed ────────────────────────────────────────────────────────────────────

describe("bridge seed", () => {
  it("sets global seed for subsequent rolls", () => {
    handler.handle(req("seed", { seed: 42 }));
    const r1 = handler.handle(req("roll", { expression: "1d20" }));

    handler.handle(req("seed", { seed: 42 }));
    const r2 = handler.handle(req("roll", { expression: "1d20" }));

    expect((r1.result as { total: number }).total).toBe((r2.result as { total: number }).total);
  });
});

// ─── Table methods ───────────────────────────────────────────────────────────

describe("bridge tables", () => {
  const collection = {
    version: "2.0",
    tables: [
      {
        table: "loot",
        kind: "loot",
        entries: [
          { name: "Gold", weight: 5, roll: "2d6*10" },
          { name: "Gem", weight: 2 },
        ],
      },
    ],
  };

  it("loads and lists tables", () => {
    const loadRes = handler.handle(req("table_load", { collection }));
    expect(loadRes.error).toBeUndefined();
    expect((loadRes.result as { loaded: string[] }).loaded).toContain("loot");

    const listRes = handler.handle(req("table_list"));
    expect((listRes.result as { tables: string[] }).tables).toContain("loot");
  });

  it("rolls on loaded table", () => {
    handler.handle(req("table_load", { collection }));
    const res = handler.handle(req("table_roll", { table: "loot" }));
    expect(res.error).toBeUndefined();
    const results = res.result as { entry: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(["Gold", "Gem"]).toContain(results[0].entry);
  });

  it("returns error for unloaded table", () => {
    const res = handler.handle(req("table_roll", { table: "nonexistent" }));
    expect(res.error).toBeDefined();
  });
});

// ─── handleRaw end-to-end ────────────────────────────────────────────────────

describe("bridge handleRaw", () => {
  it("handles full JSON string roundtrip", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "roll",
      params: { expression: "1d6", seed: 42 },
    });
    const res = handler.handleRaw(raw);
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.error).toBeUndefined();
    expect((res.result as { total: number }).total).toBeGreaterThanOrEqual(1);
  });
});
