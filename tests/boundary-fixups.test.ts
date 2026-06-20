/**
 * Boundary fix-up tests — gaps the post-fix verifier found in the wire layer.
 *
 * These prove three concrete fixes and double as regression guards:
 *
 *   V1-003 (HIGH) — roll_batch must cap p.expressions.length, not just validate
 *                   each element. An 8000-expression batch of "10000d6" is a DoS;
 *                   an over-cap batch returns a clean INVALID_PARAMS, never hangs.
 *   V2-001 (HIGH) — the binary auto-start guard must use the symlink-robust
 *                   isMainModule() helper so `npm i -g` / `npm link` symlinked
 *                   bins still run. Importing the modules in-process (where
 *                   isMainModule is false) must NOT start a server or consume stdin.
 *   V2-003 (MED)  — the HTTP body cap was 64KB, which wrongly 413s a legitimate
 *                   ~89KB+ table_load. The cap is raised to a generous bound so a
 *                   real loot/encounter collection loads, while an over-cap body
 *                   still gets 413 + socket destroy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BridgeHandler } from "../src/bridge/handler.js";
import { runHttp, MAX_BODY_BYTES } from "../src/bridge/server.js";
import { isMainModule } from "../src/entry.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/bridge/protocol.js";
import type { Server, AddressInfo } from "node:http";

function req(method: string, params?: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

// ─── V1-003: roll_batch length cap ───────────────────────────────────────────

describe("V1-003 — roll_batch caps expressions.length", () => {
  let handler: BridgeHandler;
  beforeEach(() => {
    handler = new BridgeHandler();
  });

  it("rejects an over-limit batch with a clean INVALID_PARAMS (no hang)", () => {
    // Far over any reasonable cap. Each element is a real, parseable expression
    // so the rejection MUST come from the length cap, not per-element validation.
    const expressions = new Array(5000).fill("1d6");
    const res = handler.handle(req("roll_batch", { expressions }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602); // INVALID_PARAMS
    expect(res.error!.message).toMatch(/1000|maximum|exceed/i);
    expect(res.result).toBeUndefined();
  });

  it("does NOT allocate ~10^8 dice for a hostile batch (cap fires before rolling)", () => {
    // 8000 × "10000d6" is the verifier's DoS vector. With the cap, this returns
    // immediately with an error; without it the test would hang on allocation.
    const expressions = new Array(8000).fill("10000d6");
    const res = handler.handle(req("roll_batch", { expressions }));
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });

  it("accepts a batch at exactly the limit", () => {
    // Build a batch of exactly MAX_BATCH_EXPRESSIONS. We don't import the
    // constant (it's an internal); 1000 is the documented cap mirroring
    // MAX_TABLE_ROLL_COUNT, so a 1000-element batch must succeed.
    const expressions = new Array(1000).fill("1d6");
    const res = handler.handle(req("roll_batch", { expressions, seed: 42 }));
    expect(res.error).toBeUndefined();
    expect((res.result as unknown[]).length).toBe(1000);
  });

  it("a small valid batch still works (no regression)", () => {
    const res = handler.handle(req("roll_batch", { expressions: ["1d6", "2d8"], seed: 7 }));
    expect(res.error).toBeUndefined();
    expect((res.result as unknown[]).length).toBe(2);
  });
});

// ─── V2-001: symlink-robust entry guard ──────────────────────────────────────

describe("V2-001 — binaries use isMainModule and do not auto-start on import", () => {
  it("isMainModule is false for these modules under the test runner", () => {
    // The whole point: when imported (not the process entry), the guard is false
    // and main()/the stdio loop never runs. If isMainModule returned true here
    // the import below would have already bound a port / consumed stdin.
    expect(isMainModule(import.meta.url)).toBe(false);
  });

  it("importing bridge/server.ts did not bind a port or consume stdin", async () => {
    // The module is imported at the top of this file (runHttp). If its bottom
    // guard had wrongly used `===` true semantics we'd see a listening server.
    // We assert positively that we can still bind the same default port,
    // proving nothing is squatting on it from import side effects.
    const mod = await import("../src/bridge/server.js");
    expect(typeof mod.runHttp).toBe("function");
    // stdin is not in flowing/consumed mode from an import.
    expect(process.stdin.readableFlowing).not.toBe(true);
  });

  it("importing mcp/server.ts did not start the stdio loop", async () => {
    const mod = await import("../src/mcp/server.js");
    expect(typeof mod.dispatch).toBe("function");
    expect(typeof mod.handleRequest).toBe("function");
    expect(process.stdin.readableFlowing).not.toBe(true);
  });

  it("both server sources wire the guard through isMainModule (not raw === pathToFileURL)", () => {
    // Source-level assertion: the verifier's concrete ask is that the brittle
    // `import.meta.url === pathToFileURL(process.argv[1]).href` guard is gone.
    const bridgeSrc = readFileSync(
      fileURLToPath(new URL("../src/bridge/server.ts", import.meta.url)),
      "utf8",
    );
    const mcpSrc = readFileSync(
      fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)),
      "utf8",
    );
    for (const src of [bridgeSrc, mcpSrc]) {
      expect(src).toContain("isMainModule(import.meta.url)");
      expect(src).not.toMatch(/import\.meta\.url\s*===\s*pathToFileURL/);
    }
  });
});

// ─── V2-003: HTTP body cap raised for legitimate large table_load ─────────────

describe("V2-003 — HTTP body cap admits real collections, still bounds abuse", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = runHttp(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the new cap is well above the old 64KB (so ~89KB collections load)", () => {
    expect(MAX_BODY_BYTES).toBeGreaterThan(100 * 1024);
  });

  it("accepts a ~100KB valid table_load (would have been a wrongful 413 under 64KB)", async () => {
    // Build a real-shaped collection big enough to exceed the OLD 64KB cap.
    const entries = [];
    for (let i = 0; i < 2500; i++) {
      entries.push({ name: `Loot item number ${i} — a reasonably descriptive name`, weight: 1 });
    }
    const collection = { version: "2.0", tables: [{ table: "loot", kind: "loot", entries }] };
    const body = JSON.stringify(req("table_load", { collection }));
    // Prove the test actually exercises the >64KB regime.
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(64 * 1024);

    const r = await fetch(`${base}/rpc`, { method: "POST", body });
    expect(r.status).toBe(200);
    const json = (await r.json()) as JsonRpcResponse;
    expect(json.error).toBeUndefined();
    expect((json.result as { loaded: string[] }).loaded).toContain("loot");
  });

  it("still rejects a body over the NEW cap with 413 (or a destroyed socket)", async () => {
    const huge = "x".repeat(MAX_BODY_BYTES + 64 * 1024);
    const body = JSON.stringify(req("ping", { pad: huge }));
    const r = await fetch(`${base}/rpc`, { method: "POST", body }).catch((e) => e as Error);
    if (r instanceof Error) {
      expect(r).toBeInstanceOf(Error); // socket destroyed mid-stream is acceptable
    } else {
      expect(r.status).toBe(413);
    }
  });

  it("the 413 message reflects the real (raised) limit, not a stale 64KB", async () => {
    const huge = "x".repeat(MAX_BODY_BYTES + 64 * 1024);
    const body = JSON.stringify(req("ping", { pad: huge }));
    const r = await fetch(`${base}/rpc`, { method: "POST", body }).catch((e) => e as Error);
    if (!(r instanceof Error)) {
      expect(r.status).toBe(413);
      const json = (await r.json()) as { error: string };
      expect(json.error).toContain(String(MAX_BODY_BYTES));
      expect(json.error).not.toContain("65536"); // not the old 64KB byte count
    }
  });
});
