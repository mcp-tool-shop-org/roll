import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the given module IS the process entry point — robust to symlinks.
 *
 * `import.meta.url === pathToFileURL(process.argv[1]).href` looks correct but
 * SILENTLY breaks the published binaries: `npm i -g` (and `npm link`) install
 * the `bin` as a symlink on macOS/Linux, so Node keeps `process.argv[1]` as the
 * symlink path while `import.meta.url` is the realpath'd target — they never
 * match and the CLI does nothing. Comparing the realpath of both sides fixes it
 * (and still works for Windows `.cmd` shims, which pass the real path to node).
 *
 * @param importMetaUrl  the caller's `import.meta.url`
 * @param argv1          override for `process.argv[1]` (testing seam)
 */
export function isMainModule(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
