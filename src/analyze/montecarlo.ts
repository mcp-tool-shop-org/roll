import type { ASTNode } from "../parser/ast.js";
import { evaluate } from "../engine/roller.js";
import { seededRng } from "../engine/random.js";
import type { Distribution } from "./distribution.js";

const DEFAULT_SAMPLES = 100_000;

/** Monte Carlo simulation to estimate distribution.
 *
 *  COST CONTRACT (V1-001 / V1-002): this runs DEFAULT_SAMPLES iterations, each
 *  calling evaluate(ast) which rolls EVERY die in the expression. Cost is
 *  therefore O(samples × totalDice). The bound on totalDice is enforced UPSTREAM
 *  in computeDistribution (MAX_ANALYZE_DICE), which throws a structured
 *  ParseError before this function is ever reached for an over-budget AST. With
 *  that cap (1000 dice) the worst case here is ~1e8 rolls — acceptable. Callers
 *  that invoke monteCarloDistribution directly with an unbounded AST bypass that
 *  guard and own the cost; the public analyze path never does. */
export function monteCarloDistribution(
  ast: ASTNode,
  samples: number = DEFAULT_SAMPLES,
): Distribution {
  const counts = new Map<number, number>();

  // F-AT-005: use ONE generator for the whole run so each sample is an
  // independent draw from a continuous high-quality stream. The old code created
  // a FRESH seededRng(i * 2654435761) inside the loop and consumed only its
  // first outputs — successive samples were then a correlated low-discrepancy
  // lattice (mulberry32's first output is largely determined by its seed), not
  // independent draws. Seed once with a fixed constant for determinism.
  const rng = seededRng(0x9e3779b9); // fixed seed → reproducible runs

  for (let i = 0; i < samples; i++) {
    const result = evaluate(ast, rng);
    counts.set(result.total, (counts.get(result.total) ?? 0) + 1);
  }

  // Convert counts to probabilities
  const dist: Distribution = new Map();
  for (const [value, count] of counts) {
    dist.set(value, count / samples);
  }

  return dist;
}
