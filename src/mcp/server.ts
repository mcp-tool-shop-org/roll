#!/usr/bin/env node
/**
 * Roll MCP Server — Model Context Protocol server for the Roll dice engine.
 * Communicates via stdio using JSON-RPC 2.0 (MCP transport).
 */
import { createInterface } from "node:readline";
import { isMainModule } from "../entry.js";
import { TOOLS } from "./tools.js";
import { parse, ParseError } from "../parser/parser.js";
import { LexerError } from "../parser/lexer.js";
import { evaluate } from "../engine/roller.js";
import { computeDistribution } from "../analyze/distribution.js";
import { computeStats, probabilityAtLeast } from "../analyze/stats.js";
import { seededRng, cryptoRng } from "../engine/random.js";
import { rollGameTable } from "../tables/engine.js";
import type { RngFn } from "../engine/random.js";
import type { GameTableCollection, TableContext } from "../tables/schema.js";

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

const SERVER_INFO = {
  name: "roll",
  version: "2.0.0",
};

const CAPABILITIES = {
  tools: {},
};

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
      const dist = computeDistribution(ast);
      const stats = computeStats(dist);
      const distribution = [...dist.entries()].sort((a, b) => a[0] - b[0]);

      const result: Record<string, unknown> = { stats, distribution };
      const atLeast = optionalNumber(args, "at_least");
      if (atLeast !== undefined) {
        result.atLeastProbability = probabilityAtLeast(dist, atLeast);
        result.atLeastTarget = atLeast;
      }
      return result;
    }

    case "compare_dice": {
      const exprA = requireString(args, "expression_a");
      const exprB = requireString(args, "expression_b");

      const analyze = (expr: string) => {
        const ast = parse(expr);
        const dist = computeDistribution(ast);
        return { expression: expr, stats: computeStats(dist) };
      };

      return [analyze(exprA), analyze(exprB)];
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

    default:
      throw new ToolValidationError(`Unknown tool: ${name}`);
  }
}

// ─── MCP dispatch ────────────────────────────────────────────────────────────

export function handleRequest(request: McpRequest): McpResponse {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: SERVER_INFO,
            capabilities: CAPABILITIES,
          },
        };

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
            error: { code: -32602, message: "Missing tool name" },
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
          error: { code: -32601, message: `Unknown method: ${method}` },
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
    process.stderr.write(`[roll-mcp] internal error: ${detail}\n`);
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
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }

  // JSON-RPC 2.0 batch: an array of requests. Process each element, dropping
  // notification (no-id) responses; an all-notification batch yields nothing.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: empty batch" } };
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
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const request = parsed as McpRequest;

  // Notifications (no id) get no response.
  if (request.id === undefined || request.id === null) return null;

  if (typeof request.method !== "string") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32600, message: "Invalid request: missing method" },
    };
  }

  return handleRequest(request);
}

// ─── Stdio transport ─────────────────────────────────────────────────────────

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const response = dispatch(trimmed);
    // `null` → notification(s) with no response; emit nothing.
    if (response === null) return;
    process.stdout.write(JSON.stringify(response) + "\n");
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
