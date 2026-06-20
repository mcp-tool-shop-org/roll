import { describe, it, expect } from "vitest";

import { drawBox, sanitize, stripAnsi } from "../src/display/box.js";
import { renderHistogram, renderSparkline } from "../src/display/histogram.js";
import { formatJson } from "../src/display/format.js";
import type { Distribution } from "../src/analyze/distribution.js";
import type { DistributionStats } from "../src/analyze/stats.js";
import type { RollResult } from "../src/engine/roller.js";

// color.ts reads NO_COLOR at module import. Setting it here is best-effort, but
// every assertion below tolerates color by checking structural properties
// rather than exact-equality of styled strings.
process.env["NO_COLOR"] = "1";

const ESC = String.fromCharCode(0x1b);

function makeStats(over: Partial<DistributionStats> = {}): DistributionStats {
  return {
    min: 0, max: 0, mean: 0, median: 0, mode: 0,
    stddev: 0, percentiles: {}, entropy: 0,
    ...over,
  };
}

describe("sanitize (F-DC-004)", () => {
  it("removes ESC and other C0 control chars", () => {
    const dirty = `A${ESC}[2JB${String.fromCharCode(0x07)}C${String.fromCharCode(0x7f)}D`;
    const clean = sanitize(dirty);
    expect(clean).toBe("A[2JBCD");
    expect(clean.includes(ESC)).toBe(false);
  });

  it("preserves tab and newline (legitimate whitespace) and printable text", () => {
    const s = "name\twith\nnewlines and text";
    expect(sanitize(s)).toBe(s);
  });

  it("strips carriage return (cursor-to-line-start is an overwrite vector)", () => {
    // CR (0x0d) is in the stripped C0 range per spec — it can move the cursor
    // to the start of the line and overwrite earlier output.
    expect(sanitize("real\rFAKE")).toBe("realFAKE");
  });

  it("coerces non-strings without throwing", () => {
    // Defensive: sanitize is applied to file-sourced fields that *should* be
    // strings but may not be.
    expect(sanitize(123 as unknown as string)).toBe("123");
  });
});

describe("drawBox sanitization defense (F-DC-004)", () => {
  it("does not emit injected ESC when content is sanitized before boxing", () => {
    const injected = sanitize(`Loot${ESC}[2J${ESC}[1;1HInjected`);
    const box = drawBox([injected], "Title");
    expect(box.includes(ESC)).toBe(false);
    expect(box).toContain("Injected");
  });

  it("stripAnsi still measures visible width ignoring color codes", () => {
    // stripAnsi removes only SGR color sequences for width math.
    const colored = `${ESC}[1mBOLD${ESC}[0m`;
    expect(stripAnsi(colored)).toBe(4);
  });
});

describe("histogram NaN guard (F-DC-006)", () => {
  it("renderHistogram does not throw on an all-zero-probability distribution", () => {
    const dist: Distribution = new Map([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const stats = makeStats({ min: 1, max: 3, median: 2, mode: 2 });
    let out = "";
    expect(() => {
      out = renderHistogram(dist, stats);
    }).not.toThrow();
    // Bars collapse to empty rather than NaN-repeat throwing.
    expect(out).toContain("Distribution");
  });

  it("renderSparkline does not throw / produce undefined on all-zero probs", () => {
    const dist: Distribution = new Map([
      [1, 0],
      [2, 0],
    ]);
    let spark = "";
    expect(() => {
      spark = renderSparkline(dist);
    }).not.toThrow();
    expect(spark).not.toContain("undefined");
    expect(spark.length).toBe(2);
  });

  it("renderHistogram returns empty string for an empty distribution", () => {
    expect(renderHistogram(new Map(), makeStats())).toBe("");
  });
});

describe("histogram marker legend (Stage D polish)", () => {
  it("documents the M/*/~ markers so they are not cryptic", () => {
    const dist: Distribution = new Map([
      [1, 0.2],
      [2, 0.6], // mode + median
      [3, 0.2],
    ]);
    const stats = makeStats({ min: 1, max: 3, median: 2, mode: 2 });
    // Legend words ("mode"/"median") are plain text, not styled, so a raw
    // substring check works whether or not color is active.
    const out = renderHistogram(dist, stats);
    expect(out).toContain("mode");
    expect(out).toContain("median");
  });

  it("omits the legend when there is no mode/median in range", () => {
    const dist: Distribution = new Map([
      [1, 0.5],
      [2, 0.5],
    ]);
    // mode/median fall outside the displayed values → no markers, no legend.
    const stats = makeStats({ min: 1, max: 2, median: 99, mode: 99 });
    const out = renderHistogram(dist, stats);
    expect(out).not.toContain("median");
  });
});

describe("formatJson stable shape", () => {
  it("emits expression/total/groups with per-die value+kept", () => {
    const result: RollResult = {
      expression: "2d6",
      total: 7,
      groups: [
        {
          expression: "2d6",
          total: 7,
          resultMode: "sum",
          dice: [
            { value: 3, kept: true, exploded: false },
            { value: 4, kept: true, exploded: false },
          ],
        },
      ],
    };
    const json = JSON.parse(formatJson(result, "2d6"));
    expect(json).toMatchObject({
      expression: "2d6",
      total: 7,
      groups: [
        {
          expression: "2d6",
          total: 7,
          resultMode: "sum",
          dice: [
            { value: 3, kept: true },
            { value: 4, kept: true },
          ],
        },
      ],
    });
    // Optional flags omitted when false/absent.
    expect(json.groups[0].dice[0]).not.toHaveProperty("exploded");
  });
});

describe("NO_COLOR / colorless output", () => {
  it("drawBox emits no ANSI escape codes when NO_COLOR is set", () => {
    // color.ts samples NO_COLOR at import; this test documents the contract and
    // verifies no raw ESC leaks regardless. With NO_COLOR the box should be
    // entirely free of escape sequences.
    if (process.env["NO_COLOR"]) {
      const box = drawBox(["plain line"], "Plain");
      expect(box.includes(ESC)).toBe(false);
    }
  });
});
