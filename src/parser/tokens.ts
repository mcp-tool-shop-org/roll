export enum TokenType {
  NUMBER = "NUMBER",
  D = "D",
  PLUS = "PLUS",
  MINUS = "MINUS",
  STAR = "STAR",
  SLASH = "SLASH",
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  KH = "KH",
  KL = "KL",
  DH = "DH",
  DL = "DL",
  BANG = "BANG",
  GT = "GT",
  PERCENT = "PERCENT",
  F = "F",
  EOF = "EOF",
}

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}
