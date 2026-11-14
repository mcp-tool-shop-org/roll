import type { ASTNode } from "../parser/ast.js";
import { ParseError } from "../parser/parser.js";
import { estimateAstAnalyzeRolls } from "../engine/pipeline.js";
import { evaluate } from "../engine/roller.js";
import { seededRng, type RngFn } from "../engine/random.js";
import type { Distribution } from "./distribution.js";

/** Default number of Monte-Carlo iterations. Exported so the analyze path can
 *  REPORT the exact sample count it used when it falls back to sampling
 *  (computeDistributionWithMethod surfaces this as `samples`). Keeping it the
 *  single source of truth means the reported count can never drift from the
 *  count actually run. (P-CORE-001) */
export const DEFAULT_MONTE_CARLO_SAMPLES = 100_000;

/** Per-sample roll budget shared with `computeDistributionWithMethod`. */
export const MAX_ANALYZE_DICE = 1_000;

const DEFAULT_SAMPLES = DEFAULT_MONTE_CARLO_SAMPLES;

/** Monte Carlo simulation to estimate distribution.
 *
 *  COST CONTRACT (V1-001 / V1-002): this runs DEFAULT_SAMPLES iterations, each
 *  calling evaluate(ast). Cost is O(samples × rollsPerSample). Both the static
 *  AST roll estimate (accounting for stacked explosions `101^k` and rerolls) AND
 *  a live RNG-draw counter (`samples × MAX_ANALYZE_DICE`) are enforced here so
 *  neither `analyze()` nor direct `monteCarloDistribution()` callers can run
 *  unbounded work. */
export function monteCarloDistribution(
  ast: ASTNode,
  samples: number = DEFAULT_SAMPLES,
): Distribution {
  const estimatedRolls = estimateAstAnalyzeRolls(ast);
  if (estimatedRolls > MAX_ANALYZE_DICE) {
    throw new ParseError(
      `Expression too complex to analyze: ${estimatedRolls} dice rolls per sample exceeds the ` +
        `analysis limit of ${MAX_ANALYZE_DICE}.`,
      0,
    );
  }

  const counts = new Map<number, number>();

  // F-AT-005: use ONE generator for the whole run so each sample is an
  // independent draw from a continuous high-quality stream. The old code created
  // a FRESH seededRng(i * 2654435761) inside the loop and consumed only its
  // first outputs — successive samples were then a correlated low-discrepancy
  // lattice (mulberry32's first output is largely determined by its seed), not
  // independent draws. Seed once with a fixed constant for determinism.
  const baseRng = seededRng(0x9e3779b9); // fixed seed → reproducible runs
  const maxRolls = Math.max(1, samples) * MAX_ANALYZE_DICE;
  let totalRolls = 0;
  const rng: RngFn = (min, max) => {
    totalRolls++;
    if (totalRolls > maxRolls) {
      throw new ParseError(
        `Expression too complex to analyze: Monte Carlo roll budget (${maxRolls}) exceeded.`,
        0,
      );
    }
    return baseRng(min, max);
  };

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
