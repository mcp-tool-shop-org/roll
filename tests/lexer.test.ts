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
});
