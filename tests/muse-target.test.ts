import { describe, it, expect } from "vitest";
import { analyze } from "../src/index.js";

describe("muse target", () => {
  it("largest target T such that P(1d20+5 >= T) >= 0.65", () => {
    const a = analyze("1d20+5");
    const t = a.targetForProbability(0.65);
    expect(t).toBe(13);
  });
});
