#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { parse } from "./parser/parser.js";
import { evaluate } from "./engine/roller.js";
import { computeDistribution } from "./analyze/distribution.js";
import { computeStats, probabilityAtLeast } from "./analyze/stats.js";
import { rollLootTable, validateLootTables, type LootTable } from "./loot/table.js";
import { formatRollResult, formatStats, formatAtLeast, formatComparison, formatJson } from "./display/format.js";
import { renderHistogram } from "./display/histogram.js";
import { bold, cyan, dim, red, yellow, green, boldYellow } from "./display/color.js";
import { drawBox } from "./display/box.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `
${bold("@mcptoolshop/roll")} ${dim(`v${version}`)} — RPG dice engine

${bold("Usage:")}
  ${cyan("roll")} <expression>              Roll dice
  ${cyan("roll")} <expression> ${dim("--analyze")}   Show probability distribution
  ${cyan("roll")} <expression> ${dim("--at-least")} N  P(result >= N)
  ${cyan("roll")} ${dim("--compare")} "expr1" "expr2"  Compare two distributions
  ${cyan("roll")} ${dim("--loot")} table.json         Roll on a loot table
  ${cyan("roll")} <expression> ${dim("--times")} N    Roll N times

${bold("Dice Notation:")}
  2d6         Roll two six-sided dice
  d20+5       Roll d20, add 5
  4d6kh3      Roll 4d6, keep highest 3
  4d6dl1      Roll 4d6, drop lowest 1
  1d6!        Exploding d6 (reroll on max)
  1d6!>4      Explode on 4+
  d%          Percentile die (1-100)
  4dF         Four Fate/Fudge dice (-1, 0, +1)
  (2d6+3)*2   Grouped arithmetic

${bold("Flags:")}
  --analyze    Show full probability distribution + statistics
  --at-least N Show probability of rolling >= N
  --compare    Compare two dice expressions side by side
  --loot FILE  Roll on a JSON loot table
  --times N    Roll multiple times (default: 1)
  --json       Output as JSON
  --help       Show this help
  --version    Show version
`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      analyze: { type: "boolean", default: false },
      "at-least": { type: "string" },
      compare: { type: "boolean", default: false },
      loot: { type: "string" },
      times: { type: "string", default: "1" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.version) {
    console.log(`@mcptoolshop/roll v${version}`);
    return;
  }

  // Loot table mode
  if (values.loot) {
    return handleLoot(values.loot, values.json!);
  }

  // Compare mode
  if (values.compare) {
    if (positionals.length < 2) {
      console.error(red("Error: --compare requires two dice expressions"));
      console.error(dim('  Example: roll --compare "4d6dl1" "3d6"'));
      process.exit(1);
    }
    return handleCompare(positionals[0], positionals[1], values.json!);
  }

  // Need at least one expression
  if (positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const expression = positionals.join("");
  const times = parseInt(values.times!, 10) || 1;

  // At-least mode
  if (values["at-least"]) {
    const target = parseInt(values["at-least"], 10);
    if (isNaN(target)) {
      console.error(red("Error: --at-least requires a number"));
      process.exit(1);
    }
    return handleAtLeast(expression, target, values.json!);
  }

  // Analyze mode
  if (values.analyze) {
    return handleAnalyze(expression, values.json!);
  }

  // Roll mode
  handleRoll(expression, times, values.json!);
}

function handleRoll(expression: string, times: number, json: boolean) {
  try {
    const ast = parse(expression);

    for (let i = 0; i < times; i++) {
      const result = evaluate(ast);
      result.expression = expression;

      if (json) {
        console.log(formatJson(result, expression));
      } else {
        if (times > 1) {
          console.log(dim(`--- Roll ${i + 1} of ${times} ---`));
        }
        console.log(formatRollResult(result, expression));
        if (i < times - 1) console.log();
      }
    }

    if (times > 1 && !json) {
      // Show summary for multiple rolls
      const totals: number[] = [];
      const summaryAst = parse(expression);
      for (let i = 0; i < times; i++) {
        totals.push(evaluate(summaryAst).total);
      }
      // Already printed above — just totals were from different RNG calls
    }
  } catch (e) {
    console.error(red(`Error: ${(e as Error).message}`));
    process.exit(1);
  }
}

function handleAnalyze(expression: string, json: boolean) {
  try {
    const ast = parse(expression);
    const dist = computeDistribution(ast);
    const stats = computeStats(dist);

    if (json) {
      const entries = [...dist.entries()].sort((a, b) => a[0] - b[0]);
      console.log(JSON.stringify({ expression, stats, distribution: entries }, null, 2));
      return;
    }

    console.log();
    console.log(renderHistogram(dist, stats));
    console.log();
    console.log(formatStats(stats));
    console.log();
  } catch (e) {
    console.error(red(`Error: ${(e as Error).message}`));
    process.exit(1);
  }
}

function handleAtLeast(expression: string, target: number, json: boolean) {
  try {
    const ast = parse(expression);
    const dist = computeDistribution(ast);
    const prob = probabilityAtLeast(dist, target);

    if (json) {
      console.log(JSON.stringify({ expression, target, probability: prob }, null, 2));
      return;
    }

    console.log();
    console.log(formatAtLeast(target, prob, expression));
    console.log();
  } catch (e) {
    console.error(red(`Error: ${(e as Error).message}`));
    process.exit(1);
  }
}

function handleCompare(expr1: string, expr2: string, json: boolean) {
  try {
    const ast1 = parse(expr1);
    const ast2 = parse(expr2);
    const dist1 = computeDistribution(ast1);
    const dist2 = computeDistribution(ast2);
    const stats1 = computeStats(dist1);
    const stats2 = computeStats(dist2);

    if (json) {
      console.log(JSON.stringify({ expressions: [expr1, expr2], stats: [stats1, stats2] }, null, 2));
      return;
    }

    console.log();
    console.log(formatComparison(expr1, stats1, expr2, stats2));
    console.log();

    // Show both histograms
    console.log(bold(cyan(`  ${expr1}`)));
    console.log(renderHistogram(dist1, stats1, 40));
    console.log();
    console.log(bold(cyan(`  ${expr2}`)));
    console.log(renderHistogram(dist2, stats2, 40));
    console.log();
  } catch (e) {
    console.error(red(`Error: ${(e as Error).message}`));
    process.exit(1);
  }
}

function handleLoot(filePath: string, json: boolean) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    // Accept either { tables: [...] } or [...] or a single table object
    let tables: LootTable[];
    if (Array.isArray(data)) {
      tables = data;
    } else if (data.tables) {
      tables = data.tables;
    } else if (data.table && data.items) {
      tables = [data];
    } else {
      console.error(red("Error: Invalid loot table format"));
      process.exit(1);
      return;
    }

    const errors = validateLootTables(tables);
    if (errors.length > 0) {
      console.error(red("Loot table validation errors:"));
      for (const err of errors) console.error(red(`  - ${err}`));
      process.exit(1);
    }

    const drops = rollLootTable(tables);

    if (json) {
      console.log(JSON.stringify(drops, null, 2));
      return;
    }

    const lines: string[] = [];
    for (const drop of drops) {
      let line = boldYellow(drop.item);
      if (drop.quantity > 1) line += dim(` x${drop.quantity}`);
      if (drop.rollValue !== undefined) {
        line += ` ${dim("(")}${green(String(drop.rollValue))}${dim(")")}`;
        if (drop.rollExpression) line += dim(` [${drop.rollExpression}]`);
      }
      lines.push(line);
    }
    lines.push("");
    lines.push(dim(`from: ${drops[0]?.fromTable ?? "unknown"}`));

    console.log();
    console.log(drawBox(lines, "Loot Drop"));
    console.log();
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      console.error(red(`Error: File not found: ${filePath}`));
    } else {
      console.error(red(`Error: ${(e as Error).message}`));
    }
    process.exit(1);
  }
}

main();
