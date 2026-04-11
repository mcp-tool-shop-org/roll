import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RollParams,
  RollBatchParams,
  AnalyzeParams,
  AtLeastParams,
  CompareParams,
  TableRollParams,
  TableLoadParams,
  SeedParams,
} from "./protocol.js";
import {
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
} from "./protocol.js";
import { parse } from "../parser/parser.js";
import { evaluate } from "../engine/roller.js";
import { computeDistribution } from "../analyze/distribution.js";
import { computeStats, probabilityAtLeast } from "../analyze/stats.js";
import { cryptoRng, seededRng } from "../engine/random.js";
import { rollGameTable } from "../tables/engine.js";
import type { RngFn } from "../engine/random.js";
import type { GameTableCollection, TableContext } from "../tables/schema.js";

export class BridgeHandler {
  private rng: RngFn = cryptoRng;
  private tables = new Map<string, GameTableCollection>();

  /** Set a deterministic seed for all subsequent rolls. */
  setSeed(seed: number): void {
    this.rng = seededRng(seed);
  }

  /** Reset to cryptographic RNG. */
  resetRng(): void {
    this.rng = cryptoRng;
  }

  /** Parse a raw JSON string into a request and handle it. */
  handleRaw(raw: string): JsonRpcResponse {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      return { jsonrpc: "2.0", id: 0, error: { code: RPC_PARSE_ERROR, message: "Parse error" } };
    }

    if (!request.jsonrpc || request.jsonrpc !== "2.0" || !request.method || request.id === undefined) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? 0,
        error: { code: RPC_INVALID_REQUEST, message: "Invalid request" },
      };
    }

    return this.handle(request);
  }

  /** Handle a parsed JSON-RPC request. */
  handle(request: JsonRpcRequest): JsonRpcResponse {
    const { id, method, params } = request;

    try {
      switch (method) {
        case "ping":
          return ok(id, { ok: true });

        case "shutdown":
          return ok(id, { shutdown: true });

        case "seed": {
          const p = params as unknown as SeedParams;
          if (typeof p?.seed !== "number") {
            return err(id, RPC_INVALID_PARAMS, "Missing seed parameter");
          }
          this.setSeed(p.seed);
          return ok(id, { seeded: true });
        }

        case "roll": {
          const p = params as unknown as RollParams;
          if (!p?.expression) {
            return err(id, RPC_INVALID_PARAMS, "Missing expression parameter");
          }
          const rng = p.seed !== undefined ? seededRng(p.seed) : this.rng;
          const ast = parse(p.expression);
          const result = evaluate(ast, rng);
          result.expression = p.expression;
          return ok(id, result);
        }

        case "roll_batch": {
          const p = params as unknown as RollBatchParams;
          if (!p?.expressions || !Array.isArray(p.expressions)) {
            return err(id, RPC_INVALID_PARAMS, "Missing expressions array");
          }
          const rng = p.seed !== undefined ? seededRng(p.seed) : this.rng;
          const results = p.expressions.map((expr) => {
            const ast = parse(expr);
            const result = evaluate(ast, rng);
            result.expression = expr;
            return result;
          });
          return ok(id, results);
        }

        case "analyze": {
          const p = params as unknown as AnalyzeParams;
          if (!p?.expression) {
            return err(id, RPC_INVALID_PARAMS, "Missing expression parameter");
          }
          const ast = parse(p.expression);
          const dist = computeDistribution(ast);
          const stats = computeStats(dist);
          // Convert Map to array of tuples for JSON serialization
          const distribution = [...dist.entries()].sort((a, b) => a[0] - b[0]);
          return ok(id, { stats, distribution });
        }

        case "at_least": {
          const p = params as unknown as AtLeastParams;
          if (!p?.expression || typeof p?.target !== "number") {
            return err(id, RPC_INVALID_PARAMS, "Missing expression or target parameter");
          }
          const ast = parse(p.expression);
          const dist = computeDistribution(ast);
          const probability = probabilityAtLeast(dist, p.target);
          return ok(id, { probability, target: p.target });
        }

        case "compare": {
          const p = params as unknown as CompareParams;
          if (!p?.expressions || p.expressions.length !== 2) {
            return err(id, RPC_INVALID_PARAMS, "Need exactly 2 expressions");
          }
          const results = p.expressions.map((expr) => {
            const ast = parse(expr);
            const dist = computeDistribution(ast);
            return { expression: expr, stats: computeStats(dist) };
          });
          return ok(id, results);
        }

        case "table_load": {
          const p = params as unknown as TableLoadParams;
          if (!p?.collection) {
            return err(id, RPC_INVALID_PARAMS, "Missing collection parameter");
          }
          const collection = p.collection as GameTableCollection;
          // Index by each table name
          for (const table of collection.tables) {
            this.tables.set(table.table, collection);
          }
          return ok(id, {
            loaded: collection.tables.map((t) => t.table),
          });
        }

        case "table_list": {
          return ok(id, { tables: [...this.tables.keys()] });
        }

        case "table_roll": {
          const p = params as unknown as TableRollParams;
          if (!p?.table) {
            return err(id, RPC_INVALID_PARAMS, "Missing table parameter");
          }
          const collection = this.tables.get(p.table);
          if (!collection) {
            return err(id, RPC_INVALID_PARAMS, `Table "${p.table}" not loaded`);
          }
          const context = (p.context ?? {}) as TableContext;
          const count = p.count ?? 1;
          const results = [];
          for (let i = 0; i < count; i++) {
            results.push(...rollGameTable(collection, p.table, context, this.rng));
          }
          return ok(id, results);
        }

        default:
          return err(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(id, RPC_INTERNAL_ERROR, message);
    }
  }
}

function ok(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
