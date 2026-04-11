export enum TokenType {
  NUMBER = "NUMBER",
  D = "D",
  PLUS = "PLUS",
  MINUS = "MINUS",
  STAR = "STAR",
  SLASH = "SLASH",
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  // Keep/drop
  KH = "KH",
  KL = "KL",
  DH = "DH",
  DL = "DL",
  // Explosion variants
  BANG = "BANG",
  BANG_BANG = "BANG_BANG",
  BANG_P = "BANG_P",
  // Comparison operators
  GT = "GT",
  GTE = "GTE",
  LT = "LT",
  LTE = "LTE",
  EQ = "EQ",
  // Reroll
  R = "R",
  RO = "RO",
  // Success/failure counting and marking
  CS = "CS",
  CF = "CF",
  // Sorting
  SA = "SA",
  SD = "SD",
  // Min/max clamping
  MIN = "MIN",
  MAX = "MAX",
  // Special die types
  PERCENT = "PERCENT",
  F = "F",
  EOF = "EOF",
}

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}
