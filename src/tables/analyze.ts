import type {
  GameTable,
  GameTableCollection,
  TableContext,
  TableEntry,
} from "./schema.js";
import type { Distribution } from "../analyze/distribution.js";
import { filterEligibleEntries } from "./conditions.js";
import { weightScale } from "./engine.js";
import { computeDistribution } from "../analyze/distribution.js";
import { parse } from "../parser/parser.js";

// ─── Result shapes ────────────────────────────────────────────────────────────

/** One eligible entry's analyzed selection probability, plus the value
 *  distribution of its `roll`/`quantity` dice expression (if any). */
export interface AnalyzedEntry {
  entry: TableEntry;
  /** Real selection probability under the given context — normalized weight
   *  AFTER eligibility filtering, using the SAME integer weight scaling that
   *  `weightedSelect` uses, so this matches actual roll proportions. For nested
   *  table refs this is the multiplied (parent × child) probability. */
  probability: number;
  /** Mean of the entry's value dice (`roll`, else `quantity`), when present. */
  valueMean?: number;
  /** Full value distribution of the entry's value dice, when present. */
  valueDistribution?: Distribution;
}

/** An entry excluded from selection, with the reason it was filtered out. */
export interface ExcludedEntry {
  entry: TableEntry;
  /** Human-readable reason — e.g. "level" (minLevel/maxLevel gate) or
   *  "condition" (a condition failed). Designed so a UI can render
   *  "Dragon: 0% (minLevel 12)". */
  reason: string;
}

/** The full analysis of a table for a given context. */
export interface TableAnalysis {
  entries: AnalyzedEntry[];
  excluded: ExcludedEntry[];
}

// Weight scaling reuses engine.ts `weightScale` (imported) so analyzed
// probabilities match the integer-weight proportions `weightedSelect` actually
// rolls against — no byte-for-byte duplication to drift out of lockstep.

/** The integer weights `weightedSelect` would roll against, in entry order. */
function scaledWeights(entries: TableEntry[]): number[] {
  const scale = weightScale(entries);
  return entries.map((e) => Math.round(e.weight * scale));
}

// ─── Why was an entry excluded? ───────────────────────────────────────────────

/**
 * Classify why an entry was filtered out by `filterEligibleEntries`, for the
 * `excluded` report. Order matches the filter's own checks: level gates first,
 * then conditions. Returns undefined if the entry is actually eligible (so the
 * caller can detect a classification gap rather than report a wrong reason).
 */
function exclusionReason(entry: TableEntry, context: TableContext): string | undefined {
  if (context.level !== undefined) {
    if (entry.minLevel !== undefined && context.level < entry.minLevel) {
      return `level (minLevel ${entry.minLevel}, context level ${context.level})`;
    }
    if (entry.maxLevel !== undefined && context.level > entry.maxLevel) {
      return `level (maxLevel ${entry.maxLevel}, context level ${context.level})`;
    }
  }
  if (entry.conditions && entry.conditions.length > 0) {
    return "condition (one or more conditions not met)";
  }
  return undefined;
}

// ─── Value dice ───────────────────────────────────────────────────────────────

/** The dice expression carrying an entry's numeric value, if any. Prefers
 *  `roll` (the loot/reward value), falling back to `quantity`. */
function valueExpression(entry: TableEntry): string | undefined {
  return entry.roll ?? entry.quantity;
}

/** Mean of a distribution (Σ v·p). */
function distributionMean(dist: Distribution): number {
  let mean = 0;
  for (const [v, p] of dist) mean += v * p;
  return mean;
}

// ─── Core analysis ────────────────────────────────────────────────────────────

const MAX_NESTED_DEPTH = 1; // single level of nested-table expansion (see below)

/**
 * Analyze a single {@link GameTable} for a given context: report each ELIGIBLE
 * entry's real selection probability plus the value distribution of any
 * `roll`/`quantity` dice, and list excluded entries with the reason they were
 * filtered out.
 *
 * Probabilities use the SAME integer weight scaling `weightedSelect` uses, so
 * they match what the engine actually rolls (not the raw float weights).
 *
 * Nested table refs (`entry.table`) are expanded ONE level deep, best-effort:
 * the child table's entries are analyzed under the same context and their
 * probabilities multiplied by the parent entry's probability, then merged into
 * the result. A `collection` is required to resolve refs; without one (the
 * single-table overload), nested-ref entries are reported as a single entry at
 * their own selection probability (the ref is not expanded). Deeper nesting is
 * intentionally NOT followed — this keeps the analysis bounded and avoids any
 * interaction with the engine's MAX_DEPTH recursion guard.
 */
export function analyzeTable(
  table: GameTable,
  context: TableContext = {},
  collection?: GameTableCollection,
): TableAnalysis {
  return analyzeTableInner(table, context, collection, 0, new Set([table.table]));
}

/**
 * Analyze a table within a collection by name. This is the natural entry point
 * mirroring `rollGameTable(collection, tableName, context)` — it resolves the
 * collection so nested table refs can be expanded one level deep.
 */
export function analyzeCollection(
  collection: GameTableCollection,
  tableName: string,
  context: TableContext = {},
): TableAnalysis {
  const table = collection.tables.find((t) => t.table === tableName);
  if (!table) {
    throw new Error(`Table not found: ${tableName}`);
  }
  return analyzeTableInner(table, context, collection, 0, new Set([tableName]));
}

function analyzeTableInner(
  table: GameTable,
  context: TableContext,
  collection: GameTableCollection | undefined,
  depth: number,
  visited: Set<string>,
): TableAnalysis {
  const eligible = filterEligibleEntries(table.entries, context);
  const eligibleSet = new Set(eligible);

  // Excluded entries: everything the filter dropped, with a classified reason.
  const excluded: ExcludedEntry[] = [];
  for (const entry of table.entries) {
    if (eligibleSet.has(entry)) continue;
    const reason = exclusionReason(entry, context) ?? "excluded (ineligible)";
    excluded.push({ entry, reason });
  }

  const entries: AnalyzedEntry[] = [];

  // No eligible entries → mirror nothing-to-select; return only the excluded set.
  if (eligible.length === 0) {
    return { entries, excluded };
  }

  // Selection probabilities from the SAME integer weights weightedSelect rolls.
  const weights = scaledWeights(eligible);
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  for (let i = 0; i < eligible.length; i++) {
    const entry = eligible[i]!;
    const probability = totalWeight > 0 ? weights[i]! / totalWeight : 0;

    // Nested table ref: expand one level deep when we can resolve it.
    if (
      entry.table &&
      collection &&
      depth < MAX_NESTED_DEPTH &&
      !visited.has(entry.table)
    ) {
      const child = collection.tables.find((t) => t.table === entry.table);
      if (child) {
        const childVisited = new Set(visited);
        childVisited.add(entry.table);
        const childAnalysis = analyzeTableInner(
          child,
          context,
          collection,
          depth + 1,
          childVisited,
        );
        for (const childEntry of childAnalysis.entries) {
          entries.push({
            ...childEntry,
            probability: probability * childEntry.probability,
          });
        }
        // Child's excluded entries surface too, attributed by their own reason.
        excluded.push(...childAnalysis.excluded);
        continue;
      }
    }

    const analyzed: AnalyzedEntry = { entry, probability };

    const expr = valueExpression(entry);
    if (expr) {
      try {
        const dist = computeDistribution(parse(expr));
        analyzed.valueDistribution = dist;
        analyzed.valueMean = distributionMean(dist);
      } catch {
        // A malformed dice expression on the entry is a data problem, not an
        // analysis failure — skip the value distribution and still report the
        // entry's selection probability rather than throwing.
      }
    }

    entries.push(analyzed);
  }

  return { entries, excluded };
}
