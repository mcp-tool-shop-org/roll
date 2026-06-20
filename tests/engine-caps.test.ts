import { describe, it, expect } from "vitest";
import {
  parse,
  ParseError,
  MAX_DICE_COUNT,
  MAX_DIE_SIDES,
  MAX_EXPRESSION_LENGTH,
} from "../src/parser/parser.js";
import { evaluate } from "../src/engine/roller.js";
import { seededRng } from "../src/engine/random.js";

function roll(expr: string, seed = 42) {
  const ast = parse(expr);
  const rng = seededRng(seed);
  return evaluate(ast, rng);
}

// ─── H1: Input-size caps (DoS prevention) ────────────────────────────────────
// Invariant: a single crafted expression can never force unbounded work.
// The parser MUST reject oversized dice counts, die sides, and expression
// lengths BEFORE any allocation/iteration, throwing the existing ParseError so
// every downstream consumer's existing catch block produces a clean error.
describe("H1 — input-size caps", () => {
  // Invariant: dice count above MAX_DICE_COUNT is rejected at parse time.
  it("rejects dice count above MAX_DICE_COUNT (no OOM/hang)", () => {
    expect(() => parse(`${MAX_DICE_COUNT + 1}d6`)).toThrow(ParseError);
    expect(() => parse("999999999d6")).toThrow(/exceeds maximum/i);
  });

  // Invariant: dice count exactly at the cap is still accepted (boundary).
  it("accepts dice count exactly at MAX_DICE_COUNT", () => {
    expect(() => parse(`${MAX_DICE_COUNT}d6`)).not.toThrow();
  });

  // Invariant: die sides above MAX_DIE_SIDES is rejected at parse time.
  it("rejects die sides above MAX_DIE_SIDES (no huge allocation)", () => {
    expect(() => parse(`1d${MAX_DIE_SIDES + 1}`)).toThrow(ParseError);
    expect(() => parse("1d999999999999999")).toThrow(/exceeds maximum/i);
  });

  // Invariant: die sides exactly at the cap is still accepted (boundary).
  it("accepts die sides exactly at MAX_DIE_SIDES", () => {
    expect(() => parse(`1d${MAX_DIE_SIDES}`)).not.toThrow();
  });

  // Invariant: total expression length above MAX_EXPRESSION_LENGTH is rejected
  // BEFORE tokenizing (megabyte-string DoS).
  it("rejects expressions longer than MAX_EXPRESSION_LENGTH before tokenizing", () => {
    const huge = "1d6" + "+1d6".repeat(MAX_EXPRESSION_LENGTH); // well over the cap
    expect(huge.length).toBeGreaterThan(MAX_EXPRESSION_LENGTH);
    expect(() => parse(huge)).toThrow(ParseError);
    expect(() => parse(huge)).toThrow(/exceeds maximum length/i);
  });

  // Invariant: a normal-length expression at/under the cap still parses.
  it("accepts an expression at the length boundary", () => {
    const atCap = "6".repeat(MAX_EXPRESSION_LENGTH);
    expect(atCap.length).toBe(MAX_EXPRESSION_LENGTH);
    // This is a valid number literal of exactly MAX_EXPRESSION_LENGTH chars.
    expect(() => parse(atCap)).not.toThrow();
  });

  // Invariant: the caps are exported as numbers consumers/tests can reference.
  it("exports the cap constants", () => {
    expect(typeof MAX_DICE_COUNT).toBe("number");
    expect(typeof MAX_DIE_SIDES).toBe("number");
    expect(typeof MAX_EXPRESSION_LENGTH).toBe("number");
    expect(MAX_DICE_COUNT).toBe(10_000);
    expect(MAX_DIE_SIDES).toBe(1_000_000);
    expect(MAX_EXPRESSION_LENGTH).toBe(1_000);
  });
});

// ─── F-PE-005: cf-only success mode ──────────────────────────────────────────
// Invariant: a pool with cf_count but no cs_count must evaluate in
// success_count mode so the failure count is reflected in the total (not
// silently ignored in sum mode).
describe("F-PE-005 — cf-only triggers success_count mode", () => {
  // Invariant: cf-only enters success_count mode and yields a non-positive
  // total equal to -(failures).
  it("10d6cf<=2 evaluates in success_count mode", () => {
    const result = roll("10d6cf<=2", 42);
    const group = result.groups[0];
    expect(group.resultMode).toBe("success_count");
    const failures = group.dice.filter((d) => d.kept && d.value <= 2).length;
    expect(group.total).toBe(-failures);
  });

  // Invariant: combined cs+cf still works (regression guard for F-PE-005).
  it("cs+cf combined still in success_count mode (no regression)", () => {
    const result = roll("12d6cs>=5cf<=1", 42);
    const group = result.groups[0];
    expect(group.resultMode).toBe("success_count");
    const successes = group.dice.filter((d) => d.kept && d.value >= 5).length;
    const failures = group.dice.filter((d) => d.kept && d.value <= 1).length;
    expect(group.total).toBe(successes - failures);
  });
});

// ─── F-PE-004: division by zero throws ───────────────────────────────────────
// Invariant: division by zero is a malformed expression and must surface a
// clear structured error rather than silently returning 0.
describe("F-PE-004 — division by zero throws", () => {
  // Invariant: 1d6/0 throws "Division by zero" rather than returning 0.
  it("1d6/0 throws a clear Division by zero error", () => {
    expect(() => roll("1d6/0")).toThrow(/division by zero/i);
  });

  it("5/0 throws (not silent 0)", () => {
    expect(() => roll("5/0")).toThrow(/division by zero/i);
  });

  // Invariant: normal floor division is unaffected.
  it("normal floor division still works", () => {
    expect(roll("7/2").total).toBe(3);
  });
});

// ─── F-TD-010: buildExpression round-trip fidelity ───────────────────────────
// Invariant: buildExpression(parse(x)) must re-parse to an AST with equivalent
// semantics. Previously cf_count serialized to bare "f" (re-tokenized as Fate
// dice) — a lossy, semantically-broken round-trip.
import { buildExpressionForTest } from "../src/engine/roller.js";

describe("F-TD-010 — buildExpression round-trips", () => {
  const cases = [
    "2d6",
    "4d6kh3",
    "4d6dl1",
    "2d20!",
    "2d20!!>=18",
    "1d6!p",
    "4d6r=1",
    "4d6ro<2",
    "8d6cs>=5",
    "10d6cf<=2", // the previously-broken cf_count case
    "8d6cs>=5cf<=1", // combined
    "4d6min2",
    "4d6max5",
    "6d6sa",
    "6d6sd",
    "1d%",
    "4dF",
  ];

  for (const expr of cases) {
    // Invariant: re-serializing a parsed dice node yields a string that
    // re-parses to a structurally-equivalent dice node.
    it(`round-trips ${expr}`, () => {
      const ast = parse(expr);
      expect(ast.type).toBe("dice");
      if (ast.type !== "dice") return;
      const serialized = buildExpressionForTest(ast);
      const reparsed = parse(serialized);
      expect(reparsed.type).toBe("dice");
      if (reparsed.type !== "dice") return;
      // Structural equivalence: same count, sides, and modifier kinds/compares.
      expect(reparsed.count).toBe(ast.count);
      expect(reparsed.sides).toEqual(ast.sides);
      expect(reparsed.modifiers).toEqual(ast.modifiers);
      expect(reparsed.resultMode).toBe(ast.resultMode);
    });
  }

  // Invariant: cf_count specifically does NOT serialize to bare "f" (which
  // would re-tokenize as Fate dice and silently corrupt the expression).
  it("cf_count does not serialize to ambiguous Fate 'f'", () => {
    const ast = parse("10d6cf<=2");
    if (ast.type !== "dice") throw new Error("expected dice node");
    const serialized = buildExpressionForTest(ast);
    expect(serialized).toContain("cf");
    // Re-parsing must NOT produce Fate dice.
    const reparsed = parse(serialized);
    if (reparsed.type !== "dice") throw new Error("expected dice node");
    expect(reparsed.sides).not.toBe("F");
  });
});
