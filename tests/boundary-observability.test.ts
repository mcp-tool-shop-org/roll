/**
 * Boundary observability + resilience tests (Stage B proactive).
 *
 * Findings under test:
 *   P-BND-001 — injectable logger seam: the "Roll bridge listening…" banner and
 *               internal-error detail route through a Logger, not console/stderr
 *               directly. A no-op sink silences them; a capturing sink sees them.
 *   P-BND-002 — opt-in request observability: verbose mode logs ONE structured
 *               line per request through the seam; OFF by default.
 *   P-BND-009 — graceful degradation: a bad line/response does not kill the loop.
 *   P-BND-008 — roll_batch per-item resilience: one bad expression yields a
 *               per-item { expression, error } entry; the others still succeed.
 *   P-BND-007 — shared error taxonomy: MCP uses the bridge's RPC_* codes.
 *   P-BND-005 — MCP initialize echoes the client's requested protocolVersion.
 *   Task 8    — analyze/at_least/compare (bridge) and analyze_dice (MCP) surface
 *               the analyzer's `method` (and `samples` for monte-carlo).
 *
 * In-process only — no child processes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BridgeHandler } from "../src/bridge/handler.js";
import { runHttp } from "../src/bridge/server.js";
import { dispatch, handleRequest, setLogger } from "../src/mcp/server.js";
import {
  stderrLogger,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
} from "../src/bridge/protocol.js";
import type { Logger } from "../src/bridge/protocol.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/bridge/protocol.js";
import type { Server, AddressInfo } from "node:http";

/** A Logger that records every line it receives, by channel. */
function capturingLogger(): Logger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    info: (msg: string) => infos.push(msg),
    error: (msg: string) => errors.push(msg),
  };
}

/** A Logger that drops everything (the test no-op sink). */
const noopLogger: Logger = { info: () => {}, error: () => {} };

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

// ─── P-BND-001: logger seam (banner + internal-error routing) ─────────────────

describe("P-BND-001 — injectable logger seam", () => {
  it("the listening banner goes to the injected logger, NOT the console/stderr", async () => {
    const log = capturingLogger();
    // Spy on the real stderr/stdout to prove the banner did not leak there.
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const server = runHttp(0, "127.0.0.1", log);
    await new Promise<void>((resolve) => server.once("listening", resolve));

    // Banner captured by the injected sink.
    expect(log.infos.some((l) => l.includes("Roll bridge listening"))).toBe(true);
    // And NOT written to the real stderr / console.
    const stderrText = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).not.toContain("Roll bridge listening");
    expect(outSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
    outSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bridge internal-error detail routes through the logger (not raw process.stderr)", () => {
    const log = capturingLogger();
    const handler = new BridgeHandler(log);
    // Force an unexpected (non-ParseError) throw by making the rng explode.
    const boom = new Error("SECRET-DETAIL token=abc");
    (handler as unknown as { rng: () => number }).rng = () => {
      throw boom;
    };
    const res = handler.handle(req("roll", { expression: "1d6" }));
    expect(res.error!.code).toBe(-32603); // INTERNAL_ERROR
    expect(res.error!.message).toBe("Internal error"); // generic, no detail on the wire
    // Detail captured by the seam, server-side only.
    expect(log.errors.join("")).toContain("SECRET-DETAIL");
  });

  it("MCP internal-error detail routes through the injected logger", () => {
    const log = capturingLogger();
    setLogger(log);
    try {
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
      expect(log.errors.join("")).toContain("RAW-LEAK");
    } finally {
      setLogger(stderrLogger); // restore the default for other suites
    }
  });

  it("the default stderrLogger writes a single newline-terminated line per channel", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stderrLogger.info("hello-info");
    stderrLogger.error("hello-error");
    const written = errSpy.mock.calls.map((c) => String(c[0]));
    expect(written).toContain("hello-info\n");
    expect(written).toContain("hello-error\n");
    errSpy.mockRestore();
  });
});

// ─── P-BND-002: opt-in request observability ──────────────────────────────────

describe("P-BND-002 — verbose request observability", () => {
  let server: Server;
  let base: string;
  let log: ReturnType<typeof capturingLogger>;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("verbose=true logs one structured line per request (method + id + outcome)", async () => {
    log = capturingLogger();
    server = runHttp(0, "127.0.0.1", log, /* verbose */ true);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    const r = await fetch(`${base}/rpc`, {
      method: "POST",
      body: JSON.stringify(req("ping", undefined, 7)),
    });
    expect(r.status).toBe(200);

    const trace = log.infos.filter((l) => l.includes("method=ping"));
    expect(trace.length).toBe(1);
    expect(trace[0]!).toContain("id=7");
    expect(trace[0]!).toContain("outcome=ok");
  });

  it("verbose=true logs the error code on a failed request", async () => {
    log = capturingLogger();
    server = runHttp(0, "127.0.0.1", log, true);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    await fetch(`${base}/rpc`, {
      method: "POST",
      body: JSON.stringify(req("nope_unknown", undefined, 9)),
    });

    const trace = log.infos.find((l) => l.includes("method=nope_unknown"));
    expect(trace).toBeDefined();
    expect(trace!).toContain("outcome=error");
    expect(trace!).toContain(`code=${RPC_METHOD_NOT_FOUND}`);
  });

  it("verbose OFF (default) emits NO per-request trace lines", async () => {
    log = capturingLogger();
    server = runHttp(0, "127.0.0.1", log /* no verbose */);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify(req("ping")) });

    // Only the banner should be present, never a per-request trace.
    expect(log.infos.some((l) => l.includes("method="))).toBe(false);
  });
});

// ─── P-BND-008: roll_batch per-item resilience ────────────────────────────────

describe("P-BND-008 — roll_batch per-item resilience", () => {
  let handler: BridgeHandler;
  beforeEach(() => {
    handler = new BridgeHandler(noopLogger);
  });

  it("one bad expression yields a per-item error; the others still succeed", () => {
    const res = handler.handle(
      req("roll_batch", { expressions: ["1d6", "not a roll", "2d8"], seed: 42 }),
    );
    // The whole batch is NOT voided — there is a result array, no top-level error.
    expect(res.error).toBeUndefined();
    const results = res.result as Array<{ total?: number; expression: string; error?: string }>;
    expect(results).toHaveLength(3);
    // Position 0 + 2 succeeded (have a numeric total).
    expect(typeof results[0]!.total).toBe("number");
    expect(typeof results[2]!.total).toBe("number");
    // Position 1 is a per-item error entry, positionally aligned, with the
    // offending expression echoed and a curated message (no internal detail).
    expect(results[1]!.total).toBeUndefined();
    expect(results[1]!.expression).toBe("not a roll");
    expect(typeof results[1]!.error).toBe("string");
    expect(results[1]!.error).not.toBe("Internal error");
  });

  it("an all-bad batch returns per-item errors, not a single opaque failure", () => {
    const res = handler.handle(req("roll_batch", { expressions: ["@@@", "###"] }));
    expect(res.error).toBeUndefined();
    const results = res.result as Array<{ error?: string; expression: string }>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => typeof r.error === "string")).toBe(true);
  });

  it("a clean batch is unchanged (no error keys)", () => {
    const res = handler.handle(req("roll_batch", { expressions: ["1d6", "2d8"], seed: 7 }));
    expect(res.error).toBeUndefined();
    const results = res.result as Array<{ total: number; error?: string }>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => typeof r.total === "number" && r.error === undefined)).toBe(true);
  });

  it("compare stays all-or-nothing (its 2-expression validation is unchanged)", () => {
    const res = handler.handle(req("compare", { expressions: ["1d6", "not a roll"] }));
    // compare is genuinely all-or-nothing → a single INVALID_PARAMS, no partial.
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(RPC_INVALID_PARAMS);
  });
});

// ─── Task 8: analyzer `method` surfaced on the wire ───────────────────────────

describe("analyzer method surfaced on the wire", () => {
  const handler = new BridgeHandler(noopLogger);

  it("bridge analyze includes method=exact for a small expression", () => {
    const res = handler.handle(req("analyze", { expression: "2d6" }));
    expect(res.error).toBeUndefined();
    const result = res.result as { method?: string; samples?: number };
    expect(result.method).toBe("exact");
    expect(result.samples).toBeUndefined(); // no samples on the exact path
  });

  it("bridge at_least includes method", () => {
    const res = handler.handle(req("at_least", { expression: "2d6", target: 7 }));
    const result = res.result as { method?: string };
    expect(result.method).toBe("exact");
  });

  it("bridge compare includes method on each entry", () => {
    const res = handler.handle(req("compare", { expressions: ["2d6", "1d12"] }));
    const results = res.result as Array<{ method?: string }>;
    expect(results.every((r) => r.method === "exact")).toBe(true);
  });

  it("MCP analyze_dice includes method", () => {
    const res = handleRequest(mcpCall("analyze_dice", { expression: "2d6" }));
    const { text, isError } = mcpText(res);
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { method?: string };
    expect(parsed.method).toBe("exact");
  });

  it("a monte-carlo fallback surfaces method=monte-carlo with a samples count", () => {
    // 500d1000 is within the dice budget but its exact support blows up, so the
    // analyzer falls back to Monte Carlo — the wire must label it as sampled.
    const res = handler.handle(req("analyze", { expression: "500d1000" }));
    expect(res.error).toBeUndefined();
    const result = res.result as { method?: string; samples?: number };
    expect(result.method).toBe("monte-carlo");
    expect(typeof result.samples).toBe("number");
    expect(result.samples!).toBeGreaterThan(0);
  });
});

// ─── P-BND-007: shared error taxonomy (MCP uses RPC_* codes) ──────────────────

describe("P-BND-007 — MCP uses the shared RPC_* error taxonomy", () => {
  it("parse error → RPC_PARSE_ERROR", () => {
    const res = dispatch("garbage{{{") as JsonRpcResponse;
    expect(res.error!.code).toBe(RPC_PARSE_ERROR);
  });

  it("empty batch → RPC_INVALID_REQUEST", () => {
    const res = dispatch("[]") as JsonRpcResponse;
    expect(res.error!.code).toBe(RPC_INVALID_REQUEST);
  });

  it("unknown method → RPC_METHOD_NOT_FOUND", () => {
    const res = handleRequest({ jsonrpc: "2.0", id: 1, method: "bogus/method" });
    expect(res.error!.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it("missing tool name → RPC_INVALID_PARAMS", () => {
    const res = handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect(res.error!.code).toBe(RPC_INVALID_PARAMS);
  });
});

// ─── P-BND-005: MCP initialize echoes the client's protocolVersion ────────────

describe("P-BND-005 — MCP initialize protocol negotiation", () => {
  it("echoes the client's requested protocolVersion when present", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const result = res.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("falls back to the server default when the client sends none", () => {
    const res = handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const result = res.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe("2024-11-05");
  });
});

// ─── P-BND-001 / P-BND-009: import is side-effect-free (no stray console) ──────

describe("importing the boundary modules produces no stray console output", () => {
  it("a fresh import of server.ts / mcp/server.ts emits nothing to console/stderr", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errLogSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const bridge = await import("../src/bridge/server.js");
    const mcp = await import("../src/mcp/server.js");
    // The modules expose their seams and did NOT auto-start anything on import.
    expect(typeof bridge.runHttp).toBe("function");
    expect(typeof mcp.dispatch).toBe("function");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errLogSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errLogSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
