/**
 * Feature-boundary tests (Tier-1 analysis-on-the-wire features).
 *
 * Surfaces the analysis layer to both transports — exercised IN-PROCESS via
 * BridgeHandler.handle(...) and the MCP handleRequest(...)/dispatch(...), no
 * child processes. Findings under test:
 *
 *   FT-INT-002 / FT-ANA-001 — table analysis on the wire:
 *       bridge `table_analyze` + MCP `analyze_table` return per-entry selection
 *       probabilities, value means, and excluded entries (with reasons). The
 *       value distributions are JSON-serializable (Maps converted to tuples).
 *   FT-ANA-002 — comparison as probability:
 *       bridge `compare` (enhanced additively) + MCP `compare_dice` include
 *       P(A>B), P(tie), P(B>A), and the margin mean.
 *   FT-ANA-003 — query family on the wire:
 *       bridge `at_most`, `exactly`, `between` mirror `at_least`. MCP
 *       `analyze_dice` optionally surfaces the query family + cdf additively.
 *   FT-INT-008 — MCP serverInfo.version reads from package.json (no drift).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { BridgeHandler } from "../src/bridge/handler.js";
import { handleRequest } from "../src/mcp/server.js";
import type { JsonRpcRequest } from "../src/bridge/protocol.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

let handler: BridgeHandler;
beforeEach(() => {
  handler = new BridgeHandler();
});

function req(method: string, params?: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function mcpCall(name: string, args: Record<string, unknown>, id: number | string = 1) {
  return { jsonrpc: "2.0" as const, id, method: "tools/call", params: { name, arguments: args } };
}

function mcpText(res: { result?: unknown }): { text: string; isError: boolean } {
  const r = res.result as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
}

// A small collection with a level-gated entry so we get a guaranteed exclusion.
const COLLECTION = {
  version: "2.0",
  tables: [
    {
      table: "loot",
      kind: "loot",
      entries: [
        { name: "Gold", weight: 5, roll: "2d6*10" },
        { name: "Gem", weight: 3 },
        { name: "Dragon Hoard", weight: 2, minLevel: 12 },
      ],
    },
  ],
};

// ─── FT-INT-002 / FT-ANA-001: table analysis on the wire ──────────────────────

describe("FT-ANA-001 — bridge table_analyze", () => {
  it("returns entry selection probabilities summing to ~1 with an excluded entry", () => {
    handler.handle(req("table_load", { collection: COLLECTION }));
    const res = handler.handle(req("table_analyze", { table: "loot", context: { level: 5 } }));
    expect(res.error).toBeUndefined();
    const result = res.result as {
      entries: { entry: { name: string }; probability: number; valueMean?: number }[];
      excluded: { entry: { name: string }; reason: string }[];
    };
    // Gold + Gem are eligible at level 5; Dragon Hoard (minLevel 12) is excluded.
    const total = result.entries.reduce((s, e) => s + e.probability, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(result.entries.map((e) => e.entry.name).sort()).toEqual(["Gem", "Gold"]);
    expect(result.excluded.length).toBeGreaterThan(0);
    const dragon = result.excluded.find((e) => e.entry.name === "Dragon Hoard");
    expect(dragon).toBeDefined();
    expect(typeof dragon!.reason).toBe("string");
    expect(dragon!.reason.length).toBeGreaterThan(0);
    // Gold has a value dice expression → a value mean.
    const gold = result.entries.find((e) => e.entry.name === "Gold")!;
    expect(typeof gold.valueMean).toBe("number");
    expect(gold.valueMean).toBeCloseTo(70, 0); // 2d6*10 mean = 70
  });

  it("table_analyze works by name within a posted collection (mirrors table_roll)", () => {
    handler.handle(req("table_load", { collection: COLLECTION }));
    const res = handler.handle(req("table_analyze", { table: "loot" }));
    expect(res.error).toBeUndefined();
    const result = res.result as { entries: unknown[] };
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it("returns INVALID_PARAMS for an unloaded table", () => {
    const res = handler.handle(req("table_analyze", { table: "nope" }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });

  it("value distributions are serialized as tuple arrays, not bare Maps", () => {
    handler.handle(req("table_load", { collection: COLLECTION }));
    const res = handler.handle(req("table_analyze", { table: "loot" }));
    const result = res.result as {
      entries: { entry: { name: string }; valueDistribution?: unknown }[];
    };
    const gold = result.entries.find((e) => e.entry.name === "Gold")!;
    expect(Array.isArray(gold.valueDistribution)).toBe(true);
    // No Map leak: round-trips through JSON without losing the distribution.
    const roundTripped = JSON.parse(JSON.stringify(res.result)) as {
      entries: { entry: { name: string }; valueDistribution?: unknown }[];
    };
    const goldRT = roundTripped.entries.find((e) => e.entry.name === "Gold")!;
    expect(Array.isArray(goldRT.valueDistribution)).toBe(true);
    expect((goldRT.valueDistribution as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("FT-ANA-001 — MCP analyze_table", () => {
  it("returns the same analysis, JSON-serializable (no Map leaks)", () => {
    const res = handleRequest(
      mcpCall("analyze_table", { table_name: "loot", collection: COLLECTION, context: { level: 5 } }),
    );
    const { text, isError } = mcpText(res);
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as {
      entries: { entry: { name: string }; probability: number; valueDistribution?: unknown }[];
      excluded: { entry: { name: string }; reason: string }[];
    };
    const total = parsed.entries.reduce((s, e) => s + e.probability, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(parsed.excluded.some((e) => e.entry.name === "Dragon Hoard")).toBe(true);
    const gold = parsed.entries.find((e) => e.entry.name === "Gold")!;
    expect(Array.isArray(gold.valueDistribution)).toBe(true);
    expect((gold.valueDistribution as unknown[]).length).toBeGreaterThan(0);
  });

  it("is in the tool list with table_name + collection required", () => {
    const res = handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools;
    const tool = tools.find((t) => t.name === "analyze_table");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain("table_name");
    expect(tool!.inputSchema.required).toContain("collection");
  });

  it("missing collection → clean validation error (isError, no stack)", () => {
    const res = handleRequest(mcpCall("analyze_table", { table_name: "loot" }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("Error:");
    expect(text).not.toContain("at "); // no stack frames
  });

  it("unknown table name → clean validation error", () => {
    const res = handleRequest(mcpCall("analyze_table", { table_name: "ghost", collection: COLLECTION }));
    const { isError } = mcpText(res);
    expect(isError).toBe(true);
  });
});

// ─── FT-ANA-002: comparison as probability ────────────────────────────────────

type VersusBlock = { pAGreater: number; pEqual: number; pBGreater: number; marginMean: number };
type CompareEntry = { expression: string; stats: { mean: number }; method: string; versus: VersusBlock };

describe("FT-ANA-002 — bridge compare includes win probabilities (additive)", () => {
  it("includes pAGreater/pEqual/pBGreater + margin mean for 2d6+10 vs 1d4", () => {
    const res = handler.handle(req("compare", { expressions: ["2d6+10", "1d4"] }));
    expect(res.error).toBeUndefined();
    // The EXISTING top-level array of two per-expression entries is preserved
    // positionally; the new `versus` verdict rides on each entry (so it survives
    // JSON.stringify, which drops stray array properties).
    const result = res.result as CompareEntry[];
    expect(result).toHaveLength(2);
    expect(result[0]!.stats.mean).toBeGreaterThan(result[1]!.stats.mean);
    const versus = result[0]!.versus;
    expect(versus).toBeDefined();
    expect(versus.pAGreater).toBeCloseTo(1, 6); // 2d6+10 (min 12) always beats 1d4 (max 4)
    expect(versus.pEqual).toBeCloseTo(0, 6);
    expect(versus.pBGreater).toBeCloseTo(0, 6);
    expect(versus.marginMean).toBeGreaterThan(0);
    // Survives a JSON round-trip (the real wire) — versus is NOT lost.
    const rt = JSON.parse(JSON.stringify(res.result)) as CompareEntry[];
    expect(rt).toHaveLength(2);
    expect(rt[0]!.versus.pAGreater).toBeCloseTo(1, 6);
  });

  it("preserves method on each per-expression entry (existing observability)", () => {
    const res = handler.handle(req("compare", { expressions: ["2d6", "1d12"] }));
    const result = res.result as CompareEntry[];
    expect(result.every((r) => r.method === "exact")).toBe(true);
  });
});

describe("FT-ANA-002 — MCP compare_dice includes win-probability verdict", () => {
  it("includes the versus block (on each entry) for 2d6+10 vs 1d4", () => {
    const res = handleRequest(mcpCall("compare_dice", { expression_a: "2d6+10", expression_b: "1d4" }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as CompareEntry[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.versus.pAGreater).toBeCloseTo(1, 6);
    expect(parsed[0]!.stats.mean).toBeGreaterThan(parsed[1]!.stats.mean);
  });
});

// ─── FT-ANA-003: query family on the wire ─────────────────────────────────────

describe("FT-ANA-003 — bridge at_most / exactly / between for 2d6", () => {
  it("at_most returns P(X <= 7) for 2d6", () => {
    const res = handler.handle(req("at_most", { expression: "2d6", target: 7 }));
    expect(res.error).toBeUndefined();
    const result = res.result as { probability: number; target: number };
    expect(result.target).toBe(7);
    expect(result.probability).toBeCloseTo(21 / 36, 6); // P(2d6 <= 7) = 21/36
  });

  it("exactly returns P(X === 7) for 2d6", () => {
    const res = handler.handle(req("exactly", { expression: "2d6", target: 7 }));
    expect(res.error).toBeUndefined();
    const result = res.result as { probability: number; target: number };
    expect(result.probability).toBeCloseTo(6 / 36, 6); // P(2d6 === 7) = 6/36
  });

  it("between returns P(5 <= X <= 9) for 2d6", () => {
    const res = handler.handle(req("between", { expression: "2d6", lo: 5, hi: 9 }));
    expect(res.error).toBeUndefined();
    const result = res.result as { probability: number; lo: number; hi: number };
    expect(result.lo).toBe(5);
    expect(result.hi).toBe(9);
    // P(5..9) = (4+5+6+5+4)/36 = 24/36
    expect(result.probability).toBeCloseTo(24 / 36, 6);
  });

  it("at_most missing target → INVALID_PARAMS", () => {
    const res = handler.handle(req("at_most", { expression: "2d6" }));
    expect(res.error!.code).toBe(-32602);
  });

  it("between missing bounds → INVALID_PARAMS", () => {
    const res = handler.handle(req("between", { expression: "2d6", lo: 5 }));
    expect(res.error!.code).toBe(-32602);
  });

  it("over-complex expression on a query method → INVALID_PARAMS (ParseError mapped)", () => {
    const res = handler.handle(req("at_most", { expression: "20000d6", target: 5 }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });
});

describe("FT-ANA-003 — MCP analyze_dice surfaces the query family additively", () => {
  it("includes a query block (atMost/exactly/range) when a target is given", () => {
    const res = handleRequest(
      mcpCall("analyze_dice", { expression: "2d6", at_most: 7, exactly: 7, between: [5, 9] }),
    );
    const { text, isError } = mcpText(res);
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as {
      stats: unknown;
      query?: { atMost?: { target: number; probability: number }; exactly?: { target: number; probability: number }; between?: { lo: number; hi: number; probability: number } };
    };
    expect(parsed.query).toBeDefined();
    expect(parsed.query!.atMost!.probability).toBeCloseTo(21 / 36, 6);
    expect(parsed.query!.exactly!.probability).toBeCloseTo(6 / 36, 6);
    expect(parsed.query!.between!.probability).toBeCloseTo(24 / 36, 6);
  });

  it("analyze_dice without query args is unchanged (no query block, stats present)", () => {
    const res = handleRequest(mcpCall("analyze_dice", { expression: "2d6" }));
    const { text } = mcpText(res);
    const parsed = JSON.parse(text) as { stats: { mean: number }; query?: unknown };
    expect(parsed.stats.mean).toBeCloseTo(7, 1);
    expect(parsed.query).toBeUndefined();
  });
});

// ─── FT-INT-008: MCP serverInfo.version from package.json ──────────────────────

describe("FT-INT-008 — MCP serverInfo.version reads from package.json", () => {
  it("initialize reports the package.json version (not a hardcoded literal)", () => {
    const res = handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const result = res.result as { serverInfo: { version: string; name: string } };
    expect(result.serverInfo.version).toBe(pkg.version);
    expect(result.serverInfo.name).toBe("roll");
  });
});
