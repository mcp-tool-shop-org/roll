#!/usr/bin/env node
/**
 * Roll MCP Server — Model Context Protocol server for the Roll dice engine.
 * Communicates via stdio using JSON-RPC 2.0 (MCP transport).
 */
import { createInterface } from "node:readline";
import { TOOLS } from "./tools.js";
import { parse } from "../parser/parser.js";
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
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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
      const expression = args.expression as string;
      const times = (args.times as number) ?? 1;
      const rng: RngFn = args.seed !== undefined ? seededRng(args.seed as number) : cryptoRng;

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
      const expression = args.expression as string;
      const ast = parse(expression);
      const dist = computeDistribution(ast);
      const stats = computeStats(dist);
      const distribution = [...dist.entries()].sort((a, b) => a[0] - b[0]);

      const result: Record<string, unknown> = { stats, distribution };
      if (args.at_least !== undefined) {
        result.atLeastProbability = probabilityAtLeast(dist, args.at_least as number);
        result.atLeastTarget = args.at_least;
      }
      return result;
    }

    case "compare_dice": {
      const exprA = args.expression_a as string;
      const exprB = args.expression_b as string;

      const analyze = (expr: string) => {
        const ast = parse(expr);
        const dist = computeDistribution(ast);
        return { expression: expr, stats: computeStats(dist) };
      };

      return [analyze(exprA), analyze(exprB)];
    }

    case "roll_table": {
      const tableName = args.table_name as string;
      const collection = args.collection as GameTableCollection;
      const context = (args.context ?? {}) as TableContext;
      const count = (args.count as number) ?? 1;

      const results = [];
      for (let i = 0; i < count; i++) {
        results.push(...rollGameTable(collection, tableName, context));
      }
      return results;
    }

    case "query_table": {
      const tableName = args.table_name as string;
      const collection = args.collection as GameTableCollection;
      const table = collection.tables.find((t) => t.table === tableName);
      if (!table) throw new Error(`Table not found: ${tableName}`);
      return table;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP dispatch ────────────────────────────────────────────────────────────

function handleRequest(request: McpRequest): McpResponse {
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
    const message = e instanceof Error ? e.message : String(e);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      },
    };
  }
}

// ─── Stdio transport ─────────────────────────────────────────────────────────

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: McpRequest;
    try {
      request = JSON.parse(trimmed);
    } catch {
      const res: McpResponse = {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" },
      };
      process.stdout.write(JSON.stringify(res) + "\n");
      return;
    }

    // Skip notifications (no id)
    if (request.id === undefined || request.id === null) return;

    const response = handleRequest(request);
    process.stdout.write(JSON.stringify(response) + "\n");
  });

  rl.on("close", () => process.exit(0));
}

main();
