import { bold, dim } from "./color.js";

const TOP_LEFT = "┌";
const TOP_RIGHT = "┐";
const BOTTOM_LEFT = "└";
const BOTTOM_RIGHT = "┘";
const HORIZONTAL = "─";
const VERTICAL = "│";

/** Strip ANSI escape sequences to get visible character length. */
export function stripAnsi(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Draw a Unicode box around lines of text. */
export function drawBox(lines: string[], title?: string): string {
  const maxLen = Math.max(...lines.map(stripAnsi), title ? stripAnsi(title) + 2 : 0);
  const width = maxLen + 2; // 1 space padding each side

  const top = title
    ? `${TOP_LEFT}${HORIZONTAL} ${bold(title)} ${HORIZONTAL.repeat(Math.max(0, width - stripAnsi(title) - 3))}${TOP_RIGHT}`
    : `${TOP_LEFT}${HORIZONTAL.repeat(width)}${TOP_RIGHT}`;

  const bottom = `${BOTTOM_LEFT}${HORIZONTAL.repeat(width)}${BOTTOM_RIGHT}`;

  const body = lines.map((line) => {
    const pad = maxLen - stripAnsi(line);
    return `${dim(VERTICAL)} ${line}${" ".repeat(pad)} ${dim(VERTICAL)}`;
  });

  return [top, ...body, bottom].join("\n");
}
