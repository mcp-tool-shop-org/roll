---
title: Loot Tables
description: Define weighted loot tables in JSON with nested references, dice expressions for quantity and value, and roll them from the CLI or library API.
sidebar:
  order: 4
---

Roll includes a loot table system for generating random treasure, rewards, and item drops. Tables are defined in JSON with weighted item selection, dice expressions for quantity and value, and nested table references for tiered drops.

## Quick start

Create a file called `treasure.json`:

```json
{
  "tables": [
    {
      "table": "Treasure",
      "items": [
        { "name": "Gold", "weight": 50, "roll": "2d6*10" },
        { "name": "Potion of Healing", "weight": 30 },
        { "name": "Scroll", "weight": 20, "quantity": "1d3" }
      ]
    }
  ]
}
```

Roll on it from the command line:

```bash
roll --loot treasure.json
```

Output:

```
┌─ Loot Drop ─────────────────────┐
│ Gold (70) [2d6*10]              │
│                                  │
│ from: Treasure                   │
└──────────────────────────────────┘
```

## JSON schema

A loot table file contains one or more named tables. Each table has a list of weighted items.

### Top-level structure

The file can use any of three formats:

```json
// Format 1: Object with "tables" array (recommended)
{
  "tables": [
    { "table": "TableName", "items": [...] }
  ]
}

// Format 2: Bare array of tables
[
  { "table": "TableName", "items": [...] }
]

// Format 3: Single table object
{
  "table": "TableName",
  "items": [...]
}
```

### Table object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `table` | string | Yes | Unique name for this table |
| `items` | array | Yes | List of items that can drop |

### Item object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes* | Display name of the item |
| `weight` | number | Yes | Relative probability weight (must be > 0) |
| `roll` | string | No | Dice expression for the item's value (e.g., `"2d6*10"` for gold amount) |
| `quantity` | string | No | Dice expression for how many drop (e.g., `"1d3"`) |
| `table` | string | No | Reference to another table by name (for nested drops) |

*Either `name` or `table` is required. Items with a `table` reference redirect to the referenced table instead of dropping directly.

## Weighted selection

Items are chosen by weighted random selection. The weight values are relative to each other within the same table.

```json
{
  "table": "Common Drops",
  "items": [
    { "name": "Copper coins", "weight": 60 },
    { "name": "Healing herb", "weight": 30 },
    { "name": "Iron dagger", "weight": 10 }
  ]
}
```

Total weight is 60 + 30 + 10 = 100, so:

- Copper coins: 60% chance
- Healing herb: 30% chance
- Iron dagger: 10% chance

The weights do not need to sum to 100. These are equivalent:

```json
{ "name": "Common", "weight": 3 }
{ "name": "Rare",   "weight": 1 }
```

Common has a 75% chance (3 out of 4) and Rare has 25% (1 out of 4).

## Dice expressions for value

The `roll` field attaches a dice expression to an item. When the item is selected, the expression is evaluated and its result is included in the drop.

This is most commonly used for gold or currency amounts:

```json
{ "name": "Gold", "weight": 40, "roll": "2d6*10" }
```

When this item drops, Roll evaluates `2d6*10` and reports both the item name and the rolled value. If the roll produces 70, the output shows:

```
Gold (70) [2d6*10]
```

The `roll` field supports the full dice notation: `3d6+5`, `(2d4+1)*5`, `1d100`, and so on.

## Dice expressions for quantity

The `quantity` field determines how many of the item drop. When omitted, the quantity is 1.

```json
{ "name": "Scroll of Fireball", "weight": 15, "quantity": "1d3" }
```

If `1d3` rolls a 2, the output shows:

```
Scroll of Fireball x2
```

You can combine `quantity` and `roll` on the same item:

```json
{ "name": "Gemstones", "weight": 10, "roll": "3d6*5", "quantity": "1d4" }
```

This drops 1--4 gemstones, each worth a `3d6*5` gold value.

## Nested table references

Items can reference other tables by name using the `table` field. When a referencing item is selected, Roll follows the reference and rolls on the target table instead.

```json
{
  "tables": [
    {
      "table": "Treasure",
      "items": [
        { "name": "Gold", "weight": 50, "roll": "2d6*10" },
        { "name": "Potion of Healing", "weight": 30 },
        { "name": "Rare Item", "weight": 20, "table": "Rare Weapons" }
      ]
    },
    {
      "table": "Rare Weapons",
      "items": [
        { "name": "Flametongue Sword", "weight": 30 },
        { "name": "Frost Brand", "weight": 25 },
        { "name": "Vorpal Blade", "weight": 5 },
        { "name": "Staff of Power", "weight": 20 },
        { "name": "Dagger of Venom", "weight": 20 }
      ]
    }
  ]
}
```

When "Rare Item" is selected from the Treasure table (20% chance), Roll follows the reference to the "Rare Weapons" table and selects from it. The final drop comes from the nested table.

References can chain: a nested table can itself reference another table. Roll prevents infinite loops by capping recursion at 10 levels deep.

## Full example: multi-tier treasure system

Here is a complete loot table file for a dungeon treasure system with three tiers:

```json
{
  "tables": [
    {
      "table": "Dungeon Chest",
      "items": [
        { "name": "Gold",              "weight": 35, "roll": "3d6*10" },
        { "name": "Silver",            "weight": 25, "roll": "5d6*5" },
        { "name": "Healing Potion",    "weight": 15, "quantity": "1d2" },
        { "name": "Consumable",        "weight": 15, "table": "Consumables" },
        { "name": "Equipment",         "weight": 10, "table": "Equipment" }
      ]
    },
    {
      "table": "Consumables",
      "items": [
        { "name": "Scroll of Fireball",  "weight": 20, "quantity": "1d2" },
        { "name": "Antidote",            "weight": 30 },
        { "name": "Bomb",                "weight": 25, "quantity": "1d3" },
        { "name": "Elixir of Speed",     "weight": 15 },
        { "name": "Rare Consumable",     "weight": 10, "table": "Rare Consumables" }
      ]
    },
    {
      "table": "Rare Consumables",
      "items": [
        { "name": "Phoenix Down",         "weight": 40 },
        { "name": "Megalixir",            "weight": 30 },
        { "name": "Soma Drop",            "weight": 30 }
      ]
    },
    {
      "table": "Equipment",
      "items": [
        { "name": "Iron Shield",          "weight": 30 },
        { "name": "Steel Sword",          "weight": 25 },
        { "name": "Leather Armor",        "weight": 25 },
        { "name": "Rare Equipment",       "weight": 20, "table": "Rare Equipment" }
      ]
    },
    {
      "table": "Rare Equipment",
      "items": [
        { "name": "Flametongue Sword",    "weight": 25 },
        { "name": "Aegis Shield",         "weight": 25 },
        { "name": "Dragon Mail",          "weight": 20 },
        { "name": "Genji Gloves",         "weight": 15 },
        { "name": "Excalibur",            "weight": 5 },
        { "name": "Masamune",             "weight": 5 },
        { "name": "Ragnarok",             "weight": 5 }
      ]
    }
  ]
}
```

Drop probabilities cascade through the chain. The chance of getting Excalibur from a Dungeon Chest is:

```
10% (Equipment) * 20% (Rare Equipment) * 5% (Excalibur) = 0.1%
```

## Validation

Roll validates loot table files before rolling on them. The validator checks for:

- Missing table names
- Empty item lists
- Items without either a `name` or `table` reference
- Non-positive weights
- Table references that point to nonexistent tables
- Invalid dice expressions in `roll` or `quantity` fields

If validation fails, Roll prints the errors and exits with a non-zero status code.

From the library API, you can validate tables directly:

```typescript
import { validateLootTables } from '@mcptoolshop/roll';

const errors = validateLootTables(tables);
if (errors.length > 0) {
  console.error('Validation failed:', errors);
}
```

## CLI usage

```bash
# Roll on the default (first) table in the file
roll --loot treasure.json

# JSON output for scripting
roll --loot treasure.json --json
```

The `--loot` flag reads a JSON file, validates it, and rolls on the first table. The JSON output format is an array of drop objects:

```json
[
  {
    "item": "Gold",
    "quantity": 1,
    "rollValue": 70,
    "rollExpression": "2d6*10",
    "fromTable": "Treasure"
  }
]
```

## Library usage

```typescript
import { rollLootTable, validateLootTables } from '@mcptoolshop/roll';
import type { LootTable } from '@mcptoolshop/roll';

const tables: LootTable[] = [
  {
    table: "Treasure",
    items: [
      { name: "Gold", weight: 50, roll: "2d6*10" },
      { name: "Potion", weight: 30 },
      { name: "Rare", weight: 20, table: "Rare Items" },
    ],
  },
  {
    table: "Rare Items",
    items: [
      { name: "Magic Sword", weight: 50 },
      { name: "Magic Staff", weight: 50 },
    ],
  },
];

// Validate first
const errors = validateLootTables(tables);
if (errors.length > 0) throw new Error(errors.join(', '));

// Roll on the first table
const drops = rollLootTable(tables);

// Roll on a specific table by name
const rareDrops = rollLootTable(tables, "Rare Items");

// Use a seeded RNG for deterministic results
import { seededRng } from '@mcptoolshop/roll';
const drops2 = rollLootTable(tables, undefined, seededRng(42));
```

Each call to `rollLootTable` returns an array of `LootDrop` objects:

```typescript
interface LootDrop {
  item: string;        // Item name
  quantity: number;    // How many (from quantity dice, or 1)
  rollValue?: number;  // Resolved value from roll dice
  rollExpression?: string;  // Original roll expression
  fromTable: string;   // Which table the item came from
}
```
