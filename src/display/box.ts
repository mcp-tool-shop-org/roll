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

/**
 * Strip C0 control characters (incl. ESC 0x1b and DEL 0x7f) from
 * externally-sourced strings before they are rendered in the terminal.
 *
 * This blocks ANSI/terminal-control injection: a malicious loot/table JSON
 * could put raw ESC bytes in an item `name`, hijacking the victim's terminal
 * when they run `roll --loot evil.json`. Apply ONLY to content that originates
 * outside this program (file/user input) — never to the color codes our own
 * display functions add, which are emitted after sanitization.
 *
 * Note: `\t`, `\n`, and `\r` (0x09, 0x0a, 0x0d) are intentionally preserved so
 * legitimate whitespace survives; everything else in C0 plus 0x7f is removed.
 */
export function sanitize(s: string): string {
  return String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
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
