import type { GameTableCollection } from "./schema.js";
import { parse } from "../parser/parser.js";

/** Validate a game table collection. Returns error strings or empty array. */
export function validateGameTables(collection: GameTableCollection): string[] {
  const errors: string[] = [];
  const tableNames = new Set(collection.tables.map((t) => t.table));

  for (const table of collection.tables) {
    if (!table.table) {
      errors.push("Table missing name");
    }

    if (!table.entries || table.entries.length === 0) {
      errors.push(`Table "${table.table}" has no entries`);
      continue;
    }

    for (const entry of table.entries) {
      // Must have a name or a table reference
      if (!entry.name && !entry.table) {
        errors.push(`Entry in "${table.table}" has no name or table reference`);
      }

      // Weight must be positive
      if (entry.weight <= 0) {
        errors.push(`Entry "${entry.name}" in "${table.table}" has invalid weight: ${entry.weight}`);
      }

      // Nested table reference must exist
      if (entry.table && !tableNames.has(entry.table)) {
        errors.push(`Table reference "${entry.table}" not found (in "${table.table}")`);
      }

      // Chain references must exist
      if (entry.chain) {
        for (const ref of entry.chain) {
          if (!tableNames.has(ref)) {
            errors.push(`Chain reference "${ref}" not found (in "${table.table}", entry "${entry.name}")`);
          }
        }
      }

      // Validate dice expressions
      for (const [field, expr] of [
        ["roll", entry.roll],
        ["quantity", entry.quantity],
        ["duration", entry.duration],
      ] as const) {
        if (expr) {
          try {
            parse(expr);
          } catch {
            errors.push(`Invalid dice expression "${expr}" for ${field} in "${table.table}", entry "${entry.name}"`);
          }
        }
      }

      // Level range sanity
      if (
        entry.minLevel !== undefined &&
        entry.maxLevel !== undefined &&
        entry.minLevel > entry.maxLevel
      ) {
        errors.push(`Entry "${entry.name}" in "${table.table}" has minLevel (${entry.minLevel}) > maxLevel (${entry.maxLevel})`);
      }
    }
  }

  // Circular reference detection via DFS
  const circularErrors = detectCircularRefs(collection);
  errors.push(...circularErrors);

  return errors;
}

function detectCircularRefs(collection: GameTableCollection): string[] {
  const errors: string[] = [];
  const tableMap = new Map(collection.tables.map((t) => [t.table, t]));

  // A fresh DFS runs from every table, so the same cycle is rediscovered once
  // per table that can reach it. Canonicalize each cycle to the sorted set of
  // its members and report it only the first time we see that set — otherwise a
  // single cycle reachable from N tables floods the error list with N copies.
  const reportedCycles = new Set<string>();

  for (const table of collection.tables) {
    const visited = new Set<string>();
    const stack: string[] = [];
    const stackSet = new Set<string>();

    function dfs(name: string): boolean {
      if (stackSet.has(name)) {
        // Extract just the members forming the cycle (from where `name` first
        // appears on the stack) so the canonical key ignores the lead-in path.
        const start = stack.indexOf(name);
        const cycleMembers = stack.slice(start);
        const key = [...cycleMembers].sort().join("|");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          errors.push(`Circular reference detected: ${[...cycleMembers, name].join(" → ")}`);
        }
        return true;
      }
      if (visited.has(name)) return false;

      visited.add(name);
      stack.push(name);
      stackSet.add(name);

      const t = tableMap.get(name);
      if (t) {
        for (const entry of t.entries) {
          if (entry.table && dfs(entry.table)) return true;
          if (entry.chain) {
            for (const ref of entry.chain) {
              if (dfs(ref)) return true;
            }
          }
        }
      }

      stack.pop();
      stackSet.delete(name);
      return false;
    }

    dfs(table.table);
  }

  return errors;
}
