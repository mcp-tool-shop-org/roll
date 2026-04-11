import { Token, TokenType } from "./tokens.js";

export class LexerError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "LexerError";
  }
}

const TWO_CHAR_KEYWORDS: Record<string, TokenType> = {
  kh: TokenType.KH,
  kl: TokenType.KL,
  dh: TokenType.DH,
  dl: TokenType.DL,
};

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
    const ch = input[i];

    // Numbers
    if (ch >= "0" && ch <= "9") {
      let num = "";
      while (i < input.length && input[i] >= "0" && input[i] <= "9") {
        num += input[i];
        i++;
      }
      tokens.push({ type: TokenType.NUMBER, value: num, position: pos });
      continue;
    }

    // Two-char keywords (kh, kl, dh, dl) — but not 'd' alone
    const twoChar = input.slice(i, i + 2).toLowerCase();
    if (TWO_CHAR_KEYWORDS[twoChar]) {
      // Make sure 'dh'/'dl' aren't confused with 'd' followed by a modifier
      // Only match dh/dl if the previous token is a dice-related context
      if (twoChar === "dh" || twoChar === "dl") {
        // dh/dl are drop-highest/drop-lowest modifiers, only valid after dice
        const lastToken = tokens[tokens.length - 1];
        if (
          lastToken &&
          (lastToken.type === TokenType.NUMBER ||
            lastToken.type === TokenType.PERCENT ||
            lastToken.type === TokenType.F ||
            lastToken.type === TokenType.KH ||
            lastToken.type === TokenType.KL ||
            lastToken.type === TokenType.DH ||
            lastToken.type === TokenType.DL ||
            lastToken.type === TokenType.BANG)
        ) {
          tokens.push({
            type: TWO_CHAR_KEYWORDS[twoChar],
            value: twoChar,
            position: pos,
          });
          i += 2;
          continue;
        }
      } else {
        tokens.push({
          type: TWO_CHAR_KEYWORDS[twoChar],
          value: twoChar,
          position: pos,
        });
        i += 2;
        continue;
      }
    }

    // Single characters
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
        tokens.push({ type: TokenType.BANG, value: ch, position: pos });
        i++;
        break;
      case ">":
        tokens.push({ type: TokenType.GT, value: ch, position: pos });
        i++;
        break;
      default:
        throw new LexerError(`Unexpected character: '${ch}'`, pos);
    }
  }

  tokens.push({ type: TokenType.EOF, value: "", position: i });
  return tokens;
}
