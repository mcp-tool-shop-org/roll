import { ASTNode, ComparePoint, DiceModifier, DiceSides } from "./ast.js";
import { Token, TokenType } from "./tokens.js";
import { tokenize } from "./lexer.js";

export class ParseError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "ParseError";
  }
}

// ─── Input-size caps (DoS prevention) ────────────────────────────────────────
// A single crafted expression must never be able to force unbounded work
// (allocation, iteration, or string scanning). These caps are checked at parse
// time — before any dice are allocated — and throw the existing ParseError so
// every downstream consumer's existing catch block produces a clean error.
// The limits are generous for real RPG/VTT use; they exist only to block abuse.

/** Maximum number of dice in a single group (e.g. the N in `Nd6`). */
export const MAX_DICE_COUNT = 10_000;
/** Maximum number of sides on a single die (e.g. the M in `1dM`). */
export const MAX_DIE_SIDES = 1_000_000;
/** Maximum length, in characters, of a whole expression string. */
export const MAX_EXPRESSION_LENGTH = 1_000;

const COMPARE_TOKENS = new Set([
  TokenType.GT,
  TokenType.GTE,
  TokenType.LT,
  TokenType.LTE,
  TokenType.EQ,
]);

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

  /** Parse a compare point: >, >=, <, <=, = followed by a number. */
  private parseComparePoint(): ComparePoint | undefined {
    const token = this.peek();
    if (!COMPARE_TOKENS.has(token.type)) return undefined;

    this.advance();
    const numToken = this.expect(TokenType.NUMBER);
    const value = parseInt(numToken.value, 10);

    const operatorMap: Record<string, ComparePoint["operator"]> = {
      [TokenType.GT]: ">",
      [TokenType.GTE]: ">=",
      [TokenType.LT]: "<",
      [TokenType.LTE]: "<=",
      [TokenType.EQ]: "=",
    };

    return { operator: operatorMap[token.type], value };
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
    // Cap dice count before the 'd' is consumed so the error position points at
    // the count token (the current token is still 'd', positioned right after).
    if (count > MAX_DICE_COUNT) {
      throw new ParseError(
        `Dice count ${count} exceeds maximum of ${MAX_DICE_COUNT}`,
        this.peek().position,
      );
    }

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
      if (sides > MAX_DIE_SIDES) {
        throw new ParseError(
          `Die sides ${sides} exceeds maximum of ${MAX_DIE_SIDES}`,
          token.position,
        );
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
        // --- Keep/Drop (unchanged from V1) ---
        case TokenType.KH: {
          this.advance();
          modifiers.push({ kind: "kh", value: this.parseOptionalNumber(1) });
          break;
        }
        case TokenType.KL: {
          this.advance();
          modifiers.push({ kind: "kl", value: this.parseOptionalNumber(1) });
          break;
        }
        case TokenType.DH: {
          this.advance();
          modifiers.push({ kind: "dh", value: this.parseOptionalNumber(1) });
          break;
        }
        case TokenType.DL: {
          this.advance();
          modifiers.push({ kind: "dl", value: this.parseOptionalNumber(1) });
          break;
        }

        // --- Explosion variants ---
        case TokenType.BANG: {
          this.advance();
          const cp = this.parseComparePoint();
          modifiers.push({ kind: "explode", compare: cp });
          break;
        }
        case TokenType.BANG_BANG: {
          this.advance();
          const cp = this.parseComparePoint();
          modifiers.push({ kind: "compound", compare: cp });
          break;
        }
        case TokenType.BANG_P: {
          this.advance();
          const cp = this.parseComparePoint();
          modifiers.push({ kind: "penetrate", compare: cp });
          break;
        }

        // --- Reroll ---
        case TokenType.R: {
          this.advance();
          const cp = this.parseComparePoint() ?? { operator: "=" as const, value: 1 };
          modifiers.push({ kind: "reroll", compare: cp });
          break;
        }
        case TokenType.RO: {
          this.advance();
          const cp = this.parseComparePoint() ?? { operator: "=" as const, value: 1 };
          modifiers.push({ kind: "reroll_once", compare: cp });
          break;
        }

        // --- Success/failure counting and marking ---
        case TokenType.CS: {
          this.advance();
          const cp = this.parseComparePoint();
          if (cp) {
            modifiers.push({ kind: "cs_count", compare: cp });
          } else {
            modifiers.push({ kind: "cs_mark" });
          }
          break;
        }
        case TokenType.CF: {
          this.advance();
          const cp = this.parseComparePoint();
          if (cp) {
            modifiers.push({ kind: "cf_count", compare: cp });
          } else {
            modifiers.push({ kind: "cf_mark" });
          }
          break;
        }

        // --- Min/Max clamping ---
        case TokenType.MIN: {
          this.advance();
          const numToken = this.expect(TokenType.NUMBER);
          modifiers.push({ kind: "min", value: parseInt(numToken.value, 10) });
          break;
        }
        case TokenType.MAX: {
          this.advance();
          const numToken = this.expect(TokenType.NUMBER);
          modifiers.push({ kind: "max", value: parseInt(numToken.value, 10) });
          break;
        }

        // --- Sorting ---
        case TokenType.SA: {
          this.advance();
          modifiers.push({ kind: "sort_asc" });
          break;
        }
        case TokenType.SD: {
          this.advance();
          modifiers.push({ kind: "sort_desc" });
          break;
        }

        default:
          parsing = false;
      }
    }

    // Determine result mode: success_count if any success/failure COUNT
    // modifier is present. A pool with only cf_count (e.g. `10d6cf<2`) must
    // still enter success_count mode so the failure count is reflected in the
    // total rather than silently ignored in sum mode. (F-PE-005)
    const hasSuccessCounting = modifiers.some(
      (m) => m.kind === "cs_count" || m.kind === "cf_count",
    );
    const resultMode = hasSuccessCounting ? ("success_count" as const) : undefined;

    return { type: "dice", count, sides, modifiers, resultMode };
  }

  private parseOptionalNumber(defaultValue: number): number {
    if (this.peek().type === TokenType.NUMBER) {
      return parseInt(this.advance().value, 10);
    }
    return defaultValue;
  }
}

export function parse(input: string): ASTNode {
  // Cap expression length before tokenizing so a megabyte-long string can never
  // force a long scan. Checked first, before any work touches the input.
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new ParseError(
      `Expression exceeds maximum length of ${MAX_EXPRESSION_LENGTH} characters`,
      0,
    );
  }

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
