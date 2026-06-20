#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BridgeHandler } from "./handler.js";
import type { JsonRpcResponse } from "./protocol.js";

const handler = new BridgeHandler();

// ─── HTTP hardening limits (M4 / F-BM-004) ───────────────────────────────────
/** Max request body. Dice expressions are tiny; table collections a bit larger.
 *  64 KB is generous for legitimate use and caps unbounded-body memory abuse. */
const MAX_BODY_BYTES = 64 * 1024;
/** Idle/request socket timeout. A slow-loris client must not pin a connection. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A batch (array) response is never a shutdown; only a single response can be. */
function isShutdownResponse(response: JsonRpcResponse | JsonRpcResponse[]): boolean {
  if (Array.isArray(response)) return false;
  return (
    response.result !== undefined &&
    typeof response.result === "object" &&
    response.result !== null &&
    "shutdown" in response.result
  );
}

// ─── Stdio transport ─────────────────────────────────────────────────────────

function runStdio(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const response = handler.handleRaw(trimmed);
    process.stdout.write(JSON.stringify(response) + "\n");

    // Check for shutdown (single responses only).
    if (isShutdownResponse(response)) {
      process.exit(0);
    }
  });

  rl.on("close", () => process.exit(0));
}

// ─── HTTP transport ──────────────────────────────────────────────────────────

export function runHttp(port: number, host: string): Server {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST /rpc only" }));
      return;
    }

    // Enforce a max body size (M4 / F-BM-004). Accumulate bytes, not chars, and
    // reject + destroy the moment we cross the cap so a hostile client can't
    // stream an unbounded body into memory.
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Request body exceeds ${MAX_BODY_BYTES} bytes` }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString("utf8");
      const response = handler.handleRaw(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));

      if (isShutdownResponse(response)) {
        server.close();
      }
    });
  });

  // Per-request timeout so a slow/stalled client cannot pin a connection open.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.on("connection", (socket) => {
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  });

  // Bind to the requested host. Default 127.0.0.1 (loopback only) so the
  // server is not silently reachable on all interfaces — the log now matches
  // reality. External binding requires explicit --host opt-in.
  server.listen(port, host, () => {
    process.stderr.write(`Roll bridge listening on http://${host}:${port}/rpc\n`);
  });

  return server;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main(): void {
  const { values } = parseArgs({
    options: {
      stdio: { type: "boolean", default: false },
      http: { type: "boolean", default: false },
      port: { type: "string", default: "3947" },
      // Default loopback-only. Pass --host 0.0.0.0 to expose on all interfaces
      // (explicit opt-in, e.g. for a containerized bridge).
      host: { type: "string", default: "127.0.0.1" },
    },
    strict: false,
  });

  if (values.http) {
    runHttp(parseInt(values.port as string, 10), values.host as string);
  } else {
    // Default to stdio
    runStdio();
  }
}

// Only auto-start when invoked as a binary, not when imported in tests
// (importing must not block on stdin). (pathToFileURL normalizes Windows paths.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
