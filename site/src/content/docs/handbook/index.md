---
title: Roll Handbook
description: The complete guide to @mcptoolshop/roll — an RPG dice engine with probability analysis, loot tables, and beautiful terminal output.
sidebar:
  order: 0
---

Roll is an RPG dice engine for Node.js. It parses standard tabletop notation, rolls with cryptographically secure randomness, computes exact probability distributions, and generates loot from weighted tables. It works as both a CLI tool and a library you can import into your own projects.

## Why Roll exists

There are plenty of dice-rolling packages on npm, but most only handle the basics: parse `2d6`, return a number. Roll fills the gap for developers and game designers who need the full toolkit in one place:

- **A real expression parser** that handles nested arithmetic, keep/drop, exploding dice, Fate dice, and percentile rolls
- **Exact probability analysis** so you can answer questions like "what are the actual odds of rolling 15+ on 4d6 drop lowest?" without Monte Carlo guesswork
- **Loot table support** with weighted selection, nested tables, and dice expressions for quantity and value
- **Beautiful terminal output** with Unicode box drawing, colored histograms, and dice face glyphs
- **Zero dependencies** built entirely on Node.js 22+ builtins

## Key features

**Dice rolling** -- Every notation a tabletop player expects: `2d6`, `4d6kh3`, `1d6!`, `d%`, `4dF`, and full arithmetic with parentheses. All rolls use `crypto.randomInt` for fair outcomes.

**Probability engine** -- Computes exact distributions via polynomial convolution for basic rolls, full enumeration for keep/drop mechanics, and truncated recursion for exploding dice. Falls back to Monte Carlo (100k samples) only when exact computation would exceed 10 million states -- and labels which path produced every result, so a sampled estimate is never mistaken for an exact answer.

**Statistics** -- Mean, median, mode, standard deviation, min/max range, Shannon entropy, and percentiles (p10 through p95) for any dice expression.

**Probability queries** -- A full query family for the questions a designer actually asks: P(≥N), P(≤N), P(=N), P(L≤x≤H), and a break-even target solver ("what DC succeeds 65% of the time?").

**Which build wins?** -- Compare two expressions as a probability contest, not just a pair of means: P(A wins), P(tie), P(B wins), and the mean margin. The flagship balance workflow.

**Loot tables** -- Define weighted item tables in JSON with dice expressions for value and quantity, plus nested table references for tiered drops.

**Table analysis** -- Read every entry's real selection probability without rolling -- including excluded entries and *why* they were excluded ("Dragon: 0% (minLevel 12)"). Wired to the MCP server and JSON bridge for AI- and engine-driven balance work.

**Library API** -- Every internal function is exported with full TypeScript types: parse to AST, evaluate with pluggable RNG, compute distributions, analyze stats, and roll loot tables.

## What's in this handbook

| Page | What you'll learn |
|------|-------------------|
| [Getting Started](/handbook/getting-started/) | Install, run your first roll, read the output |
| [Dice Notation](/handbook/dice-notation/) | Every supported expression with examples |
| [Probability Engine](/handbook/probability-engine/) | How distributions are computed, CLI analysis modes |
| [Loot Tables](/handbook/loot-tables/) | JSON schema, weighted selection, nested tables |
| [API Reference](/handbook/api-reference/) | Every exported function with TypeScript signatures |

## Quick taste

```bash
# Roll ability scores (4d6, drop lowest)
npx @mcptoolshop/roll 4d6dl1

# See the exact probability distribution
npx @mcptoolshop/roll 4d6dl1 --analyze

# What are the odds of rolling 15 or higher?
npx @mcptoolshop/roll 4d6dl1 --at-least 15

# What DC can a +5 character beat 65% of the time?
npx @mcptoolshop/roll 1d20+5 --target-for 0.65

# Which damage build wins head-to-head?
npx @mcptoolshop/roll --compare "2d6+5" "1d12+6"

# Roll on a loot table
npx @mcptoolshop/roll --loot treasure.json

# Reproduce an exact roll with a seed
npx @mcptoolshop/roll 4d6kh3 --seed 42
```

## Security and trust

Roll processes dice expressions and nothing else. It makes no network requests, writes no files, and collects no data. The only filesystem access is the `--loot` flag, which reads a single user-specified JSON file. There is no telemetry, analytics, or tracking. All dice rolls use `crypto.randomInt` for cryptographically secure randomness.
