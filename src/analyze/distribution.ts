import type { ASTNode, DiceNode, DiceModifier, DiceSides } from "../parser/ast.js";
import { matchesCompare } from "../engine/pipeline.js";
import { monteCarloDistribution } from "./montecarlo.js";

/** A probability distribution: value → probability (0..1) */
export type Distribution = Map<number, number>;

const MAX_EXACT_STATES = 10_000_000;

function sideCount(sides: DiceSides): number {
  if (sides === "%") return 100;
  if (sides === "F") return 3;
  return sides;
}

// ─── Single-die distributions ────────────────────────────────────────────────

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

/** Single-die distribution after reroll modifiers.
 *  Unlimited reroll: faces matching the compare point have zero probability;
 *  their mass redistributes uniformly to remaining faces via geometric series.
 *  Reroll-once: two-step probability. */
function singleDieWithReroll(sides: DiceSides, mods: DiceModifier[]): Distribution {
  const s = sideCount(sides);
  const isFate = sides === "F";
  const base = singleDieDistribution(sides);

  // Get all faces
  const faces: number[] = [];
  if (isFate) {
    faces.push(-1, 0, 1);
  } else {
    for (let i = 1; i <= s; i++) faces.push(i);
  }

  let dist = new Map(base);

  for (const mod of mods) {
    if (mod.kind !== "reroll" && mod.kind !== "reroll_once") continue;
    if (!mod.compare) continue;

    const newDist: Distribution = new Map();
    const matchingFaces = faces.filter((f) => matchesCompare(f, mod.compare!));
    const nonMatchingFaces = faces.filter((f) => !matchesCompare(f, mod.compare!));

    if (nonMatchingFaces.length === 0) {
      // All faces match — infinite reroll would never terminate, return uniform
      return dist;
    }

    if (mod.kind === "reroll") {
      // Unlimited reroll: matching faces have 0 probability.
      // Total probability of non-matching faces: each gets its base prob + share of removed mass.
      // Result: uniform over non-matching faces.
      const pEach = 1 / nonMatchingFaces.length;
      for (const face of nonMatchingFaces) {
        newDist.set(face, pEach);
      }
    } else {
      // Reroll once: if face matches, reroll one time.
      // P(end on face f) = P(roll f initially, f doesn't match) + P(roll matching, then roll f)
      const pMatch = matchingFaces.length / s;
      const pFace = 1 / s;
      for (const face of faces) {
        const isMatch = matchesCompare(face, mod.compare!);
        if (isMatch) {
          // Can only end here if initial roll was a match AND reroll also lands here
          newDist.set(face, pMatch * pFace);
        } else {
          // End here from: direct roll + (match then reroll to here)
          newDist.set(face, pFace + pMatch * pFace);
        }
      }
    }

    dist = newDist;
  }

  return dist;
}

/** Single-die distribution after min/max clamping. */
function singleDieWithMinMax(baseDist: Distribution, mods: DiceModifier[]): Distribution {
  let dist = new Map(baseDist);

  for (const mod of mods) {
    if (mod.kind === "min" && mod.value !== undefined) {
      const floor = mod.value;
      const newDist: Distribution = new Map();
      let piledMass = 0;
      for (const [v, p] of dist) {
        if (v < floor) {
          piledMass += p;
        } else {
          newDist.set(v, (newDist.get(v) ?? 0) + p);
        }
      }
      if (piledMass > 0) {
        newDist.set(floor, (newDist.get(floor) ?? 0) + piledMass);
      }
      dist = newDist;
    }

    if (mod.kind === "max" && mod.value !== undefined) {
      const ceiling = mod.value;
      const newDist: Distribution = new Map();
      let piledMass = 0;
      for (const [v, p] of dist) {
        if (v > ceiling) {
          piledMass += p;
        } else {
          newDist.set(v, (newDist.get(v) ?? 0) + p);
        }
      }
      if (piledMass > 0) {
        newDist.set(ceiling, (newDist.get(ceiling) ?? 0) + piledMass);
      }
      dist = newDist;
    }
  }

  return dist;
}

// ─── Convolution ─────────────────────────────────────────────────────────────

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
  let dist: Distribution = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) {
    dist = convolve(dist, single);
  }
  return dist;
}

/** Convolve a single-die distribution N times. */
function convolveN(single: Distribution, count: number): Distribution {
  let dist: Distribution = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) {
    dist = convolve(dist, single);
  }
  return dist;
}

// ─── Exact strategies ────────────────────────────────────────────────────────

/** Distribution with keep/drop via full enumeration. */
function enumerateKeepDrop(node: DiceNode): Distribution | null {
  const s = sideCount(node.sides);
  const totalStates = Math.pow(s, node.count);
  if (totalStates > MAX_EXACT_STATES) return null;

  const isFate = node.sides === "F";
  const dist: Distribution = new Map();
  const prob = 1 / totalStates;

  const rolls = new Array<number>(node.count);

  function enumerate(depth: number): void {
    if (depth === node.count) {
      // Apply reroll + min/max per die, then keep/drop on the result
      let values = rolls.slice();

      // Apply min/max per die
      for (const mod of node.modifiers) {
        if (mod.kind === "min" && mod.value !== undefined) {
          values = values.map((v) => Math.max(v, mod.value!));
        }
        if (mod.kind === "max" && mod.value !== undefined) {
          values = values.map((v) => Math.min(v, mod.value!));
        }
      }

      const sorted = [...values].sort((a, b) => a - b);
      let kept = sorted.slice();

      for (const mod of node.modifiers) {
        if (mod.kind !== "kh" && mod.kind !== "kl" && mod.kind !== "dh" && mod.kind !== "dl") continue;
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

      // Compute total based on result mode
      let total: number;
      if (node.resultMode === "success_count") {
        const csMods = node.modifiers.filter((m) => m.kind === "cs_count");
        const cfMods = node.modifiers.filter((m) => m.kind === "cf_count");
        total = 0;
        for (const v of kept) {
          for (const mod of csMods) {
            if (mod.compare && matchesCompare(v, mod.compare)) { total++; break; }
          }
          for (const mod of cfMods) {
            if (mod.compare && matchesCompare(v, mod.compare)) { total--; break; }
          }
        }
      } else {
        total = kept.reduce((a, b) => a + b, 0);
      }

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

/** Distribution for exploding/compounding/penetrating dice via iterative depth expansion. */
function explosionDistribution(node: DiceNode): Distribution | null {
  if (node.sides === "F") return null;
  const s = sideCount(node.sides);

  const explodeMod = node.modifiers.find(
    (m) => m.kind === "explode" || m.kind === "compound" || m.kind === "penetrate",
  );
  if (!explodeMod) return null;

  const threshold = explodeMod.compare?.value ?? s;
  const isCompound = explodeMod.kind === "compound";
  const isPenetrate = explodeMod.kind === "penetrate";
  const maxExplosions = 10;

  function singleExploding(): Distribution {
    const dist: Distribution = new Map();
    const pFace = 1 / s;

    let accumulated: Distribution = new Map([[0, 1]]);

    for (let depth = 0; depth <= maxExplosions; depth++) {
      const nextAccumulated: Distribution = new Map();

      for (const [accSum, accProb] of accumulated) {
        for (let face = 1; face <= s; face++) {
          // Penetrating: explosions subtract 1 (min 1) from the new roll
          const effectiveFace =
            isPenetrate && depth > 0 ? Math.max(1, face - 1) : face;
          const total = accSum + effectiveFace;
          const p = accProb * pFace;

          if (face < threshold || depth === maxExplosions) {
            dist.set(total, (dist.get(total) ?? 0) + p);
          } else {
            nextAccumulated.set(total, (nextAccumulated.get(total) ?? 0) + p);
          }
        }
      }

      accumulated = nextAccumulated;
      if (accumulated.size === 0) break;
    }

    return dist;
  }

  // For compounding, the distribution shape is the same as exploding
  // (sum of chain of rolls) — the difference is engine-side (one die vs many).
  // The probability distribution is identical.
  const single = singleExploding();
  return convolveN(single, node.count);
}

/** Distribution for simple reroll (no keep/drop, no explode). */
function rerollDistribution(node: DiceNode): Distribution | null {
  const hasReroll = node.modifiers.some(
    (m) => m.kind === "reroll" || m.kind === "reroll_once",
  );
  if (!hasReroll) return null;

  const single = singleDieWithReroll(node.sides, node.modifiers);
  return convolveN(single, node.count);
}

/** Distribution for simple min/max (no keep/drop, no explode, no reroll). */
function minMaxDistribution(node: DiceNode): Distribution | null {
  const hasMinMax = node.modifiers.some(
    (m) => m.kind === "min" || m.kind === "max",
  );
  if (!hasMinMax) return null;

  const base = singleDieDistribution(node.sides);
  const clamped = singleDieWithMinMax(base, node.modifiers);
  return convolveN(clamped, node.count);
}

/** Distribution for success counting pools (no keep/drop, no explode).
 *  Each die independently produces +1 (success), -1 (failure), or 0 (neutral).
 *  The distribution is over net count, computed via convolution. */
function successCountDistribution(node: DiceNode): Distribution | null {
  if (node.resultMode !== "success_count") return null;

  const csMods = node.modifiers.filter((m) => m.kind === "cs_count");
  const cfMods = node.modifiers.filter((m) => m.kind === "cf_count");

  if (csMods.length === 0) return null;

  // Build single-die distribution accounting for reroll + min/max first
  let baseDist: Distribution;
  const hasReroll = node.modifiers.some(
    (m) => m.kind === "reroll" || m.kind === "reroll_once",
  );
  if (hasReroll) {
    baseDist = singleDieWithReroll(node.sides, node.modifiers);
  } else {
    baseDist = singleDieDistribution(node.sides);
  }

  const hasMinMax = node.modifiers.some(
    (m) => m.kind === "min" || m.kind === "max",
  );
  if (hasMinMax) {
    baseDist = singleDieWithMinMax(baseDist, node.modifiers);
  }

  // Map each face to its contribution: +1 (success), -1 (failure), or 0
  const outcomeDist: Distribution = new Map();
  for (const [face, prob] of baseDist) {
    let contribution = 0;
    for (const mod of csMods) {
      if (mod.compare && matchesCompare(face, mod.compare)) {
        contribution++;
        break;
      }
    }
    for (const mod of cfMods) {
      if (mod.compare && matchesCompare(face, mod.compare)) {
        contribution--;
        break;
      }
    }
    outcomeDist.set(contribution, (outcomeDist.get(contribution) ?? 0) + prob);
  }

  return convolveN(outcomeDist, node.count);
}

// ─── Distribution algebra ────────────────────────────────────────────────────

function shiftDistribution(dist: Distribution, offset: number): Distribution {
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    result.set(v + offset, (result.get(v + offset) ?? 0) + p);
  }
  return result;
}

function scaleDistribution(dist: Distribution, factor: number): Distribution {
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    const scaled = v * factor;
    result.set(scaled, (result.get(scaled) ?? 0) + p);
  }
  return result;
}

function divideDistribution(dist: Distribution, divisor: number): Distribution {
  if (divisor === 0) return new Map([[0, 1]]);
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    const divided = Math.floor(v / divisor);
    result.set(divided, (result.get(divided) ?? 0) + p);
  }
  return result;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

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
      const hasExplosion = node.modifiers.some(
        (m) => m.kind === "explode" || m.kind === "compound" || m.kind === "penetrate",
      );
      const hasReroll = node.modifiers.some(
        (m) => m.kind === "reroll" || m.kind === "reroll_once",
      );
      const hasMinMax = node.modifiers.some(
        (m) => m.kind === "min" || m.kind === "max",
      );
      const isSuccessCount = node.resultMode === "success_count";

      // Success counting pool (no keep/drop, no explosion)
      if (isSuccessCount && !hasKeepDrop && !hasExplosion) {
        return successCountDistribution(node);
      }

      // Keep/drop present — full enumeration (handles reroll + min/max internally)
      if (hasKeepDrop) {
        return enumerateKeepDrop(node);
      }

      // Explosion variants (no keep/drop)
      if (hasExplosion) {
        return explosionDistribution(node);
      }

      // Reroll (no keep/drop, no explosion)
      if (hasReroll) {
        return rerollDistribution(node);
      }

      // Min/max (no keep/drop, no explosion, no reroll)
      if (hasMinMax) {
        return minMaxDistribution(node);
      }

      // Plain NdM
      return convolveDice(node.count, node.sides);
    }

    case "binary": {
      const left = tryExact(node.left);
      const right = tryExact(node.right);
      if (!left || !right) return null;

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
            const negated = scaleDistribution(right, -1);
            return shiftDistribution(negated, lv);
          }
          case "*":
            return scaleDistribution(right, lv);
          case "/":
            return null;
        }
      }

      if (node.op === "+") return convolve(left, right);
      if (node.op === "-") {
        const negated = scaleDistribution(right, -1);
        return convolve(left, negated);
      }

      return null;
    }

    case "unary_minus": {
      const inner = tryExact(node.operand);
      if (!inner) return null;
      return scaleDistribution(inner, -1);
    }
  }
}
