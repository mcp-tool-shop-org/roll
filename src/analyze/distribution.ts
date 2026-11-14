import type { ASTNode, ComparePoint, DiceNode, DiceModifier, DiceSides } from "../parser/ast.js";
import { matchesCompare, MAX_EXPLOSIONS, MAX_REROLLS } from "../engine/pipeline.js";
import { monteCarloDistribution, DEFAULT_MONTE_CARLO_SAMPLES } from "./montecarlo.js";
import { ParseError } from "../parser/parser.js";

/** A probability distribution: value → probability (0..1) */
export type Distribution = Map<number, number>;

/**
 * Whether a distribution was computed EXACTLY (closed-form convolution /
 * enumeration) or ESTIMATED by Monte-Carlo sampling. The product is marketed on
 * "exact probabilities", so callers MUST be able to tell the two apart — a
 * sampled estimate is not an exact probability. (P-CORE-001)
 */
export type DistributionMethod = "exact" | "monte-carlo";

/**
 * Engine loop caps modelled by an `"exact"` distribution.
 *
 * Exploding dice and unlimited rerolls have no finite exact distribution in pure
 * mathematics; in Roll, `"exact"` means exact for the engine as built
 * (`runPipeline` in `src/engine/pipeline.ts`), including its finite loop caps
 * (`MAX_EXPLOSIONS = 100` and `MAX_REROLLS = 100`). Only caps actually exercised
 * by the expression are populated.
 */
export interface ModelledCaps {
  maxExplosions?: number;
  maxRerolls?: number;
}

/** A distribution paired with how it was produced. When `method` is
 *  "monte-carlo", `samples` is the number of Monte-Carlo iterations used; for
 *  the exact path `samples` is absent, and `caps` is present whenever the exact
 *  distribution models one or more of the engine's loop caps (`MAX_EXPLOSIONS`,
 *  `MAX_REROLLS`). (P-CORE-001) */
export interface DistributionWithMethod {
  distribution: Distribution;
  method: DistributionMethod;
  samples?: number;
  caps?: ModelledCaps;
}

/**
 * Modifier families used to ROUTE a dice node to an analysis strategy.
 * (P-CORE-002)
 *
 * Every DiceModifier kind maps to exactly one family via the exhaustive
 * `classifyModifier` switch below. Adding a new kind to the AST union without
 * adding a case there is a COMPILE error (the `assertNever` default), which is
 * the whole point: a new modifier can no longer slip through `tryExact` and get
 * silently analyzed as plain NdM.
 *
 *  - "keep-drop"      — kh/kl/dh/dl: change the kept set, handled by enumeration.
 *  - "explosion"      — explode/compound/penetrate: extra rolls added to a die.
 *  - "reroll"         — reroll/reroll_once: a face may be re-rolled.
 *  - "min-max"        — min/max: per-die clamping of the value.
 *  - "success-count"  — cs_count/cf_count: count successes/failures (net total).
 *  - "display-only"   — cs_mark/cf_mark/sort_asc/sort_desc: do NOT change the
 *                       numeric total, so they are IGNORED for analysis. (Sort
 *                       reorders dice for display; cs/cf MARK annotate criticals
 *                       without altering the sum.) Documented explicitly so the
 *                       "no effect on the distribution" decision is intentional.
 */
export type ModifierFamily =
  | "keep-drop"
  | "explosion"
  | "reroll"
  | "min-max"
  | "success-count"
  | "display-only";

/** Compile-time exhaustiveness guard: reaching here means a DiceModifier kind
 *  was added to the AST union without a case in `classifyModifier`. The `never`
 *  parameter makes that a type error at the call site. */
function assertNever(value: never): never {
  throw new Error(`Unhandled modifier kind: ${JSON.stringify(value)}`);
}

/**
 * Classify a single modifier into its analysis family via an EXHAUSTIVE switch
 * over the kind union. (P-CORE-002)
 *
 * This replaces the old set of independent `node.modifiers.some(m => m.kind ===
 * ...)` probes in `tryExact`. Those probes were not exhaustive: a brand-new
 * DiceModifier kind matched NONE of them and silently fell through to
 * `convolveDice`, so the analyzer returned a plain-NdM distribution as if the
 * new modifier did not exist (silent drift from the engine). Routing through one
 * exhaustive switch means a new kind forces a compile error HERE — at one site —
 * instead of mis-analyzing at runtime.
 */
export function classifyModifier(mod: Pick<DiceModifier, "kind">): ModifierFamily {
  switch (mod.kind) {
    case "kh":
    case "kl":
    case "dh":
    case "dl":
      return "keep-drop";
    case "explode":
    case "compound":
    case "penetrate":
      return "explosion";
    case "reroll":
    case "reroll_once":
      return "reroll";
    case "min":
    case "max":
      return "min-max";
    case "cs_count":
    case "cf_count":
      return "success-count";
    case "cs_mark":
    case "cf_mark":
    case "sort_asc":
    case "sort_desc":
      // Display-only: these never change the numeric total, so analysis ignores
      // them. cs_mark/cf_mark annotate criticals; sort_asc/sort_desc reorder
      // dice for presentation. A plain NdM (or whatever the value-affecting
      // modifiers produce) is the correct distribution.
      return "display-only";
    default:
      // Exhaustiveness: a new DiceModifier kind reaching here is a compile error.
      return assertNever(mod.kind);
  }
}

// ─── Cost bounds (analyze-path DoS prevention) ───────────────────────────────
// V1-001 / V1-002: the parser caps dice count (<=10000) and sides (<=1000000),
// which protects the ROLL path (rolling N dice once is cheap). But the ANALYZE
// path computes the FULL distribution by convolution — work proportional to
// count × sideCount — so a parse-clean expression like `10000d1000000` would
// build a ~1e6-entry Map and convolve it 10000× (support → ~10^10) and OOM/hang.
// Two independent guards close this; neither one alone is sufficient.

/**
 * Cap on the support (number of distinct outcomes) of any EXACT distribution.
 * Used to gate enumerateKeepDrop AND every convolution step. When the support
 * would exceed this, the exact path is abandoned and we fall back to Monte
 * Carlo (which is O(samples × dice), not O(support)). Reused unchanged.
 */
const MAX_EXACT_STATES = 10_000_000;

/**
 * Cap on the TOTAL number of dice rolled across the whole AST. This bounds the
 * Monte-Carlo fallback: each of the DEFAULT_SAMPLES (100_000) samples calls
 * evaluate(ast), which rolls every die in the expression. With this cap MC does
 * at most MAX_ANALYZE_DICE × 100_000 = 1e8 rolls — acceptable. 1000 dice is far
 * beyond any realistic RPG analysis (100d100, 20d20kh3, 8d6!, 10d10cs>=7 all
 * use ≤100 dice), so this rejects only the absurd. Exceeding it throws a
 * structured ParseError ("Expression too complex to analyze") at the top of
 * computeDistribution — before any convolution or sampling work begins.
 */
const MAX_ANALYZE_DICE = 1_000;

/**
 * Sentinel thrown internally by the convolution helpers when an exact
 * distribution's support would exceed MAX_EXACT_STATES. Caught in tryExact so
 * the whole exact attempt cleanly abandons to Monte Carlo. NEVER escapes this
 * module (computeDistribution converts an escape into the public ParseError).
 */
class ExactTooLargeError extends Error {
  constructor() {
    super("exact distribution support exceeds MAX_EXACT_STATES");
    this.name = "ExactTooLargeError";
  }
}

/** Count the total number of dice rolled across an AST (sum over all dice nodes). */
function countTotalDice(node: ASTNode): number {
  switch (node.type) {
    case "number":
      return 0;
    case "dice":
      return node.count;
    case "binary":
      return countTotalDice(node.left) + countTotalDice(node.right);
    case "unary_minus":
      return countTotalDice(node.operand);
  }
}

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

/** Enumerate every face of a die (Fate: -1,0,1; else 1..s). */
function allFaces(sides: DiceSides): number[] {
  if (sides === "F") return [-1, 0, 1];
  const s = sideCount(sides);
  const faces: number[] = [];
  for (let i = 1; i <= s; i++) faces.push(i);
  return faces;
}

/** Single-die distribution after reroll / reroll_once modifiers (Stage 2).
 *  Mirrors stageReroll in src/engine/pipeline.ts: runs all unlimited "reroll"
 *  modifiers first (capped at MAX_REROLLS = 100 — after 100 failed rerolls, the
 *  100th roll stands uniformly across matchingFaces), then all "reroll_once"
 *  modifiers. Returns null when an unlimited reroll matches every face
 *  (F-AT-007), so the caller falls back to Monte Carlo instead of returning an
 *  unmodified uniform distribution. */
function singleDieWithReroll(
  sides: DiceSides,
  mods: DiceModifier[],
  caps: ModelledCaps,
): Distribution | null {
  const base = singleDieDistribution(sides);
  const faces = allFaces(sides);
  const s = faces.length;

  let dist = new Map(base);

  const rerollMods = mods.filter((m) => m.kind === "reroll");
  const rerollOnceMods = mods.filter((m) => m.kind === "reroll_once");

  // Unlimited reroll: while matchesCompare(die.value, mod.compare) &&
  // iterations < MAX_REROLLS, roll a fresh uniform die.
  // - If every face matches (nonMatchingFaces.length === 0), return null so
  //   computeDistribution falls back to Monte Carlo (F-AT-007).
  // - Otherwise, let m = matchingFaces.length and q = m / s. An initial match
  //   (mass pMatch) escapes to nonMatchingFaces within MAX_REROLLS tries with
  //   total probability pMatch * (1 - q^MAX_REROLLS), distributed uniformly
  //   across nonMatchingFaces; with probability pMatch * q^MAX_REROLLS all
  //   MAX_REROLLS rerolls match, leaving the final roll uniformly distributed
  //   across matchingFaces (pMatch * q^MAX_REROLLS / m each).
  for (const mod of rerollMods) {
    if (!mod.compare) continue;
    const matchingFaces = faces.filter((f) => matchesCompare(f, mod.compare!));
    const nonMatchingFaces = faces.filter((f) => !matchesCompare(f, mod.compare!));
    if (nonMatchingFaces.length === 0) {
      return null;
    }
    if (matchingFaces.length === 0) {
      continue;
    }

    let pMatch = 0;
    for (const f of matchingFaces) {
      pMatch += dist.get(f) ?? 0;
    }
    if (pMatch === 0) {
      continue;
    }

    caps.maxRerolls = MAX_REROLLS;
    const q = matchingFaces.length / s;
    const qCap = Math.pow(q, MAX_REROLLS);
    const share = (pMatch * (1 - qCap)) / nonMatchingFaces.length;
    const residualEach =
      (pMatch * qCap) / matchingFaces.length || Number.MIN_VALUE;

    const newDist: Distribution = new Map();
    for (const face of nonMatchingFaces) {
      const p = (dist.get(face) ?? 0) + share;
      if (p > 0) newDist.set(face, p);
    }
    for (const face of matchingFaces) {
      newDist.set(face, residualEach);
    }
    dist = newDist;
  }

  // Reroll once: if current value matches mod.compare, roll one fresh uniform die.
  for (const mod of rerollOnceMods) {
    if (!mod.compare) continue;
    const matchingFaces = faces.filter((f) => matchesCompare(f, mod.compare!));

    let pMatch = 0;
    for (const f of matchingFaces) {
      pMatch += dist.get(f) ?? 0;
    }

    const newDist: Distribution = new Map();
    const pFace = 1 / s;
    for (const face of faces) {
      const isMatch = matchesCompare(face, mod.compare!);
      const p = (isMatch ? 0 : (dist.get(face) ?? 0)) + pMatch * pFace;
      if (p > 0) newDist.set(face, p);
    }
    dist = newDist;
  }

  return dist;
}

/** Single-die distribution after min/max clamping (Stage 3).
 *  Mirrors stageMinMax in src/engine/pipeline.ts: runs all "min" modifiers
 *  first, then all "max" modifiers. */
function singleDieWithMinMax(baseDist: Distribution, mods: DiceModifier[]): Distribution {
  let dist = new Map(baseDist);

  const minMods = mods.filter((m) => m.kind === "min");
  const maxMods = mods.filter((m) => m.kind === "max");

  for (const mod of minMods) {
    if (mod.value === undefined) continue;
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

  for (const mod of maxMods) {
    if (mod.value === undefined) continue;
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

  return dist;
}

/** Compose Stage 1 (initial roll) -> Stage 2 (reroll / reroll_once) -> Stage 3
 *  (min / max) for a single die. Returns null if an unlimited reroll is
 *  degenerate (matches all faces). */
function singleDiePreExplode(node: DiceNode, caps: ModelledCaps): Distribution | null {
  const hasReroll = node.modifiers.some(
    (m) => m.kind === "reroll" || m.kind === "reroll_once",
  );
  let dist: Distribution | null = hasReroll
    ? singleDieWithReroll(node.sides, node.modifiers, caps)
    : singleDieDistribution(node.sides);
  if (!dist) return null;

  const hasMinMax = node.modifiers.some(
    (m) => m.kind === "min" || m.kind === "max",
  );
  if (hasMinMax) {
    dist = singleDieWithMinMax(dist, node.modifiers);
  }
  return dist;
}

// ─── Convolution ─────────────────────────────────────────────────────────────

/** Convolve two distributions (sum of independent random variables).
 *  Throws ExactTooLargeError BEFORE the O(|a|·|b|) inner loop if EITHER:
 *    - the result support (≤ |a| + |b| - 1 distinct integer sums) would exceed
 *      MAX_EXACT_STATES — bounds allocation / Map size; OR
 *    - the inner-loop iteration count |a|·|b| would exceed MAX_EXACT_STATES —
 *      bounds COMPUTE TIME. The support bound alone is insufficient: a tall-but-
 *      narrow case like 500d1000 keeps support ~5e5 (under the state cap) yet
 *      each late step iterates 5e5 × 1000 = 5e8 times, so without this check the
 *      exact path is slow-but-finite (a multi-second-to-minute stall). With it,
 *      such cases throw early and fall back to bounded Monte Carlo, while real
 *      analysis (100d100 peaks at 1e4 × 100 = 1e6 iterations) stays exact. */
function convolve(a: Distribution, b: Distribution): Distribution {
  // Distinct integer sums of two supports number at most |a| + |b| - 1.
  if (a.size + b.size - 1 > MAX_EXACT_STATES) {
    throw new ExactTooLargeError();
  }
  // Bound per-step compute: the inner loop runs |a|·|b| times.
  if (a.size * b.size > MAX_EXACT_STATES) {
    throw new ExactTooLargeError();
  }
  const result: Distribution = new Map();
  for (const [va, pa] of a) {
    if (pa <= 0) continue;
    for (const [vb, pb] of b) {
      if (pb <= 0) continue;
      const sum = (va + vb) || 0;
      const prod = pa * pb || Number.MIN_VALUE;
      result.set(sum, (result.get(sum) ?? 0) + prod);
    }
  }
  return result;
}

/** Convolve a single-die distribution N times. Throws ExactTooLargeError (via
 *  convolve) when the accumulated support would exceed MAX_EXACT_STATES. */
function convolveN(single: Distribution, count: number): Distribution {
  let dist: Distribution = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) {
    dist = convolve(dist, single);
  }
  return dist;
}

// ─── Exact strategies ────────────────────────────────────────────────────────

/** Distribution with keep/drop via full enumeration over the post-reroll,
 *  post-min/max single-die distribution (Stages 1-3 -> Stage 5 -> Stage 8). */
function enumerateKeepDrop(
  node: DiceNode,
  singleDieDist: Distribution,
): Distribution | null {
  const entries = [...singleDieDist.entries()];
  const totalStates = Math.pow(entries.length, node.count);
  if (totalStates > MAX_EXACT_STATES) return null;

  const dist: Distribution = new Map();
  const rolls = new Array<number>(node.count);

  function enumerate(depth: number, prob: number): void {
    if (depth === node.count) {
      const sorted = [...rolls].sort((a, b) => a - b);
      let kept = sorted.slice();

      for (const mod of node.modifiers) {
        if (mod.kind !== "kh" && mod.kind !== "kl" && mod.kind !== "dh" && mod.kind !== "dl") continue;
        const n = mod.value ?? 1;
        switch (mod.kind) {
          case "kh":
            kept = kept.slice(Math.max(0, kept.length - n));
            break;
          case "kl":
            kept = kept.slice(0, n);
            break;
          case "dh":
            kept = kept.slice(0, Math.max(0, kept.length - n));
            break;
          case "dl":
            kept = kept.slice(n);
            break;
        }
      }

      // Compute total based on result mode (Stage 8)
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

    for (const [face, pFace] of entries) {
      if (pFace <= 0) continue;
      rolls[depth] = face;
      enumerate(depth + 1, prob * pFace || Number.MIN_VALUE);
    }
  }

  enumerate(0, 1);
  return dist;
}

/** Distribution for exploding/compounding/penetrating dice via iterative depth
 *  expansion (Stages 1-3 -> Stage 4 -> Stage 8).
 *
 *  Mirrors stageExplode in src/engine/pipeline.ts up to MAX_EXPLOSIONS = 100:
 *  - Depth 0 (the initial roll) draws from `initialDieDist` (after stageReroll
 *    and stageMinMax).
 *  - Depth 1..MAX_EXPLOSIONS (explosion bonus rolls) calls rollSingleDie(sides,
 *    rng) directly, so bonus rolls are drawn uniformly from raw faces 1..s
 *    without reroll or min/max clamping.
 *  - At depth === MAX_EXPLOSIONS, chains stop unconditionally (matching
 *    `while (... && explosions < MAX_EXPLOSIONS)` in stageExplode). */
function explosionDistribution(
  node: DiceNode,
  initialDieDist: Distribution,
  caps: ModelledCaps,
): Distribution | null {
  if (node.sides === "F") return null;
  const s = sideCount(node.sides);

  const explodeMods = node.modifiers.filter(
    (m) => m.kind === "explode" || m.kind === "compound" || m.kind === "penetrate",
  );
  if (explodeMods.length !== 1) return null;
  const explodeMod = explodeMods[0]!;

  // F-AT-001: honor the FULL compare operator, not just its value. Mirror the
  // engine's getExplosionThreshold (pipeline.ts): default to {operator:">=",
  // value:s} when no compare is present so the two code paths cannot drift.
  // The old code collapsed this to `threshold = compare?.value ?? s` and decided
  // explosion with `face < threshold` (a hardcoded >=), silently ignoring the
  // operator — e.g. d10!>5 wrongly exploded on 5-10, d6!=3 wrongly on 3-6.
  const explodeCompare: ComparePoint = explodeMod.compare ?? {
    operator: ">=",
    value: s,
  };
  const isPenetrate = explodeMod.kind === "penetrate";

  function singleExploding(): Distribution {
    const dist: Distribution = new Map();
    const rawFaces: Array<[number, number]> = [];
    const pRaw = 1 / s;
    for (let f = 1; f <= s; f++) {
      rawFaces.push([f, pRaw]);
    }
    const initialFaces = [...initialDieDist.entries()];

    let accumulated: Distribution = new Map([[0, 1]]);

    for (let depth = 0; depth <= MAX_EXPLOSIONS; depth++) {
      const stepFaces = depth === 0 ? initialFaces : rawFaces;
      // Guard BOTH support allocation AND per-depth inner-loop work so huge
      // side counts (e.g. 1d1000!>=1) abandon early to Monte Carlo rather than
      // stalling across MAX_EXPLOSIONS = 100 steps.
      if (
        dist.size + accumulated.size + stepFaces.length > MAX_EXACT_STATES ||
        accumulated.size * stepFaces.length > MAX_EXACT_STATES
      ) {
        throw new ExactTooLargeError();
      }
      const nextAccumulated: Distribution = new Map();

      for (const [accSum, accProb] of accumulated) {
        if (accProb <= 0) continue;
        for (const [face, pFace] of stepFaces) {
          if (pFace <= 0) continue;
          // Penetrating: explosions subtract 1 (min 1) from bonus rolls (depth > 0)
          const effectiveFace =
            isPenetrate && depth > 0 ? Math.max(1, face - 1) : face;
          const total = accSum + effectiveFace;
          const p = accProb * pFace || Number.MIN_VALUE;

          // Explode exactly when the engine would: matchesCompare(face, cp).
          // Note the threshold check uses the RAW face (pre-penetration), which
          // matches the engine — penetrate adjusts the added value, not the test.
          const explodes = matchesCompare(face, explodeCompare);
          if (!explodes || depth === MAX_EXPLOSIONS) {
            if (explodes) {
              caps.maxExplosions = MAX_EXPLOSIONS;
            }
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

/** Distribution for success counting pools (no keep/drop, no explode).
 *  Each die independently produces +1 (success), -1 (failure), or 0 (neutral)
 *  from its post-reroll, post-min/max distribution.
 *  The distribution is over net count, computed via convolution. */
function successCountDistribution(
  node: DiceNode,
  baseDist: Distribution,
): Distribution | null {
  if (node.resultMode !== "success_count") return null;

  const csMods = node.modifiers.filter((m) => m.kind === "cs_count");
  const cfMods = node.modifiers.filter((m) => m.kind === "cf_count");

  if (csMods.length === 0 && cfMods.length === 0) return null;

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
    const shifted = (v + offset) || 0;
    result.set(shifted, (result.get(shifted) ?? 0) + p);
  }
  return result;
}

function scaleDistribution(dist: Distribution, factor: number): Distribution {
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    const scaled = (v * factor) || 0;
    result.set(scaled, (result.get(scaled) ?? 0) + p);
  }
  return result;
}

function divideDistribution(dist: Distribution, divisor: number): Distribution {
  if (divisor === 0) {
    throw new ParseError("Division by zero", 0);
  }
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    const divided = Math.floor(v / divisor) || 0;
    result.set(divided, (result.get(divided) ?? 0) + p);
  }
  return result;
}

/** Exact floor-division of two independent distributions A and B (`Math.floor(a / b)`).
 *  Throws ParseError("Division by zero") if B has positive mass at 0, and
 *  ExactTooLargeError if |A|·|B| exceeds MAX_EXACT_STATES. */
function divideDistributions(a: Distribution, b: Distribution): Distribution {
  if ((b.get(0) ?? 0) > 0) {
    throw new ParseError("Division by zero", 0);
  }
  if (a.size * b.size > MAX_EXACT_STATES) {
    throw new ExactTooLargeError();
  }
  const result: Distribution = new Map();
  for (const [va, pa] of a) {
    if (pa <= 0) continue;
    for (const [vb, pb] of b) {
      if (pb <= 0) continue;
      const divided = Math.floor(va / vb) || 0;
      const prod = pa * pb || Number.MIN_VALUE;
      result.set(divided, (result.get(divided) ?? 0) + prod);
    }
  }
  return result;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

/** Compute the full probability distribution for an AST.
 *
 *  Two cost guards make this safe against parse-clean but analytically
 *  intractable inputs (V1-001 / V1-002):
 *
 *  1. INPUT-DICE BUDGET (throws): if the total dice across the AST exceed
 *     MAX_ANALYZE_DICE, throw a structured ParseError BEFORE any work. This
 *     bounds the Monte-Carlo fallback (each sample rolls every die), so we never
 *     run an expensive MC for e.g. `10000d6!`. ParseError is the type the
 *     bridge/MCP/CLI boundaries already classify as a client validation error
 *     (→ INVALID_PARAMS / isError), so the caller sees a clean "too complex"
 *     message, not an internal error.
 *
 *  2. EXACT-STATE GUARD (falls back): the exact strategies abandon (via
 *     ExactTooLargeError, caught here) when a distribution's support would
 *     exceed MAX_EXACT_STATES, e.g. `500d1000`. That case is within the dice
 *     budget, so it falls back to a bounded Monte-Carlo estimate rather than
 *     throwing.
 *
 *  Division-by-zero contract:
 *  - Whenever a `/` divisor is exact (`tryExact(right)` succeeds), it is
 *    evaluated and checked BEFORE the dividend can abort with `ExactTooLargeError`
 *    (so `500d1000/(5d20-5)` deterministically throws `ParseError("Division by zero")`).
 *    Any divisor with P(divisor = 0) > 0 throws `ParseError("Division by zero")`.
 *  - When the divisor ITSELF is non-exact (`tryExact(right)` returns `null` or
 *    exceeds `MAX_EXACT_STATES`, e.g. `1d6/(5d20!kh4-4)`), analysis falls back
 *    to `monteCarloDistribution` (`DEFAULT_MONTE_CARLO_SAMPLES = 100_000` trials
 *    via `evaluate()`). If any sampled trial rolls a 0 divisor (e.g.
 *    `1d6/(4d6!kh3-12)`), `evaluate()` throws `ParseError("Division by zero")`
 *    immediately; if a rare zero outcome is not hit within the 100k sample
 *    horizon (e.g. `1d6/(5d20!kh4-4)`, P(0) = 20^-5), the result is returned
 *    honestly as `method: "monte-carlo"` with `samples: 100_000` (never `"exact"`).
 */
export function computeDistribution(ast: ASTNode): Distribution {
  return computeDistributionWithMethod(ast).distribution;
}

/**
 * Like {@link computeDistribution}, but also reports HOW the distribution was
 * produced: `method:"exact"` for a closed-form result (with `caps` populated
 * whenever the engine's `MAX_EXPLOSIONS = 100` or `MAX_REROLLS = 100` loop caps
 * were modelled), or `method:"monte-carlo"` with a `samples` count when the
 * exact path was abandoned and a sampled estimate was returned instead.
 * (P-CORE-001)
 */
export function computeDistributionWithMethod(ast: ASTNode): DistributionWithMethod {
  // Guard 1: input-dice budget — reject the truly absurd before any work.
  const totalDice = countTotalDice(ast);
  if (totalDice > MAX_ANALYZE_DICE) {
    throw new ParseError(
      `Expression too complex to analyze: ${totalDice} dice exceeds the ` +
        `analysis limit of ${MAX_ANALYZE_DICE}. (Rolling it is fine; computing ` +
        `its full probability distribution is not.)`,
      0,
    );
  }

  // Guard 2: exact-state guard — try exact, but fall back to MC if the support
  // would blow up. ExactTooLargeError is internal; any other error propagates.
  const caps: ModelledCaps = {};
  let result: Distribution | null;
  try {
    result = tryExact(ast, caps);
  } catch (e) {
    if (e instanceof ExactTooLargeError) {
      result = null; // abandon exact path, fall through to Monte Carlo
    } else {
      throw e;
    }
  }
  if (result) {
    const hasCaps =
      caps.maxExplosions !== undefined || caps.maxRerolls !== undefined;
    return hasCaps
      ? { distribution: result, method: "exact", caps }
      : { distribution: result, method: "exact" };
  }

  // Exact path abandoned → sampled estimate. Surface the method + sample count
  // so callers know these probabilities are approximate, not exact.
  const samples = DEFAULT_MONTE_CARLO_SAMPLES;
  return {
    distribution: monteCarloDistribution(ast, samples),
    method: "monte-carlo",
    samples,
  };
}

function mergeCaps(target: ModelledCaps, source: ModelledCaps): void {
  if (source.maxExplosions !== undefined) {
    target.maxExplosions = source.maxExplosions;
  }
  if (source.maxRerolls !== undefined) {
    target.maxRerolls = source.maxRerolls;
  }
}

function tryExact(node: ASTNode, caps: ModelledCaps): Distribution | null {
  switch (node.type) {
    case "number":
      return new Map([[node.value, 1]]);

    case "dice": {
      // P-CORE-002: route by an EXHAUSTIVE classification of each modifier kind,
      // not independent `.some(m => m.kind === ...)` probes.
      const families = new Set(node.modifiers.map(classifyModifier));
      const hasKeepDrop = families.has("keep-drop");
      const hasExplosion = families.has("explosion");
      const isSuccessCount = node.resultMode === "success_count";

      // Compose Stage 1 (roll) -> Stage 2 (reroll / reroll_once) -> Stage 3
      // (min / max) for a single die. Returns null when an unlimited reroll
      // matches every face (F-AT-007), falling back to Monte Carlo.
      const nodeCaps: ModelledCaps = {};
      const singleDie = singleDiePreExplode(node, nodeCaps);
      if (!singleDie) return null;

      if (hasKeepDrop) {
        if (hasExplosion) return null;
        const dist = enumerateKeepDrop(node, singleDie);
        if (!dist) return null;
        mergeCaps(caps, nodeCaps);
        return dist;
      }

      if (hasExplosion) {
        if (isSuccessCount) return null;
        const dist = explosionDistribution(node, singleDie, nodeCaps);
        if (!dist) return null;
        mergeCaps(caps, nodeCaps);
        return dist;
      }

      if (isSuccessCount) {
        const dist = successCountDistribution(node, singleDie);
        if (!dist) return null;
        mergeCaps(caps, nodeCaps);
        return dist;
      }

      const dist = convolveN(singleDie, node.count);
      mergeCaps(caps, nodeCaps);
      return dist;
    }

    case "binary": {
      // Evaluate and check `right` BEFORE `left` so an ExactTooLargeError on the
      // dividend (e.g. `500d1000/(5d20-5)`) never skips a deterministic
      // division-by-zero check on an exact divisor. Likewise isolate
      // ExactTooLargeError on each branch so nested `/` errors on either side
      // still propagate as ParseError("Division by zero").
      const rightCaps: ModelledCaps = {};
      let right: Distribution | null;
      let rightTooLarge = false;
      try {
        right = tryExact(node.right, rightCaps);
      } catch (e) {
        if (e instanceof ExactTooLargeError) {
          right = null;
          rightTooLarge = true;
        } else {
          throw e;
        }
      }

      if (node.op === "/" && right && (right.get(0) ?? 0) > 0) {
        throw new ParseError("Division by zero", 0);
      }

      const leftCaps: ModelledCaps = {};
      let left: Distribution | null;
      let leftTooLarge = false;
      try {
        left = tryExact(node.left, leftCaps);
      } catch (e) {
        if (e instanceof ExactTooLargeError) {
          left = null;
          leftTooLarge = true;
        } else {
          throw e;
        }
      }

      if (leftTooLarge || rightTooLarge) {
        throw new ExactTooLargeError();
      }
      if (!left || !right) return null;

      if (right.size === 1) {
        // right.size === 1, so the single key is always present.
        const rv = [...right.keys()][0]!;
        let out: Distribution;
        switch (node.op) {
          case "+":
            out = shiftDistribution(left, rv);
            break;
          case "-":
            out = shiftDistribution(left, -rv);
            break;
          case "*":
            out = scaleDistribution(left, rv);
            break;
          case "/":
            out = divideDistribution(left, rv);
            break;
        }
        mergeCaps(caps, leftCaps);
        mergeCaps(caps, rightCaps);
        return out;
      }

      if (left.size === 1) {
        // left.size === 1, so the single key is always present.
        const lv = [...left.keys()][0]!;
        let out: Distribution;
        switch (node.op) {
          case "+":
            out = shiftDistribution(right, lv);
            break;
          case "-": {
            const negated = scaleDistribution(right, -1);
            out = shiftDistribution(negated, lv);
            break;
          }
          case "*":
            out = scaleDistribution(right, lv);
            break;
          case "/":
            out = divideDistributions(left, right);
            break;
        }
        mergeCaps(caps, leftCaps);
        mergeCaps(caps, rightCaps);
        return out;
      }

      if (node.op === "+") {
        const out = convolve(left, right);
        mergeCaps(caps, leftCaps);
        mergeCaps(caps, rightCaps);
        return out;
      }
      if (node.op === "-") {
        const negated = scaleDistribution(right, -1);
        const out = convolve(left, negated);
        mergeCaps(caps, leftCaps);
        mergeCaps(caps, rightCaps);
        return out;
      }
      if (node.op === "/") {
        const out = divideDistributions(left, right);
        mergeCaps(caps, leftCaps);
        mergeCaps(caps, rightCaps);
        return out;
      }

      return null;
    }

    case "unary_minus": {
      const innerCaps: ModelledCaps = {};
      const inner = tryExact(node.operand, innerCaps);
      if (!inner) return null;
      mergeCaps(caps, innerCaps);
      return scaleDistribution(inner, -1);
    }
  }
}

// ─── Distribution comparison (FT-ANA-002) ─────────────────────────────────────

/**
 * Negate a distribution: map every value v → -v (the distribution of -X).
 * Public, additive helper used by {@link compareDistributions} to express
 * A − B as A convolved with (−B). (Internally `scaleDistribution(dist, -1)`
 * does the same, but it is private; this is the exported, named negate helper.)
 */
export function negateDistribution(dist: Distribution): Distribution {
  const result: Distribution = new Map();
  for (const [v, p] of dist) {
    result.set(-v, (result.get(-v) ?? 0) + p);
  }
  return result;
}

/** The result of comparing two distributions as a head-to-head contest. */
export interface DistributionComparison {
  /** P(A > B). */
  pAGreater: number;
  /** P(A === B) — the tie mass. */
  pEqual: number;
  /** P(B > A). */
  pBGreater: number;
  /** The distribution of the margin (A − B). Mass at key > 0 ⇒ A wins by that
   *  much; key < 0 ⇒ B wins; key 0 ⇒ tie. */
  margin: Distribution;
}

/**
 * Compare two independent distributions as a probability contest. Builds the
 * margin distribution of (A − B) by convolving A with the negation of B, then
 * reads off the three outcome probabilities from the margin's mass:
 *   - pAGreater = total mass at keys > 0
 *   - pEqual    = mass at key 0
 *   - pBGreater = total mass at keys < 0
 *
 * The three probabilities sum to the total mass of A×B (≈ 1 for normalized
 * inputs). Reuses the module's exact `convolve` (so the margin is computed
 * exactly when A and B are exact) and the public `negateDistribution`. (FT-ANA-002)
 */
export function compareDistributions(
  a: Distribution,
  b: Distribution,
): DistributionComparison {
  const margin = convolve(a, negateDistribution(b));

  let pAGreater = 0;
  let pEqual = 0;
  let pBGreater = 0;
  for (const [v, p] of margin) {
    if (v > 0) pAGreater += p;
    else if (v < 0) pBGreater += p;
    else pEqual += p;
  }

  return { pAGreater, pEqual, pBGreater, margin };
}
