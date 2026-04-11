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
    expect(ast.modifiers).toEqual([{ kind: "explode" }]);
  });

  it("parses exploding with threshold", () => {
    const ast = parse("1d6!>4") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "explode", compare: { operator: ">", value: 4 } },
    ]);
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

  // ─── V2 Modifiers ─────────────────────────────────────────────────────────

  it("parses reroll with compare point", () => {
    const ast = parse("2d6r<2") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "reroll", compare: { operator: "<", value: 2 } },
    ]);
  });

  it("parses reroll once", () => {
    const ast = parse("2d6ro=1") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "reroll_once", compare: { operator: "=", value: 1 } },
    ]);
  });

  it("parses bare reroll (defaults to =1)", () => {
    const ast = parse("2d6r") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "reroll", compare: { operator: "=", value: 1 } },
    ]);
  });

  it("parses compounding dice", () => {
    const ast = parse("1d6!!") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "compound" }]);
  });

  it("parses compounding with threshold", () => {
    const ast = parse("1d6!!>4") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "compound", compare: { operator: ">", value: 4 } },
    ]);
  });

  it("parses penetrating dice", () => {
    const ast = parse("1d6!p") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "penetrate" }]);
  });

  it("parses penetrating with threshold", () => {
    const ast = parse("1d6!p>=4") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "penetrate", compare: { operator: ">=", value: 4 } },
    ]);
  });

  it("parses success counting", () => {
    const ast = parse("8d6cs>=5") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "cs_count", compare: { operator: ">=", value: 5 } },
    ]);
    expect(ast.resultMode).toBe("success_count");
  });

  it("parses success + failure counting", () => {
    const ast = parse("8d6cs>=5cf<=1") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "cs_count", compare: { operator: ">=", value: 5 } },
      { kind: "cf_count", compare: { operator: "<=", value: 1 } },
    ]);
    expect(ast.resultMode).toBe("success_count");
  });

  it("parses min floor", () => {
    const ast = parse("2d6min3") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "min", value: 3 }]);
  });

  it("parses max ceiling", () => {
    const ast = parse("2d6max5") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "max", value: 5 }]);
  });

  it("parses sort ascending", () => {
    const ast = parse("4d6sa") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "sort_asc" }]);
  });

  it("parses sort descending", () => {
    const ast = parse("4d6sd") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "sort_desc" }]);
  });

  it("parses critical success mark (no compare point)", () => {
    const ast = parse("1d20cs") as DiceNode;
    expect(ast.modifiers).toEqual([{ kind: "cs_mark" }]);
    expect(ast.resultMode).toBeUndefined();
  });

  it("parses exploding with >= threshold", () => {
    const ast = parse("1d6!>=5") as DiceNode;
    expect(ast.modifiers).toEqual([
      { kind: "explode", compare: { operator: ">=", value: 5 } },
    ]);
  });

  it("parses complex modifier chain", () => {
    const ast = parse("4d6r<2min2kh3sa") as DiceNode;
    expect(ast.modifiers).toHaveLength(4);
    expect(ast.modifiers[0].kind).toBe("reroll");
    expect(ast.modifiers[1].kind).toBe("min");
    expect(ast.modifiers[2].kind).toBe("kh");
    expect(ast.modifiers[3].kind).toBe("sort_asc");
  });

  it("resultMode is undefined for non-pool expressions", () => {
    const ast = parse("4d6kh3") as DiceNode;
    expect(ast.resultMode).toBeUndefined();
  });

  it("parses WoD-style pool: 8d10cs>=8", () => {
    const ast = parse("8d10cs>=8") as DiceNode;
    expect(ast.count).toBe(8);
    expect(ast.sides).toBe(10);
    expect(ast.resultMode).toBe("success_count");
    expect(ast.modifiers[0]).toEqual({
      kind: "cs_count",
      compare: { operator: ">=", value: 8 },
    });
  });

  it("parses Shadowrun-style pool: 12d6cs>=5", () => {
    const ast = parse("12d6cs>=5") as DiceNode;
    expect(ast.count).toBe(12);
    expect(ast.resultMode).toBe("success_count");
  });

  it("parses all comparison operators in compare points", () => {
    const ops = [">", ">=", "<", "<=", "="] as const;
    const exprs = ["1d6!>4", "1d6!>=4", "1d6r<2", "1d6r<=2", "1d6r=1"];
    for (let i = 0; i < ops.length; i++) {
      const ast = parse(exprs[i]) as DiceNode;
      expect(ast.modifiers[0].compare?.operator).toBe(ops[i]);
    }
  });

  it("success counting with arithmetic: 8d6cs>=5+2", () => {
    const ast = parse("8d6cs>=5+2") as BinaryOpNode;
    expect(ast.type).toBe("binary");
    expect(ast.op).toBe("+");
    const dice = ast.left as DiceNode;
    expect(dice.resultMode).toBe("success_count");
  });
});
