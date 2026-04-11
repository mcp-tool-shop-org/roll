import type { ASTNode, DiceNode, DiceModifier, DiceSides } from "../parser/ast.js";
import { cryptoRng, type RngFn } from "./random.js";

export interface DieResult {
  value: number;
  kept: boolean;
  exploded: boolean;
}

export interface DiceGroupResult {
  expression: string;
  dice: DieResult[];
  total: number;
}

export interface RollResult {
  expression: string;
  total: number;
  groups: DiceGroupResult[];
}

const MAX_EXPLOSIONS = 100;

function resolveSides(sides: DiceSides): number {
  if (sides === "%") return 100;
  if (sides === "F") return 3; // internal: we roll 0-2 and map to -1,0,+1
  return sides;
}

function rollSingleDie(sides: DiceSides, rng: RngFn): number {
  if (sides === "F") {
    return rng(0, 2) - 1; // -1, 0, +1
  }
  const max = sides === "%" ? 100 : sides;
  return rng(1, max);
}

function rollDiceGroup(node: DiceNode, rng: RngFn): DiceGroupResult {
  const maxSide = resolveSides(node.sides);
  const isFate = node.sides === "F";

  // Determine explosion settings
  const explodeMod = node.modifiers.find((m) => m.kind === "explode");
  const explodeThreshold = explodeMod
    ? explodeMod.value ?? (isFate ? undefined : maxSide)
    : undefined;

  // Roll initial dice
  const rawRolls: number[] = [];
  for (let i = 0; i < node.count; i++) {
    let roll = rollSingleDie(node.sides, rng);
    rawRolls.push(roll);

    // Handle exploding
    if (explodeThreshold !== undefined && !isFate) {
      let explosions = 0;
      while (roll >= explodeThreshold && explosions < MAX_EXPLOSIONS) {
        roll = rollSingleDie(node.sides, rng);
        rawRolls.push(roll);
        explosions++;
      }
    }
  }

  // Build die results (all kept initially)
  const dice: DieResult[] = rawRolls.map((value) => ({
    value,
    kept: true,
    exploded: false,
  }));

  // Mark exploded dice
  if (explodeThreshold !== undefined && !isFate) {
    let dieIndex = 0;
    for (let i = 0; i < node.count; i++) {
      // Skip the initial die
      dieIndex++;
      // Mark subsequent exploded dice
      while (
        dieIndex < dice.length &&
        dice[dieIndex - 1].value >= explodeThreshold
      ) {
        dice[dieIndex].exploded = true;
        dieIndex++;
      }
    }
  }

  // Apply keep/drop modifiers
  for (const mod of node.modifiers) {
    if (mod.kind === "explode") continue;
    applyKeepDrop(dice, mod);
  }

  const total = dice.filter((d) => d.kept).reduce((sum, d) => sum + d.value, 0);

  // Build expression string
  let expr = `${node.count}d${node.sides === "%" ? "%" : node.sides === "F" ? "F" : node.sides}`;
  for (const mod of node.modifiers) {
    if (mod.kind === "explode") {
      expr += "!";
      if (mod.value !== undefined) expr += `>${mod.value}`;
    } else {
      expr += mod.kind;
      if (mod.value !== undefined) expr += mod.value;
    }
  }

  return { expression: expr, dice, total };
}

function applyKeepDrop(dice: DieResult[], mod: DiceModifier): void {
  const n = mod.value ?? 1;
  const keptDice = dice.filter((d) => d.kept);

  // Sort by value to determine which to keep/drop
  const sorted = [...keptDice].sort((a, b) => a.value - b.value);

  switch (mod.kind) {
    case "kh": {
      // Keep highest N — drop everything else
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
      // Keep lowest N — drop everything else
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
      // Drop highest N
      let dropped = 0;
      for (let i = sorted.length - 1; i >= 0 && dropped < n; i--) {
        sorted[i].kept = false;
        dropped++;
      }
      break;
    }
    case "dl": {
      // Drop lowest N
      let dropped = 0;
      for (let i = 0; i < sorted.length && dropped < n; i++) {
        sorted[i].kept = false;
        dropped++;
      }
      break;
    }
  }
}

export function evaluate(ast: ASTNode, rng: RngFn = cryptoRng): RollResult {
  const groups: DiceGroupResult[] = [];

  function walk(node: ASTNode): number {
    switch (node.type) {
      case "number":
        return node.value;

      case "dice": {
        const group = rollDiceGroup(node, rng);
        groups.push(group);
        return group.total;
      }

      case "binary": {
        const left = walk(node.left);
        const right = walk(node.right);
        switch (node.op) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return right === 0 ? 0 : Math.floor(left / right);
        }
        break;
      }

      case "unary_minus":
        return -walk(node.operand);
    }
    return 0;
  }

  const total = walk(ast);
  return { expression: "", total, groups };
}
