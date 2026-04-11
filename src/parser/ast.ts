export type ASTNode = NumberNode | DiceNode | BinaryOpNode | UnaryMinusNode;

export interface NumberNode {
  type: "number";
  value: number;
}

export interface ComparePoint {
  operator: "=" | ">" | ">=" | "<" | "<=";
  value: number;
}

export interface DiceModifier {
  kind:
    | "kh"
    | "kl"
    | "dh"
    | "dl"
    | "explode"
    | "compound"
    | "penetrate"
    | "reroll"
    | "reroll_once"
    | "cs_count"
    | "cf_count"
    | "cs_mark"
    | "cf_mark"
    | "min"
    | "max"
    | "sort_asc"
    | "sort_desc";
  value?: number;
  compare?: ComparePoint;
}

export type DiceSides = number | "%" | "F";

export interface DiceNode {
  type: "dice";
  count: number;
  sides: DiceSides;
  modifiers: DiceModifier[];
  resultMode?: "sum" | "success_count";
}

export interface BinaryOpNode {
  type: "binary";
  op: "+" | "-" | "*" | "/";
  left: ASTNode;
  right: ASTNode;
}

export interface UnaryMinusNode {
  type: "unary_minus";
  operand: ASTNode;
}
