import type { ComparePoint, DiceModifier, DiceSides } from "../parser/ast.js";
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

const MAX_EXPLOSIONS = 100;
const MAX_REROLLS = 100;

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

  const maxSide = resolveSides(sides);

  // Standard exploding: add new dice
  for (const mod of getModsByKind(mods, "explode")) {
    const threshold = getExplosionThreshold(mod, maxSide);
    const originalCount = dice.length;
    for (let i = 0; i < originalCount; i++) {
      const die = dice[i];
      if (!die.kept) continue;
      let current = die.value;
      let explosions = 0;
      while (matchesCompare(current, threshold) && explosions < MAX_EXPLOSIONS) {
        const newValue = rollSingleDie(sides, rng);
        dice.push({ value: newValue, kept: true, exploded: true });
        current = newValue;
        explosions++;
      }
    }
  }

  // Compounding: sum into same die
  for (const mod of getModsByKind(mods, "compound")) {
    const threshold = getExplosionThreshold(mod, maxSide);
    for (const die of dice) {
      if (!die.kept) continue;
      let current = die.value;
      let explosions = 0;
      while (matchesCompare(current, threshold) && explosions < MAX_EXPLOSIONS) {
        const newValue = rollSingleDie(sides, rng);
        die.value += newValue;
        die.exploded = true;
        current = newValue;
        explosions++;
      }
    }
  }

  // Penetrating: add new dice but each explosion gets -1
  for (const mod of getModsByKind(mods, "penetrate")) {
    const threshold = getExplosionThreshold(mod, maxSide);
    const originalCount = dice.length;
    for (let i = 0; i < originalCount; i++) {
      const die = dice[i];
      if (!die.kept) continue;
      let current = die.value;
      let explosions = 0;
      while (matchesCompare(current, threshold) && explosions < MAX_EXPLOSIONS) {
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
          sorted[i].kept = false;
          dropped++;
        }
        break;
      }
      case "dl": {
        let dropped = 0;
        for (let i = 0; i < sorted.length && dropped < n; i++) {
          sorted[i].kept = false;
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
