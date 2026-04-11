# @mcptoolshop/roll

RPG dice engine with probability analysis, loot tables, and beautiful terminal output.

```
npx @mcptoolshop/roll 4d6dl1 --analyze
```

```
  Distribution

   3    0.08%
   4 █   0.31%
   5 ███   0.77%
   6 ███████   1.62%
   7 █████████████   2.93%
   8 ██████████████████████   4.78%
   9 ████████████████████████████████   7.02%
  10 ███████████████████████████████████████████   9.41%
  11 ████████████████████████████████████████████████████  11.42%
  12 ██████████████████████████████████████████████████████████  12.89%
  13 ████████████████████████████████████████████████████████████  13.27%
  14 ████████████████████████████████████████████████████████  12.35%
  15 ██████████████████████████████████████████████  10.11%
  16 █████████████████████████████████   7.25%
  17 ███████████████████   4.17%
  18 ███████   1.62%

┌─ Statistics ─────────────────────────────────┐
│ Mean:    12.24                                │
│ Median:  12                                   │
│ Mode:    13                                   │
│ Std Dev: 2.85                                 │
│ Range:   3–18                                 │
│ Entropy: 3.53 bits                            │
│                                               │
│ Percentiles:                                  │
│   p10:8  p25:10  p50:12  p75:14  p90:16  p95:17│
└───────────────────────────────────────────────┘
```

## Install

```bash
npm install @mcptoolshop/roll
```

Requires Node.js >= 22.

## CLI Usage

### Roll dice

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### Analyze probability

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### Compare distributions

```bash
roll --compare "4d6dl1" "3d6"
```

Side-by-side stats (mean, median, mode, stddev, range, entropy) with diff column, plus both histograms.

### Loot tables

```bash
roll --loot treasure.json
```

JSON format:

```json
{
  "tables": [
    {
      "table": "Treasure",
      "items": [
        { "name": "Gold", "weight": 40, "roll": "2d6*10" },
        { "name": "Potion of Healing", "weight": 30 },
        { "name": "Scroll", "weight": 15, "quantity": "1d3" },
        { "name": "Rare Item", "weight": 5, "table": "Rare Weapons" }
      ]
    },
    {
      "table": "Rare Weapons",
      "items": [
        { "name": "Vorpal Blade", "weight": 5 },
        { "name": "Frost Brand", "weight": 25 }
      ]
    }
  ]
}
```

Features: weighted selection, nested table references, dice expressions for quantity and value.

### Other flags

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## Dice Notation

| Notation | Meaning |
|----------|---------|
| `2d6` | Roll 2 six-sided dice |
| `d20` | Roll 1 twenty-sided die |
| `4d6kh3` | Roll 4d6, keep highest 3 |
| `4d6dl1` | Roll 4d6, drop lowest 1 |
| `1d6!` | Exploding d6 (reroll on max, add) |
| `1d6!>4` | Explode on 4 or higher |
| `d%` | Percentile die (1-100) |
| `4dF` | Fate/Fudge dice (-1, 0, +1 each) |
| `(2d6+3)*2` | Arithmetic with grouping |
| `2d6+1d4+3` | Chained expressions |

## Library API

```typescript
import { roll, analyze, parse, evaluate, computeDistribution } from '@mcptoolshop/roll';

// Quick roll
const result = roll('4d6kh3');
console.log(result.total);        // 14
console.log(result.groups[0].dice); // per-die breakdown

// Full analysis
const analysis = analyze('2d6+3');
console.log(analysis.stats.mean);                  // 10
console.log(analysis.stats.percentiles[95]);        // 14
console.log(analysis.probabilityAtLeast(12));       // 0.2778

// Low-level: parse → AST → evaluate
import { seededRng } from '@mcptoolshop/roll';
const ast = parse('4d6dl1');
const r = evaluate(ast, seededRng(42));  // deterministic

// Loot tables
import { rollLootTable } from '@mcptoolshop/roll';
const tables = [{ table: "Loot", items: [{ name: "Gold", weight: 50, roll: "2d6*10" }] }];
const drops = rollLootTable(tables);
```

## Probability Engine

- **Exact distributions** via polynomial convolution for basic NdM
- **Full enumeration** for keep/drop mechanics (4d6 = 1,296 states)
- **Truncated recursion** for exploding dice (capped at 10 explosions)
- **Monte Carlo fallback** (100k samples) when exact computation exceeds 10M states

## Zero Dependencies

Built entirely on Node.js 22+ builtins:
- `util.styleText` for terminal colors
- `util.parseArgs` for CLI argument parsing
- `crypto.randomInt` for cryptographically secure dice rolls

## License

MIT
