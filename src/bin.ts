#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { isMainModule } from "./entry.js";
import { parse } from "./parser/parser.js";
import type { ASTNode } from "./parser/ast.js";
import { evaluate } from "./engine/roller.js";
import { computeDistribution, computeDistributionWithMethod } from "./analyze/distribution.js";
import { computeStats, probabilityAtLeast } from "./analyze/stats.js";
import { rollLootTable, validateLootTables, type LootTable } from "./loot/table.js";
import { formatRollResult, formatStats, formatAtLeast, formatComparison, formatJson, formatMethodNote } from "./display/format.js";
import { renderHistogram } from "./display/histogram.js";
import { bold, cyan, dim, red, green, boldYellow, setColorEnabled } from "./display/color.js";
import { drawBox, sanitize } from "./display/box.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** Upper bound on `--times` so a single command can't flood the terminal. */
const MAX_TIMES = 10_000;

/**
 * Upper bound on the TOTAL dice allocated by a single `--times` roll, i.e.
 * `times × dice-per-roll`. `--times` and per-expression dice are each capped
 * individually, but the AST is parsed once and evaluated `times` times, so
 * `10000d6 --times 10000` would allocate ~10^8 dice and flood the terminal even
 * though each cap is individually satisfied. We bound the product instead.
 */
const MAX_TOTAL_DICE = 1_000_000;

/**
 * Sink for normal/error output. Defaults to the real console but is overridable
 * by `run()` so the CLI can be driven in-process by tests (capturing output and
 * asserting exit codes) without spawning a child process.
 */
interface IO {
  out: (line?: string) => void;
  err: (line?: string) => void;
}

const consoleIO: IO = {
  out: (line = "") => console.log(line),
  err: (line = "") => console.error(line),
};

/**
 * Internal signal used to unwind out of a handler with a specific exit code,
 * instead of calling `process.exit()` mid-flight. `run()` catches it and
 * returns the code so the process boundary stays in one place (and tests don't
 * kill the test runner).
 */
class CliExit extends Error {
  constructor(public code: number) {
    super(`CliExit(${code})`);
    this.name = "CliExit";
  }
}

const USAGE = `
${bold("@mcptoolshop/roll")} ${dim(`v${version}`)} — RPG dice engine

${bold("Usage:")}
  ${cyan("roll")} <expression>              Roll dice
  ${cyan("roll")} <expression> ${dim("--analyze")}   Show probability distribution
  ${cyan("roll")} <expression> ${dim("--at-least")} N  P(result >= N)
  ${cyan("roll")} ${dim("--compare")} "expr1" "expr2"  Compare two distributions
  ${cyan("roll")} ${dim("--loot")} table.json         Roll on a loot table
  ${cyan("roll")} <expression> ${dim("--times")} N    Roll N times

${bold("Core Notation:")}
  2d6         Roll two six-sided dice
  d20+5       Roll d20, add 5
  4d6kh3      Roll 4d6, keep highest 3
  4d6dl1      Roll 4d6, drop lowest 1
  1d6!        Exploding d6 (reroll on max)
  1d6!>4      Explode on 4+
  d%          Percentile die (1-100)
  4dF         Four Fate/Fudge dice (-1, 0, +1)
  (2d6+3)*2   Grouped arithmetic

${bold("Extended Notation (V2):")}
  8d6cs>=5    Count successes (dice >= 5)
  8d6cf<=1    Subtract failures from success count
  1d6!!       Compounding (sum explosions into one die)
  1d6!p       Penetrating (explosions subtract 1)
  2d6r<2      Reroll values < 2 (unlimited)
  2d6ro=1     Reroll 1s once
  2d6min3     Floor: no die below 3
  2d6max5     Ceiling: no die above 5
  4d6sa       Sort ascending  (4d6sd = descending)

${bold("Flags:")}
  --analyze    Show full probability distribution + statistics
  --at-least N Show probability of rolling >= N
  --compare    Compare two dice expressions side by side
  --loot FILE  Roll on a JSON loot table
  --times N    Roll multiple times (default: 1, max ${MAX_TIMES})
  --json       Output as JSON
  --no-color   Disable ANSI color for this run (NO_COLOR env also honored)
  --help       Show this help
  --version    Show version

${bold("Exit codes:")}
  0  Success
  1  Any error (bad expression, validation failure, missing loot file, cap exceeded)
`;

/**
 * Parse `--times` into a validated positive integer. Throws CliExit(1) with a
 * friendly message on anything that isn't a positive integer (e.g. `abc`, `0`,
 * `-5`, `1.5`) and caps the value at MAX_TIMES so the terminal can't be flooded.
 */
function parseTimes(raw: string, io: IO): number {
  // Reject anything that isn't a run of digits. parseInt would silently accept
  // "5abc" → 5 and turn "abc" → NaN, so validate the shape strictly first.
  if (!/^\d+$/.test(raw.trim())) {
    io.err(red("Error: --times requires a positive integer"));
    throw new CliExit(1);
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    io.err(red("Error: --times requires a positive integer"));
    throw new CliExit(1);
  }
  if (n > MAX_TIMES) {
    io.err(red(`Error: --times capped at ${MAX_TIMES} (got ${n})`));
    throw new CliExit(1);
  }
  return n;
}

/**
 * Run the CLI in-process. Returns the would-be process exit code (0 = success,
 * 1 = error) instead of calling `process.exit()`, so it is safe to import and
 * call from tests. The real entry point (below) maps the return into a process
 * exit.
 */
export function run(argv: string[], io: IO = consoleIO): number {
  try {
    dispatch(argv, io);
    return 0;
  } catch (e) {
    if (e instanceof CliExit) return e.code;

    // Friendly handling for parseArgs failures (unknown/dangling options),
    // which otherwise surface as raw Node stack traces with internal frames.
    const code = (e as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      // The option name is lifted straight from argv (attacker-controlled), so
      // sanitize before it reaches the terminal — a pasted ESC byte in a flag
      // must not emit a raw control sequence (ANSI-injection defense).
      io.err(red(`Error: ${sanitize(friendlyUnknownOption(e as Error))}`));
      io.err(dim("  Run 'roll --help' to see available options."));
      return 1;
    }
    if (
      code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ||
      code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
    ) {
      io.err(red(`Error: ${sanitize((e as Error).message)}`));
      io.err(dim("  Run 'roll --help' to see usage."));
      return 1;
    }

    // Anything else (parser/engine ParseError, file errors, etc.): one clean
    // line plus a hint — never a stack trace. The message can echo the raw
    // offending input (e.g. a LexerError on a crafted dice string), so sanitize
    // before applying our own color codes.
    io.err(red(`Error: ${sanitize((e as Error).message)}`));
    io.err(dim("  Run 'roll --help' for usage."));
    return 1;
  }
}

/** Extract a clean "Unknown option '--x'" message from a parseArgs error. */
function friendlyUnknownOption(e: Error): string {
  const m = e.message.match(/'([^']+)'/);
  if (m) return `Unknown option ${m[1]}`;
  return e.message;
}

function dispatch(argv: string[], io: IO): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      analyze: { type: "boolean", default: false },
      "at-least": { type: "string" },
      compare: { type: "boolean", default: false },
      loot: { type: "string" },
      times: { type: "string", default: "1" },
      json: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  // Per-invocation color suppression. NO_COLOR (env) still wins inside
  // setColorEnabled, so this only ever turns color OFF, never forces it on.
  if (values["no-color"]) {
    setColorEnabled(false);
  }

  if (values.help) {
    io.out(USAGE);
    return;
  }

  if (values.version) {
    io.out(`@mcptoolshop/roll v${version}`);
    return;
  }

  // Loot table mode
  if (values.loot) {
    return handleLoot(values.loot, values.json!, io);
  }

  // Compare mode
  if (values.compare) {
    if (positionals.length < 2) {
      io.err(red("Error: --compare requires two dice expressions"));
      io.err(dim('  Example: roll --compare "4d6dl1" "3d6"'));
      throw new CliExit(1);
    }
    // length >= 2 here, so both positionals are defined.
    return handleCompare(positionals[0]!, positionals[1]!, values.json!, io);
  }

  const expression = positionals.join("");

  // A mode flag with no expression used to silently fall through to help and
  // exit 0, discarding the user's intent. Treat it as the error it is.
  if (positionals.length === 0) {
    if (values["at-least"] !== undefined) {
      io.err(red("Error: no dice expression given"));
      io.err(dim("  Example: roll d20+5 --at-least 15"));
      throw new CliExit(1);
    }
    if (values.analyze) {
      io.err(red("Error: no dice expression given"));
      io.err(dim("  Example: roll 2d6 --analyze"));
      throw new CliExit(1);
    }
    if (values.json) {
      io.err(red("Error: no dice expression given"));
      io.err(dim("  Example: roll 2d6+3 --json"));
      throw new CliExit(1);
    }
    // Genuine no-args invocation: show help.
    io.out(USAGE);
    return;
  }

  const times = parseTimes(values.times!, io);

  // At-least mode
  if (values["at-least"]) {
    const target = parseInt(values["at-least"], 10);
    if (isNaN(target)) {
      io.err(red("Error: --at-least requires a number"));
      throw new CliExit(1);
    }
    return handleAtLeast(expression, target, values.json!, io);
  }

  // Analyze mode
  if (values.analyze) {
    return handleAnalyze(expression, values.json!, io);
  }

  // Roll mode
  handleRoll(expression, times, values.json!, io);
}

/**
 * Sum the dice counts across every `dice` node in an AST — a cheap upper bound
 * on how many dice one evaluation allocates (modifiers like explode can add a
 * few more, but the base count dominates and is what we gate on). Used to bound
 * `times × dice-per-roll` before any rolling happens.
 */
function estimateDiceCount(node: ASTNode): number {
  switch (node.type) {
    case "dice":
      return node.count;
    case "binary":
      return estimateDiceCount(node.left) + estimateDiceCount(node.right);
    case "unary_minus":
      return estimateDiceCount(node.operand);
    default:
      return 0;
  }
}

function handleRoll(expression: string, times: number, json: boolean, io: IO): void {
  const ast = parse(expression);

  // Each individual cap (MAX_TIMES, MAX_DICE_COUNT) can be satisfied while their
  // product is catastrophic. Bound `times × dice-per-roll` so a single command
  // can't allocate ~10^8 dice and flood the terminal (V1-004).
  const dicePerRoll = estimateDiceCount(ast);
  if (dicePerRoll * times > MAX_TOTAL_DICE) {
    io.err(
      red(
        `Error: total dice ${dicePerRoll} × ${times} times exceeds the limit of ${MAX_TOTAL_DICE.toLocaleString()}`,
      ),
    );
    io.err(dim("  Lower --times or use a smaller dice expression."));
    throw new CliExit(1);
  }

  for (let i = 0; i < times; i++) {
    const result = evaluate(ast);
    result.expression = expression;

    if (json) {
      io.out(formatJson(result, expression));
    } else {
      if (times > 1) {
        io.out(dim(`--- Roll ${i + 1} of ${times} ---`));
      }
      io.out(formatRollResult(result, expression));
      if (i < times - 1) io.out();
    }
  }
}

function handleAnalyze(expression: string, json: boolean, io: IO): void {
  const ast = parse(expression);
  // Use the method-aware primitive so we can tell the user whether these numbers
  // are exact or a Monte-Carlo estimate (P-CORE-001 consumer side).
  const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
  const stats = computeStats(dist);

  if (json) {
    const entries = [...dist.entries()].sort((a, b) => a[0] - b[0]);
    io.out(
      JSON.stringify(
        { expression, method, ...(samples !== undefined ? { samples } : {}), stats, distribution: entries },
        null,
        2,
      ),
    );
    return;
  }

  io.out();
  io.out(renderHistogram(dist, stats));
  io.out();
  io.out(formatStats(stats));
  // Honest labeling: only call out the estimate when sampled; a quiet "exact"
  // note otherwise. This is the user-facing half of the exactness win.
  io.out(formatMethodNote(method, samples));
  io.out();
}

function handleAtLeast(expression: string, target: number, json: boolean, io: IO): void {
  const ast = parse(expression);
  const { distribution: dist, method, samples } = computeDistributionWithMethod(ast);
  const prob = probabilityAtLeast(dist, target);

  if (json) {
    io.out(
      JSON.stringify(
        { expression, target, probability: prob, method, ...(samples !== undefined ? { samples } : {}) },
        null,
        2,
      ),
    );
    return;
  }

  io.out();
  io.out(formatAtLeast(target, prob, expression));
  io.out(formatMethodNote(method, samples));
  io.out();
}

function handleCompare(expr1: string, expr2: string, json: boolean, io: IO): void {
  const ast1 = parse(expr1);
  const ast2 = parse(expr2);
  const dist1 = computeDistribution(ast1);
  const dist2 = computeDistribution(ast2);
  const stats1 = computeStats(dist1);
  const stats2 = computeStats(dist2);

  if (json) {
    io.out(JSON.stringify({ expressions: [expr1, expr2], stats: [stats1, stats2] }, null, 2));
    return;
  }

  io.out();
  io.out(formatComparison(expr1, stats1, expr2, stats2));
  io.out();

  // Show both histograms
  io.out(bold(cyan(`  ${expr1}`)));
  io.out(renderHistogram(dist1, stats1, 40));
  io.out();
  io.out(bold(cyan(`  ${expr2}`)));
  io.out(renderHistogram(dist2, stats2, 40));
  io.out();
}

function handleLoot(filePath: string, json: boolean, io: IO): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      io.err(red(`Error: File not found: ${sanitize(filePath)}`));
    } else {
      io.err(red(`Error: ${sanitize((e as Error).message)}`));
    }
    throw new CliExit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    io.err(red(`Error: Invalid JSON in loot file: ${sanitize((e as Error).message)}`));
    throw new CliExit(1);
  }

  // Accept either { tables: [...] } or [...] or a single table object
  let tables: LootTable[];
  const d = data as { tables?: LootTable[]; table?: unknown; items?: unknown };
  if (Array.isArray(data)) {
    tables = data;
  } else if (d.tables) {
    tables = d.tables;
  } else if (d.table && d.items) {
    tables = [data as LootTable];
  } else {
    io.err(red("Error: Invalid loot table format"));
    throw new CliExit(1);
  }

  const errors = validateLootTables(tables);
  if (errors.length > 0) {
    io.err(red("Loot table validation errors:"));
    // Validation messages echo table/item names from the file — sanitize.
    for (const err of errors) io.err(red(`  - ${sanitize(err)}`));
    throw new CliExit(1);
  }

  const drops = rollLootTable(tables);

  if (json) {
    io.out(JSON.stringify(drops, null, 2));
    return;
  }

  const lines: string[] = [];
  for (const drop of drops) {
    // drop.item / fromTable / rollExpression all originate from the loot JSON;
    // sanitize before applying our color codes so no ESC bytes reach the
    // terminal (ANSI-injection defense).
    let line = boldYellow(sanitize(drop.item));
    if (drop.quantity > 1) line += dim(` x${drop.quantity}`);
    if (drop.rollValue !== undefined) {
      line += ` ${dim("(")}${green(String(drop.rollValue))}${dim(")")}`;
      if (drop.rollExpression) line += dim(` [${sanitize(drop.rollExpression)}]`);
    }
    lines.push(line);
  }
  lines.push("");
  lines.push(dim(`from: ${sanitize(drops[0]?.fromTable ?? "unknown")}`));

  io.out();
  io.out(drawBox(lines, "Loot Drop"));
  io.out();
}

// Only auto-execute when invoked as the CLI entry point. `isMainModule` is
// realpath-based, so it stays correct when `npm i -g` / `npm link` install the
// bin as a symlink (the old string/path compare silently disabled the published
// `roll` binary). Importing this module (e.g. from tests) must NOT run the CLI.
if (isMainModule(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
