import { describe, it, expect } from "vitest";
import { tokenize, LexerError } from "../src/parser/lexer.js";
import { TokenType } from "../src/parser/tokens.js";

describe("lexer", () => {
  it("tokenizes a simple dice expression", () => {
    const tokens = tokenize("2d6");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("tokenizes arithmetic", () => {
    const tokens = tokenize("2d6+3");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.PLUS,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("tokenizes keep highest", () => {
    const tokens = tokenize("4d6kh3");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.KH,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("tokenizes drop lowest", () => {
    const tokens = tokenize("4d6dl1");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.DL,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("tokenizes exploding dice", () => {
    const tokens = tokenize("1d6!");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.BANG,
      TokenType.EOF,
    ]);
  });

  it("tokenizes exploding with threshold", () => {
    const tokens = tokenize("1d6!>4");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.BANG,
      TokenType.GT,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("tokenizes percentile dice", () => {
    const tokens = tokenize("d%");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.D,
      TokenType.PERCENT,
      TokenType.EOF,
    ]);
  });

  it("tokenizes fate dice", () => {
    const tokens = tokenize("4dF");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.F,
      TokenType.EOF,
    ]);
  });

  it("tokenizes parenthesized expression", () => {
    const tokens = tokenize("(2d6+3)*2");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.LPAREN,
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.PLUS,
      TokenType.NUMBER,
      TokenType.RPAREN,
      TokenType.STAR,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("ignores whitespace", () => {
    const tokens = tokenize("2d6 + 3");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER,
      TokenType.D,
      TokenType.NUMBER,
      TokenType.PLUS,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("throws on invalid character", () => {
    expect(() => tokenize("2d6@3")).toThrow(LexerError);
  });

  // ─── V2 Tokens ───────────────────────────────────────────────────────────

  it("tokenizes comparison operators", () => {
    expect(tokenize(">=5").map((t) => t.type)).toEqual([
      TokenType.GTE, TokenType.NUMBER, TokenType.EOF,
    ]);
    expect(tokenize("<=3").map((t) => t.type)).toEqual([
      TokenType.LTE, TokenType.NUMBER, TokenType.EOF,
    ]);
    expect(tokenize("<2").map((t) => t.type)).toEqual([
      TokenType.LT, TokenType.NUMBER, TokenType.EOF,
    ]);
    expect(tokenize("=1").map((t) => t.type)).toEqual([
      TokenType.EQ, TokenType.NUMBER, TokenType.EOF,
    ]);
  });

  it("tokenizes compounding !!", () => {
    const tokens = tokenize("1d6!!");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.BANG_BANG, TokenType.EOF,
    ]);
  });

  it("tokenizes penetrating !p", () => {
    const tokens = tokenize("1d6!p");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.BANG_P, TokenType.EOF,
    ]);
  });

  it("tokenizes reroll r and ro", () => {
    const tokens = tokenize("2d6r<2");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.R, TokenType.LT, TokenType.NUMBER, TokenType.EOF,
    ]);

    const tokens2 = tokenize("2d6ro=1");
    expect(tokens2.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.RO, TokenType.EQ, TokenType.NUMBER, TokenType.EOF,
    ]);
  });

  it("tokenizes cs and cf", () => {
    const tokens = tokenize("8d6cs>=5");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.CS, TokenType.GTE, TokenType.NUMBER, TokenType.EOF,
    ]);

    const tokens2 = tokenize("8d6cf<=1");
    expect(tokens2.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.CF, TokenType.LTE, TokenType.NUMBER, TokenType.EOF,
    ]);
  });

  it("tokenizes sa and sd", () => {
    const tokens = tokenize("4d6sa");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.SA, TokenType.EOF,
    ]);
  });

  it("tokenizes min and max (3-char keywords)", () => {
    const tokens = tokenize("2d6min3");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.MIN, TokenType.NUMBER, TokenType.EOF,
    ]);

    const tokens2 = tokenize("2d6max5");
    expect(tokens2.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.MAX, TokenType.NUMBER, TokenType.EOF,
    ]);
  });

  it("ro matches before r (longest-match)", () => {
    const tokens = tokenize("2d6ro<2");
    const types = tokens.map((t) => t.type);
    expect(types).toContain(TokenType.RO);
    expect(types).not.toContain(TokenType.R);
  });

  it("distinguishes > from >=", () => {
    const gt = tokenize(">4");
    expect(gt[0].type).toBe(TokenType.GT);

    const gte = tokenize(">=4");
    expect(gte[0].type).toBe(TokenType.GTE);
  });

  it("tokenizes complex V2 expression", () => {
    const tokens = tokenize("8d6r<2!cs>=5f<=1sa");
    const types = tokens.map((t) => t.type);
    expect(types).toContain(TokenType.R);
    expect(types).toContain(TokenType.BANG);
    expect(types).toContain(TokenType.CS);
    expect(types).toContain(TokenType.SA);
  });

  it("tokenizes compounding with threshold", () => {
    const tokens = tokenize("1d6!!>4");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.NUMBER, TokenType.D, TokenType.NUMBER,
      TokenType.BANG_BANG, TokenType.GT, TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });
});
