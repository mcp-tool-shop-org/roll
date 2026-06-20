#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { parseArgs } from "node:util";
import { BridgeHandler } from "./handler.js";
import { isMainModule } from "../entry.js";
import {
  RPC_INTERNAL_ERROR,
  stderrLogger,
} from "./protocol.js";
import type { JsonRpcResponse, Logger } from "./protocol.js";

// ─── HTTP hardening limits (M4 / F-BM-004) ───────────────────────────────────
/** Max request body. Dice expressions are tiny, but `table_load` carries a whole
 *  game collection: a real loot/encounter set (~2000+ entries) is ~90 KB, so the
 *  former 64 KB cap wrongly 413'd legitimate loads. 8 MB is generous enough for
 *  any honest collection while still bounding unbounded-body memory abuse and
 *  slow-loris streaming. Exported so tests assert against the real value. (V2-003) */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Idle/request socket timeout. A slow-loris client must not pin a connection. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Cap on concurrent connections (P-BND-003). A sane bound so a connection flood
 *  cannot exhaust file descriptors / memory; honest clients never approach it. */
const MAX_CONNECTIONS = 256;

/** Opt-in request observability (P-BND-002). OFF by default (quiet operation).
 *  Enabled by `--verbose` or env `ROLL_BRIDGE_DEBUG`. When on, ONE structured
 *  line per request is emitted through the logger seam. */
function isDebugEnabled(flag: boolean | undefined): boolean {
  if (flag) return true;
  const env = process.env.ROLL_BRIDGE_DEBUG;
  return env !== undefined && env !== "" && env !== "0" && env.toLowerCase() !== "false";
}

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

/**
 * Emit one structured trace line per request when debug is on (P-BND-002):
 * method, id, outcome (ok|error), and the error code on failure. Pairs the
 * parsed request(s) with their response(s). Best-effort — never throws into the
 * hot path. A batch logs one line per element.
 */
function traceRequest(
  logger: Logger,
  raw: string,
  response: JsonRpcResponse | JsonRpcResponse[],
): void {
  try {
    const responses = Array.isArray(response) ? response : [response];
    let requests: unknown[];
    try {
      const parsed = JSON.parse(raw);
      requests = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      requests = [];
    }
    responses.forEach((res, i) => {
      const reqItem = requests[i] as { method?: unknown } | undefined;
      const method = typeof reqItem?.method === "string" ? reqItem.method : "?";
      const outcome = res.error ? "error" : "ok";
      const code = res.error ? ` code=${res.error.code}` : "";
      logger.info(`[roll-bridge] method=${method} id=${String(res.id)} outcome=${outcome}${code}`);
    });
  } catch {
    // Observability must never break request handling.
  }
}

/** Build an INTERNAL_ERROR response for a graceful-degradation path (P-BND-009)
 *  where the original id is unknown / unrecoverable. */
function internalErrorResponse(): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code: RPC_INTERNAL_ERROR, message: "Internal error" } };
}

// ─── Stdio transport ─────────────────────────────────────────────────────────

export function runStdio(logger: Logger = stderrLogger, verbose?: boolean): void {
  const handler = new BridgeHandler(logger);
  const debug = isDebugEnabled(verbose);
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    // P-BND-009: graceful degradation. A throw in handling OR serialization of
    // ONE line must not kill the loop — emit an INTERNAL_ERROR line and keep
    // serving. handleRaw is already total, but defense-in-depth covers any
    // future change and the JSON.stringify write (e.g. a circular result).
    let serialized: string;
    let response: JsonRpcResponse | JsonRpcResponse[];
    try {
      const trimmed = line.trim();
      if (!trimmed) return;
      response = handler.handleRaw(trimmed);
      serialized = JSON.stringify(response);
      if (debug) traceRequest(logger, trimmed, response);
    } catch (e) {
      const detail = e instanceof Error ? e.stack ?? e.message : String(e);
      logger.error(`[roll-bridge] line handler fault: ${detail}`);
      try {
        process.stdout.write(JSON.stringify(internalErrorResponse()) + "\n");
      } catch {
        /* stdout itself failed — nothing more we can safely do; keep serving. */
      }
      return;
    }

    process.stdout.write(serialized + "\n");

    // Check for shutdown (single responses only).
    if (isShutdownResponse(response)) {
      process.exit(0);
    }
  });

  rl.on("close", () => process.exit(0));
}

// ─── HTTP transport ──────────────────────────────────────────────────────────

export function runHttp(port: number, host: string, logger: Logger = stderrLogger, verbose?: boolean): Server {
  const handler = new BridgeHandler(logger);
  const debug = isDebugEnabled(verbose);
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
        res.end(JSON.stringify({ error: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit` }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      // P-BND-009: graceful degradation. A fault handling/serializing ONE
      // request must not crash the server; respond 500 with an INTERNAL_ERROR
      // body and keep listening.
      let body: string;
      let response: JsonRpcResponse | JsonRpcResponse[];
      let serialized: string;
      try {
        body = Buffer.concat(chunks).toString("utf8");
        response = handler.handleRaw(body);
        serialized = JSON.stringify(response);
        if (debug) traceRequest(logger, body, response);
      } catch (e) {
        const detail = e instanceof Error ? e.stack ?? e.message : String(e);
        logger.error(`[roll-bridge] request handler fault: ${detail}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(internalErrorResponse()));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(serialized);

      if (isShutdownResponse(response)) {
        server.close();
      }
    });
  });

  // Per-request timeout so a slow/stalled client cannot pin a connection open.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  // Cap concurrent connections (P-BND-003) so a flood can't exhaust resources.
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (socket) => {
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  });

  // Bind to the requested host. Default 127.0.0.1 (loopback only) so the
  // server is not silently reachable on all interfaces — the log now matches
  // reality. External binding requires explicit --host opt-in. Banner routes
  // through the injectable logger (P-BND-001) so a host can silence it / tests
  // can capture it instead of polluting stdout/stderr.
  server.listen(port, host, () => {
    logger.info(`Roll bridge listening on http://${host}:${port}/rpc`);
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
      // Opt-in request observability (P-BND-002): one structured line per
      // request through the logger. OFF unless --verbose or ROLL_BRIDGE_DEBUG.
      verbose: { type: "boolean", default: false },
    },
    strict: false,
  });

  const logger = stderrLogger;
  const verbose = values.verbose as boolean;

  // P-BND-009: top-level resilience. An uncaught exception / unhandled rejection
  // should be logged via the seam and NOT tear the process down — the bridge is
  // a long-lived server; one stray async fault must not stop it serving.
  process.on("uncaughtException", (e) => {
    logger.error(`[roll-bridge] uncaughtException: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`[roll-bridge] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  if (values.http) {
    const server = runHttp(parseInt(values.port as string, 10), values.host as string, logger, verbose);
    // P-BND-003: graceful lifecycle. On SIGTERM/SIGINT stop accepting new
    // connections, drain, then exit cleanly (rather than dropping in-flight
    // requests on an abrupt kill).
    const shutdown = (signal: string): void => {
      logger.info(`[roll-bridge] received ${signal}, shutting down`);
      server.close(() => process.exit(0));
      // Failsafe: force-exit if close() stalls on a lingering keep-alive socket.
      setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } else {
    // Default to stdio
    runStdio(logger, verbose);
  }
}

// Only auto-start when invoked as a binary, not when imported in tests
// (importing must not block on stdin). isMainModule() realpaths both sides so a
// symlinked `npm i -g` / `npm link` bin still starts — the old href-equality
// guard compared the symlink path against the realpath'd target and never
// matched, silently disabling the published `roll-bridge` binary. (V2-001)
if (isMainModule(import.meta.url)) {
  main();
}
