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
  Logger,
} from "./protocol.js";
import {
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  stderrLogger,
} from "./protocol.js";
import { parse, ParseError } from "../parser/parser.js";
import { LexerError } from "../parser/lexer.js";
import { evaluate } from "../engine/roller.js";
import { computeDistributionWithMethod } from "../analyze/distribution.js";
import type { DistributionWithMethod } from "../analyze/distribution.js";
import { computeStats, probabilityAtLeast } from "../analyze/stats.js";
import { cryptoRng, seededRng } from "../engine/random.js";
import { rollGameTable } from "../tables/engine.js";
import type { RngFn } from "../engine/random.js";
import type { GameTableCollection, TableContext } from "../tables/schema.js";

export class BridgeHandler {
  private rng: RngFn = cryptoRng;
  private tables = new Map<string, GameTableCollection>();
  private readonly logger: Logger;

  /**
   * @param logger  injectable log sink for internal-error detail (P-BND-001).
   *   Defaults to the process.stderr-backed sink. A host can silence/redirect
   *   logs; tests inject a capturing or no-op sink. Internal exception text is
   *   logged here ONLY — it never crosses the wire (the client gets a generic
   *   "Internal error").
   */
  constructor(logger: Logger = stderrLogger) {
    this.logger = logger;
  }

  /** Set a deterministic seed for all subsequent rolls. */
  setSeed(seed: number): void {
    this.rng = seededRng(seed);
  }

  /** Reset to cryptographic RNG. */
  resetRng(): void {
    this.rng = cryptoRng;
  }

  /**
   * Parse a raw JSON string into a request (or batch) and handle it.
   * Returns a single response, or an array of responses for a JSON-RPC 2.0
   * batch (array) payload. (F-BM-006)
   */
  handleRaw(raw: string): JsonRpcResponse | JsonRpcResponse[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // id is unknown on parse failure → null per JSON-RPC 2.0 (not 0).
      return { jsonrpc: "2.0", id: null, error: { code: RPC_PARSE_ERROR, message: "Parse error" } };
    }

    // Batch: array of requests. Process each; an empty array is invalid.
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_INVALID_REQUEST, message: "Invalid request: empty batch" },
        };
      }
      return parsed.map((item) => this.handleOne(item));
    }

    return this.handleOne(parsed);
  }

  /** Validate and dispatch a single (already-parsed) request object. */
  private handleOne(parsed: unknown): JsonRpcResponse {
    if (typeof parsed !== "object" || parsed === null) {
      return { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "Invalid request" } };
    }
    const request = parsed as JsonRpcRequest;
    // Preserve the original id (including null) instead of coercing to 0.
    const id = request.id === undefined ? null : request.id;

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || request.method.length === 0 || request.id === undefined) {
      return {
        jsonrpc: "2.0",
        id,
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
          if (typeof p?.expression !== "string" || p.expression.length === 0) {
            return err(id, RPC_INVALID_PARAMS, "Missing expression parameter");
          }
          if (p.seed !== undefined && typeof p.seed !== "number") {
            return err(id, RPC_INVALID_PARAMS, "seed must be a number");
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
          // Cap the batch LENGTH before doing any per-expression work. Each
          // expression already caps its own dice count, but an uncapped array of
          // thousands of "10000d6" entries (≈8000 fit in a 64KB HTTP body, and
          // the array is unbounded over stdio) rolls ~10^8 dice in one
          // synchronous request → OOM/DoS. Reject over-cap via the same
          // ParseError → INVALID_PARAMS path as the other count guards. (V1-003)
          if (p.expressions.length > MAX_BATCH_EXPRESSIONS) {
            return err(
              id,
              RPC_INVALID_PARAMS,
              `expressions length (${p.expressions.length}) exceeds maximum of ${MAX_BATCH_EXPRESSIONS}`,
            );
          }
          if (p.expressions.some((e) => typeof e !== "string")) {
            return err(id, RPC_INVALID_PARAMS, "expressions must all be strings");
          }
          if (p.seed !== undefined && typeof p.seed !== "number") {
            return err(id, RPC_INVALID_PARAMS, "seed must be a number");
          }
          const rng = p.seed !== undefined ? seededRng(p.seed) : this.rng;
          // P-BND-008: per-item resilience. One bad expression must NOT void the
          // whole batch. Each entry is parsed+evaluated in its own try/catch; a
          // failure yields a `{ expression, error }` entry (with the curated
          // ParseError/LexerError message) alongside the successful results,
          // preserving order. Unexpected internal faults still surface a generic
          // message and are logged server-side (never leaked).
          const results = p.expressions.map((expr) => {
            try {
              const ast = parse(expr);
              const result = evaluate(ast, rng);
              result.expression = expr;
              return result;
            } catch (e) {
              return { expression: expr, error: this.safeItemError(e) };
            }
          });
          return ok(id, results);
        }

        case "analyze": {
          const p = params as unknown as AnalyzeParams;
          if (!p?.expression) {
            return err(id, RPC_INVALID_PARAMS, "Missing expression parameter");
          }
          const ast = parse(p.expression);
          const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
          const stats = computeStats(dist);
          // Convert Map to array of tuples for JSON serialization
          const distribution = [...dist.entries()].sort((a, b) => a[0] - b[0]);
          // Surface HOW the probability was produced so clients know whether it
          // is exact or a Monte-Carlo estimate (and how many samples). (Additive.)
          return ok(id, { stats, distribution, ...methodFields(method, samples) });
        }

        case "at_least": {
          const p = params as unknown as AtLeastParams;
          if (!p?.expression || typeof p?.target !== "number") {
            return err(id, RPC_INVALID_PARAMS, "Missing expression or target parameter");
          }
          const ast = parse(p.expression);
          const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
          const probability = probabilityAtLeast(dist, p.target);
          return ok(id, { probability, target: p.target, ...methodFields(method, samples) });
        }

        case "compare": {
          const p = params as unknown as CompareParams;
          if (!p?.expressions || p.expressions.length !== 2) {
            return err(id, RPC_INVALID_PARAMS, "Need exactly 2 expressions");
          }
          const results = p.expressions.map((expr) => {
            const ast = parse(expr);
            const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
            return { expression: expr, stats: computeStats(dist), ...methodFields(method, samples) };
          });
          return ok(id, results);
        }

        case "table_load": {
          const p = params as unknown as TableLoadParams;
          if (!p?.collection) {
            return err(id, RPC_INVALID_PARAMS, "Missing collection parameter");
          }
          // Validate shape before indexing (F-BM-005). validateCollection
          // throws ParseError → INVALID_PARAMS on a malformed collection.
          const collection = validateCollection(p.collection);
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
          // Cap count at the boundary (F-BM-005). Throws ParseError →
          // INVALID_PARAMS for non-integers, negatives, or over-cap values.
          const count = validateCount(p.count, 1);
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
      // ParseError / LexerError carry safe, curated, user-facing text (e.g.
      // "Dice count exceeds maximum of 10000", "Unexpected character") and are
      // client input errors → INVALID_PARAMS. Anything else is an unexpected
      // internal fault: log the detail to stderr and return a GENERIC message so
      // internal exception text never crosses the trust boundary. (F-BM-003 / M3)
      if (e instanceof ParseError || e instanceof LexerError) {
        return err(id, RPC_INVALID_PARAMS, e.message);
      }
      const detail = e instanceof Error ? e.stack ?? e.message : String(e);
      this.logger.error(`[roll-bridge] internal error: ${detail}`);
      return err(id, RPC_INTERNAL_ERROR, "Internal error");
    }
  }

  /**
   * Reduce a per-item failure (P-BND-008) to a safe, client-facing message.
   * ParseError/LexerError carry curated text that is safe to return. Anything
   * else is an unexpected fault: log the detail server-side (via the seam) and
   * return a GENERIC message so internal exception text never crosses the wire.
   */
  private safeItemError(e: unknown): string {
    if (e instanceof ParseError || e instanceof LexerError) {
      return e.message;
    }
    const detail = e instanceof Error ? e.stack ?? e.message : String(e);
    this.logger.error(`[roll-bridge] internal error (batch item): ${detail}`);
    return "Internal error";
  }
}

/** Spread-able method/samples fields for analyze-style results (P-CORE-001 wire
 *  surfacing). `samples` is present ONLY for the monte-carlo path. */
function methodFields(
  method: DistributionWithMethod["method"],
  samples: DistributionWithMethod["samples"],
): { method: DistributionWithMethod["method"]; samples?: number } {
  return samples !== undefined ? { method, samples } : { method };
}

/** Upper bound on repeat-count style params at the boundary. */
const MAX_TABLE_ROLL_COUNT = 1000;

/** Upper bound on the number of expressions in a single roll_batch. Mirrors
 *  MAX_TABLE_ROLL_COUNT. Each expression still caps its own dice count; this
 *  bounds the array length so a 64KB body can't queue ~10^8 allocations and
 *  stdio can't pass an unbounded array. (V1-003) */
const MAX_BATCH_EXPRESSIONS = 1000;

/** Validate a count param: finite positive integer within cap. Returns def
 *  when absent. Throws ParseError (→ INVALID_PARAMS) on violation. */
function validateCount(v: unknown, def: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
    throw new ParseError(`count must be a positive integer`, 0);
  }
  if (v > MAX_TABLE_ROLL_COUNT) {
    throw new ParseError(`count (${v}) exceeds maximum of ${MAX_TABLE_ROLL_COUNT}`, 0);
  }
  return v;
}

/** Structural validation of a GameTableCollection at the boundary. Throws
 *  ParseError (→ INVALID_PARAMS) on a malformed shape. */
function validateCollection(c: unknown): GameTableCollection {
  if (typeof c !== "object" || c === null) {
    throw new ParseError("collection must be an object", 0);
  }
  const tables = (c as { tables?: unknown }).tables;
  if (!Array.isArray(tables)) {
    throw new ParseError("collection.tables must be an array", 0);
  }
  for (const t of tables) {
    if (typeof t !== "object" || t === null) {
      throw new ParseError("each table must be an object", 0);
    }
    if (typeof (t as { table?: unknown }).table !== "string") {
      throw new ParseError("each table requires a string \"table\" name", 0);
    }
    if (!Array.isArray((t as { entries?: unknown }).entries)) {
      throw new ParseError("each table requires an \"entries\" array", 0);
    }
  }
  return c as GameTableCollection;
}

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
