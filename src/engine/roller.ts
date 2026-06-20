import type { ASTNode, DiceNode, DiceSides } from "../parser/ast.js";
import { ParseError } from "../parser/parser.js";
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
        // Emit "cf" + the compare (not bare "f", which re-tokenizes as Fate
        // dice and corrupts the round-trip). cf_count always carries a compare;
        // the guard keeps serialization total even if that ever changes.
        expr += "cf";
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
      // P-CORE-003: keep/drop are EXPLICIT cases (kh/kl/dh/dl serialize as their
      // kind + count), and the old catch-all `default` is replaced by an
      // exhaustive `never` guard. Previously the default emitted `mod.kind` as a
      // raw string for kh/kl/dh/dl; a NEW modifier kind would have silently
      // serialized as its raw enum name and failed to round-trip. Now an
      // unhandled kind is a COMPILE error here, forcing every new kind to get an
      // intentional serialization. (These four kinds' notation IS their kind
      // name, so the emitted text is unchanged — the round-trip tests still pass.)
      case "kh":
      case "kl":
      case "dh":
      case "dl":
        expr += mod.kind;
        if (mod.value !== undefined) expr += mod.value;
        break;
      default: {
        const _exhaustive: never = mod.kind;
        throw new Error(`Unhandled modifier kind in buildExpression: ${_exhaustive}`);
      }
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
            // Division by zero is a malformed expression — surface a clear
            // structured error rather than silently returning 0, which masks
            // the bug from every downstream consumer. (F-PE-004)
            if (right === 0) {
              throw new ParseError("Division by zero", 0);
            }
            return Math.floor(left / right);
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

/**
 * Test-only hook for the buildExpression serializer round-trip (F-TD-010).
 * Not part of the public API surface; exported so the round-trip invariant can
 * be asserted without exposing the internal helper to consumers.
 * @internal
 */
export function buildExpressionForTest(node: DiceNode): string {
  return buildExpression(node);
}
