import { describe, it, expect } from "vitest";

import { run } from "../src/bin.js";

// Force colorless output so any ESC byte that appears in output is necessarily
// an injection, not our own ANSI styling. (Mirrors tests/cli.test.ts.)
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

describe("V2-002: error echo is sanitized (terminal injection)", () => {
  it("an expression carrying an ESC byte never echoes a raw control byte into stderr", () => {
    // A crafted dice string with an embedded ESC + cursor/clear sequence. The
    // parser/lexer rejects it; the load-bearing point is that the resulting
    // error message — which echoes the offending input — must NOT smuggle the
    // raw ESC byte to the terminal.
    const r = cli(`2d6${ESC}[2J`);
    expect(r.code).toBe(1);
    // The teeth of the injection are the ESC bytes; with NO_COLOR on there is no
    // legitimate ESC source, so any ESC in stderr is the injection surviving.
    expect(r.err.includes(ESC)).toBe(false);
  });

  it("an unknown option carrying an ESC byte is sanitized before echo", () => {
    const r = cli("2d6", `--bog${ESC}[2Jus`);
    expect(r.code).toBe(1);
    expect(r.err.includes(ESC)).toBe(false);
    expect(r.err.toLowerCase()).toContain("unknown option");
  });
});

describe("V1-004: --times x dice multiplicative blow-up is bounded", () => {
  it("10000d6 --times 10000 -> clean error + exit 1 (no hang/flood)", () => {
    const r = cli("10000d6", "--times", "10000");
    expect(r.code).toBe(1);
    // A real, explanatory error — not a stack trace and not silence.
    expect(r.err).toContain("Error:");
    expect(r.err).not.toContain("node:internal");
    // Nothing should have been rolled.
    expect(r.out).toBe("");
  });

  it("2d6 --times 1000 still works (exit 0)", () => {
    const r = cli("2d6", "--times", "1000");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Roll 1 of 1000");
    expect(r.out).toContain("Roll 1000 of 1000");
  });

  it("4d6kh3 --times 100 still works (exit 0)", () => {
    const r = cli("4d6kh3", "--times", "100");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Roll 100 of 100");
  });
});

describe("V2-001: importing bin.ts has no side effects (symlink-safe entry guard)", () => {
  it("importing the module does not auto-run the CLI under the test runner", async () => {
    // If the entry guard fired on import, vitest would have rolled dice (or
    // exited) at module-load time. Re-importing is a no-op; the fact that the
    // module imported cleanly above (and `run` is callable on demand) is the
    // evidence. Assert the export exists and is the only entry point.
    const mod = await import("../src/bin.js");
    expect(typeof mod.run).toBe("function");
    // Calling run explicitly is the ONLY way the CLI executes in-process.
    const r = cli("--version");
    expect(r.code).toBe(0);
    expect(r.out).toContain("@mcptoolshop/roll v");
  });
});
