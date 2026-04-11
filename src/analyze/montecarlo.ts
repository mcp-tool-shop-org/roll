import type { ASTNode } from "../parser/ast.js";
import { evaluate } from "../engine/roller.js";
import { seededRng } from "../engine/random.js";
import type { Distribution } from "./distribution.js";

const DEFAULT_SAMPLES = 100_000;

/** Monte Carlo simulation to estimate distribution. */
export function monteCarloDistribution(
  ast: ASTNode,
  samples: number = DEFAULT_SAMPLES,
): Distribution {
  const counts = new Map<number, number>();

  for (let i = 0; i < samples; i++) {
    const rng = seededRng(i * 2654435761); // spread seeds widely
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
