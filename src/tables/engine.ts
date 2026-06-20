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

  // Fast path: duplicates allowed — just roll `count` times.
  if (table.allowDuplicates) {
    for (let i = 0; i < count; i++) {
      // rollGameTable always returns a non-empty array (it throws on no eligible
      // entries and otherwise returns [result]), so [0] is always defined.
      results.push(rollGameTable(collection, tableName, context, rng)[0]!);
    }
    return results;
  }

  // Unique mode. A table can supply only as many results as it has distinct
  // *eligible* entries; asking for more than that can never be satisfied without
  // duplicates. Compute that ceiling up front so we stop cleanly once uniques are
  // exhausted instead of burning retries and then silently appending duplicates
  // (the old contract violation — it returned `count` items but lied about
  // uniqueness). We now return FEWER than `count` rather than padding with dups:
  // the allowDuplicates=false contract guarantees uniqueness, not quantity.
  let target = count;
  const eligible = filterEligibleEntries(table.entries, context);
  // Nested-table entries resolve to names we can't enumerate cheaply, so a table
  // containing any nested ref keeps the full `count` target and relies on the
  // attempt budget below to terminate.
  const hasNested = eligible.some((e) => e.table);
  if (!hasNested) {
    const distinct = new Set(eligible.map((e) => e.name));
    target = Math.min(count, distinct.size);
  }

  // Bounded attempt budget: enough headroom to gather all uniques even with
  // unlucky collisions, but finite so we never loop forever once uniques run out.
  const maxAttempts = (target + 1) * 8;
  let attempts = 0;
  while (results.length < target && attempts < maxAttempts) {
    attempts++;
    // rollGameTable always returns a non-empty array (see above), so [0] is
    // always defined.
    const entry = rollGameTable(collection, tableName, context, rng)[0]!;
    if (seen.has(entry.entry)) continue;
    results.push(entry);
    seen.add(entry.entry);
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
  // Weights are typed as `number` (fractional/zero values are representable).
  // Scale every weight by a common factor so integer weights reach `rng` — the
  // crypto RNG calls randomInt(), which throws on fractional or non-positive
  // bounds. Scaling preserves the relative proportions, so weighted selection
  // stays statistically correct (mirrors the V1 loot guard for totalWeight <= 0).
  const scale = weightScale(entries);
  const weights = entries.map((e) => Math.round(e.weight * scale));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Guard zero/negative totals (e.g. all weights 0) — mirror loot/table.ts so the
  // V2 engine raises a clear domain error instead of leaking a RangeError.
  if (totalWeight <= 0) {
    throw new Error("Cannot select from entries with total weight <= 0");
  }

  const roll = rng(1, totalWeight);

  let cumulative = 0;
  for (let i = 0; i < entries.length; i++) {
    // `weights` is `entries.map(...)`, so weights.length === entries.length and
    // both indexed accesses are in-bounds for i < entries.length.
    cumulative += weights[i]!;
    if (roll <= cumulative) return entries[i]!;
  }

  // Callers only invoke weightedSelect with a non-empty entries array, so the
  // final fallback element always exists.
  return entries[entries.length - 1]!;
}

/** Choose an integer scale factor that turns the largest count of decimal
 *  places among the weights into whole numbers (capped to avoid overflow).
 *  Exported so the table analyzer (tables/analyze.ts) computes the SAME
 *  integer-weight proportions weightedSelect rolls against — no drift. */
export function weightScale(entries: TableEntry[]): number {
  let maxDecimals = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.weight)) continue;
    const str = String(e.weight);
    const dot = str.indexOf(".");
    if (dot >= 0) maxDecimals = Math.max(maxDecimals, str.length - dot - 1);
  }
  // Cap at 6 decimals of precision — beyond that, integer overflow risk
  // outweighs the negligible probability difference.
  return 10 ** Math.min(maxDecimals, 6);
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
