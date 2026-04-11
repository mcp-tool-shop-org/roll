import type { ASTNode, DiceNode, DiceSides } from "../parser/ast.js";
import { monteCarloDistribution } from "./montecarlo.js";

/** A probability distribution: value → probability (0..1) */
export type Distribution = Map<number, number>;

const MAX_EXACT_STATES = 10_000_000;

function sideCount(sides: DiceSides): number {
  if (sides === "%") return 100;
  if (sides === "F") return 3;
  return sides;
}

/** Distribution for a single die roll. */
function singleDieDistribution(sides: DiceSides): Distribution {
  const dist: Distribution = new Map();
  if (sides === "F") {
    dist.set(-1, 1 / 3);
    dist.set(0, 1 / 3);
    dist.set(1, 1 / 3);
  } else {
    const n = sides === "%" ? 100 : sides;
    const p = 1 / n;
    for (let i = 1; i <= n; i++) {
      dist.set(i, p);
    }
  }
  return dist;
}

/** Convolve two distributions (sum of independent random variables). */
function convolve(a: Distribution, b: Distribution): Distribution {
  const result: Distribution = new Map();
  for (const [va, pa] of a) {
    for (const [vb, pb] of b) {
      const sum = va + vb;
      result.set(sum, (result.get(sum) ?? 0) + pa * pb);
    }
  }
  return result;
}

/** Distribution for NdM via iterative convolution. */
function convolveDice(count: number, sides: DiceSides): Distribution {
  const single = singleDieDistribution(sides);
  let dist: Distribution = new Map([[0, 1]]); // identity: always 0
  for (let i = 0; i < count; i++) {
    dist = convolve(dist, single);
  }
  return dist;
}

/** Distribution with keep/drop via full enumeration. */
function enumerateKeepDrop(node: DiceNode): Distribution | null {
  const s = sideCount(node.sides);
  const totalStates = Math.pow(s, node.count);
  if (totalStates > MAX_EXACT_STATES) return null;

  const isFate = node.sides === "F";
  const dist: Distribution = new Map();
  const prob = 1 / totalStates;

  // Enumerate all outcomes
  const rolls = new Array<number>(node.count);

  function enumerate(depth: number): void {
    if (depth === node.count) {
      // Apply keep/drop
      const sorted = [...rolls].sort((a, b) => a - b);
      let kept = sorted.slice(); // start with all

      for (const mod of node.modifiers) {
        if (mod.kind === "explode") continue;
        const n = mod.value ?? 1;
        switch (mod.kind) {
          case "kh":
            kept = kept.slice(kept.length - n);
            break;
          case "kl":
            kept = kept.slice(0, n);
            break;
          case "dh":
            kept = kept.slice(0, kept.length - n);
            break;
          case "dl":
            kept = kept.slice(n);
            break;
        }
      }

      const total = kept.reduce((a, b) => a + b, 0);
      dist.set(total, (dist.get(total) ?? 0) + prob);
      return;
    }

    if (isFate) {
      for (let v = -1; v <= 1; v++) {
        rolls[depth] = v;
        enumerate(depth + 1);
      }
    } else {
      const max = sideCount(node.sides);
      for (let v = 1; v <= max; v++) {
        rolls[depth] = v;
        enumerate(depth + 1);
      }
    }
  }

  enumerate(0);
  return dist;
}

/** Distribution for exploding dice via iterative depth expansion. */
function explodingDistribution(node: DiceNode): Distribution | null {
  if (node.sides === "F") return null;
  const s = sideCount(node.sides);
  const explodeMod = node.modifiers.find((m) => m.kind === "explode");
  if (!explodeMod) return null;

  const threshold = explodeMod.value ?? s;
  const maxExplosions = 10;

  function singleExploding(): Distribution {
    const dist: Distribution = new Map();
    const pFace = 1 / s;

    // Build depth-by-depth: accumulated tracks (sum → probability) for chains
    // that haven't terminated yet
    let accumulated: Distribution = new Map([[0, 1]]);

    for (let depth = 0; depth <= maxExplosions; depth++) {
      const nextAccumulated: Distribution = new Map();

      for (const [accSum, accProb] of accumulated) {
        for (let face = 1; face <= s; face++) {
          const total = accSum + face;
          const p = accProb * pFace;

          if (face < threshold || depth === maxExplosions) {
            // Terminating roll (or forced cap)
            dist.set(total, (dist.get(total) ?? 0) + p);
          } else {
            // Exploding — carry forward
            nextAccumulated.set(total, (nextAccumulated.get(total) ?? 0) + p);
          }
        }
      }

      accumulated = nextAccumulated;
      if (accumulated.size === 0) break;
    }

    return dist;
  }

  const single = singleExploding();
  let dist: Distribution = new Map([[0, 1]]);
  for (let i = 0; i < node.count; i++) {
    dist = convolve(dist, single);
  }
  return dist;
}

/** Shift distribution by constant. */
function shiftDistribution(dist: Distribution, offset: number): Distribution {
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    result.set(v + offset, (result.get(v + offset) ?? 0) + p);
  }
  return result;
}

/** Scale distribution by constant. */
function scaleDistribution(dist: Distribution, factor: number): Distribution {
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    const scaled = factor >= 0 ? v * factor : v * factor;
    result.set(scaled, (result.get(scaled) ?? 0) + p);
  }
  return result;
}

/** Floor-divide distribution by constant. */
function divideDistribution(dist: Distribution, divisor: number): Distribution {
  if (divisor === 0) return new Map([[0, 1]]);
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    const divided = Math.floor(v / divisor);
    result.set(divided, (result.get(divided) ?? 0) + p);
  }
  return result;
}

/** Compute the full probability distribution for an AST. Falls back to Monte Carlo for complex cases. */
export function computeDistribution(ast: ASTNode): Distribution {
  const result = tryExact(ast);
  if (result) return result;
  return monteCarloDistribution(ast);
}

function tryExact(node: ASTNode): Distribution | null {
  switch (node.type) {
    case "number":
      return new Map([[node.value, 1]]);

    case "dice": {
      const hasKeepDrop = node.modifiers.some(
        (m) => m.kind === "kh" || m.kind === "kl" || m.kind === "dh" || m.kind === "dl",
      );
      const hasExplode = node.modifiers.some((m) => m.kind === "explode");

      if (hasExplode && !hasKeepDrop) {
        return explodingDistribution(node);
      }

      if (hasKeepDrop) {
        return enumerateKeepDrop(node);
      }

      // Plain NdM — use convolution
      return convolveDice(node.count, node.sides);
    }

    case "binary": {
      const left = tryExact(node.left);
      const right = tryExact(node.right);
      if (!left || !right) return null;

      // Optimize: if one side is a constant
      if (right.size === 1) {
        const [rv] = [...right.keys()];
        switch (node.op) {
          case "+":
            return shiftDistribution(left, rv);
          case "-":
            return shiftDistribution(left, -rv);
          case "*":
            return scaleDistribution(left, rv);
          case "/":
            return divideDistribution(left, rv);
        }
      }

      if (left.size === 1) {
        const [lv] = [...left.keys()];
        switch (node.op) {
          case "+":
            return shiftDistribution(right, lv);
          case "-": {
            // lv - right → negate right, shift by lv
            const negated = scaleDistribution(right, -1);
            return shiftDistribution(negated, lv);
          }
          case "*":
            return scaleDistribution(right, lv);
          case "/":
            return null; // constant / distribution is unusual, use MC
        }
      }

      // Both sides are distributions — convolve for +/-, fall back for */÷
      if (node.op === "+") return convolve(left, right);
      if (node.op === "-") {
        const negated = scaleDistribution(right, -1);
        return convolve(left, negated);
      }

      // Multiplication/division of two distributions — Monte Carlo
      return null;
    }

    case "unary_minus": {
      const inner = tryExact(node.operand);
      if (!inner) return null;
      return scaleDistribution(inner, -1);
    }
  }
}
