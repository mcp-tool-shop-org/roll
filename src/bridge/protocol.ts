// ─── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  /** `null` is a legitimate JSON-RPC id (and the required id for parse-error /
   *  invalid-request responses where the original id is unknown). */
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── Standard error codes ────────────────────────────────────────────────────

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ─── Logging seam (P-BND-001) ────────────────────────────────────────────────

/**
 * The boundary's injectable log sink. The CLI already has an IO seam (bin.ts);
 * this gives the bridge + MCP transports the same so a host can silence or
 * redirect logs and tests can inject a no-op sink (which kills the "Roll bridge
 * listening on…" banner noise that otherwise leaks into test output).
 *
 *  - `info`  — operational lines: the listening banner, opt-in request traces.
 *  - `error` — internal-error detail (never the client-facing message; that
 *              crosses the wire, the detail stays server-side).
 *
 * One taxonomy, both transports — the same shape is consumed by the bridge
 * (handler/server) and the MCP server.
 */
export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * Default logger: writes a single trailing-newline-terminated line to
 * process.stderr for both channels. stderr (not stdout) so log lines never
 * corrupt the JSON-RPC response stream on the stdio transport. This is the
 * behavior the boundary had before the seam existed; it is now the explicit,
 * overridable default. (P-BND-001)
 */
export const stderrLogger: Logger = {
  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
};

// ─── Method parameter types ──────────────────────────────────────────────────

export interface RollParams {
  expression: string;
  seed?: number;
}

export interface RollBatchParams {
  expressions: string[];
  seed?: number;
}

/**
 * Per-item result shape for `roll_batch` (P-BND-008). The method returns an
 * array, positionally aligned with `expressions`. A successful element is a
 * normal roll result (carrying its `expression`); a failed element is a
 * `BatchItemError` instead, so ONE bad expression no longer voids the whole
 * batch with a single opaque INVALID_PARAMS. The `error` text is curated and
 * safe (ParseError/LexerError message, or a generic "Internal error" for an
 * unexpected fault — whose detail is logged server-side, never leaked).
 */
export interface BatchItemError {
  expression: string;
  error: string;
}

export interface AnalyzeParams {
  expression: string;
}

export interface AtLeastParams {
  expression: string;
  target: number;
}

/** Shared param shape for the point-query family (`at_most`, `exactly`).
 *  Mirrors {@link AtLeastParams}. (FT-ANA-003) */
export interface AtMostParams {
  expression: string;
  target: number;
}

/** Param shape for the inclusive range query (`between`). (FT-ANA-003) */
export interface BetweenParams {
  expression: string;
  lo: number;
  hi: number;
}

export interface CompareParams {
  expressions: [string, string];
}

export interface TableRollParams {
  table: string;
  count?: number;
  context?: Record<string, unknown>;
}

/** Param shape for `table_analyze` — mirrors {@link TableRollParams}'s
 *  `table` + `context`, minus `count` (analysis is over the whole table).
 *  (FT-INT-002 / FT-ANA-001) */
export interface TableAnalyzeParams {
  table: string;
  context?: Record<string, unknown>;
}

export interface TableLoadParams {
  collection: unknown;
}

export interface SeedParams {
  seed: number;
}

// ─── Bridge methods ──────────────────────────────────────────────────────────

export type BridgeMethod =
  | "roll"
  | "roll_batch"
  | "analyze"
  | "at_least"
  | "at_most"
  | "exactly"
  | "between"
  | "compare"
  | "table_roll"
  | "table_load"
  | "table_list"
  | "table_analyze"
  | "seed"
  | "ping"
  | "shutdown";
