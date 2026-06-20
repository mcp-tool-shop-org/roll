/**
 * Boundary security tests — the wire-facing trust boundary.
 *
 * These tests double as the missing unit coverage for the dispatch layer
 * (bridge handler + MCP dispatch were previously untested directly). They
 * exercise the handler/dispatch functions in-process — no child processes.
 *
 * Findings under test:
 *   M3  / F-BM-003 — internal error text must not leak; ParseError → INVALID_PARAMS
 *   M4  / F-BM-004 — HTTP body cap + timeout + loopback bind
 *   M11 / F-BM-008 — MCP tool args validated (no NaN loop, no leaked TypeError)
 *   F-BM-005       — table_roll count capped; table_load collection shape validated
 *   F-BM-006       — JSON-RPC batch handling + null id preserved
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BridgeHandler } from "../src/bridge/handler.js";
import { dispatch, handleRequest } from "../src/mcp/server.js";
import { runHttp } from "../src/bridge/server.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/bridge/protocol.js";
import type { Server, AddressInfo } from "node:http";

let handler: BridgeHandler;

beforeEach(() => {
  handler = new BridgeHandler();
});

function req(method: string, params?: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

/** Build an MCP tools/call request envelope. */
function mcpCall(name: string, args: Record<string, unknown>, id: number | string = 1) {
  return { jsonrpc: "2.0" as const, id, method: "tools/call", params: { name, arguments: args } };
}

/** Extract the text payload from an MCP tool result. */
function mcpText(res: { result?: unknown }): { text: string; isError: boolean } {
  const r = res.result as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, isError: r.isError === true };
}

// A minimal valid collection used across table tests.
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

// ─── M3 / F-BM-003: error-text leakage + ParseError classification ───────────

describe("M3 — error classification at the boundary", () => {
  it("over-cap dice via the bridge returns a clean INVALID_PARAMS (not a hang, not a leak)", () => {
    const res = handler.handle(req("roll", { expression: "20000d6" }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602); // INVALID_PARAMS
    expect(res.error!.message).toContain("10000"); // curated, user-facing cap message
    expect(res.error!.message).not.toBe("Internal error");
  });

  it("a malformed expression via the bridge is INVALID_PARAMS, not INTERNAL_ERROR", () => {
    const res = handler.handle(req("roll", { expression: "not a roll" }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602); // INVALID_PARAMS (ParseError)
  });

  it("an unexpected internal error returns the GENERIC message (not internal detail)", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Force an unexpected (non-ParseError) throw inside the try block by making
    // the table engine receive a loaded collection whose entry triggers a fault.
    // Simpler + deterministic: monkeypatch the rng to throw a raw Error.
    const boom = new Error("SECRET-INTERNAL-STATE /home/user/token=abc");
    (handler as unknown as { rng: () => number }).rng = () => {
      throw boom;
    };
    const res = handler.handle(req("roll", { expression: "1d6" }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32603); // INTERNAL_ERROR
    expect(res.error!.message).toBe("Internal error"); // generic, no detail
    expect(res.error!.message).not.toContain("SECRET-INTERNAL-STATE");
    // detail logged server-side only
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("SECRET-INTERNAL-STATE");
    errSpy.mockRestore();
  });

  it("over-cap dice via MCP returns a structured tool error with the curated cap message", () => {
    const res = handleRequest(mcpCall("roll_dice", { expression: "20000d6" }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("10000");
    expect(text).not.toContain("Internal error");
  });

  it("an unexpected internal error via MCP returns a generic message and logs detail", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // query_table on a collection whose tables array contains a non-object would
    // pass shape validation only if entries is an array... instead force a raw
    // fault: a collection whose `tables.find` is shadowed is hard; use a getter.
    const evil: Record<string, unknown> = {
      table_name: "x",
      get collection() {
        throw new Error("RAW-LEAK secret/path");
      },
    };
    const res = handleRequest(mcpCall("query_table", evil));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toBe("Error: Internal error");
    expect(text).not.toContain("RAW-LEAK");
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("RAW-LEAK");
    errSpy.mockRestore();
  });
});

// ─── M11 / F-BM-008: MCP arg validation ──────────────────────────────────────

describe("M11 — MCP tool args validated", () => {
  it("non-numeric `times` returns a structured error, not a NaN loop / crash", () => {
    const res = handleRequest(mcpCall("roll_dice", { expression: "1d6", times: "lots" }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("times");
  });

  it("missing `collection` on roll_table returns a structured error, not a leaked TypeError", () => {
    const res = handleRequest(mcpCall("roll_table", { table_name: "loot" }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("collection");
    expect(text).not.toContain("Cannot read"); // no raw TypeError text
  });

  it("missing required `expression` on roll_dice returns a structured error", () => {
    const res = handleRequest(mcpCall("roll_dice", {}));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("expression");
  });

  it("over-cap `times` (>1000) on roll_dice is rejected", () => {
    const res = handleRequest(mcpCall("roll_dice", { expression: "1d6", times: 100000 }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("1000");
  });

  it("a valid roll_dice call still works", () => {
    const res = handleRequest(mcpCall("roll_dice", { expression: "2d6", seed: 42 }));
    const { isError, text } = mcpText(res);
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toHaveProperty("total");
  });

  it("malformed collection (non-array tables) on roll_table is rejected", () => {
    const res = handleRequest(mcpCall("roll_table", { table_name: "loot", collection: { tables: "nope" } }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(true);
    expect(text).toContain("array");
  });
});

// ─── F-BM-005: table_roll count cap + table_load shape validation ─────────────

describe("F-BM-005 — table boundary hardening", () => {
  it("table_roll with a huge count is capped (INVALID_PARAMS)", () => {
    handler.handle(req("table_load", { collection }));
    const res = handler.handle(req("table_roll", { table: "loot", count: 1_000_000 }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain("1000");
  });

  it("table_roll with a non-integer count is rejected", () => {
    handler.handle(req("table_load", { collection }));
    const res = handler.handle(req("table_roll", { table: "loot", count: 2.5 }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });

  it("table_roll with a valid count still works", () => {
    handler.handle(req("table_load", { collection }));
    const res = handler.handle(req("table_roll", { table: "loot", count: 3 }));
    expect(res.error).toBeUndefined();
    expect((res.result as unknown[]).length).toBe(3);
  });

  it("table_load rejects a collection with non-array tables", () => {
    const res = handler.handle(req("table_load", { collection: { tables: "nope" } }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain("array");
  });

  it("table_load rejects a table missing its name / entries", () => {
    const res = handler.handle(req("table_load", { collection: { tables: [{ kind: "loot" }] } }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });

  it("table_load accepts a well-formed collection", () => {
    const res = handler.handle(req("table_load", { collection }));
    expect(res.error).toBeUndefined();
    expect((res.result as { loaded: string[] }).loaded).toContain("loot");
  });
});

// ─── F-BM-006: batch + null id ───────────────────────────────────────────────

describe("F-BM-006 — JSON-RPC batch + id handling (bridge)", () => {
  it("handles a batch (array) payload, returning an array of responses", () => {
    const raw = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const res = handler.handleRaw(raw) as JsonRpcResponse[];
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(2);
    expect(res[0].id).toBe(1);
    expect(res[1].id).toBe(2);
  });

  it("rejects an empty batch with INVALID_REQUEST", () => {
    const res = handler.handleRaw("[]") as JsonRpcResponse;
    expect(Array.isArray(res)).toBe(false);
    expect(res.error!.code).toBe(-32600);
  });

  it("preserves a null id (does not coerce to 0) on invalid request", () => {
    const res = handler.handleRaw(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" })) as JsonRpcResponse;
    // id null is "no id" per our validation → INVALID_REQUEST, id preserved as null
    expect(res.id).toBeNull();
  });

  it("preserves null id on a JSON parse error (not 0)", () => {
    const res = handler.handleRaw("not json {{{") as JsonRpcResponse;
    expect(res.error!.code).toBe(-32700);
    expect(res.id).toBeNull();
  });
});

describe("F-BM-006 — JSON-RPC batch + id handling (MCP dispatch)", () => {
  it("MCP dispatch handles a batch, omitting notification (no-id) responses", () => {
    const raw = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" }, // notification, no id
    ]);
    const res = dispatch(raw) as JsonRpcResponse[];
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(1);
  });

  it("MCP dispatch preserves null id on a parse error", () => {
    const res = dispatch("garbage{{{") as JsonRpcResponse;
    expect(res.error!.code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it("MCP dispatch returns null for a single notification (no response)", () => {
    const res = dispatch(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res).toBeNull();
  });
});

// ─── M4 / F-BM-004: HTTP body cap + bind ─────────────────────────────────────

describe("M4 — HTTP transport hardening", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    // Bind to an ephemeral loopback port in-process (no child process).
    server = runHttp(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("binds to loopback (127.0.0.1), not all interfaces", () => {
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("accepts a small valid request body", async () => {
    const r = await fetch(`${base}/rpc`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as JsonRpcResponse;
    expect(body.result).toEqual({ ok: true });
  });

  it("rejects an over-cap body with 413", async () => {
    // Craft a body over the 8MB cap. Server must respond 413 and destroy, not buffer it all.
    const huge = "x".repeat(8 * 1024 * 1024 + 1024);
    const r = await fetch(`${base}/rpc`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: huge } }),
    }).catch((e) => e as Error);
    if (r instanceof Error) {
      // Connection may be destroyed mid-stream — that is an acceptable rejection.
      expect(r).toBeInstanceOf(Error);
    } else {
      expect(r.status).toBe(413);
    }
  });
});
