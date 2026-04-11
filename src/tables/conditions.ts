import type { TableCondition, TableContext, TableEntry } from "./schema.js";

/** Test a single condition against context. */
export function evaluateCondition(
  condition: TableCondition,
  context: TableContext,
): boolean {
  switch (condition.type) {
    case "compare": {
      if (context.triggerRoll === undefined) return false;
      return compareNumeric(context.triggerRoll, condition.operator, condition.value);
    }

    case "nat": {
      if (context.triggerNat === undefined) return false;
      return compareNumeric(context.triggerNat, condition.operator, condition.value);
    }

    case "tag": {
      if (!context.tags) return false;
      return context.tags.includes(condition.tag);
    }

    case "context": {
      if (!context.variables) return false;
      const actual = context.variables[condition.variable];
      if (actual === undefined) return false;

      if (typeof condition.value === "string") {
        // String comparison: only equality
        return String(actual) === condition.value;
      }

      return compareNumeric(Number(actual), condition.operator, condition.value);
    }
  }
}

/** Filter entries to only those whose ALL conditions pass.
 *  Also filters by level range if context.level is set. */
export function filterEligibleEntries(
  entries: TableEntry[],
  context: TableContext,
): TableEntry[] {
  return entries.filter((entry) => {
    // Level range check
    if (context.level !== undefined) {
      if (entry.minLevel !== undefined && context.level < entry.minLevel) return false;
      if (entry.maxLevel !== undefined && context.level > entry.maxLevel) return false;
    }

    // All conditions must pass
    if (entry.conditions && entry.conditions.length > 0) {
      return entry.conditions.every((c) => evaluateCondition(c, context));
    }

    return true;
  });
}

function compareNumeric(
  actual: number,
  operator: "=" | ">" | ">=" | "<" | "<=",
  expected: number,
): boolean {
  switch (operator) {
    case "=":
      return actual === expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
  }
}
