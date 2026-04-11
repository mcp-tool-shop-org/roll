---
title: Getting Started
description: Install @mcptoolshop/roll, roll your first dice, and understand the output format.
sidebar:
  order: 1
---

This page walks you through installing Roll, making your first dice roll, and reading the output. By the end you'll know how to use both the CLI and the library API at a basic level.

## Requirements

Roll requires **Node.js 22 or later**. It uses three Node.js 22+ builtins that are not available in earlier versions:

- `util.styleText` for terminal colors
- `util.parseArgs` for CLI argument parsing
- `crypto.randomInt` for cryptographically secure dice rolls

Check your Node version:

```bash
node --version
# Must be v22.0.0 or later
```

## Installation

### As a project dependency

```bash
npm install @mcptoolshop/roll
```

This gives you both the library API (importable in your code) and the `roll` CLI command (via `npx roll` or through npm scripts).

### Run without installing

```bash
npx @mcptoolshop/roll 2d6+3
```

This downloads and runs the latest version in a temporary context. Useful for quick one-off rolls or trying out the tool before committing to an install.

### Global install

```bash
npm install -g @mcptoolshop/roll
```

After a global install, the `roll` command is available everywhere in your terminal:

```bash
roll 2d6+3
```

## Your first roll

Roll a twenty-sided die with a +5 modifier:

```bash
roll d20+5
```

The output appears inside a Unicode box with the expression as the title:

```
┌─ roll d20+5 ────────────────────┐
│ 1d20: 14 = 14                    │
│                                  │
│ Total:  19                       │
└──────────────────────────────────┘
```

### Reading the output

Each line inside the box represents a dice group from your expression:

- **Expression label** (`1d20`) -- the parsed dice component
- **Dice faces** -- individual die results. For d6s, these show as Unicode dice glyphs. For other dice, they show as numbers.
- **Group total** -- the sum of kept dice in that group

The **Total** line at the bottom is the final computed result after all arithmetic.

### Color coding

Roll uses terminal colors to highlight important results:

- **Green bold** -- a maximum roll (crit). Rolling a 20 on a d20, or a 6 on a d6.
- **Red bold** -- a minimum roll (fumble). Rolling a 1.
- **Dim bracketed** -- a dropped die. When using keep/drop modifiers, dropped dice appear as `[3]` in dim text.
- **Magenta with !** -- an exploded die. Extra dice from the exploding mechanic show with an exclamation mark.

## Rolling with modifiers

Roll four d6 and keep the highest three (classic ability score generation):

```bash
roll 4d6kh3
```

```
┌─ roll 4d6kh3 ───────────────────┐
│ 4d6kh3: ⚃ [⚁] ⚄ ⚃ = 13        │
│                                  │
│ Total:  13                       │
└──────────────────────────────────┘
```

The `[⚁]` in dim text shows the dropped die (it rolled a 2, the lowest).

## Your first analysis

Add `--analyze` to see the full probability distribution:

```bash
roll 2d6 --analyze
```

This prints two sections. The first is a histogram showing every possible outcome and its probability, with bars scaled to the most likely result. The mode (most probable value) is highlighted with a `*>` prefix and yellow bars.

The second section is a statistics box:

```
┌─ Statistics ──────────────────────┐
│ Mean:    7.00                     │
│ Median:  7                        │
│ Mode:    7                        │
│ Std Dev: 2.42                     │
│ Range:   2-12                     │
│ Entropy: 3.27 bits                │
│                                   │
│ Percentiles:                      │
│   p10:4  p25:5  p50:7  p75:9     │
│   p90:10  p95:11                  │
└───────────────────────────────────┘
```

Each statistic tells you something useful:

| Statistic | What it means |
|-----------|---------------|
| **Mean** | The expected average over many rolls |
| **Median** | The value where 50% of rolls fall below |
| **Mode** | The single most likely outcome |
| **Std Dev** | How spread out the results are (higher = more variance) |
| **Range** | The minimum and maximum possible results |
| **Entropy** | Information content in bits (higher = more unpredictable) |
| **Percentiles** | The value at which N% of rolls fall at or below |

## Checking specific thresholds

Use `--at-least` to answer "what are the odds of rolling N or higher?":

```bash
roll d20+5 --at-least 15
```

This outputs a visual probability bar and a plain-language assessment:

```
┌─ At Least ────────────────────────┐
│ P(d20+5 >= 15)                    │
│                                   │
│   ███████████████████████░░░░░░░  │
│                          55.00%   │
│                                   │
│   Likely                          │
└───────────────────────────────────┘
```

The assessment categories are:

| Probability | Label |
|-------------|-------|
| 95%+ | Almost certain |
| 75%+ | Very likely |
| 50%+ | Likely |
| 25%+ | Possible |
| 5%+ | Unlikely |
| Below 5% | Very unlikely |

## Rolling multiple times

Use `--times` to repeat a roll:

```bash
roll 2d6+3 --times 5
```

Each roll is printed separately with a `--- Roll N of M ---` header.

## JSON output

Add `--json` for machine-readable output suitable for piping or parsing:

```bash
roll 2d6+3 --json
```

```json
{
  "expression": "2d6+3",
  "total": 10,
  "groups": [
    {
      "expression": "2d6",
      "total": 7,
      "dice": [
        { "value": 3, "kept": true },
        { "value": 4, "kept": true }
      ]
    }
  ]
}
```

The `--json` flag works with `--analyze` and `--at-least` as well, returning structured data instead of formatted terminal output.

## Using as a library

Import Roll into your own Node.js or TypeScript project:

```typescript
import { roll, analyze } from '@mcptoolshop/roll';

// Quick roll
const result = roll('2d6+3');
console.log(result.total); // e.g., 10

// Probability analysis
const analysis = analyze('2d6+3');
console.log(analysis.stats.mean);            // 10
console.log(analysis.probabilityAtLeast(12)); // 0.2778
```

For the full library API, see the [API Reference](/handbook/api-reference/).

## Next steps

- Learn every supported dice expression in the [Dice Notation](/handbook/dice-notation/) reference
- Understand how probabilities are computed in the [Probability Engine](/handbook/probability-engine/) guide
- Set up weighted loot drops with the [Loot Tables](/handbook/loot-tables/) guide
