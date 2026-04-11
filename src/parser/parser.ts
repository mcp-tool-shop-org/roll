import { ASTNode, DiceModifier, DiceSides } from "./ast.js";
import { Token, TokenType } from "./tokens.js";
import { tokenize } from "./lexer.js";

export class ParseError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "ParseError";
  }
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new ParseError(
        `Expected ${type} but got ${token.type} ('${token.value}')`,
        token.position,
      );
    }
    return this.advance();
  }

  private match(...types: TokenType[]): Token | null {
    if (types.includes(this.peek().type)) {
      return this.advance();
    }
    return null;
  }

  // expression → term (('+' | '-') term)*
  parseExpression(): ASTNode {
    let left = this.parseTerm();

    while (this.peek().type === TokenType.PLUS || this.peek().type === TokenType.MINUS) {
      const op = this.advance();
      const right = this.parseTerm();
      left = {
        type: "binary",
        op: op.type === TokenType.PLUS ? "+" : "-",
        left,
        right,
      };
    }

    return left;
  }

  // term → factor (('*' | '/') factor)*
  private parseTerm(): ASTNode {
    let left = this.parseFactor();

    while (this.peek().type === TokenType.STAR || this.peek().type === TokenType.SLASH) {
      const op = this.advance();
      const right = this.parseFactor();
      left = {
        type: "binary",
        op: op.type === TokenType.STAR ? "*" : "/",
        left,
        right,
      };
    }

    return left;
  }

  // factor → '-' factor | '(' expression ')' | dice | number
  private parseFactor(): ASTNode {
    // Unary minus
    if (this.peek().type === TokenType.MINUS) {
      this.advance();
      const operand = this.parseFactor();
      return { type: "unary_minus", operand };
    }

    // Parenthesized expression
    if (this.peek().type === TokenType.LPAREN) {
      this.advance();
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return expr;
    }

    // Dice or number: starts with NUMBER or D
    if (this.peek().type === TokenType.NUMBER) {
      const numToken = this.advance();
      const numValue = parseInt(numToken.value, 10);

      // Check if followed by 'd' → dice expression
      if (this.peek().type === TokenType.D) {
        return this.parseDice(numValue);
      }

      // Just a number
      return { type: "number", value: numValue };
    }

    // Bare 'd' (implicit 1d)
    if (this.peek().type === TokenType.D) {
      return this.parseDice(1);
    }

    throw new ParseError(
      `Unexpected token: ${this.peek().type} ('${this.peek().value}')`,
      this.peek().position,
    );
  }

  // dice → 'd' M [modifier]*
  // Called with count already parsed
  private parseDice(count: number): ASTNode {
    this.expect(TokenType.D);

    // Parse sides: number, %, or F
    let sides: DiceSides;
    if (this.peek().type === TokenType.PERCENT) {
      this.advance();
      sides = "%";
    } else if (this.peek().type === TokenType.F) {
      this.advance();
      sides = "F";
    } else if (this.peek().type === TokenType.NUMBER) {
      const token = this.advance();
      sides = parseInt(token.value, 10);
      if (sides < 1) {
        throw new ParseError("Die must have at least 1 side", token.position);
      }
    } else {
      throw new ParseError(
        `Expected die size after 'd', got ${this.peek().type}`,
        this.peek().position,
      );
    }

    // Parse modifiers
    const modifiers: DiceModifier[] = [];
    let parsing = true;
    while (parsing) {
      switch (this.peek().type) {
        case TokenType.KH: {
          this.advance();
          const n = this.parseOptionalNumber(1);
          modifiers.push({ kind: "kh", value: n });
          break;
        }
        case TokenType.KL: {
          this.advance();
          const n = this.parseOptionalNumber(1);
          modifiers.push({ kind: "kl", value: n });
          break;
        }
        case TokenType.DH: {
          this.advance();
          const n = this.parseOptionalNumber(1);
          modifiers.push({ kind: "dh", value: n });
          break;
        }
        case TokenType.DL: {
          this.advance();
          const n = this.parseOptionalNumber(1);
          modifiers.push({ kind: "dl", value: n });
          break;
        }
        case TokenType.BANG: {
          this.advance();
          let threshold: number | undefined;
          if (this.peek().type === TokenType.GT) {
            this.advance();
            const numToken = this.expect(TokenType.NUMBER);
            threshold = parseInt(numToken.value, 10);
          }
          modifiers.push({ kind: "explode", value: threshold });
          break;
        }
        default:
          parsing = false;
      }
    }

    return { type: "dice", count, sides, modifiers };
  }

  private parseOptionalNumber(defaultValue: number): number {
    if (this.peek().type === TokenType.NUMBER) {
      return parseInt(this.advance().value, 10);
    }
    return defaultValue;
  }
}

export function parse(input: string): ASTNode {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression();

  // Ensure we consumed everything
  const remaining = tokens[parser["pos"]];
  if (remaining && remaining.type !== TokenType.EOF) {
    throw new ParseError(
      `Unexpected token after expression: ${remaining.type} ('${remaining.value}')`,
      remaining.position,
    );
  }

  return ast;
}
