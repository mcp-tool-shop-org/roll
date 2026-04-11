import type {
  GameTable,
  GameTableCollection,
  TableContext,
  TableEntry,
  TableResult,
} from "./schema.js";
import type { LootTable } from "../loot/table.js";
import { filterEligibleEntries } from "./conditions.js";
import { parse } from "../parser/parser.js";
import { evaluate } from "../engine/roller.js";
import { cryptoRng, type RngFn } from "../engine/random.js";

const MAX_DEPTH = 10;

// ─── Core engine ─────────────────────────────────────────────────────────────

/** Roll on a game table, resolving nested tables, chains, and dice expressions. */
export function rollGameTable(
  collection: GameTableCollection,
  tableName: string,
  context: TableContext = {},
  rng: RngFn = cryptoRng,
  depth = 0,
): TableResult[] {
  if (depth > MAX_DEPTH) {
    throw new Error("Table recursion depth exceeded (circular reference?)");
  }

  const table = collection.tables.find((t) => t.table === tableName);
  if (!table) {
    throw new Error(`Table not found: ${tableName}`);
  }

  // Filter entries by conditions and level
  const eligible = filterEligibleEntries(table.entries, context);
  if (eligible.length === 0) {
    throw new Error(`No eligible entries in table "${tableName}" for given context`);
  }

  // Weighted random selection
  const selected = weightedSelect(eligible, rng);

  // Handle nested table reference
  if (selected.table) {
    return rollGameTable(collection, selected.table, context, rng, depth + 1);
  }

  // Resolve the entry
  const result = resolveEntry(selected, tableName, rng);

  // Handle chain: roll on additional tables
  if (selected.chain && selected.chain.length > 0) {
    result.chainResults = [];
    for (const chainTable of selected.chain) {
      const chainResult = rollGameTable(collection, chainTable, context, rng, depth + 1);
      result.chainResults.push(...chainResult);
    }
  }

  return [result];
}

/** Roll on a table multiple times, optionally excluding duplicates. */
export function rollMultiple(
  collection: GameTableCollection,
  tableName: string,
  count: number,
  context: TableContext = {},
  rng: RngFn = cryptoRng,
): TableResult[] {
  const table = collection.tables.find((t) => t.table === tableName);
  if (!table) {
    throw new Error(`Table not found: ${tableName}`);
  }

  const results: TableResult[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < count; i++) {
    const result = rollGameTable(collection, tableName, context, rng);
    const entry = result[0];

    if (!table.allowDuplicates && seen.has(entry.entry)) {
      // Skip duplicates — try again (up to 3x attempts per slot)
      let retries = 0;
      let unique = false;
      while (retries < count * 3 && !unique) {
        const retry = rollGameTable(collection, tableName, context, rng);
        if (!seen.has(retry[0].entry)) {
          results.push(retry[0]);
          seen.add(retry[0].entry);
          unique = true;
        }
        retries++;
      }
      if (!unique) {
        // Exhausted retries, add the duplicate anyway
        results.push(entry);
        seen.add(entry.entry);
      }
    } else {
      results.push(entry);
      seen.add(entry.entry);
    }
  }

  return results;
}

// ─── V1 Bridge ───────────────────────────────────────────────────────────────

/** Convert a V1 LootTable to a V2 GameTable. */
export function convertLootToGameTable(loot: LootTable): GameTable {
  return {
    table: loot.table,
    kind: "loot",
    entries: loot.items.map((item) => ({
      name: item.name,
      weight: item.weight,
      roll: item.roll,
      quantity: item.quantity,
      table: item.table,
    })),
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function weightedSelect(entries: TableEntry[], rng: RngFn): TableEntry {
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  const roll = rng(1, totalWeight);

  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.weight;
    if (roll <= cumulative) return entry;
  }

  return entries[entries.length - 1];
}

function resolveEntry(
  entry: TableEntry,
  tableName: string,
  rng: RngFn,
): TableResult {
  // Resolve quantity dice
  let quantity = 1;
  if (entry.quantity) {
    const ast = parse(entry.quantity);
    quantity = Math.max(1, evaluate(ast, rng).total);
  }

  // Resolve roll value dice
  let rollValue: number | undefined;
  let rollExpression: string | undefined;
  if (entry.roll) {
    const ast = parse(entry.roll);
    rollValue = evaluate(ast, rng).total;
    rollExpression = entry.roll;
  }

  // Resolve duration dice
  let duration: number | undefined;
  let durationExpression: string | undefined;
  if (entry.duration) {
    const ast = parse(entry.duration);
    duration = Math.max(1, evaluate(ast, rng).total);
    durationExpression = entry.duration;
  }

  const result: TableResult = {
    entry: entry.name,
    quantity,
    fromTable: tableName,
  };

  if (entry.description) result.description = entry.description;
  if (rollValue !== undefined) result.rollValue = rollValue;
  if (rollExpression) result.rollExpression = rollExpression;
  if (duration !== undefined) result.duration = duration;
  if (durationExpression) result.durationExpression = durationExpression;
  if (entry.rarity) result.rarity = entry.rarity;
  if (entry.tags && entry.tags.length > 0) result.tags = entry.tags;

  return result;
}
