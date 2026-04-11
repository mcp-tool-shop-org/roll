export type ASTNode = NumberNode | DiceNode | BinaryOpNode | UnaryMinusNode;

export interface NumberNode {
  type: "number";
  value: number;
}

export interface DiceModifier {
  kind: "kh" | "kl" | "dh" | "dl" | "explode";
  value?: number; // kh3, dl1, explode threshold
}

export type DiceSides = number | "%" | "F";

export interface DiceNode {
  type: "dice";
  count: number;
  sides: DiceSides;
  modifiers: DiceModifier[];
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
