import type { ASTNode, DiceNode, DiceSides } from "../parser/ast.js";
import { cryptoRng, type RngFn } from "./random.js";
import { runPipeline, type PipelineDie } from "./pipeline.js";

export interface DieResult {
  value: number;
  kept: boolean;
  exploded: boolean;
  rerolledFrom?: number;
  critical?: "success" | "failure";
}

export interface DiceGroupResult {
  expression: string;
  dice: DieResult[];
  total: number;
  resultMode: "sum" | "success_count";
}

export interface RollResult {
  expression: string;
  total: number;
  groups: DiceGroupResult[];
}

function pipelineDieToDieResult(d: PipelineDie): DieResult {
  const result: DieResult = {
    value: d.value,
    kept: d.kept,
    exploded: d.exploded,
  };
  if (d.rerolledFrom !== undefined) result.rerolledFrom = d.rerolledFrom;
  if (d.critical !== undefined) result.critical = d.critical;
  return result;
}

function buildExpression(node: DiceNode): string {
  let expr = `${node.count}d${node.sides === "%" ? "%" : node.sides === "F" ? "F" : node.sides}`;

  for (const mod of node.modifiers) {
    switch (mod.kind) {
      case "explode":
        expr += "!";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "compound":
        expr += "!!";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "penetrate":
        expr += "!p";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "reroll":
        expr += "r";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "reroll_once":
        expr += "ro";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "cs_count":
        expr += "cs";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "cf_count":
        expr += "f";
        if (mod.compare) expr += `${mod.compare.operator}${mod.compare.value}`;
        break;
      case "cs_mark":
        expr += "cs";
        break;
      case "cf_mark":
        expr += "cf";
        break;
      case "min":
        expr += `min${mod.value}`;
        break;
      case "max":
        expr += `max${mod.value}`;
        break;
      case "sort_asc":
        expr += "sa";
        break;
      case "sort_desc":
        expr += "sd";
        break;
      default:
        // kh, kl, dh, dl
        expr += mod.kind;
        if (mod.value !== undefined) expr += mod.value;
    }
  }

  return expr;
}

function rollDiceGroup(node: DiceNode, rng: RngFn): DiceGroupResult {
  const resultMode = node.resultMode ?? "sum";

  const pipeline = runPipeline(
    node.count,
    node.sides,
    node.modifiers,
    rng,
    resultMode,
  );

  return {
    expression: buildExpression(node),
    dice: pipeline.dice.map(pipelineDieToDieResult),
    total: pipeline.total,
    resultMode: pipeline.resultMode,
  };
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
