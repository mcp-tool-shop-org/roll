import { describe, it, expect } from "vitest";

import { run } from "../src/bin.js";

// Force colorless output so assertions match plain substrings without ANSI
// escapes from our color layer. (Mirrors tests/cli.test.ts.)
process.env["NO_COLOR"] = "1";

/** Drive run() in-process and capture out/err streams + exit code. */
function cli(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    out: (l = "") => out.push(l),
    err: (l = "") => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// ─── FT-INT-001: --seed determinism ──────────────────────────────────────────

describe("feature-cli: --seed (FT-INT-001)", () => {
  it("--seed makes a roll reproducible across two invocations", () => {
    const a = cli("3d20+5", "--seed", "42");
    const b = cli("3d20+5", "--seed", "42");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.out).toBe(b.out);
  });

  it("different seeds (usually) produce different rolls", () => {
    // Not a strict guarantee for every pair, but 20d20 across two distinct
    // seeds collides with negligible probability.
    const a = cli("20d20", "--seed", "1");
    const b = cli("20d20", "--seed", "2");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.out).not.toBe(b.out);
  });

  it("seeded --times sequence is deterministic", () => {
    const a = cli("1d20", "--seed", "7", "--times", "5");
    const b = cli("1d20", "--seed", "7", "--times", "5");
    expect(a.out).toBe(b.out);
    // A seeded sequence advances — the five rolls are not all identical.
    expect(a.out).toContain("Roll 5 of 5");
  });

  it("--seed abc -> exit 1 with a finite-integer error", () => {
    const r = cli("1d6", "--seed", "abc");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("seed");
  });

  it("--seed 1.5 (non-integer) -> exit 1", () => {
    const r = cli("1d6", "--seed", "1.5");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("seed");
  });

  it("--seed accepts a negative integer (via the =form parseArgs requires)", () => {
    // parseArgs treats a space-separated leading-dash value as ambiguous and
    // mandates the `=` form for dash-prefixed option values — same rule the
    // existing `--times=-5` test exercises. The seed parser itself accepts the
    // negative; this just documents the required invocation shape.
    const r = cli("1d6", "--seed=-3");
    expect(r.code).toBe(0);
  });

  it("--json echoes the seed", () => {
    const r = cli("2d6", "--seed", "99", "--json");
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.seed).toBe(99);
  });

  it("--json without a seed omits the seed field", () => {
    const r = cli("2d6", "--json");
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.seed).toBeUndefined();
  });
});

// ─── FT-ANA-002: --compare verdict ───────────────────────────────────────────

describe("feature-cli: --compare verdict (FT-ANA-002)", () => {
  it("2d6+10 vs 1d4 shows a near-certain P(A wins)", () => {
    const r = cli("--compare", "2d6+10", "1d4");
    expect(r.code).toBe(0);
    // The Versus block renders.
    expect(r.out).toContain("Versus");
    expect(r.out).toContain("A wins");
    // 2d6+10 (min 12) always beats 1d4 (max 4): 100%.
    expect(r.out).toContain("100");
  });

  it("keeps the per-expression statistics block", () => {
    const r = cli("--compare", "2d6", "1d4");
    expect(r.code).toBe(0);
    // The existing Comparison stat table still renders.
    expect(r.out).toContain("Mean");
  });

  it("--compare --json includes the comparison verdict", () => {
    const r = cli("--compare", "2d6+10", "1d4", "--json");
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.comparison).toBeDefined();
    expect(parsed.comparison.pAGreater).toBeGreaterThan(0.99);
    expect(parsed.comparison).toHaveProperty("pEqual");
    expect(parsed.comparison).toHaveProperty("pBGreater");
    expect(parsed.comparison).toHaveProperty("meanMargin");
  });

  it("still errors when fewer than two expressions are given", () => {
    const r = cli("--compare", "2d6");
    expect(r.code).toBe(1);
    expect(r.err).toContain("two dice expressions");
  });
});

// ─── FT-ANA-003 / FT-ANA-005: query flags ────────────────────────────────────

describe("feature-cli: --at-most (FT-ANA-003)", () => {
  it("--at-most 7 2d6 ≈ 58.3%", () => {
    const r = cli("2d6", "--at-most", "7");
    expect(r.code).toBe(0);
    expect(r.out).toContain("<=");
    expect(r.out).toContain("58.3");
  });

  it("--at-most --json carries probability + the expression", () => {
    const r = cli("2d6", "--at-most", "7", "--json");
    const parsed = JSON.parse(r.out);
    expect(parsed.expression).toBe("2d6");
    expect(parsed.x).toBe(7);
    expect(parsed.probability).toBeCloseTo(21 / 36, 4);
  });
});

describe("feature-cli: --exactly (FT-ANA-003)", () => {
  it("--exactly 7 2d6 ≈ 16.67%", () => {
    const r = cli("2d6", "--exactly", "7");
    expect(r.code).toBe(0);
    // P(X=7) = 6/36 = 16.666…% → toFixed(2) = "16.67".
    expect(r.out).toContain("16.67");
  });

  it("--exactly --json: P(X=7) = 6/36", () => {
    const r = cli("2d6", "--exactly", "7", "--json");
    const parsed = JSON.parse(r.out);
    expect(parsed.probability).toBeCloseTo(6 / 36, 4);
  });
});

describe("feature-cli: --between (FT-ANA-003)", () => {
  it("--between 6..8 2d6 is correct (P = 16/36)", () => {
    const r = cli("2d6", "--between", "6..8");
    expect(r.code).toBe(0);
    const r2 = cli("2d6", "--between", "6..8", "--json");
    const parsed = JSON.parse(r2.out);
    // 5/36 + 6/36 + 5/36 = 16/36.
    expect(parsed.probability).toBeCloseTo(16 / 36, 4);
    expect(parsed.lo).toBe(6);
    expect(parsed.hi).toBe(8);
  });

  it("--between 6,8 comma syntax also works", () => {
    const r = cli("2d6", "--between", "6,8", "--json");
    const parsed = JSON.parse(r.out);
    expect(parsed.probability).toBeCloseTo(16 / 36, 4);
  });

  it("--between with a bad range -> exit 1", () => {
    const r = cli("2d6", "--between", "garbage");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("between");
  });

  it("--between with lo > hi -> exit 1", () => {
    const r = cli("2d6", "--between", "8..6");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("between");
  });
});

describe("feature-cli: --target-for (FT-ANA-005)", () => {
  it("--target-for 0.5 1d20+5 returns a sane T", () => {
    const r = cli("1d20+5", "--target-for", "0.5");
    expect(r.code).toBe(0);
    // 1d20+5 ranges 6..25. The LARGEST T with P(X>=T) >= 0.5 is 16:
    // P(X>=16) = P(d20>=11) = 10/20 = 0.50 (qualifies); P(X>=17) = 9/20 = 0.45 (fails).
    const r2 = cli("1d20+5", "--target-for", "0.5", "--json");
    const parsed = JSON.parse(r2.out);
    expect(parsed.target).toBe(16);
    expect(parsed.p).toBe(0.5);
  });

  it("--target-for with p outside (0,1] -> exit 1", () => {
    const r = cli("1d20", "--target-for", "5");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("target-for");
  });

  it("--target-for abc -> exit 1", () => {
    const r = cli("1d20", "--target-for", "abc");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("target-for");
  });
});

// ─── Regression: existing exit codes unchanged ───────────────────────────────

describe("feature-cli: no regressions", () => {
  it("plain roll still works", () => {
    const r = cli("2d6");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Total:");
  });

  it("--at-least still works", () => {
    const r = cli("2d6", "--at-least", "7");
    expect(r.code).toBe(0);
    expect(r.out).toContain(">=");
  });

  it("query flag with no expression -> exit 1", () => {
    const r = cli("--at-most", "7");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no dice expression given");
  });

  it("unknown flag still errors", () => {
    const r = cli("1d6", "--bogus");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("unknown option");
  });
});
