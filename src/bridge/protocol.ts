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

// ─── Method parameter types ──────────────────────────────────────────────────

export interface RollParams {
  expression: string;
  seed?: number;
}

export interface RollBatchParams {
  expressions: string[];
  seed?: number;
}

export interface AnalyzeParams {
  expression: string;
}

export interface AtLeastParams {
  expression: string;
  target: number;
}

export interface CompareParams {
  expressions: [string, string];
}

export interface TableRollParams {
  table: string;
  count?: number;
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
  | "compare"
  | "table_roll"
  | "table_load"
  | "table_list"
  | "seed"
  | "ping"
  | "shutdown";
