import type { RollResult, DiceGroupResult, DieResult } from "../engine/roller.js";
import type { DistributionStats } from "../analyze/stats.js";
import { bold, dim, red, green, yellow, cyan, boldGreen, boldRed, boldYellow, magenta } from "./color.js";
import { drawBox } from "./box.js";

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function dieFace(value: number, sides: number): string {
  if (sides === 6 && value >= 1 && value <= 6) {
    // value is in [1, 6], so value - 1 indexes a defined DICE_FACES element.
    return DICE_FACES[value - 1]!;
  }
  return String(value);
}

function formatDie(die: DieResult, maxSide: number, isPool = false): string {
  const face = dieFace(die.value, maxSide);
  if (!die.kept) return dim(`[${face}]`);
  if (die.rerolledFrom !== undefined) {
    // Show rerolled die with original value
    const orig = dieFace(die.rerolledFrom, maxSide);
    if (die.exploded) return magenta(`${dim(orig + "→")}${face}!`);
    if (isPool && die.critical === "success") return boldGreen(`${dim(orig + "→")}${face}`);
    return cyan(`${dim(orig + "→")}${face}`);
  }
  if (die.exploded) return magenta(`${face}!`);
  // Pool mode: color by success/failure marking
  if (isPool) {
    if (die.critical === "success") return boldGreen(face);
    if (die.critical === "failure") return boldRed(face);
    return dim(face);
  }
  // Standard mode: color by max/min face
  if (die.value === maxSide && maxSide > 1) return boldGreen(face); // crit
  if (die.value === 1 && maxSide > 1) return boldRed(face); // fumble
  return face;
}

function formatGroup(group: DiceGroupResult): string {
  const maxSide = inferMaxSide(group.expression);
  const isPool = group.resultMode === "success_count";
  const dice = group.dice.map((d) => formatDie(d, maxSide, isPool)).join(" ");

  if (isPool) {
    const label = group.total === 1 ? "success" : "successes";
    return `${dim(group.expression)}: ${dice} ${dim("→")} ${boldYellow(String(group.total))} ${dim(label)}`;
  }

  return `${dim(group.expression)}: ${dice} ${dim("=")} ${bold(String(group.total))}`;
}

function inferMaxSide(expr: string): number {
  const match = expr.match(/d(\d+)/);
  // Capture group 1 is always present when the regex matches.
  if (match) return parseInt(match[1]!, 10);
  if (expr.includes("d%")) return 100;
  if (expr.includes("dF")) return 1;
  return 6;
}

/** Format a roll result for terminal display. */
export function formatRollResult(result: RollResult, expression: string): string {
  const lines: string[] = [];

  // Show each dice group
  for (const group of result.groups) {
    lines.push(formatGroup(group));
  }

  // Total
  const totalStr = boldYellow(` ${result.total} `);
  lines.push("");
  lines.push(`${bold("Total:")} ${totalStr}`);

  return drawBox(lines, `${cyan("roll")} ${expression}`);
}

/** Format stats summary for terminal display. */
export function formatStats(stats: DistributionStats): string {
  const lines: string[] = [];

  lines.push(`${bold("Mean:")}    ${stats.mean.toFixed(2)}`);
  lines.push(`${bold("Median:")}  ${stats.median}`);
  lines.push(`${bold("Mode:")}    ${stats.mode}`);
  lines.push(`${bold("Std Dev:")} ${stats.stddev.toFixed(2)}`);
  lines.push(`${bold("Range:")}   ${stats.min}${dim("–")}${stats.max}`);
  lines.push(`${bold("Entropy:")} ${stats.entropy.toFixed(2)} bits`);
  lines.push("");
  lines.push(bold("Percentiles:"));

  const pctKeys = [10, 25, 50, 75, 90, 95] as const;
  const pctLine = pctKeys
    .map((k) => `${dim(`p${k}:`)}${stats.percentiles[k] ?? "?"}`)
    .join("  ");
  lines.push(`  ${pctLine}`);

  return drawBox(lines, "Statistics");
}

/** Format probability for --at-least display. */
export function formatAtLeast(target: number, probability: number, expression: string): string {
  const pct = (probability * 100).toFixed(2);
  const lines: string[] = [];

  // Visual probability bar
  const barWidth = 40;
  const filled = Math.round(probability * barWidth);
  const bar = green("█".repeat(filled)) + dim("░".repeat(barWidth - filled));

  lines.push(`P(${bold(expression)} >= ${bold(String(target))})`);
  lines.push("");
  lines.push(`  ${bar} ${boldYellow(pct + "%")}`);
  lines.push("");

  if (probability >= 0.95) lines.push(green("  Almost certain"));
  else if (probability >= 0.75) lines.push(green("  Very likely"));
  else if (probability >= 0.5) lines.push(yellow("  Likely"));
  else if (probability >= 0.25) lines.push(yellow("  Possible"));
  else if (probability >= 0.05) lines.push(red("  Unlikely"));
  else lines.push(red("  Very unlikely"));

  return drawBox(lines, "At Least");
}

/** Format a comparison of two distributions side by side. */
export function formatComparison(
  expr1: string,
  stats1: DistributionStats,
  expr2: string,
  stats2: DistributionStats,
): string {
  const w = 12;
  const lines: string[] = [];

  const header = `${"".padEnd(10)}${bold(expr1.padEnd(w))}${bold(expr2.padEnd(w))}${bold("Diff")}`;
  lines.push(header);
  lines.push(dim("─".repeat(10 + w * 2 + 8)));

  function row(label: string, v1: number, v2: number, decimals = 2) {
    const s1 = v1.toFixed(decimals).padEnd(w);
    const s2 = v2.toFixed(decimals).padEnd(w);
    const diff = v1 - v2;
    const diffStr = diff > 0 ? green(`+${diff.toFixed(decimals)}`) : diff < 0 ? red(diff.toFixed(decimals)) : dim("0");
    lines.push(`${dim(label.padEnd(10))}${s1}${s2}${diffStr}`);
  }

  row("Mean", stats1.mean, stats2.mean);
  row("Median", stats1.median, stats2.median, 0);
  row("Mode", stats1.mode, stats2.mode, 0);
  row("Std Dev", stats1.stddev, stats2.stddev);
  row("Min", stats1.min, stats2.min, 0);
  row("Max", stats1.max, stats2.max, 0);
  row("Entropy", stats1.entropy, stats2.entropy);

  return drawBox(lines, "Comparison");
}

/** Format roll result as JSON. */
export function formatJson(result: RollResult, expression: string): string {
  return JSON.stringify({
    expression,
    total: result.total,
    groups: result.groups.map((g) => ({
      expression: g.expression,
      total: g.total,
      resultMode: g.resultMode,
      dice: g.dice.map((d) => ({
        value: d.value,
        kept: d.kept,
        ...(d.exploded ? { exploded: true } : {}),
        ...(d.rerolledFrom !== undefined ? { rerolledFrom: d.rerolledFrom } : {}),
        ...(d.critical ? { critical: d.critical } : {}),
      })),
    })),
  }, null, 2);
}
