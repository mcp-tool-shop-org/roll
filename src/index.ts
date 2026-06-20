// Parser
export {
  parse,
  ParseError,
  MAX_DICE_COUNT,
  MAX_DIE_SIDES,
  MAX_EXPRESSION_LENGTH,
} from "./parser/parser.js";
export { tokenize, LexerError } from "./parser/lexer.js";
export type { ASTNode, DiceNode, NumberNode, BinaryOpNode, UnaryMinusNode, DiceModifier, DiceSides, ComparePoint } from "./parser/ast.js";
export { TokenType } from "./parser/tokens.js";
export type { Token } from "./parser/tokens.js";

// Engine
export { evaluate } from "./engine/roller.js";
export type { RollResult, DiceGroupResult, DieResult } from "./engine/roller.js";
export { cryptoRng, seededRng } from "./engine/random.js";
export type { RngFn } from "./engine/random.js";

// Pipeline
export { runPipeline, matchesCompare } from "./engine/pipeline.js";
export type { PipelineDie, PipelineResult } from "./engine/pipeline.js";

// Analysis
export {
  computeDistribution,
  computeDistributionWithMethod,
  classifyModifier,
  compareDistributions,
  negateDistribution,
} from "./analyze/distribution.js";
export type {
  Distribution,
  DistributionMethod,
  DistributionWithMethod,
  ModifierFamily,
  DistributionComparison,
} from "./analyze/distribution.js";
export {
  computeStats,
  probabilityAtLeast,
  probabilityAtMost,
  probabilityExactly,
  probabilityInRange,
  cumulativeDistribution,
  survivalDistribution,
  targetForProbability,
} from "./analyze/stats.js";
export type { DistributionStats } from "./analyze/stats.js";
export { monteCarloDistribution, DEFAULT_MONTE_CARLO_SAMPLES } from "./analyze/montecarlo.js";

// Table analysis (FT-ANA-001 / FT-TBL-001)
export { analyzeTable, analyzeCollection } from "./tables/analyze.js";
export type {
  AnalyzedEntry,
  ExcludedEntry,
  TableAnalysis,
} from "./tables/analyze.js";

// Loot (V1 — unchanged)
export { rollLootTable, validateLootTables } from "./loot/table.js";
export type { LootTable, LootItem, LootDrop, LootTableCollection } from "./loot/table.js";

// Game Tables (V2)
export { rollGameTable, rollMultiple, convertLootToGameTable } from "./tables/engine.js";
export { validateGameTables } from "./tables/validate.js";
export { evaluateCondition, filterEligibleEntries } from "./tables/conditions.js";
export type {
  GameTable, GameTableCollection, TableEntry, TableResult,
  TableContext, TableCondition, TableKind,
  CompareCondition, NatCondition, TagCondition, ContextCondition,
} from "./tables/schema.js";

// Bridge
export { BridgeHandler } from "./bridge/handler.js";
export type {
  JsonRpcRequest, JsonRpcResponse, JsonRpcError, BridgeMethod,
} from "./bridge/protocol.js";

// Convenience functions
import { parse as _parse } from "./parser/parser.js";
import { evaluate as _evaluate } from "./engine/roller.js";
import { computeDistributionWithMethod as _computeDistWithMethod } from "./analyze/distribution.js";
import {
  computeStats as _computeStats,
  probabilityAtLeast as _probAtLeast,
  probabilityAtMost as _probAtMost,
  probabilityExactly as _probExactly,
  probabilityInRange as _probInRange,
  cumulativeDistribution as _cdf,
  targetForProbability as _targetForProbability,
} from "./analyze/stats.js";
import type { RollResult } from "./engine/roller.js";
import type { RngFn } from "./engine/random.js";

/** Roll a dice expression and return the result. */
export function roll(expression: string, rng?: RngFn): RollResult {
  const ast = _parse(expression);
  const result = _evaluate(ast, rng);
  result.expression = expression;
  return result;
}

/** Analyze a dice expression — returns distribution, stats, a P(>=target)
 *  function, AND the `method` used to produce the distribution: "exact" for a
 *  closed-form result, or "monte-carlo" (with a `samples` count) when the
 *  expression was too complex/large for exact computation and was estimated by
 *  sampling. Surfacing `method` lets callers honor the "exact probabilities"
 *  contract — they can tell exact numbers from sampled estimates. (P-CORE-001) */
export function analyze(expression: string) {
  const ast = _parse(expression);
  const { distribution: dist, method, samples } = _computeDistWithMethod(ast);
  const stats = _computeStats(dist);
  return {
    distribution: dist,
    stats,
    probabilityAtLeast: (target: number) => _probAtLeast(dist, target),
    // FT-ANA-003/004/005: additive query family mirroring probabilityAtLeast.
    // Closures so callers don't re-thread the distribution; `cdf` is the
    // precomputed cumulative Map (P(X <= v) per value).
    probabilityAtMost: (x: number) => _probAtMost(dist, x),
    probabilityExactly: (x: number) => _probExactly(dist, x),
    probabilityInRange: (lo: number, hi: number) => _probInRange(dist, lo, hi),
    cdf: _cdf(dist),
    targetForProbability: (
      p: number,
      direction: "atLeast" | "atMost" = "atLeast",
    ) => _targetForProbability(dist, p, direction),
    method,
    // `samples` is present only for the monte-carlo path; omitted (undefined)
    // for exact so callers can do `"samples" in result`-style checks cleanly.
    ...(samples !== undefined ? { samples } : {}),
  };
}
