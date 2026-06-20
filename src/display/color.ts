import { styleText } from "node:util";

// Color is enabled unless suppressed. Two independent off-switches:
//   1. NO_COLOR env var (sampled once at import — the de-facto standard contract)
//   2. setColorEnabled(false) at runtime (wired to the CLI's --no-color flag)
// We track the env baseline separately so re-enabling color can't accidentally
// override a NO_COLOR environment that should stay colorless.
const noColorEnv = !!process.env["NO_COLOR"];
let colorEnabled = !noColorEnv;

/**
 * Runtime toggle for ANSI styling. The CLI calls `setColorEnabled(false)` when
 * `--no-color` is passed so a single invocation can suppress color without
 * touching the environment. NO_COLOR (env) always wins: requesting color back on
 * is ignored when NO_COLOR is set, so the env contract is never broken.
 */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled && !noColorEnv;
}

function style(styles: string | string[], text: string): string {
  if (!colorEnabled) return text;
  return styleText(styles as Parameters<typeof styleText>[0], text);
}

export const bold = (s: string) => style("bold", s);
export const dim = (s: string) => style("dim", s);
export const red = (s: string) => style("red", s);
export const green = (s: string) => style("green", s);
export const yellow = (s: string) => style("yellow", s);
export const cyan = (s: string) => style("cyan", s);
export const magenta = (s: string) => style("magenta", s);
export const boldGreen = (s: string) => style(["bold", "green"], s);
export const boldRed = (s: string) => style(["bold", "red"], s);
export const boldYellow = (s: string) => style(["bold", "yellow"], s);
export const boldCyan = (s: string) => style(["bold", "cyan"], s);
