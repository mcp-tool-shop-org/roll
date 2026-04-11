import { parse } from "../parser/parser.js";
import { evaluate } from "../engine/roller.js";
import type { RngFn } from "../engine/random.js";
import { cryptoRng } from "../engine/random.js";

export interface LootItem {
  name: string;
  weight: number;
  roll?: string;      // dice expression to evaluate (e.g., "2d6*10")
  table?: string;     // reference to nested table by name
  quantity?: string;   // dice expression for quantity (e.g., "1d4")
}

export interface LootTable {
  table: string;
  items: LootItem[];
}

export interface LootDrop {
  item: string;
  quantity: number;
  rollValue?: number;       // resolved dice value (from "roll" field)
  rollExpression?: string;  // original dice expression
  fromTable: string;
}

export interface LootTableCollection {
  tables: LootTable[];
}

/** Roll on a loot table, resolving nested tables and dice expressions. */
export function rollLootTable(
  tables: LootTable[],
  tableName?: string,
  rng: RngFn = cryptoRng,
  depth = 0,
): LootDrop[] {
  if (depth > 10) {
    throw new Error("Loot table recursion depth exceeded (circular reference?)");
  }

  const table = tableName
    ? tables.find((t) => t.table === tableName)
    : tables[0];

  if (!table) {
    throw new Error(`Loot table not found: ${tableName ?? "(default)"}`);
  }

  // Calculate total weight
  const totalWeight = table.items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    throw new Error(`Loot table "${table.table}" has no valid items`);
  }

  // Weighted random selection
  const roll = rng(1, totalWeight);
  let cumulative = 0;
  let selected: LootItem | undefined;

  for (const item of table.items) {
    cumulative += item.weight;
    if (roll <= cumulative) {
      selected = item;
      break;
    }
  }

  if (!selected) {
    selected = table.items[table.items.length - 1];
  }

  // If nested table reference, recurse
  if (selected.table) {
    return rollLootTable(tables, selected.table, rng, depth + 1);
  }

  // Resolve quantity
  let quantity = 1;
  if (selected.quantity) {
    const ast = parse(selected.quantity);
    quantity = evaluate(ast, rng).total;
  }

  // Resolve roll value
  let rollValue: number | undefined;
  let rollExpression: string | undefined;
  if (selected.roll) {
    const ast = parse(selected.roll);
    rollValue = evaluate(ast, rng).total;
    rollExpression = selected.roll;
  }

  return [{
    item: selected.name,
    quantity,
    rollValue,
    rollExpression,
    fromTable: table.table,
  }];
}

/** Validate a loot table collection. Returns errors or empty array. */
export function validateLootTables(tables: LootTable[]): string[] {
  const errors: string[] = [];
  const tableNames = new Set(tables.map((t) => t.table));

  for (const table of tables) {
    if (!table.table) errors.push("Table missing name");
    if (!table.items || table.items.length === 0) {
      errors.push(`Table "${table.table}" has no items`);
    }

    for (const item of table.items) {
      if (!item.name && !item.table) {
        errors.push(`Item in "${table.table}" has no name or table reference`);
      }
      if (item.weight <= 0) {
        errors.push(`Item "${item.name}" in "${table.table}" has invalid weight`);
      }
      if (item.table && !tableNames.has(item.table)) {
        errors.push(`Table reference "${item.table}" not found (in "${table.table}")`);
      }
      if (item.roll) {
        try { parse(item.roll); } catch {
          errors.push(`Invalid dice expression "${item.roll}" in "${table.table}"`);
        }
      }
    }
  }

  return errors;
}
