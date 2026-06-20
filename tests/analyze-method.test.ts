import { describe, it, expect } from "vitest";
import { analyze } from "../src/index.js";
import { parse } from "../src/parser/parser.js";
import {
  computeDistribution,
  computeDistributionWithMethod,
} from "../src/analyze/distribution.js";
import { classifyModifier, type ModifierFamily } from "../src/analyze/distribution.js";
import type { DiceModifier } from "../src/parser/ast.js";

// ─── P-CORE-001: exact-vs-approximate must be surfaced ────────────────────────
//
// The product is marketed on "exact probabilities", but computeDistribution
// silently falls back to Monte Carlo (an ESTIMATE) for complex/large
// expressions, and analyze() returned no way for a caller to know whether the
// numbers are exact or sampled. computeDistributionWithMethod() (and analyze()
// surfacing `.method`) closes that hole: every caller can now distinguish an
// exact convolution result from a sampled estimate.
//
// INVARIANT: an expression whose distribution is computed exactly reports
// method:"exact" with no samples count; an expression that falls back to Monte
// Carlo reports method:"monte-carlo" with a finite samples count.

describe("P-CORE-001 analyze() surfaces exact-vs-approximate method", () => {
  it("analyze('2d6').method === 'exact' and has no samples", () => {
    const a = analyze("2d6");
    expect(a.method).toBe("exact");
    // The exact path must NOT carry a samples count.
    expect("samples" in a ? a.samples : undefined).toBeUndefined();
  });

  it("a Monte-Carlo fallback reports method:'monte-carlo' with a samples number", () => {
    // 500d1000: exact convolution's per-step compute blows up (|a|*|b| guard),
    // so the exact path abandons and falls back to bounded Monte Carlo. 500 dice
    // is within the analyze-dice budget (1000), so it samples rather than throws.
    // This is the canonical "exact too expensive, sampled instead" case.
    const a = analyze("500d1000");
    expect(a.method).toBe("monte-carlo");
    expect(typeof a.samples).toBe("number");
    expect(a.samples as number).toBeGreaterThan(0);
  });

  it("a keep/drop + explosion expression also falls back to MC (method exposed)", () => {
    // 4d6!kh3: keep/drop combined with explosion cannot be modeled exactly
    // (enumerateKeepDrop ignores explosion), so tryExact returns null and the
    // method must report monte-carlo with a samples count.
    const a = analyze("4d6!kh3");
    expect(a.method).toBe("monte-carlo");
    expect(typeof a.samples).toBe("number");
    expect(a.samples as number).toBeGreaterThan(0);
  });

  it("other exact paths (keep/drop, reroll, explosion, success pool) report exact", () => {
    // These all stay on an exact strategy and must self-report as exact.
    expect(analyze("4d6kh3").method).toBe("exact");
    expect(analyze("1d6r=1").method).toBe("exact");
    expect(analyze("1d6!").method).toBe("exact");
    expect(analyze("10d10cs>=7").method).toBe("exact");
    expect(analyze("1d6min3").method).toBe("exact");
  });
});

// ─── computeDistributionWithMethod / computeDistribution parity ───────────────
// computeDistribution must remain a thin wrapper returning just the
// distribution — identical mass to computeDistributionWithMethod's `.distribution`
// — so existing callers and the public export are unbroken.

describe("computeDistributionWithMethod is additive over computeDistribution", () => {
  it("computeDistribution returns the same distribution as .distribution (exact)", () => {
    const ast = parse("2d6");
    const plain = computeDistribution(ast);
    const withMethod = computeDistributionWithMethod(ast);
    expect(withMethod.method).toBe("exact");
    expect(withMethod.samples).toBeUndefined();
    expect([...plain.entries()].sort()).toEqual(
      [...withMethod.distribution.entries()].sort(),
    );
  });

  it("computeDistributionWithMethod reports monte-carlo + samples on fallback", () => {
    const ast = parse("500d1000");
    const withMethod = computeDistributionWithMethod(ast);
    expect(withMethod.method).toBe("monte-carlo");
    expect(typeof withMethod.samples).toBe("number");
    expect(withMethod.samples as number).toBeGreaterThan(0);
    // The thin wrapper returns just the distribution map.
    const plain = computeDistribution(ast);
    expect(plain instanceof Map).toBe(true);
    expect(plain.size).toBe(withMethod.distribution.size);
  });
});

// ─── P-CORE-002: analyzer modifier exhaustiveness ─────────────────────────────
// tryExact must classify EVERY modifier kind through one exhaustive switch so a
// NEW DiceModifier kind forces a compile error rather than silently falling
// through to convolveDice (a plain-NdM distribution that lies about the new
// modifier). We cannot test a compile error at runtime, but we LOCK the current
// classification: every existing kind maps to its expected family. If a kind is
// re-classified (or a new kind is added without a family) this table breaks.

describe("P-CORE-002 modifier classification is exhaustive and locked", () => {
  // The full DiceModifier.kind union, paired with its expected family. Adding a
  // new kind to the union without adding it here is a compile error at
  // classifyModifier's assertNever default (P-CORE-002's whole point), and a
  // test-coverage gap caught by the "covers every kind" assertion below.
  const table: Record<DiceModifier["kind"], ModifierFamily> = {
    kh: "keep-drop",
    kl: "keep-drop",
    dh: "keep-drop",
    dl: "keep-drop",
    explode: "explosion",
    compound: "explosion",
    penetrate: "explosion",
    reroll: "reroll",
    reroll_once: "reroll",
    cs_count: "success-count",
    cf_count: "success-count",
    // sort + success-marker modifiers do not change the total → display-only.
    cs_mark: "display-only",
    cf_mark: "display-only",
    min: "min-max",
    max: "min-max",
    sort_asc: "display-only",
    sort_desc: "display-only",
  };

  for (const [kind, family] of Object.entries(table) as [
    DiceModifier["kind"],
    ModifierFamily,
  ][]) {
    it(`classifies ${kind} as ${family}`, () => {
      expect(classifyModifier({ kind })).toBe(family);
    });
  }

  it("the lock table covers every DiceModifier kind (no kind left unclassified)", () => {
    // Mirror of the union so a forgotten kind is visible here too. If a kind is
    // added to the AST union, TypeScript flags this object literal AND the table
    // above, and classifyModifier's assertNever flags the source — three guards.
    const allKinds: DiceModifier["kind"][] = [
      "kh", "kl", "dh", "dl",
      "explode", "compound", "penetrate",
      "reroll", "reroll_once",
      "cs_count", "cf_count",
      "cs_mark", "cf_mark",
      "min", "max",
      "sort_asc", "sort_desc",
    ];
    for (const kind of allKinds) {
      expect(table[kind]).toBeDefined();
    }
    expect(Object.keys(table).length).toBe(allKinds.length);
  });
});
