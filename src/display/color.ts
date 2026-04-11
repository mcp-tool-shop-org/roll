import { styleText } from "node:util";

const noColor = !!process.env["NO_COLOR"];

function style(styles: string | string[], text: string): string {
  if (noColor) return text;
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
