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
export { computeDistribution } from "./analyze/distribution.js";
export type { Distribution } from "./analyze/distribution.js";
export { computeStats, probabilityAtLeast } from "./analyze/stats.js";
export type { DistributionStats } from "./analyze/stats.js";
export { monteCarloDistribution } from "./analyze/montecarlo.js";

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
import { computeDistribution as _computeDist } from "./analyze/distribution.js";
import { computeStats as _computeStats, probabilityAtLeast as _probAtLeast } from "./analyze/stats.js";
import type { RollResult } from "./engine/roller.js";
import type { RngFn } from "./engine/random.js";

/** Roll a dice expression and return the result. */
export function roll(expression: string, rng?: RngFn): RollResult {
  const ast = _parse(expression);
  const result = _evaluate(ast, rng);
  result.expression = expression;
  return result;
}

/** Analyze a dice expression — returns distribution, stats, and a P(>=target) function. */
export function analyze(expression: string) {
  const ast = _parse(expression);
  const dist = _computeDist(ast);
  const stats = _computeStats(dist);
  return {
    distribution: dist,
    stats,
    probabilityAtLeast: (target: number) => _probAtLeast(dist, target),
  };
}
