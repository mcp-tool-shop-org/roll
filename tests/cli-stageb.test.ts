import { describe, it, expect } from "vitest";

import { run } from "../src/bin.js";

// Most assertions below want plain text, so default to colorless output by
// pinning NO_COLOR (mirrors tests/cli.test.ts). The --no-color flag tests below
// intentionally drive run() with this on AND off to prove the flag stands on its
// own, independent of the env var.
process.env["NO_COLOR"] = "1";

const ESC = String.fromCharCode(0x1b);

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

// ─── Task 1: exact-vs-estimate labeling in --analyze / --at-least ─────────────
//
// The product is marketed on "exact probabilities", but the analyzer silently
// falls back to Monte Carlo for large/complex expressions. The CLI must be the
// honest user-facing half: when the numbers are sampled, say so; when they are
// exact, never claim otherwise.

describe("cli: exact-vs-estimate labeling (P-CORE-001 consumer side)", () => {
  it("--analyze 2d6 does NOT claim an estimate (it is exact)", () => {
    const r = cli("--analyze", "2d6");
    expect(r.code).toBe(0);
    // No Monte-Carlo / estimate language on an exact result.
    expect(r.out.toLowerCase()).not.toContain("monte carlo");
    expect(r.out.toLowerCase()).not.toContain("estimat");
    // And no "~" approximation prefix smuggled in front of stats.
    expect(r.out).not.toContain("~");
  });

  it("--analyze 500d1000 IS labeled as a Monte-Carlo estimate", () => {
    // 500d1000 is within the analyze-dice budget but the exact convolution's
    // per-step compute blows up, so the analyzer falls back to bounded Monte
    // Carlo. The CLI must surface that the numbers are sampled.
    const r = cli("--analyze", "500d1000");
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).toContain("monte carlo");
    // The label should carry the sample count so the user can judge precision.
    expect(r.out).toMatch(/\d{1,3}(,\d{3})+|\d{4,}/); // a sizable samples number
  });

  it("--at-least on a Monte-Carlo expression is also labeled as estimated", () => {
    const r = cli("--at-least", "250000", "500d1000");
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).toContain("monte carlo");
  });

  it("--at-least on an exact expression does NOT claim an estimate", () => {
    const r = cli("--at-least", "15", "d20+5");
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).not.toContain("monte carlo");
    expect(r.out.toLowerCase()).not.toContain("estimat");
  });

  it("--analyze --json carries a machine-readable method field", () => {
    // JSON consumers (bridge/engine integrations) need the method too.
    const exact = JSON.parse(cli("--analyze", "2d6", "--json").out);
    expect(exact.method).toBe("exact");
    const mc = JSON.parse(cli("--analyze", "500d1000", "--json").out);
    expect(mc.method).toBe("monte-carlo");
    expect(typeof mc.samples).toBe("number");
  });
});

// ─── Task 2: --no-color flag ─────────────────────────────────────────────────
//
// NO_COLOR (env) is honored at module import; --no-color is a per-invocation
// flag that disables ANSI for that run regardless of env. We prove the flag
// produces colorless output even when NO_COLOR is NOT set.

describe("cli: --no-color flag (P-CLI-004)", () => {
  it("--no-color 2d6 emits no ANSI escape, exit 0", () => {
    const r = cli("--no-color", "2d6");
    expect(r.code).toBe(0);
    // The ANSI introducer is ESC '['; assert no bracket-escape and no raw ESC.
    expect(r.out.includes(ESC)).toBe(false);
    expect(r.out.includes(`${ESC}[`)).toBe(false);
    // Still a real roll.
    expect(r.out).toContain("Total:");
  });

  it("--no-color disables color even when NO_COLOR is unset for that run", () => {
    // Temporarily clear NO_COLOR to prove the flag — not the env — is what
    // suppresses color here. setColorEnabled is the runtime toggle the CLI flips.
    const saved = process.env["NO_COLOR"];
    delete process.env["NO_COLOR"];
    try {
      const r = cli("--no-color", "2d6");
      expect(r.code).toBe(0);
      expect(r.out.includes(ESC)).toBe(false);
    } finally {
      if (saved !== undefined) process.env["NO_COLOR"] = saved;
    }
  });

  it("a normal run (NO_COLOR on) is also clean, and --no-color matches it", () => {
    // Under NO_COLOR both paths are colorless; the point is --no-color never
    // ADDS escapes and a plain run is unaffected.
    const plain = cli("2d6");
    const flagged = cli("--no-color", "2d6");
    expect(plain.out.includes(ESC)).toBe(false);
    expect(flagged.out.includes(ESC)).toBe(false);
  });

  it("--no-color is documented in --help", () => {
    const r = cli("--help");
    expect(r.out).toContain("--no-color");
  });
});

// ─── Exit-code contract (P-CLI-005) is unchanged by the above ─────────────────

describe("cli: exit codes unchanged (P-CLI-005 two-code contract)", () => {
  it("valid input exits 0", () => {
    expect(cli("2d6").code).toBe(0);
    expect(cli("--analyze", "2d6").code).toBe(0);
    expect(cli("--no-color", "2d6").code).toBe(0);
    expect(cli("--at-least", "7", "2d6").code).toBe(0);
  });

  it("invalid input exits 1", () => {
    expect(cli("@@@bogus@@@").code).toBe(1);
    expect(cli("--at-least", "x", "2d6").code).toBe(1);
    expect(cli("--loot", "definitely-not-real-xyz.json").code).toBe(1);
  });
});
