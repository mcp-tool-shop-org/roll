---
title: Dice Notation
description: Complete reference for every dice expression supported by @mcptoolshop/roll, with examples and output explanations.
sidebar:
  order: 2
---

Roll supports the standard tabletop dice notation used across D&D, Pathfinder, Fate, and other RPG systems. Expressions can be combined with arithmetic and grouped with parentheses for complex calculations.

## Basic rolls -- NdM

The foundation of all dice notation. Roll N dice, each with M sides, and sum them.

```bash
roll 2d6     # Roll two six-sided dice
roll d20     # Roll one twenty-sided die (1d20)
roll 3d8     # Roll three eight-sided dice
roll 1d100   # Roll a hundred-sided die
roll 10d10   # Roll ten ten-sided dice
```

When you omit the count before `d`, it defaults to 1. So `d20` is the same as `1d20`.

The sides value can be any positive integer. Common tabletop dice are d4, d6, d8, d10, d12, d20, and d100, but Roll handles any size: `1d3`, `2d7`, `1d1000` all work.

### Output format

```bash
roll 3d8
```

```
┌─ roll 3d8 ──────────────────┐
│ 3d8: 5 2 7 = 14             │
│                              │
│ Total:  14                   │
└──────────────────────────────┘
```

Each individual die result is shown, followed by the group sum.

## Arithmetic

Combine dice rolls and constants with the four basic operators:

```bash
roll 2d6+3       # Add 3 to the result of 2d6
roll d20+5       # Attack roll with +5 modifier
roll 2d6-2       # Subtract 2 from 2d6
roll 2d6*2       # Double the result of 2d6
roll 2d10/2      # Halve the result (integer division, rounds down)
```

### Chaining multiple dice groups

You can add multiple independent dice pools together:

```bash
roll 2d6+1d4+3   # Roll 2d6 and 1d4, add 3
roll d8+d6+5     # Longsword (d8) + sneak attack (d6) + modifier
```

Each dice group is rolled independently and shown on its own line in the output:

```bash
roll 2d6+1d4+3
```

```
┌─ roll 2d6+1d4+3 ────────────┐
│ 2d6: ⚃ ⚅ = 10               │
│ 1d4: 3 = 3                  │
│                              │
│ Total:  16                   │
└──────────────────────────────┘
```

### Parentheses for grouping

Use parentheses to control the order of operations:

```bash
roll "(2d6+3)*2"    # Roll 2d6+3, then double the total
roll "(d8+d6)*2+5"  # Double the dice, then add 5
```

Quotes are required when your shell would interpret parentheses as special characters.

### Division behavior

Division uses integer floor division (rounds down toward negative infinity), consistent with how most tabletop games handle fractional results:

```bash
roll 3d6/2     # If the 3d6 total is 11, the result is 5
```

Division by zero returns 0 instead of throwing an error.

## Keep highest -- kh

Roll extra dice and keep only the N highest results. This is the core mechanic for D&D 5e ability score generation and advantage rolls.

```bash
roll 4d6kh3    # Roll 4d6, keep the highest 3
roll 2d20kh1   # Roll with advantage (keep highest of 2d20)
roll 2d20kh    # Same — kh without a number defaults to 1
```

When kh is used without a number, it defaults to keeping 1 die.

### Output

Dropped dice appear in dim text with brackets:

```bash
roll 4d6kh3
```

```
┌─ roll 4d6kh3 ───────────────┐
│ 4d6kh3: ⚃ [⚁] ⚄ ⚂ = 13    │
│                              │
│ Total:  13                   │
└──────────────────────────────┘
```

The `[⚁]` (value 2) was the lowest die and was dropped. The total is 4 + 5 + 4 = 13.

## Keep lowest -- kl

The inverse of kh. Roll extra dice and keep only the N lowest results. Useful for disadvantage or penalties.

```bash
roll 2d20kl1   # Roll with disadvantage (keep lowest of 2d20)
roll 2d20kl    # Same — defaults to 1
roll 4d6kl3    # Roll 4d6, keep the 3 lowest
```

## Drop highest -- dh

Roll dice and discard the N highest results, keeping everything else.

```bash
roll 4d6dh1    # Roll 4d6, drop the single highest die
roll 3d8dh1    # Roll 3d8, drop the highest
```

This is the opposite of keep lowest: `4d6dh1` keeps the lowest 3, while `4d6kl3` also keeps the lowest 3. They produce the same result.

## Drop lowest -- dl

Roll dice and discard the N lowest results. This is the most popular way to express D&D ability score generation.

```bash
roll 4d6dl1    # Roll 4d6, drop the lowest 1
roll 5d6dl2    # Roll 5d6, drop the 2 lowest
```

`4d6dl1` and `4d6kh3` are equivalent -- both keep the highest 3 of 4 dice. The `dl` form reads more naturally for many players: "roll four d6, drop the lowest."

### Combining modifiers

You can chain keep and drop modifiers:

```bash
roll 6d6kh4dl1   # Roll 6d6, keep highest 4, then drop lowest 1 of those
```

Modifiers are applied left to right. In this example, first the 4 highest of 6 dice are kept, then the lowest of those 4 is dropped, leaving 3 dice.

## Exploding dice -- !

When a die rolls its maximum value, roll it again and add the new result. This can chain: if the reroll also hits the maximum, it explodes again.

```bash
roll 1d6!      # Exploding d6: reroll and add on a 6
roll 2d6!      # Two exploding d6
roll 1d10!     # Exploding d10: reroll and add on a 10
```

Explosions are capped at 100 rerolls per die to prevent infinite loops (though in practice, long chains are astronomically unlikely).

### Custom explosion threshold -- !>N

Set a custom threshold for explosions. The die explodes on a result of N or higher:

```bash
roll 1d6!>4    # Explode on 4, 5, or 6
roll 1d6!>5    # Explode on 5 or 6
roll 1d20!>19  # Explode on 19 or 20 (critical range)
```

Lower thresholds mean more frequent explosions and higher average results.

### Output

Exploded dice appear in magenta with an exclamation mark:

```bash
roll 1d6!
```

```
┌─ roll 1d6! ─────────────────┐
│ 1d6!: ⚅ 3! = 9              │
│                              │
│ Total:  9                    │
└──────────────────────────────┘
```

The initial roll was 6 (maximum), which triggered an explosion. The reroll was 3, which did not trigger another explosion. The total is 6 + 3 = 9.

## Percentile dice -- d%

Shorthand for a d100 (a die that rolls 1 through 100):

```bash
roll d%        # Roll 1-100
roll 2d%       # Roll two percentile dice and sum them
```

`d%` is exactly equivalent to `d100`. It exists because percentile dice are a distinct physical object in many tabletop games (two ten-sided dice, one for tens and one for ones).

## Fate / Fudge dice -- dF

Fate dice (also called Fudge dice) have three faces: minus (-1), blank (0), and plus (+1). They are used in the Fate RPG system and its variants.

```bash
roll 4dF       # Standard Fate roll: four Fate dice
roll 4dF+2     # Fate roll with a +2 skill modifier
roll 6dF       # Extended Fate roll
```

The result range for NdF is -N to +N. For the standard 4dF, results range from -4 to +4 with 0 as the most likely outcome.

### Output

Fate dice display their values as -1, 0, or +1:

```bash
roll 4dF
```

```
┌─ roll 4dF ──────────────────┐
│ 4dF: -1 0 1 1 = 1           │
│                              │
│ Total:  1                    │
└──────────────────────────────┘
```

## Unary minus

Negate a value or sub-expression:

```bash
roll -1d6      # Negative roll (e.g., for damage penalties)
roll 10-2d6    # Subtract a dice roll from a constant
```

## Complete notation reference

| Notation | Meaning | Result range |
|----------|---------|-------------|
| `2d6` | Roll 2 six-sided dice, sum them | 2--12 |
| `d20` | Roll 1 twenty-sided die | 1--20 |
| `4d6kh3` | Roll 4d6, keep highest 3 | 3--18 |
| `4d6kl3` | Roll 4d6, keep lowest 3 | 3--18 |
| `4d6dh1` | Roll 4d6, drop highest 1 | 3--18 |
| `4d6dl1` | Roll 4d6, drop lowest 1 | 3--18 |
| `1d6!` | Exploding d6 (reroll on 6, add) | 1--unlimited |
| `1d6!>4` | Explode on 4 or higher | 1--unlimited |
| `d%` | Percentile die (1--100) | 1--100 |
| `4dF` | Four Fate/Fudge dice | -4 to +4 |
| `2d6+3` | Add constant | 5--15 |
| `2d6-1` | Subtract constant | 1--11 |
| `2d6*10` | Multiply by constant | 20--120 |
| `3d6/2` | Integer floor division | 1--9 |
| `(2d6+3)*2` | Grouped arithmetic | 10--30 |
| `2d6+1d4+3` | Multiple dice groups | 6--19 |

## Parser details

Roll uses a recursive descent parser with the following grammar:

```
expression → term (('+' | '-') term)*
term       → factor (('*' | '/') factor)*
factor     → '-' factor | '(' expression ')' | dice | number
dice       → [count] 'd' sides [modifier]*
sides      → number | '%' | 'F'
modifier   → 'kh' [n] | 'kl' [n] | 'dh' [n] | 'dl' [n] | '!' ['>'] [n]
```

The parser is case-insensitive for `d`, `F`, and modifiers (`kh`, `kl`, `dh`, `dl`). Whitespace is ignored everywhere in the expression.
