import type { Distribution } from "../analyze/distribution.js";
import type { DistributionStats } from "../analyze/stats.js";
import { bold, dim, cyan, yellow, green, boldCyan } from "./color.js";

const FULL_BLOCK = "\u2588";
const BLOCKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

/** Render a horizontal bar chart of a probability distribution. */
export function renderHistogram(
  dist: Distribution,
  stats: DistributionStats,
  maxWidth = 60,
): string {
  const entries = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return "";

  const maxProb = Math.max(...entries.map(([, p]) => p));
  // Guard against an all-zero-probability distribution: dividing by 0 yields
  // NaN, and `"█".repeat(NaN)` throws (RangeError). Fall back to 1 so every
  // bar renders empty rather than crashing.
  const denom = maxProb || 1;
  const lines: string[] = [];

  // Header
  lines.push(boldCyan("  Distribution"));
  lines.push("");

  // Determine label width
  const maxLabel = Math.max(...entries.map(([v]) => String(v).length));
  const barWidth = Math.min(maxWidth, (process.stdout.columns || 80) - maxLabel - 15);

  let sawMode = false;
  let sawMedian = false;

  for (const [value, prob] of entries) {
    const label = String(value).padStart(maxLabel);
    const barLen = Math.round((prob / denom) * barWidth);
    const bar = FULL_BLOCK.repeat(barLen);
    const pctStr = (prob * 100).toFixed(2).padStart(6) + "%";

    // Highlight mode
    const isMode = value === stats.mode;
    const isMedian = value === stats.median;
    if (isMode) sawMode = true;
    if (isMedian) sawMedian = true;

    let prefix = "  ";
    if (isMode && isMedian) prefix = bold("M>");
    else if (isMode) prefix = bold("*>");
    else if (isMedian) prefix = "~>";

    const coloredBar = isMode ? yellow(bar) : cyan(bar);
    const coloredPct = isMode ? bold(pctStr) : dim(pctStr);

    lines.push(`${prefix}${dim(label)} ${coloredBar} ${coloredPct}`);
  }

  // Legend for the row markers, so M>/*>/~> aren't cryptic. Only show the keys
  // that actually appear in this chart.
  if (sawMode || sawMedian) {
    const keys: string[] = [];
    if (sawMode && sawMedian) keys.push(`${bold("M")} mode+median`);
    if (sawMode) keys.push(`${bold("*")} mode`);
    if (sawMedian) keys.push(`~ median`);
    lines.push("");
    lines.push(dim(`  ${keys.join("   ")}`));
  }

  return lines.join("\n");
}

/** Render a compact sparkline for inline display. */
export function renderSparkline(dist: Distribution): string {
  const entries = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return "";

  const maxProb = Math.max(...entries.map(([, p]) => p));
  // Same all-zero guard as renderHistogram: avoid NaN index into BLOCKS.
  const denom = maxProb || 1;
  return entries
    .map(([, p]) => BLOCKS[Math.round((p / denom) * 8)])
    .join("");
}
