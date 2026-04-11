import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../src/parser/parser.js";
import type { DiceNode, BinaryOpNode, NumberNode, UnaryMinusNode } from "../src/parser/ast.js";

describe("parser", () => {
  it("parses a simple number", () => {
    const ast = parse("42");
    expect(ast).toEqual({ type: "number", value: 42 });
  });

  it("parses basic dice", () => {
    const ast = parse("2d6") as DiceNode;
    expect(ast.type).toBe("dice");
    expect(ast.count).toBe(2);
    expect(ast.sides).toBe(6);
    expect(ast.modifiers).toEqual([]);
  });

  it("parses bare d20 (implicit 1d)", () => {
    const ast = parse("d20") as DiceNode;
    expect(ast.type).toBe("dice");
    expect(ast.count).toBe(1);
    expect(ast.sides).toBe(20);
  });

  it("parses dice with addition", () => {
    const ast = parse("2d6+3") as BinaryOpNode;
    expect(ast.type).toBe("binary");
    expect(ast.op).toBe("+");
    expect((ast.left as DiceNode).type).toBe("dice");
    expect((ast.right as NumberNode).value).toBe(3);
  });

  it("parses chained dice expressions", () => {
    const ast = parse("2d6+1d4+3") as BinaryOpNode;
    expect(ast.type).toBe("binary");
    expect(ast.op).toBe("+");
    // Left side: 2d6+1d4
    const left = ast.left as BinaryOpNode;
    expect(left.type).toBe("binary");
    expect(left.op).toBe("+");
  });

  it("parses multiplication with correct precedence", () => {
    const ast = parse("2d6*10") as BinaryOpNode;
    expect(ast.type).toBe("binary");
    expect(ast.op).toBe("*");
    expect((ast.left as DiceNode).sides).toBe(6);
    expect((ast.right as NumberNode).value).toBe(10);
  });

  it("respects operator precedence: 1d4+2d6*10", () => {
    const ast = parse("1d4+2d6*10") as BinaryOpNode;
    expect(ast.op).toBe("+");
    // Right side should be (2d6*10), not ((1d4+2d6)*10)
    const right = ast.right as BinaryOpNode;
    expect(right.op).toBe("*");
  });

  it("parses parenthesized expression", () => {
    const ast = parse("(2d6+3)*2") as BinaryOpNode;
    expect(ast.op).toBe("*");
    const left = ast.left as BinaryOpNode;
    expect(left.op).toBe("+");
  });

  it("parses keep highest", () => {
    const ast = parse("4d6kh3") as DiceNode;
    expect(ast.count).toBe(4);
    expect(ast.sides).toBe(6);
    expect(ast.modifiers).toEqual([{ kind: "kh", value: 3 }]);
  });

  it("parses drop lowest (no number = drop 1)", () => {
    const ast = parse("4d6dl") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "dl", value: 1 }]);
  });

  it("parses drop highest", () => {
    const ast = parse("4d6dh1") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "dh", value: 1 }]);
  });

  it("parses exploding dice", () => {
    const ast = parse("1d6!") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "explode", value: undefined }]);
  });

  it("parses exploding with threshold", () => {
    const ast = parse("1d6!>4") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "explode", value: 4 }]);
  });

  it("parses percentile dice", () => {
    const ast = parse("d%") as DiceNode;
    expect(ast.count).toBe(1);
    expect(ast.sides).toBe("%");
  });

  it("parses fate dice", () => {
    const ast = parse("4dF") as DiceNode;
    expect(ast.count).toBe(4);
    expect(ast.sides).toBe("F");
  });

  it("parses unary minus", () => {
    const ast = parse("-2") as UnaryMinusNode;
    expect(ast.type).toBe("unary_minus");
    expect((ast.operand as NumberNode).value).toBe(2);
  });

  it("parses complex D&D expression: 4d6kh3+5", () => {
    const ast = parse("4d6kh3+5") as BinaryOpNode;
    expect(ast.op).toBe("+");
    const dice = ast.left as DiceNode;
    expect(dice.count).toBe(4);
    expect(dice.sides).toBe(6);
    expect(dice.modifiers).toEqual([{ kind: "kh", value: 3 }]);
    expect((ast.right as NumberNode).value).toBe(5);
  });

  it("parses division", () => {
    const ast = parse("2d6/2") as BinaryOpNode;
    expect(ast.op).toBe("/");
  });

  it("throws on empty input", () => {
    expect(() => parse("")).toThrow(ParseError);
  });

  it("throws on trailing garbage", () => {
    expect(() => parse("2d6 d")).toThrow(ParseError);
  });

  it("throws on unclosed parenthesis", () => {
    expect(() => parse("(2d6+3")).toThrow(ParseError);
  });
});
