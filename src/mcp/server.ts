#!/usr/bin/env node
/**
 * Roll MCP Server — Model Context Protocol server for the Roll dice engine.
 * Communicates via stdio using JSON-RPC 2.0 (MCP transport).
 */
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { isMainModule } from "../entry.js";
import { TOOLS } from "./tools.js";
import { parse, ParseError } from "../parser/parser.js";
import { LexerError } from "../parser/lexer.js";
import { evaluate } from "../engine/roller.js";
import { computeDistributionWithMethod } from "../analyze/distribution.js";
import {
  computeStats,
  probabilityAtLeast,
  probabilityAtMost,
  probabilityExactly,
  probabilityInRange,
} from "../analyze/stats.js";
import { seededRng, cryptoRng } from "../engine/random.js";
import { rollGameTable } from "../tables/engine.js";
import { analyzeCollection } from "../tables/analyze.js";
import { serializeTableAnalysis, makeVersus } from "../bridge/handler.js";
import type { RngFn } from "../engine/random.js";
import type { GameTableCollection, TableContext } from "../tables/schema.js";
// P-BND-007: one shared error taxonomy. Both transports speak the same JSON-RPC
// codes — import the named RPC_* constants from the bridge protocol instead of
// re-hardcoding -32700/-32600/-32601/-32602 as raw literals here.
import {
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  stderrLogger,
} from "../bridge/protocol.js";
import type { Logger } from "../bridge/protocol.js";

// ─── MCP Protocol types ──────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Thrown by argument validation at the trust boundary. Carries a curated,
 * user-facing message that is SAFE to return to the client (unlike unexpected
 * internal exceptions, whose text must never cross the boundary).
 */
class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

/** Upper bound on repeat-count style args (times / count). Dice are tiny; a
 *  caller asking for a million rolls is abuse, not a use case. */
const MAX_TOOL_COUNT = 1000;

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolValidationError(`Parameter "${key}" must be a non-empty string`);
  }
  return v;
}

/** Validate an optional count/times arg: must be a finite positive integer
 *  within the cap. Returns the default when absent. */
function optionalCount(
  args: Record<string, unknown>,
  key: string,
  def: number,
): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
    throw new ToolValidationError(`Parameter "${key}" must be a positive integer`);
  }
  if (v > MAX_TOOL_COUNT) {
    throw new ToolValidationError(
      `Parameter "${key}" (${v}) exceeds maximum of ${MAX_TOOL_COUNT}`,
    );
  }
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolValidationError(`Parameter "${key}" must be a number`);
  }
  return v;
}

/** Validate an optional [lo, hi] numeric pair (for the `between` query arg).
 *  Returns undefined when absent. Throws ToolValidationError (→ a clean isError
 *  response) when the shape is wrong. (FT-ANA-003) */
function optionalPair(
  args: Record<string, unknown>,
  key: string,
): [number, number] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    typeof v[0] !== "number" ||
    typeof v[1] !== "number" ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1])
  ) {
    throw new ToolValidationError(`Parameter "${key}" must be a [lo, hi] pair of numbers`);
  }
  return [v[0], v[1]];
}

/** Validate a GameTableCollection's shape at the boundary. Only structural
 *  checks — the engine guards roll-time invariants (zero-weight, etc.). */
function requireCollection(
  args: Record<string, unknown>,
  key: string,
): GameTableCollection {
  const c = args[key];
  if (typeof c !== "object" || c === null) {
    throw new ToolValidationError(`Parameter "${key}" must be a table collection object`);
  }
  const tables = (c as { tables?: unknown }).tables;
  if (!Array.isArray(tables)) {
    throw new ToolValidationError(`Parameter "${key}.tables" must be an array`);
  }
  for (const t of tables) {
    if (typeof t !== "object" || t === null) {
      throw new ToolValidationError(`Each table in "${key}.tables" must be an object`);
    }
    if (typeof (t as { table?: unknown }).table !== "string") {
      throw new ToolValidationError(`Each table requires a string "table" name`);
    }
    if (!Array.isArray((t as { entries?: unknown }).entries)) {
      throw new ToolValidationError(`Table "${(t as { table?: unknown }).table}" requires an "entries" array`);
    }
  }
  return c as GameTableCollection;
}

// ─── Server info ─────────────────────────────────────────────────────────────

// FT-INT-008: read the version from package.json (the single source of truth)
// the same way bin.ts does — via createRequire on a relative path. A hardcoded
// literal silently drifts on every version bump; reading it here makes the MCP
// serverInfo.version track the package automatically.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../../package.json") as { version: string };

const SERVER_INFO = {
  name: "roll",
  version: PKG_VERSION,
};

const CAPABILITIES = {
  tools: {},
};

/** The MCP protocol version this server implements when the client does not
 *  request one. `initialize` echoes the client's requested version when present
 *  (P-BND-005) so negotiation is honest. */
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

// ─── Logger seam (P-BND-001) ─────────────────────────────────────────────────
// Internal-error detail was written ad-hoc to process.stderr. Route it through
// an injectable sink so a host can silence/redirect and tests can capture it
// (defaults to the shared process.stderr-backed logger).
let activeLogger: Logger = stderrLogger;

/** Override the MCP server's log sink. Exported as a test/host seam. */
export function setLogger(logger: Logger): void {
  activeLogger = logger;
}

/** Spread-able method/samples fields for analyze-style results (P-CORE-001 wire
 *  surfacing). `samples` is present ONLY for the monte-carlo path. */
function methodFields(
  method: "exact" | "monte-carlo",
  samples: number | undefined,
): { method: "exact" | "monte-carlo"; samples?: number } {
  return samples !== undefined ? { method, samples } : { method };
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

function handleToolCall(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "roll_dice": {
      const expression = requireString(args, "expression");
      const times = optionalCount(args, "times", 1);
      const seed = optionalNumber(args, "seed");
      const rng: RngFn = seed !== undefined ? seededRng(seed) : cryptoRng;

      const results = [];
      for (let i = 0; i < times; i++) {
        const ast = parse(expression);
        const result = evaluate(ast, rng);
        result.expression = expression;
        results.push(result);
      }
      return times === 1 ? results[0] : results;
    }

    case "analyze_dice": {
      const expression = requireString(args, "expression");
      const ast = parse(expression);
      const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
      const stats = computeStats(dist);
      const distribution = [...dist.entries()].sort((a, b) => a[0] - b[0]);

      // Surface HOW the probability was produced (exact vs monte-carlo, with the
      // sample count) so Claude clients know whether it is exact or sampled.
      const result: Record<string, unknown> = { stats, distribution, ...methodFields(method, samples) };
      const atLeast = optionalNumber(args, "at_least");
      if (atLeast !== undefined) {
        result.atLeastProbability = probabilityAtLeast(dist, atLeast);
        result.atLeastTarget = atLeast;
      }

      // FT-ANA-003: surface the rest of the query family additively, so an LLM
      // gets P(<=x) / P(==x) / P(lo<=x<=hi) in the SAME call (no extra round
      // trips). Only the requested members appear; absent args add nothing, so
      // a plain analyze_dice is byte-for-byte unchanged.
      const atMost = optionalNumber(args, "at_most");
      const exactly = optionalNumber(args, "exactly");
      const between = optionalPair(args, "between");
      const query: Record<string, unknown> = {};
      if (atMost !== undefined) {
        query.atMost = { target: atMost, probability: probabilityAtMost(dist, atMost) };
      }
      if (exactly !== undefined) {
        query.exactly = { target: exactly, probability: probabilityExactly(dist, exactly) };
      }
      if (between !== undefined) {
        query.between = {
          lo: between[0],
          hi: between[1],
          probability: probabilityInRange(dist, between[0], between[1]),
        };
      }
      if (Object.keys(query).length > 0) result.query = query;
      return result;
    }

    case "compare_dice": {
      const exprA = requireString(args, "expression_a");
      const exprB = requireString(args, "expression_b");

      const analyze = (expr: string) => {
        const ast = parse(expr);
        const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
        return {
          dist,
          entry: { expression: expr, stats: computeStats(dist), ...methodFields(method, samples) },
        };
      };

      const a = analyze(exprA);
      const b = analyze(exprB);

      // FT-ANA-002: the result is the EXISTING [statsA, statsB] array (length 2,
      // positional fields untouched). The `versus` win-probability verdict is
      // attached to EACH entry — a stray array property would be dropped by the
      // JSON.stringify the dispatch wraps tool results in, so it must live on the
      // array elements to reach the client.
      const versus = makeVersus(a.dist, b.dist);
      return [
        { ...a.entry, versus },
        { ...b.entry, versus },
      ];
    }

    case "roll_table": {
      const tableName = requireString(args, "table_name");
      const collection = requireCollection(args, "collection");
      const context = (args.context ?? {}) as TableContext;
      const count = optionalCount(args, "count", 1);

      const results = [];
      for (let i = 0; i < count; i++) {
        results.push(...rollGameTable(collection, tableName, context));
      }
      return results;
    }

    case "query_table": {
      const tableName = requireString(args, "table_name");
      const collection = requireCollection(args, "collection");
      const table = collection.tables.find((t) => t.table === tableName);
      if (!table) throw new ToolValidationError(`Table not found: ${tableName}`);
      return table;
    }

    case "analyze_table": {
      // FT-INT-002 / FT-ANA-001: per-entry probabilities + value means + excluded
      // entries. Validates args the same way roll_table/query_table do (reusing
      // requireString + requireCollection). analyzeCollection throws a plain Error
      // for an unknown table name; translate it to a ToolValidationError so it
      // returns a clean isError response instead of leaking as an internal fault.
      const tableName = requireString(args, "table_name");
      const collection = requireCollection(args, "collection");
      const context = (args.context ?? {}) as TableContext;
      if (!collection.tables.some((t) => t.table === tableName)) {
        throw new ToolValidationError(`Table not found: ${tableName}`);
      }
      const analysis = analyzeCollection(collection, tableName, context);
      // Convert the value-distribution Maps to JSON-serializable tuple arrays so
      // no Map leaks as `{}` through JSON.stringify. Shared serializer with the
      // bridge so both transports emit the identical wire shape.
      return serializeTableAnalysis(analysis);
    }

    default:
      throw new ToolValidationError(`Unknown tool: ${name}`);
  }
}

// ─── MCP dispatch ────────────────────────────────────────────────────────────

export function handleRequest(request: McpRequest): McpResponse {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize": {
        // P-BND-005: honest negotiation — echo the client's requested
        // protocolVersion when present, falling back to the server default.
        const requested = params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && requested.length > 0
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            serverInfo: SERVER_INFO,
            capabilities: CAPABILITIES,
          },
        };
      }

      case "notifications/initialized":
        // Client acknowledgment — no response needed for notifications
        // but since we got an id, respond with empty result
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

        if (!toolName) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: RPC_INVALID_PARAMS, message: "Missing tool name" },
          };
        }

        const toolResult = handleToolCall(toolName, toolArgs);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(toolResult, null, 2),
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: RPC_METHOD_NOT_FOUND, message: `Unknown method: ${method}` },
        };
    }
  } catch (e) {
    // Known, user-facing validation errors carry safe, curated text that is
    // intended to reach the client (e.g. "Dice count exceeds maximum of 10000").
    // Anything else is an unexpected internal fault: log the detail server-side
    // and return a GENERIC message so internal exception text never crosses the
    // trust boundary. (F-BM-003 / M3)
    if (e instanceof ParseError || e instanceof LexerError || e instanceof ToolValidationError) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        },
      };
    }

    const detail = e instanceof Error ? e.stack ?? e.message : String(e);
    activeLogger.error(`[roll-mcp] internal error: ${detail}`);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Error: Internal error" }],
        isError: true,
      },
    };
  }
}

/**
 * Pure dispatch entry point: parse a raw JSON-RPC line into a response (or an
 * array of responses for a batch). Returns `null` for inputs that produce no
 * response (notifications, or a batch of only notifications). Exported so the
 * dispatch layer can be unit-tested without spawning a process — the stdio
 * `main()` loop is a thin wrapper around this. (F-BM-006 + test seam)
 */
export function dispatch(raw: string): McpResponse | McpResponse[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve a null id per JSON-RPC 2.0 (id unknown on parse failure).
    return { jsonrpc: "2.0", id: null, error: { code: RPC_PARSE_ERROR, message: "Parse error" } };
  }

  // JSON-RPC 2.0 batch: an array of requests. Process each element, dropping
  // notification (no-id) responses; an all-notification batch yields nothing.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "Invalid request: empty batch" } };
    }
    const responses: McpResponse[] = [];
    for (const item of parsed) {
      const r = dispatchOne(item);
      if (r !== null) responses.push(r);
    }
    return responses.length > 0 ? responses : null;
  }

  return dispatchOne(parsed);
}

/** Dispatch a single (already-parsed) request object. Returns null for
 *  notifications (requests with no id). */
function dispatchOne(parsed: unknown): McpResponse | null {
  if (typeof parsed !== "object" || parsed === null) {
    return { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "Invalid request" } };
  }
  const request = parsed as McpRequest;

  // Notifications (no id) get no response.
  if (request.id === undefined || request.id === null) return null;

  if (typeof request.method !== "string") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: RPC_INVALID_REQUEST, message: "Invalid request: missing method" },
    };
  }

  return handleRequest(request);
}

// ─── Observability (P-BND-002) ───────────────────────────────────────────────

/** Opt-in: ON when --verbose or env ROLL_BRIDGE_DEBUG is set. OFF by default
 *  (quiet operation unchanged). Shared env name with the bridge transport. */
function isDebugEnabled(flag: boolean): boolean {
  if (flag) return true;
  const env = process.env.ROLL_BRIDGE_DEBUG;
  return env !== undefined && env !== "" && env !== "0" && env.toLowerCase() !== "false";
}

/**
 * Emit one structured trace line per request when debug is on (P-BND-002):
 * method, id, outcome (ok|error), error code. Best-effort; never throws into the
 * hot path. A batch logs one line per element. Notification-only inputs (a null
 * dispatch result) log nothing — they produce no response.
 */
function traceRequest(
  logger: Logger,
  raw: string,
  response: McpResponse | McpResponse[] | null,
): void {
  if (response === null) return;
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
      logger.info(`[roll-mcp] method=${method} id=${String(res.id)} outcome=${outcome}${code}`);
    });
  } catch {
    // Observability must never break request handling.
  }
}

// ─── Stdio transport ─────────────────────────────────────────────────────────

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const debug = isDebugEnabled(verbose);

  // P-BND-009: top-level resilience. An uncaught exception / unhandled rejection
  // is logged via the seam and does NOT tear the server down — the MCP loop is
  // long-lived; one stray async fault must not stop it serving.
  process.on("uncaughtException", (e) => {
    activeLogger.error(`[roll-mcp] uncaughtException: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  });
  process.on("unhandledRejection", (reason) => {
    activeLogger.error(`[roll-mcp] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    // P-BND-009: graceful degradation — a fault in handling OR serializing ONE
    // line must not crash the loop. Emit a generic INTERNAL_ERROR response and
    // keep serving. (dispatch is already total; this also covers the
    // JSON.stringify write of any future non-serializable result.)
    try {
      const trimmed = line.trim();
      if (!trimmed) return;

      const response = dispatch(trimmed);
      if (debug) traceRequest(activeLogger, trimmed, response);
      // `null` → notification(s) with no response; emit nothing.
      if (response === null) return;
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch (e) {
      const detail = e instanceof Error ? e.stack ?? e.message : String(e);
      activeLogger.error(`[roll-mcp] line handler fault: ${detail}`);
      try {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: RPC_INTERNAL_ERROR, message: "Internal error" } }) + "\n",
        );
      } catch {
        /* stdout itself failed — keep serving. */
      }
    }
  });

  rl.on("close", () => process.exit(0));
}

// Only run the stdio loop when invoked as a binary, not when imported in tests.
// isMainModule() realpaths both sides so a symlinked `npm i -g` / `npm link` bin
// still starts — the old href-equality guard compared the symlink path against
// the realpath'd target and never matched, silently disabling the published
// `roll-mcp` binary. (V2-001)
if (isMainModule(import.meta.url)) {
  main();
}
