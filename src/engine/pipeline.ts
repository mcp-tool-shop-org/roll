import type { ASTNode, ComparePoint, DiceModifier, DiceNode, DiceSides } from "../parser/ast.js";
import { ParseError } from "../parser/parser.js";
import type { RngFn } from "./random.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineDie {
  value: number;
  kept: boolean;
  exploded: boolean;
  rerolledFrom?: number;
  critical?: "success" | "failure";
}

export interface PipelineResult {
  dice: PipelineDie[];
  total: number;
  resultMode: "sum" | "success_count";
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_EXPLOSIONS = 100;
export const MAX_REROLLS = 100;
/**
 * Hard cap on the total bonus rolls performed inside `stageExplode` for a
 * single dice group (mirrors `MAX_DICE_COUNT = 10_000` on Stage 1). A single
 * modifier on ≤100 dice does at most `100 × 100 = 10_000` bonus rolls, so normal
 * and exact-analyzed exploding pools never reach this limit; stacked explosion
 * modifiers (`2d3!<=4!!>=1`, `1d6!>=1!>=1!>=1`) that would otherwise amplify by
 * `(MAX_EXPLOSIONS + 1)^k = 101^k` throw a clean `ParseError` instead of
 * running unbounded work.
 */
export const MAX_EXPLOSION_ROLLS = 10_000;

const ROLL_ESTIMATE_CLAMP = 1e15;

// ─── Utilities ───────────────────────────────────────────────────────────────

export function resolveSides(sides: DiceSides): number {
  if (sides === "%") return 100;
  if (sides === "F") return 3;
  return sides;
}

export function rollSingleDie(sides: DiceSides, rng: RngFn): number {
  if (sides === "F") return rng(0, 2) - 1;
  const max = sides === "%" ? 100 : sides;
  return rng(1, max);
}

export function matchesCompare(value: number, cp: ComparePoint): boolean {
  switch (cp.operator) {
    case "=":
      return value === cp.value;
    case ">":
      return value > cp.value;
    case ">=":
      return value >= cp.value;
    case "<":
      return value < cp.value;
    case "<=":
      return value <= cp.value;
  }
}

function getExplosionThreshold(
  mod: DiceModifier,
  maxSide: number,
): ComparePoint {
  if (mod.compare) return mod.compare;
  return { operator: ">=", value: maxSide };
}

function getModsByKind(
  mods: DiceModifier[],
  ...kinds: DiceModifier["kind"][]
): DiceModifier[] {
  return mods.filter((m) => kinds.includes(m.kind));
}

/**
 * Count how many raw faces of a die (`-1..1` for Fate, `1..s` otherwise) match
 * `cp` in O(1) time without allocating a face array (safe even at `s = 1_000_000`).
 */
export function countMatchingFaces(sides: DiceSides, cp: ComparePoint): number {
  if (sides === "F") {
    let m = 0;
    for (const f of [-1, 0, 1]) {
      if (matchesCompare(f, cp)) m++;
    }
    return m;
  }
  const s = sides === "%" ? 100 : sides;
  const v = cp.value;
  switch (cp.operator) {
    case "=":
      return v >= 1 && v <= s ? 1 : 0;
    case ">":
      return Math.max(0, Math.min(s, s - v));
    case ">=":
      return Math.max(0, Math.min(s, s - v + 1));
    case "<":
      return Math.max(0, Math.min(s, v - 1));
    case "<=":
      return Math.max(0, Math.min(s, v));
  }
}

function canMatchOutOfRange(
  cp: ComparePoint,
  s: number,
  canBelowOne: boolean,
  canExceedMaxSide: boolean,
): boolean {
  if (
    canBelowOne &&
    (cp.operator === "<" ||
      cp.operator === "<=" ||
      (cp.operator === "=" && cp.value < 1))
  ) {
    return true;
  }
  if (
    canExceedMaxSide &&
    (cp.operator === ">" ||
      cp.operator === ">=" ||
      (cp.operator === "=" && cp.value > s))
  ) {
    return true;
  }
  return false;
}

/**
 * Estimate per-evaluation RNG roll counts (`expectedRolls` upper bound and
 * `maxRolls` worst case) for a single `DiceNode`, accounting for Stage 2
 * rerolls and Stage 4 stacked explosions (`explode` -> `compound` -> `penetrate`
 * in exact `stageExplode` order, where each active `explode`/`penetrate`
 * multiplies `dice.length` by up to `1 + MAX_EXPLOSIONS = 101`).
 */
export function estimateDiceNodeRolls(node: DiceNode): {
  expectedRolls: number;
  maxRolls: number;
  explosionModCount: number;
} {
  if (node.count <= 0) {
    return { expectedRolls: 0, maxRolls: 0, explosionModCount: 0 };
  }

  const s = resolveSides(node.sides);
  let expectedRolls = node.count;
  let maxRolls = node.count;
  let seenReroll = false;

  for (const mod of getModsByKind(node.modifiers, "reroll")) {
    if (!mod.compare) continue;
    const m = countMatchingFaces(node.sides, mod.compare);
    if (m <= 0) continue;
    const q = m / s;
    maxRolls = Math.min(ROLL_ESTIMATE_CLAMP, maxRolls + node.count * MAX_REROLLS);
    if (q >= 1) {
      expectedRolls = Math.min(
        ROLL_ESTIMATE_CLAMP,
        expectedRolls + node.count * MAX_REROLLS,
      );
    } else {
      const pEntry = seenReroll ? 1 : q;
      const extra = node.count * pEntry * ((1 - Math.pow(q, MAX_REROLLS)) / (1 - q));
      expectedRolls = Math.min(ROLL_ESTIMATE_CLAMP, expectedRolls + extra);
    }
    seenReroll = true;
  }

  for (const mod of getModsByKind(node.modifiers, "reroll_once")) {
    if (!mod.compare) continue;
    const m = countMatchingFaces(node.sides, mod.compare);
    if (m <= 0) continue;
    const q = m / s;
    const pEntry = seenReroll ? 1 : q;
    maxRolls = Math.min(ROLL_ESTIMATE_CLAMP, maxRolls + node.count);
    expectedRolls = Math.min(ROLL_ESTIMATE_CLAMP, expectedRolls + node.count * pEntry);
    seenReroll = true;
  }

  if (node.sides === "F") {
    return { expectedRolls, maxRolls, explosionModCount: 0 };
  }

  const explodeMods = getModsByKind(node.modifiers, "explode");
  const compoundMods = getModsByKind(node.modifiers, "compound");
  const penetrateMods = getModsByKind(node.modifiers, "penetrate");
  const explosionModCount =
    explodeMods.length + compoundMods.length + penetrateMods.length;

  if (explosionModCount === 0) {
    return { expectedRolls, maxRolls, explosionModCount: 0 };
  }

  const hasPreClamp =
    seenReroll ||
    node.modifiers.some((m) => m.kind === "min" || m.kind === "max");
  let canExceedMaxSide = node.modifiers.some(
    (m) => m.kind === "min" && (m.value ?? 0) > s,
  );
  const canBelowOne = node.modifiers.some(
    (m) => m.kind === "max" && (m.value ?? 1) < 1,
  );

  let expDice = node.count;
  let maxDice = node.count;
  let stage4Exp = 0;
  let stage4Max = 0;

  for (const mod of explodeMods) {
    const cp = getExplosionThreshold(mod, s);
    const m = countMatchingFaces(node.sides, cp);
    const outMatch = canMatchOutOfRange(cp, s, canBelowOne, canExceedMaxSide);
    if (m > 0) {
      const q = m / s;
      const chainExp =
        q >= 1 ? MAX_EXPLOSIONS : (1 - Math.pow(q, MAX_EXPLOSIONS)) / (1 - q);
      const p0 = hasPreClamp || outMatch ? 1 : q;
      const bonusExpPerDie = p0 * chainExp;
      stage4Exp = Math.min(ROLL_ESTIMATE_CLAMP, stage4Exp + expDice * bonusExpPerDie);
      expDice = Math.min(ROLL_ESTIMATE_CLAMP, expDice * (1 + bonusExpPerDie));
      stage4Max = Math.min(ROLL_ESTIMATE_CLAMP, stage4Max + maxDice * MAX_EXPLOSIONS);
      maxDice = Math.min(ROLL_ESTIMATE_CLAMP, maxDice * (1 + MAX_EXPLOSIONS));
    } else if (outMatch) {
      stage4Exp = Math.min(ROLL_ESTIMATE_CLAMP, stage4Exp + expDice);
      expDice = Math.min(ROLL_ESTIMATE_CLAMP, expDice * 2);
      stage4Max = Math.min(ROLL_ESTIMATE_CLAMP, stage4Max + maxDice);
      maxDice = Math.min(ROLL_ESTIMATE_CLAMP, maxDice * 2);
    }
  }

  for (const mod of compoundMods) {
    const cp = getExplosionThreshold(mod, s);
    const m = countMatchingFaces(node.sides, cp);
    const outMatch = canMatchOutOfRange(cp, s, canBelowOne, canExceedMaxSide);
    if (m > 0) {
      const q = m / s;
      const chainExp =
        q >= 1 ? MAX_EXPLOSIONS : (1 - Math.pow(q, MAX_EXPLOSIONS)) / (1 - q);
      const p0 = hasPreClamp || outMatch ? 1 : q;
      const bonusExpPerDie = p0 * chainExp;
      stage4Exp = Math.min(ROLL_ESTIMATE_CLAMP, stage4Exp + expDice * bonusExpPerDie);
      stage4Max = Math.min(ROLL_ESTIMATE_CLAMP, stage4Max + maxDice * MAX_EXPLOSIONS);
      canExceedMaxSide = true;
    } else if (outMatch) {
      stage4Exp = Math.min(ROLL_ESTIMATE_CLAMP, stage4Exp + expDice);
      stage4Max = Math.min(ROLL_ESTIMATE_CLAMP, stage4Max + maxDice);
      canExceedMaxSide = true;
    }
  }

  for (const mod of penetrateMods) {
    const cp = getExplosionThreshold(mod, s);
    const m = countMatchingFaces(node.sides, cp);
    const outMatch = canMatchOutOfRange(cp, s, canBelowOne, canExceedMaxSide);
    if (m > 0) {
      const q = m / s;
      const chainExp =
        q >= 1 ? MAX_EXPLOSIONS : (1 - Math.pow(q, MAX_EXPLOSIONS)) / (1 - q);
      const p0 = hasPreClamp || outMatch ? 1 : q;
      const bonusExpPerDie = p0 * chainExp;
      stage4Exp = Math.min(ROLL_ESTIMATE_CLAMP, stage4Exp + expDice * bonusExpPerDie);
      expDice = Math.min(ROLL_ESTIMATE_CLAMP, expDice * (1 + bonusExpPerDie));
      stage4Max = Math.min(ROLL_ESTIMATE_CLAMP, stage4Max + maxDice * MAX_EXPLOSIONS);
      maxDice = Math.min(ROLL_ESTIMATE_CLAMP, maxDice * (1 + MAX_EXPLOSIONS));
    } else if (outMatch) {
      stage4Exp = Math.min(ROLL_ESTIMATE_CLAMP, stage4Exp + expDice);
      expDice = Math.min(ROLL_ESTIMATE_CLAMP, expDice * 2);
      stage4Max = Math.min(ROLL_ESTIMATE_CLAMP, stage4Max + maxDice);
      maxDice = Math.min(ROLL_ESTIMATE_CLAMP, maxDice * 2);
    }
  }

  expectedRolls = Math.min(ROLL_ESTIMATE_CLAMP, expectedRolls + stage4Exp);
  maxRolls = Math.min(ROLL_ESTIMATE_CLAMP, maxRolls + stage4Max);
  return { expectedRolls, maxRolls, explosionModCount };
}

/**
 * Estimate per-sample roll cost across an AST for `analyze()` / Monte Carlo.
 * Uses worst-case `101^k` amplification when explosion modifiers are stacked on
 * one node (`explosionModCount >= 2`), and expected rolls per sample otherwise.
 */
export function estimateAstAnalyzeRolls(node: ASTNode): number {
  switch (node.type) {
    case "number":
      return 0;
    case "dice": {
      const { expectedRolls, maxRolls, explosionModCount } =
        estimateDiceNodeRolls(node);
      const cost = explosionModCount >= 2 ? maxRolls : Math.ceil(expectedRolls);
      return Math.min(ROLL_ESTIMATE_CLAMP, cost);
    }
    case "binary":
      return Math.min(
        ROLL_ESTIMATE_CLAMP,
        estimateAstAnalyzeRolls(node.left) + estimateAstAnalyzeRolls(node.right),
      );
    case "unary_minus":
      return estimateAstAnalyzeRolls(node.operand);
  }
}

// ─── Stage 1: Roll ───────────────────────────────────────────────────────────

export function stageRoll(
  count: number,
  sides: DiceSides,
  rng: RngFn,
): PipelineDie[] {
  const dice: PipelineDie[] = [];
  for (let i = 0; i < count; i++) {
    dice.push({
      value: rollSingleDie(sides, rng),
      kept: true,
      exploded: false,
    });
  }
  return dice;
}

// ─── Stage 2: Reroll ─────────────────────────────────────────────────────────

export function stageReroll(
  dice: PipelineDie[],
  mods: DiceModifier[],
  sides: DiceSides,
  rng: RngFn,
): void {
  const rerollMods = getModsByKind(mods, "reroll");
  const rerollOnceMods = getModsByKind(mods, "reroll_once");

  // Unlimited reroll: keep rerolling while any compare matches (capped)
  for (const mod of rerollMods) {
    if (!mod.compare) continue;
    for (const die of dice) {
      if (!die.kept) continue;
      let iterations = 0;
      while (matchesCompare(die.value, mod.compare) && iterations < MAX_REROLLS) {
        die.rerolledFrom = die.rerolledFrom ?? die.value;
        die.value = rollSingleDie(sides, rng);
        iterations++;
      }
    }
  }

  // Reroll once: reroll matching dice exactly once
  for (const mod of rerollOnceMods) {
    if (!mod.compare) continue;
    for (const die of dice) {
      if (!die.kept) continue;
      if (matchesCompare(die.value, mod.compare)) {
        die.rerolledFrom = die.value;
        die.value = rollSingleDie(sides, rng);
      }
    }
  }
}

// ─── Stage 3: Min/Max Clamping ───────────────────────────────────────────────

export function stageMinMax(dice: PipelineDie[], mods: DiceModifier[]): void {
  const minMods = getModsByKind(mods, "min");
  const maxMods = getModsByKind(mods, "max");

  for (const mod of minMods) {
    const floor = mod.value!;
    for (const die of dice) {
      if (die.kept && die.value < floor) {
        die.value = floor;
      }
    }
  }

  for (const mod of maxMods) {
    const ceiling = mod.value!;
    for (const die of dice) {
      if (die.kept && die.value > ceiling) {
        die.value = ceiling;
      }
    }
  }
}

// ─── Stage 4: Explode / Compound / Penetrate ─────────────────────────────────

export function stageExplode(
  dice: PipelineDie[],
  mods: DiceModifier[],
  sides: DiceSides,
  rng: RngFn,
): void {
  const isFate = sides === "F";
  if (isFate) return; // Fate dice never explode

  const explodeMods = getModsByKind(mods, "explode");
  const compoundMods = getModsByKind(mods, "compound");
  const penetrateMods = getModsByKind(mods, "penetrate");
  if (
    explodeMods.length === 0 &&
    compoundMods.length === 0 &&
    penetrateMods.length === 0
  ) {
    return;
  }

  const maxSide = resolveSides(sides);

  // Fast pre-check when all raw faces match: reject guaranteed >MAX_EXPLOSION_ROLLS
  // blow-ups (e.g. `2d3!<=4!!>=1`, `1d6!>=1!>=1!>=1`) in O(mods) before drawing
  // thousands of CSPRNG samples.
  let exactInitial = true;
  let guaranteedRawDice = 0;
  let guaranteedBonus = 0;
  for (const mod of [...explodeMods, ...compoundMods, ...penetrateMods]) {
    const threshold = getExplosionThreshold(mod, maxSide);
    if (countMatchingFaces(sides, threshold) !== maxSide) {
      break;
    }
    if (exactInitial) {
      let matchingInitial = 0;
      let inRangeKept = 0;
      for (const d of dice) {
        if (!d.kept) continue;
        if (matchesCompare(d.value, threshold)) matchingInitial++;
        if (d.value >= 1 && d.value <= maxSide) inRangeKept++;
      }
      guaranteedBonus += matchingInitial * MAX_EXPLOSIONS;
      if (guaranteedBonus > MAX_EXPLOSION_ROLLS) {
        throw new ParseError(
          `Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`,
          0,
        );
      }
      if (mod.kind === "compound") break;
      guaranteedRawDice = matchingInitial * MAX_EXPLOSIONS + inRangeKept;
      exactInitial = false;
    } else {
      guaranteedBonus += guaranteedRawDice * MAX_EXPLOSIONS;
      if (guaranteedBonus > MAX_EXPLOSION_ROLLS) {
        throw new ParseError(
          `Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`,
          0,
        );
      }
      if (mod.kind === "compound") break;
      guaranteedRawDice += guaranteedRawDice * MAX_EXPLOSIONS;
    }
  }

  let totalExplosions = 0;

  // Standard exploding: add new dice
  for (const mod of explodeMods) {
    const threshold = getExplosionThreshold(mod, maxSide);
    const originalCount = dice.length;
    for (let i = 0; i < originalCount; i++) {
      // i < originalCount <= dice.length (the array only grows via push), so
      // dice[i] is always in-bounds and defined.
      const die = dice[i]!;
      if (!die.kept) continue;
      let current = die.value;
      let explosions = 0;
      while (matchesCompare(current, threshold) && explosions < MAX_EXPLOSIONS) {
        if (totalExplosions >= MAX_EXPLOSION_ROLLS) {
          throw new ParseError(
            `Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`,
            0,
          );
        }
        totalExplosions++;
        const newValue = rollSingleDie(sides, rng);
        dice.push({ value: newValue, kept: true, exploded: true });
        current = newValue;
        explosions++;
      }
    }
  }

  // Compounding: sum into same die
  for (const mod of compoundMods) {
    const threshold = getExplosionThreshold(mod, maxSide);
    for (const die of dice) {
      if (!die.kept) continue;
      let current = die.value;
      let explosions = 0;
      while (matchesCompare(current, threshold) && explosions < MAX_EXPLOSIONS) {
        if (totalExplosions >= MAX_EXPLOSION_ROLLS) {
          throw new ParseError(
            `Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`,
            0,
          );
        }
        totalExplosions++;
        const newValue = rollSingleDie(sides, rng);
        die.value += newValue;
        die.exploded = true;
        current = newValue;
        explosions++;
      }
    }
  }

  // Penetrating: add new dice but each explosion gets -1
  for (const mod of penetrateMods) {
    const threshold = getExplosionThreshold(mod, maxSide);
    const originalCount = dice.length;
    for (let i = 0; i < originalCount; i++) {
      // i < originalCount <= dice.length (the array only grows via push), so
      // dice[i] is always in-bounds and defined.
      const die = dice[i]!;
      if (!die.kept) continue;
      let current = die.value;
      let explosions = 0;
      while (matchesCompare(current, threshold) && explosions < MAX_EXPLOSIONS) {
        if (totalExplosions >= MAX_EXPLOSION_ROLLS) {
          throw new ParseError(
            `Explosion roll limit of ${MAX_EXPLOSION_ROLLS} exceeded`,
            0,
          );
        }
        totalExplosions++;
        const rawValue = rollSingleDie(sides, rng);
        const penValue = Math.max(1, rawValue - 1);
        dice.push({ value: penValue, kept: true, exploded: true });
        current = rawValue; // threshold check uses raw value
        explosions++;
      }
    }
  }
}

// ─── Stage 5: Keep/Drop ──────────────────────────────────────────────────────

export function stageKeepDrop(
  dice: PipelineDie[],
  mods: DiceModifier[],
): void {
  const keepDropMods = getModsByKind(mods, "kh", "kl", "dh", "dl");

  for (const mod of keepDropMods) {
    const n = mod.value ?? 1;
    const keptDice = dice.filter((d) => d.kept);
    const sorted = [...keptDice].sort((a, b) => a.value - b.value);

    switch (mod.kind) {
      case "kh": {
        const threshold = sorted.length - n;
        let dropped = 0;
        for (const d of sorted) {
          if (dropped < threshold) {
            d.kept = false;
            dropped++;
          }
        }
        break;
      }
      case "kl": {
        let kept = 0;
        for (const d of sorted) {
          if (kept < n) {
            kept++;
          } else {
            d.kept = false;
          }
        }
        break;
      }
      case "dh": {
        let dropped = 0;
        for (let i = sorted.length - 1; i >= 0 && dropped < n; i--) {
          // i is bounded to [0, sorted.length), so sorted[i] is defined.
          sorted[i]!.kept = false;
          dropped++;
        }
        break;
      }
      case "dl": {
        let dropped = 0;
        for (let i = 0; i < sorted.length && dropped < n; i++) {
          // i < sorted.length, so sorted[i] is defined.
          sorted[i]!.kept = false;
          dropped++;
        }
        break;
      }
    }
  }
}

// ─── Stage 6: Sort ───────────────────────────────────────────────────────────

export function stageSort(dice: PipelineDie[], mods: DiceModifier[]): void {
  const sortMod = mods.find(
    (m) => m.kind === "sort_asc" || m.kind === "sort_desc",
  );
  if (!sortMod) return;

  // Sort the kept dice in-place. Dropped dice stay at end.
  const kept = dice.filter((d) => d.kept);
  const dropped = dice.filter((d) => !d.kept);

  if (sortMod.kind === "sort_asc") {
    kept.sort((a, b) => a.value - b.value);
  } else {
    kept.sort((a, b) => b.value - a.value);
  }

  // Rebuild the array in-place
  dice.length = 0;
  dice.push(...kept, ...dropped);
}

// ─── Stage 7: Critical Mark ──────────────────────────────────────────────────

export function stageCriticalMark(
  dice: PipelineDie[],
  mods: DiceModifier[],
): void {
  const csCountMods = getModsByKind(mods, "cs_count");
  const cfCountMods = getModsByKind(mods, "cf_count");
  const csMarkMods = getModsByKind(mods, "cs_mark");
  const cfMarkMods = getModsByKind(mods, "cf_mark");

  const allCsMods = [...csCountMods, ...csMarkMods];
  const allCfMods = [...cfCountMods, ...cfMarkMods];

  for (const die of dice) {
    if (!die.kept) continue;

    for (const mod of allCsMods) {
      if (mod.compare && matchesCompare(die.value, mod.compare)) {
        die.critical = "success";
      }
    }

    for (const mod of allCfMods) {
      if (mod.compare && matchesCompare(die.value, mod.compare)) {
        die.critical = "failure";
      }
    }
  }
}

// ─── Stage 8: Total ──────────────────────────────────────────────────────────

export function stageTotal(
  dice: PipelineDie[],
  resultMode: "sum" | "success_count",
  mods: DiceModifier[],
): number {
  const keptDice = dice.filter((d) => d.kept);

  if (resultMode === "sum") {
    return keptDice.reduce((sum, d) => sum + d.value, 0);
  }

  // Success counting mode
  const csCountMods = getModsByKind(mods, "cs_count");
  const cfCountMods = getModsByKind(mods, "cf_count");

  let count = 0;
  for (const die of keptDice) {
    for (const mod of csCountMods) {
      if (mod.compare && matchesCompare(die.value, mod.compare)) {
        count++;
        break; // One success per die max
      }
    }
    for (const mod of cfCountMods) {
      if (mod.compare && matchesCompare(die.value, mod.compare)) {
        count--;
        break; // One failure per die max
      }
    }
  }

  return count;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export function runPipeline(
  count: number,
  sides: DiceSides,
  modifiers: DiceModifier[],
  rng: RngFn,
  resultMode: "sum" | "success_count" = "sum",
): PipelineResult {
  // Stage 1: Roll
  const dice = stageRoll(count, sides, rng);

  // Stage 2: Reroll
  stageReroll(dice, modifiers, sides, rng);

  // Stage 3: Min/Max
  stageMinMax(dice, modifiers);

  // Stage 4: Explode / Compound / Penetrate
  stageExplode(dice, modifiers, sides, rng);

  // Stage 5: Keep/Drop
  stageKeepDrop(dice, modifiers);

  // Stage 6: Sort
  stageSort(dice, modifiers);

  // Stage 7: Critical Mark
  stageCriticalMark(dice, modifiers);

  // Stage 8: Total
  const total = stageTotal(dice, resultMode, modifiers);

  return { dice, total, resultMode };
}
