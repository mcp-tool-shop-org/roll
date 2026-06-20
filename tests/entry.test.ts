import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../src/entry.js";

// Regression guard for the symlink-blind entry detection that silently
// disabled the published binaries under `npm i -g` on macOS/Linux.

describe("isMainModule", () => {
  it("returns false when there is no argv1", () => {
    expect(isMainModule(pathToFileURL(__filename).href, undefined)).toBe(false);
  });

  it("returns true when argv1 is the same real file", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "roll-entry-")));
    const real = join(dir, "bin.js");
    writeFileSync(real, "// entry");
    // Invariant: a module IS the entry when argv1 resolves to its own file.
    expect(isMainModule(pathToFileURL(real).href, real)).toBe(true);
  });

  it("returns true when argv1 is a SYMLINK to the real file (the npm -g case)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "roll-entry-")));
    const real = join(dir, "bin.js");
    const link = join(dir, "roll"); // extensionless symlink, like a global bin
    writeFileSync(real, "// entry");
    try {
      symlinkSync(real, link);
    } catch {
      // Windows without developer mode can't create symlinks — skip there.
      return;
    }
    // Invariant: the realpath comparison sees through the symlink. The naive
    // `import.meta.url === pathToFileURL(argv1)` check would return false here.
    expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
  });

  it("returns false when argv1 is an unrelated file", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "roll-entry-")));
    const real = join(dir, "bin.js");
    const other = join(dir, "other.js");
    writeFileSync(real, "// entry");
    writeFileSync(other, "// other");
    expect(isMainModule(pathToFileURL(real).href, other)).toBe(false);
  });
});
