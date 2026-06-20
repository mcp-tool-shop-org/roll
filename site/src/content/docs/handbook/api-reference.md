---
title: API Reference
description: Complete library API for @mcptoolshop/roll — every exported function with TypeScript signatures, parameters, return types, and usage examples.
sidebar:
  order: 5
---

Roll exports every internal function with full TypeScript types. You can use the high-level convenience functions for common tasks, or reach into the parser, evaluator, distribution engine, and loot system directly.

## Convenience functions

### roll(expression, rng?)

Parse and evaluate a dice expression in one call. This is the most common entry point.

```typescript
function roll(expression: string, rng?: RngFn): RollResult;
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `expression` | `string` | -- | Dice expression (e.g., `"4d6dl1"`, `"2d6+3"`) |
| `rng` | `RngFn` | `cryptoRng` | Random number generator function |

**Returns:** `RollResult`

```typescript
interface RollResult {
  expression: string;       // The original expression
  total: number;            // Final computed result
  groups: DiceGroupResult[]; // Per-group breakdown
}

interface DiceGroupResult {
  expression: string;  // Dice sub-expression (e.g., "4d6dl1")
  dice: DieResult[];   // Individual die results
  total: number;       // Group sum (kept dice only)
}

interface DieResult {
  value: number;    // Face value
  kept: boolean;    // false if dropped by kh/kl/dh/dl
  exploded: boolean; // true if this die was added by explosion
}
```

**Example:**

```typescript
import { roll } from '@mcptoolshop/roll';

const result = roll('4d6dl1');
console.log(result.total);              // 14
console.log(result.groups[0].dice);     // Array of 4 DieResult objects
console.log(result.groups[0].dice
  .filter(d => !d.kept)
  .map(d => d.value));                  // [2] — the dropped die

// Multiple dice groups
const multi = roll('2d6+1d4+3');
console.log(multi.total);               // 16
console.log(multi.groups.length);        // 2 (one for 2d6, one for 1d4)
console.log(multi.groups[0].expression); // "2d6"
console.log(multi.groups[1].expression); // "1d4"
```

### analyze(expression)

Compute the full probability distribution and statistics for a dice expression.

```typescript
function analyze(expression: string): {
  distribution: Distribution;
  stats: DistributionStats;
  probabilityAtLeast: (target: number) => number;
  probabilityAtMost: (x: number) => number;
  probabilityExactly: (x: number) => number;
  probabilityInRange: (lo: number, hi: number) => number;
  cdf: Map<number, number>;
  targetForProbability: (p: number, direction?: "atLeast" | "atMost") => number;
  method: "exact" | "monte-carlo";
  samples?: number; // present only on the monte-carlo path
};
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `expression` | `string` | Dice expression to analyze |

**Returns:** An object carrying the distribution, stats, the full probability query family as closures, the cumulative distribution, and the method used:

| Field | Type | Description |
|-------|------|-------------|
| `distribution` | `Distribution` | Map from outcome value to probability |
| `stats` | `DistributionStats` | Computed statistics |
| `probabilityAtLeast` | `(target: number) => number` | P(result >= target) |
| `probabilityAtMost` | `(x: number) => number` | P(result <= x) |
| `probabilityExactly` | `(x: number) => number` | P(result == x) |
| `probabilityInRange` | `(lo: number, hi: number) => number` | P(lo <= result <= hi), inclusive |
| `cdf` | `Map<number, number>` | Cumulative distribution: value → P(result <= value) |
| `targetForProbability` | `(p, direction?) => number` | Break-even target solver (see [`targetForProbability`](#targetforprobabilitydist-p-direction)) |
| `method` | `"exact" \| "monte-carlo"` | How the distribution was produced |
| `samples` | `number?` | Sample count — present only when `method` is `"monte-carlo"` |

The `method` field lets callers honor the exact-probabilities contract: a `"monte-carlo"` result is a sampled estimate, not a closed-form answer. The query functions are closures over the computed distribution, so you don't re-thread it yourself.

**Example:**

```typescript
import { analyze } from '@mcptoolshop/roll';

const a = analyze('2d6+3');

// Statistics
console.log(a.stats.mean);           // 10
console.log(a.stats.median);         // 10
console.log(a.stats.mode);           // 10
console.log(a.stats.stddev);         // 2.42
console.log(a.stats.min);            // 5
console.log(a.stats.max);            // 15
console.log(a.stats.entropy);        // 3.27
console.log(a.stats.percentiles[95]); // 14

// Probability query family
console.log(a.probabilityAtLeast(12)); // 0.2778 (27.78%)
console.log(a.probabilityAtMost(7));   // 0.0833 (8.33%)
console.log(a.probabilityExactly(10)); // 0.1250 (12.50%)
console.log(a.probabilityInRange(8, 12)); // P(8 <= X <= 12)
console.log(a.targetForProbability(0.65)); // break-even target for P(X >= T) >= 0.65

// Method honesty
console.log(a.method);                 // "exact"
console.log(analyze('2d6*1d4').method); // "monte-carlo"
console.log(analyze('2d6*1d4').samples); // 100000

// Cumulative distribution
console.log(a.cdf.get(10));            // P(result <= 10)

// Raw distribution
for (const [value, prob] of a.distribution) {
  console.log(`${value}: ${(prob * 100).toFixed(2)}%`);
}
```

## Parser

### parse(expression)

Parse a dice expression string into an abstract syntax tree (AST).

```typescript
function parse(expression: string): ASTNode;
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `expression` | `string` | Dice expression to parse |

**Returns:** `ASTNode` -- the root of the parsed AST.

**Throws:** `ParseError` with a `position` property indicating where the error occurred.

```typescript
type ASTNode = NumberNode | DiceNode | BinaryOpNode | UnaryMinusNode;

interface NumberNode {
  type: "number";
  value: number;
}

interface DiceNode {
  type: "dice";
  count: number;          // Number of dice
  sides: DiceSides;       // number | "%" | "F"
  modifiers: DiceModifier[];
}

interface BinaryOpNode {
  type: "binary";
  op: "+" | "-" | "*" | "/";
  left: ASTNode;
  right: ASTNode;
}

interface UnaryMinusNode {
  type: "unary_minus";
  operand: ASTNode;
}

interface DiceModifier {
  kind: "kh" | "kl" | "dh" | "dl" | "explode";
  value?: number; // kh3, dl1, explode threshold
}

type DiceSides = number | "%" | "F";
```

**Example:**

```typescript
import { parse } from '@mcptoolshop/roll';

// Simple roll
const ast = parse('2d6+3');
// ast = {
//   type: "binary",
//   op: "+",
//   left:  { type: "dice", count: 2, sides: 6, modifiers: [] },
//   right: { type: "number", value: 3 }
// }

// Keep highest
const ast2 = parse('4d6kh3');
// ast2 = {
//   type: "dice",
//   count: 4,
//   sides: 6,
//   modifiers: [{ kind: "kh", value: 3 }]
// }

// Exploding
const ast3 = parse('1d6!>4');
// ast3 = {
//   type: "dice",
//   count: 1,
//   sides: 6,
//   modifiers: [{ kind: "explode", value: 4 }]
// }

// Error handling
try {
  parse('2d6kh3kl2??');
} catch (e) {
  console.log(e.message);  // "Unexpected token after expression: ..."
  console.log(e.position); // Character position of the error
}
```

## Evaluator

### evaluate(ast, rng?)

Evaluate a parsed AST and produce a roll result with full per-die breakdown.

```typescript
function evaluate(ast: ASTNode, rng?: RngFn): RollResult;
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `ast` | `ASTNode` | -- | Parsed AST from `parse()` |
| `rng` | `RngFn` | `cryptoRng` | Random number generator |

**Returns:** `RollResult` (same shape as `roll()` output, but with an empty `expression` string -- set it yourself if needed).

**Example:**

```typescript
import { parse, evaluate, seededRng } from '@mcptoolshop/roll';

// Deterministic evaluation for testing
const ast = parse('4d6dl1');
const result = evaluate(ast, seededRng(42));
console.log(result.total); // Always the same for seed 42

// Multiple evaluations of the same AST
const ast2 = parse('d20+5');
for (let i = 0; i < 5; i++) {
  const r = evaluate(ast2);
  console.log(r.total); // Different each time (crypto RNG)
}
```

## Distribution engine

### computeDistribution(ast)

Compute the probability distribution for a parsed AST. Uses exact algorithms when possible, falls back to Monte Carlo for complex cases.

```typescript
function computeDistribution(ast: ASTNode): Distribution;

type Distribution = Map<number, number>; // value → probability (0..1)
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `ast` | `ASTNode` | Parsed AST from `parse()` |

**Returns:** `Distribution` -- a Map where each key is a possible outcome and each value is its probability (a number between 0 and 1). Probabilities sum to 1 (or very close to 1 for Monte Carlo results).

**Example:**

```typescript
import { parse, computeDistribution } from '@mcptoolshop/roll';

const ast = parse('2d6');
const dist = computeDistribution(ast);

// Iterate over all outcomes
const sorted = [...dist.entries()].sort((a, b) => a[0] - b[0]);
for (const [value, prob] of sorted) {
  console.log(`${value}: ${(prob * 100).toFixed(2)}%`);
}
// 2: 2.78%
// 3: 5.56%
// 4: 8.33%
// ...
// 12: 2.78%

// Check a specific outcome
console.log(dist.get(7)); // 0.16666... (1 in 6)
```

### computeStats(dist)

Derive statistics from a probability distribution.

```typescript
function computeStats(dist: Distribution): DistributionStats;

interface DistributionStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  mode: number;
  stddev: number;
  percentiles: Record<number, number>; // Keys: 10, 25, 50, 75, 90, 95
  entropy: number;                     // Shannon entropy in bits
}
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `dist` | `Distribution` | A probability distribution map |

**Returns:** `DistributionStats`

**Example:**

```typescript
import { parse, computeDistribution, computeStats } from '@mcptoolshop/roll';

const ast = parse('4d6dl1');
const dist = computeDistribution(ast);
const stats = computeStats(dist);

console.log(stats.mean);            // 12.24
console.log(stats.median);          // 12
console.log(stats.mode);            // 13
console.log(stats.stddev);          // 2.85
console.log(stats.min);             // 3
console.log(stats.max);             // 18
console.log(stats.entropy);         // 3.53
console.log(stats.percentiles[10]); // 8
console.log(stats.percentiles[90]); // 16
```

### probabilityAtLeast(dist, target)

Compute the probability of a result being greater than or equal to a target value.

```typescript
function probabilityAtLeast(dist: Distribution, target: number): number;
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `dist` | `Distribution` | A probability distribution |
| `target` | `number` | The threshold value |

**Returns:** A number between 0 and 1 representing the probability.

**Example:**

```typescript
import { parse, computeDistribution, probabilityAtLeast } from '@mcptoolshop/roll';

const dist = computeDistribution(parse('d20+5'));

console.log(probabilityAtLeast(dist, 15)); // 0.55 (55%)
console.log(probabilityAtLeast(dist, 25)); // 0.05 (5% — only a natural 20)
console.log(probabilityAtLeast(dist, 6));  // 1.0  (100% — minimum is 6)
console.log(probabilityAtLeast(dist, 26)); // 0.0  (impossible — max is 25)
```

### probabilityAtMost(dist, x) / probabilityExactly(dist, x) / probabilityInRange(dist, lo, hi)

The rest of the point/range query family. Each mirrors `probabilityAtLeast`: a small linear sum over the distribution map, making no normalization assumption.

```typescript
function probabilityAtMost(dist: Distribution, x: number): number;     // P(result <= x)
function probabilityExactly(dist: Distribution, x: number): number;    // P(result == x)
function probabilityInRange(dist: Distribution, lo: number, hi: number): number; // P(lo <= result <= hi)
```

**Example:**

```typescript
import { parse, computeDistribution, probabilityAtMost, probabilityExactly, probabilityInRange } from '@mcptoolshop/roll';

const dist = computeDistribution(parse('2d6'));

console.log(probabilityAtMost(dist, 7));      // 0.5833 (cumulative through 7)
console.log(probabilityExactly(dist, 7));     // 0.1667 (1 in 6)
console.log(probabilityInRange(dist, 6, 8));  // 0.4444 (6, 7, and 8 combined)
```

`probabilityExactly` returns 0 for any value outside the distribution's support.

### cumulativeDistribution(dist) / survivalDistribution(dist)

Build the cumulative distribution function (CDF) or its complement (the survival function) as a value-keyed map.

```typescript
function cumulativeDistribution(dist: Distribution): Map<number, number>; // value → P(X <= value)
function survivalDistribution(dist: Distribution): Map<number, number>;   // value → P(X >= value)
```

Both walk the support in ascending order. For `cumulativeDistribution`, the last entry equals the total mass (~1 for a normalized distribution). For `survivalDistribution`, the first entry equals the total mass.

```typescript
import { parse, computeDistribution, cumulativeDistribution, survivalDistribution } from '@mcptoolshop/roll';

const dist = computeDistribution(parse('2d6'));
const cdf = cumulativeDistribution(dist);
const surv = survivalDistribution(dist);

console.log(cdf.get(7));   // P(X <= 7)
console.log(surv.get(7));  // P(X >= 7)
```

### targetForProbability(dist, p, direction?)

The break-even / "what number do I need" solver. Finds the target T such that the requested-direction probability still clears the threshold `p`.

```typescript
function targetForProbability(
  dist: Distribution,
  p: number,
  direction?: "atLeast" | "atMost"
): number;
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `dist` | `Distribution` | -- | A probability distribution |
| `p` | `number` | -- | The probability threshold (0–1) |
| `direction` | `"atLeast" \| "atMost"` | `"atLeast"` | Whether T bounds P(X >= T) or P(X <= T) |

**Returns:** For `"atLeast"`, the largest value T for which P(X >= T) >= p — "the highest DC you can require and still succeed with probability at least p." For `"atMost"`, the smallest value T for which P(X <= T) >= p. Empty distributions return 0.

**Example:**

```typescript
import { parse, computeDistribution, targetForProbability } from '@mcptoolshop/roll';

const dist = computeDistribution(parse('1d20+5'));

// "What DC can the +5 character beat at least 65% of the time?"
console.log(targetForProbability(dist, 0.65)); // the break-even target
```

### compareDistributions(a, b)

Compare two independent distributions as a head-to-head contest. Builds the margin distribution of (A − B) and reads off the three outcome probabilities. This is the engine behind the CLI `--compare` Versus verdict and the MCP `compare_dice` tool.

```typescript
function compareDistributions(a: Distribution, b: Distribution): DistributionComparison;

interface DistributionComparison {
  pAGreater: number;   // P(A > B)
  pEqual: number;      // P(A === B) — the tie mass
  pBGreater: number;   // P(B > A)
  margin: Distribution; // distribution of (A − B): key > 0 ⇒ A wins by that much
}
```

The three probabilities sum to the total mass of A×B (≈ 1 for normalized inputs).

**Example:**

```typescript
import { parse, computeDistribution, compareDistributions } from '@mcptoolshop/roll';

// Which damage build wins head-to-head?
const a = computeDistribution(parse('2d6+5'));   // steady greatsword
const b = computeDistribution(parse('1d12+6'));  // swingy greataxe (higher mean)

const v = compareDistributions(a, b);
console.log(v.pAGreater); // P(steady wins)
console.log(v.pEqual);    // P(tie)
console.log(v.pBGreater); // P(swingy wins)

// Mean margin E[A − B] — positive favors A despite B's higher mean
let mean = 0;
for (const [margin, prob] of v.margin) mean += margin * prob;
console.log(mean);
```

A related helper, `negateDistribution(dist)`, maps every value `v → -v` (the distribution of −X) — exported and used internally by `compareDistributions`.

### monteCarloDistribution(ast, samples?)

Force Monte Carlo simulation for a distribution. This is the fallback used internally when exact computation is not feasible. You can call it directly if you want to control the sample count.

```typescript
function monteCarloDistribution(
  ast: ASTNode,
  samples?: number
): Distribution;
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `ast` | `ASTNode` | -- | Parsed AST |
| `samples` | `number` | `100_000` | Number of simulation trials |

**Returns:** `Distribution` (approximate probabilities based on sampling).

**Example:**

```typescript
import { parse, monteCarloDistribution, computeStats } from '@mcptoolshop/roll';

// Force Monte Carlo even for simple expressions
const ast = parse('2d6*1d4');
const dist = monteCarloDistribution(ast, 500_000); // Extra precision
const stats = computeStats(dist);
console.log(stats.mean);
```

## Loot tables

### rollLootTable(tables, tableName?, rng?)

Roll on a loot table and return the resulting drops.

```typescript
function rollLootTable(
  tables: LootTable[],
  tableName?: string,
  rng?: RngFn
): LootDrop[];
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `tables` | `LootTable[]` | -- | Array of table definitions |
| `tableName` | `string` | First table | Which table to roll on |
| `rng` | `RngFn` | `cryptoRng` | Random number generator |

**Returns:** `LootDrop[]`

```typescript
interface LootTable {
  table: string;
  items: LootItem[];
}

interface LootItem {
  name: string;
  weight: number;
  roll?: string;     // Dice expression for value
  table?: string;    // Nested table reference
  quantity?: string;  // Dice expression for quantity
}

interface LootDrop {
  item: string;
  quantity: number;
  rollValue?: number;
  rollExpression?: string;
  fromTable: string;
}
```

**Throws:** Error if the table name is not found, total weight is zero, or recursion exceeds 10 levels.

**Example:**

```typescript
import { rollLootTable, seededRng } from '@mcptoolshop/roll';
import type { LootTable } from '@mcptoolshop/roll';

const tables: LootTable[] = [
  {
    table: "Chest",
    items: [
      { name: "Gold", weight: 50, roll: "2d6*10" },
      { name: "Potion", weight: 30, quantity: "1d2" },
      { name: "Rare", weight: 20, table: "Rare" },
    ],
  },
  {
    table: "Rare",
    items: [
      { name: "Magic Sword", weight: 60 },
      { name: "Magic Staff", weight: 40 },
    ],
  },
];

// Random roll
const drops = rollLootTable(tables);
for (const drop of drops) {
  let line = drop.item;
  if (drop.quantity > 1) line += ` x${drop.quantity}`;
  if (drop.rollValue !== undefined) line += ` (${drop.rollValue} gp)`;
  console.log(`${line} [from ${drop.fromTable}]`);
}

// Roll on a specific table
const rareDrops = rollLootTable(tables, "Rare");

// Deterministic for testing
const seeded = rollLootTable(tables, undefined, seededRng(42));
```

### validateLootTables(tables)

Validate a collection of loot tables. Returns an array of error messages (empty if valid).

```typescript
function validateLootTables(tables: LootTable[]): string[];
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `tables` | `LootTable[]` | Tables to validate |

**Returns:** `string[]` -- empty if all tables are valid, otherwise a list of human-readable error descriptions.

**Example:**

```typescript
import { validateLootTables } from '@mcptoolshop/roll';

const errors = validateLootTables([
  {
    table: "Bad Table",
    items: [
      { name: "Item", weight: -1 },              // Negative weight
      { name: "", weight: 10, table: "Missing" }, // Missing reference
      { name: "X", weight: 5, roll: "???" },      // Invalid dice
    ],
  },
]);

console.log(errors);
// [
//   'Item "Item" in "Bad Table" has invalid weight',
//   'Table reference "Missing" not found (in "Bad Table")',
//   'Invalid dice expression "???" in "Bad Table"'
// ]
```

## Table analysis

Compute the *exact* outcome distribution of a game table without rolling it: each entry's real selection probability, the value distribution of its dice, and the entries excluded by level or condition gates. See the [Loot Tables](/handbook/loot-tables/#table-analysis) guide for the full walkthrough.

### analyzeTable(table, context?, collection?)

Analyze a single `GameTable` for a given context.

```typescript
function analyzeTable(
  table: GameTable,
  context?: TableContext,
  collection?: GameTableCollection
): TableAnalysis;
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `table` | `GameTable` | -- | The table to analyze |
| `context` | `TableContext` | `{}` | Play context: `{ level?, tags?, variables?, triggerRoll?, triggerNat? }` |
| `collection` | `GameTableCollection` | -- | Required only to expand nested table refs one level deep |

**Returns:** `TableAnalysis`

```typescript
interface TableAnalysis {
  entries: AnalyzedEntry[];   // eligible entries with probabilities
  excluded: ExcludedEntry[];  // filtered-out entries with reasons
}

interface AnalyzedEntry {
  entry: TableEntry;
  probability: number;          // real selection probability (0–1), after weights/level/conditions
  valueMean?: number;           // mean of the entry's roll/quantity dice, if any
  valueDistribution?: Distribution; // full value distribution, if any
}

interface ExcludedEntry {
  entry: TableEntry;
  reason: string;  // e.g. "level (minLevel 12, context level 8)"
}
```

Probabilities use the same integer weight scaling the engine rolls against, so they match real drop proportions. A nested table ref (`entry.table`) is expanded one level deep when a `collection` is supplied, multiplying parent probability by child probability.

**Example:**

```typescript
import { analyzeTable } from '@mcptoolshop/roll';
import type { GameTableCollection } from '@mcptoolshop/roll';

const collection: GameTableCollection = {
  version: "2.0",
  tables: [{
    table: "Boss Drops",
    kind: "loot",
    entries: [
      { name: "Gold", weight: 60, roll: "3d6*10" },
      { name: "Legendary", weight: 2 },
      { name: "Dragon Scale", weight: 8, minLevel: 12 },
    ],
  }],
};

const analysis = analyzeTable(collection.tables[0], { level: 8 });

for (const e of analysis.entries) {
  console.log(`${e.entry.name}: ${(e.probability * 100).toFixed(1)}%`);
}
for (const x of analysis.excluded) {
  console.log(`${x.entry.name}: 0% — ${x.reason}`);
  // Dragon Scale: 0% — level (minLevel 12, context level 8)
}
```

### analyzeCollection(collection, tableName, context?)

Analyze a table within a collection by name. Mirrors `rollGameTable(collection, tableName, context)` and resolves the collection so nested refs expand.

```typescript
function analyzeCollection(
  collection: GameTableCollection,
  tableName: string,
  context?: TableContext
): TableAnalysis;
```

**Throws:** `Error` if `tableName` is not found in the collection.

**Example:**

```typescript
import { analyzeCollection } from '@mcptoolshop/roll';

const analysis = analyzeCollection(collection, "Boss Drops", { level: 15 });
```

## Random number generators

### cryptoRng

The default RNG used by all Roll functions. Delegates to `crypto.randomInt` for cryptographically secure randomness.

```typescript
const cryptoRng: RngFn;

type RngFn = (min: number, max: number) => number;
// Returns a random integer in [min, max] (inclusive)
```

You never need to pass this explicitly -- it's the default. It is exported so you can reference the type or use it alongside custom RNGs.

### seededRng(seed)

Create a deterministic PRNG for reproducible results. Uses the Mulberry32 algorithm.

```typescript
function seededRng(seed: number): RngFn;
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `seed` | `number` | Integer seed value |

**Returns:** `RngFn` -- a function with the same signature as `cryptoRng` that produces deterministic results for a given seed.

**Example:**

```typescript
import { roll, seededRng } from '@mcptoolshop/roll';

// Same seed always produces the same result
const r1 = roll('4d6dl1', seededRng(42));
const r2 = roll('4d6dl1', seededRng(42));
console.log(r1.total === r2.total); // true

// Different seeds produce different results
const r3 = roll('4d6dl1', seededRng(123));
console.log(r1.total === r3.total); // probably false

// Useful in test suites
import { describe, it, expect } from 'vitest';

describe('damage calculation', () => {
  it('computes sword damage correctly', () => {
    const rng = seededRng(999);
    const damage = roll('2d6+3', rng);
    expect(damage.total).toBe(10); // Deterministic
  });
});
```

## Tokenizer

### tokenize(expression)

Low-level tokenizer. Converts a dice expression string into an array of tokens. This is called internally by `parse()` but is exported for advanced use cases like syntax highlighting or custom parsers.

```typescript
function tokenize(expression: string): Token[];

interface Token {
  type: TokenType;
  value: string;
  position: number; // Character offset in the input
}

enum TokenType {
  NUMBER = "NUMBER",
  D = "D",
  PLUS = "PLUS",
  MINUS = "MINUS",
  STAR = "STAR",
  SLASH = "SLASH",
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  KH = "KH",
  KL = "KL",
  DH = "DH",
  DL = "DL",
  BANG = "BANG",
  GT = "GT",
  PERCENT = "PERCENT",
  F = "F",
  EOF = "EOF",
}
```

**Throws:** `LexerError` with a `position` property if the input contains an unrecognized character.

**Example:**

```typescript
import { tokenize, TokenType } from '@mcptoolshop/roll';

const tokens = tokenize('4d6kh3+5');
// [
//   { type: "NUMBER",  value: "4", position: 0 },
//   { type: "D",       value: "d", position: 1 },
//   { type: "NUMBER",  value: "6", position: 2 },
//   { type: "KH",      value: "kh", position: 3 },
//   { type: "NUMBER",  value: "3", position: 5 },
//   { type: "PLUS",    value: "+", position: 6 },
//   { type: "NUMBER",  value: "5", position: 7 },
//   { type: "EOF",     value: "",  position: 8 },
// ]
```

## MCP server

Roll ships an MCP server (`dist/mcp/server.js`) exposing six tools for Claude-driven game design. The `serverInfo.version` is read from `package.json` at startup, so it tracks the package version automatically rather than drifting on a hardcoded literal.

| Tool | Purpose |
|------|---------|
| `roll_dice` | Roll an expression. Params: `expression`, optional `times`, optional `seed`. |
| `analyze_dice` | Distribution + stats for an expression. Carries a `method` field (`"exact"` / `"monte-carlo"` with `samples`). Optional `at_least`, `at_most`, `exactly`, and `between` ([lo, hi]) add a `query` block to the result. |
| `compare_dice` | Stats for two expressions PLUS a `versus` verdict — P(A>B), P(tie), P(B>A), and the mean margin (A − B). Params: `expression_a`, `expression_b`. |
| `analyze_table` | Analyze a game table: each eligible entry's selection probability + value distribution, plus excluded entries with reasons. Params: `table_name`, `collection`, optional `context`. The headline tool for AI balance work. |
| `roll_table` | Roll on a game table. Params: `table_name`, `collection`, optional `context`, optional `count`. |
| `query_table` | Inspect a table's entries, conditions, and metadata without rolling. |

The `analyze_dice` query block and the `compare_dice` versus verdict are the v2.1.0 additions on the MCP surface; `analyze_table` is new.

## JSON bridge

The bridge (`roll-bridge`) is a JSON-RPC 2.0 server for game-engine integration over stdio or HTTP. Use the exported `BridgeHandler` class to call methods in-process, or run the binary as a child process.

**Methods:** `roll`, `roll_batch`, `analyze`, `at_least`, `at_most`, `exactly`, `between`, `compare`, `table_roll`, `table_load`, `table_list`, `table_analyze`, `seed`, `ping`, `shutdown`.

The v2.1.0 additions and enhancements:

| Method | Notes |
|--------|-------|
| `at_most` | P(result <= target). Params: `expression`, `target`. |
| `exactly` | P(result == target). Params: `expression`, `target`. |
| `between` | P(lo <= result <= hi). Params: `expression`, `lo`, `hi`. |
| `table_analyze` | Table analysis — mirrors `table_roll`'s `table` + `context` params, minus `count`. |
| `compare` | Now attaches a `versus` block (`pAGreater`, `pEqual`, `pBGreater`, `marginMean`) to each of the two returned entries. |
| `roll_batch` | Per-item resilient: one bad expression returns a `{ expression, error }` element instead of voiding the whole batch. |

### Observability

The bridge and MCP server share an injectable logger seam (a `Logger` with `info` and `error` channels) so a host can silence or redirect logs and tests can inject a no-op sink. Request tracing is **off by default**; enable one structured log line per request with the `--verbose` flag or the `ROLL_BRIDGE_DEBUG` environment variable (both transports honor the same env name):

```bash
roll-bridge --verbose                 # one structured line per request
ROLL_BRIDGE_DEBUG=1 roll-bridge       # same, via env
```

Internal-error detail is logged through the `error` channel server-side and never crosses the wire — the client sees a generic message, the detail stays on stderr.

## Error types

### ParseError

Thrown by `parse()` when the expression has a syntax error.

```typescript
class ParseError extends Error {
  position: number; // Character offset of the error
}
```

### LexerError

Thrown by `tokenize()` when the input contains an unrecognized character.

```typescript
class LexerError extends Error {
  position: number; // Character offset of the error
}
```

Both error types include a `position` property that indicates the character offset in the input string where the error was detected. This is useful for highlighting the error location in an editor or terminal.

## Exported types summary

All types are exported from the package root:

```typescript
import type {
  // AST
  ASTNode,
  DiceNode,
  NumberNode,
  BinaryOpNode,
  UnaryMinusNode,
  DiceModifier,
  DiceSides,

  // Tokens
  Token,

  // Engine
  RollResult,
  DiceGroupResult,
  DieResult,
  RngFn,

  // Analysis
  Distribution,
  DistributionStats,
  DistributionMethod,
  DistributionWithMethod,
  DistributionComparison,

  // Loot
  LootTable,
  LootItem,
  LootDrop,
  LootTableCollection,

  // Game tables + table analysis
  GameTable,
  GameTableCollection,
  TableEntry,
  TableContext,
  AnalyzedEntry,
  ExcludedEntry,
  TableAnalysis,
} from '@mcptoolshop/roll';
```
