import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/bin.js";

// Force colorless output so assertions can match plain substrings without
// worrying about ANSI escape codes from our own color layer. With NO_COLOR set,
// any ESC byte appearing in output is necessarily an injection, not our styling.
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

describe("cli: help & version", () => {
  it("--help prints usage and exits 0", () => {
    const r = cli("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("RPG dice engine");
    expect(r.out).toContain("Usage:");
  });

  it("-h short flag prints usage", () => {
    const r = cli("-h");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage:");
  });

  it("--help documents V2 notation (F-TD-002)", () => {
    const r = cli("--help");
    // A representative slice of the V2 notation rows.
    expect(r.out).toContain("cs>=5");
    expect(r.out).toContain("cf<=1");
    expect(r.out).toContain("!!");
    expect(r.out).toContain("!p");
    expect(r.out).toContain("min3");
    expect(r.out).toContain("max5");
    expect(r.out).toContain("sa");
  });

  it("--version prints version and exits 0", () => {
    const r = cli("--version");
    expect(r.code).toBe(0);
    expect(r.out).toContain("@mcptoolshop/roll v");
  });

  it("no args prints help and exits 0", () => {
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage:");
  });
});

describe("cli: unknown flag (F-DC-001, no raw stack trace)", () => {
  it("exits 1 with a friendly Unknown option message, no node:internal frames", () => {
    const r = cli("1d6", "--bogus");
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("unknown option");
    // Must NOT leak a Node stack trace.
    expect(r.err).not.toContain("node:internal");
    expect(r.err).not.toMatch(/\n\s+at /);
    // Helpful hint to recover.
    expect(r.err).toContain("--help");
  });
});

describe("cli: --times validation (F-DC-002 / F-DC-003)", () => {
  it("--times abc -> exit 1, positive-integer error", () => {
    const r = cli("1d6", "--times", "abc");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--times requires a positive integer");
  });

  it("--times 0 -> exit 1 (not silent 1)", () => {
    const r = cli("1d6", "--times", "0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--times requires a positive integer");
  });

  it("--times=-5 -> exit 1 (not a silent no-op exit 0)", () => {
    const r = cli("1d6", "--times=-5");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--times requires a positive integer");
  });

  it("--times over the cap -> exit 1 with cap message", () => {
    const r = cli("1d6", "--times", "100000000");
    expect(r.code).toBe(1);
    expect(r.err).toContain("capped");
  });

  it("valid --times rolls that many times, exit 0", () => {
    const r = cli("1d6", "--times", "3");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Roll 1 of 3");
    expect(r.out).toContain("Roll 3 of 3");
  });
});

describe("cli: mode flag without expression (F-DC-005)", () => {
  it("--at-least with no expression -> exit 1, not silent help", () => {
    const r = cli("--at-least", "5");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no dice expression given");
  });

  it("--analyze with no expression -> exit 1", () => {
    const r = cli("--analyze");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no dice expression given");
  });

  it("--json with no expression -> exit 1", () => {
    const r = cli("--json");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no dice expression given");
  });
});

describe("cli: --loot errors", () => {
  it("missing file -> exit 1, friendly File not found (no stack)", () => {
    const r = cli("--loot", "definitely-not-a-real-file-xyz.json");
    expect(r.code).toBe(1);
    expect(r.err).toContain("File not found");
    expect(r.err).not.toContain("node:internal");
  });
});

describe("cli: loot sanitization end-to-end (F-DC-004)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roll-loot-"));
  });

  it("strips ESC bytes from a malicious item name before display", () => {
    // Item name carries a raw ESC + a fake "clear screen" / cursor-home sequence.
    const evilName = `Gold${ESC}[2J${ESC}[1;1HPWNED`;
    const evil = { table: "Evil", items: [{ name: evilName, weight: 1 }] };
    const file = join(dir, "evil.json");
    writeFileSync(file, JSON.stringify(evil), "utf-8");

    const r = cli("--loot", file);
    rmSync(dir, { recursive: true, force: true });

    expect(r.code).toBe(0);
    // The injection's teeth are the ESC bytes: without a leading ESC the
    // "[2J"/"[1;1H" become inert printable text. So the load-bearing assertion
    // is that NO raw ESC byte survives into output (NO_COLOR is on, so there is
    // no legitimate ESC source).
    expect(r.out.includes(ESC)).toBe(false);
    // The visible (non-control) characters remain — content is preserved, only
    // the control bytes are neutralized.
    expect(r.out).toContain("PWNED");
  });
});

describe("cli: valid expressions still work (no regression)", () => {
  it("roll 2d6 produces a boxed result, exit 0", () => {
    const r = cli("2d6");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Total:");
  });

  it("roll 2d6 --json emits parseable JSON with stable shape", () => {
    const r = cli("2d6", "--json");
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed).toHaveProperty("expression", "2d6");
    expect(parsed).toHaveProperty("total");
    expect(Array.isArray(parsed.groups)).toBe(true);
  });

  it("invalid dice expression -> exit 1 with clean error, no stack", () => {
    const r = cli("@@@bogus@@@");
    expect(r.code).toBe(1);
    expect(r.err).toContain("Error:");
    expect(r.err).not.toContain("node:internal");
  });
});
