import { Token, TokenType } from "./tokens.js";

export class LexerError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "LexerError";
  }
}

// Longest-match keyword table — ordered longest-first within each length group.
// Keywords that are prefixes of others MUST come after the longer variant
// (e.g., "ro" before "r") to ensure greedy matching.
const KEYWORDS: Array<[string, TokenType]> = [
  // 3-char
  ["min", TokenType.MIN],
  ["max", TokenType.MAX],
  // 2-char
  ["kh", TokenType.KH],
  ["kl", TokenType.KL],
  ["dh", TokenType.DH],
  ["dl", TokenType.DL],
  ["ro", TokenType.RO],
  ["cs", TokenType.CS],
  ["cf", TokenType.CF],
  ["sa", TokenType.SA],
  ["sd", TokenType.SD],
  // 1-char (must be last — "r" is a prefix of "ro")
  ["r", TokenType.R],
];

// Token types that indicate dice context (for dh/dl disambiguation)
const DICE_CONTEXT_TOKENS = new Set<TokenType>([
  TokenType.NUMBER,
  TokenType.PERCENT,
  TokenType.F,
  TokenType.KH,
  TokenType.KL,
  TokenType.DH,
  TokenType.DL,
  TokenType.BANG,
  TokenType.BANG_BANG,
  TokenType.BANG_P,
  TokenType.GT,
  TokenType.GTE,
  TokenType.LT,
  TokenType.LTE,
  TokenType.EQ,
  TokenType.R,
  TokenType.RO,
  TokenType.CS,
  TokenType.CF,
  TokenType.SA,
  TokenType.SD,
  TokenType.MIN,
  TokenType.MAX,
]);

function tryMatchKeyword(
  input: string,
  pos: number,
  tokens: Token[],
): { type: TokenType; length: number } | null {
  const remaining = input.slice(pos).toLowerCase();

  for (const [keyword, type] of KEYWORDS) {
    if (!remaining.startsWith(keyword)) continue;

    // Ensure the character after the keyword is not a letter (word boundary).
    // This prevents matching "min" inside "mint" or "r" inside "roll".
    const nextChar = input[pos + keyword.length];
    if (nextChar && nextChar >= "a" && nextChar <= "z") continue;
    if (nextChar && nextChar >= "A" && nextChar <= "Z") continue;

    // Context-sensitive disambiguation for dh/dl/r/ro/cs/cf/sa/sd/min/max:
    // These are modifier keywords only valid after dice-related tokens.
    // Without this check, "d20" would match "d" then fail on "2" if "d" + something matched.
    if (type === TokenType.DH || type === TokenType.DL) {
      const lastToken = tokens[tokens.length - 1];
      if (!lastToken || !DICE_CONTEXT_TOKENS.has(lastToken.type)) {
        continue; // Not in dice context — fall through to single-char "d"
      }
    }

    // "r" alone could appear in contexts where it's not a reroll modifier.
    // Only match r/ro as keywords after dice context.
    if (type === TokenType.R || type === TokenType.RO) {
      const lastToken = tokens[tokens.length - 1];
      if (!lastToken || !DICE_CONTEXT_TOKENS.has(lastToken.type)) {
        continue;
      }
    }

    // cs/cf/sa/sd/min/max are only valid after dice context
    if (
      type === TokenType.CS ||
      type === TokenType.CF ||
      type === TokenType.SA ||
      type === TokenType.SD ||
      type === TokenType.MIN ||
      type === TokenType.MAX
    ) {
      const lastToken = tokens[tokens.length - 1];
      if (!lastToken || !DICE_CONTEXT_TOKENS.has(lastToken.type)) {
        continue;
      }
    }

    return { type, length: keyword.length };
  }

  return null;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (input[i] === " " || input[i] === "\t") {
      i++;
      continue;
    }

    const pos = i;
    // Guarded by the `while (i < input.length)` loop condition above, so
    // `input[i]` is always a defined character here.
    const ch = input[i]!;

    // Numbers
    if (ch >= "0" && ch <= "9") {
      let num = "";
      while (i < input.length && input[i]! >= "0" && input[i]! <= "9") {
        num += input[i]!;
        i++;
      }
      tokens.push({ type: TokenType.NUMBER, value: num, position: pos });
      continue;
    }

    // Try keyword match (longest-match, context-sensitive)
    const kwMatch = tryMatchKeyword(input, i, tokens);
    if (kwMatch) {
      tokens.push({
        type: kwMatch.type,
        value: input.slice(i, i + kwMatch.length),
        position: pos,
      });
      i += kwMatch.length;
      continue;
    }

    // Multi-char and single-char operators
    switch (ch.toLowerCase()) {
      case "d":
        tokens.push({ type: TokenType.D, value: ch, position: pos });
        i++;
        break;
      case "f":
        tokens.push({ type: TokenType.F, value: ch, position: pos });
        i++;
        break;
      case "%":
        tokens.push({ type: TokenType.PERCENT, value: ch, position: pos });
        i++;
        break;
      case "+":
        tokens.push({ type: TokenType.PLUS, value: ch, position: pos });
        i++;
        break;
      case "-":
        tokens.push({ type: TokenType.MINUS, value: ch, position: pos });
        i++;
        break;
      case "*":
        tokens.push({ type: TokenType.STAR, value: ch, position: pos });
        i++;
        break;
      case "/":
        tokens.push({ type: TokenType.SLASH, value: ch, position: pos });
        i++;
        break;
      case "(":
        tokens.push({ type: TokenType.LPAREN, value: ch, position: pos });
        i++;
        break;
      case ")":
        tokens.push({ type: TokenType.RPAREN, value: ch, position: pos });
        i++;
        break;
      case "!":
        // Peek ahead: !! = compound, !p = penetrate, ! = explode
        // `input[i + 1]` is guarded by `i + 1 < input.length` so it's defined.
        if (i + 1 < input.length && input[i + 1] === "!") {
          tokens.push({ type: TokenType.BANG_BANG, value: "!!", position: pos });
          i += 2;
        } else if (i + 1 < input.length && input[i + 1]!.toLowerCase() === "p") {
          tokens.push({ type: TokenType.BANG_P, value: "!p", position: pos });
          i += 2;
        } else {
          tokens.push({ type: TokenType.BANG, value: ch, position: pos });
          i++;
        }
        break;
      case ">":
        // Peek ahead: >= or >
        if (i + 1 < input.length && input[i + 1] === "=") {
          tokens.push({ type: TokenType.GTE, value: ">=", position: pos });
          i += 2;
        } else {
          tokens.push({ type: TokenType.GT, value: ch, position: pos });
          i++;
        }
        break;
      case "<":
        // Peek ahead: <= or <
        if (i + 1 < input.length && input[i + 1] === "=") {
          tokens.push({ type: TokenType.LTE, value: "<=", position: pos });
          i += 2;
        } else {
          tokens.push({ type: TokenType.LT, value: ch, position: pos });
          i++;
        }
        break;
      case "=":
        tokens.push({ type: TokenType.EQ, value: ch, position: pos });
        i++;
        break;
      default:
        throw new LexerError(`Unexpected character: '${ch}'`, pos);
    }
  }

  tokens.push({ type: TokenType.EOF, value: "", position: i });
  return tokens;
}
